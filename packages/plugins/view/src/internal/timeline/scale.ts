/**
 * Calendar-unit arithmetic for the time axis.
 *
 * Not part of the published surface — the package exports only the plugin factory, its public
 * types and its `declare module` augmentation. These helpers exist so the unit maths can be
 * unit-tested without a DOM.
 *
 * Time is uniformly epoch milliseconds **UTC**, so every boundary below is computed with the
 * `getUTC*` / `Date.UTC` family. No local-timezone reading anywhere.
 */
import type { ScaleRow } from "./index";
import { fromWall, toWall } from "./zone";

export type ScaleUnit = ScaleRow["unit"];

export const MS_HOUR = 3_600_000;
export const MS_DAY = 86_400_000;
export const MS_WEEK = 604_800_000;

/**
 * Upper bound on the boundaries produced for one visible range. A header row can only show a
 * few hundred labels; without a cap, an "hour" row over a decade-wide viewport would build a
 * multi-million entry array before the caller could discard it.
 */
export const MAX_TICKS = 4096;

/** `step` is optional on `ScaleRow`; anything below 1 or non-finite degrades to 1. */
export function normalizeStep(step: number | undefined): number {
  if (step === undefined || !Number.isFinite(step)) return 1;
  const n = Math.floor(step);
  return n >= 1 ? n : 1;
}

// docs/specs/plugins/view.md — a stepped row can anchor its
// sequence on a calendar index other than a multiple of `step`; a fiscal year is a `step: 12`
// month row anchored on the fiscal start month.
/**
 * `stepOffset` is optional on `ScaleRow`; the calendar-index remainder the stepped sequence is
 * anchored on, reduced to `0..step-1`. Anything that is not a finite number degrades to 0 — the
 * plain multiple-of-`step` anchoring.
 */
export function normalizeStepOffset(offset: number | undefined, step: number): number {
  if (offset === undefined || !Number.isFinite(offset)) return 0;
  const n = Math.floor(offset);
  return ((n % step) + step) % step;
}

// docs/specs/plugins/view.md — the week-boundary weekday is configurable; 1
// (Monday, ISO-8601) is the default and reproduces the previous fixed behaviour.
/** Weekday a week starts on when none was configured: 1 = Monday, i.e. ISO-8601. */
export const DEFAULT_FIRST_DAY_OF_WEEK: 0 | 1 | 2 | 3 | 4 | 5 | 6 = 1;

/**
 * The configured week-start weekday, or the ISO-8601 default when the value is unusable.
 *
 * `firstDayOfWeek` is host configuration, so a value that is not an integer 0..6 degrades to the
 * default rather than producing nonsensical boundaries.
 */
export function normalizeFirstDayOfWeek(value: unknown): 0 | 1 | 2 | 3 | 4 | 5 | 6 {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 6
    ? (value as 0 | 1 | 2 | 3 | 4 | 5 | 6)
    : DEFAULT_FIRST_DAY_OF_WEEK;
}

/**
 * The three calendar operations a scale unit has to answer, all in UTC.
 *
 * Every unit-dependent decision in this plugin — where a cell starts, where the next one starts,
 * and which absolute cell a boundary is — goes through one of these, so a unit is described in
 * exactly one place instead of once per `switch`.
 */
interface UnitOps {
  /** Largest boundary of this unit at or before `t`. */
  floor(t: number, firstDayOfWeek: number): number;
  /** The boundary `step` units after `t`, which is expected to be a boundary already. */
  advance(t: number, step: number): number;
  /** This boundary's absolute index in the unit's own sequence, independent of any range. */
  index(t: number, firstDayOfWeek: number): number;
}

// docs/specs/plugins/data-store.md — time is epoch milliseconds in UTC, and
// docs/specs/plugins/view.md — keeps these helpers off the published surface.
// `satisfies Record<ScaleUnit, UnitOps>` is the exhaustiveness check: adding a member to `ScaleUnit`
// without teaching this table how to floor, advance and index it is a compile error, where a
// `switch` per operation could silently fall through in one of them.
/** Start of the week containing `t`, on the configured week start. Named because the week's own index counts from it. */
function floorWeek(t: number, firstDayOfWeek: number): number {
  const day = Math.floor(t / MS_DAY) * MS_DAY;
  // docs/specs/plugins/view.md — getUTCDay(): 0 = Sunday. How many days to step
  // back to reach the configured week start; with the default 1 (Monday) this is the ISO-8601
  // `(day + 6) % 7` rotation the plugin used to hardcode.
  const start = normalizeFirstDayOfWeek(firstDayOfWeek);
  const back = (new Date(day).getUTCDay() - start + 7) % 7;
  return day - back * MS_DAY;
}

