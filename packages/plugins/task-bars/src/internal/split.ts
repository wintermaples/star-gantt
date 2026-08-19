/**
 * Compressed-row displays of `stargantt.task-bars`: a collapsed summary's row carrying its
 * children as individual bars. Pure functions over the reader shapes, so the rules unit-test
 * without a host.
 */
import type { Task, TaskId } from "@stargantt/plugin-data-store";
import type { CollapsedSummary } from "../types";
import type { ExpandReader, RowHeightReader, TaskTreeReader } from "./deps";
import { isSummary } from "./geometry";

/** The row-model read the child filter needs: what height this task's own row resolves to. */
export type RowVisibilityReader = RowHeightReader;

// What a collapsed summary paints is a chart-wide option, so one predicate answers for every value
// of it: there is no per-task opt-in.
/** Whether this row shows a summary that is currently collapsed. */
export function isCollapsedSummary(task: Readonly<Task>, rows: ExpandReader): boolean {
  return isSummary(task) && !rows.isExpanded(task.id);
}

// One predicate answers for both the paint pass (layer.ts) and the hit test (hit.ts), so the two
// can never disagree about which rows paint their children in place of their own bar.
/** Whether the row paints its children's bars instead of its own (`collapsedSummary: "split"`). */
export function isSplitParentRow(
  mode: CollapsedSummary | undefined,
  expand: ExpandReader | undefined,
  tree: TaskTreeReader | undefined,
  task: Readonly<Task>,
): boolean {
  return mode === "split" && expand !== undefined && tree !== undefined && isCollapsedSummary(task, expand);
}

// Under `"hidden"` a collapsed summary paints nothing and answers no hit, so the shared rule keeps
// painting and hit testing in step.
/** Whether the row shows a collapsed summary the `"hidden"` mode suppresses entirely. */
export function isHiddenSummaryRow(
  mode: CollapsedSummary | undefined,
  expand: ExpandReader | undefined,
  task: Readonly<Task>,
): boolean {
  return mode === "hidden" && expand !== undefined && isCollapsedSummary(task, expand);
}

/** The direct children of a task, in store order. */
export function childIdsOf(data: TaskTreeReader, id: TaskId): readonly TaskId[] {
  return data.query().children.get(id) ?? [];
}

// A row the `rows/height` reduction put at 0 is hidden: not laid out, not painted, and with no
// geometry to answer about. The test is the generic row-height one rather than anything
// filter-shaped, so this plugin gains no dependency on whichever plugin hid the row. It has to be
// the by-task resolution rather than a row-index lookup: the children a split row draws are inside
// a collapsed branch and so have no row index at all.
/** Whether the task's own row resolves to a height the row model treats as hidden. */
export function isRowHidden(rows: RowVisibilityReader, id: TaskId): boolean {
  const height = rows.resolvedHeightOf(id);
  // An id the row model cannot resolve at all carries no hiding decision, so it is drawn.
  if (height === undefined) return false;
  return !(height > 0);
}

// The children a split row paints, puts in the service composite, and hit-tests are one and the
// same set, so the rule lives in one pure function both the paint pass and the hit test call.
/**
 * The direct children a split row shows: store order, minus any whose own row is hidden.
 *
 * The unfiltered list is returned as-is when nothing is hidden, so the common case costs one scan
 * and no allocation.
 */
export function visibleChildIdsOf(
  data: TaskTreeReader,
  rows: RowVisibilityReader,
  id: TaskId,
): readonly TaskId[] {
  const all = childIdsOf(data, id);
  let kept: TaskId[] | undefined;
  for (let i = 0; i < all.length; i += 1) {
    const childId = all[i];
    if (childId !== undefined && !isRowHidden(rows, childId)) {
      kept?.push(childId);
      continue;
    }
    kept ??= all.slice(0, i);
  }
  return kept ?? all;
}
