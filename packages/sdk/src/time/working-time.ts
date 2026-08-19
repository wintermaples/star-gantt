// The working-time engine (docs/specs/sdk.md, Module: sdk/time). Window values are milliseconds
// from UTC midnight; all time arithmetic is UTC; boundary walks are bounded so a calendar with no
// working time at all cannot loop forever.
/**
 * The shared working-time engine: pure arithmetic over a calendar's weekly working days, intra-day
 * working windows and per-date exceptions.
 *
 * Everything here is plain arithmetic over epoch-millisecond UTC instants, which is how task start
 * and end times are represented. No DOM, no locale and no `Intl`, so it runs unchanged in plain
 * Node, and no id resolution or "no calendar" defaulting — those policies belong to the services
 * that call it.
 *
 * Two granularities exist, chosen per calendar:
 *  - a calendar **without** usable working windows resolves whole days: a working day is working
 *    from midnight to midnight, and a non-working day is skipped whole;
 *  - a calendar **with** working windows resolves working intervals inside each day: an instant in
 *    a non-working stretch moves to the start of the next working interval, and a span's working
 *    time counts only the milliseconds inside those windows.
 *
 * All ranges are half-open — `start` inclusive, `end` exclusive — and every list returned is
 * clipped to the query range, merged and ascending.
 */
import { MS_DAY } from "./time";

/** A half-open time range in epoch milliseconds (UTC): `start` inclusive, `end` exclusive. */
export interface TimeRange {
  start: number;
  end: number;
}

/**
 * The id-less calendar shape the engine evaluates.
 *
 * Window values — both the calendar's `workingHours` and an exception's `hours` — are
 * milliseconds from UTC midnight, so a 09:00–17:00 day is `[32400000, 61200000]`. `workingDays`
 * holds weekday numbers, 0 = Sunday … 6 = Saturday (UTC). An `exceptions` entry names a UTC
 * calendar day as `"YYYY-MM-DD"` and overrides that day's working flag, and its own `hours`
 * override the calendar's windows for that day.
 */
export type WorkingCalendar = {
  readonly workingDays: readonly number[];
  readonly workingHours?: readonly (readonly [number, number])[];
  readonly exceptions?: readonly {
    readonly date: string;
    readonly working: boolean;
    readonly hours?: readonly (readonly [number, number])[];
  }[];
};

/**
 * The Monday-to-Friday, all-day calendar — the single shared default for a consumer that needs one
 * when no calendar is known for a task, a resource or a chart.
 *
 * It declares no working windows, so it resolves at whole-day granularity: every Monday through
 * Friday is working from UTC midnight to UTC midnight, and Saturday and Sunday are not.
 */
export const DEFAULT_WORKWEEK: Readonly<WorkingCalendar> = Object.freeze({
  workingDays: Object.freeze([1, 2, 3, 4, 5]) as readonly number[],
});

/**
 * Upper bound on the number of days a boundary or advance walk crosses before giving up. A
 * calendar with no working time at all (`workingDays: []` and no working exception, or windows
 * that cover nothing) would otherwise loop forever; every walk must terminate on any input.
 *
 * Exported because a caller that walks days itself — for a landing rule the engine deliberately
 * does not implement — must give up after the same number of days, and one number cannot be two
 * numbers.
 */
export const MAX_SKIPPED_DAYS = 4000;

/**
 * Upper bound on the number of days a measurement or listing walk crosses. Well beyond any
 * plausible task span or viewport; it only exists so a corrupt pair of instants cannot hang a
 * caller.
 */
const MAX_MEASURED_DAYS = 400_000;

/** Days in each month of a common year, indexed 0 = January. February is corrected for leap years. */
const MONTH_DAYS: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * The resolved working intervals of one UTC day, flattened as `[start0, end0, start1, end1, …]`
 * absolute instants.
 *
 * Module-private and never handed out: `resolveDay` rewrites it, and every predicate, measurement
 * and boundary function reads it before calling anything that could rewrite it again. This is what
 * lets those functions allocate nothing per call. It is safe only because the engine calls no user
 * code and JavaScript is single-threaded — a future user-supplied calendar predicate would need a
 * different mechanism.
 */
const scratch: number[] = [];

/** Start of the UTC day containing `t`. `Math.floor` keeps this correct for pre-1970 instants. */
export function startOfUtcDay(t: number): number {
  return Math.floor(t / MS_DAY) * MS_DAY;
}

/** UTC day of week, 0 = Sunday. 1970-01-01 was a Thursday (4). */
export function utcDayOfWeek(t: number): number {
  const day = Math.floor(t / MS_DAY);
  return (((day + 4) % 7) + 7) % 7;
}

