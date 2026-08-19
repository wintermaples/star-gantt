// docs/specs/plugins/interaction.md §1.3 (`dragging-row`) — the rows a vertical drag drops between
// come from the row model, not from the painted bars: one row is one drop target even when it
// paints several bars (a `collapsedSummary: "split"` parent showing its children) or none at all.
/**
 * The row list a row drag resolves its drop against, and the guard that decides whether a gesture
 * may fork vertically at all.
 *
 * Pure arithmetic over the row model's answers: the caller passes in the model and the viewport
 * band, and gets back the rows overlapping that band in viewport-local coordinates.
 */
import type { TaskId } from "@stargantt/plugin-data-store";
import type { RowBox } from "./row-drag";

/** The row model's vertical geometry, as this module reads it. */
export interface RowGeometry {
  rowCount(): number;
  taskIdAt(row: number): TaskId | undefined;
  rowOf(id: TaskId): number | undefined;
  rowHeight(row: number): number;
  /** The row's top edge in content coordinates (scroll-independent). */
  yOf(row: number): number;
  rowAtY(y: number): number;
}

/** The vertical slice of content the chart pane is showing. */
export interface ViewportBand {
  scrollTop: number;
  height: number;
}

/**
 * The rows overlapping the viewport band, in viewport-local coordinates and row order.
 *
 * Only the visible band is walked, so the cost is the row count on screen rather than the whole
 * chart's — a row drag re-reads this on every pointer move. Rows the model gives no height are left
 * out: they occupy no pixels, so no drop can name them and including them would put two gaps at the
 * same y.
 */
export function viewportRows(
  model: RowGeometry,
  band: ViewportBand,
  // A caller on the pointer-move path passes its own buffer to reuse (cleared here), so the row
  // walk allocates no fresh array per move.
  out: RowBox[] = [],
): RowBox[] {
  out.length = 0;
  const count = model.rowCount();
  if (count === 0) return out;
  const first = Math.max(0, Math.min(model.rowAtY(band.scrollTop), count - 1));
  const bottom = band.scrollTop + band.height;
  for (let row = first; row < count; row += 1) {
    const y = model.yOf(row);
    if (y >= bottom) break;
    const height = model.rowHeight(row);
    if (height <= 0) continue;
    out.push({ id: model.taskIdAt(row), y: y - band.scrollTop, height });
  }
  return out;
}

/**
 * Whether a vertical gesture may start from this task: it must have a row of its own.
 *
 * An in-row child of a `collapsedSummary: "split"` row is painted inside its parent's row and has
 * none, so a drag on it stays a horizontal date edit.
 */
export function hasOwnRow(
  model: RowGeometry | undefined,
  bars: { hasOwnBar(id: TaskId): boolean },
  id: TaskId,
): boolean {
  return model === undefined ? bars.hasOwnBar(id) : model.rowOf(id) !== undefined;
}
