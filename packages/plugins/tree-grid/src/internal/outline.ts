/**
 * Outline (hierarchy) helpers: indent / outdent targets, insert positions, level plans and
 * descendant counts, all computed over a `ReadonlyDataView`. Pure logic: no DOM, no core imports.
 */
// docs/specs/plugins/tree-grid.md § Commands — outline editing, insert rows, expand to level,
// and the collapsed-branch badge.
import type { ReadonlyDataView, TaskId } from "@stargantt/plugin-data-store";
import type { InsertPosition } from "../types";
// docs/specs/plugins/tree-grid.md § Dependencies — the shared one-day constant, never re-declared
// per package; used by the no-reference insert-dates fallback below.
import { MS_DAY } from "@stargantt/sdk";

/**
 * The task that becomes `id`'s parent when it is indented: its immediately preceding sibling.
 * `undefined` when indenting is impossible — an unknown id, or a first sibling (nothing precedes
 * it), or when the preceding sibling is the task itself (malformed data).
 */
export function indentTarget(view: ReadonlyDataView, id: TaskId): TaskId | undefined {
  const task = view.byId.get(id);
  if (task === undefined) return undefined;
  const siblings = view.children.get(task.parentId) ?? [];
  const at = siblings.indexOf(id);
  if (at <= 0) return undefined;
  const prev = siblings[at - 1];
  return prev === id ? undefined : prev;
}

/**
 * The parent `id` gets when it is outdented: its grandparent (`null` = becomes a root).
 * `undefined` when outdenting is impossible — an unknown id, or a task already at the root level.
 */
export function outdentTarget(
  view: ReadonlyDataView,
  id: TaskId,
): { parentId: TaskId | null } | undefined {
  const task = view.byId.get(id);
  if (task === undefined || task.parentId === null) return undefined;
  const parent = view.byId.get(task.parentId);
  if (parent === undefined) return undefined;
  return { parentId: parent.parentId };
}

/**
 * Where a new task goes for a `view/rowInsert` relative to `ref`: the parent to create it under
 * and the sibling index to insert at (`undefined` = append at the end of that parent's children).
 * With no reference the new task is appended at the end of the roots. `undefined` when `ref` names
 * no task.
 */
export function insertSlot(
  view: ReadonlyDataView,
  ref: TaskId | undefined,
  position: InsertPosition,
): { parentId: TaskId | null; index: number | undefined } | undefined {
  if (ref === undefined) return { parentId: null, index: undefined };
  const task = view.byId.get(ref);
  if (task === undefined) return undefined;
  if (position === "child") return { parentId: ref, index: undefined };
  const siblings = view.children.get(task.parentId) ?? [];
  const at = siblings.indexOf(ref);
  if (at < 0) return { parentId: task.parentId, index: undefined };
  return { parentId: task.parentId, index: position === "above" ? at : at + 1 };
}

/**
 * The current last root task, in the store's sibling order — `undefined` when the store has no
 * root tasks at all. Every task traces back to a root, so "no root tasks" and "empty store" are the
 * same condition, which is what the no-reference insert-dates fallback below keys off.
 */
export function lastRootTaskId(view: ReadonlyDataView): TaskId | undefined {
  const roots = view.children.get(null) ?? [];
  return roots.length === 0 ? undefined : roots[roots.length - 1];
}

/**
 * The `start` / `end` a `view/rowInsert` with `id` omitted gives its new task.
 *
 * `lastRootStart` is the current last root task's `start` (`undefined` for an empty store);
 * `cellAt` is `TimelineService.gridCellAt`, looked up per call (`undefined` when no time axis is
 * composed, or the instant it is given resolves no cell); `xToT` is `TimelineService.xToT`,
 * `undefined` under the same no-axis condition.
 *
 * With a last root task, the new task is dated exactly as a `"below"` insert on it would be: same
 * start, one grid cell long (falling back to one day without a usable axis). With an empty store,
 * the new task fills the grid cell containing `now` clamped to the axis origin
 * (`max(now, xToT(0))`) — so a host-configured **future** origin dates the task at the origin
 * rather than before it — falling back to the UTC calendar day containing `now` when no usable
 * axis is composed. Either way this never answers an undated (epoch) task.
 */
// docs/specs/plugins/tree-grid.md § Commands — insert rows: dates for a reference-less insert.
export function noRefInsertDates(
  lastRootStart: number | undefined,
  now: number,
  cellAt: (t: number) => { start: number; end: number } | undefined,
  xToT: ((x: number) => number) | undefined,
): { start: number; end: number } {
  // A malformed reference (a last root task with a non-finite start) falls through to the
  // empty-store rule rather than propagating NaN or a legacy epoch date.
  if (lastRootStart !== undefined && Number.isFinite(lastRootStart)) {
    const cell = cellAt(lastRootStart);
    const duration = cell === undefined ? MS_DAY : cell.end - cell.start;
    return { start: lastRootStart, end: lastRootStart + duration };
  }
  const at = xToT === undefined ? now : Math.max(now, xToT(0));
  const cell = cellAt(at);
  if (cell !== undefined) return { start: cell.start, end: cell.end };
  // Floor the clamped instant, not `now` — a future origin must hold even when the axis
  // answers no cell.
  const dayStart = Math.floor(at / MS_DAY) * MS_DAY;
  return { start: dayStart, end: dayStart + MS_DAY };
}

/**
 * The per-branch expanded states that make exactly the rows of depth ≤ `level` visible: a branch
 * node at depth < `level` is expanded, one at depth ≥ `level` is collapsed. Only branch nodes
 * (tasks with children) appear in the plan — leaves have no expand state. Iterative DFS with a
 * cycle guard, so malformed data terminates.
 */
export function planExpandToLevel(
  view: ReadonlyDataView,
  level: number,
): { id: TaskId; expanded: boolean }[] {
  const plan: { id: TaskId; expanded: boolean }[] = [];
  const seen = new Set<TaskId>();
  const stack: { id: TaskId; depth: number }[] = [];
  for (const id of view.children.get(null) ?? []) stack.push({ id, depth: 0 });
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    const children = view.children.get(node.id) ?? [];
    if (children.length === 0) continue;
    plan.push({ id: node.id, expanded: node.depth < level });
    for (const child of children) stack.push({ id: child, depth: node.depth + 1 });
  }
  return plan;
}

/** The number of descendants (children, grandchildren, …) of `id`. Cycle-guarded. */
export function countDescendants(view: ReadonlyDataView, id: TaskId): number {
  const seen = new Set<TaskId>([id]);
  const stack: TaskId[] = [...(view.children.get(id) ?? [])];
  let count = 0;
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined) break;
    if (seen.has(next)) continue;
    seen.add(next);
    count += 1;
    for (const child of view.children.get(next) ?? []) stack.push(child);
  }
  return count;
}
