/**
 * The composed column track: which columns the grid shows, in which order, and how wide each one is.
 *
 * The header and the body both lay out against this one source of truth — the header builds cells
 * from it and registers them back, the body sizes its cells from it — so a resize (drag or keyboard)
 * can never leave the two disagreeing.
 */
// docs/specs/plugins/tree-grid.md § Extension points — column resize and sort targeting, and the
// composed `grid/columns` reduction this tracks.
import type { ColumnDef } from "../types";

// The resize floor and the tree column's indent geometry live in `tree-column.ts`
// (docs/specs/plugins/tree-grid.md § Extension points, "Header parity and the usable minimum"):
// a column's minimum is 24 CSS px of *content* box, so the border-box floor depends on the
// cell-padding token and cannot be a constant here.

export interface ColumnTrack {
  /** The composed columns in display order. Stable until `refresh()` reports a change. */
  list(): readonly ColumnDef[];
  /**
   * Re-reads the `grid/columns` reduction. Returns whether the reduction produced a different array
   * than last time — the signal to rebuild the header cells and the slot pool.
   */
  refresh(): boolean;
  /** The column with this id, or `undefined`. */
  find(id: string): ColumnDef | undefined;
  /** The display index of the column with this id, or `-1`. */
  indexOf(id: string): number;
  /** The width to use for a column: a resize override if one exists, else its `ColumnDef.width`. */
  widthOf(column: ColumnDef): number | undefined;
  /** Records a resize override for the life of the instance (`ColumnDef.width` is never mutated). */
  setWidth(id: string, width: number): void;
  /**
   * The laid-out width of a column, measured off its header cell — the width a column with no
   * declared `ColumnDef.width` actually occupies. `undefined` before the header has been laid out
   * (or when the column has no header cell), never a zero-width guess.
   */
  measuredWidthOf(id: string): number | undefined;
  /**
   * Current width in CSS px per displayed column: the tracked resize override or the column's
   * declared `width`, and otherwise the width its header cell is laid out at. A column with
   * neither — a width-less column before the header has ever been laid out — is absent.
   */
  widths(): ReadonlyMap<string, number>;
  /** Forgets every header cell; the header calls it before rebuilding them. */
  clearHeaderCells(): void;
  /** Registers the header cell laid out for a column. */
  setHeaderCell(id: string, cell: HTMLElement): void;
  /** The header cell of a column, or `undefined` when the header has not been built for it. */
  headerCell(id: string): HTMLElement | undefined;
  /** Every registered header cell, in registration (display) order. */
  headerCells(): Iterable<readonly [string, HTMLElement]>;
}

/**
 * Tracks the columns produced by `read` — the `grid/columns` reduction — together with their resize
 * overrides and their laid-out header cells.
 */
export function createColumnTrack(read: () => ColumnDef[]): ColumnTrack {
  let columns: ColumnDef[] = [];
  /** The array identity last seen from `read()`; a new identity is what "the columns changed" means. */
  let source: readonly ColumnDef[] | null = null;
  /** Per-column width overrides from header-boundary drag-resize, keyed by column id. */
  const widths = new Map<string, number>();
  /** Header cells by column id, refreshed on every header rebuild; backs resize and click targeting. */
  const cells = new Map<string, HTMLElement>();

  function measuredWidthOf(id: string): number | undefined {
    const width = cells.get(id)?.getBoundingClientRect().width;
    return width !== undefined && Number.isFinite(width) && width > 0 ? width : undefined;
  }

  return {
    list: () => columns,
    refresh(): boolean {
      const raw = read();
      const list: readonly ColumnDef[] = Array.isArray(raw) ? raw : [];
      if (list === source) return false;
      source = list;
      columns = list.slice();
      return true;
    },
    find: (id) => columns.find((c) => c.id === id),
    indexOf: (id) => columns.findIndex((c) => c.id === id),
    widthOf: (column) => widths.get(column.id) ?? column.width,
    setWidth(id, width): void {
      widths.set(id, width);
    },
    measuredWidthOf,
    widths(): ReadonlyMap<string, number> {
      const result = new Map<string, number>();
      for (const column of columns) {
        const width = widths.get(column.id) ?? column.width ?? measuredWidthOf(column.id);
        if (width !== undefined) result.set(column.id, width);
      }
      return result;
    },
    clearHeaderCells(): void {
      cells.clear();
    },
    setHeaderCell(id, cell): void {
      cells.set(id, cell);
    },
    headerCell: (id) => cells.get(id),
    headerCells: () => cells,
  };
}
