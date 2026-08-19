/**
 * Decoration resolution for `stargantt.task-bars`: which pattern, milestone shape and corner
 * radius one pass paints with, given the resolved options and the theme. Pure functions, so the
 * mappings unit-test without a host.
 */
import { parsePx } from "@stargantt/sdk";
import type { Task } from "@stargantt/plugin-data-store";
import type { BarPattern, MilestoneShape } from "../types";
import type { ThemeReader } from "./deps";
import type { BarOptions } from "./options";
import { asPattern, asShape } from "./options";
import { isMilestone, isSummary } from "./geometry";
import { BEVEL_TOKEN, RADIUS_TOKEN, STROKE_TOKEN, STROKE_WIDTH_TOKEN } from "./paint";

// The built-in per-type mapping: ordinary bars hatch diagonally and summaries cross-hatch, so the
// two bar-shaped types stop relying on colour alone; a milestone's marker shape is already its
// non-colour cue, so it stays plain.
/** The built-in pattern for a task's type under `patternFill: true`. */
export function builtinPatternFor(task: Readonly<Task>): BarPattern {
  if (isMilestone(task)) return "none";
  if (isSummary(task)) return "cross";
  return "diagonal";
}

/**
 * The pattern to paint for one task under the resolved option, `"none"` when the feature is off.
 * `provider` is the already-latched per-task chooser when the option was a function; a declined or
 * invalid answer falls back to the built-in mapping.
 */
export function resolvePattern(
  options: Pick<BarOptions, "patternFill">,
  provider: ((task: Readonly<Task>) => BarPattern | undefined) | undefined,
  task: Readonly<Task>,
): BarPattern {
  if (options.patternFill === undefined) return "none";
  if (provider !== undefined) {
    const chosen = asPattern(provider(task));
    if (chosen !== undefined) return chosen;
  }
  return builtinPatternFor(task);
}

/**
 * The marker shape to paint for one milestone under the resolved option. `provider` is the
 * already-latched per-task chooser when the option was a function; a declined or invalid answer
 * falls back to the fixed configured shape, then to the built-in diamond.
 */
export function resolveShape(
  options: Pick<BarOptions, "milestoneShape">,
  provider: ((task: Readonly<Task>) => MilestoneShape | undefined) | undefined,
  task: Readonly<Task>,
): MilestoneShape {
  if (provider !== undefined) {
    const chosen = asShape(provider(task));
    if (chosen !== undefined) return chosen;
  }
  const fixed = options.milestoneShape;
  return typeof fixed === "string" ? fixed : "diamond";
}

// The config option wins over the `--sg-bar-radius` token; both absent (or unusable) paints the
// classic square bar. One read per pass, not per bar.
/** The corner radius for one pass, in CSS px; 0 means square corners. */
export function resolveRadius(options: Pick<BarOptions, "barRadius">, theme: ThemeReader): number {
  if (options.barRadius !== undefined) return options.barRadius;
  const token = theme.get(RADIUS_TOKEN);
  return token === "" ? 0 : parsePx(token, 0);
}

// The outline and the bevel are theme-only (no per-instance config option), read once per pass like
// the radius. Both are "off" unless the theme asks for them, which is what keeps the default look
// byte-identical.

/** The outline for one pass: its colour and width in CSS px, width 0 meaning "no outline". */
export function resolveStroke(theme: ThemeReader): { color: string; width: number } {
  const width = parsePx(theme.get(STROKE_WIDTH_TOKEN), 0);
  // `transparent` is the token's own default and paints nothing, so it is treated as "off"
  // rather than spending a stroke call per bar on an invisible line.
  const color = theme.get(STROKE_TOKEN);
  if (width <= 0 || color === "" || color === "transparent") return { color: "", width: 0 };
  return { color, width };
}

/** The bevel strength for one pass, clamped to 0…1; 0 means flat. */
export function resolveBevel(theme: ThemeReader): number {
  const parsed = Number.parseFloat(theme.get(BEVEL_TOKEN));
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(1, parsed);
}
