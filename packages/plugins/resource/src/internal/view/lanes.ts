// docs/specs/plugins/resource.md §3.4 / §4.2 — lane geometry of the `drag/lanes` seam.
/**
 * Which resource lane a root-relative y names.
 *
 * The panel records one lane per rendered resource row while it paints, in the strip body's own
 * content space (y = 0 at the top of the first painted element, before the body's vertical scroll
 * is applied). This module turns that list, the body's scroll offset and the body's own box —
 * measured against the gantt root, because the view plugin owns where the strip lands — into the
 * `LaneBox` the `drag/lanes` provider answers with, in the root-relative space interaction.md
 * declares the seam in.
 *
 * Pure arithmetic over plain values, so it is exercised without a host. `LaneBox` is imported from
 * the defining package rather than re-declared here: the seam's shape has exactly one owner.
 */
import type { LaneBox } from "@stargantt/plugin-interaction";

/** One lane as the panel records it while painting: content-space y, not root-relative. */
export interface LaneRecord {
  resourceId: string;
  /** Top of the lane in the strip body's content space (before its vertical scroll). */
  y: number;
  height: number;
}

/**
 * The lane at a root-relative `y`, translated back into root-relative coordinates, or `undefined`
 * when `y` names no lane — above or below the strip body's box, above/below every row, or in a gap
 * such as the header band or a team band. An empty lane list (the strip is released, or has not
 * painted yet) answers `undefined` for every y.
 *
 * `bodyTop` is the body scroller's own top edge relative to the gantt root and `bodyHeight` its
 * visible height, so the strip's placement is one measurement and everything inside it is exact
 * arithmetic over the band heights the DOM was laid out with.
 */
export function laneAtY(
  lanes: readonly LaneRecord[],
  y: number,
  scrollTop: number,
  bodyTop: number,
  bodyHeight: number,
): LaneBox | undefined {
  if (lanes.length === 0) return undefined;
  if (!Number.isFinite(y) || !Number.isFinite(bodyTop) || !Number.isFinite(bodyHeight)) {
    return undefined;
  }
  const local = y - bodyTop;
  if (local < 0 || local >= bodyHeight) return undefined;
  const offset = Number.isFinite(scrollTop) ? scrollTop : 0;
  const contentY = local + offset;
  // The panel records lanes in paint order, so `y` ascends strictly: the candidate is the last
  // lane starting at or before `contentY`, found by binary search. This runs per pointermove of a
  // lane drag, and a large roster must not turn that into a scan of every row.
  let lo = 0;
  let hi = lanes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((lanes[mid] as LaneRecord).y <= contentY) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return undefined;
  const lane = lanes[lo - 1] as LaneRecord;
  // Not every gap between lanes is a lane: a team band sits between two of them.
  if (contentY >= lane.y + lane.height) return undefined;
  return { resourceId: lane.resourceId, y: lane.y - offset + bodyTop, height: lane.height };
}

/**
 * One named resource's lane, in the same root-relative space {@link laneAtY} answers in — so a
 * consumer can compare the two numbers — or `undefined` when that resource has no painted lane.
 */
export function laneOfResource(
  lanes: readonly LaneRecord[],
  resourceId: string,
  scrollTop: number,
  bodyTop: number,
  bodyHeight: number,
): LaneBox | undefined {
  if (!Number.isFinite(bodyTop) || !Number.isFinite(bodyHeight) || bodyHeight <= 0) return undefined;
  const offset = Number.isFinite(scrollTop) ? scrollTop : 0;
  for (const lane of lanes) {
    if (lane.resourceId !== resourceId) continue;
    return { resourceId: lane.resourceId, y: lane.y - offset + bodyTop, height: lane.height };
  }
  return undefined;
}
