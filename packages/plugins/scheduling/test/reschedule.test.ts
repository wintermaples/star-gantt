// docs/specs/plugins/scheduling.md §2.6 — status-date rescheduling, pure engine half.
import { describe, expect, it } from "vitest";
import type { CalendarDef } from "@stargantt/plugin-data-store";
import { planReschedule, progressOf, rescheduledIds } from "../src/engine/reschedule";
import { DAY, moves, task, view } from "./_helpers";

const rescheduleFrom = (v: Parameters<typeof planReschedule>[0], d: number) =>
  planReschedule(v, d, true).patches;

const HOUR = 3_600_000;

describe("progressOf", () => {
  it("clamps to [0,1] and treats unusable values as zero", () => {
    expect(progressOf(task("a", 0, DAY))).toBe(0);
    expect(progressOf(task("a", 0, DAY, { progress: 0.5 }))).toBe(0.5);
    expect(progressOf(task("a", 0, DAY, { progress: 7 }))).toBe(1);
    expect(progressOf(task("a", 0, DAY, { progress: -1 }))).toBe(0);
    expect(progressOf(task("a", 0, DAY, { progress: Number.NaN }))).toBe(0);
  });
});

describe("rescheduleFrom", () => {
  it("moves an unstarted past task bodily to the status date", () => {
    const v = view([task("a", 0, 2 * DAY)]);
    const patches = rescheduleFrom(v, 5 * DAY);
    expect(moves(patches)).toEqual({ a: [5 * DAY, 7 * DAY] });
    expect(rescheduledIds(patches)).toEqual(new Set(["a"]));
  });

  it("leaves an unstarted task already at or after the status date alone", () => {
    const v = view([task("a", 5 * DAY, 7 * DAY)]);
    expect(rescheduleFrom(v, 5 * DAY)).toEqual([]);
  });

  it("keeps the start of an in-progress task and pushes its end past the status date", () => {
    // 4 days long, half done: 2 days remain, and they must fit after day 10.
    const v = view([task("a", 0, 4 * DAY, { progress: 0.5 })]);
    expect(moves(rescheduleFrom(v, 10 * DAY))).toEqual({ a: [0, 12 * DAY] });
  });

  it("leaves an in-progress task whose remainder already fits after the status date", () => {
    const v = view([task("a", 0, 20 * DAY, { progress: 0.5 })]);
    // 10 days remain; end at day 20 >= status day 2 + 10 days.
    expect(rescheduleFrom(v, 2 * DAY)).toEqual([]);
  });

  it("skips complete, manual and summary tasks", () => {
    const v = view([
      task("done", 0, DAY, { progress: 1 }),
      task("pinned", 0, DAY, { meta: { scheduleMode: "manual" } }),
      task("parent", 0, DAY),
      task("child", 0, DAY, { parentId: "parent", progress: 1 }),
    ]);
    expect(moves(rescheduleFrom(v, 5 * DAY))).toEqual({});
  });

  it("places the remainder on working time against a working-hours calendar", () => {
    // 09:00-17:00 weekdays. Task worked 1970-01-05 (Mon) 09:00-17:00, i.e. 8 working hours, half
    // done. Status date Wed 13:00 → the 4 remaining hours start Wed 13:00 and fit exactly to 17:00.
    const cal: CalendarDef = {
      id: "c",
      workingDays: [1, 2, 3, 4, 5],
      workingHours: [[9 * HOUR, 17 * HOUR]],
    };
    const mon9 = 4 * DAY + 9 * HOUR;
    const mon17 = 4 * DAY + 17 * HOUR;
    const wed13 = 6 * DAY + 13 * HOUR;
    const v = view([task("a", mon9, mon17, { progress: 0.5, calendarId: "c" })], [], [cal]);
    expect(moves(rescheduleFrom(v, wed13))).toEqual({ a: [mon9, 6 * DAY + 17 * HOUR] });
  });

  it("mutates nothing in the view", () => {
    const t = task("a", 0, 2 * DAY);
    rescheduleFrom(view([t]), 5 * DAY);
    expect([t.start, t.end]).toEqual([0, 2 * DAY]);
  });
});

describe("planReschedule", () => {
  it("defers unstarted downstream candidates to the floored propagation", () => {
    const v = view(
      [task("a", 0, 2 * DAY), task("b", 2 * DAY, 3 * DAY)],
      [{ id: "l1", sourceId: "a", targetId: "b", type: "FS" }],
    );
    const plan = planReschedule(v, 5 * DAY, true);
    expect(rescheduledIds(plan.patches)).toEqual(new Set(["a"]));
    expect(plan.floorIds).toEqual(new Set(["b"]));
    expect(plan.floor).toBe(5 * DAY);
  });

  it("patches every candidate directly in a flat (no-propagation) plan", () => {
    const v = view(
      [task("a", 0, 2 * DAY), task("b", 2 * DAY, 3 * DAY)],
      [{ id: "l1", sourceId: "a", targetId: "b", type: "FS" }],
    );
    const plan = planReschedule(v, 5 * DAY, false);
    expect(rescheduledIds(plan.patches)).toEqual(new Set(["a", "b"]));
    expect(plan.floorIds.size).toBe(0);
  });

  it("always patches in-progress candidates directly, even downstream ones", () => {
    const v = view(
      [task("a", 0, 2 * DAY), task("b", 2 * DAY, 6 * DAY, { progress: 0.5 })],
      [{ id: "l1", sourceId: "a", targetId: "b", type: "FS" }],
    );
    const plan = planReschedule(v, 10 * DAY, true);
    expect(rescheduledIds(plan.patches)).toEqual(new Set(["a", "b"]));
    expect(plan.floorIds.size).toBe(0);
  });
});