/** Per-unit calendar arithmetic — the single dispatch table for the five scale units. */
const UNITS = {
  year: {
    floor: (t) => Date.UTC(new Date(t).getUTCFullYear(), 0, 1),
    advance: (t, step) => Date.UTC(new Date(t).getUTCFullYear() + step, 0, 1),
    index: (t) => new Date(t).getUTCFullYear(),
  },
  month: {
    floor: (t) => {
      const d = new Date(t);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    },
    advance: (t, step) => {
      const d = new Date(t);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + step, 1);
    },
    index: (t) => {
      const d = new Date(t);
      return d.getUTCFullYear() * 12 + d.getUTCMonth();
    },
  },
  week: {
    floor: floorWeek,
    advance: (t, step) => t + step * MS_WEEK,
    // Weeks are fixed 7-day cycles, so counting from any fixed week-aligned reference (here, the
    // week containing the epoch) gives an absolute index regardless of `firstDayOfWeek`.
    index: (t, firstDayOfWeek) => Math.round((t - floorWeek(0, firstDayOfWeek)) / MS_WEEK),
  },
  day: {
    floor: (t) => Math.floor(t / MS_DAY) * MS_DAY,
    advance: (t, step) => t + step * MS_DAY,
    index: (t) => Math.round(t / MS_DAY),
  },
  hour: {
    floor: (t) => Math.floor(t / MS_HOUR) * MS_HOUR,
    advance: (t, step) => t + step * MS_HOUR,
    index: (t) => Math.round(t / MS_HOUR),
  },
} satisfies Record<ScaleUnit, UnitOps>;

/**
 * Largest `unit` boundary at or before `t`, in UTC.
 *
 * `firstDayOfWeek` (0 = Sunday … 6 = Saturday) selects the weekday a `"week"` boundary falls on
 * and is ignored by every other unit; it defaults to Monday (ISO-8601).
 */
export function floorTo(
  t: number,
  unit: ScaleUnit,
  firstDayOfWeek: number = DEFAULT_FIRST_DAY_OF_WEEK,
  timeZone?: string,
): number {
  // docs/specs/plugins/view.md — with a display time zone the
  // arithmetic runs on the zone's wall clock: convert in, floor as before, convert back. With no
  // zone the pre-existing UTC path runs untouched, so default output is byte-identical.
  if (timeZone === undefined) return UNITS[unit].floor(t, firstDayOfWeek);
  return fromWall(timeZone, UNITS[unit].floor(toWall(timeZone, t), firstDayOfWeek));
}

/** The boundary `step` units after `t`. `t` is expected to be a boundary already. */
export function advance(t: number, unit: ScaleUnit, step: number, timeZone?: string): number {
  if (timeZone === undefined) return UNITS[unit].advance(t, step);
  return fromWall(timeZone, UNITS[unit].advance(toWall(timeZone, t), step));
}

// docs/specs/plugins/view.md — the absolute position of a boundary in its unit's
// own sequence, independent of any visible range. Both the `step` alignment below and the header's
// fit-based label thinning key off this one index, so a boundary's identity is a function of the
// calendar alone.
/**
 * The absolute index of a `unit` boundary in that unit's own sequence.
 *
 * Counted from a fixed reference per unit — year 0 for years and months, the epoch for days and
 * hours, and the week containing the epoch for weeks — so the value depends only on the instant,
 * never on the range being drawn.
 *
 * `firstDayOfWeek` (0 = Sunday … 6 = Saturday) selects the weekday `"week"` boundaries fall on;
 * it defaults to Monday (ISO-8601) and is ignored by every other unit.
 */
export function calendarIndex(
  t: number,
  unit: ScaleUnit,
  firstDayOfWeek: number = DEFAULT_FIRST_DAY_OF_WEEK,
  timeZone?: string,
): number {
  if (timeZone === undefined) return UNITS[unit].index(t, firstDayOfWeek);
  return UNITS[unit].index(toWall(timeZone, t), firstDayOfWeek);
}

// docs/specs/plugins/view.md — a `step` row's boundaries
// are a property of the calendar, not of what happens to be on screen: a `step: 3` month row starts
// its cells on January/April/July/October whatever the viewport shows, and a `step: 10` year row on
// a decade start. Flooring to the unit alone and then advancing by `step` would instead seed the
// sequence on the viewport's left edge, so every boundary would slide as the user scrolled.
/**
 * Largest boundary at or before `t` that is also aligned to `step` units of `unit`.
 *
 * Identical to `floorTo` when `step` is 1. For larger steps the result is the nearest earlier
 * boundary whose absolute calendar index is a multiple of `step`, so the sequence it seeds is
 * fixed by the calendar rather than by where the range starts.
 *
 * `firstDayOfWeek` (0 = Sunday … 6 = Saturday) selects the weekday `"week"` boundaries fall on;
 * it defaults to Monday (ISO-8601) and is ignored by every other unit.
 */
