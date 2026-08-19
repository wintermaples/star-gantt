// docs/specs/plugins/scheduling.md §5.2 / §5.6
/**
 * Whether two tasks are linked already — the question both link-creation paths ask before offering
 * a link the store would refuse.
 *
 * The store holds at most one dependency per ordered pair, so `link/add` over a pair that already
 * has one produces nothing. The pointer gesture and the keyboard chord ask this first, so neither
 * offers what the drop or the press cannot deliver.
 */
import type { ReadonlyDataView, TaskId } from "@stargantt/plugin-data-store";

/** Whether the store already holds a link running from `sourceId` to `targetId`. */
export type LinkedPredicate = (sourceId: TaskId, targetId: TaskId) => boolean;

/**
 * Whether a link runs from `sourceId` to `targetId` in `view`, whatever its type and lag. The
 * opposite direction is a different pair and is not consulted — a reversed link is the cycle
 * check's business (§2.7), not this one's.
 *
 * The lookup walks the source task's outgoing bucket, so it costs that task's out-degree.
 */
export function isPairLinked(view: ReadonlyDataView, sourceId: TaskId, targetId: TaskId): boolean {
  const out = view.linksByTask.get(sourceId)?.out;
  return out !== undefined && out.some((link) => link.targetId === targetId);
}
