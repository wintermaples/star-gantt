/**
 * The plugin wiring: service registration, the `data/willApplyTransaction` hook that appends
 * follow-on patches into the *same* transaction, and cycle rejection.
 *
 * Everything here runs in plain node against a `{}` "root element" — the plugin must never touch
 * the DOM (docs/specs/plugins/scheduling.md §2: "the engine is headless").
 */
import type { GanttInstance } from "@stargantt/core";
import type { LinkId, Transaction } from "@stargantt/plugin-data-store";
import { afterEach, describe, expect, it } from "vitest";
import { scheduling } from "../src/index";
import type { SchedulingConfig } from "../src/index";
import { createGantt, dataOf, links, recordTransactions, times } from "./_helpers";

let gantt: GanttInstance | undefined;

function boot(raw: unknown[], config?: SchedulingConfig): GanttInstance {
  gantt = createGantt([], config);
  dataOf(gantt).load(raw);
  return gantt;
}

afterEach(() => {
  gantt?.dispose();
  gantt = undefined;
});

const CHAIN = [
  { id: "a", name: "A", start: 0, end: 10 },
  { id: "b", name: "B", start: 10, end: 15 },
  { id: "L1", sourceId: "a", targetId: "b", type: "FS" },
];

describe("scheduling — factory form", () => {
  it("is a factory whose plugin carries the spec id and dependency", () => {
    expect(typeof scheduling).toBe("function");
    const plugin = scheduling();
    expect(plugin.meta.id).toBe("stargantt.scheduling");
    expect(plugin.meta.dependsOn).toEqual(["stargantt.data-store"]);
  });

  it("builds an independent plugin value per call", () => {
    expect(scheduling()).not.toBe(scheduling());
  });

  it("accepts an omitted config and an empty one alike", () => {
    expect(scheduling({}).meta.id).toBe(scheduling().meta.id);
  });
});

describe("scheduling — registration", () => {
  it("provides stargantt.scheduler with all seven members", () => {
    const g = boot([]);
    const scheduler = g.service("stargantt.scheduler");
    for (const member of [
      "schedule",
      "scheduleAsync",
      "latestTimes",
      "detectCycle",
      "previewReschedule",
      "taskScheduleMode",
      "propagationEnabled",
    ] as const) {
      expect(typeof scheduler[member]).toBe("function");
    }
    expect(Object.keys(scheduler)).toHaveLength(7);
  });

  it("exposes the engine against the live store view", () => {
    const g = boot(CHAIN);
    const scheduler = g.service("stargantt.scheduler");
    const view = dataOf(g).query();
    expect(scheduler.latestTimes(view).get("a")).toEqual({ latestStart: 0, latestFinish: 10 });
    expect(scheduler.schedule(view, new Set(["a"]))).toEqual([]);
  });
});

describe("scheduling — willApplyTransaction", () => {
  it("moves the dependent task when its predecessor moves", () => {
    const g = boot(CHAIN);
    g.dispatch("task/move", { id: "a", start: 100, end: 110 });
    expect(times(dataOf(g))).toEqual({ a: [100, 110], b: [110, 115] });
  });

  it("appends the follow-on patch to the very same transaction", () => {
    const g = boot(CHAIN);
    let seen: Transaction | undefined;
    // Subscribed after the plugin, so this handler observes the appended patches.
    g.on("data/willApplyTransaction", (e) => {
      seen = e.transaction;
    });
    g.dispatch("task/move", { id: "a", start: 100, end: 110 });

    expect(seen?.patches).toHaveLength(2);
    expect(seen?.patches[1]).toEqual({
      op: "task/update",
      id: "b",
      before: { start: 10, end: 15 },
      after: { start: 110, end: 115 },
    });
  });

  it("settles the derived task inside the one transaction", () => {
    const g = boot(CHAIN);
    const settled = recordTransactions(g);
    g.dispatch("task/move", { id: "a", start: 100, end: 110 });
    expect(settled).toHaveLength(1);
    expect(
      settled[0]?.patches.map((p) => (p.op === "task/update" ? String(p.id) : p.op)),
    ).toEqual(["a", "b"]);
  });

  it("propagates through a chain in one transaction", () => {
    const g = boot([
      ...CHAIN,
      { id: "c", name: "C", start: 15, end: 20 },
      { id: "L2", sourceId: "b", targetId: "c", type: "FS" },
    ]);
    g.dispatch("task/move", { id: "a", start: 100, end: 110 });
    expect(times(dataOf(g))).toEqual({ a: [100, 110], b: [110, 115], c: [115, 120] });
  });

  it("schedules the new target when a link is added", () => {
    const g = boot([
      { id: "a", name: "A", start: 0, end: 10 },
      { id: "b", name: "B", start: 0, end: 5 },
    ]);
    g.dispatch("link/add", { sourceId: "a", targetId: "b", type: "FS" });
    expect(times(dataOf(g))).toEqual({ a: [0, 10], b: [10, 15] });
  });

  it("rolls the parent up when a child is added", () => {
    const g = boot([
      { id: "p", name: "P", start: 0, end: 0 },
      { id: "a", name: "A", parentId: "p", start: 10, end: 20 },
    ]);
    g.dispatch("task/add", { task: { id: "c", name: "C", parentId: "p", start: 5, end: 30 } });
    expect(times(dataOf(g))["p"]).toEqual([5, 30]);
  });

  it("rolls the parent up when a child is removed", () => {
    const g = boot([
      { id: "p", name: "P", start: 10, end: 50 },
      { id: "a", name: "A", parentId: "p", start: 10, end: 20 },
      { id: "b", name: "B", parentId: "p", start: 40, end: 50 },
    ]);
    g.dispatch("task/remove", { ids: ["b"] });
    expect(times(dataOf(g))).toEqual({ p: [10, 20], a: [10, 20] });
  });

  it("leaves an unrelated command alone", () => {
    const g = boot(CHAIN);
    g.dispatch("task/setProgress", { id: "a", progress: 0.5 });
    expect(times(dataOf(g))).toEqual({ a: [0, 10], b: [10, 15] });
  });
});

