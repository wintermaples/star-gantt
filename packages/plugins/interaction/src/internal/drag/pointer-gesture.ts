// docs/specs/plugins/interaction.md §1.1 / §1.3 — the pointer gesture: `barDown` → 3px threshold →
// move / end-resize / progress-drag by hit kind.
/**
 * The state one press-and-drag carries, and the arithmetic that advances it.
 *
 * A gesture is a plain object; the decisions a pointer move implies are computed here as values, so
 * the controller stays wiring: it hands over the numbers a pointer event carries and acts on the
 * decision that comes back. Nothing here touches the canvas, the DOM or the core, so all of it can
 * be exercised without booting a host.
 */
import type { TaskId } from "@stargantt/plugin-data-store";
import type { DragMode, TimeRange } from "./gesture";
import { progressAt, proposeRange, resizeModeAt, unrounded } from "./gesture";

/** How far the pointer must travel before a press turns into a drag, in CSS pixels. */
export const DRAG_THRESHOLD_PX = 3;

/** Raw event type that marks a `pointer/barUp` as a cancelled capture rather than a release. */
export const POINTER_CANCEL = "pointercancel";

/** Where a bar was drawn, in content coordinates (i.e. with the scroll offsets added back). */
export interface BarPlacement {
  left: number;
  top: number;
  width: number;
  height: number;
  /**
   * The drawn box's left edge as an offset from the content x of the bar's own start, in CSS pixels
   * — pure padding between a bar's dates and the rectangle it was painted in (0 for an ordinary
   * bar, non-zero for a milestone or a minimum-width one).
   *
   * `left` is a *content* x, and every content x moves when the origin moves, so a placement
   * captured at the press goes stale the moment the drag extends the axis. The ghost is displaced
   * from these offsets instead, which no origin move can invalidate.
   */
  startOffset: number;
  /** As `startOffset`, for the drawn box's right edge against the bar's own end. */
  endOffset: number;
}

/** The rounding rule a gesture consults, as this module needs it. */
export interface Rounding {
  snap(t: number): number;
}

/** What a single press-and-drag remembers whatever it is editing. */
export interface GestureBase {
  readonly id: TaskId;
  /**
   * The pointer that started this drag. Pointer events are per-device — a second finger, a pen or a
   * second mouse produces its own stream — and only the one that pressed the bar may move or finish
   * the edit.
   */
  readonly pointerId: number;
  /** The per-drag nonce every command of this gesture carries, so they undo as one entry. */
  readonly coalesceKey: string;
  /** The bar as it was last drawn, which the ghost is displaced from. */
  readonly bar: BarPlacement;
  /**
   * Where the pointer went down, in client coordinates. `clientX` is mutable because auto-scroll
   * shifts it: scrolling the view under a stationary pointer is the same edit as moving the pointer
   * over a stationary view, and shifting the press origin by the scrolled distance makes the
   * existing client-delta arithmetic describe it with no second code path.
   */
  clientX: number;
  readonly clientY: number;
  /** `false` until the movement threshold is exceeded; nothing is drawn or committed before. */
  dragging: boolean;
}

/** A drag that edits the task's dates: a move, or a resize of one end. */
export interface DateGesture extends GestureBase {
  readonly kind: "date";
  readonly mode: DragMode;
  /** The task's dates when the pointer went down. */
  readonly origin: TimeRange;
  /** The dates the pointer describes right now, unrounded — the ghost band's geometry. */
  range: TimeRange;
  /** The dates a release would commit: `range` rounded, or `range` itself when it is not. */
  commit: TimeRange;
  /** Whether `commit` went through the snap service at all, i.e. whether rounding is active. */
  rounded: boolean;
  /** The dates the store already holds because of this gesture; starts at the task's own. */
  dispatched: TimeRange;
  /**
   * The other selected tasks a multi-task move carries along, with the dates each held when the
   * drag began. Absent or empty for a single-task drag, a resize, or a chart without `multiDrag`.
   */
  peers?: readonly { id: TaskId; origin: TimeRange }[];
  /**
   * The numbers the most recent pointer move contributed, kept so an auto-scroll step (which moves
   * the view without a new pointer event) and a frame-synced replay can recompute the proposal.
   */
  lastInput?: MoveInput;
}

