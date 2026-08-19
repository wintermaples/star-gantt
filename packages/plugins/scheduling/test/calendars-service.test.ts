/**
 * `CalendarsService` (§1.2) wired end to end through `scheduling({ calendars: {...} })` and the
 * real `@stargantt/plugin-data-store` — `createGantt` from `./_helpers` (READ-only, unmodified).
 *
 * The working-time query section asserts fixed inputs against fixed expected values, answered by
 * the `sdk/time`-backed `CalendarsService` — the acceptance proof for a single working-time
 * implementation.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { GanttInstance } from "@stargantt/core";
import { createGantt, dataOf, task } from "./_helpers";
import type { CalendarsService } from "../src/internal/calendars/service";

const DAY = 86_400_000;
/** 1970-01-05 was a Monday. */
const MON = 4 * DAY;
const HOUR = 3_600_000;
const NINE_TO_FIVE: [number, number][] = [[9 * HOUR, 17 * HOUR]];
const WEEKDAYS = { id: "wd", workingDays: [1, 2, 3, 4, 5] };
const OFFICE = { id: "office", workingDays: [1, 2, 3, 4, 5], workingHours: NINE_TO_FIVE };

let gantt: GanttInstance | undefined;
afterEach(() => {
  gantt?.dispose();
  gantt = undefined;
});

function serviceOf(g: GanttInstance): CalendarsService {
  return g.service("stargantt.calendars");
}

function boot(calendars: readonly unknown[] = [WEEKDAYS, OFFICE]): CalendarsService {
  gantt = createGantt([], { calendars: { calendars: calendars as never } });
  return serviceOf(gantt);
}

/* ------------------------------------------------------------------ *
 * Working-time query equivalence proof
 * ------------------------------------------------------------------ */

describe("nonWorkingRanges", () => {
  it("returns whole days for a calendar without intra-day windows", () => {
    const s = boot();
    expect(s.nonWorkingRanges("wd", MON, MON + 14 * DAY)).toEqual([
      { start: MON + 5 * DAY, end: MON + 7 * DAY },
      { start: MON + 12 * DAY, end: MON + 14 * DAY },
    ]);
  });

  it("merges a holiday exception into the adjacent weekend, whole-day still", () => {
    const s = boot();
    s.define({
      id: "hol",
      workingDays: [1, 2, 3, 4, 5],
      exceptions: [{ date: "1970-01-12", working: false }], // the Monday after the weekend
    });
    expect(s.nonWorkingRanges("hol", MON, MON + 14 * DAY)[0]).toEqual({
      start: MON + 5 * DAY,
      end: MON + 8 * DAY,
    });
  });

  it("adds the intra-day gaps for a calendar that declares working windows", () => {
    const s = boot();
    expect(s.nonWorkingRanges("office", MON, MON + 2 * DAY)).toEqual([
      { start: MON, end: MON + 9 * HOUR },
      { start: MON + 17 * HOUR, end: MON + DAY + 9 * HOUR },
      { start: MON + DAY + 17 * HOUR, end: MON + 2 * DAY },
    ]);
  });

  it("answers empty for an empty, reversed or unresolvable query", () => {
    const s = boot();
    expect(s.nonWorkingRanges("wd", MON, MON)).toEqual([]);
    expect(s.nonWorkingRanges("wd", MON, MON - DAY)).toEqual([]);
    expect(s.nonWorkingRanges("wd", Number.NaN, MON)).toEqual([]);
    expect(s.nonWorkingRanges("missing", MON, MON + 7 * DAY)).toEqual([]);
  });
});

