// docs/specs/plugins/portfolio.md §2.1
/**
 * Task-tree walking helpers over a flat task list: child index, subtree collection in
 * parent-before-child order, and ancestor lookup. Pure and hostless.
 */
import type { Task, TaskId } from "@stargantt/plugin-data-store";

/** Builds the parent → children index over a flat task list, preserving list order. */
export function childIndex(tasks: Iterable<Readonly<Task>>): Map<TaskId | null, Task[]> {
  const index = new Map<TaskId | null, Task[]>();
  for (const task of tasks) {
    const key = task.parentId ?? null;
    const bucket = index.get(key);
    if (bucket === undefined) index.set(key, [task as Task]);
    else bucket.push(task as Task);
  }
  return index;
}

/**
 * The subtree rooted at `rootId` (root included), parent-before-child, or an empty array when
 * the root is not in `byId`.
 */
export function collectSubtree(
  rootId: TaskId,
  byId: ReadonlyMap<TaskId, Readonly<Task>>,
  children: ReadonlyMap<TaskId | null, readonly Readonly<Task>[]>,
): Task[] {
  const root = byId.get(rootId);
  if (root === undefined) return [];
  const out: Task[] = [];
  // BFS over an index cursor, never `shift()`: shifting re-packs the whole queue per step and
  // turns the walk quadratic (portfolio.md §2.1's O(subtree)-per-call promise).
  const queue: Readonly<Task>[] = [root];
  const seen = new Set<TaskId>();
  for (let head = 0; head < queue.length; head++) {
    const task = queue[head] as Readonly<Task>;
    if (seen.has(task.id)) continue; // corrupt parent cycles never loop us
    seen.add(task.id);
    out.push(task as Task);
    for (const child of children.get(task.id) ?? []) queue.push(child);
  }
  return out;
}

/**
 * Whether `candidate` is `taskId` itself or one of its descendants, walking parent links in
 * `byId`. Bounded against parent cycles.
 */
export function isInSubtree(
  candidate: TaskId,
  taskId: TaskId,
  byId: ReadonlyMap<TaskId, Readonly<Task>>,
): boolean {
  let current: TaskId | null | undefined = candidate;
  const seen = new Set<TaskId>();
  while (current !== null && current !== undefined && !seen.has(current)) {
    if (current === taskId) return true;
    seen.add(current);
    current = byId.get(current)?.parentId;
  }
  return false;
}
