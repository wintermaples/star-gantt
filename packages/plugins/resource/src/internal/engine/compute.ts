// docs/specs/plugins/resource.md §2 — THE unified aggregation engine.
/**
 * `computeUtilization`: one build = one resources × buckets matrix.
 *
 * This subsumes load-chart's matrix aggregation and resource-utilization's engine into one
 * implementation: a scatter/gather sweep (§2.6 item 1). Each demand is
 * folded into the working-interval index space — two binary searches, a difference-array mark for
 * the intervals it fully covers, and the exact clamped overlap for its at-most-two partial ones —
 * and the buckets are filled by a single forward walk over the intervals. Every interval falls
 * wholly inside one bucket, because they are cut at the grid's own boundaries first, so the cursor
 * never moves backwards. Per row this is O(demands × log I + I + buckets), and no demand is
 * rescanned per bucket.
 *
 * A cell accrues both numbers over the WORKING MILLISECONDS inside its bucket:
 * `capacity = capacityRate × Σ|working intervals ∩ bucket|` and
 * `allocated = Σ over the row's demands of units × |demand ∩ working intervals ∩ bucket|`. A
 * demand overlapping only non-working time contributes nothing.
 *
 * Headless: pure functions, no DOM and no service reference (§8). Time is epoch milliseconds UTC.
 */
import { MS_DAY } from "@stargantt/sdk";
import type { ResourceBucketInput, TimeRange } from "@stargantt/sdk";
import { bucketsInRange, coarsenBucketMode, isSubDayMode, stepOf } from "./buckets";
import type { Bucket, BucketEdges, UtilizationBucketUnit } from "./buckets";

/**
 * The over-allocation tolerance, in milliseconds (§2.4 / §2.6 item 2).
 *
 * A deliberate unified deviation from load-chart's exact comparison and utilization's 1e-9 —
 * recorded in the spec: the unified engine's single accumulation order shifts figures by up to
 * the reorder error (measured ≈ 6e-8 ms), so 1e-6 sits comfortably above every accumulated
 * reorder artifact while staying six orders of magnitude below the 1 ms scheduling quantum, and
 * exactly-at-capacity cells keep their not-over verdict on every surface.
 */
export const OVERLOAD_EPSILON = 1e-6;

/** One roster resource as the engine consumes it (§2.1). */
export interface EngineResource<R = unknown> {
  id: string | number;
  name: string;
  /**
   * Dimensionless FTE rate: `capacity ?? 1` resolved upstream, with the usability guard kept —
   * a non-finite or non-positive stored capacity reads as 1, never as itself.
   */
  capacityRate: number;
  /**
   * The resource's working intervals inside `[from, to)`: clipped, merged, ascending
   * (`ResourcePoolService.workingIntervals` for pool-known resources; the `sdk/time`
   * `DEFAULT_WORKWEEK` listing for every other — §2.3). Appends into `out` when given.
   */
  workingIntervals(from: number, to: number, out?: TimeRange[]): TimeRange[];
  /** The host object the hooks receive as `input.resource`. */
  source: R;
}

/**
 * One demand interval on a resource: an assignment projected onto its task's span.
 *
 * The PROJECTION is caller policy and differs per surface (§2.6 item 8) — milestones, non-positive
 * spans and each side's own `units` filter are applied upstream; the engine accrues whatever
 * demands it is handed, clipping them to the analysis window.
 */
export interface DemandInterval {
  start: number;
  end: number;
  units: number;
}

/** The per-consumer hook pair a build carries (§2.4). */
export interface EngineHooks<R> {
  /**
   * Adjusts one cell's allocated working time; the returned finite number (ms) replaces the
   * baseline. Both hooks always see the BUILT-IN baselines (order-independent).
   */
  resourceLoad?: (input: ResourceBucketInput<R>) => number;
  /** Adjusts one cell's available working time; same shape and containment. */
  resourceCapacity?: (input: ResourceBucketInput<R>) => number;
  /**
   * Receives the FIRST throw of each hook per build; later throws of the same build are swallowed;
   * a later build reports again (per-call, unlatched, per-build reporting; the failing cell keeps
   * its built-in value, non-finite results fall back silently, no cell is ever omitted).
   */
  onError?: (where: "resourceLoad" | "resourceCapacity", error: unknown) => void;
}

