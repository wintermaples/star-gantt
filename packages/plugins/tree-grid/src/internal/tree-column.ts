/**
 * The tree column: which displayed column carries the depth indentation, how far that indentation
 * may grow, and the narrowest a column may ever be.
 *
 * Pure arithmetic over the composed column list — no DOM, no host. The header and the body both
 * compute their leading structure from these functions, which is what keeps a row's total width
 * equal to the header row's at every depth.
 */
// docs/specs/plugins/tree-grid.md § Config — tree indentation and header parity: the indent belongs
// to the tree column, never to the WBS numbering column, and the tree column keeps a 24 px
// content-box minimum, saturating the inset on a deep tree.
import type { ColumnDef } from "../types";

/**
 * The narrowest content box a column keeps: 24 CSS px *net of* the cell's own horizontal padding.
 * The border-box floor is this plus both paddings — 40 px at the default 8 px token.
 */
export const MIN_CONTENT_WIDTH = 24;

/**
 * Brands the WBS numbering column the `wbs` option contributes.
 *
 * The WBS column is identified as *the contributed column itself*, not as "the column whose id is
 * `wbs`": a foreign column reusing that id is an ordinary column and may host the tree. A
 * module-private symbol says exactly that and, being an own enumerable property, survives the
 * object spread `column-view.ts` performs when a `cellRenderers` override wraps a column — which
 * plain reference identity would not.
 */
const WBS_COLUMN = Symbol("stargantt.tree-grid/wbs-column");

/** Brands `column` as the WBS numbering column. Returns the same object. */
export function markWbsColumn(column: ColumnDef): ColumnDef {
  return Object.assign(column, { [WBS_COLUMN]: true });
}

/** Whether `column` is the WBS numbering column `wbs` contributed. */
export function isWbsColumn(column: ColumnDef): boolean {
  return (column as Partial<Record<typeof WBS_COLUMN, unknown>>)[WBS_COLUMN] === true;
}

/**
 * The display index of the tree column — the first displayed column that is not the WBS numbering
 * column — or `-1` when no column is displayed at all (then there is no tree column and no gutter).
 * When the WBS column is the only displayed column it is itself the tree column.
 */
export function treeColumnIndex(columns: readonly ColumnDef[]): number {
  if (columns.length === 0) return -1;
  const index = columns.findIndex((column) => !isWbsColumn(column));
  return index >= 0 ? index : 0;
}

/** The narrowest border-box width a column may be resized to, given the cell's own padding. */
export function minColumnWidth(cellPadding: number): number {
  return MIN_CONTENT_WIDTH + 2 * Math.max(0, cellPadding);
}

/**
 * The tree column's effective depth inset: `depth × indent`, saturated at the largest inset that
 * still leaves the column its 24 px content box.
 *
 * Beyond that depth the gutter and the content stop moving together rather than the row outgrowing
 * its header — parity outranks the indentation. `width` is the tree column's own laid-out
 * border-box width; `undefined` (no declared width, no laid-out header cell to measure) leaves
 * nothing to saturate against, so the raw inset stands.
 */
export function treeInset(
  depth: number,
  indent: number,
  width: number | undefined,
  cellPadding: number,
): number {
  const raw = Math.max(0, depth) * indent;
  if (!(raw > 0)) return 0;
  if (width === undefined) return raw;
  return Math.min(raw, Math.max(0, width - minColumnWidth(cellPadding)));
}
