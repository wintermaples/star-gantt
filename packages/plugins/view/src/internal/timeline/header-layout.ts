/**
 * What the header draws, computed without touching a drawing surface.
 *
 * Three stages, in order: the rows' vertical bands, each row's boundary ticks, then each row's
 * labels (`header-labels.ts`). Shared by the on-screen canvas paint (§3.5) and the
 * `export/auxiliarySurfaces` tile paths (, raster and SVG) so the geometry and the
 * `ScaleRow.format` fault barrier are identical everywhere the header is composed.
 *
 * Internal: not part of the published surface.
 */
import type { HeaderLabel } from "./header-labels";
import { rowLabels } from "./header-labels";
import type { HeaderDrawOptions, HeaderTier } from "./header-options";
import { ticks } from "./scale";
import type { ScaleRow } from "./index";

/** One header row's geometry and content, in local (post-`scrollLeft`) coordinates. */
export interface HeaderRowLayout {
  top: number;
  /** X positions of every boundary tick in this row (grid lines), local to the header box. */
  separators: number[];
  /** Y of the row's bottom separator line (`top + rowHeight`). */
  bottomY: number;
  labels: HeaderLabel[];
  /** Which typographic tier this row paints in. */
  tier: HeaderTier;
}

/**
 * The tier a row belongs to: the coarse top row of a multi-row header is `"major"`, everything
 * else `"minor"`. A single-row header has no coarse/fine distinction to make, so its one row is
 * minor — heavier type there would emphasise the only thing on screen against nothing.
 */
function tierOf(rowIndex: number, rowCount: number): HeaderTier {
  return rowCount > 1 && rowIndex === 0 ? "major" : "minor";
}

/** One header row's vertical band: where it starts and how tall it is, in CSS pixels. */
interface RowBand {
  top: number;
  height: number;
}

// docs/specs/plugins/view.md — the total height comes from
// `--sg-header-height`; `headerRowRatio` splits it between the two rows of the two-row header
// treatment every built-in level uses. A contributed level with some other row count has no
// "top row share" to apply, so those keep dividing the height equally, as before.
/**
 * Stage 1 — the rows' vertical bands, stacked top to bottom.
 *
 * A hole in a sparse `scales` array gets a zero-height band, so the rows below it move up into the
 * space it would have taken: the band list is derived from the array itself, hole for hole, rather
 * than from its length. The two-row treatment is the exception — its heights come from `rowRatio`
 * as a pair, so a hole there still occupies its share.
 */
function rowBands(rows: ScaleRow[], height: number, rowRatio: number): RowBand[] {
  const heights: number[] =
    rows.length === 2
      ? [height * rowRatio, height * (1 - rowRatio)]
      : rows.map(() => height / rows.length);
  const bands: RowBand[] = [];
  let top = 0;
  for (let i = 0; i < rows.length; i++) {
    // `heights` is as sparse as `rows`: an absent entry is a hole, which takes no height at all.
    const rowHeight = heights[i] ?? 0;
    bands.push({ top, height: rowHeight });
    top += rowHeight;
  }
  return bands;
}

/**
 * Stage 2 — one row's boundary instants and their local x positions.
 *
 * docs/specs/plugins/view.md — week boundaries follow the
 * configured week start; formatting stays the row's own, locale-driven business.
 */
function rowTicks(
  row: ScaleRow,
  from: number,
  to: number,
  o: HeaderDrawOptions,
): { boundaries: number[]; separators: number[] } {
  // docs/specs/plugins/view.md — a row's boundaries
  // honor its `stepOffset` anchor and the chart's display time zone; both default to the
  // pre-existing behavior when absent.
  const boundaries = ticks(from, to, row.unit, row.step, o.firstDayOfWeek, o.timeZone, row.stepOffset);
  return { boundaries, separators: boundaries.map((t) => o.tToX(t) - o.scrollLeft) };
}

/** Computes what each header row draws — grid-line x positions and label placements. */
export function computeHeaderRows(o: HeaderDrawOptions): HeaderRowLayout[] {
  const rows = o.level.scales;
  const bands = rowBands(rows, o.height, o.rowRatio);
  const from = o.xToT(o.scrollLeft);
  const to = o.xToT(o.scrollLeft + o.width);

  const layout: HeaderRowLayout[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const band = bands[i];
    // A hole in the `scales` array draws nothing; `rowBands` has already decided what its absence
    // does to the rows below it.
    if (row === undefined || band === undefined) continue;
    const { boundaries, separators } = rowTicks(row, from, to, o);
    const tier = tierOf(i, rows.length);
    const labels = rowLabels(row, i, tier, boundaries, separators, band.top + band.height / 2, o);
    layout.push({ top: band.top, separators, bottomY: band.top + band.height, labels, tier });
  }
  return layout;
}
