// docs/specs/plugins/resource.md §2.3 — working time and rosters.
/**
 * Per-resource working intervals, cached across builds.
 *
 * Working intervals come from the surface that OWNS their policy: `ResourcePoolService`'s listing
 * for pool-known resources (defaulting, degradation and time-off subtraction already applied),
 * the shared `sdk/time` `DEFAULT_WORKWEEK` listing for every other resource. Nothing here
 * re-implements calendar arithmetic, and nothing here re-derives pool policy from an entry: every
 * caller asks one owner the same question.
 *
 * Resolving that costs a listing per window, and the resource lanes rebuild their matrix on EVERY
 * frame over the whole visible span, so the answers live in per-resource day windows that survive
 * between frames and grow as the reader scrolls. Only a change in the pool itself may invalidate
 * them, wholesale — a task edit cannot move working time.
 *
 * Intervals are kept DAY-CONTAINED: each is clipped to the UTC day it belongs to even when the
 * source merges a run of all-day working days into one range (the SDK's listing does merge). Day
 * containment is this module's own business — the pool lists the working time it owns, in its
 * natural merged form, and the day boundaries a bucket grid happens to sit on are none of its
 * concern.
 *
 * Unifies the window-cache-plus-day-split approach with a per-day cumulative-millisecond-series
 * approach that answered the same queries — the capability survives here as these interval
 * windows; the other mechanism does not.
 *
 * Headless: no DOM, no service reference.
 */
import { DEFAULT_WORKWEEK, MS_DAY, workingIntervals } from "@stargantt/sdk";
import type { TimeRange } from "@stargantt/sdk";

/**
 * The slice of `ResourcePoolService` the cache needs — resolved per use, never captured at setup,
 * because `optional` does not order plugin start-up (§9's resolution timing).
 */
export interface WorkingTimeSource {
  /** Whether the pool holds an entry for this resource, i.e. whether it owns its working time. */
  knows(id: string | number): boolean;
  /**
   * Appends the resource's working intervals inside `[from, to)` to `out` — clipped, merged,
   * ascending, with the pool's time off already subtracted. The pool's own listing, verbatim.
   */
  intervalsOf(id: string | number, from: number, to: number, out: TimeRange[]): void;
}

/** Per-resource working intervals over growing day windows. */
export interface WorkingIntervalCache {
  /**
   * The resource's working intervals inside the half-open `[from, to)`: clipped to it, merged,
   * ascending and day-contained. Appends into `out` when one is given and returns it; allocates a
   * fresh array otherwise.
   *
   * An unclipped interval is returned as the cache's OWN object — read it during the current
   * build, never retain it and never write to it.
   */
  intervalsFor(id: string | number, from: number, to: number, out?: TimeRange[]): TimeRange[];
  /** Drops every cached answer. Called when the pool's entries, calendars or time off change. */
  invalidate(): void;
}

/**
 * The largest window kept per resource. A reader scrolling a multi-year plan would otherwise grow
 * one buffer per resource without bound; past this size the cache serves the requested span alone
 * and lets the previous window go.
 */
const MAX_WINDOW_DAYS = 4096;

/** The key the default week is cached under; every resource the pool does not know shares it. */
const DEFAULT_KEY = " default";

/** The whole-day index of an instant. */
function dayIndexOf(t: number): number {
  return Math.floor(t / MS_DAY);
}

/**
 * Cuts `ranges` at every midnight they cross, appending the day-contained pieces to `out`.
 *
 * The accrual places a working interval whole in the bucket its start falls in and never splits
 * one, which is sound only while every interval sits inside a single day.
 */
function cutAtDays(ranges: readonly TimeRange[], out: TimeRange[]): void {
  for (const range of ranges) {
    let cursor = range.start;
    while (cursor < range.end) {
      const boundary = (Math.floor(cursor / MS_DAY) + 1) * MS_DAY;
      const end = boundary < range.end ? boundary : range.end;
      out.push({ start: cursor, end });
      cursor = end;
    }
  }
}

/**
 * The shared default-week listing (§2.3): UTC Monday to Friday as whole days, day-contained and
 * clipped to `[from, to)`.
 *
 * This is what every resource the pool does not know works, and what a composition with no pool at
 * all gives every resource — the same result as omitting the resource-pool feature entirely.
 */
export function defaultWorkingIntervals(
  from: number,
  to: number,
  out?: TimeRange[],
): TimeRange[] {
  const list = out ?? [];
  if (!(Number.isFinite(from) && Number.isFinite(to) && to > from)) return list;
  cutAtDays(workingIntervals(DEFAULT_WORKWEEK, from, to, []), list);
  return list;
}

interface Window {
  /** First day index the window covers. */
  from: number;
  /** Number of days it covers. */
  days: number;
  /** Day-contained intervals, ascending and disjoint. */
  ranges: TimeRange[];
  /** `offsets[d]` is the interval index at which day `from + d` ends; length `days + 1`. */
  offsets: Int32Array;
}

/**
 * Who answers for one resource's working time: the pool when it owns the resource, and `undefined`
 * for every resource it does not know — which is then listed from the shared default work week.
 */
interface Owner {
  source: WorkingTimeSource | undefined;
  id: string | number;
}