describe("scheduling — cycle rejection", () => {
  it("cancels the transaction and emits schedule/cycleRejected", () => {
    const g = boot(CHAIN);
    const chains: LinkId[][] = [];
    g.on("schedule/cycleRejected", (e) => {
      chains.push([...e.chain]);
    });

    g.dispatch("link/add", { sourceId: "b", targetId: "a", type: "FS" });

    // The generated id is the store's next link id; the existing edge closes the loop.
    expect(chains).toHaveLength(1);
    expect(chains[0]?.[1]).toBe("L1");
    expect(links(dataOf(g))).toHaveLength(1);
  });

  it("applies nothing at all from a rejected transaction", () => {
    const g = boot(CHAIN);
    const settled = recordTransactions(g);
    g.dispatch("link/add", { sourceId: "b", targetId: "a", type: "FS" });
    expect(settled).toEqual([]);
    expect(times(dataOf(g))).toEqual({ a: [0, 10], b: [10, 15] });
  });

  it("rejects a self link", () => {
    const g = boot(CHAIN);
    g.dispatch("link/add", { sourceId: "a", targetId: "a", type: "FS" });
    expect(links(dataOf(g))).toHaveLength(1);
  });

  it("accepts an acyclic link", () => {
    const g = boot([...CHAIN, { id: "c", name: "C", start: 0, end: 5 }]);
    let rejected = false;
    g.on("schedule/cycleRejected", () => {
      rejected = true;
    });
    g.dispatch("link/add", { sourceId: "b", targetId: "c", type: "FS" });
    expect(rejected).toBe(false);
    expect(links(dataOf(g))).toHaveLength(2);
  });
});

