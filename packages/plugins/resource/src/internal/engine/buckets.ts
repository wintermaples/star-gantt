// docs/specs/plugins/resource.md §2.2 — the grid rules.
/**
 * The eight bucket grids, their epoch alignment, the two edge policies, `"auto"` resolution, the
 * coarsening ladder and the 8192-bucket cap.
 *
 * Merged from load-chart's grid computation (its Σ-units histogram is aggregate-BAND behavior,
 * never matrix behavior — §2.6 item 6 — and stays with that consumer) and resource-utilization's
 * `bucketGrid`, whose range-clipping rule is the `"clamped"` edge policy below.
 *
 * Headless: no DOM, no service reference. Time is uniformly epoch milliseconds UTC.
 */
import { MS_DAY } from "@stargantt/sdk";

/** The eight aggregation widths (§2.2). */
export type UtilizationBucketUnit =
  | "minute"
  | "minute5"
  | "minute15"
  | "minute30"
  | "hour"
  | "day"
  | "week"
  | "month";

/** A width, or the zoom-density-following `"auto"` the load chart's config accepts (§6.5). */
export type BucketMode = UtilizationBucketUnit | "auto";

/**
 * What happens at the analysis range's bounds (§2.2) — the explicit carrier of the two engines'
 * irreconcilable clamping rules (§2.6 item 7).
 *
 * `"clamped"` clips the first and last bucket to the range (the resource-utilization rule);
 * `"aligned"` keeps every bucket at its full grid width, the range bounds falling inside the edge
 * buckets (the load-chart rule).
 */
export type BucketEdges = "aligned" | "clamped";

/** One bucket of the grid; `end` is exclusive. */
export interface Bucket {
  start: number;
  end: number;
}

export const MS_WEEK = MS_DAY * 7;

/**
 * Every width but `"month"` steps by a fixed span. `"week"` is anchored on the week-start weekday
 * rather than on the epoch, so it keeps its own branch below; the rest align straight to the UTC
 * epoch, and each sub-day span divides a day evenly so its grid nests inside the wider ones.
 */
const STEP_MS: Readonly<Record<Exclude<UtilizationBucketUnit, "month">, number>> = {
  minute: 60_000,
  minute5: 300_000,
  minute15: 900_000,
  minute30: 1_800_000,
  hour: 3_600_000,
  day: MS_DAY,
  week: MS_WEEK,
};

/**
 * Every width from the narrowest to the widest — the order `coarsenBucketMode` escalates along and
 * the order `isBucketMode` validates against.
 */
const LADDER: readonly UtilizationBucketUnit[] = [
  "minute",
  "minute5",
  "minute15",
  "minute30",
  "hour",
  "day",
  "week",
  "month",
];

/** Safety cap on the number of buckets generated for one build, whatever the width (§2.2). */
export const MAX_BUCKETS = 8192;

/**
 * The fixed step of `unit` in milliseconds, or `null` for `"month"` — the one calendar-walking
 * width, whose buckets have no constant width.
 */
export function stepOf(unit: UtilizationBucketUnit): number | null {
  return unit === "month" ? null : STEP_MS[unit];
}

/** Whether `unit`'s buckets are narrower than a UTC day. */
export function isSubDayMode(unit: UtilizationBucketUnit): boolean {
  const step = stepOf(unit);
  return step !== null && step < MS_DAY;
}

/** Whether `value` names one of the eight concrete widths (`"auto"` is not one). */
export function isBucketMode(value: unknown): value is UtilizationBucketUnit {
  return LADDER.includes(value as UtilizationBucketUnit);
}

/** Start of the UTC day containing `t`. */
function startOfDay(t: number): number {
  return Math.floor(t / MS_DAY) * MS_DAY;
}

/**
 * Start of the UTC week containing `t`, the week beginning on `weekStartDay` (0 = Sunday …
 * 6 = Saturday). Subsumes both sources: utilization's `weekStart` name map and the timeline's
 * `firstDayOfWeek` (§2.1).
 */
