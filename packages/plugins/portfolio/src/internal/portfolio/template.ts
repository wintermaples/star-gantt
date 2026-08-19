// docs/specs/plugins/portfolio.md §2.5
/**
 * Template duplication planning: deep-copies a project's task subtree (and its internal links)
 * under fresh ids, optionally shifted in time and with progress reset. Pure and hostless — the
 * plugin executes the plan through `sdk/aggregate`'s `createTransactionBatcher` (§2.5).
 *
 * Neither the copied root nor its descendants carry an `orderKey`: the head `task/add` command
 * (built by the data-store's own command runner) assigns the root's key after the existing
 * top-level roots, and the store's default empty-key insertion keeps the descendants' relative
 * order stable among themselves — the store assigns fresh sibling order either way.
 */
import type { Link, Patch, Task, TaskId } from "@stargantt/plugin-data-store";

/** Input of `buildDuplicatePlan`. */
export interface DuplicateInput {
  /** The source subtree, parent-before-child, root first (as `collectSubtree` returns it). */
  subtree: readonly Readonly<Task>[];
  /** Every link of the store; only links internal to the subtree are copied. */
  links: readonly Readonly<Link>[];
  /** Name of the duplicated root task. */
  rootName: string;
  /** Epoch ms the copy's root starts at; non-finite = no shift. */
  startAt: number | undefined;
  /** Keep task progress instead of clearing it. */
  keepProgress: boolean;
  /** Mints a store-unique id for each copied task/link. */
  freshId: () => string;
}

/** The plan: the first `task/add` payload plus the patches appended into its transaction. */
export interface DuplicatePlan {
  first: Task;
  rest: Patch[];
  rootId: TaskId;
}

/** Builds the duplication plan, or `undefined` for an empty subtree. */
export function buildDuplicatePlan(input: DuplicateInput): DuplicatePlan | undefined {
  const root = input.subtree[0];
  if (root === undefined) return undefined;
  const delta =
    input.startAt !== undefined && Number.isFinite(input.startAt) ? input.startAt - root.start : 0;

  const idMap = new Map<TaskId, TaskId>();
  for (const task of input.subtree) idMap.set(task.id, input.freshId());

  const copies: Task[] = input.subtree.map((task) => {
    const isRoot = task.id === root.id;
    const parent = task.parentId === null ? null : idMap.get(task.parentId);
    const copy: Task = {
      id: idMap.get(task.id) as TaskId,
      // The copied root starts a new top-level project; descendants follow the id map.
      parentId: isRoot ? null : (parent ?? null),
      name: isRoot ? input.rootName : task.name,
      start: task.start + delta,
      end: task.end + delta,
    };
    if (input.keepProgress && task.progress !== undefined) copy.progress = task.progress;
    if (task.type !== undefined) copy.type = task.type;
    if (task.calendarId !== undefined) copy.calendarId = task.calendarId;
    if (task.constraint !== undefined) copy.constraint = structuredClone(task.constraint);
    if (task.meta !== undefined) copy.meta = structuredClone(task.meta);
    return copy;
  });

  const rest: Patch[] = copies.slice(1).map((task) => ({ op: "task/add", task }));
  for (const link of input.links) {
    const sourceId = idMap.get(link.sourceId);
    const targetId = idMap.get(link.targetId);
    if (sourceId === undefined || targetId === undefined) continue;
    const copy: Link = { id: input.freshId(), sourceId, targetId, type: link.type };
    if (link.lag !== undefined) copy.lag = link.lag;
    rest.push({ op: "link/add", link: copy });
  }

  return { first: copies[0] as Task, rest, rootId: copies[0]?.id as TaskId };
}