/** A drag that edits the task's completion fraction. */
export interface ProgressGesture extends GestureBase {
  readonly kind: "progress";
  /** The fraction the pointer describes right now, clamped to 0..1. */
  value: number;
  /** The fraction the store already holds because of this gesture; starts at the task's own. */
  dispatched: number;
}

/** Everything a single press-and-drag needs to remember. */
export type Gesture = DateGesture | ProgressGesture;

/** What the pointer proposes at one instant: what to draw, and what a release would commit. */
export interface Proposal {
  range: TimeRange;
  commit: TimeRange;
  rounded: boolean;
}

// The key must be unique per gesture and never derived from the task, so two separate drags of the
// same task stay two undo entries. A per-module random prefix keeps keys from two chart instances
// apart, and the counter keeps them apart within one.
/** Random prefix drawn once per module load, so keys are unique across instances too. */
const KEY_NONCE = Math.random().toString(36).slice(2, 10);
let keySequence = 0;

/** Mints a `coalesceKey` no other gesture will ever use. */
export function mintCoalesceKey(prefix: string): string {
  keySequence += 1;
  return `${prefix}:${KEY_NONCE}:${keySequence}`;
}

/**
 * Whether a pointer event belongs to this gesture.
 *
 * Pointer events are per-device, and only the pointer that pressed the bar may move or finish the
 * edit; letting a second one through would drag the bar to wherever that other pointer happened to
 * be.
 */
export function belongsTo(active: Pick<GestureBase, "pointerId">, pointerId: number): boolean {
  return active.pointerId === pointerId;
}

/** What a `pointer/barDown` on a bar tells the drag controller. */
export interface PressInput {
  /** The hit kind the press reported: the bar's body, one of its handles, or its progress strip. */
  hitKind: "bar" | "handle" | "progress";
  id: TaskId;
  pointerId: number;
  clientX: number;
  clientY: number;
  /** Where the bar was drawn, in content coordinates. */
  bar: BarPlacement;
  coalesceKey: string;
  /** The task's dates when the pointer went down. */
  origin: Readonly<TimeRange>;
  /** The task's completion fraction when the pointer went down. */
  progress: number;
  /** The time under the pointer, which decides which end a handle drag grabbed. */
  grabbed: number;
}

/** The gesture a press starts, decided from the hit kind. */
export function startGesture(press: PressInput): Gesture {
  const base = {
    id: press.id,
    pointerId: press.pointerId,
    coalesceKey: press.coalesceKey,
    bar: press.bar,
    clientX: press.clientX,
    clientY: press.clientY,
    dragging: false,
  };
  if (press.hitKind === "progress") {
    // The press lands on the progress-fill boundary, so the gesture starts at the fraction the
    // store already holds and follows the pointer from there.
    return { ...base, kind: "progress", value: press.progress, dispatched: press.progress };
  }
  const origin: TimeRange = { start: press.origin.start, end: press.origin.end };
  return {
    ...base,
    kind: "date",
    mode: press.hitKind === "bar" ? "move" : resizeModeAt(press.grabbed, origin),
    origin,
    range: origin,
    commit: origin,
    rounded: false,
    dispatched: origin,
    peers: [],
  };
}

/** Whether a press has travelled far enough to become a drag. */
export function exceedsThreshold(dx: number, dy: number): boolean {
  // The press becomes a drag only once 3px is exceeded, so a click that wobbles never edits
  // anything.
  return Math.hypot(dx, dy) > DRAG_THRESHOLD_PX;
}

/** How far in time the pointer has travelled since the press, in milliseconds. */
export function deltaMsFor(clientX: number, originClientX: number, pxPerMs: number): number {
  return pxPerMs > 0 ? (clientX - originClientX) / pxPerMs : 0;
}

