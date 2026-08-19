// docs/specs/plugins/resource.md §3.6 — the aggregate band's DATA half: the Σ-units histogram
// plus one shared aggregation seam.
/**
 * The band's per-bucket bar and capacity-line values: the built-in Σ`units` histogram, the
 * task-count fallback, the band-level `load` / `capacity` overrides, and Σ mode's column sums over
 * the §2 matrix.
 *
 * Both consumers — the live band's paint and the export surface's per-tile redraw — aggregate
 * through the SAME entry (`createBandAggregator`), which is what keeps screen and export from
 * drifting apart on bucket width, week start, allowlist, custom functions, Σ mode and the fallback.
 *
 * Headless: no DOM and no service reference; time is epoch milliseconds UTC.
 */
import type { Assignment, ReadonlyDataView, Resource, Task, TaskId } from "@stargantt/plugin-data-store";
import type { LoadChartBucketInput, ResolvedLoadChart } from "../../config";
import { bucketsInRange, createBucketIndexer, resolveBucketMode } from "../engine/buckets";
import type { Bucket, BucketIndexer, UtilizationBucketUnit } from "../engine/buckets";
import type { UtilizationMatrix } from "../engine/compute";

/** One resolved bucket: its range plus the bar value and capacity-line value computed for it. */
export interface BucketResult {
  bucket: Bucket;
  /** The bar value — either the built-in Σunits/task-count aggregation or the custom `load`. */
  value: number;
  /** The capacity-line value, or `null` when no line is drawn for this bucket. */
  capacity: number | null;
}

/** The band-level (non-engine) slice of the `loadChart` nest the aggregation reads. */
export interface AggregationConfig {
  /** Resource id allowlist; empty means every store resource counts. */
  resources: readonly (string | number)[];
  /** Band-bar override; contained by the caller before it reaches here. */
  load: ((input: LoadChartBucketInput) => number) | undefined;
  /** Capacity-line override; `null` = no line there. */
  capacity: ((input: LoadChartBucketInput) => number | null) | undefined;
}

/** Narrows the resolved nest down to the aggregation's own inputs. */
export function aggregationConfig(config: ResolvedLoadChart): AggregationConfig {
  return { resources: config.resources, load: config.load, capacity: config.capacity };
}

/** Σ(`capacity ?? 1`) over `resources` — the capacity-line value, identical for every bucket. */
function sumCapacity(resources: readonly Resource[]): number {
  let sum = 0;
  for (const r of resources) sum += r.capacity ?? 1;
  return sum;
}

/** Default per-bucket capacity: Σ(`capacity ?? 1`) over the already-narrowed resources. */
function defaultCapacity(input: LoadChartBucketInput): number {
  return sumCapacity(input.resources);
}

/**
 * Whether the task-count fallback is active for `view` and `config` (§3.6).
 *
 * The fallback is tied to the STORE itself — not to any `resources` allowlist narrowing — and
 * never engages once a custom `load` is configured. Shared by the aggregation and the band's
 * accessible-name summary so the two agree without duplicating the rule.
 */
export function isFallbackMode(view: ReadonlyDataView, config: AggregationConfig): boolean {
  if (config.load !== undefined) return false;
  if (view.resources.size > 0) return false;
  for (const list of view.assignmentsByTask.values()) {
    if (list.length > 0) return false;
  }
  return true;
}

/**
 * The resource rows an allowlist admits, DEDUPLICATED on id: a duplicated id must not double-count
 * capacity, duplicate matrix rows or duplicate lanes. Order is the allowlist's own (first
 * occurrence wins); ids the store does not know are dropped. With an empty allowlist, every
 * resource counts in store order (§2.3).
 */
export function allowedResources(
  view: ReadonlyDataView,
  allowlist: readonly (string | number)[],
): Resource[] {
  if (allowlist.length === 0) return [...view.resources.values()];
  const out: Resource[] = [];
  const seen = new Set<string | number>();
  for (const id of allowlist) {
    if (seen.has(id)) continue;
    seen.add(id);
    const resource = view.resources.get(id);
    if (resource !== undefined) out.push(resource);
  }
  return out;
}

/** The band's accessible-name summary over one rendered bucket set (§7's `bandLabel` input). */
export interface BandSummary {
  rangeStart: number;
  rangeEnd: number;
  bucketCount: number;
  peakLoad: number;
  peakCapacity: number | null;
  overloadedBuckets: number;
}

