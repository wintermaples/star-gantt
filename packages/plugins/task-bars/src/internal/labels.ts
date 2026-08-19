/**
 * The bar-label pipeline of `stargantt.task-bars`: the host-supplied provider behind
 * `TaskBarsConfig.label` with its latched fault barrier, the built-in duration and progress
 * labels, per-label placement, and the per-pass theme reads their text needs.
 *
 * The drawing itself is `./paint-text`'s `drawPlacedLabels`.
 */
import { MS_DAY, contrastRatio, parseColor } from "@stargantt/sdk";
import type { Rgba } from "@stargantt/sdk";
import type { Task } from "@stargantt/plugin-data-store";
import type { BarLabelProvider, LabelPlacement } from "../types";
import type { ThemeReader } from "./deps";
import type { BackdropOption, BuiltinLabel, HostLabel } from "./options";
import {
  INSIDE_LABEL_COLOR,
  INSIDE_LABEL_TOKEN,
  LABEL_COLOR,
  LABEL_FONT,
  LABEL_FONT_TOKEN,
  LABEL_TOKEN,
} from "./paint";
import {
  LABEL_BACKDROP_COLOR,
  LABEL_BACKDROP_PADDING,
  LABEL_BACKDROP_RADIUS,
  LABEL_BACKDROP_TOKEN,
} from "./paint-text";
import type { LabelBackdrop } from "./paint-text";
import { clampProgress, isMilestone, isSummary } from "./geometry";

/** One label the pass will draw for a bar, with its resolved placement. */
export interface PlacedLabel {
  text: string;
  placement: LabelPlacement;
}

/** The label options the feature reads, all resolved by `./options` at setup(). */
export interface LabelOptions {
  /** The host-supplied provider and the placement every one of its labels takes. */
  host: HostLabel;
  duration: BuiltinLabel;
  progress: BuiltinLabel;
  /**
   * The halo behind outside labels, or `undefined` when the option switched it off.
   *
   * Required rather than optional: the option defaults to *on*, so a caller that forgets it would
   * silently get the off behaviour, which is the bug this field was added to fix.
   */
  backdrop: BackdropOption | undefined;
}

const DEFAULT_OPTIONS: LabelOptions = {
  host: { provider: undefined, placement: "right" },
  duration: { enabled: false, placement: undefined },
  progress: { enabled: false, placement: undefined },
  backdrop: { color: undefined, padding: undefined, radius: undefined },
};

/** The label feature of one plugin instance, off when nothing label-shaped was configured. */
export interface LabelFeature {
  /** Whether any label work is worth doing at all this pass. */
  enabled(): boolean;
  /** The label colour for one pass (labels placed beside the bar). */
  color(): string;
  /** The label colour for one pass for labels placed inside the bar. */
  insideColor(): string;
  /**
   * The colour an inside-placement label paints in on a bar of `barColor`, given the pass's
   * inside-label colour: `token` where it is readable on this bar, and black or white — whichever
   * the bar carries better — where it is not. The token is passed in rather than re-read so the
   * theme reads stay once-per-pass.
   */
  insideColorOn(barColor: string, token: string): string;
  /** The label font for one pass, as a CSS font shorthand. */
  font(): string;
  /**
   * The halo painted behind each label drawn outside a bar for one pass, or `undefined` when the
   * option switched it off. Read once per pass, like the colour and the font.
   */
  backdrop(): LabelBackdrop | undefined;
  /**
   * The text for one bar from the host-supplied provider only, or `undefined` for no label. Empty
   * and non-string results draw nothing, and a throwing provider turns the provider off for good.
   */
  textOf(task: Readonly<Task>): string | undefined;
  /**
   * Every label to draw for one bar, in order (host label, then duration, then progress), each
   * with its resolved placement. Fills and returns `out` so the pass reuses one array per frame.
   */
  collect(task: Readonly<Task>, out: PlacedLabel[]): PlacedLabel[];
}

// A duration label rounds the span to whole days (minimum 1) and reads `Nd`; milestones carry no
// duration and get none.
/** The duration label's text for a task, or `undefined` when the task carries none. */
export function durationText(task: Readonly<Task>): string | undefined {
  if (isMilestone(task)) return undefined;
  const span = task.end - task.start;
  if (!Number.isFinite(span) || span < 0) return undefined;
  return `${Math.max(1, Math.round(span / MS_DAY))}d`;
}

// A progress label rounds the clamped fraction to whole percent; milestones and summaries paint no
// progress fill and get none.
/** The progress label's text for a task, or `undefined` when the task shows no progress. */
export function progressText(task: Readonly<Task>): string | undefined {
  if (isMilestone(task) || isSummary(task)) return undefined;
  return `${Math.round(clampProgress(task.progress) * 100)}%`;
}

// The inside-label token is authored against the palette's ordinary bar fill, but a bar can be
// painted any colour: a summary bar, a conditional-format rule or a `taskbars/style` contribution
// all override the fill the token was chosen for, and a black label on a black summary bar reads as
// no label at all.

/** WCAG 1.4.3 AA for ordinary-size text — the floor an inside label has to clear on its bar. */
const MIN_LABEL_CONTRAST = 4.5;

const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };

