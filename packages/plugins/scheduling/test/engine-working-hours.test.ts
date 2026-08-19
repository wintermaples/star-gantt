/**
 * docs/specs/plugins/scheduling.md §2.2 — the working-hours model.
 *
 * A task's duration is working time. Against a calendar that declares `workingHours` (milliseconds
 * from UTC midnight), propagation converts between working duration and elapsed time: a task pushed
 * across a non-working stretch lengthens in elapsed terms while preserving its working duration, and
 * every instant it is placed on is a working one. The bounded skip generalizes from days to working
 * intervals. The arithmetic is `sdk/time`'s — this plugin re-implements no calendar arithmetic; what
 * is asserted here is the placement the scheduler builds on it.
 */
import { describe, expect, it } from "vitest";
import {
  addWorkingMs,
  hasWorkingHours,
  previousWorkingEnd,
  subtractWorkingMs,
  workingMsBetween,
} from "@stargantt/sdk";
import { nextWorkingTime, schedule } from "../src/engine/engine";
import { DAY, link, moves, task, view } from "./_helpers";

const H = 3_600_000;
const MON = Date.UTC(2024, 0, 1); // 2024-01-01 is a Monday
const TUE = Date.UTC(2024, 0, 2);
const WED = Date.UTC(2024, 0, 3);
const FRI = Date.UTC(2024, 0, 5);
const SAT = Date.UTC(2024, 0, 6);
const NEXT_MON = Date.UTC(2024, 0, 8);

/** 09:00–17:00 on weekdays: eight working hours a day. Window values are ms from UTC midnight. */
const office = {
  id: "o",
  workingDays: [1, 2, 3, 4, 5],
  workingHours: [[9 * H, 17 * H]] as [number, number][],
};

/** A split day: 09:00–12:00 and 13:00–17:00, i.e. seven hours around a lunch break. */
const split = {
  id: "s",
  workingDays: [1, 2, 3, 4, 5],
  workingHours: [
    [9 * H, 12 * H],
    [13 * H, 17 * H],
  ] as [number, number][],
};

/** Working hours declared, but no day they apply to — the all-non-working calendar. */
const nothing = { id: "n", workingDays: [], workingHours: [[9 * H, 17 * H]] as [number, number][] };