/** Everything one build needs (§2.1). */
export interface BucketInput<R = unknown> {
  /** Row membership and order (§2.3: each consumer supplies its own roster). */
  resources: readonly EngineResource<R>[];
  /** Demand intervals per resource, keyed by `String(id)`. */
  demands: ReadonlyMap<string, readonly DemandInterval[]>;
  /** The resolved half-open analysis range, epoch ms (range RESOLUTION is caller policy — §2.5). */
  start: number;
  end: number;
  /** Requested width. The engine never narrows it. */
  bucket: UtilizationBucketUnit;
  /** Edge policy at the range bounds (§2.2). */
  edges: BucketEdges;
  /** Weekday week buckets start on: 0 = Sunday … 6 = Saturday. */
  weekStartDay: number;
  /**
   * Over-allocation threshold; a cell is over when
   * `allocated > capacity × threshold + OVERLOAD_EPSILON`. Default 1.
   */
  threshold?: number;
  /**
   * Column bound: the engine coarsens the width one step at a time toward `"month"` while the grid
   * would exceed it, month accepted even when still over. Absent = no
   * coarsening (the 8192-bucket grid cap of §2.2 still applies).
   */
  maxColumns?: number;
  hooks?: EngineHooks<R>;
}

/** One cell of the matrix (§2.1). */
export interface UtilizationCell {
  start: number;
  end: number;
  /** The row resource's working ms inside the bucket (pre-rate; also the hooks' `workingMs`). */
  workingMs: number;
  /** Post-hook allocated working ms. */
  allocated: number;
  /** Post-hook available working ms (`capacityRate × workingMs` built-in). */
  capacity: number;
  /** `allocated / capacity`, `null` at capacity 0. */
  ratio: number | null;
  /** `allocated > capacity × threshold + OVERLOAD_EPSILON`, from the post-hook numbers. */
  overallocated: boolean;
}

/** One row of the matrix. */
export interface UtilizationMatrixRow<R = unknown> {
  resource: EngineResource<R>;
  cells: readonly UtilizationCell[];
}

/** The matrix one build produces. */
export interface UtilizationMatrix<R = unknown> {
  /** The effective width after coarsening. */
  bucket: UtilizationBucketUnit;
  rows: readonly UtilizationMatrixRow<R>[];
}

/** The reused hook input: one instance per build, its fields rewritten before every call. */
interface MutableBucketInput<R> {
  resource: R;
  resourceId: string | number;
  resourceName: string;
  capacityRate: number;
  bucketStart: number;
  bucketEnd: number;
  workingMs: number;
  workingDays: number;
  allocated: number;
  capacity: number;
}

/**
 * Creates the one input object a single build reuses across every call it makes (§2.4).
 *
 * The lifetime is per BUILD, not per plugin instance: a hook may re-enter the engine, and a nested
 * build that rewrote the outer build's input would hand the still-running call fields describing a
 * different resource and bucket.
 */
function createHookInput<R>(): MutableBucketInput<R> {
  return {
    resource: undefined as unknown as R,
    resourceId: "",
    resourceName: "",
    capacityRate: 1,
    bucketStart: 0,
    bucketEnd: 0,
    workingMs: 0,
    workingDays: 0,
    allocated: 0,
    capacity: 0,
  };
}

/** The per-build scratch buffers, sized once and cleared per row. */
interface Scratch {
  /** Flat `[start, end, …]` of the row's grid-cut working-interval pieces. */
  pieces: Float64Array;
  /** Difference array over interval indices — the demands that fully cover an interval. */
  delta: Float64Array;
  /** Per-interval partial overlaps, in `units × ms`, that no difference array can express. */
  partial: Float64Array;
  allocated: Float64Array;
  workingMs: Float64Array;
  workingDays: Float64Array;
  /** Each bucket's exclusive end, for the forward cursor walk. */
  bucketEnds: Float64Array;
}

function grow(buffer: Float64Array, needed: number): Float64Array {
  return buffer.length >= needed ? buffer : new Float64Array(Math.max(needed, buffer.length * 2));
}

/**
 * Clips `list` to `[from, to)` and cuts every interval at the multiples of `step` it crosses,
 * writing the flat pieces into `scratch.pieces` (grown as needed).
 *
 * The accrual places a working interval whole in the bucket its start falls in, which
 * is sound only while every bucket boundary the interval could straddle has been cut. Sub-day
 * widths are fixed and divide a day, and day-or-coarser grids sit on midnights, so the cut points
 * are arithmetic either way and the whole pass is O(intervals + pieces). Cutting unconditionally
 * also makes the engine independent of whether its `workingIntervals` source happens to return
 * day-contained ranges (the SDK's listing merges runs of all-day working days into one).
 */
function clipAndCut(
  list: readonly TimeRange[],
  step: number,
  from: number,
  to: number,
  scratch: Scratch,
): number {
  let written = 0;
  for (const range of list) {
    let cursor = range.start < from ? from : range.start;
    const stop = range.end < to ? range.end : to;
    while (cursor < stop) {
      const boundary = (Math.floor(cursor / step) + 1) * step;
      const pieceEnd = boundary < stop ? boundary : stop;
      if (written * 2 + 2 > scratch.pieces.length) {
        const grown = new Float64Array(Math.max(written * 4 + 2, scratch.pieces.length * 2));
        grown.set(scratch.pieces);
        scratch.pieces = grown;
      }
      scratch.pieces[written * 2] = cursor;
      scratch.pieces[written * 2 + 1] = pieceEnd;
      written += 1;
      cursor = pieceEnd;
    }
  }
  return written;
}

