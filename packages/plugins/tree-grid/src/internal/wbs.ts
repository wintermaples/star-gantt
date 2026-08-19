/**
 * WBS (work-breakdown-structure) code computation and the optional WBS column.
 * Pure logic: no DOM writes beyond the column's own `render`, no core imports.
 */
// docs/specs/plugins/tree-grid.md § Config — `wbs`.
import type { ReadonlyDataView, TaskId } from "@stargantt/plugin-data-store";
import type { ColumnDef } from "../types";
import { BUILT_IN_COLUMN_WEIGHT } from "./column-order";
import { markWbsColumn } from "./tree-column";

/**
 * Computes the WBS code of every task from the tree structure, in the store's sibling order:
 * the n-th root is `n`, the m-th child of a task coded `c` is `c.m` (1-based). Collapse state and
 * display sorting do not affect the codes — they follow the data, not the view. Cycle-guarded.
 */
export function computeWbsCodes(view: ReadonlyDataView): Map<TaskId, string> {
  const codes = new Map<TaskId, string>();
  const stack: { id: TaskId; code: string }[] = [];
  const roots = view.children.get(null) ?? [];
  for (let i = roots.length - 1; i >= 0; i -= 1) {
    const id = roots[i];
    if (id !== undefined) stack.push({ id, code: String(i + 1) });
  }
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    if (codes.has(node.id) || !view.byId.has(node.id)) continue;
    codes.set(node.id, node.code);
    const children = view.children.get(node.id) ?? [];
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i];
      if (child !== undefined) stack.push({ id: child, code: `${node.code}.${i + 1}` });
    }
  }
  return codes;
}

/** Orders two WBS codes segment-by-segment numerically: `1.2` < `1.10` < `2`. */
export function compareWbsCodes(a: string, b: string): number {
  const as = a.split(".");
  const bs = b.split(".");
  const n = Math.min(as.length, bs.length);
  for (let i = 0; i < n; i += 1) {
    const d = Number(as[i]) - Number(bs[i]);
    if (d !== 0 && Number.isFinite(d)) return d;
  }
  return as.length - bs.length;
}

/**
 * The read-only WBS column `TreeGridConfig.wbs` prepends: renders each task's computed code and
 * sorts by it (numeric per segment).
 *
 * The column is branded (`markWbsColumn`) rather than recognised by its id, so the tree
 * indentation lands on the column *after* it and a foreign column reusing the id `wbs` stays an
 * ordinary column.
 */
export function wbsColumnDef(header: string, codeOf: (id: TaskId) => string): ColumnDef {
  return markWbsColumn({
    id: "wbs",
    weight: BUILT_IN_COLUMN_WEIGHT,
    header,
    width: 70,
    render(el, task) {
      const code = codeOf(task.id);
      el.textContent = code;
      // docs/specs/plugins/tree-grid.md § Config — the full code, always, so a code the column's
      // width ellipsises is never lossy. Set unconditionally: detecting the overflow first would
      // mean a synchronous `scrollWidth` read per cell in the paint path, while the code string is
      // already cached per data generation.
      el.setAttribute("title", code);
    },
    getValue: (task) => codeOf(task.id),
    compare: (a, b) => compareWbsCodes(codeOf(a.id), codeOf(b.id)),
  });
}