describe("calendar — working-hours granularity", () => {
  it("switches granularity on the presence of usable workingHours", () => {
    expect(hasWorkingHours(office)).toBe(true);
    expect(hasWorkingHours({ workingDays: [1] })).toBe(false);
    expect(hasWorkingHours({ workingDays: [1], workingHours: [] })).toBe(false);
    // A calendar whose every window covers nothing is day-granular, not a working-hours calendar
    // with no working time: the shared engine's "usable window" test decides granularity.
    expect(hasWorkingHours({ workingDays: [1], workingHours: [[12 * H, 12 * H]] })).toBe(false);
    expect(hasWorkingHours(undefined)).toBe(false);
  });

  it("resolves the day's windows as absolute instants", () => {
    expect(nextWorkingTime(office, MON + 3 * H)).toBe(MON + 9 * H);
    expect(workingMsBetween(office, MON, MON + DAY)).toBe(8 * H);
    expect(workingMsBetween(office, SAT, SAT + DAY)).toBe(0);
  });

  it("merges overlapping ranges and drops empty ones", () => {
    const messy = {
      id: "m",
      workingDays: [1],
      workingHours: [
        [10 * H, 11 * H],
        [9 * H, 10 * H + 20 * 60_000],
        [11 * H + 40 * 60_000, 11 * H + 40 * 60_000],
      ] as [number, number][],
    };
    // 09:00–11:00 once merged, and the empty window contributes nothing.
    expect(nextWorkingTime(messy, MON)).toBe(MON + 9 * H);
    expect(workingMsBetween(messy, MON, MON + DAY)).toBe(2 * H);
    expect(nextWorkingTime(messy, MON + 11 * H)).toBe(NEXT_MON + 9 * H);
  });

  it("lets an exception's own hours win over the calendar's", () => {
    const cal = {
      ...office,
      exceptions: [
        { date: "2024-01-06", working: true, hours: [[10 * H, 12 * H]] as [number, number][] },
      ],
    };
    expect(nextWorkingTime(cal, SAT)).toBe(SAT + 10 * H);
    expect(workingMsBetween(cal, SAT, SAT + DAY)).toBe(2 * H);
  });

  it("gives a working exception without hours the calendar's ranges", () => {
    const cal = { ...office, exceptions: [{ date: "2024-01-06", working: true }] };
    expect(nextWorkingTime(cal, SAT)).toBe(SAT + 9 * H);
    expect(workingMsBetween(cal, SAT, SAT + DAY)).toBe(8 * H);
  });

  it("moves a non-working instant to the start of the next working interval", () => {
    expect(nextWorkingTime(office, MON + 7 * H)).toBe(MON + 9 * H);
    expect(nextWorkingTime(office, MON + 18 * H)).toBe(TUE + 9 * H);
    expect(nextWorkingTime(office, SAT + 10 * H)).toBe(NEXT_MON + 9 * H);
  });

  it("leaves an instant inside a working interval alone", () => {
    expect(nextWorkingTime(office, MON + 12 * H)).toBe(MON + 12 * H);
  });

  it("treats the close of an interval as non-working for a start", () => {
    expect(nextWorkingTime(split, MON + 12 * H)).toBe(MON + 13 * H);
  });

  it("walks back to the close of a working interval for an end", () => {
    expect(previousWorkingEnd(office, MON + 20 * H)).toBe(MON + 17 * H);
    expect(previousWorkingEnd(office, TUE)).toBe(MON + 17 * H);
    expect(previousWorkingEnd(office, MON + 17 * H)).toBe(MON + 17 * H);
    expect(previousWorkingEnd(office, MON + 12 * H)).toBe(MON + 12 * H);
  });

  it("measures working time, ignoring nights and weekends", () => {
    expect(workingMsBetween(office, MON + 9 * H, MON + 13 * H)).toBe(4 * H);
    expect(workingMsBetween(office, MON, TUE)).toBe(8 * H);
    expect(workingMsBetween(office, FRI + 9 * H, NEXT_MON + 12 * H)).toBe(11 * H);
    expect(workingMsBetween(office, SAT, SAT + DAY)).toBe(0);
    expect(workingMsBetween(office, MON + 13 * H, MON + 9 * H)).toBe(0);
  });

  it("skips the lunch break when measuring", () => {
    expect(workingMsBetween(split, MON + 11 * H, MON + 14 * H)).toBe(2 * H);
  });

  it("spends working time forward across a night", () => {
    // Four working hours starting at 16:00 end at noon the next day.
    expect(addWorkingMs(office, MON + 16 * H, 4 * H)).toBe(TUE + 12 * H);
  });

  it("spends working time forward across a weekend", () => {
    expect(addWorkingMs(office, FRI + 16 * H, 4 * H)).toBe(NEXT_MON + 12 * H);
  });

  it("moves a non-working start onto working time before spending anything", () => {
    expect(addWorkingMs(office, SAT, H)).toBe(NEXT_MON + 10 * H);
    expect(addWorkingMs(office, MON, 0)).toBe(MON + 9 * H);
  });

  it("stops exactly at the close of business when the budget runs out there", () => {
    expect(addWorkingMs(office, MON + 9 * H, 8 * H)).toBe(MON + 17 * H);
  });

  it("subtracts working time as the exact inverse", () => {
    expect(subtractWorkingMs(office, TUE + 12 * H, 4 * H)).toBe(MON + 16 * H);
    expect(subtractWorkingMs(office, NEXT_MON + 12 * H, 4 * H)).toBe(FRI + 16 * H);
    expect(subtractWorkingMs(office, MON + 17 * H, 8 * H)).toBe(MON + 9 * H);
  });

  it("moves a non-working end back onto working time first", () => {
    expect(subtractWorkingMs(office, MON + 22 * H, H)).toBe(MON + 16 * H);
    expect(subtractWorkingMs(office, MON + 20 * H, 0)).toBe(MON + 17 * H);
  });

  it("round-trips a working duration in both directions", () => {
    for (const start of [MON + 9 * H, MON + 15 * H, WED + 10 * H, FRI + 16 * H]) {
      for (const working of [H, 5 * H, 8 * H, 30 * H]) {
        const end = addWorkingMs(office, start, working);
        expect(workingMsBetween(office, start, end)).toBe(working);
        expect(subtractWorkingMs(office, end, working)).toBe(start);
      }
    }
  });

  it("reads a zero-length span from the near side of the boundary it sits on", () => {
    // A zero-length span at the very start of a working interval is also the very end of the
    // previous one, so the two directions legitimately name different instants for it.
    expect(addWorkingMs(office, MON + 9 * H, 0)).toBe(MON + 9 * H);
    expect(subtractWorkingMs(office, MON + 9 * H, 0)).toBe(Date.UTC(2023, 11, 29) + 17 * H);
    expect(addWorkingMs(office, MON + 12 * H, 0)).toBe(MON + 12 * H);
    expect(subtractWorkingMs(office, MON + 12 * H, 0)).toBe(MON + 12 * H);
  });

  it("round-trips across a split day too", () => {
    const start = MON + 11 * H;
    const end = addWorkingMs(split, start, 4 * H);
    expect(end).toBe(MON + 16 * H);
    expect(subtractWorkingMs(split, end, 4 * H)).toBe(start);
  });
});

describe("calendar — all-non-working bound", () => {
  it("returns the unmodified instant instead of looping", () => {
    expect(nextWorkingTime(nothing, MON + 10 * H)).toBe(MON + 10 * H);
    expect(previousWorkingEnd(nothing, MON + 10 * H)).toBe(MON + 10 * H);
  });

  it("falls back to elapsed arithmetic for the conversions", () => {
    expect(addWorkingMs(nothing, MON, 3 * H)).toBe(MON + 3 * H);
    expect(subtractWorkingMs(nothing, MON + 5 * H, 3 * H)).toBe(MON + 2 * H);
    expect(workingMsBetween(nothing, MON, TUE)).toBe(0);
  });

  it("schedules normally and never throws", () => {
    const v = view(
      [task("a", MON, MON + 10 * H), task("b", MON, MON + 4 * H, { calendarId: "n" })],
      [link("l1", "a", "b", "FS")],
      [nothing],
    );
    // The measured working duration is zero, so the successor is placed on the unmodified instant
    // its predecessor hands it — a data error made visible in the result, not a failure.
    expect(() => schedule(v, new Set(["a"]))).not.toThrow();
    expect(moves(schedule(v, new Set(["a"])))).toEqual({
      b: [MON + 10 * H, MON + 10 * H],
    });
  });
});