describe("instant-granular members", () => {
  it("distinguishes a working day from a working instant", () => {
    const s = boot();
    expect(s.isWorkingDay("office", MON + 8 * HOUR)).toBe(true);
    expect(s.isWorkingInstant("office", MON + 8 * HOUR)).toBe(false);
    expect(s.isWorkingInstant("office", MON + 9 * HOUR)).toBe(true);
    expect(s.isWorkingInstant("office", MON + 17 * HOUR)).toBe(false); // end exclusive
    expect(s.isWorkingInstant("wd", MON + 8 * HOUR)).toBe(true);
    expect(s.isWorkingInstant("wd", MON + 5 * DAY)).toBe(false); // Saturday
  });

  it("lists working intervals clipped to the query range", () => {
    const s = boot();
    expect(s.workingIntervals("office", MON + 10 * HOUR, MON + DAY + 10 * HOUR)).toEqual([
      { start: MON + 10 * HOUR, end: MON + 17 * HOUR },
      { start: MON + DAY + 9 * HOUR, end: MON + DAY + 10 * HOUR },
    ]);
    expect(s.workingIntervals("missing", MON, MON + DAY)).toEqual([]);
  });

  it("measures working time and walks it in both directions", () => {
    const s = boot();
    expect(s.workingMsBetween("office", MON, MON + DAY)).toBe(8 * HOUR);
    expect(s.workingMsBetween("office", MON + 5 * DAY, MON + 7 * DAY)).toBe(0); // weekend
    expect(s.addWorkingMs("office", MON + 9 * HOUR, 16 * HOUR)).toBe(MON + DAY + 17 * HOUR);
    expect(s.subtractWorkingMs("office", MON + DAY + 17 * HOUR, 16 * HOUR)).toBe(MON + 9 * HOUR);
    const start = MON + 4 * DAY + 9 * HOUR; // Friday 09:00
    const end = s.addWorkingMs("office", start, 12 * HOUR);
    expect(end).toBe(MON + 7 * DAY + 13 * HOUR); // Monday 13:00
    expect(s.workingMsBetween("office", start, end)).toBe(12 * HOUR);
  });

  it("moves an instant to the surrounding working boundaries", () => {
    const s = boot();
    expect(s.nextWorkingStart("office", MON + 8 * HOUR)).toBe(MON + 9 * HOUR);
    expect(s.nextWorkingStart("office", MON + 10 * HOUR)).toBe(MON + 10 * HOUR);
    expect(s.nextWorkingStart("office", MON + 5 * DAY)).toBe(MON + 7 * DAY + 9 * HOUR);
    expect(s.previousWorkingEnd("office", MON + 18 * HOUR)).toBe(MON + 17 * HOUR);
    expect(s.previousWorkingEnd("office", MON + 5 * DAY)).toBe(MON + 4 * DAY + 17 * HOUR);
  });

  it("degrades instead of hanging on a calendar with no working time", () => {
    const s = boot();
    const never = { id: "never", workingDays: [] as number[] };
    expect(s.nextWorkingStart(never, MON)).toBe(MON);
    expect(s.previousWorkingEnd(never, MON)).toBe(MON);
    expect(s.workingMsBetween(never, MON, MON + DAY)).toBe(0);
  });

  it("treats an unresolvable calendar as all working time", () => {
    const s = boot();
    expect(s.isWorkingInstant("missing", MON + 5 * DAY)).toBe(true);
    expect(s.isWorkingInstant(undefined, MON)).toBe(true);
    expect(s.workingMsBetween("missing", MON, MON + 3 * DAY)).toBe(3 * DAY);
    expect(s.workingMsBetween("missing", MON + DAY, MON)).toBe(0);
    expect(s.addWorkingMs("missing", MON, 5 * HOUR)).toBe(MON + 5 * HOUR);
    expect(s.subtractWorkingMs("missing", MON, 5 * HOUR)).toBe(MON - 5 * HOUR);
    expect(s.nextWorkingStart("missing", MON + 5 * DAY)).toBe(MON + 5 * DAY);
    expect(s.previousWorkingEnd("missing", MON + 5 * DAY)).toBe(MON + 5 * DAY);
  });

  it("accepts an inline definition as well as a registry or store id", () => {
    gantt = createGantt([], { calendars: { calendars: [WEEKDAYS, OFFICE] as never } });
    const s = serviceOf(gantt);
    dataOf(gantt).load({ tasks: [], calendars: [{ id: "store", workingDays: [0, 6] }] });
    expect(s.isWorkingInstant({ id: "inline", workingDays: [1] }, MON)).toBe(true);
    expect(s.isWorkingInstant("store", MON)).toBe(false);
    expect(s.isWorkingInstant("store", MON + 5 * DAY)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Registry/resolve/assign, minus DOM (shading/editor covered elsewhere)
 * ------------------------------------------------------------------ */

describe("resolve and effectiveCalendar", () => {
  it("resolves registry calendars over data-store calendars of the same id", () => {
    gantt = createGantt([], { calendars: { calendars: [{ id: "c", workingDays: [1] }] } });
    const s = serviceOf(gantt);
    dataOf(gantt).load({
      tasks: [],
      calendars: [
        { id: "c", workingDays: [1, 2, 3] },
        { id: "store-only", workingDays: [4] },
      ],
    });
    expect(s.resolve("c")?.workingDays).toEqual([1]);
    expect(s.resolve("store-only")?.workingDays).toEqual([4]);
    expect(s.resolve("missing")).toBeUndefined();
    expect(s.resolve(undefined)).toBeUndefined();
  });

  it("uses the default calendar for tasks without one", () => {
    gantt = createGantt([], {
      calendars: { calendars: [{ ...WEEKDAYS, isDefault: true }, { id: "other", workingDays: [0] }] },
    });
    const s = serviceOf(gantt);
    dataOf(gantt).load({
      tasks: [task("t1", MON, MON + DAY), task("t2", MON, MON + DAY, { calendarId: "other" })],
    });
    expect(s.effectiveCalendar("t1")?.id).toBe("wd");
    expect(s.effectiveCalendar("t2")?.id).toBe("other");
    expect(s.effectiveCalendar("missing")).toBeUndefined();
  });
});

describe("task assignment (transactional, undoable)", () => {
  it("assigns and clears through the transactional pipeline", () => {
    gantt = createGantt([], { calendars: { calendars: [WEEKDAYS] } });
    const s = serviceOf(gantt);
    const data = dataOf(gantt);
    data.load({ tasks: [task("t1", MON, MON + DAY)] });
    s.assignTask("t1", "wd");
    expect(data.getTask("t1")?.calendarId).toBe("wd");
    s.assignTask("t1", undefined);
    expect(data.getTask("t1")?.calendarId).toBeUndefined();
    s.assignTask("missing", "wd"); // unknown task — no throw, no change
  });

  it("ignores an unusable calendar id", () => {
    gantt = createGantt([], { calendars: { calendars: [WEEKDAYS] } });
    const s = serviceOf(gantt);
    const data = dataOf(gantt);
    data.load({ tasks: [task("t1", MON, MON + DAY)] });
    s.assignTask("t1", { bad: true } as never);
    expect(data.getTask("t1")?.calendarId).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * §1.2: setShadeCalendar sets the store and announces `calendars/changed`
 * ------------------------------------------------------------------ */

describe("setShadeCalendar (§1.2)", () => {
  it("publishes through `state`", () => {
    const s = boot([{ ...WEEKDAYS, isDefault: true }]);
    const seen: unknown[] = [];
    s.state.subscribe((next) => void seen.push(next.shadeCalendar));
    expect(s.state.get().shadeCalendar).toBe("wd"); // the default, followed live
    s.setShadeCalendar(undefined);
    expect(seen).toEqual([undefined]);
    expect(s.state.get().shadeCalendar).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * §2.2 reflection sanity: a registry-only calendar reaches the engine through the seeded registry
 * (deep engine coverage — oscillation fixes, shadowing — is engine.md's own test suite;
 * this is a light end-to-end wiring check that config.calendars.calendars really reaches it).
 * ------------------------------------------------------------------ */

describe("registry reaches the engine (light wiring check, §2.2)", () => {
  it("propagates a successor off a registry-only non-working day", () => {
    gantt = createGantt(
      [],
      {
        calendars: { calendars: [{ id: "reg", workingDays: [1, 2, 3, 4, 5] }] },
        autoSchedule: { enabled: true },
      },
    );
    const data = dataOf(gantt);
    data.load({
      tasks: [task("a", MON, MON + 4 * DAY), task("b", MON, MON + DAY, { calendarId: "reg" })],
      links: [{ id: "l1", sourceId: "a", targetId: "b", type: "FS" }],
    });
    gantt.dispatch("task/update", { id: "a", after: { start: MON + DAY, end: MON + 5 * DAY } });
    const moved = data.getTask("b");
    expect(moved?.start).toBe(MON + 7 * DAY); // pushed off Saturday to next Monday
    expect(moved?.end).toBe(MON + 8 * DAY); // elapsed duration preserved (day-granular)
  });
});