/**
 * Summarizes a rendered bucket set: the covered range, bucket count, peak bar value, peak
 * capacity-line value (`null` when no bucket carries a line) and the count of overloaded buckets.
 * `fromT` / `toT` back the range when `results` is empty.
 */
export function summarizeBucketResults(
  results: readonly BucketResult[],
  fromT: number,
  toT: number,
): BandSummary {
  let peakLoad = 0;
  let peakCapacity: number | null = null;
  let overloadedBuckets = 0;
  for (const r of results) {
    if (r.value > peakLoad) peakLoad = r.value;
    if (r.capacity !== null && (peakCapacity === null || r.capacity > peakCapacity)) {
      peakCapacity = r.capacity;
    }
    if (r.capacity !== null && r.value > r.capacity) overloadedBuckets += 1;
  }
  const first = results[0];
  const last = results[results.length - 1];
  return {
    rangeStart: first !== undefined ? first.bucket.start : fromT,
    rangeEnd: last !== undefined ? last.bucket.end : toT,
    bucketCount: results.length,
    peakLoad,
    peakCapacity,
    overloadedBuckets,
  };
}

/**
 * Visits every task overlapping at least one bucket, with the inclusive bucket index range it
 * spans. Milestones (zero or negative duration) are dropped, the endpoints go through the
 * `BucketIndexer`, and the result is clamped to the bucket list.
 */
function forEachSpanningTask(
  view: ReadonlyDataView,
  indexer: BucketIndexer,
  count: number,
  visit: (task: Readonly<Task>, lo: number, hi: number) => void,
): void {
  for (const task of view.byId.values()) {
    // A non-numeric endpoint fails this comparison too and is skipped.
    if (!(task.end > task.start)) continue;
    let lo = indexer.firstIndex(task.start);
    if (lo < 0) lo = 0;
    let hi = indexer.lastIndex(task.end);
    if (hi > count - 1) hi = count - 1;
    if (!(lo <= hi)) continue;
    visit(task, lo, hi);
  }
}

/** Σ`units` per task id over the assignments the allowlist admits. */
function sumUnitsByTask(
  view: ReadonlyDataView,
  allowedIds: ReadonlySet<string | number> | null,
): Map<TaskId, number> {
  const totals = new Map<TaskId, number>();
  for (const list of view.assignmentsByTask.values()) {
    for (const a of list) {
      if (allowedIds !== null && !allowedIds.has(a.resourceId)) continue;
      totals.set(a.taskId, (totals.get(a.taskId) ?? 0) + a.units);
    }
  }
  return totals;
}

/** The per-bucket Σ`units` (or active-task count) walk, as a difference array. */
function accrue(
  view: ReadonlyDataView,
  indexer: BucketIndexer,
  count: number,
  unitsByTask: Map<TaskId, number> | null,
): Float64Array {
  // One extra slot so a task reaching the last bucket has somewhere to end without a bounds test.
  const delta = new Float64Array(count + 1);
  forEachSpanningTask(view, indexer, count, (task, lo, hi) => {
    const weight = unitsByTask === null ? 1 : (unitsByTask.get(task.id) ?? 0);
    if (weight === 0) return;
    delta[lo] = (delta[lo] as number) + weight;
    delta[hi + 1] = (delta[hi + 1] as number) - weight;
  });
  const values = new Float64Array(count);
  let value = 0;
  for (let i = 0; i < count; i += 1) {
    value += delta[i] as number;
    values[i] = value;
  }
  return values;
}

/** The built-in aggregation: Σ`units` per bucket (or the active-task count in fallback mode). */
function builtInResults(
  view: ReadonlyDataView,
  buckets: readonly Bucket[],
  indexer: BucketIndexer,
  allowedIds: ReadonlySet<string | number> | null,
  resources: readonly Resource[],
  fallback: boolean,
): BucketResult[] {
  const count = buckets.length;
  const values = accrue(view, indexer, count, fallback ? null : sumUnitsByTask(view, allowedIds));
  const capacity = fallback ? null : sumCapacity(resources);
  const results: BucketResult[] = [];
  for (let i = 0; i < count; i += 1) {
    results.push({ bucket: buckets[i] as Bucket, value: values[i] as number, capacity });
  }
  return results;
}

