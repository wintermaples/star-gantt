// docs/specs/plugins/interaction.md §2.2 / §3 — working-time avoidance arithmetic.
/**
 * Keeping an edited instant inside working time.
 *
 * The intervals themselves come from the composed `snap/workingTime` provider; this module only
 * decides *which* boundary an unacceptable instant moves to. Pure arithmetic over epoch
 * milliseconds UTC and three probes — unit-testable without a host or a provider.
 */
import type { WorkingBoundaries } from "../../types";

/**
 * Moves an instant into working time, to the nearest working-interval boundary.
 *
 * An instant is acceptable **in place** when it lies inside a working interval or exactly on either
 * of that interval's boundaries — start or end. The end clause is what lets an exclusive task end
 * rest on the instant that closes a working window (the 17:00 ending a 09:00–17:00 day, or the
 * midnight closing a working Friday) instead of being dragged into the gap that follows.
 *
 * Any other instant moves to the nearest working-interval boundary: the closest acceptable boundary
 * at-or-before and the closest at-or-after are both candidates, the smaller distance wins, and a tie
 * resolves **forward** to the later boundary — matching the rounding rule's upward tie, so the
 * answer never depends on which direction the edit came from.
 *
 * When neither direction finds a boundary within the provider's bounded walk (an all-non-working
 * calendar), and for a non-finite instant, `t` is returned unchanged: a data error made visible
 * rather than an infinite loop.
 */
export function adjustToWorkingBoundary(t: number, bounds: WorkingBoundaries): number {
  // In-place acceptance is decided by asking whether the instant *is* working time, never by
  // comparing a boundary walk's answer to its own argument: a walk returns its argument both when
  // the instant is working and when it hit its bound with nothing to reach, so the comparison would
  // accept a non-working instant wherever one direction has nothing to walk to. `t` itself covers
  // "inside a working interval, or exactly on its start"; the millisecond before it covers the
  // instant that closes one, which is what lets an exclusive end rest there.
  if (!Number.isFinite(t)) return t;
  if (bounds.isWorkingInstant(t) || bounds.isWorkingInstant(t - 1)) return t;

  // `t` is known not to be acceptable here, so a walk that answers `t` is one that gave up: it
  // contributes no candidate, and the other direction — if it has one — decides alone.
  const forward = bounds.nextWorkingStart(t);
  const backward = bounds.previousWorkingEnd(t);
  const hasForward = forward > t;
  const hasBackward = backward < t;
  if (!hasForward) return hasBackward ? backward : t;
  if (!hasBackward) return forward;
  return forward - t <= t - backward ? forward : backward;
}

/** A `snap/workingTime` contribution missing its one required member is treated as absent. */
export function isUsableWorkingTimeProvider(candidate: unknown): boolean {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof (candidate as { boundaries?: unknown }).boundaries === "function"
  );
}
