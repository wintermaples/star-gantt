// The visible-row walk (docs/specs/sdk.md, Module: sdk/frame): every row-aligned canvas layer
// reads it instead of performing this walk by hand.

/** The row-geometry surface the walk reads (the shape the tree-grid rows service publishes). */
export interface VisibleRowSource {
  /** Number of rows. */
  rowCount(): number;
  /** The row index at a content-space y; clamps to the last row past the end of the content. */
  rowAtY(y: number): number;
  /** The content-space top of a row. */
  yOf(row: number): number;
  /** The height of a row in CSS px. */
  rowHeight(row: number): number;
}

/** The viewport slice of the walk: where the visible band starts and how tall it is. */
export interface VisibleRowViewport {
  /** Content-space y of the viewport's top edge. */
  scrollTop: number;
  /** Viewport height in CSS px. */
  height: number;
}

/**
 * Calls `fn` once for every row that intersects the viewport's vertical band, in row order.
 *
 * `top` is the row's **content-space** top (`rows.yOf(row)`); subtract `vp.scrollTop` to get the
 * viewport-local y a canvas layer draws at. With no rows, a non-positive viewport height, or a
 * band past the content, `fn` is never called.
 */
export function forEachVisibleRow(
  rows: VisibleRowSource,
  vp: VisibleRowViewport,
  fn: (row: number, top: number, height: number) => void,
): void {
  const count = rows.rowCount();
  if (count === 0 || vp.height <= 0) return;
  const first = rows.rowAtY(vp.scrollTop);
  const last = Math.min(count - 1, rows.rowAtY(vp.scrollTop + vp.height));
  for (let row = first; row <= last; row += 1) {
    fn(row, rows.yOf(row), rows.rowHeight(row));
  }
}
