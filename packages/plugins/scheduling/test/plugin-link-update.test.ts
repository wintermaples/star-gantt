// docs/specs/plugins/scheduling.md §2.1 — a `link/update` (retype / re-lag) is classified exactly
// as a fresh edge.
import { afterEach, describe, expect, it } from "vitest";
import type { GanttInstance } from "@stargantt/core";
import type { SchedulingConfig } from "../src/index";
import { DAY, createGantt, dataOf, links, recordTransactions, times } from "./_helpers";

let gantt: GanttInstance | undefined;

afterEach(() => {
  gantt?.dispose();
  gantt = undefined;
});

/** a(0..1d) → b(1d..2d) over one FS link; returns the chart, its data and the link id. */
function chain() {
  const g = createGantt();
  gantt = g;
  const data = dataOf(g);
  data.load([
    { id: "a", parentId: null, name: "a", start: 0, end: 1 * DAY },
    { id: "b", parentId: null, name: "b", start: 1 * DAY, end: 2 * DAY },
  ]);
  g.dispatch("link/add", { sourceId: "a", targetId: "b", type: "FS" });
  const linkId = links(data)[0]?.id ?? "";
  return { g, data, linkId };
}

describe("link/update repropagation", () => {
  it("moves the target when the link is retyped", () => {
    const { g, data, linkId } = chain();
    expect(times(data)["b"]).toEqual([1 * DAY, 2 * DAY]);

    // FS → SS: b now starts with a rather than after it.
    g.dispatch("link/update", { id: linkId, type: "SS" });
    expect(times(data)["b"]).toEqual([0, 1 * DAY]);
  });

  it("moves the target when the lag changes", () => {
    const { g, data, linkId } = chain();

    g.dispatch("link/update", { id: linkId, lag: 2 * DAY });
    expect(times(data)["b"]).toEqual([3 * DAY, 4 * DAY]);

    // Dropping the lag pulls the target back to the plain FS position.
    g.dispatch("link/update", { id: linkId, lag: 0 });
    expect(times(data)["b"]).toEqual([1 * DAY, 2 * DAY]);
  });

  it("cascades to the target's own successors, in the same transaction", () => {
    const g = createGantt();
    gantt = g;
    const data = dataOf(g);
    data.load([
      { id: "a", parentId: null, name: "a", start: 0, end: 1 * DAY },
      { id: "b", parentId: null, name: "b", start: 1 * DAY, end: 2 * DAY },
      { id: "c", parentId: null, name: "c", start: 2 * DAY, end: 3 * DAY },
    ]);
    g.dispatch("link/add", { sourceId: "a", targetId: "b", type: "FS" });
    g.dispatch("link/add", { sourceId: "b", targetId: "c", type: "FS" });

    const linkId = links(data).find((l) => l.targetId === "b")?.id ?? "";
    const settled = recordTransactions(g);
    g.dispatch("link/update", { id: linkId, lag: 2 * DAY });

    expect(times(data)["b"]).toEqual([3 * DAY, 4 * DAY]);
    expect(times(data)["c"]).toEqual([4 * DAY, 5 * DAY]);
    expect(settled).toHaveLength(1);
  });

  it("leaves the target alone while propagation is disabled", () => {
    const g = createGantt([], { autoSchedule: { enabled: false } });
    gantt = g;
    const data = dataOf(g);
    data.load([
      { id: "a", parentId: null, name: "a", start: 0, end: 1 * DAY },
      { id: "b", parentId: null, name: "b", start: 1 * DAY, end: 2 * DAY },
    ]);
    g.dispatch("link/add", { sourceId: "a", targetId: "b", type: "FS" });
    const linkId = links(data)[0]?.id ?? "";

    g.dispatch("link/update", { id: linkId, lag: 5 * DAY });
    expect(times(data)["b"]).toEqual([1 * DAY, 2 * DAY]);
  });
});

// docs/specs/plugins/scheduling.md §1.1 / §4.2 — the propagation predicate a co-composed
// reconciler consults.
describe("propagationEnabled()", () => {
  it("reports the composed propagation setting", () => {
    const on = createGantt([], { autoSchedule: { enabled: true } });
    expect(on.service("stargantt.scheduler").propagationEnabled()).toBe(true);
    on.dispose();

    const off = createGantt([], { autoSchedule: { enabled: false } });
    expect(off.service("stargantt.scheduler").propagationEnabled()).toBe(false);
    off.dispose();
  });

  // §11.2 — propagation is opt-in, so a chart that composes the plugin and says nothing else moves
  // only what the user edited. `{}` is the library default here; the harness's own default opts in
  // (see `createGantt`).
  it("is off when the option is omitted, and an unusable value leaves it off", () => {
    const omitted = createGantt([], {});
    expect(omitted.service("stargantt.scheduler").propagationEnabled()).toBe(false);
    omitted.dispose();

    const unusable = createGantt([], {
      autoSchedule: { enabled: "yes" },
    } as unknown as SchedulingConfig);
    expect(unusable.service("stargantt.scheduler").propagationEnabled()).toBe(false);
    unusable.dispose();
  });

  it("propagates nothing and still refuses a cycle when the option is omitted", () => {
    const g = createGantt([], {});
    const data = dataOf(g);
    data.load([
      { id: "a", parentId: null, name: "a", start: 0, end: 1 * DAY },
      { id: "b", parentId: null, name: "b", start: 1 * DAY, end: 2 * DAY },
      { id: "l", sourceId: "a", targetId: "b", type: "FS" },
    ]);
    g.dispatch("task/update", { id: "a", after: { end: 5 * DAY } });
    expect(times(data)["b"]).toEqual([1 * DAY, 2 * DAY]);
    // Cycle rejection is a validity guard on the data, not a schedule derivation, so it survives.
    g.dispatch("link/add", { id: "back", sourceId: "b", targetId: "a", type: "FS" });
    expect(links(data)).toHaveLength(1);
    g.dispose();
  });

  it("schedules nothing of its own when read", () => {
    const g = createGantt();
    gantt = g;
    const data = dataOf(g);
    data.load([
      { id: "a", parentId: null, name: "a", start: 0, end: 1 * DAY },
      { id: "b", parentId: null, name: "b", start: 5 * DAY, end: 6 * DAY },
    ]);
    const settled = recordTransactions(g);
    expect(g.service("stargantt.scheduler").propagationEnabled()).toBe(true);
    expect(settled).toHaveLength(0);
    expect(times(data)["b"]).toEqual([5 * DAY, 6 * DAY]);
  });
});
