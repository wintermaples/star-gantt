// docs/specs/plugins/interaction.md §4 (copy order, anchor, cell-paste walking). Pure module — no
// host, no DOM types beyond structural walking.
import type { ReadonlyDataView, Task, TaskId } from "@stargantt/plugin-data-store";
import type { PasteTarget } from "./transfer";

/** The slice of `RowsService` this module reads; absent when tree-grid is not composed. */
export interface RowOrder {
  rowOf(id: TaskId): number | undefined;
  taskIdAt(row: number): TaskId | undefined;
  rowCount(): number;
}

/** `ids` in visible-row order when a row model resolves, in given order otherwise. */
export function orderIds(ids: readonly TaskId[], rows: RowOrder | undefined): TaskId[] {
  const list = [...ids];
  if (rows === undefined) return list;
  const at = (id: TaskId): number => rows.rowOf(id) ?? Number.MAX_SAFE_INTEGER;
  return list.sort((a, b) => at(a) - at(b));
}

/**
 * Where a structured paste inserts relative to `anchorId`: as a sibling directly after it, or
 * appended at the root level when there is no usable anchor.
 */
export function siblingTarget(view: ReadonlyDataView, anchorId: TaskId | undefined): PasteTarget {
  const anchor = anchorId === undefined ? undefined : view.byId.get(anchorId);
  if (anchor === undefined) {
    return { parentId: null, index: (view.children.get(null) ?? []).length };
  }
  const siblings = view.children.get(anchor.parentId) ?? [];
  const at = siblings.indexOf(anchor.id);
  return { parentId: anchor.parentId, index: at < 0 ? siblings.length : at + 1 };
}

/**
 * Up to `count` tasks starting at the anchor and walking downward — visible-row order when a row
 * model resolves, store iteration order otherwise; empty with no anchor.
 *
 * Summary rows are not targets (their dates are derived and the store refuses edits to them): the
 * walk steps over them without consuming a text row, so the pasted rows land on the next editable
 * tasks below instead of producing silent per-row no-ops.
 */
export function walkTargets(
  view: ReadonlyDataView,
  anchorId: TaskId | undefined,
  count: number,
  rows: RowOrder | undefined,
  taskIds: () => Iterable<TaskId>,
): Readonly<Task>[] {
  if (anchorId === undefined || view.byId.get(anchorId) === undefined) return [];
  const out: Readonly<Task>[] = [];
  const take = (task: Readonly<Task> | undefined): void => {
    if (task !== undefined && task.type !== "summary") out.push(task);
  };
  if (rows !== undefined) {
    const first = rows.rowOf(anchorId);
    if (first === undefined) return [];
    for (let row = first; row < rows.rowCount() && out.length < count; row++) {
      const id = rows.taskIdAt(row);
      take(id === undefined ? undefined : view.byId.get(id));
    }
    return out;
  }
  let started = false;
  for (const id of taskIds()) {
    if (!started) {
      if (id !== anchorId) continue;
      started = true;
    }
    take(view.byId.get(id));
    if (out.length >= count) break;
  }
  return out;
}
