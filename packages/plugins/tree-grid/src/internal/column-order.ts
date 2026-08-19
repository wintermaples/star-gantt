/**
 * Display order of the composed `grid/columns` collection: a stable sort by `ColumnDef.weight`.
 *
 * The raw collect order follows plugin start-up tiers, which put data-store-only column
 * contributors ahead of this plugin — their columns would otherwise render left of the built-in
 * Name / Start / End / Progress and strand the expand toggle in a contributed column. Pure logic,
 * no DOM, no plugin context.
 */
// docs/specs/plugins/tree-grid.md § Extension points — "display order is weight-sorted".
import type { ColumnDef } from "../types";

/** The weight a column that declares none is sorted at; the built-ins sit at 0, well ahead. */
export const DEFAULT_COLUMN_WEIGHT = 100;

/** The weight the built-in and `TreeGridConfig.columns` replacement columns are contributed at. */
export const BUILT_IN_COLUMN_WEIGHT = 0;

/** Whether a column declares a usable weight; an absent or non-finite one does not. */
export function hasWeight(column: ColumnDef): boolean {
  return typeof column.weight === "number" && Number.isFinite(column.weight);
}

function weightOf(column: ColumnDef): number {
  return hasWeight(column) ? (column.weight as number) : DEFAULT_COLUMN_WEIGHT;
}

/**
 * Stably sorts columns by ascending weight. An already-ordered list is returned as-is (same array
 * identity), which keeps the pane's "new array identity = the columns changed" signal meaningful.
 */
export function sortColumnsByWeight(columns: readonly ColumnDef[]): ColumnDef[] {
  let sorted = true;
  for (let i = 1; i < columns.length; i++) {
    if (weightOf(columns[i]!) < weightOf(columns[i - 1]!)) {
      sorted = false;
      break;
    }
  }
  if (sorted) return columns as ColumnDef[];
  // Decorate with the collect index so ties keep contribution order regardless of the engine's
  // sort stability.
  return columns
    .map((column, index) => ({ column, index, weight: weightOf(column) }))
    .sort((a, b) => a.weight - b.weight || a.index - b.index)
    .map((entry) => entry.column);
}

/**
 * Wraps a column reader so what it yields is weight-sorted, memoized on the input array's identity
 * so repeated reads within one composition return one and the same array.
 */
export function weightSortedReader(read: () => ColumnDef[]): () => ColumnDef[] {
  let lastInput: ColumnDef[] | null = null;
  let lastOutput: ColumnDef[] = [];
  return () => {
    const input = read();
    if (input === lastInput) return lastOutput;
    lastInput = input;
    lastOutput = sortColumnsByWeight(input);
    return lastOutput;
  };
}
