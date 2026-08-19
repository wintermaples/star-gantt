// docs/specs/plugins/interaction.md §1.3 (`dragging-lane`) / §3 (`drag/lanes`) — dragging a bar
// vertically onto another resource's lane reassigns the task to that lane's resource. The lane
// geometry and the reassignment write both belong to the composed provider; this module only
// decides which lane a pointer names and whether a drop there means anything.
/**
 * The resource-lane drag: the state a lane drag carries, the structural guard the point's
 * contributions pass, and which lane a pointer position targets.
 *
 * Everything here is arithmetic over plain values plus one structural guard, so all of it can be
 * exercised without booting a host.
 */
import type { TaskId } from "@stargantt/plugin-data-store";
import type { LaneBox, LaneDragProvider } from "../../types";
import type { GestureBase } from "./pointer-gesture";

/**
 * A `drag/lanes` contribution is admitted only when it structurally offers what the drag needs.
 *
 * A composition whose provider lacks either required member leaves the drag inert instead of
 * throwing. The other two members are optional: a provider that cannot mark its own drop target
 * still drives the drag, it just does so unmarked.
 */
export function isUsableLaneProvider(candidate: unknown): candidate is LaneDragProvider {
  if (typeof candidate !== "object" || candidate === null) return false;
  const seam = candidate as Partial<Record<keyof LaneDragProvider, unknown>>;
  return typeof seam.laneAt === "function" && typeof seam.reassign === "function";
}

/** A vertical drag of a bar across resource lanes: same press bookkeeping, target is a lane. */
export interface LaneGesture extends GestureBase {
  readonly kind: "lane";
  /** The resource whose lane the dragged bar sat in when the drag began. */
  readonly sourceResourceId: string;
  /** The lane a drop right now would reassign to, or `undefined` while none is targeted. */
  target: LaneBox | undefined;
}

/** Turns an established move drag into a lane drag, keeping the press bookkeeping. */
export function startLaneGesture(from: GestureBase, sourceResourceId: string): LaneGesture {
  return {
    kind: "lane",
    id: from.id,
    pointerId: from.pointerId,
    coalesceKey: from.coalesceKey,
    bar: from.bar,
    clientX: from.clientX,
    clientY: from.clientY,
    dragging: true,
    sourceResourceId,
    target: undefined,
  };
}

/**
 * The lane a pointer at `y` (root-relative) targets, or `undefined` when it names no lane or names
 * the source lane itself — dropping a task back onto its own resource is not a reassignment, so it
 * is never marked as a target.
 */
export function laneTargetAt(
  y: number,
  provider: Pick<LaneDragProvider, "laneAt">,
  sourceResourceId: string,
): LaneBox | undefined {
  const lane = provider.laneAt(y);
  if (lane === undefined) return undefined;
  if (lane.resourceId === sourceResourceId) return undefined;
  return lane;
}

/**
 * Asks the provider to mark `resourceId` as the drop target, or to clear the mark with `null`.
 *
 * A provider without the member is silently accepted: the drag runs unmarked.
 */
export function markLaneTarget(provider: LaneDragProvider, resourceId: string | null): void {
  provider.highlightLane?.(resourceId);
}

/**
 * The lane the dragged task is currently on, or `undefined` when the provider cannot say.
 *
 * The provider answers directly when it offers `laneOfTask`; its lanes may sit below the chart, so
 * the bar's own position names none of them. A provider that does paint its lanes over the chart
 * offers no such member, and the source is then read from the bar's own centre — never from the
 * press point, so a press near a lane boundary cannot name the neighbouring lane.
 */
export function sourceLaneOf(
  provider: LaneDragProvider,
  id: TaskId,
  barCentreRootY: number | undefined,
): LaneBox | undefined {
  if (provider.laneOfTask !== undefined) return provider.laneOfTask(id);
  if (barCentreRootY === undefined) return undefined;
  return provider.laneAt(barCentreRootY);
}
