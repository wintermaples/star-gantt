// docs/specs/plugins/interaction.md §1.3 (`pressing`) — the deferred collapse of `"multi"` mode:
// an unmodified press on a bar that is already selected does not replace the selection at press
// time; the collapse waits for the release and is discarded the moment the press becomes a drag.
/**
 * The deferred collapse's decision table: whether a press defers, and what each later pointer event
 * does to a pending collapse.
 *
 * Everything here is arithmetic over plain values — no host, no bus — so every branch is exercised
 * directly by the unit tests.
 */
import type { TaskId } from "@stargantt/plugin-data-store";

// The same movement slop the drag arbiter uses as its drag threshold (`DRAG_THRESHOLD_PX`). The
// two must stay equal, which is why the spec writes both numbers out.
/** Movement, in CSS px, a press may travel and still count as a click rather than a drag. */
export const COLLAPSE_SLOP_PX = 3;

/** Raw event type that marks a `pointer/barUp` as a cancelled capture rather than a release. */
const POINTER_CANCEL = "pointercancel";

/** A collapse recorded at press time and waiting for the gesture to end. */
export interface PendingCollapse {
  /** The task the selection collapses to, if the press turns out to be a click. */
  readonly id: TaskId;
  /** The pointer that pressed; only that pointer's own release resolves the collapse. */
  readonly pointerId: number;
  /** Press position in client coordinates, so a scrolling view cannot fake movement. */
  readonly clientX: number;
  readonly clientY: number;
}

/** Modifier state a press carries, already extracted from whichever event delivered it. */
export interface PressModifiers {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/** The part of a pointer event the decision reads. */
export interface PointerPoint {
  pointerId: number;
  clientX: number;
  clientY: number;
  /** The raw event's `type`; `"pointercancel"` marks a lost capture. */
  type: string;
}

/**
 * Whether a bar press on `id` defers its collapse instead of replacing the selection now.
 *
 * Only in `"multi"` mode, only without modifiers, and only for a task already inside a selection of
 * two or more — collapsing a one-task selection onto its own task changes nothing, so deferring it
 * would be unobservable bookkeeping.
 */
export function pressDefersCollapse(
  mode: "single" | "multi" | "none",
  modifiers: PressModifiers,
  selected: ReadonlySet<TaskId>,
  id: TaskId,
): boolean {
  if (mode !== "multi") return false;
  if (modifiers.ctrlKey || modifiers.metaKey || modifiers.shiftKey) return false;
  return selected.size > 1 && selected.has(id);
}

/** How far the pointer has travelled from the press point. */
function travelled(pending: PendingCollapse, e: PointerPoint): number {
  return Math.hypot(e.clientX - pending.clientX, e.clientY - pending.clientY);
}

/** What a pointer move does to the pending collapse: keep waiting, or drop it. */
export function collapseOnMove(pending: PendingCollapse, e: PointerPoint): "hold" | "discard" {
  // Another pointer's movement says nothing about this gesture.
  if (e.pointerId !== pending.pointerId) return "hold";
  return travelled(pending, e) > COLLAPSE_SLOP_PX ? "discard" : "hold";
}

/**
 * What the end of a gesture does to the pending collapse: apply it (the press was a click in place)
 * or drop it.
 *
 * A release by another pointer, a cancelled capture, and a release past the slop all discard: the
 * selection the press left alone stays exactly as it was.
 */
export function collapseOnUp(pending: PendingCollapse, e: PointerPoint): "apply" | "discard" {
  if (e.pointerId !== pending.pointerId) return "discard";
  if (e.type === POINTER_CANCEL) return "discard";
  return travelled(pending, e) > COLLAPSE_SLOP_PX ? "discard" : "apply";
}