/** The completion fraction the pointer describes, from its viewport-local x. */
export function progressOf(active: ProgressGesture, x: number, scrollLeft: number): number {
  return progressAt(x + scrollLeft, active.bar.left, active.bar.width);
}

/** What a pointer position tells a gesture: everything the arithmetic needs, and nothing else. */
export interface MoveInput {
  clientX: number;
  clientY: number;
  /** Buttons still held, as the pointer event reports them. */
  buttons: number;
  /** Whether Alt is held — this gesture's own bypass of the rounding rule. */
  altKey: boolean;
  /** The pointer's viewport-local x. */
  x: number;
  /**
   * The viewport's horizontal scroll offset, which turns `x` into a content coordinate. Only a
   * progress decision reads it, so callers populate it for progress gestures and may pass 0 for
   * date gestures (a date drag works in client-space deltas).
   */
  scrollLeft: number;
  pxPerMs: number;
  /** The chart's rounding rule, or `undefined` in a composition without the snap nest. */
  rounding: Rounding | undefined;
  /** The shortest duration a resize may leave, in milliseconds. Absent or 0 means no floor. */
  minDuration?: number;
}

/**
 * What the drag proposes for a pointer at `input`: the unrounded dates the ghost follows, and the
 * dates a release would commit.
 */
export function proposalAt(active: DateGesture, input: Readonly<MoveInput>): Proposal {
  const delta = deltaMsFor(input.clientX, active.clientX, input.pxPerMs);
  const floor = input.minDuration ?? 0;
  const range = proposeRange(active.mode, active.origin, delta, unrounded, floor);
  // Alt is this gesture's own bypass: while it is held the service is not consulted at all, so the
  // raw instant is what gets committed. It is read from the event that produced the instant, so
  // pressing or releasing it mid-drag takes effect on the next move.
  const rounding = input.altKey ? undefined : input.rounding;
  if (rounding === undefined) return { range, commit: range, rounded: false };
  const commit = proposeRange(active.mode, active.origin, delta, (t) => rounding.snap(t), floor);
  return { range, commit, rounded: true };
}

/** What one pointer move means for the gesture in progress. */
export type MoveDecision =
  /** Nothing to do: the press has not travelled far enough to be a drag yet. */
  | { readonly type: "ignore" }
  /**
   * The pointer is no longer pressed, so the drag is over without a release: a release outside the
   * window, or a pointer taken over by another application, can leave the capture without ever
   * delivering one, and ending the drag beats following an unpressed pointer.
   */
  | { readonly type: "abandon" }
  /** The drag proposes this completion fraction. */
  | { readonly type: "progress"; readonly value: number }
  /** The drag proposes these dates. */
  | { readonly type: "date"; readonly proposal: Proposal };

/** What a pointer move means for this gesture, without changing it. */
export function decideMove(active: Gesture, input: Readonly<MoveInput>): MoveDecision {
  if (input.buttons === 0) return { type: "abandon" };
  if (
    !active.dragging &&
    !exceedsThreshold(input.clientX - active.clientX, input.clientY - active.clientY)
  ) {
    return { type: "ignore" };
  }
  if (active.kind === "progress") {
    return { type: "progress", value: progressOf(active, input.x, input.scrollLeft) };
  }
  return { type: "date", proposal: proposalAt(active, input) };
}

/**
 * Writes a move's decision into the gesture: the drag is under way from here on, and the gesture
 * carries what the ghost draws and what a release would commit.
 *
 * An `ignore` or `abandon` decision changes nothing — those are the caller's to act on.
 */
export function applyMove(active: Gesture, decision: MoveDecision): void {
  if (decision.type === "progress") {
    if (active.kind !== "progress") return;
    active.dragging = true;
    active.value = decision.value;
    return;
  }
  if (decision.type !== "date" || active.kind !== "date") return;
  active.dragging = true;
  active.range = decision.proposal.range;
  active.commit = decision.proposal.commit;
  active.rounded = decision.proposal.rounded;
}

/** Whether a `pointer/barUp` is a cancelled capture rather than a release. */
export function isCancelledCapture(eventType: string): boolean {
  return eventType === POINTER_CANCEL;
}
