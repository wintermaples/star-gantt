// docs/specs/plugins/resource.md §3.6 — the resource lanes' row model (§3.2).
/**
 * One lane per roster resource over the VISIBLE range, on the aggregate band's own bucket grid (no
 * column coarsening), with the bar values and the y-scale ceiling shaped by the configured lane
 * scale.
 *
 * The output is deliberately `BucketResult[]` per lane: the lanes then reuse the one lane
 * projection in `geometry.ts` instead of carrying a second copy of the y-scale.
 *
 * Headless: no DOM, no service reference.
 */
import type { ReadonlyDataView, Resource } from "@stargantt/plugin-data-store";
import type { BucketResult } from "./band";
import type { UtilizationMatrix } from "../engine/compute";

/** How a lane's bars are scaled (§6.5's `laneScale`). */
export type LaneScale = "ratio" | "shared" | "auto";

/** One resource's lane. */
export interface LaneRow {
  resourceId: string | number;
  resourceName: string;
  /** The resource's dimensionless capacity rate, `1` when the store leaves it unset. */
  capacity: number;
  /**
   * The lane's reference-line value in the unit the active scale draws — the 100 % mark (`1`) under
   * `"ratio"`, the bucket's own working-millisecond capacity otherwise. Under the absolute scales
   * the reference varies with the bucket, so this is the largest of them; each bucket's own value
   * rides on its `BucketResult.capacity`.
   */
  lineValue: number;
  /** One entry per visible bucket, already shaped for the lane projection. */
  results: BucketResult[];
  /** Largest bar value on this lane, in whatever unit the active scale draws. */
  peak: number;
  /** Buckets on this lane whose allocated load exceeds the resource's capacity. */
  overloadedBuckets: number;
}

export interface LaneModel {
  rows: LaneRow[];
  /**
   * The ceiling every lane's y-scale is fitted to, or `undefined` when each lane fits its own peak
   * (`"auto"`). Handed to the lane projection as its `scaleMax`.
   */
  sharedMax: number | undefined;
  /** The range the lanes cover, epoch ms UTC, half-open — backs the accessible names. */
  rangeStart: number;
  rangeEnd: number;
  /** Number of buckets each lane holds. */
  bucketCount: number;
}

export interface LaneModelInput {
  view: ReadonlyDataView;
  /**
   * The §2 matrix over the visible range, already built on the aggregate band's own bucket grid.
   *
   * The lanes never build their own: within a frame the Σ-mode band and the lanes share one build
   * through the area's memo, and the grid must stay the band's own — uncoarsened — or a lane bar
   * stops lining up with the task bar above it.
   */
  matrix: UtilizationMatrix<Resource>;
  fromT: number;
  toT: number;
  scale: LaneScale;
}

/** An empty model — no resource in scope, no bucket in the range, or a hidden strip. */
export const EMPTY_LANE_MODEL: LaneModel = {
  rows: [],
  sharedMax: undefined,
  rangeStart: 0,
  rangeEnd: 0,
  bucketCount: 0,
};

/**
 * Shapes the §2 matrix into lane rows for `[fromT, toT)`.
 *
 * Cell values are the matrix's POST-HOOK working-millisecond numbers, so a lane, the heatmap, the
 * reports and a Σ-mode band all show the same adjusted figures by construction.
 */
export function buildLaneModel(input: LaneModelInput): LaneModel {
  const matrix = input.matrix.rows;
  if (matrix.length === 0) return EMPTY_LANE_MODEL;

  const ratioScale = input.scale === "ratio";
  const rows: LaneRow[] = [];
  let sharedMax = 0;

  for (const row of matrix) {
    // The resource's dimensionless capacity RATE, for the lane's accessible name: the matrix cells
    // carry the bucket's working-millisecond capacity, a different quantity (§2.1).
    const capacity = input.view.resources.get(row.resource.id)?.capacity ?? 1;
    const results: BucketResult[] = [];
    let peak = 0;
    let overloadedBuckets = 0;
    // The line each lane's overload is measured against: 1 in ratio mode (where the bars are
    // already fractions of the capacity), the bucket's own capacity otherwise — so an
    // absolute-scale lane compares a week's load against a week's capacity, not a day's.
    let lineValue = ratioScale ? 1 : 0;

    for (const cell of row.cells) {
      // A capacity of 0 has a null ratio, which draws no bar in ratio mode; the capacity line still
      // sits at 1 there, so the lane reads as "any load is over".
      const value = ratioScale ? (cell.ratio ?? 0) : cell.allocated;
      const line = ratioScale ? 1 : cell.capacity;
      if (value > peak) peak = value;
      if (line > lineValue) lineValue = line;
      if (cell.overallocated) overloadedBuckets += 1;
      results.push({ bucket: { start: cell.start, end: cell.end }, value, capacity: line });
    }

    if (peak > sharedMax) sharedMax = peak;
    if (lineValue > sharedMax) sharedMax = lineValue;
    rows.push({
      resourceId: row.resource.id,
      resourceName: row.resource.name,
      capacity,
      lineValue,
      results,
      peak,
      overloadedBuckets,
    });
  }

  const first = rows[0];
  const bucketCount = first?.results.length ?? 0;
  if (first === undefined || bucketCount === 0) return EMPTY_LANE_MODEL;

  return {
    rows,
    // `"ratio"` and `"shared"` fit every lane to ONE ceiling so heights are comparable across
    // lanes; `"auto"` leaves each lane to the projection's own per-lane derivation.
    sharedMax: input.scale === "auto" ? undefined : Math.max(sharedMax, ratioScale ? 1 : 0),
    rangeStart: first.results[0]?.bucket.start ?? input.fromT,
    rangeEnd: first.results[bucketCount - 1]?.bucket.end ?? input.toT,
    bucketCount,
  };
}
