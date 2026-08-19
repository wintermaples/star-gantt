// docs/specs/plugins/tree-grid.md § Extension points — the bar overlay renderer: progress-status
// coloring, then the overdue warning icon.
/**
 * The per-bar overlay renderer: repaints the progress portion in a status color — clipped to the
 * bar's rounded-corner outline inside a save/clip/restore — and draws the warning triangle on
 * overdue bars. Pure drawing over a provided 2d context — no host needed.
 */
import type { Task } from "@stargantt/plugin-data-store";
import type { BarBox } from "../upward";
import type { ColorResolver } from "./color";
import type { ResolvedOverdue, ResolvedProgress } from "./config";
import { isOverdue } from "./style";

/** Actual progress more than this below the expected fraction counts as behind schedule. */
const BEHIND_EPSILON = 0.001;

/** Progress status of an ordinary task at one instant. */
export type ProgressStatus = "behind" | "onTrack" | "complete";

/**
 * Classifies a task's progress: complete at ≥ 1, behind when actual trails the expected fraction
 * `clamp((now − start) / (end − start), 0, 1)` by more than an epsilon, on track otherwise.
 */
export function progressStatus(task: Readonly<Task>, now: number): ProgressStatus {
  const actual = Math.min(Math.max(task.progress ?? 0, 0), 1);
  if (actual >= 1) return "complete";
  const span = task.end - task.start;
  const expected = span > 0 ? Math.min(Math.max((now - task.start) / span, 0), 1) : 0;
  return actual + BEHIND_EPSILON < expected ? "behind" : "onTrack";
}

export interface OverlayDeps {
  getTask(id: BarBox["id"]): Task | undefined;
  now(): number;
  progress: ResolvedProgress | null;
  overdue: ResolvedOverdue | null;
  /**
   * The bars' corner radius in CSS px for the current paint pass — the `--sg-bar-radius` theme
   * token's value, `0` when it is absent or unusable. The progress-status fill is clipped to the
   * bar's rounded outline built from this radius, so no status pixel lands outside the bar shape.
   */
  barRadius(): number;
  /**
   * Turns a configured color into the value assigned to `fillStyle`, resolving theme tokens.
   * A color that resolves to `""` is not painted at all — neither the progress fill nor the
   * warning icon is drawn in a color the canvas would ignore.
   */
  color: ColorResolver;
}

// The same rounded-rect path the bar body is filled with (arcTo corners, radius clamped to half the
// smaller side); `roundRect` is avoided so the recording test context (and older canvas
// implementations) stay usable. Traced only, never filled here: the caller uses it as a clip.
/** Traces the bar body's rounded-corner outline as the current path. */
function traceBarPath(g: CanvasRenderingContext2D, bar: Readonly<BarBox>, radius: number): void {
  const { x, y, width, height } = bar;
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + width, y, x + width, y + height, r);
  g.arcTo(x + width, y + height, x, y + height, r);
  g.arcTo(x, y + height, x, y, r);
  g.arcTo(x, y, x + width, y, r);
  g.closePath();
}

/** Half-width of the warning triangle in CSS px. */
const ICON_HALF = 5;

function drawWarningIcon(g: CanvasRenderingContext2D, bar: Readonly<BarBox>, color: string): void {
  // Anchored inside the bar's right end when the bar is wide enough, just outside it otherwise,
  // so the icon stays visible on 2 px minimum-width bars.
  const cx =
    bar.width >= 14 ? bar.x + bar.width - ICON_HALF - 2 : bar.x + bar.width + ICON_HALF + 2;
  const cy = bar.y + bar.height / 2;
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(cx, cy - ICON_HALF);
  g.lineTo(cx - ICON_HALF, cy + ICON_HALF - 1);
  g.lineTo(cx + ICON_HALF, cy + ICON_HALF - 1);
  g.closePath();
  g.fill();
  // The exclamation glyph, in white for contrast against the warning fill.
  g.fillStyle = "#ffffff";
  g.fillRect(cx - 0.75, cy - 2.5, 1.5, 3.5);
  g.fillRect(cx - 0.75, cy + 2, 1.5, 1.5);
}

/**
 * Builds the overlay renderer. It is called once per visible bar per paint, after that bar's body,
 * progress fill and label.
 */
export function createOverlayRenderer(
  deps: OverlayDeps,
): (g: CanvasRenderingContext2D, bar: Readonly<BarBox>) => void {
  return (g, bar) => {
    const task = deps.getTask(bar.id);
    if (task === undefined) return;

    if (
      deps.progress !== null &&
      (task.type === undefined || task.type === "task") &&
      typeof task.progress === "number" &&
      Number.isFinite(task.progress)
    ) {
      const fraction = Math.min(Math.max(task.progress, 0), 1);
      if (fraction > 0) {
        const status = progressStatus(task, deps.now());
        const fill = deps.color(deps.progress[status]);
        if (fill !== "") {
          // The status fill is clipped to the bar's rounded outline inside its own
          // save/clip/restore, so nothing paints outside the corner curve — the bar pass
          // save/restores around the whole overlay anyway, but the clip must not leak onto the
          // warning icon drawn below.
          g.save();
          traceBarPath(g, bar, deps.barRadius());
          g.clip();
          g.fillStyle = fill;
          g.fillRect(bar.x, bar.y, bar.width * fraction, bar.height);
          g.restore();
        }
      }
    }

    if (deps.overdue !== null && deps.overdue.icon && isOverdue(task, deps.now())) {
      const fill = deps.color(deps.overdue.color);
      if (fill !== "") drawWarningIcon(g, bar, fill);
    }
  };
}

/** Whether the overlay renderer should be contributed at all. */
export function overlayActive(deps: Pick<OverlayDeps, "progress" | "overdue">): boolean {
  return deps.progress !== null || (deps.overdue !== null && deps.overdue.icon);
}