/** The first interval index whose end is past `t`; `count` when none is. */
function firstIntervalEndingAfter(edges: Float64Array, count: number, t: number): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((edges[mid * 2 + 1] as number) > t) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** The last interval index whose start is before `t`; `-1` when none is. */
function lastIntervalStartingBefore(edges: Float64Array, count: number, t: number): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((edges[mid * 2] as number) < t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** Accrues one row's per-bucket working milliseconds and allocation. */
function accrueRow(
  demands: readonly DemandInterval[],
  spanStart: number,
  spanEnd: number,
  intervals: number,
  buckets: number,
  scratch: Scratch,
): void {
  const { pieces, delta, partial, allocated, workingMs, workingDays, bucketEnds } = scratch;
  delta.fill(0, 0, intervals + 1);
  partial.fill(0, 0, intervals);
  allocated.fill(0, 0, buckets);
  workingMs.fill(0, 0, buckets);
  workingDays.fill(0, 0, buckets);
  if (intervals === 0) return;

  for (const demand of demands) {
    const start = demand.start > spanStart ? demand.start : spanStart;
    const end = demand.end < spanEnd ? demand.end : spanEnd;
    if (!(end > start)) continue;
    const units = demand.units;
    const first = firstIntervalEndingAfter(pieces, intervals, start);
    const last = lastIntervalStartingBefore(pieces, intervals, end);
    if (first > last || first >= intervals || last < 0) continue;
    if (first === last) {
      const overlap =
        Math.min(pieces[first * 2 + 1] as number, end) -
        Math.max(pieces[first * 2] as number, start);
      if (overlap > 0) partial[first] = (partial[first] as number) + units * overlap;
      continue;
    }
    let lo = first;
    let hi = last;
    if ((pieces[first * 2] as number) < start) {
      partial[first] =
        (partial[first] as number) + units * ((pieces[first * 2 + 1] as number) - start);
      lo += 1;
    }
    if ((pieces[last * 2 + 1] as number) > end) {
      partial[last] = (partial[last] as number) + units * (end - (pieces[last * 2] as number));
      hi -= 1;
    }
    if (lo <= hi) {
      delta[lo] = (delta[lo] as number) + units;
      delta[hi + 1] = (delta[hi + 1] as number) - units;
    }
  }

  const lastBucket = buckets - 1;
  let bucket = 0;
  let bucketEnd = bucketEnds[0] as number;
  let covering = 0;
  let lastDay = Number.NaN;
  for (let k = 0; k < intervals; k += 1) {
    covering += delta[k] as number;
    const start = pieces[k * 2] as number;
    const end = pieces[k * 2 + 1] as number;
    while (bucket < lastBucket && start >= bucketEnd) {
      bucket += 1;
      bucketEnd = bucketEnds[bucket] as number;
      // The distinct-day count is per bucket, not per row: a sub-day bucket must read
      // 1 (any working time) or 0, and several of them share one UTC day. For a day-or-coarser
      // bucket the reset changes nothing, since crossing such a boundary crosses a midnight too.
      lastDay = Number.NaN;
    }
    const length = end - start;
    allocated[bucket] = (allocated[bucket] as number) + covering * length + (partial[k] as number);
    workingMs[bucket] = (workingMs[bucket] as number) + length;
    const day = Math.floor(start / MS_DAY);
    if (day !== lastDay) {
      workingDays[bucket] = (workingDays[bucket] as number) + 1;
      lastDay = day;
    }
  }
}

/** THE unified engine entry: one build = one matrix (§2.1). */
export function computeUtilization<R>(input: BucketInput<R>): UtilizationMatrix<R> {
  const { resources, demands, start, end, edges, weekStartDay } = input;
  const maxColumns = input.maxColumns;
  const unit: UtilizationBucketUnit =
    typeof maxColumns === "number" && Number.isFinite(maxColumns) && maxColumns > 0
      ? coarsenBucketMode(input.bucket, start, end, weekStartDay, maxColumns)
      : input.bucket;

  const buckets = bucketsInRange(unit, start, end, weekStartDay, edges);
  const count = buckets.length;
  // §2.3 — no task-count fallback in the matrix: no roster row is no matrix row.
  if (count === 0 || resources.length === 0) return { bucket: unit, rows: [] };

  const origin = (buckets[0] as Bucket).start;
  const spanEnd = (buckets[count - 1] as Bucket).end;
  // §2.3 — the interval window is the day-aligned span CONTAINING the buckets: a day-or-coarser
  // grid is already day-aligned and this is the window it has always requested; a sub-day (or
  // clamped) grid starting at 09:30 has no day index of its own, and `clipAndCut` clips the wider
  // answer back to `[origin, spanEnd)`.
  const windowFrom = Math.floor(origin / MS_DAY) * MS_DAY;
  const windowEnd = Math.ceil(spanEnd / MS_DAY) * MS_DAY;
  const subDayStep = isSubDayMode(unit) ? (stepOf(unit) as number) : null;
  const cutStep = subDayStep ?? MS_DAY;

  const threshold =
    typeof input.threshold === "number" && Number.isFinite(input.threshold) ? input.threshold : 1;

  // One set of buffers per build. A re-entrant build (a hook calling back into the engine) gets
  // its own, which is what keeps the outer build's numbers and hook input intact.
  const scratch: Scratch = {
    pieces: new Float64Array(0),
    delta: new Float64Array(0),
    partial: new Float64Array(0),
    allocated: new Float64Array(count),
    workingMs: new Float64Array(count),
    workingDays: new Float64Array(count),
    bucketEnds: new Float64Array(count),
  };
  for (let i = 0; i < count; i += 1) scratch.bucketEnds[i] = (buckets[i] as Bucket).end;

  const hooks = input.hooks;
  const loadHook = hooks?.resourceLoad;
  const capacityHook = hooks?.resourceCapacity;
  const hooked = loadHook !== undefined || capacityHook !== undefined;
  // One report per hook per build; a later build reports again (never latched).
  let loadReported = false;
  let capacityReported = false;
  const hookInput: MutableBucketInput<R> | null = hooked ? createHookInput<R>() : null;
  // One reused listing array across rows: the cache appends its own held ranges into it.
  const listing: TimeRange[] = [];

  const rows: UtilizationMatrixRow<R>[] = resources.map((resource) => {
    const rate = resource.capacityRate;
    listing.length = 0;
    resource.workingIntervals(windowFrom, windowEnd, listing);
    const intervals = clipAndCut(listing, cutStep, origin, spanEnd, scratch);
    scratch.delta = grow(scratch.delta, intervals + 1);
    scratch.partial = grow(scratch.partial, intervals);
    accrueRow(
      demands.get(String(resource.id)) ?? [],
      origin,
      spanEnd,
      intervals,
      count,
      scratch,
    );

    const cells: UtilizationCell[] = [];
    for (let i = 0; i < count; i += 1) {
      const bucket = buckets[i] as Bucket;
      const working = scratch.workingMs[i] as number;
      const baseAllocated = scratch.allocated[i] as number;
      const baseCapacity = rate * working;
      let allocated = baseAllocated;
      let capacity = baseCapacity;
      // §2.4 — the hooks run once per cell, at the single choke point every cell passes before
      // becoming public: after accrual, before ratios, strictly outside the typed-array sweep.
      if (hookInput !== null) {
        hookInput.resource = resource.source;
        hookInput.resourceId = resource.id;
        hookInput.resourceName = resource.name;
        hookInput.capacityRate = rate;
        hookInput.bucketStart = bucket.start;
        hookInput.bucketEnd = bucket.end;
        hookInput.workingMs = working;
        hookInput.workingDays = scratch.workingDays[i] as number;
        hookInput.allocated = baseAllocated;
        hookInput.capacity = baseCapacity;
        const shared = hookInput as unknown as ResourceBucketInput<R>;
        if (loadHook !== undefined) {
          try {
            const out = loadHook(shared);
            // A non-finite result keeps the built-in value silently; no cell is ever omitted.
            if (typeof out === "number" && Number.isFinite(out)) allocated = out;
          } catch (error) {
            if (!loadReported) {
              loadReported = true;
              hooks?.onError?.("resourceLoad", error);
            }
          }
        }
        if (capacityHook !== undefined) {
          // Both hooks see the BUILT-IN baselines, so a hook that mutated the shared input cannot
          // change what the other one is handed, and the two are order-independent.
          hookInput.allocated = baseAllocated;
          hookInput.capacity = baseCapacity;
          try {
            const out = capacityHook(shared);
            if (typeof out === "number" && Number.isFinite(out)) capacity = out;
          } catch (error) {
            if (!capacityReported) {
              capacityReported = true;
              hooks?.onError?.("resourceCapacity", error);
            }
          }
        }
      }
      cells.push({
        start: bucket.start,
        end: bucket.end,
        workingMs: working,
        allocated,
        capacity,
        ratio: capacity > 0 ? allocated / capacity : null,
        overallocated: allocated > capacity * threshold + OVERLOAD_EPSILON,
      });
    }
    return { resource, cells };
  });

  return { bucket: unit, rows };
}