/**
 * The colour to paint an inside-placement label in, given the theme's inside-label colour and the
 * fill of the bar it sits on.
 *
 * `token` is kept whenever it clears {@link MIN_LABEL_CONTRAST} on that fill, so a palette in
 * charge of its own contrast is never second-guessed; only where it does not is the label flipped
 * to whichever of black and white the bar carries better. A colour neither side can parse — a
 * system-colour keyword under forced colors, say — is not measurable, and the token is kept rather
 * than replaced on a guess.
 *
 * A translucent bar fill is measured composited over white, the approximation `contrastRatio`
 * documents and the theme's own audit already reports with: the painter cannot know what the chart
 * background under a glass palette resolves to, so both measurements share one assumption rather
 * than disagreeing.
 */
export function readableInsideColor(token: string, barColor: string): string {
  const fill = parseColor(barColor);
  const fg = parseColor(token);
  if (fill === null || fg === null) return token;
  if (contrastRatio(fg, fill) >= MIN_LABEL_CONTRAST) return token;
  return contrastRatio(BLACK, fill) >= contrastRatio(WHITE, fill) ? "#000000" : "#ffffff";
}

// The option is read once, at setup(), from the config the factory closed over. Anything that is
// not a function is ignored silently, which leaves the provider off: with no label source at all,
// the pass performs no label work, touches no canvas text state and never reads the label tokens,
// so the painted result is byte-identical to a composition from before the options existed.
/**
 * Builds the label feature from the configured option and the resolved label options.
 *
 * `onFault` is called at most once, with the error the provider threw: the barrier is *latched*
 * because the call sits inside a paint loop running at frame rate, so the first throw is reported
 * once and the provider then declines for the rest of the instance's life. Nothing can clear the
 * latch — a config option cannot be re-contributed, unlike a `taskbars/style` contribution.
 */
export function createLabelFeature(
  theme: ThemeReader,
  onFault: (error: unknown) => void,
  options: LabelOptions = DEFAULT_OPTIONS,
): LabelFeature {
  const provider: BarLabelProvider | undefined = options.host.provider;
  const hostPlacement = options.host.placement;
  let faulted = false;
  const durationPlacement = options.duration.placement ?? "right";
  const progressPlacement = options.progress.placement ?? "inside";

  // One measurement per distinct bar fill rather than one per bar per frame: the contrast maths is
  // pure, and a chart paints a handful of fills across thousands of bars. The cache is dropped when
  // the token behind it changes (a preset switch) and bounded so a per-task colour scheme cannot
  // grow it without limit.
  const insideByFill = new Map<string, string>();
  let cachedToken: string | null = null;

  // Runs the provider behind the latch. The placement is the chart's, not the task's: since the
  // three label kinds were unified there is no per-task placement channel, so a provider returning
  // anything but a non-empty string simply draws nothing.
  const resolve = (task: Readonly<Task>): PlacedLabel | undefined => {
    if (provider === undefined || faulted) return undefined;
    try {
      const result = provider(task);
      if (typeof result !== "string" || result === "") return undefined;
      return { text: result, placement: hostPlacement };
    } catch (error) {
      faulted = true;
      onFault(error);
      return undefined;
    }
  };

  return {
    enabled: () =>
      (provider !== undefined && !faulted) ||
      options.duration.enabled ||
      options.progress.enabled,
    // Read once per pass rather than once per bar (the same treatment the track alpha gets) and
    // only when the feature is on, so a default composition never reads the token.
    color: () => theme.get(LABEL_TOKEN) || LABEL_COLOR,
    insideColor: () => theme.get(INSIDE_LABEL_TOKEN) || INSIDE_LABEL_COLOR,
    insideColorOn(barColor, token) {
      if (token !== cachedToken) {
        cachedToken = token;
        insideByFill.clear();
      }
      const hit = insideByFill.get(barColor);
      if (hit !== undefined) return hit;
      const resolved = readableInsideColor(token, barColor);
      if (insideByFill.size >= 64) insideByFill.clear();
      insideByFill.set(barColor, resolved);
      return resolved;
    },
    // The font gets exactly the treatment the colour gets. The fallback is the canvas default, so a
    // theme that leaves the token unset paints what this plugin painted before the token existed.
    font: () => theme.get(LABEL_FONT_TOKEN) || LABEL_FONT,
    // One token read per pass, and only while the option is on and something is labelled.
    backdrop: () => {
      const option = options.backdrop;
      if (option === undefined) return undefined;
      return {
        color: option.color ?? (theme.get(LABEL_BACKDROP_TOKEN) || LABEL_BACKDROP_COLOR),
        padding: option.padding ?? LABEL_BACKDROP_PADDING,
        radius: option.radius ?? LABEL_BACKDROP_RADIUS,
      };
    },
    textOf: (task) => resolve(task)?.text,
    collect(task, out) {
      out.length = 0;
      const custom = resolve(task);
      if (custom !== undefined) out.push(custom);
      if (options.duration.enabled) {
        const text = durationText(task);
        if (text !== undefined) out.push({ text, placement: durationPlacement });
      }
      if (options.progress.enabled) {
        const text = progressText(task);
        if (text !== undefined) out.push({ text, placement: progressPlacement });
      }
      return out;
    },
  };
}
