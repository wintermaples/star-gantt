// docs/specs/plugins/interaction.md §1.3 — a drag branches on the hit kind.
/**
 * What a drag does to a task's dates.
 *
 * Pressing the body of a bar moves it; pressing one of its end handles resizes that end. The
 * arithmetic is kept here, free of canvas, DOM and core imports, so the rules can be unit-tested on
 * their own.
 */

/** The three things a drag on a bar can do. */
export type DragMode = "move" | "resize-start" | "resize-end";

/** A task's dates, in epoch milliseconds. */
export interface TimeRange {
  start: number;
  end: number;
}

/** Rounds a time to the snap unit, or returns it unchanged when snapping is off. */
export type Snap = (t: number) => number;

/** Leaves an instant exactly where it is — the rounding used when there is none. */
export function unrounded(t: number): number {
  return t;
}

/**
 * Which end a resize grabbed, decided from the time under the pointer when it went down.
 *
 * The hit result says only that a handle was hit, so the end is recovered by comparing the grabbed
 * time with the middle of the task: the nearer end wins, and a tie takes the start.
 */
export function resizeModeAt(grabbed: number, origin: Readonly<TimeRange>): DragMode {
  const middle = (origin.start + origin.end) / 2;
  return grabbed <= middle ? "resize-start" : "resize-end";
}

/**
 * The dates a drag proposes: the task's original dates displaced by `delta` milliseconds, with the
 * moved edge snapped.
 *
 * A move shifts both ends and keeps the duration, so only the start is snapped and the end follows
 * it. A resize moves one end and leaves the other where it was; the moved end is never allowed past
 * the fixed one, so a task cannot be dragged inside out.
 *
 * `minDuration` (milliseconds, default 0) tightens the resize clamp: the moved end stops that far
 * short of the fixed one. A task already shorter than the minimum is clamped no tighter than its
 * own current duration, so the option never forces an edit the drag did not describe. A move is
 * never affected.
 */
export function proposeRange(
  mode: DragMode,
  origin: Readonly<TimeRange>,
  delta: number,
  snap: Snap,
  minDuration = 0,
): TimeRange {
  if (mode === "move") {
    const start = snap(origin.start + delta);
    return { start, end: start + (origin.end - origin.start) };
  }
  // The floor is never wider than the task's own current duration, so a sub-minimum task stays
  // resizable up to (but not past) its current length.
  const floor = Math.min(Math.max(0, minDuration), origin.end - origin.start);
  if (mode === "resize-start") {
    const start = Math.min(snap(origin.start + delta), origin.end - floor);
    return { start, end: origin.end };
  }
  const end = Math.max(snap(origin.end + delta), origin.start + floor);
  return { start: origin.start, end };
}

/** Whether two proposals are the same, so an unchanged drag can skip a repaint or a commit. */
export function sameRange(a: Readonly<TimeRange>, b: Readonly<TimeRange>): boolean {
  return a.start === b.start && a.end === b.end;
}

/**
 * The completion fraction a pointer at `x` describes inside a bar spanning `left` to `left + width`.
 *
 * All three coordinates are in the same space; the result is clamped to `0..1` so dragging past
 * either edge saturates instead of producing a value the store would have to reject, and a bar with
 * no width reads as `0`.
 */
export function progressAt(x: number, left: number, width: number): number {
  if (!(width > 0)) return 0;
  const fraction = (x - left) / width;
  if (fraction <= 0) return 0;
  if (fraction >= 1) return 1;
  return fraction;
}
