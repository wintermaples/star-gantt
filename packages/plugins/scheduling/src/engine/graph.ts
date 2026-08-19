// docs/specs/plugins/scheduling.md §2.1 / §2.7 / §2.8 (`engine/graph.ts`)
/**
 * Graph walks in topological order over `ReadonlyDataView.linksByTask` — the index the store
 * maintains for scheduling propagation — and over the parent/child hierarchy.
 *
 * Two edge kinds exist:
 *  - **link edges** `source → target`, taken from `linksByTask`;
 *  - **hierarchy edges** `child → parent`, needed because a summary task rolls its times up from
 *    its children, so a summary must be ordered *after* every child it aggregates.
 *
 * Every walk here is restricted to an explicit node set. That restriction is what keeps the
 * recalculation differential instead of recomputing every task.
 */
import type { Link, LinkId, ReadonlyDataView, TaskId } from "@stargantt/plugin-data-store";

const NO_LINKS: readonly Link[] = [];

export function outLinks(view: ReadonlyDataView, id: TaskId): readonly Link[] {
  return view.linksByTask.get(id)?.out ?? NO_LINKS;
}

export function inLinks(view: ReadonlyDataView, id: TaskId): readonly Link[] {
  return view.linksByTask.get(id)?.in ?? NO_LINKS;
}

/** The task's parent, or `null` when it is a root or does not exist. */
export function parentOf(view: ReadonlyDataView, id: TaskId): TaskId | null {
  return view.byId.get(id)?.parentId ?? null;
}

/**
 * Everything reachable forward from `seeds` through link edges and hierarchy edges, seeds
 * included. Ids that are not in `byId` are dropped.
 */
export function forwardClosure(view: ReadonlyDataView, seeds: Iterable<TaskId>): Set<TaskId> {
  const seen = new Set<TaskId>();
  const queue: TaskId[] = [];

  const push = (id: TaskId): void => {
    if (seen.has(id) || !view.byId.has(id)) return;
    seen.add(id);
    queue.push(id);
  };

  for (const id of seeds) push(id);

  for (let head = 0; head < queue.length; head++) {
    const id = queue[head] as TaskId;
    for (const link of outLinks(view, id)) push(link.targetId);
    const parent = parentOf(view, id);
    if (parent !== null) push(parent);
  }
  return seen;
}

/**
 * Kahn topological order over `nodes`, counting only edges whose **both** endpoints are in `nodes`
 * (a predecessor outside the set does not move, so it imposes no ordering).
 *
 * Nodes trapped in a cycle are **omitted** from the result: they cannot be ordered, and the caller
 * therefore leaves them untouched. Link cycles are already rejected in the will phase of
 * `link/add` (§2.7), so this is a safety net rather than a normal path.
 */
export function topoOrder(
  view: ReadonlyDataView,
  nodes: ReadonlySet<TaskId>,
  hierarchy: boolean,
): TaskId[] {
  const indegree = new Map<TaskId, number>();
  for (const id of nodes) indegree.set(id, 0);

  const bump = (id: TaskId, delta: number): number | undefined => {
    const current = indegree.get(id);
    if (current === undefined) return undefined;
    const next = current + delta;
    indegree.set(id, next);
    return next;
  };

  for (const id of nodes) {
    for (const link of outLinks(view, id)) {
      if (nodes.has(link.targetId)) bump(link.targetId, 1);
    }
    if (hierarchy) {
      const parent = parentOf(view, id);
      if (parent !== null && nodes.has(parent)) bump(parent, 1);
    }
  }

  const queue: TaskId[] = [];
  for (const [id, degree] of indegree) {
    if (degree === 0) queue.push(id);
  }

  const order: TaskId[] = [];
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head] as TaskId;
    order.push(id);
    for (const link of outLinks(view, id)) {
      if (nodes.has(link.targetId) && bump(link.targetId, -1) === 0) queue.push(link.targetId);
    }
    if (hierarchy) {
      const parent = parentOf(view, id);
      if (parent !== null && nodes.has(parent) && bump(parent, -1) === 0) queue.push(parent);
    }
  }
  return order;
}

/**
 * Detects whether adding a link would close a cycle, so the will phase of `link/add` can refuse it
 * before it is applied (§2.7).
 *
 * `candidate` is a link that is **not yet** part of `view`. It closes a cycle exactly when a path
 * of existing links already leads from its target back to its source.
 *
 * The returned chain starts with `candidate.id` and continues with the existing link ids that lead
 * back from `candidate.targetId` to `candidate.sourceId`, i.e. the cycle in traversal order.
 */
export function detectCycle(
  view: ReadonlyDataView,
  candidate: Link,
): readonly LinkId[] | undefined {
  if (candidate.sourceId === candidate.targetId) return [candidate.id];

  const cameFrom = new Map<TaskId, Link>();
  const seen = new Set<TaskId>([candidate.targetId]);
  const queue: TaskId[] = [candidate.targetId];

  for (let head = 0; head < queue.length; head++) {
    const id = queue[head] as TaskId;
    for (const link of outLinks(view, id)) {
      const next = link.targetId;
      if (seen.has(next)) continue;
      cameFrom.set(next, link);

      if (next === candidate.sourceId) {
        const chain: LinkId[] = [];
        let node: TaskId = next;
        while (node !== candidate.targetId) {
          const step = cameFrom.get(node);
          if (step === undefined) break;
          chain.push(step.id);
          node = step.sourceId;
        }
        chain.reverse();
        return [candidate.id, ...chain];
      }

      seen.add(next);
      queue.push(next);
    }
  }
  return undefined;
}