export function floorToStep(
  t: number,
  unit: ScaleUnit,
  step?: number,
  firstDayOfWeek: number = DEFAULT_FIRST_DAY_OF_WEEK,
  timeZone?: string,
  stepOffset?: number,
): number {
  const base = floorTo(t, unit, firstDayOfWeek, timeZone);
  const n = normalizeStep(step);
  if (n === 1) return base;
  const index = calendarIndex(base, unit, firstDayOfWeek, timeZone);
  // docs/specs/plugins/view.md — `stepOffset` shifts the anchor
  // remainder: a fiscal-year row (step 12, offset 3) breaks on Aprils rather than Januaries.
  const anchor = normalizeStepOffset(stepOffset, n);
  // Euclidean remainder: indices before the reference point are negative, and `%` alone would
  // then align the sequence the wrong way across that point.
  const back = (((index - anchor) % n) + n) % n;
  return back === 0 ? base : advance(base, unit, -back, timeZone);
}

// docs/specs/plugins/view.md — the grid cell holding an instant, built from the
// same `floorToStep` seed and `advance` walk `enumerate()` uses, so a cell's edges are boundaries
// the header and the body grid draw on.
/**
 * The half-open span of the `unit`/`step` cell containing `t`, or `undefined` when `t` is not a
 * finite number or the walk cannot advance.
 */
export function cellAt(
  t: number,
  unit: ScaleUnit,
  step?: number,
  firstDayOfWeek: number = DEFAULT_FIRST_DAY_OF_WEEK,
  timeZone?: string,
  stepOffset?: number,
): { start: number; end: number } | undefined {
  if (!Number.isFinite(t)) return undefined;
  const n = normalizeStep(step);
  const start = floorToStep(t, unit, n, firstDayOfWeek, timeZone, stepOffset);
  const end = advance(start, unit, n, timeZone);
  // Defensive, mirroring `enumerate`'s non-advancing guard: a degenerate cell is no cell.
  if (!Number.isFinite(start) || !(end > start)) return undefined;
  return { start, end };
}

// docs/specs/plugins/view.md — the public `unitBoundaries` member's engine. It runs
// the very same `enumerate()` walk `ticks()` does, which is what makes the body grid and the header
// ticks one calendar rather than two: the only difference between the two is the leading boundary,
// which the header needs (it labels a cell straddling the left edge) and a half-open enumeration
// must not report.
/**
 * Every `unit` boundary that falls inside `[from, to)`, ascending.
 *
 * Unlike `ticks`, a boundary at or before `from` is not reported: the span is half-open on both
 * ends, so the result holds only instants within it.
 *
 * A `step` above 1 produces boundaries aligned to the calendar rather than to `from`, exactly as
 * `ticks` does. `firstDayOfWeek` (0 = Sunday … 6 = Saturday) selects the weekday `"week"`
 * boundaries fall on and is ignored by every other unit.
 */
export function unitBoundaries(
  from: number,
  to: number,
  unit: ScaleUnit,
  step?: number,
  firstDayOfWeek: number = DEFAULT_FIRST_DAY_OF_WEEK,
  timeZone?: string,
  stepOffset?: number,
): number[] {
  return enumerate(from, to, unit, step, firstDayOfWeek, false, timeZone, stepOffset);
}

/**
 * Every `unit` boundary that overlaps `[from, to)`, ascending.
 *
 * The first entry is the boundary at or before `from`, so the partially scrolled-out leading
 * cell still has a label to draw.
 *
 * A `step` above 1 produces boundaries aligned to the calendar — every third month of a `step: 3`
 * month row falls on January, April, July or October — rather than to `from`, so the same set of
 * boundaries comes back for a given zoom level however the range is scrolled.
 *
 * `firstDayOfWeek` (0 = Sunday … 6 = Saturday) selects the weekday `"week"` boundaries fall on;
 * it defaults to Monday (ISO-8601) and is ignored by every other unit.
 */
export function ticks(
  from: number,
  to: number,
  unit: ScaleUnit,
  step?: number,
  firstDayOfWeek: number = DEFAULT_FIRST_DAY_OF_WEEK,
  timeZone?: string,
  stepOffset?: number,
): number[] {
  return enumerate(from, to, unit, step, firstDayOfWeek, true, timeZone, stepOffset);
}

/**
 * The one boundary walk both `ticks` and `unitBoundaries` run.
 *
 * Seeds on the calendar-aligned boundary at or before `from` and advances by `step` units until
 * `to` or the `MAX_TICKS` cap, whichever comes first. `includeLeading` is the only difference
 * between the two callers: the header keeps the seed boundary (it labels the cell straddling the
 * left edge), a half-open enumeration drops it.
 */
function enumerate(
  from: number,
  to: number,
  unit: ScaleUnit,
  step: number | undefined,
  firstDayOfWeek: number,
  includeLeading: boolean,
  timeZone?: string,
  stepOffset?: number,
): number[] {
  const out: number[] = [];
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return out;
  const n = normalizeStep(step);
  let t = floorToStep(from, unit, n, firstDayOfWeek, timeZone, stepOffset);
  while (t < to && out.length < MAX_TICKS) {
    // The seed boundary is the one at or before `from`, so at most this first step is dropped.
    if (includeLeading || t >= from) out.push(t);
    const next = advance(t, unit, n, timeZone);
    // Defensive: a non-advancing step would spin forever.
    if (!(next > t)) break;
    t = next;
  }
  return out;
}
