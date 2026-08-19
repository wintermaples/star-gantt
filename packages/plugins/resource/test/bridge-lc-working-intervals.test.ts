/**
 * The per-resource working-interval windows of `internal/engine/working-time.ts`
 * (docs/specs/plugins/resource.md §2.3).
 *
 * Notable framing: the cache is keyed by resource id and asked over a half-open `[from, to)`
 * (the shape `EngineResource.workingIntervals` has in §2.1), and it answers with `TimeRange`
 * objects it owns (the SDK's `TimeRange` is the published interval shape — §1.1). What is pinned
 * about the module's OWN business: day-containment, the shared default window, one source call
 * per window, growth that changes no answer, and wholesale invalidation.
 */
import { describe, expect, it } from "vitest";
import { workingIntervals } from "@stargantt/sdk";
import type { TimeRange, WorkingCalendar } from "@stargantt/sdk";
import {
  createWorkingIntervalCache,
  defaultWorkingIntervals,
} from "../src/internal/engine/working-time";
import type { WorkingTimeSource } from "../src/internal/engine/working-time";
import { MONDAY, MS_DAY, MS_HOUR } from "./_engine";

/** The slice as `[start, end]` pairs, so a failure prints instants rather than objects. */
function pairs(list: readonly TimeRange[]): [number, number][] {
  return list.map((r) => [r.start, r.end]);
}

/** One listing of a resource's working time, the shape the pool's own member has. */
type Listing = (from: number, to: number, out: TimeRange[]) => void;

/** The listing the official pool produces for a calendar with no time off. */
const fromCalendar =
  (calendar: Readonly<WorkingCalendar>): Listing =>
  (from, to, out) => {
    workingIntervals(calendar, from, to, out);
  };

/** A mutable one-resource pool stand-in; the cache resolves it per call. */
function source(
  listing: Listing,
  knows = true,
): { value: WorkingTimeSource; listing: Listing; calls: number } {
  const state = {
    listing,
    calls: 0,
    value: undefined as unknown as WorkingTimeSource,
  };
  state.value = {
    knows: () => knows,
    intervalsOf: (_id, from, to, out) => {
      state.calls += 1;
      state.listing(from, to, out);
    },
  };
  return state;
}

const WEEK = 7 * MS_DAY;

describe("the default week (no pool)", () => {
  it("lists Monday to Friday as five whole days", () => {
    expect(pairs(defaultWorkingIntervals(MONDAY, MONDAY + WEEK))).toEqual([
      [MONDAY, MONDAY + MS_DAY],
      [MONDAY + MS_DAY, MONDAY + 2 * MS_DAY],
      [MONDAY + 2 * MS_DAY, MONDAY + 3 * MS_DAY],
      [MONDAY + 3 * MS_DAY, MONDAY + 4 * MS_DAY],
      [MONDAY + 4 * MS_DAY, MONDAY + 5 * MS_DAY],
    ]);
  });

  it("keeps intervals day-contained rather than merging a run of all-day working days", () => {
    const cache = createWorkingIntervalCache(() => undefined);
    const week = cache.intervalsFor("r", MONDAY, MONDAY + WEEK);
    expect(week).toHaveLength(5);
    for (const [start, end] of pairs(week)) expect(end - start).toBe(MS_DAY);
  });

  it("shares one window across every resource the pool does not know", () => {
    const state = source(fromCalendar({ workingDays: [1, 2, 3, 4, 5] }), false);
    const cache = createWorkingIntervalCache(() => state.value);
    const a = pairs(cache.intervalsFor("a", MONDAY, MONDAY + WEEK));
    expect(pairs(cache.intervalsFor("b", MONDAY, MONDAY + WEEK))).toEqual(a);
    // The pool answers `knows: false`, so its listing is never consulted at all.
    expect(state.calls).toBe(0);
    expect(a).toHaveLength(5);
  });

  it("answers an empty listing for a zero-length request", () => {
    const cache = createWorkingIntervalCache(() => undefined);
    expect(cache.intervalsFor("r", MONDAY, MONDAY)).toEqual([]);
  });
});