export function startOfWeek(t: number, weekStartDay: number): number {
  const day = startOfDay(t);
  const weekday = new Date(day).getUTCDay();
  const back = (weekday - weekStartDay + 7) % 7;
  return day - back * MS_DAY;
}

/** Start of the UTC calendar month containing `t`. */
function startOfMonth(t: number): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** The UTC calendar month starting immediately after `monthStart`. */
function nextMonth(monthStart: number): number {
  const d = new Date(monthStart);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/**
 * A monotonic index of the UTC calendar month containing `t` (`year * 12 + month`).
 *
 * Instants outside the range a `Date` can represent have no month; they collapse to `-Infinity` /
 * `Infinity` so an interval reaching that far simply covers every bucket on that side.
 */
function monthIndexOf(t: number): number {
  const d = new Date(t);
  const year = d.getUTCFullYear();
  if (Number.isNaN(year)) return t < 0 ? -Infinity : Infinity;
  return year * 12 + d.getUTCMonth();
}

/** The start of the `unit` bucket containing `t`. */
function alignDown(unit: UtilizationBucketUnit, t: number, weekStartDay: number): number {
  if (unit === "month") return startOfMonth(t);
  if (unit === "week") return startOfWeek(t, weekStartDay);
  const step = STEP_MS[unit];
  return Math.floor(t / step) * step;
}

/**
 * Picks the resolved width for `"auto"`, from the current zoom level's `pxPerDay`.
 *
 * Against the built-in levels this puts the `"hour"` level (480) on hour buckets and the `"day"`
 * level (40) on day buckets, while `"week"` (12), `"month"` (4), `"quarter"` and `"year"` keep the
 * widths they resolved to before. 2880 px per day is 2 px per minute bucket, so only a third-party
 * level of that density reaches minute buckets. The sub-hour widths are deliberately unreachable
 * here: a five-, fifteen- or thirty-minute grid is a judgement about the data rather than about
 * zoom density, so a host asks for one by name.
 */
export function autoBucketMode(pxPerDay: number): UtilizationBucketUnit {
  if (pxPerDay > 2880) return "minute";
  if (pxPerDay > 100) return "hour";
  if (pxPerDay > 20) return "day";
  if (pxPerDay > 4) return "week";
  return "month";
}

/**
 * Resolves a configured width to a concrete one, following `"auto"` through the current zoom
 * level's density.
 *
 * An unusable value falls back to the default `"day"` rather than to `"auto"`, which is also what
 * an omitted option gets.
 */
export function resolveBucketMode(
  mode: BucketMode | undefined,
  pxPerDay: number,
): UtilizationBucketUnit {
  if (mode === "auto") return autoBucketMode(pxPerDay);
  return isBucketMode(mode) ? mode : "day";
}

/**
 * Coarsens `unit` along the width ladder (minute → … → hour → day → week → month, never past
 * month) until the grid it would produce over `[fromT, toT)` has at most `maxColumns` entries, or
 * month is reached.
 *
 * The bound applies regardless of how `unit` was chosen — including an explicit request — because
 * it protects the rendered/exported size, not a stated preference; month is always accepted even
 * when still over the bound, since there is nothing coarser to escalate to. Coarsening is a CALLER
 * policy (§2.5): the heatmap and the reports pass 200, the strips and the Σ-mode band pass none.
 */
export function coarsenBucketMode(
  unit: UtilizationBucketUnit,
  fromT: number,
  toT: number,
  weekStartDay: number,
  maxColumns: number,
): UtilizationBucketUnit {
  let index = LADDER.indexOf(unit);
  if (index < 0) index = 0;
  for (; index < LADDER.length - 1; index += 1) {
    const candidate = LADDER[index] as UtilizationBucketUnit;
    // Counting a minute grid over a multi-year range would itself build (and cap) an 8192-entry
    // array before rejecting it, once per rung. The fixed-width rungs answer the same question by
    // division; only `"month"`, which has no fixed width, needs the enumeration — and it is the
    // rung this loop never tests, since it is always accepted.
    const step = stepOf(candidate);
    const count =
      step === null
        ? bucketsInRange(candidate, fromT, toT, weekStartDay, "aligned").length
        : Math.ceil((toT - alignDown(candidate, fromT, weekStartDay)) / step);
    if (count <= maxColumns) return candidate;
  }
  return LADDER[LADDER.length - 1] as UtilizationBucketUnit;
}

/**
 * Enumerates the buckets of `unit` covering `[fromT, toT)` under `edges`, capped at `MAX_BUCKETS`
 * entries so a degenerate zoom/width combination cannot build an unbounded array.
 *
 * The grid itself is always the epoch- (or week-anchor-, or calendar-month-) aligned one; `edges`
 * decides only what happens at the two range bounds (§2.2): `"aligned"` returns the grid buckets
 * whole, `"clamped"` clips the first one's start and the last one's end to the range. Clipping
 * never moves an interior boundary, so the two policies agree exactly whenever both bounds already
 * sit on the grid.
 */
export function bucketsInRange(
  unit: UtilizationBucketUnit,
  fromT: number,
  toT: number,
  weekStartDay: number,
  edges: BucketEdges,
): Bucket[] {
  const buckets: Bucket[] = [];
  if (!(toT > fromT)) return buckets;

  const step = stepOf(unit);
  if (step !== null) {
    let start = alignDown(unit, fromT, weekStartDay);
    while (start < toT && buckets.length < MAX_BUCKETS) {
      buckets.push({ start, end: start + step });
      start += step;
    }
  } else {
    let start = startOfMonth(fromT);
    while (start < toT && buckets.length < MAX_BUCKETS) {
      const end = nextMonth(start);
      buckets.push({ start, end });
      start = end;
    }
  }

  if (edges === "clamped" && buckets.length > 0) {
    const first = buckets[0] as Bucket;
    if (first.start < fromT) first.start = fromT;
    const last = buckets[buckets.length - 1] as Bucket;
    if (last.end > toT) last.end = toT;
  }
  return buckets;
}

/**
 * Maps an interval's endpoints straight onto the index range of the buckets it overlaps.
 *
 * The bucket list `bucketsInRange` produces is a regular grid — a constant millisecond step for
 * the seven fixed widths, consecutive calendar months for `"month"` — so "which buckets does
 * `[start, end)` touch" is arithmetic on two numbers rather than a test against every bucket. Both
 * methods may return an index outside `[0, buckets.length)` (including `±Infinity` for an interval
 * that runs off one end); callers clamp.
 *
 * The two methods reproduce the activity rule `start < bucketEnd && end > bucketStart` exactly, so
 * an interval touching a boundary lands on the same buckets a per-bucket comparison would pick.
 */
export interface BucketIndexer {
  /** Index of the first bucket whose `end` is past `start`, i.e. the first `start < bucketEnd`. */
  firstIndex(start: number): number;
  /** Index of the last bucket whose `start` is before `end`, i.e. the last `end > bucketStart`. */
  lastIndex(end: number): number;
}

/** Builds the index mapping for a bucket list of `unit`, anchored on the list's first bucket. */
export function createBucketIndexer(
  unit: UtilizationBucketUnit,
  buckets: readonly Bucket[],
): BucketIndexer {
  const origin = buckets[0]?.start ?? 0;

  if (unit === "month") {
    const base = monthIndexOf(origin);
    return {
      firstIndex: (start) => monthIndexOf(start) - base,
      lastIndex: (end) => {
        const index = monthIndexOf(end);
        const onBoundary = Number.isFinite(index) && startOfMonth(end) === end;
        return (onBoundary ? index - 1 : index) - base;
      },
    };
  }

  const step = STEP_MS[unit];
  return {
    firstIndex: (start) => Math.floor((start - origin) / step),
    // `ceil - 1` is what makes a boundary-aligned `end` exclusive: an exact multiple of the step
    // gives back the bucket before the one it opens, anything inside a bucket gives that bucket.
    lastIndex: (end) => Math.ceil((end - origin) / step) - 1,
  };
}
