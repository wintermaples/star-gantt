import { afterEach, describe, expect, it } from "vitest";
import type { GanttInstance } from "@stargantt/core";
import { DAY, createGantt, dataOf, times } from "./_helpers";

let gantt: GanttInstance | undefined;

afterEach(() => {
  gantt?.dispose();
  gantt = undefined;
});

describe("link/remove repropagation", () => {
  it("repropagates a freed target from its remaining predecessor", () => {
    const g = createGantt();
    gantt = g;
    const data = dataOf(g);
    // c(0..1d) and a(10d..11d) both feed b. b sits at a.end = 11d.
    data.load([
      { id: "a", parentId: null, name: "a", start: 10 * DAY, end: 11 * DAY },
      { id: "c", parentId: null, name: "c", start: 0, end: 1 * DAY },
      { id: "b", parentId: null, name: "b", start: 11 * DAY, end: 12 * DAY },
    ]);
    g.dispatch("link/add", { sourceId: "c", targetId: "b", type: "FS" });
    g.dispatch("link/add", { sourceId: "a", targetId: "b", type: "FS" });
    expect(times(data)["b"]).toEqual([11 * DAY, 12 * DAY]);

    // Removing `a` emits link/remove for a→b. b must fall back to c.end = 1d.
    g.dispatch("task/remove", { ids: ["a"] });
    expect(times(data)["b"]).toEqual([1 * DAY, 2 * DAY]);
  });

  it("keeps its times when the target loses every predecessor", () => {
    const g = createGantt();
    gantt = g;
    const data = dataOf(g);
    data.load([
      { id: "a", parentId: null, name: "a", start: 10 * DAY, end: 11 * DAY },
      { id: "b", parentId: null, name: "b", start: 11 * DAY, end: 12 * DAY },
    ]);
    g.dispatch("link/add", { sourceId: "a", targetId: "b", type: "FS" });
    g.dispatch("task/remove", { ids: ["a"] });
    expect(times(data)["b"]).toEqual([11 * DAY, 12 * DAY]);
  });
});