/**
 * The custom-function path: calls the configured `load` / `capacity` (falling back to the built-in
 * ones for whichever is absent) once per bucket. Per-bucket task lists are materialized LAZILY, on
 * the first input that reads its `tasks` member.
 */
function customResults(
  view: ReadonlyDataView,
  buckets: readonly Bucket[],
  indexer: BucketIndexer,
  allowedIds: ReadonlySet<string | number> | null,
  resources: readonly Resource[],
  assignments: readonly Assignment[],
  config: AggregationConfig,
): BucketResult[] {
  const count = buckets.length;

  let materialized: Task[][] | null = null;
  const tasksOf = (i: number): readonly Task[] => {
    if (materialized === null) {
      const byBucket: Task[][] = new Array<Task[]>(count);
      for (let k = 0; k < count; k += 1) byBucket[k] = [];
      forEachSpanningTask(view, indexer, count, (task, lo, hi) => {
        for (let k = lo; k <= hi; k += 1) (byBucket[k] as Task[]).push(task);
      });
      materialized = byBucket;
    }
    return materialized[i] as Task[];
  };

  // With no custom `load`, the bar values come from the same difference-array walk the built-in
  // path uses — never a per-bucket rescan of every assignment.
  const builtInValues =
    config.load === undefined ? accrue(view, indexer, count, sumUnitsByTask(view, allowedIds)) : null;

  const load = config.load;
  const capacityFn = config.capacity ?? defaultCapacity;
  return buckets.map((bucket, i) => {
    const input: LoadChartBucketInput = {
      get tasks(): readonly Task[] {
        return tasksOf(i);
      },
      resources,
      assignments,
      bucketStart: bucket.start,
      bucketEnd: bucket.end,
    };
    const value = load === undefined ? ((builtInValues as Float64Array)[i] as number) : load(input);
    return { bucket, value, capacity: capacityFn(input) };
  });
}

/**
 * Computes the histogram for the buckets of `unit` covering `[fromT, toT)` (§3.6):
 *
 * - a task is active in a bucket when `start < bucketEnd && end > bucketStart`; milestones (zero
 *   or negative duration) are excluded;
 * - the `resources` allowlist narrows the resource/assignment set the aggregation and any custom
 *   function operate over, applied BEFORE either function runs;
 * - a custom `load` replaces the whole per-bucket bar value and disables the task-count fallback;
 *   a custom `capacity` replaces the per-bucket line value, `null` drawing no line;
 * - with no custom `load` and the store (before the allowlist filter) holding no resources and no
 *   assignments, the bar value falls back to the count of active tasks per bucket and no capacity
 *   line is drawn; an allowlist that filters out every resource does NOT trigger the fallback.
 */
export function computeBuckets(
  view: ReadonlyDataView,
  unit: UtilizationBucketUnit,
  fromT: number,
  toT: number,
  weekStartDay: number,
  config: AggregationConfig,
): BucketResult[] {
  const buckets = bucketsInRange(unit, fromT, toT, weekStartDay, "aligned");
  if (buckets.length === 0) return [];

  const resources = allowedResources(view, config.resources);
  const allowedIds = config.resources.length === 0 ? null : new Set(config.resources);
  const fallback = isFallbackMode(view, config);
  const indexer = createBucketIndexer(unit, buckets);

  // Fallback mode reaches neither custom function — it has a fixed task count and no capacity
  // line — so a custom `capacity` alone does not pull it out of the default path.
  if (fallback || (config.load === undefined && config.capacity === undefined)) {
    return builtInResults(view, buckets, indexer, allowedIds, resources, fallback);
  }

  const assignments: Assignment[] = [];
  for (const list of view.assignmentsByTask.values()) {
    for (const a of list) {
      if (allowedIds === null || allowedIds.has(a.resourceId)) assignments.push(a);
    }
  }
  return customResults(view, buckets, indexer, allowedIds, resources, assignments, config);
}

/**
 * Sums the matrix's columns into bucket results — Σ mode.
 *
 * The bar is the Σ of the post-hook `allocated` over every row, the line the Σ of the post-hook
 * `capacity`, both in milliseconds of working time; a bucket whose summed capacity is 0 draws no
 * line there.
 */