/** `YYYY-MM-DD` in UTC — the shape a calendar's exception dates use. */
export function utcDateKey(t: number): string {
  const d = new Date(startOfUtcDay(t));
  const y = String(d.getUTCFullYear()).padStart(4, "0");
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Whether `s` is a plausible `YYYY-MM-DD` date key. */
export function isDateKey(s: unknown): s is string {
  return (
    typeof s === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
  );
}

/** The epoch-millisecond UTC-day start a `YYYY-MM-DD` key names, or `undefined` when unusable. */
export function dateKeyToTime(key: string): number | undefined {
  if (!isDateKey(key)) return undefined;
  return Date.parse(`${key}T00:00:00Z`);
}

/** The number of days from 1970-01-01 to the UTC civil date `y-m-d`. Howard Hinnant's algorithm. */
function daysFromCivil(y: number, m: number, d: number): number {
  const year = y - (m <= 2 ? 1 : 0);
  const era = Math.floor(year / 400);
  const yoe = year - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Reads `count` decimal digits of `s` starting at `at`, or `NaN` when any of them is not a digit. */
function readDigits(s: string, at: number, count: number): number {
  let n = 0;
  for (let i = at; i < at + count; i += 1) {
    const c = s.charCodeAt(i) - 48;
    if (c < 0 || c > 9) return Number.NaN;
    n = n * 10 + c;
  }
  return n;
}

/**
 * The day index (days from 1970-01-01, UTC) a `YYYY-MM-DD` key names, or `NaN` when the string is
 * not one — including a date that does not exist, such as `"2024-02-31"`, which no real day equals.
 *
 * Deliberately hand-parsed rather than routed through `Date`: this runs once per exception per day
 * of every walk, and it must not allocate.
 */
function dayOfDateKey(key: string): number {
  if (key.length !== 10 || key.charCodeAt(4) !== 45 || key.charCodeAt(7) !== 45) return Number.NaN;
  const y = readDigits(key, 0, 4);
  const m = readDigits(key, 5, 2);
  const d = readDigits(key, 8, 2);
  if (Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) return Number.NaN;
  if (m < 1 || m > 12 || d < 1) return Number.NaN;
  const leap = m === 2 && y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  if (d > (MONTH_DAYS[m - 1] as number) + (leap ? 1 : 0)) return Number.NaN;
  return daysFromCivil(y, m, d);
}

/**
 * The index of the calendar's exception entry for the UTC day starting at `dayStart`, or `-1`.
 * Entries without a `"YYYY-MM-DD"` date and a boolean `working` are dropped individually; when
 * several entries name the same day the first wins.
 *
 * Deliberately a plain linear scan with no memoization: a calendar editor may mutate both the
 * calendar object and its `exceptions` array in place (splice on removal, array swap on
 * designation), so neither reference is a sound cache key.
 */
function exceptionIndexFor(cal: Readonly<WorkingCalendar>, dayStart: number): number {
  const list = cal.exceptions;
  if (!Array.isArray(list) || list.length === 0) return -1;
  const day = Math.floor(dayStart / MS_DAY);
  for (let i = 0; i < list.length; i += 1) {
    const entry = list[i];
    if (entry === null || typeof entry !== "object") continue;
    if (typeof entry.date !== "string" || typeof entry.working !== "boolean") continue;
    const entryDay = dayOfDateKey(entry.date);
    if (entryDay === day) return i; // first entry naming the day wins
  }
  return -1;
}

/** Whether one window is usable: finite, and covering time once clamped into the day. */
function isUsableWindow(window: unknown): boolean {
  if (!Array.isArray(window)) return false;
  const from = window[0] as unknown;
  const to = window[1] as unknown;
  if (typeof from !== "number" || typeof to !== "number") return false;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
  return Math.max(0, Math.min(MS_DAY, to)) > Math.max(0, Math.min(MS_DAY, from));
}

/**
 * The day-level verdict for the UTC day starting at `dayStart`: whether it is working, and the
 * index of the exception entry that decided it (or governs its windows), `-1` when none applies.
 *
 * Computed once and shared by `dayIsWorking` (the public predicate's engine) and `resolveDay`
 * (which needs both the verdict and the exception's own `hours`), so a day's exceptions are
 * scanned once per day rather than twice.
 */
function dayVerdict(
  cal: Readonly<WorkingCalendar>,
  dayStart: number,
): { working: boolean; index: number } {
  const index = exceptionIndexFor(cal, dayStart);
  if (index >= 0) return { working: cal.exceptions?.[index]?.working === true, index };
  const days = cal.workingDays;
  return { working: Array.isArray(days) && days.includes(utcDayOfWeek(dayStart)), index: -1 };
}

/**
 * Whether the UTC day starting at `dayStart` is working, at day granularity: a per-date exception
 * overrides the weekly `workingDays` pattern. A thin wrapper over `dayVerdict`, which `resolveDay`
 * also uses so the two can never disagree about which days are working.
 */
function dayIsWorking(cal: Readonly<WorkingCalendar>, dayStart: number): boolean {
  return dayVerdict(cal, dayStart).working;
}

/**
 * Writes the working intervals of the UTC day containing `t` into the scratch buffer and returns
 * how many there are — `0` for a non-working day.
 *
 * An exception entry wins over `workingDays`, and its own `hours` win over the calendar's
 * `workingHours`; a working exception without `hours` uses the calendar's windows. A working day
 * with no usable window at all is working for the whole day, which is what gives a windowless
 * calendar its day granularity without a second code path.
 */
function resolveDay(cal: Readonly<WorkingCalendar>, t: number): number {
  const dayStart = startOfUtcDay(t);
  if (!Number.isFinite(dayStart)) return 0;
  const verdict = dayVerdict(cal, dayStart);
  if (!verdict.working) return 0;

  // `verdict.working` already established this day works, so an exception found here is a
  // *working* one — its own `hours`, when it carries any, are what override the calendar's.
  const exception = verdict.index < 0 ? undefined : cal.exceptions?.[verdict.index];
  const windows = exception?.hours ?? cal.workingHours;
  let count = 0;
  if (Array.isArray(windows)) {
    for (let i = 0; i < windows.length; i += 1) {
      const window = windows[i];
      if (!isUsableWindow(window)) continue;
      const pair = window as readonly [number, number];
      const from = dayStart + Math.max(0, Math.min(MS_DAY, pair[0]));
      const to = dayStart + Math.max(0, Math.min(MS_DAY, pair[1]));
      // Insertion sort in place: a day carries a handful of windows, and this allocates nothing.
      let k = count;
      while (k > 0 && (scratch[2 * k - 2] as number) > from) {
        scratch[2 * k] = scratch[2 * k - 2] as number;
        scratch[2 * k + 1] = scratch[2 * k - 1] as number;
        k -= 1;
      }
      scratch[2 * k] = from;
      scratch[2 * k + 1] = to;
      count += 1;
    }
  }
  if (count === 0) {
    scratch[0] = dayStart;
    scratch[1] = dayStart + MS_DAY;
    return 1;
  }

  // Merge touching and overlapping windows, so every reader can assume a clean ascending list.
  let merged = 0;
  for (let i = 0; i < count; i += 1) {
    const from = scratch[2 * i] as number;
    const to = scratch[2 * i + 1] as number;
    if (merged > 0 && from <= (scratch[2 * merged - 1] as number)) {
      if (to > (scratch[2 * merged - 1] as number)) scratch[2 * merged - 1] = to;
      continue;
    }
    scratch[2 * merged] = from;
    scratch[2 * merged + 1] = to;
    merged += 1;
  }
  return merged;
}

/**
 * Whether `t` falls on a working day of the calendar, at UTC day granularity.
 *
 * A per-date exception overrides the weekly pattern, and working windows play no part: a day the
 * calendar works at all is a working day. A value that is not a finite instant reports `false`.
 */
export function isWorkingDay(cal: Readonly<WorkingCalendar>, t: number): boolean {
  const dayStart = startOfUtcDay(t);
  if (!Number.isFinite(dayStart)) return false;
  return dayIsWorking(cal, dayStart);
}

/**
 * Whether the instant `t` is working time: a working day, and inside one of that day's working
 * windows. A working day whose calendar declares no usable window is working for the whole day, so
 * a windowless calendar answers the same question a day-granular reading would.
 */
export function isWorkingInstant(cal: Readonly<WorkingCalendar>, t: number): boolean {
  if (!Number.isFinite(t)) return false;
  const count = resolveDay(cal, t);
  for (let i = 0; i < count; i += 1) {
    if (t >= (scratch[2 * i] as number) && t < (scratch[2 * i + 1] as number)) return true;
  }
  return false;
}

/**
 * Whether the calendar resolves working intervals inside the day rather than whole days.
 *
 * True exactly when it declares at least one usable working window — one that is finite and still
 * covers time after being clamped into the day. A calendar whose every window is unusable is
 * day-granular, not a calendar with no working time.
 */
export function hasWorkingHours(cal: Readonly<WorkingCalendar> | undefined): boolean {
  const windows = cal?.workingHours;
  if (!Array.isArray(windows)) return false;
  for (let i = 0; i < windows.length; i += 1) if (isUsableWindow(windows[i])) return true;
  return false;
}

/**
 * Appends the day-walked ranges of `[from, to)` to `out`, either the working intervals or their
 * complement, clipped to the query range, merged with each other and ascending.
 */
function listRanges(
  cal: Readonly<WorkingCalendar>,
  from: number,
  to: number,
  out: TimeRange[],
  complement: boolean,
): TimeRange[] {
  if (!(Number.isFinite(from) && Number.isFinite(to) && to > from)) return out;
  // Merge only within this call: `out` may already carry ranges the caller put there.
  const base = out.length;
  let cursor = from;

  let day = startOfUtcDay(from);
  for (let i = 0; i < MAX_MEASURED_DAYS && day < to; i += 1, day += MS_DAY) {
    const count = resolveDay(cal, day);
    for (let k = 0; k < count; k += 1) {
      const lo = Math.max(scratch[2 * k] as number, from);
      const hi = Math.min(scratch[2 * k + 1] as number, to);
      if (hi <= lo) continue;
      if (complement) {
        if (lo > cursor) out.push({ start: cursor, end: lo });
        cursor = Math.max(cursor, hi);
        continue;
      }
      const last = out.length > base ? out[out.length - 1] : undefined;
      if (last !== undefined && lo <= last.end) {
        if (hi > last.end) last.end = hi;
        continue;
      }
      out.push({ start: lo, end: hi });
    }
  }
  if (complement && cursor < to) out.push({ start: cursor, end: to });
  return out;
}

/**
 * The working intervals intersecting the half-open `[from, to)`, clipped to it, merged and
 * ascending. Empty when `to` is not after `from`.
 *
 * Appends into `out` when one is given and returns it — a per-frame caller reuses one array
 * instead of allocating a list per paint, and is responsible for emptying it — and allocates a
 * fresh array otherwise.
 */
export function workingIntervals(
  cal: Readonly<WorkingCalendar>,
  from: number,
  to: number,
  out?: TimeRange[],
): TimeRange[] {
  return listRanges(cal, from, to, out ?? [], false);
}

/**
 * The non-working complement of the half-open `[from, to)` — whole non-working days and the
 * intra-day gaps outside the calendar's working windows alike — clipped to the query range, merged
 * and ascending. Empty when `to` is not after `from`.
 *
 * Takes and returns `out` on the same terms as the working listing.
 */
export function nonWorkingIntervals(
  cal: Readonly<WorkingCalendar>,
  from: number,
  to: number,
  out?: TimeRange[],
): TimeRange[] {
  return listRanges(cal, from, to, out ?? [], true);
}

/**
 * The working time, in milliseconds, the calendar counts in the half-open `[from, to)`.
 *
 * Non-working stretches contribute nothing, which is what turns an elapsed span into the working
 * duration a scheduler preserves. Returns `0` when `to` is not after `from`.
 */
export function workingMsBetween(cal: Readonly<WorkingCalendar>, from: number, to: number): number {
  if (!(Number.isFinite(from) && Number.isFinite(to) && to > from)) return 0;
  let total = 0;
  let day = startOfUtcDay(from);
  for (let i = 0; i < MAX_MEASURED_DAYS && day < to; i += 1, day += MS_DAY) {
    const count = resolveDay(cal, day);
    for (let k = 0; k < count; k += 1) {
      const lo = Math.max(scratch[2 * k] as number, from);
      const hi = Math.min(scratch[2 * k + 1] as number, to);
      if (hi > lo) total += hi - lo;
    }
  }
  return total;
}

/**
 * The first instant at or after `t` that the calendar calls working.
 *
 * `t` itself when it already is working time; otherwise the start of the next working interval,
 * which for a calendar without working windows is the start of the next working day. A calendar
 * that declares no working time at all has nothing to walk to: rather than loop forever the walk
 * gives up after an internal bound and returns `t` unmodified — a data error made visible in the
 * result rather than a failure.
 */
export function nextWorkingStart(cal: Readonly<WorkingCalendar>, t: number): number {
  if (!Number.isFinite(t)) return t;
  let cur = t;
  for (let i = 0; i < MAX_SKIPPED_DAYS; i += 1) {
    const count = resolveDay(cal, cur);
    for (let k = 0; k < count; k += 1) {
      const start = scratch[2 * k] as number;
      const end = scratch[2 * k + 1] as number;
      if (cur < start) return start;
      if (cur < end) return cur;
    }
    cur = startOfUtcDay(cur) + MS_DAY;
  }
  return t;
}

/**
 * The last instant at or before `t` that can close working time.
 *
 * The close of a working interval qualifies, which is what makes a task finishing exactly at the
 * end of the working day stay there. A calendar with no working time at all returns `t`
 * unmodified once the internal bound is hit, as the forward boundary does.
 */
export function previousWorkingEnd(cal: Readonly<WorkingCalendar>, t: number): number {
  if (!Number.isFinite(t)) return t;
  let day = startOfUtcDay(t);
  let cur = t;
  for (let i = 0; i < MAX_SKIPPED_DAYS; i += 1) {
    const count = resolveDay(cal, day);
    for (let k = count - 1; k >= 0; k -= 1) {
      const start = scratch[2 * k] as number;
      const end = scratch[2 * k + 1] as number;
      if (cur >= end) return end;
      if (cur > start) return cur;
    }
    day -= MS_DAY;
    cur = day + MS_DAY;
  }
  return t;
}

/**
 * Where an end that must fall **no earlier than** `t` lands on working time.
 *
 * `t` itself when it already is working time or exactly the close of a working interval — a task
 * finishing at the end of the working day stays there — and otherwise the start of the next
 * working interval, which is the first instant at or after `t` that can carry an end. The landing
 * therefore never moves an end backwards, which is what separates it from `previousWorkingEnd`:
 * pulling the end back would finish the task earlier than the bound that produced `t`.
 *
 * A calendar with no working time at all has nothing to walk to and returns `t` unmodified, as
 * both boundary walks do.
 */
export function landWorkingEnd(cal: Readonly<WorkingCalendar>, t: number): number {
  if (!Number.isFinite(t)) return t;
  // `previousWorkingEnd` returns `t` unchanged exactly when `t` is inside a working interval or at
  // its close, so equality is the "already a legal end" test — no separate predicate is needed.
  if (previousWorkingEnd(cal, t) === t) return t;
  return nextWorkingStart(cal, t);
}

/**
 * The instant reached by spending `workingMs` milliseconds of working time forward from `start`.
 *
 * `start` is first moved onto working time. Non-working stretches are stepped over without
 * consuming any of the budget, so the returned instant sits inside — or at the close of — the
 * working interval the budget runs out in. A calendar with no working time at all falls back to
 * plain elapsed arithmetic once the internal bound is hit.
 */
export function addWorkingMs(
  cal: Readonly<WorkingCalendar>,
  start: number,
  workingMs: number,
): number {
  const begin = nextWorkingStart(cal, start);
  if (!(workingMs > 0)) return begin;

  let remaining = workingMs;
  let cur = begin;
  for (let i = 0; i < MAX_SKIPPED_DAYS; i += 1) {
    const count = resolveDay(cal, cur);
    for (let k = 0; k < count; k += 1) {
      const end = scratch[2 * k + 1] as number;
      if (end <= cur) continue;
      const at = Math.max(scratch[2 * k] as number, cur);
      const available = end - at;
      if (remaining <= available) return at + remaining;
      remaining -= available;
    }
    cur = startOfUtcDay(cur) + MS_DAY;
  }
  return start + workingMs;
}

/**
 * The instant `workingMs` milliseconds of working time *before* `end`, used wherever a bound fixes
 * a finish and its start has to follow.
 *
 * For a positive budget this inverts spending the same budget forward exactly. For a budget of
 * zero the two directions differ: stepping back lands on the close of the preceding working
 * stretch, while spending zero forward lands on the opening of the next one. Both denote the same
 * amount of working time — none — but they are different instants when a non-working gap lies
 * between them.
 *
 * `end` is first moved back onto working time. A calendar with no working time at all falls back
 * to plain elapsed arithmetic once the internal bound is hit.
 */
export function subtractWorkingMs(
  cal: Readonly<WorkingCalendar>,
  end: number,
  workingMs: number,
): number {
  const finish = previousWorkingEnd(cal, end);
  if (!(workingMs > 0)) return finish;

  let remaining = workingMs;
  let day = startOfUtcDay(finish);
  let cur = finish;
  for (let i = 0; i < MAX_SKIPPED_DAYS; i += 1) {
    const count = resolveDay(cal, day);
    for (let k = count - 1; k >= 0; k -= 1) {
      const start = scratch[2 * k] as number;
      if (start >= cur) continue;
      const at = Math.min(scratch[2 * k + 1] as number, cur);
      const available = at - start;
      if (remaining <= available) return at - remaining;
      remaining -= available;
    }
    day -= MS_DAY;
    cur = day + MS_DAY;
  }
  return end - workingMs;
}
