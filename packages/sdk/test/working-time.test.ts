/**
 * The shared working-time engine (docs/specs/sdk.md, Module: sdk/time): the reconciliation rules
 * between the weekly pattern, intra-day windows and per-date exceptions, and the bounded-walk
 * degradation on a calendar with no working time at all.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKWEEK,
  MS_DAY,
  MS_HOUR,
  addWorkingMs,
  dateKeyToTime,
  hasWorkingHours,
  isDateKey,
  isWorkingDay,
  isWorkingInstant,
  landWorkingEnd,
  nextWorkingStart,
  nonWorkingIntervals,
  previousWorkingEnd,
  startOfUtcDay,
  subtractWorkingMs,
  utcDateKey,
  utcDayOfWeek,
  workingIntervals,
  workingMsBetween,
} from "../src/index";
import type { TimeRange, WorkingCalendar } from "../src/index";

/** 2024-01-01 was a Monday. */
const MON = Date.UTC(2024, 0, 1);
const TUE = MON + MS_DAY;
const WED = MON + 2 * MS_DAY;
const SAT = MON + 5 * MS_DAY;
const SUN = MON + 6 * MS_DAY;

/** Monday–Friday, 09:00–17:00 UTC. */
const OFFICE: WorkingCalendar = {
  workingDays: [1, 2, 3, 4, 5],
  workingHours: [[9 * MS_HOUR, 17 * MS_HOUR]],
};

/** Monday–Friday, 09:00–12:00 and 13:00–17:00 UTC — a lunch break inside the day. */
const SPLIT: WorkingCalendar = {
  workingDays: [1, 2, 3, 4, 5],
  workingHours: [
    [9 * MS_HOUR, 12 * MS_HOUR],
    [13 * MS_HOUR, 17 * MS_HOUR],
  ],
};

function ranges(list: readonly TimeRange[]): [number, number][] {
  return list.map((r) => [r.start, r.end]);
}

