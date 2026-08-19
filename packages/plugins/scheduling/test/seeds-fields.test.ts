/**
 * Which edits start propagation — docs/specs/plugins/scheduling.md §2.1 ("What seeds it").
 *
 * The seed table classifies by patch content, not by op alone: a progress drag, a rename, another
 * plugin's `meta` write and a write-back that changes nothing all propagate nothing. The assertions
 * below are about the seed set itself (the unit the classification lives in) and about the
 * store-level consequence a user actually sees.
 */
import { describe, expect, it } from "vitest";
import { collectSeeds } from "../src/engine/seeds";
import type { Patch, TaskId } from "@stargantt/plugin-data-store";
import { DAY, createGantt, dataOf, link, task, times } from "./_helpers";

/** The seeds one patch contributes, as a sorted array of strings. */
function seedsOf(patch: Patch): string[] {
  const into = new Set<TaskId>();
  collectSeeds(patch, into);
  return [...into].map(String).sort();
}

const base = { op: "task/update", id: "b" } as const;

describe("task/update seeds", () => {
  it("seeds on a date change", () => {
    expect(
      seedsOf({ ...base, before: { start: 0, end: DAY }, after: { start: DAY, end: 2 * DAY } }),
    ).toEqual(["b"]);
  });

  it("seeds the old and the new parent on a re-parent", () => {
    expect(seedsOf({ ...base, before: { parentId: "p1" }, after: { parentId: "p2" } })).toEqual([
      "b",
      "p1",
      "p2",
    ]);
  });

  it("seeds on a constraint change, and not on an equal constraint re-sent", () => {
    expect(
      seedsOf({
        ...base,
        before: { constraint: { type: "SNET", date: 0 } },
        after: { constraint: { type: "SNET", date: DAY } },
      }),
    ).toEqual(["b"]);
    expect(
      seedsOf({
        ...base,
        before: { constraint: { type: "SNET", date: DAY } },
        after: { constraint: { type: "SNET", date: DAY } },
      }),
    ).toEqual([]);
  });

  it("seeds on a calendar change and on a cleared scheduling field", () => {
    expect(seedsOf({ ...base, before: { calendarId: "a" }, after: { calendarId: "b" } })).toEqual([
      "b",
    ]);
    expect(seedsOf({ ...base, before: {}, after: {}, clears: ["calendarId"] })).toEqual(["b"]);
    expect(seedsOf({ ...base, before: {}, after: {}, clears: ["meta"] })).toEqual(["b"]);
  });

  it("seeds when the schedule mode flips", () => {
    expect(
      seedsOf({ ...base, before: { meta: {} }, after: { meta: { scheduleMode: "manual" } } }),
    ).toEqual(["b"]);
  });

  it("seeds nothing for progress, name, other meta keys or a no-op", () => {
    expect(seedsOf({ ...base, before: { progress: 0.1 }, after: { progress: 0.9 } })).toEqual([]);
    expect(seedsOf({ ...base, before: { name: "old" }, after: { name: "new" } })).toEqual([]);
    expect(
      seedsOf({
        ...base,
        before: { meta: { work: 1, scheduleMode: "manual" } },
        after: { meta: { work: 2, scheduleMode: "manual" } },
      }),
    ).toEqual([]);
    expect(
      seedsOf({
        ...base,
        before: { start: DAY, end: 2 * DAY },
        after: { start: DAY, end: 2 * DAY },
      }),
    ).toEqual([]);
  });
});

describe("propagation through the store", () => {
  /** Two tasks on an `FS` link, propagation on. */
  function boot() {
    const gantt = createGantt();
    const data = dataOf(gantt);
    data.load({
      tasks: [task("a", 0, 2 * DAY), task("b", 2 * DAY, 4 * DAY)],
      links: [link("l1", "a", "b", "FS")],
    });
    return { gantt, data };
  }

  it("moves the successor when the predecessor's dates move", () => {
    const { gantt, data } = boot();
    gantt.dispatch("task/move", { id: "a", start: DAY, end: 3 * DAY });
    expect(times(data)["b"]).toEqual([3 * DAY, 5 * DAY]);
    gantt.dispose();
  });

  it("moves nothing when only progress changes", () => {
    const { gantt, data } = boot();
    const before = times(data);
    gantt.dispatch("task/setProgress", { id: "a", progress: 0.5 });
    expect(times(data)).toEqual(before);
    gantt.dispose();
  });

  it("moves nothing when a task/update re-sends the dates it already has", () => {
    const { gantt, data } = boot();
    const before = times(data);
    gantt.dispatch("task/update", { id: "a", after: { start: 0, end: 2 * DAY, name: "renamed" } });
    expect(times(data)).toEqual(before);
    gantt.dispose();
  });
});
