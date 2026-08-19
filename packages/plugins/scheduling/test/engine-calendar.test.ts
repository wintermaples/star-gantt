/**
 * docs/specs/plugins/scheduling.md §2.2 — the day-granularity calendar.
 *
 * A calendar that declares no `workingHours` keeps whole-day granularity: an earliest start landing
 * on a non-working day moves to the start of the next working UTC day, and durations stay elapsed.
 * The working-hours granularity is covered by `engine-working-hours.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { nextWorkingTime, previousWorkingDayTime, schedule } from "../src/engine/engine";
import { DAY, link, moves, task, view } from "./_helpers";

const MON = Date.UTC(2024, 0, 1); // 2024-01-01 is a Monday
const FRI = Date.UTC(2024, 0, 5);
const SAT = Date.UTC(2024, 0, 6);
const SUN = Date.UTC(2024, 0, 7);
const NEXT_MON = Date.UTC(2024, 0, 8);
const NEXT_TUE = Date.UTC(2024, 0, 9);

const weekdays = { id: "w", workingDays: [1, 2, 3, 4, 5] };

describe("calendar helpers", () => {
  it("moves a weekend instant to the start of the next working day", () => {
    expect(nextWorkingTime(weekdays, SAT + DAY / 2)).toBe(NEXT_MON);
  });

  it("treats an exception as an override of workingDays", () => {
    const cal = { ...weekdays, exceptions: [{ date: "2024-01-06", working: true }] };
    expect(nextWorkingTime(weekdays, SAT)).toBe(NEXT_MON);
    expect(nextWorkingTime(cal, SAT)).toBe(SAT);
  });

  it("leaves a working instant untouched", () => {
    expect(nextWorkingTime(weekdays, FRI + 3_600_000)).toBe(FRI + 3_600_000);
  });

  it("terminates on a calendar with no working day at all", () => {
    expect(nextWorkingTime({ id: "none", workingDays: [] }, SAT)).toBe(SAT);
  });

  it("is a no-op without a calendar", () => {
    expect(nextWorkingTime(undefined, SAT)).toBe(SAT);
  });
});

describe("previousWorkingDayTime", () => {
  it("walks whole days backward, carrying the time of day", () => {
    // The back-clamp's day-granularity landing: unlike a walk back to the close of a working
    // interval, this keeps the instant's time of day and only crosses whole days.
    expect(previousWorkingDayTime(weekdays, SUN + DAY / 4)).toBe(FRI + DAY / 4);
    expect(previousWorkingDayTime(weekdays, FRI + DAY / 4)).toBe(FRI + DAY / 4);
  });

  it("honours an exception and terminates on an all-non-working calendar", () => {
    const cal = { ...weekdays, exceptions: [{ date: "2024-01-06", working: true }] };
    expect(previousWorkingDayTime(cal, SUN)).toBe(SAT);
    expect(previousWorkingDayTime({ id: "none", workingDays: [] }, SAT)).toBe(SAT);
  });

  it("is a no-op without a calendar", () => {
    expect(previousWorkingDayTime(undefined, SAT)).toBe(SAT);
  });
});

describe("schedule — calendars", () => {
  it("skips the weekend to the next working day", () => {
    const v = view(
      [task("a", FRI, SAT), task("b", 0, DAY, { calendarId: "w" })],
      [link("l1", "a", "b", "FS")],
      [weekdays],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [NEXT_MON, NEXT_MON + DAY] });
  });

  it("snaps to the start of the working day, not to the same time of day", () => {
    const v = view(
      [task("a", FRI, SAT + DAY / 2), task("b", 0, DAY, { calendarId: "w" })],
      [link("l1", "a", "b", "FS")],
      [weekdays],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [NEXT_MON, NEXT_MON + DAY] });
  });

  it("does not snap an instant that already falls on a working day", () => {
    const v = view(
      [task("a", MON, FRI + DAY / 2), task("b", 0, DAY, { calendarId: "w" })],
      [link("l1", "a", "b", "FS")],
      [weekdays],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({
      b: [FRI + DAY / 2, FRI + DAY / 2 + DAY],
    });
  });

  it("honours a working exception on a weekend day", () => {
    const cal = { ...weekdays, exceptions: [{ date: "2024-01-06", working: true }] };
    const v = view(
      [task("a", FRI, SAT), task("b", 0, DAY, { calendarId: "w" })],
      [link("l1", "a", "b", "FS")],
      [cal],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [SAT, SAT + DAY] });
  });

  it("honours a non-working exception on a weekday", () => {
    const cal = { ...weekdays, exceptions: [{ date: "2024-01-08", working: false }] };
    const v = view(
      [task("a", FRI, SAT), task("b", 0, DAY, { calendarId: "w" })],
      [link("l1", "a", "b", "FS")],
      [cal],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [NEXT_TUE, NEXT_TUE + DAY] });
  });

  it("ignores the calendar for a task that declares none", () => {
    const v = view(
      [task("a", FRI, SAT), task("b", 0, DAY)],
      [link("l1", "a", "b", "FS")],
      [weekdays],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [SAT, SAT + DAY] });
  });

  it("ignores an unknown calendarId", () => {
    const v = view(
      [task("a", FRI, SAT), task("b", 0, DAY, { calendarId: "missing" })],
      [link("l1", "a", "b", "FS")],
      [weekdays],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [SAT, SAT + DAY] });
  });

  it("preserves duration as elapsed ms across the skip", () => {
    const v = view(
      [task("a", FRI, SAT), task("b", 0, 3 * DAY, { calendarId: "w" })],
      [link("l1", "a", "b", "FS")],
      [weekdays],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [NEXT_MON, NEXT_MON + 3 * DAY] });
  });
});