describe("schedule — working hours", () => {
  it("lengthens a task in elapsed terms while preserving its working duration", () => {
    const v = view(
      [
        task("a", MON + 9 * H, MON + 16 * H),
        task("b", MON + 9 * H, MON + 13 * H, { calendarId: "o" }),
      ],
      [link("l1", "a", "b", "FS")],
      [office],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({
      b: [MON + 16 * H, TUE + 12 * H],
    });
  });

  it("carries a task over the weekend without losing work", () => {
    const v = view(
      [
        task("a", FRI + 9 * H, FRI + 16 * H),
        task("b", MON + 9 * H, MON + 13 * H, { calendarId: "o" }),
      ],
      [link("l1", "a", "b", "FS")],
      [office],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({
      b: [FRI + 16 * H, NEXT_MON + 12 * H],
    });
  });

  it("starts the successor at the next working interval when the predecessor ends off-hours", () => {
    const v = view(
      [
        task("a", MON + 9 * H, MON + 20 * H),
        task("b", MON + 9 * H, MON + 11 * H, { calendarId: "o" }),
      ],
      [link("l1", "a", "b", "FS")],
      [office],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({
      b: [TUE + 9 * H, TUE + 11 * H],
    });
  });

  it("steps over the lunch break", () => {
    const v = view(
      [
        task("a", MON + 9 * H, MON + 11 * H),
        task("b", MON + 9 * H, MON + 11 * H, { calendarId: "s" }),
      ],
      [link("l1", "a", "b", "FS")],
      [split],
    );
    // Two working hours from 11:00 spend one hour before lunch and one after it.
    expect(moves(schedule(v, new Set(["a"])))).toEqual({
      b: [MON + 11 * H, MON + 14 * H],
    });
  });

  it("derives the start from the end for an FF link", () => {
    const v = view(
      [
        task("a", MON + 9 * H, TUE + 12 * H),
        task("b", MON + 9 * H, MON + 13 * H, { calendarId: "o" }),
      ],
      [link("l1", "a", "b", "FF")],
      [office],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({
      b: [MON + 16 * H, TUE + 12 * H],
    });
  });

  it("counts lag as elapsed time, not as work", () => {
    const v = view(
      [
        task("a", MON + 9 * H, MON + 12 * H),
        task("b", MON + 9 * H, MON + 10 * H, { calendarId: "o" }),
      ],
      [link("l1", "a", "b", "FS", 2 * H)],
      [office],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({
      b: [MON + 14 * H, MON + 15 * H],
    });
  });

  it("honours a SNET date by snapping it onto working time", () => {
    const v = view(
      [
        task("a", MON + 9 * H, MON + 10 * H),
        task("b", MON + 9 * H, MON + 11 * H, {
          calendarId: "o",
          constraint: { type: "SNET", date: TUE + 7 * H },
        }),
      ],
      [link("l1", "a", "b", "FS")],
      [office],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({
      b: [TUE + 9 * H, TUE + 11 * H],
    });
  });

  it("rolls a summary up over its working-hours children unchanged", () => {
    const v = view(
      [
        task("p", 0, 0),
        task("a", MON + 9 * H, MON + 16 * H, { parentId: "p" }),
        task("b", MON + 9 * H, MON + 13 * H, { parentId: "p", calendarId: "o" }),
      ],
      [link("l1", "a", "b", "FS")],
      [office],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({
      b: [MON + 16 * H, TUE + 12 * H],
      p: [MON + 9 * H, TUE + 12 * H],
    });
  });

  it("treats a calendar whose every window is unusable as day-granular", () => {
    // A window that covers nothing once clamped into the day leaves the calendar with no usable
    // window at all, so it schedules exactly as one declaring no `workingHours` does: whole-day
    // skips and an elapsed duration.
    const unusable = {
      id: "u",
      workingDays: [1, 2, 3, 4, 5],
      workingHours: [[12 * H, 12 * H]] as [number, number][],
    };
    const v = view(
      [task("a", FRI, SAT), task("b", 0, DAY, { calendarId: "u" })],
      [link("l1", "a", "b", "FS")],
      [unusable],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [NEXT_MON, NEXT_MON + DAY] });
  });

  it("keeps a zero-duration milestone at a single working instant", () => {
    const v = view(
      [
        task("a", MON + 9 * H, MON + 16 * H),
        task("m", MON + 9 * H, MON + 9 * H, { calendarId: "o" }),
      ],
      [link("l1", "a", "m", "FS")],
      [office],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({
      m: [MON + 16 * H, MON + 16 * H],
    });
  });
});