describe("scheduling — `autoSchedule.enabled`", () => {
  it("propagates when the harness opts in, and identically when it is explicit", () => {
    const omitted = boot(CHAIN);
    expect(times(dataOf(omitted))).toEqual({ a: [0, 10], b: [10, 15] });
    omitted.dispatch("task/move", { id: "a", start: 100, end: 110 });
    expect(times(dataOf(omitted))).toEqual({ a: [100, 110], b: [110, 115] });
    omitted.dispose();

    const explicit = boot(CHAIN, { autoSchedule: { enabled: true } });
    explicit.dispatch("task/move", { id: "a", start: 100, end: 110 });
    expect(times(dataOf(explicit))).toEqual({ a: [100, 110], b: [110, 115] });
  });

  it("moves nothing downstream when `enabled` is false", () => {
    const g = boot(CHAIN, { autoSchedule: { enabled: false } });
    g.dispatch("task/move", { id: "a", start: 100, end: 110 });
    expect(times(dataOf(g))).toEqual({ a: [100, 110], b: [10, 15] });
  });

  it("rolls no summary up when `enabled` is false", () => {
    const g = boot(
      [
        { id: "p", name: "P", start: 0, end: 0 },
        { id: "a", name: "A", parentId: "p", start: 10, end: 20 },
      ],
      { autoSchedule: { enabled: false } },
    );
    g.dispatch("task/add", { task: { id: "c", name: "C", parentId: "p", start: 5, end: 30 } });
    expect(times(dataOf(g))["p"]).toEqual([0, 0]);
  });

  it("appends no patch to the transaction when `enabled` is false", () => {
    const g = boot(CHAIN, { autoSchedule: { enabled: false } });
    let seen: Transaction | undefined;
    g.on("data/willApplyTransaction", (e) => {
      seen = e.transaction;
    });
    g.dispatch("task/move", { id: "a", start: 100, end: 110 });
    expect(seen?.patches).toHaveLength(1);
  });

  it("still provides the engine, so a host can schedule by hand", () => {
    const g = boot(CHAIN, { autoSchedule: { enabled: false } });
    const scheduler = g.service("stargantt.scheduler");
    const data = dataOf(g);
    g.dispatch("task/move", { id: "a", start: 100, end: 110 });
    expect(scheduler.schedule(data.query(), new Set(["a"]))).toEqual([
      {
        op: "task/update",
        id: "b",
        before: { start: 10, end: 15 },
        after: { start: 110, end: 115 },
      },
    ]);
    expect(typeof scheduler.latestTimes).toBe("function");
    expect(typeof scheduler.detectCycle).toBe("function");
  });

  it("still rejects a cyclic link when `enabled` is false", () => {
    const g = boot(CHAIN, { autoSchedule: { enabled: false } });
    const chains: LinkId[][] = [];
    g.on("schedule/cycleRejected", (e) => {
      chains.push([...e.chain]);
    });
    g.dispatch("link/add", { sourceId: "b", targetId: "a", type: "FS" });
    expect(chains).toHaveLength(1);
    expect(links(dataOf(g))).toHaveLength(1);
  });

  it("still accepts an acyclic link when `enabled` is false, without rescheduling its target", () => {
    const g = boot(
      [
        { id: "a", name: "A", start: 0, end: 10 },
        { id: "b", name: "B", start: 0, end: 5 },
      ],
      { autoSchedule: { enabled: false } },
    );
    g.dispatch("link/add", { sourceId: "a", targetId: "b", type: "FS" });
    expect(links(dataOf(g))).toHaveLength(1);
    expect(times(dataOf(g))).toEqual({ a: [0, 10], b: [0, 5] });
  });
});

describe("scheduling — teardown", () => {
  it("stops scheduling once the instance is disposed", () => {
    const g = boot(CHAIN);
    const data = dataOf(g);
    const scheduler = g.service("stargantt.scheduler");
    g.dispose();
    gantt = undefined;
    // The core released the subscription ledger; the pure engine still works on any view.
    expect(scheduler.schedule(data.query(), new Set(["a"]))).toEqual([]);
  });
});

describe("scheduling — which transactions it propagates over", () => {
  /** A chain with slack: `b` sits well past the earliest start its FS link allows. */
  const SLACK = [
    { id: "a", name: "A", start: 0, end: 10 },
    { id: "b", name: "B", start: 50, end: 55 },
    { id: "L1", sourceId: "a", targetId: "b", type: "FS" },
  ];

  it("propagates over a transaction with no stated origin, which is a user edit", () => {
    const g = boot(SLACK);
    g.dispatch("task/move", { id: "a", start: 100, end: 110 });
    expect(times(dataOf(g))).toEqual({ a: [100, 110], b: [110, 115] });
  });

  it("leaves a replayed transaction exactly as it was given", () => {
    const g = boot(SLACK);
    // The patches of a replay are the ones an earlier action already applied; deriving over them
    // would move `b` off the position the replay is restoring.
    g.dispatch("task/update", {
      id: "a",
      after: { start: 100, end: 110 },
      origin: "history",
    });
    expect(times(dataOf(g))).toEqual({ a: [100, 110], b: [50, 55] });
  });

  it("still leaves its own output alone", () => {
    const g = boot(SLACK);
    g.dispatch("task/update", {
      id: "a",
      after: { start: 100, end: 110 },
      origin: "schedule",
    });
    expect(times(dataOf(g))).toEqual({ a: [100, 110], b: [50, 55] });
  });

  it("does not run cycle detection on a replay either", () => {
    const g = boot(SLACK);
    let rejected = false;
    g.on("schedule/cycleRejected", () => {
      rejected = true;
    });
    // Closing the loop is rejected for a user edit, but a replay is re-applying a link that was
    // already accepted once, so it must go through untouched.
    g.dispatch("link/add", { sourceId: "b", targetId: "a", type: "FS", origin: "history" });
    expect(rejected).toBe(false);
    expect(links(dataOf(g))).toHaveLength(2);
  });
});
