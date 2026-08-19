// docs/specs/plugins/resource.md §3.1 — per-resource working-calendar evaluation.
/**
 * Calendar arithmetic itself belongs to the shared `sdk/time` engine; this module only
 * supplies the pool's own policies on top of it: the Monday-Friday default for an entry without a
 * calendar, and the time-off subtraction (time off is pool data, not calendar data).
 *
 * Headless: pure functions over the calendar shape.
 */
import { DEFAULT_WORKWEEK, workingIntervals } from "@stargantt/sdk";
import type { TimeRange, WorkingCalendar } from "@stargantt/sdk";
import type { ResourceTimeOff, ResourceWorkCalendar } from "./pool";
import { isPlainObject } from "./pool";

/** Whether the value names at least one weekday the engine can match. */
function hasUsableWorkingDays(days: unknown): boolean {
  return Array.isArray(days) && days.some((d) => Number.isInteger(d) && d >= 0 && d <= 6);
}

/**
 * The calendar the engine evaluates for an entry: the entry's own, or the shared Monday-Friday
 * default when it has none. A calendar whose `workingDays` names no usable weekday keeps its
 * windows and exceptions but falls back to the default weekdays — the member-wise degradation the
 * pool promises.
 */
export function effectiveCalendar(calendar: ResourceWorkCalendar | undefined): Readonly<WorkingCalendar> {
  if (!isPlainObject(calendar)) return DEFAULT_WORKWEEK;
  const cal = calendar as unknown as Readonly<WorkingCalendar>;
  if (hasUsableWorkingDays(cal.workingDays)) return cal;
  return { ...cal, workingDays: DEFAULT_WORKWEEK.workingDays };
}

/** Whether any half-open time-off range covers `epochMs`. */
export function inTimeOff(ranges: readonly ResourceTimeOff[], epochMs: number): boolean {
  return ranges.some((r) => epochMs >= r.start && epochMs < r.end);
}

/** The time-off ranges clipped to `[from, to)`, merged and ascending, so overlaps count once. */
function mergedTimeOff(ranges: readonly ResourceTimeOff[], from: number, to: number): TimeRange[] {
  const out: TimeRange[] = [];
  for (const r of ranges) {
    const start = Math.max(r.start, from);
    const end = Math.min(r.end, to);
    if (end > start) out.push({ start, end });
  }
  out.sort((a, b) => a.start - b.start);
  let merged = 0;
  for (let i = 0; i < out.length; i += 1) {
    const range = out[i] as TimeRange;
    const last = merged > 0 ? (out[merged - 1] as TimeRange) : undefined;
    if (last !== undefined && range.start <= last.end) {
      if (range.end > last.end) last.end = range.end;
      continue;
    }
    out[merged] = range;
    merged += 1;
  }
  out.length = merged;
  return out;
}

/**
 * The entry's working intervals inside the half-open `[from, to)`: the intervals its calendar
 * defines (the shared Monday-Friday default when it has none) with every millisecond its time off
 * covers cut out. Clipped to the query range, disjoint and ascending, empty when `to` is not after
 * `from`. Appends into `out` and returns it (the shared engine's listing convention).
 */
export function workingIntervalsOf(
  calendar: ResourceWorkCalendar | undefined,
  timeOff: readonly ResourceTimeOff[],
  from: number,
  to: number,
  out: TimeRange[],
): TimeRange[] {
  if (!(Number.isFinite(from) && Number.isFinite(to) && to > from)) return out;
  const cal = effectiveCalendar(calendar);
  const off = timeOff.length === 0 ? [] : mergedTimeOff(timeOff, from, to);
  if (off.length === 0) return workingIntervals(cal, from, to, out);

  const scratch: TimeRange[] = [];
  workingIntervals(cal, from, to, scratch);
  let cursor = 0;
  for (const interval of scratch) {
    while (cursor < off.length && (off[cursor] as TimeRange).end <= interval.start) cursor += 1;
    let segmentStart = interval.start;
    for (let k = cursor; k < off.length; k += 1) {
      const range = off[k] as TimeRange;
      if (range.start >= interval.end) break;
      if (range.start > segmentStart) out.push({ start: segmentStart, end: range.start });
      if (range.end > segmentStart) segmentStart = range.end;
    }
    if (interval.end > segmentStart) out.push({ start: segmentStart, end: interval.end });
  }
  return out;
}

/**
 * The working milliseconds of `[from, to)` for one entry: the total length of exactly the
 * intervals `workingIntervalsOf` lists for the same entry and range.
 */
export function workingMsOf(
  calendar: ResourceWorkCalendar | undefined,
  timeOff: readonly ResourceTimeOff[],
  from: number,
  to: number,
): number {
  const measured: TimeRange[] = [];
  workingIntervalsOf(calendar, timeOff, from, to, measured);
  let total = 0;
  for (const interval of measured) total += interval.end - interval.start;
  return total;
}
