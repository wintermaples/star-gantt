// docs/specs/plugins/scheduling.md §5.2 / §4.3
/**
 * The port-drag gesture: pressing a bar's connector port, dragging, and what the release means.
 *
 * The gesture is one state object with named transitions (`start` / `track` / `finish` / `cancel`)
 * plus the pure drop resolution, so the area's `pointer/*` handlers are wiring only and the rules
 * — which port a press grabbed, what counts as landing on a bar, which link type the two joined
 * ends produce — are unit-testable without a host (the pointer-identity guard of §4.3 is folded
 * into `start`/`track`/`finish`).
 *
 * Coordinate spaces, as the view's `pointer/*` events and `TaskBarsService.barRect` define them:
 * `origin` is in content coordinates (it is derived from a bar box), `point` is in the
 * viewport-local space the events report and the overlay paints in.
 */
import type { LinkType, TaskId } from "@stargantt/plugin-data-store";
import type { BarEnd, Point } from "./geometry";
import { PORT_CLEARANCE, PORT_HIT_SLACK, hitPort, linkTypeFor, portCentre } from "./geometry";
import type { LinkedPredicate } from "./pairs";
import type { TaskAtY } from "./routes";

/** How far beyond a bar's edge a drop still counts as landing on that bar's end. */
export const DROP_REACH = PORT_CLEARANCE + PORT_HIT_SLACK;

/** A link drag in progress: where it started, and where the pointer is now. */
export interface LinkDrag {
  sourceId: TaskId;
  sourceEnd: BarEnd;
  /** Port centre the drag started from, in content coordinates. */
  origin: Point;
  /** Current pointer position, in viewport-local coordinates (the space `pointer/*` reports). */
  point: Point;
  /**
   * The `PointerEvent.pointerId` that started this drag (§4.3): only that pointer advances or
   * finishes it. `undefined` when the caller did not name one.
   */
  pointerId: number | undefined;
}

/** The `link/add` payload a completed drag asks for, before creation-time defaults are applied. */
export interface LinkDraft {
  sourceId: TaskId;
  targetId: TaskId;
  type: LinkType;
}

/** The port-drag gesture's state, with one owner and named transitions. */
export interface PortDragGesture {
  /** The drag in flight, or `null` when idle — what the rubber band is drawn from. */
  current(): LinkDrag | null;
  /**
   * Starts a drag from the connector port under a content-space point, if there is one there.
   *
   * Returns whether a drag is now in flight; a press that landed on no port changes nothing.
   */
  start(
    found: TaskAtY,
    contentX: number,
    contentY: number,
    point: Point,
    pointerId?: number,
  ): boolean;
  /**
   * Moves the in-flight drag's pointer position. Returns whether there was a drag *this pointer
   * owns* to move — a move reported by any other pointer is ignored (§4.3).
   */
  track(point: Point, pointerId?: number): boolean;
  /**
   * Ends the gesture, returning the drag that was in flight, or `null` when there was none or when
   * the release came from a different pointer than the one that started it (§4.3).
   */
  finish(pointerId?: number): LinkDrag | null;
  /** Abandons the gesture without resolving a drop. Returns whether a drag was abandoned. */
  cancel(): boolean;
}

/** Whether an event's pointer is the one that owns this drag (an unnamed pointer matches). */
function ownsDrag(drag: LinkDrag, pointerId: number | undefined): boolean {
  return drag.pointerId === undefined || pointerId === undefined || drag.pointerId === pointerId;
}

/** Creates the port-drag gesture state for one chart. */
export function createPortDragGesture(): PortDragGesture {
  let drag: LinkDrag | null = null;

  return {
    current: () => drag,
    start(found, contentX, contentY, point, pointerId): boolean {
      // §4.3 — pointer identity, the same rule the gesture arbiter itself enforces for any other
      // gesture: only ONE port drag is ever in flight. Without this guard a second `pointer/barDown`
      // on a port — a stray second touch point, or another pointer device pressed mid-drag — would
      // silently HIJACK the gesture, overwriting the first pointer's `drag` (and its `origin`/
      // `sourceId`) out from under it; the first pointer's own subsequent `track`/`finish` calls
      // would then move or complete a drag it no longer recognizes as its own.
      if (drag !== null) return false;
      const end = hitPort(found.box, contentX, contentY);
      if (end === undefined) return false;
      drag = {
        sourceId: found.task.id,
        sourceEnd: end,
        origin: portCentre(found.box, end),
        point,
        pointerId,
      };
      return true;
    },
    track(point, pointerId): boolean {
      if (drag === null || !ownsDrag(drag, pointerId)) return false;
      drag.point = point;
      return true;
    },
    finish(pointerId): LinkDrag | null {
      if (drag === null) return null;
      if (!ownsDrag(drag, pointerId)) return null;
      const started = drag;
      drag = null;
      return started;
    },
    cancel(): boolean {
      if (drag === null) return false;
      drag = null;
      return true;
    },
  };
}

/**
 * The bar end a release at this point connects to: the port it landed on, or — when it missed both
 * ports — the nearer half of the bar. The drop-candidate ring uses the same rule, so the guided end
 * and the connected end can never disagree (§5.5).
 */
export function dropEnd(box: TaskAtY["box"], contentX: number, contentY: number): BarEnd {
  return hitPort(box, contentX, contentY) ?? (contentX < box.x + box.width / 2 ? "start" : "end");
}

/**
 * The link a completed drag asks for, or `undefined` when the release is not a link.
 *
 * A release counts when it lands on a *different* task's bar that the drag's source is not linked
 * to already, within `DROP_REACH` of that bar horizontally. The type comes from the two joined
 * ends, so the derivation is total and the pointer path never consults `defaultLinkType` (§5.2).
 * Refusing here also unrings the drop-candidate highlight, which resolves through this same
 * function — the ring never promises a link the drop would refuse (§5.5).
 */
export function resolveDrop(
  drag: LinkDrag,
  found: TaskAtY,
  contentX: number,
  contentY: number,
  isLinked: LinkedPredicate,
): LinkDraft | undefined {
  // A link from a task to itself is never meaningful, whichever ends were joined.
  if (found.task.id === drag.sourceId) return undefined;
  const box = found.box;
  if (contentX < box.x - DROP_REACH || contentX > box.x + box.width + DROP_REACH) return undefined;
  // §5.2 — one dependency per ordered pair, so a pair that is already linked has no second link to
  // create: the store would refuse the command, and the gesture must not promise what the drop
  // cannot deliver. The reverse direction is a different pair and is offered normally.
  if (isLinked(drag.sourceId, found.task.id)) return undefined;
  const end = dropEnd(box, contentX, contentY);
  return {
    sourceId: drag.sourceId,
    targetId: found.task.id,
    type: linkTypeFor(drag.sourceEnd, end),
  };
}
