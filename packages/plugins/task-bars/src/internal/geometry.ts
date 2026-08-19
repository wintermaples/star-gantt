/**
 * Bar geometry for `stargantt.task-bars`: where a task's bar sits inside its row, where its
 * resize handles are, and what a point lands on.
 *
 * Pure arithmetic — no canvas, no DOM, no core imports — so the layout rules can be unit-tested
 * on their own.
 */
import type { Task } from "@stargantt/plugin-data-store";
import type { MilestoneShape } from "../types";

/** A rectangle in whatever coordinate space the caller is working in. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// docs/specs/plugins/task-bars.md — the contractual bar-geometry rule: 4 CSS px vertical inset per
// side, minimum bar height 6 px, minimum width 2 px, ordered span, milestone box = a height-sized
// square centred on the start instant.

/** Vertical padding between the row band and the bar, per side, in CSS pixels. */
export const BAR_INSET = 4;

/** Smallest bar height, so bars stay visible in very short rows. */
export const MIN_BAR_HEIGHT = 6;

/** Smallest bar width, so a zero-duration ordinary task does not vanish. */
export const MIN_BAR_WIDTH = 2;

/** Width of each end's resize handle, measured inwards from the bar edge. */
export const HANDLE_WIDTH = 6;

/**
 * Narrowest bar that still gets resize handles.
 *
 * Below this the two handles would meet and leave no part of the bar grabbable for a move, so
 * the whole bar reports as a move target instead.
 */
export const MIN_HANDLED_BAR_WIDTH = HANDLE_WIDTH * 3;

/** CSS cursor reported for the body of a bar. */
export const BAR_CURSOR = "move";

/** CSS cursor reported for a resize handle. */
export const HANDLE_CURSOR = "ew-resize";

// The progress affordance is a hit zone, not a glyph: nothing new is painted, so the default look
// and every screenshot baseline are unchanged. The strip is ±3 px around the boundary and reports
// the same horizontal-resize cursor the handles use, the drag being horizontal in both cases.

/**
 * Half-width of the progress hit strip, in CSS pixels, measured either side of the boundary.
 */
export const PROGRESS_HIT_RADIUS = 3;

// The WCAG 2.2 §2.5.8-sized vertical reach of the progress zone: a 24 px-tall band centred on the
// bar's bottom edge, so the zone extends below the bar instead of being confined to the bar's own
// (usually < 24 px) height.
/** Half-height of the progress hit band, measured either side of the bar's bottom edge. */
export const PROGRESS_BAND_HALF = 12;

/** CSS cursor reported for the progress hit strip. */
export const PROGRESS_CURSOR = "ew-resize";

/** Whether the task is drawn as a milestone diamond rather than a bar. */
export function isMilestone(task: Readonly<Task>): boolean {
  return task.type === "milestone";
}

/** Whether the task is drawn as a summary glyph rather than a plain bar. */
export function isSummary(task: Readonly<Task>): boolean {
  return task.type === "summary";
}

/**
 * Normalizes a task's progress to the 0..1 range, treating a missing or nonsensical value as 0.
 */
export function clampProgress(progress: number | undefined): number {
  if (typeof progress !== "number" || !Number.isFinite(progress)) return 0;
  if (progress <= 0) return 0;
  return progress >= 1 ? 1 : progress;
}

/**
 * Computes the box a task's bar occupies, given its row band and a time→x mapping.
 *
 * The result is in the same space `tToX` produces and `rowTop` is measured in. A milestone gets a
 * square centred on its start time; anything else spans start to end, widened to a minimum so a
 * zero-length task remains visible. Start and end are ordered, so reversed dates still yield a
 * positive width.
 */
export function barRect(
  task: Readonly<Task>,
  rowTop: number,
  rowHeight: number,
  tToX: (t: number) => number,
): Rect {
  const height = Math.min(rowHeight, Math.max(MIN_BAR_HEIGHT, rowHeight - BAR_INSET * 2));
  const y = rowTop + (rowHeight - height) / 2;
  if (isMilestone(task)) {
    const centre = tToX(task.start);
    return { x: centre - height / 2, y, width: height, height };
  }
  const a = tToX(task.start);
  const b = tToX(task.end);
  return {
    x: Math.min(a, b),
    y,
    width: Math.max(MIN_BAR_WIDTH, Math.abs(b - a)),
    height,
  };
}