export function sumMatrix(matrix: UtilizationMatrix<Resource>): BucketResult[] {
  const first = matrix.rows[0];
  if (first === undefined) return [];
  const results: BucketResult[] = [];
  for (let i = 0; i < first.cells.length; i += 1) {
    let value = 0;
    let capacity = 0;
    for (const row of matrix.rows) {
      const cell = row.cells[i];
      if (cell === undefined) continue;
      value += cell.allocated;
      capacity += cell.capacity;
    }
    const cell = first.cells[i];
    if (cell === undefined) continue;
    results.push({
      bucket: { start: cell.start, end: cell.end },
      value,
      capacity: capacity > 0 ? capacity : null,
    });
  }
  return results;
}

/** Aggregates a time range into bucket results, and answers what mode produced them. */
export interface BandAggregator {
  /** The histogram of `[fromT, toT)` under the current zoom, data and configuration. */
  buckets(fromT: number, toT: number): BucketResult[];
  /** Whether the task-count fallback currently applies. */
  isFallback(): boolean;
  /**
   * Whether Σ mode is what `buckets()` would return now: a `loadChart` per-resource hook is
   * configured AND the matrix has at least one row. In Σ mode the bar and line values are
   * milliseconds of working time rather than dimensionless unit sums.
   */
  isSigma(): boolean;
  /** The largest bar or capacity-line value in `[fromT, toT)` — the y-scale peak of that span. */
  peak(fromT: number, toT: number): number;
  /**
   * The bucket width `buckets()` would use right now — the configured `bucket` with `"auto"`
   * resolved against the current zoom density. The one truth source for the band's grid; the lanes
   * read it too, so they can never sit on a different grid than the band.
   */
  unit(): UtilizationBucketUnit;
  /** The week-start weekday the grid is anchored on — the timeline's `firstDayOfWeek()`. */
  weekStartDay(): number;
}

export interface BandAggregatorDeps {
  view(): ReadonlyDataView;
  /** The configured width; `"auto"` resolves against `pxPerDay()` per call. */
  bucket: UtilizationBucketUnit | "auto";
  pxPerDay(): number;
  weekStartDay(): number;
  aggregation: AggregationConfig;
  /**
   * The §2 matrix over the band's own UNCOARSENED grid — supplied only when a `loadChart`
   * per-resource hook is configured, which is exactly what turns Σ mode on.
   */
  matrix?: (
    unit: UtilizationBucketUnit,
    fromT: number,
    toT: number,
    weekStartDay: number,
  ) => UtilizationMatrix<Resource>;
  /** How many matrix rows the current data and allowlist yield; only read in Σ mode. */
  rowCount?: () => number;
}

/** Binds the data view, the timeline density and the config into one aggregation entry. */
export function createBandAggregator(deps: BandAggregatorDeps): BandAggregator {
  // Σ mode falls back to the built-in aggregation, task-count fallback included, exactly when the
  // matrix has no rows: no resource in the store, or none surviving the allowlist.
  const sigma = (): boolean => deps.matrix !== undefined && (deps.rowCount?.() ?? 0) > 0;
  const unit = (): UtilizationBucketUnit => resolveBucketMode(deps.bucket, deps.pxPerDay());

  function buckets(fromT: number, toT: number): BucketResult[] {
    const resolved = unit();
    const week = deps.weekStartDay();
    const matrix = deps.matrix;
    if (matrix !== undefined) {
      const built = matrix(resolved, fromT, toT, week);
      if (built.rows.length > 0) return sumMatrix(built);
    }
    return computeBuckets(deps.view(), resolved, fromT, toT, week, deps.aggregation);
  }

  return {
    buckets,
    // Σ mode always overrides the bucket-level functions, so it also overrides their fallback:
    // the `fallback` flag reports `true` only on the zero-row fallthrough.
    isFallback: () => !sigma() && isFallbackMode(deps.view(), deps.aggregation),
    isSigma: sigma,
    unit,
    weekStartDay: deps.weekStartDay,
    peak: (fromT, toT) => {
      let peak = 0;
      for (const r of buckets(fromT, toT)) {
        if (r.value > peak) peak = r.value;
        if (r.capacity !== null && r.capacity > peak) peak = r.capacity;
      }
      return peak;
    },
  };
}