/** Appends `owner`'s working intervals over `[from, to)` to `out`, before the day cut. */
function listIntervals(owner: Owner, from: number, to: number, out: TimeRange[]): void {
  if (owner.source === undefined) {
    workingIntervals(DEFAULT_WORKWEEK, from, to, out);
    return;
  }
  owner.source.intervalsOf(owner.id, from, to, out);
}

/**
 * Appends the day-contained working intervals of `count` days from `fromDay` into `ranges`,
 * recording each day's end offset in `offsets`.
 *
 * One listing call covers the whole run — never one per day — and the day boundaries are applied
 * here.
 */
function fillDays(
  ranges: TimeRange[],
  offsets: number[],
  owner: Owner,
  fromDay: number,
  count: number,
): void {
  if (count <= 0) return;
  const listed: TimeRange[] = [];
  listIntervals(owner, fromDay * MS_DAY, (fromDay + count) * MS_DAY, listed);
  const pieces: TimeRange[] = [];
  cutAtDays(listed, pieces);
  // The listing is ascending and disjoint, so this cursor only ever moves forward across the whole
  // fill: the walk is linear in the intervals, not quadratic in the days.
  let cursor = 0;
  for (let d = 0; d < count; d += 1) {
    const dayEnd = (fromDay + d + 1) * MS_DAY;
    while (cursor < pieces.length && (pieces[cursor] as TimeRange).start < dayEnd) {
      ranges.push(pieces[cursor] as TimeRange);
      cursor += 1;
    }
    offsets.push(ranges.length);
  }
}

/**
 * Creates the interval cache. `source` is resolved per call, so plugin start order cannot bind it
 * to a stale reference (`optional` is not an ordering edge, so the provider may resolve late).
 */
export function createWorkingIntervalCache(
  source: () => WorkingTimeSource | undefined,
): WorkingIntervalCache {
  const windows = new Map<string, Window>();
  // One reused holder: `intervalsFor` fills it and has finished with it before returning, so
  // resolving a row's owner allocates nothing however many rows and frames go by.
  const owner: Owner = { source: undefined, id: "" };

  /** Builds the window `[from, from + days)`, reusing whatever `held` already covers of it. */
  function build(held: Window | undefined, from: number, days: number): Window {
    const ranges: TimeRange[] = [];
    const offsets: number[] = [0];
    const reusable =
      held !== undefined && held.from >= from && held.from + held.days <= from + days;
    if (reusable) {
      const kept = held;
      fillDays(ranges, offsets, owner, from, kept.from - from);
      // The held answers are copied verbatim: no interval source is asked twice for the same
      // resource and day.
      const base = ranges.length;
      const usable = kept.offsets[kept.days] as number;
      for (let i = 0; i < usable; i += 1) ranges.push(kept.ranges[i] as TimeRange);
      for (let d = 1; d <= kept.days; d += 1) offsets.push((kept.offsets[d] as number) + base);
      const tail = kept.from + kept.days;
      fillDays(ranges, offsets, owner, tail, from + days - tail);
    } else {
      fillDays(ranges, offsets, owner, from, days);
    }
    return { from, days, ranges, offsets: Int32Array.from(offsets) };
  }

  /** The window for `key`, grown to cover `[from, from + days)`. */
  function windowFor(key: string, from: number, days: number): Window {
    const held = windows.get(key);
    if (held !== undefined && from >= held.from && from + days <= held.from + held.days) {
      return held;
    }

    // Grow to the union of what is held and what is asked for, so a reader scrolling forwards keeps
    // every answer already paid for; past the cap, serve the request alone.
    let nextFrom = from;
    let nextTo = from + days;
    if (held !== undefined) {
      const unionFrom = Math.min(held.from, from);
      const unionTo = Math.max(held.from + held.days, from + days);
      if (unionTo - unionFrom <= MAX_WINDOW_DAYS) {
        nextFrom = unionFrom;
        nextTo = unionTo;
      }
    }

    const grown = build(held, nextFrom, nextTo - nextFrom);
    windows.set(key, grown);
    return grown;
  }

  return {
    intervalsFor: (id, from, to, out) => {
      const list = out ?? [];
      if (!(Number.isFinite(from) && Number.isFinite(to) && to > from)) return list;
      const pool = source();
      const known = pool !== undefined && pool.knows(id);
      const key = known ? `r${String(id)}` : DEFAULT_KEY;
      owner.source = known ? pool : undefined;
      owner.id = id;

      const fromDay = dayIndexOf(from);
      const toDay = Math.ceil(to / MS_DAY);
      const held = windowFor(key, fromDay, toDay - fromDay);
      const offset = fromDay - held.from;
      const lo = held.offsets[offset] as number;
      const hi = held.offsets[offset + (toDay - fromDay)] as number;
      for (let k = lo; k < hi; k += 1) {
        const range = held.ranges[k] as TimeRange;
        const start = range.start > from ? range.start : from;
        const end = range.end < to ? range.end : to;
        if (!(end > start)) continue;
        // The held object itself whenever the query does not clip it — no allocation per frame.
        list.push(start === range.start && end === range.end ? range : { start, end });
      }
      return list;
    },
    invalidate: () => windows.clear(),
  };
}