describe("day predicate and date-key helpers", () => {
  it("reads the weekly pattern in UTC", () => {
    expect(isWorkingDay(DEFAULT_WORKWEEK, MON)).toBe(true);
    expect(isWorkingDay(DEFAULT_WORKWEEK, SAT)).toBe(false);
    expect(isWorkingDay(DEFAULT_WORKWEEK, SUN)).toBe(false);
    expect(isWorkingDay(DEFAULT_WORKWEEK, MON + 23 * MS_HOUR)).toBe(true);
  });

  it("is total on a non-finite instant", () => {
    expect(isWorkingDay(DEFAULT_WORKWEEK, Number.NaN)).toBe(false);
    expect(isWorkingInstant(DEFAULT_WORKWEEK, Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("agrees with Date about day starts, weekdays and date keys, before and after 1970", () => {
    for (let day = -800; day < 800; day += 1) {
      const t = day * MS_DAY + 5 * MS_HOUR;
      const d = new Date(day * MS_DAY);
      expect(startOfUtcDay(t)).toBe(day * MS_DAY);
      expect(utcDayOfWeek(t)).toBe(d.getUTCDay());
      expect(utcDateKey(t)).toBe(d.toISOString().slice(0, 10));
    }
  });

  it("parses and rejects date keys", () => {
    expect(isDateKey("2024-01-01")).toBe(true);
    expect(isDateKey("2024-1-1")).toBe(false);
    expect(isDateKey(20240101)).toBe(false);
    expect(dateKeyToTime("2024-01-01")).toBe(MON);
    expect(dateKeyToTime("nope")).toBeUndefined();
  });
});

describe("intra-day windows", () => {
  it("treats a working day with no usable window as working for the whole day", () => {
    expect(hasWorkingHours(DEFAULT_WORKWEEK)).toBe(false);
    expect(isWorkingInstant(DEFAULT_WORKWEEK, MON)).toBe(true);
    expect(isWorkingInstant(DEFAULT_WORKWEEK, MON + MS_DAY - 1)).toBe(true);
    expect(ranges(workingIntervals(DEFAULT_WORKWEEK, MON, TUE))).toEqual([[MON, TUE]]);
    expect(workingMsBetween(DEFAULT_WORKWEEK, MON, TUE)).toBe(MS_DAY);
  });

  it("counts a calendar whose every window is unusable as day-granular, not empty", () => {
    const broken: WorkingCalendar = {
      workingDays: [1, 2, 3, 4, 5],
      workingHours: [
        [17 * MS_HOUR, 9 * MS_HOUR],
        [5 * MS_HOUR, 5 * MS_HOUR],
        [Number.NaN, 3 * MS_HOUR],
      ],
    };
    expect(hasWorkingHours(broken)).toBe(false);
    expect(workingMsBetween(broken, MON, TUE)).toBe(MS_DAY);
  });

  it("resolves working intervals inside the day when windows are usable", () => {
    expect(hasWorkingHours(OFFICE)).toBe(true);
    expect(isWorkingInstant(OFFICE, MON + 8 * MS_HOUR)).toBe(false);
    expect(isWorkingInstant(OFFICE, MON + 9 * MS_HOUR)).toBe(true);
    expect(isWorkingInstant(OFFICE, MON + 17 * MS_HOUR)).toBe(false);
    expect(workingMsBetween(OFFICE, MON, TUE)).toBe(8 * MS_HOUR);
  });

  it("clamps a window into its day and drops the ones that then cover nothing", () => {
    const odd: WorkingCalendar = {
      workingDays: [1],
      workingHours: [
        [-5 * MS_HOUR, 2 * MS_HOUR],
        [23 * MS_HOUR, 30 * MS_HOUR],
      ],
    };
    expect(ranges(workingIntervals(odd, MON, TUE))).toEqual([
      [MON, MON + 2 * MS_HOUR],
      [MON + 23 * MS_HOUR, TUE],
    ]);
  });

  it("sorts and merges overlapping or touching windows", () => {
    const messy: WorkingCalendar = {
      workingDays: [1],
      workingHours: [
        [13 * MS_HOUR, 17 * MS_HOUR],
        [9 * MS_HOUR, 11 * MS_HOUR],
        [11 * MS_HOUR, 13 * MS_HOUR],
        [10 * MS_HOUR, 12 * MS_HOUR],
      ],
    };
    expect(ranges(workingIntervals(messy, MON, TUE))).toEqual([
      [MON + 9 * MS_HOUR, MON + 17 * MS_HOUR],
    ]);
  });

  it("hasWorkingHours ignores an absent or unusable calendar", () => {
    expect(hasWorkingHours(undefined)).toBe(false);
    expect(hasWorkingHours({ workingDays: [1] })).toBe(false);
  });
});

describe("exceptions", () => {
  const holiday: WorkingCalendar = {
    ...OFFICE,
    exceptions: [
      { date: "2024-01-01", working: false },
      { date: "2024-01-06", working: true },
      { date: "2024-01-02", working: true, hours: [[10 * MS_HOUR, 12 * MS_HOUR]] },
    ],
  };

  it("overrides the weekly pattern in both directions", () => {
    expect(isWorkingDay(holiday, MON)).toBe(false);
    expect(isWorkingDay(holiday, SAT)).toBe(true);
    expect(workingMsBetween(holiday, MON, TUE)).toBe(0);
  });

  it("lets an exception's hours override the calendar's windows", () => {
    expect(ranges(workingIntervals(holiday, TUE, WED))).toEqual([
      [TUE + 10 * MS_HOUR, TUE + 12 * MS_HOUR],
    ]);
  });

  it("lets a working exception without hours keep the calendar's windows", () => {
    expect(ranges(workingIntervals(holiday, SAT, SAT + MS_DAY))).toEqual([
      [SAT + 9 * MS_HOUR, SAT + 17 * MS_HOUR],
    ]);
  });

  it("makes a working exception whole-day when the calendar has no windows either", () => {
    const cal: WorkingCalendar = {
      workingDays: [1, 2, 3, 4, 5],
      exceptions: [{ date: "2024-01-06", working: true }],
    };
    expect(ranges(workingIntervals(cal, SAT, SUN))).toEqual([[SAT, SUN]]);
  });

  it("drops malformed entries individually and ignores a date no day can equal", () => {
    const cal: WorkingCalendar = {
      workingDays: [1, 2, 3, 4, 5],
      exceptions: [
        { date: "2024-1-1", working: false },
        { date: "2024-02-31", working: false },
        { date: "2024-01-01" } as unknown as { date: string; working: boolean },
        { date: "2024-01-01", working: false },
      ],
    };
    expect(isWorkingDay(cal, MON)).toBe(false);
    expect(isWorkingDay(cal, Date.UTC(2024, 1, 29))).toBe(true);
  });

  it("lets the first entry for a date win", () => {
    const cal: WorkingCalendar = {
      workingDays: [1, 2, 3, 4, 5],
      exceptions: [
        { date: "2024-01-01", working: false },
        { date: "2024-01-01", working: true },
      ],
    };
    expect(isWorkingDay(cal, MON)).toBe(false);
  });
});

describe("interval listings", () => {
  it("clips to the query range and merges across days", () => {
    // Monday noon to Wednesday noon, whole-day calendar: one merged range, clipped at both ends.
    expect(ranges(workingIntervals(DEFAULT_WORKWEEK, MON + 12 * MS_HOUR, WED + 12 * MS_HOUR))).toEqual(
      [[MON + 12 * MS_HOUR, WED + 12 * MS_HOUR]],
    );
  });

  it("keeps the working list ascending, non-overlapping and inside the query", () => {
    const list = workingIntervals(OFFICE, MON - MS_DAY, MON + 9 * MS_DAY);
    let previous = Number.NEGATIVE_INFINITY;
    for (const r of list) {
      expect(r.start).toBeGreaterThanOrEqual(MON - MS_DAY);
      expect(r.end).toBeLessThanOrEqual(MON + 9 * MS_DAY);
      expect(r.start).toBeLessThan(r.end);
      expect(r.start).toBeGreaterThan(previous);
      previous = r.end;
    }
    // Ten days of query, two weekends' worth of days off, and the last day's window falls outside.
    expect(list).toHaveLength(7);
  });

  it("returns the exact complement, intra-day gaps included", () => {
    const from = MON + 8 * MS_HOUR;
    const to = TUE + 10 * MS_HOUR;
    const working = workingIntervals(SPLIT, from, to);
    const off = nonWorkingIntervals(SPLIT, from, to);
    expect(ranges(off)).toEqual([
      [from, MON + 9 * MS_HOUR],
      [MON + 12 * MS_HOUR, MON + 13 * MS_HOUR],
      [MON + 17 * MS_HOUR, TUE + 9 * MS_HOUR],
    ]);
    const covered = [...working, ...off].reduce((sum, r) => sum + (r.end - r.start), 0);
    expect(covered).toBe(to - from);
  });

  it("gives a windowless calendar the whole-day complement", () => {
    expect(ranges(nonWorkingIntervals(DEFAULT_WORKWEEK, MON, MON + 7 * MS_DAY))).toEqual([
      [SAT, SAT + 2 * MS_DAY],
    ]);
  });

  it("returns an empty list for an empty or reversed query", () => {
    expect(workingIntervals(OFFICE, TUE, MON)).toEqual([]);
    expect(nonWorkingIntervals(OFFICE, MON, MON)).toEqual([]);
    expect(workingIntervals(OFFICE, Number.NaN, TUE)).toEqual([]);
  });

  it("appends into the caller's buffer and returns it", () => {
    const buffer: TimeRange[] = [{ start: 0, end: 1 }];
    const returned = workingIntervals(OFFICE, MON, TUE, buffer);
    expect(returned).toBe(buffer);
    expect(ranges(buffer)).toEqual([
      [0, 1],
      [MON + 9 * MS_HOUR, MON + 17 * MS_HOUR],
    ]);

    // A per-frame caller empties the buffer itself; the engine never merges into what was there.
    buffer.length = 0;
    nonWorkingIntervals(OFFICE, MON, TUE, buffer);
    expect(ranges(buffer)).toEqual([
      [MON, MON + 9 * MS_HOUR],
      [MON + 17 * MS_HOUR, TUE],
    ]);
  });
});

describe("measurement and boundaries", () => {
  it("measures only the working part of a span", () => {
    expect(workingMsBetween(OFFICE, MON, MON + 7 * MS_DAY)).toBe(5 * 8 * MS_HOUR);
    expect(workingMsBetween(OFFICE, SAT, SUN + MS_DAY)).toBe(0);
    expect(workingMsBetween(OFFICE, TUE, MON)).toBe(0);
    expect(workingMsBetween(OFFICE, MON + 10 * MS_HOUR, MON + 11 * MS_HOUR)).toBe(MS_HOUR);
  });

  it("moves an instant onto working time, forward and back", () => {
    expect(nextWorkingStart(OFFICE, MON + 10 * MS_HOUR)).toBe(MON + 10 * MS_HOUR);
    expect(nextWorkingStart(OFFICE, MON + 8 * MS_HOUR)).toBe(MON + 9 * MS_HOUR);
    expect(nextWorkingStart(OFFICE, MON + 18 * MS_HOUR)).toBe(TUE + 9 * MS_HOUR);
    expect(nextWorkingStart(OFFICE, SAT)).toBe(SAT + 2 * MS_DAY + 9 * MS_HOUR);

    expect(previousWorkingEnd(OFFICE, MON + 10 * MS_HOUR)).toBe(MON + 10 * MS_HOUR);
    expect(previousWorkingEnd(OFFICE, MON + 18 * MS_HOUR)).toBe(MON + 17 * MS_HOUR);
    expect(previousWorkingEnd(OFFICE, TUE + 8 * MS_HOUR)).toBe(MON + 17 * MS_HOUR);
    expect(previousWorkingEnd(DEFAULT_WORKWEEK, SAT)).toBe(SAT);
  });

  it("lands an end forward, never backwards", () => {
    // An end that already carries work stays where it is — a task finishing at the close of the
    // working day must not be nudged.
    expect(landWorkingEnd(OFFICE, MON + 17 * MS_HOUR)).toBe(MON + 17 * MS_HOUR);
    expect(landWorkingEnd(OFFICE, MON + 10 * MS_HOUR)).toBe(MON + 10 * MS_HOUR);
    expect(landWorkingEnd(SPLIT, MON + 12 * MS_HOUR)).toBe(MON + 12 * MS_HOUR);
    // An end inside a gap moves to the next interval's start, which is the earliest instant at or
    // after it that can close work. `previousWorkingEnd` would answer earlier than the bound.
    expect(landWorkingEnd(OFFICE, MON + 18 * MS_HOUR)).toBe(TUE + 9 * MS_HOUR);
    expect(landWorkingEnd(SPLIT, MON + 12 * MS_HOUR + 30 * 60_000)).toBe(MON + 13 * MS_HOUR);
    expect(landWorkingEnd(OFFICE, SAT + 3 * MS_HOUR)).toBe(SAT + 2 * MS_DAY + 9 * MS_HOUR);
    // Every landing is at or after the instant asked for, which is the property the rule exists for.
    for (const t of [MON, MON + 8 * MS_HOUR, MON + 17 * MS_HOUR, SAT, SUN + 20 * MS_HOUR]) {
      for (const cal of [OFFICE, SPLIT, DEFAULT_WORKWEEK]) {
        expect(landWorkingEnd(cal, t)).toBeGreaterThanOrEqual(t);
      }
    }
  });

  it("spends a budget across non-working stretches without consuming it", () => {
    // Two working days of an eight-hour calendar land at Tuesday's close.
    expect(addWorkingMs(OFFICE, MON + 9 * MS_HOUR, 16 * MS_HOUR)).toBe(TUE + 17 * MS_HOUR);
    // Starting before the window snaps forward first.
    expect(addWorkingMs(OFFICE, MON, 2 * MS_HOUR)).toBe(MON + 11 * MS_HOUR);
    // A lunch break is stepped over.
    expect(addWorkingMs(SPLIT, MON + 11 * MS_HOUR, 2 * MS_HOUR)).toBe(MON + 14 * MS_HOUR);
    // A zero budget is just the boundary move.
    expect(addWorkingMs(OFFICE, SAT, 0)).toBe(SAT + 2 * MS_DAY + 9 * MS_HOUR);

    expect(subtractWorkingMs(OFFICE, TUE + 17 * MS_HOUR, 16 * MS_HOUR)).toBe(MON + 9 * MS_HOUR);
    expect(subtractWorkingMs(SPLIT, MON + 14 * MS_HOUR, 2 * MS_HOUR)).toBe(MON + 11 * MS_HOUR);
    expect(subtractWorkingMs(OFFICE, TUE + 8 * MS_HOUR, 0)).toBe(MON + 17 * MS_HOUR);
  });

  it("round-trips the budget through measurement, and inverts itself", () => {
    const calendars: readonly WorkingCalendar[] = [DEFAULT_WORKWEEK, OFFICE, SPLIT];
    const budgets = [0, MS_HOUR, 3 * MS_HOUR + 17, 8 * MS_HOUR, 37 * MS_HOUR, 200 * MS_HOUR];
    for (const cal of calendars) {
      for (const start of [MON + 9 * MS_HOUR, MON + 10 * MS_HOUR + 30 * 60_000, WED + 13 * MS_HOUR]) {
        const from = nextWorkingStart(cal, start);
        for (const budget of budgets) {
          const end = addWorkingMs(cal, from, budget);
          expect(workingMsBetween(cal, from, end)).toBe(budget);
          // A zero budget is a boundary move, and the two boundaries of one gap differ: the
          // forward one opens the next interval, the backward one closes the previous one — the
          // working time between them is still zero, which is what the inverse claims.
          expect(workingMsBetween(cal, subtractWorkingMs(cal, end, budget), end)).toBe(budget);
          if (budget > 0) expect(subtractWorkingMs(cal, end, budget)).toBe(from);
        }
      }
    }
  });
});

describe("bounded walks", () => {
  const dead: WorkingCalendar = { workingDays: [] };

  it("gives up on an all-non-working calendar instead of hanging or throwing", () => {
    const started = Date.now();
    expect(nextWorkingStart(dead, MON)).toBe(MON);
    expect(previousWorkingEnd(dead, MON)).toBe(MON);
    expect(addWorkingMs(dead, MON, 5 * MS_HOUR)).toBe(MON + 5 * MS_HOUR);
    expect(subtractWorkingMs(dead, MON, 5 * MS_HOUR)).toBe(MON - 5 * MS_HOUR);
    expect(workingMsBetween(dead, MON, MON + 365 * MS_DAY)).toBe(0);
    expect(workingIntervals(dead, MON, MON + 365 * MS_DAY)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("treats an unusable window as day granularity rather than as dead time", () => {
    const shut: WorkingCalendar = { workingDays: [1, 2, 3, 4, 5], workingHours: [[5, 5]] };
    expect(nextWorkingStart(shut, SAT)).toBe(MON + 7 * MS_DAY);
  });

  it("survives a calendar whose shape is not the declared one", () => {
    const junk = { workingDays: undefined } as unknown as WorkingCalendar;
    expect(isWorkingDay(junk, MON)).toBe(false);
    expect(nextWorkingStart(junk, MON)).toBe(MON);
    expect(workingMsBetween(junk, MON, TUE)).toBe(0);
  });

  it("is total on non-finite instants", () => {
    expect(nextWorkingStart(OFFICE, Number.NaN)).toBeNaN();
    expect(previousWorkingEnd(OFFICE, Number.NaN)).toBeNaN();
    expect(workingMsBetween(OFFICE, Number.NaN, TUE)).toBe(0);
  });
});

describe("DEFAULT_WORKWEEK", () => {
  it("is the Monday-to-Friday, all-day calendar", () => {
    expect(DEFAULT_WORKWEEK.workingDays).toEqual([1, 2, 3, 4, 5]);
    expect(DEFAULT_WORKWEEK.workingHours).toBeUndefined();
    expect(Object.isFrozen(DEFAULT_WORKWEEK)).toBe(true);
  });
});