/** Whether a bar of this size is wide enough to carry resize handles. */
export function hasHandles(task: Readonly<Task>, box: Rect): boolean {
  // A milestone has no duration to resize.
  return !isMilestone(task) && box.width >= MIN_HANDLED_BAR_WIDTH;
}

/** The resize handle at one end of a bar, as a rectangle inside the bar. */
export function handleRect(box: Rect, side: "start" | "end"): Rect {
  const x = side === "start" ? box.x : box.x + box.width - HANDLE_WIDTH;
  return { x, y: box.y, width: HANDLE_WIDTH, height: box.height };
}

// The WCAG 2.2 §2.5.8 minimum target size, applied to a bar's whole hit zone when the
// expanded-hit-area option is on.
/** Minimum hit-zone side, in CSS px, under the expanded-hit-area option. */
export const MIN_HIT_SIZE = 24;

/**
 * Whether the point falls inside the box after each dimension is symmetrically widened to at
 * least `MIN_HIT_SIZE` around the box's centre. A box already that large tests unchanged.
 */
export function withinExpanded(box: Rect, x: number, y: number): boolean {
  const w = Math.max(box.width, MIN_HIT_SIZE);
  const h = Math.max(box.height, MIN_HIT_SIZE);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return Math.abs(x - cx) <= w / 2 && Math.abs(y - cy) <= h / 2;
}

/** Whether the point falls inside the rectangle (left/top inclusive, right/bottom exclusive). */
export function within(box: Rect, x: number, y: number): boolean {
  return x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height;
}

/**
 * Whether a point falls inside the diamond inscribed in the box, rather than merely inside the
 * box. Without this the empty corners around a milestone would answer for it.
 */
function withinDiamond(box: Rect, x: number, y: number): boolean {
  const rx = box.width / 2;
  const ry = box.height / 2;
  if (rx <= 0 || ry <= 0) return false;
  const dx = Math.abs(x - (box.x + rx));
  const dy = Math.abs(y - (box.y + ry));
  return dx / rx + dy / ry <= 1;
}

// The progress boundary is where `paintBar` stops shading, i.e. the right edge of the progress
// fill. It exists only where that fill exists: a milestone and a summary paint none, and neither
// does a bar whose progress clamps to 0, so those expose no progress zone at all.
/**
 * The x of the progress-fill boundary inside a task's bar, or `undefined` when the task paints no
 * progress fill.
 */
export function progressBoundaryX(task: Readonly<Task>, box: Rect): number | undefined {
  if (isMilestone(task) || isSummary(task)) return undefined;
  const progress = clampProgress(task.progress);
  if (progress <= 0) return undefined;
  return box.x + box.width * progress;
}

/**
 * Classifies a point against one task's bar: a resize handle, the progress zone (the strip around
 * the progress-fill boundary, extended into a 24 px-tall band centred on the bar's bottom edge),
 * the bar body, or nothing.
 *
 * Handles win over both the progress zone and the body where they overlap, which keeps the resize
 * affordance intact at the bar's two edges; the progress zone in turn wins over the body.
 *
 * A milestone's hit shape follows its painted marker: the default diamond keeps its inscribed
 * hit shape, while every non-default shape hit-tests as the full bounding square, so the whole
 * painted glyph is clickable.
 */
export function hitKind(
  task: Readonly<Task>,
  box: Rect,
  x: number,
  y: number,
  milestoneShape: MilestoneShape = "diamond",
): "bar" | "handle" | "progress" | undefined {
  if (isMilestone(task)) {
    const inside =
      milestoneShape === "diamond" ? withinDiamond(box, x, y) : within(box, x, y);
    return inside ? "bar" : undefined;
  }
  const inside = within(box, x, y);
  // Handles keep their exact zones and win over the progress strip where they overlap.
  if (inside && hasHandles(task, box)) {
    if (within(handleRect(box, "start"), x, y)) return "handle";
    if (within(handleRect(box, "end"), x, y)) return "handle";
  }
  // The progress zone is the in-bar strip *plus* a 24 px-tall band hugging the bar's bottom edge,
  // so the target reaches WCAG 2.2 §2.5.8 size below thin bars. Purely a hit-area change: nothing
  // painted moves.
  const boundary = progressBoundaryX(task, box);
  if (boundary !== undefined && Math.abs(x - boundary) <= PROGRESS_HIT_RADIUS) {
    if (inside) return "progress";
    if (Math.abs(y - (box.y + box.height)) <= PROGRESS_BAND_HALF) return "progress";
  }
  return inside ? "bar" : undefined;
}