describe("the pool's own listing (§2.3)", () => {
  it("forwards what the pool lists, intra-day windows and all", () => {
    const state = source(
      fromCalendar({ workingDays: [1, 2, 3, 4, 5], workingHours: [[9 * MS_HOUR, 17 * MS_HOUR]] }),
    );
    const cache = createWorkingIntervalCache(() => state.value);
    expect(pairs(cache.intervalsFor("r", MONDAY, MONDAY + MS_DAY))).toEqual([
      [MONDAY + 9 * MS_HOUR, MONDAY + 17 * MS_HOUR],
    ]);
  });

  it("keeps a listing that splits one day in two, split", () => {
    const state = source((from, to, out) => {
      const day = [
        { start: MONDAY + 9 * MS_HOUR, end: MONDAY + 12 * MS_HOUR },
        { start: MONDAY + 13 * MS_HOUR, end: MONDAY + 17 * MS_HOUR },
      ];
      for (const r of day) if (r.start >= from && r.end <= to) out.push(r);
    });
    const cache = createWorkingIntervalCache(() => state.value);
    expect(pairs(cache.intervalsFor("r", MONDAY, MONDAY + MS_DAY))).toEqual([
      [MONDAY + 9 * MS_HOUR, MONDAY + 12 * MS_HOUR],
      [MONDAY + 13 * MS_HOUR, MONDAY + 17 * MS_HOUR],
    ]);
  });

  it("cuts a range the pool merged across days at every midnight it crosses", () => {
    const state = source((from, to, out) => {
      out.push({ start: Math.max(from, MONDAY), end: Math.min(to, MONDAY + 3 * MS_DAY) });
    });
    const cache = createWorkingIntervalCache(() => state.value);
    expect(pairs(cache.intervalsFor("r", MONDAY, MONDAY + 3 * MS_DAY))).toEqual([
      [MONDAY, MONDAY + MS_DAY],
      [MONDAY + MS_DAY, MONDAY + 2 * MS_DAY],
      [MONDAY + 2 * MS_DAY, MONDAY + 3 * MS_DAY],
    ]);
  });

  it("asks the pool once for the whole window, not once per day", () => {
    const state = source(fromCalendar({ workingDays: [1, 2, 3, 4, 5] }));
    const cache = createWorkingIntervalCache(() => state.value);
    cache.intervalsFor("r", MONDAY, MONDAY + 28 * MS_DAY);
    expect(state.calls).toBe(1);
  });
});

describe("caching (§2.3)", () => {
  it("grows its window forwards without changing the answers already paid for", () => {
    const cache = createWorkingIntervalCache(() => undefined);
    const firstWeek = pairs(cache.intervalsFor("r", MONDAY, MONDAY + WEEK));
    // A wider request that contains the held window: the first week's answers must be identical.
    const fortnight = pairs(cache.intervalsFor("r", MONDAY - WEEK, MONDAY - WEEK + 21 * MS_DAY));
    expect(fortnight.slice(5, 10)).toEqual(firstWeek);
    expect(fortnight).toHaveLength(15);
    // …and asking for the original span again still answers the same.
    expect(pairs(cache.intervalsFor("r", MONDAY, MONDAY + WEEK))).toEqual(firstWeek);
  });

  it("serves the held window rather than re-reading the source", () => {
    const state = source(fromCalendar({ workingDays: [1, 2, 3, 4, 5] }));
    const cache = createWorkingIntervalCache(() => state.value);
    expect(cache.intervalsFor("r", MONDAY, MONDAY + WEEK)).toHaveLength(5);
    // A calendar edit that nothing told the cache about must not be visible…
    state.listing = fromCalendar({ workingDays: [1, 2, 3] });
    expect(cache.intervalsFor("r", MONDAY, MONDAY + WEEK)).toHaveLength(5);
    // …until the wholesale invalidation the pool store's notification triggers.
    cache.invalidate();
    expect(cache.intervalsFor("r", MONDAY, MONDAY + WEEK)).toHaveLength(3);
  });

  it("appends into a caller-supplied array, so the accrual reuses one buffer", () => {
    const cache = createWorkingIntervalCache(() => undefined);
    const out: TimeRange[] = [];
    const returned = cache.intervalsFor("r", MONDAY, MONDAY + 2 * MS_DAY, out);
    expect(returned).toBe(out);
    expect(out).toHaveLength(2);
  });
});
