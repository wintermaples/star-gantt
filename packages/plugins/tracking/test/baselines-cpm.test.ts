/**
 * `internal/baselines/cpm.ts` — the pure `criticalPathDelta` classifier,
 * the pinned `{ toleranceMs: 1 }` boundary this area relies on `sdk/cpm.criticalTaskIds` for (§1.1's
 * recorded resolution — both the baseline side and the current side run through the SAME engine),
 * and `createCpmApi`'s per-object memoization, exercised through a real `DataService`.
 */
import { criticalTaskIds } from "@stargantt/sdk";
import { describe, expect, it } from "vitest";
import { createCpmApi, criticalPathDelta } from "../src/internal/baselines/cpm";
import type { Baseline } from "../src/types";
import { DAY, bootWithData, link, task } from "./_baselines-boot";

describe("criticalPathDelta", () => {
  it("classifies added, removed and retained ids", () => {
    expect(criticalPathDelta(["a", "b"], ["b", "c"])).toEqual({
      added: ["c"],
      removed: ["a"],
      retained: ["b"],
    });
  });

  it("is empty on both sides for an unchanged critical path", () => {
    expect(criticalPathDelta(["a"], ["a"])).toEqual({ added: [], removed: [], retained: ["a"] });
  });
});

describe("criticality tolerance boundary (pinned, this area's own dependency)", () => {
  it("treats a 1 ms latest-start slack as critical and 2 ms as not, at { toleranceMs: 1 }", () => {
    const atBoundary = criticalTaskIds(
      [
        { id: "p", start: 0, end: DAY },
        { id: "q", start: DAY + 1, end: 2 * DAY + 1 },
      ],
      [{ sourceId: "p", targetId: "q", type: "FS" }],
      { toleranceMs: 1 },
    );
    expect(atBoundary).toContain("p");

    const pastBoundary = criticalTaskIds(
      [
        { id: "p", start: 0, end: DAY },
        { id: "q", start: DAY + 2, end: 2 * DAY + 2 },
      ],
      [{ sourceId: "p", targetId: "q", type: "FS" }],
      { toleranceMs: 1 },
    );
    expect(pastBoundary).not.toContain("p");
  });

  it("omits cycle members — the engine both sides of this area share never finalizes them", () => {
    const critical = criticalTaskIds(
      [
        { id: "a", start: 0, end: 5 * DAY },
        { id: "b", start: 5 * DAY, end: 10 * DAY },
      ],
      [
        { sourceId: "a", targetId: "b", type: "FS" },
        { sourceId: "b", targetId: "a", type: "FS" },
      ],
      { toleranceMs: 1 },
    );
    expect(critical).toEqual([]);
  });
});

function baselineWith(
  tasks: { id: string; start: number; end: number }[],
  links: { sourceId: string; targetId: string; type: "FS" | "SS" | "FF" | "SF" }[] = [],
): Baseline {
  return {
    id: "b",
    name: "b",
    capturedAt: 0,
    taskCount: tasks.length,
    tasks: new Map(tasks.map((t) => [t.id, t])),
    links,
  };
}

describe("createCpmApi", () => {
  it("reports the current schedule's critical path via sdk/cpm at { toleranceMs: 1 }", () => {
    const { data, result: api } = bootWithData((ctx, data) =>
      createCpmApi({ data, ctx, resolveBaseline: () => undefined }),
    );
    data.load({
      tasks: [task("a", 0, 5 * DAY), task("b", 5 * DAY, 10 * DAY), task("c", 0, 2 * DAY)],
      links: [link("l1", "a", "b")],
    });
    expect([...api.criticalPath()].sort()).toEqual(["a", "b"]);
  });

  it("memoizes the current path across calls and invalidates on a data.tasks change", () => {
    const { host, data, result: api } = bootWithData((ctx, data) =>
      createCpmApi({ data, ctx, resolveBaseline: () => undefined }),
    );
    data.load([task("a", 0, DAY)]);
    const first = api.criticalPath();
    const second = api.criticalPath();
    expect(second).toBe(first); // same reference — served from cache

    host.host.dispatch("task/update", { id: "a", after: { end: 2 * DAY } });
    const third = api.criticalPath();
    expect(third).not.toBe(first);
  });

  it("criticalPathDelta compares the baseline's critical path against the current one", () => {
    let baseline: Baseline | undefined;
    const { data, result: api } = bootWithData((ctx, data) =>
      createCpmApi({ data, ctx, resolveBaseline: () => baseline }),
    );
    data.load({
      tasks: [task("a", 0, 5 * DAY), task("b", 5 * DAY, 10 * DAY), task("c", 0, 2 * DAY)],
      links: [link("l1", "a", "b")],
    });
    baseline = baselineWith(
      [
        { id: "a", start: 0, end: 5 * DAY },
        { id: "b", start: 5 * DAY, end: 10 * DAY },
        { id: "c", start: 0, end: 2 * DAY },
      ],
      [{ sourceId: "a", targetId: "b", type: "FS" }],
    );
    // c grows past the whole chain: the path moves to c alone.
    data.load({
      tasks: [task("a", 0, 5 * DAY), task("b", 5 * DAY, 10 * DAY), task("c", 0, 12 * DAY)],
      links: [link("l1", "a", "b")],
    });
    const delta = api.criticalPathDelta();
    expect(delta?.added).toEqual(["c"]);
    expect([...(delta?.removed ?? [])].sort()).toEqual(["a", "b"]);
    expect(delta?.retained).toEqual([]);
  });

  it("returns undefined when the baseline cannot be resolved", () => {
    const { data, result: api } = bootWithData((ctx, data) =>
      createCpmApi({ data, ctx, resolveBaseline: () => undefined }),
    );
    data.load([task("a", 0, DAY)]);
    expect(api.criticalPathDelta("nope")).toBeUndefined();
  });

  it("never invalidates a baseline's OWN path on a data.tasks change (snapshots are immutable)", () => {
    const baseline = baselineWith(
      [
        { id: "a", start: 0, end: 5 * DAY },
        { id: "b", start: 5 * DAY, end: 10 * DAY },
      ],
      [{ sourceId: "a", targetId: "b", type: "FS" }],
    );
    const { host, data, result: api } = bootWithData((ctx, data) =>
      createCpmApi({ data, ctx, resolveBaseline: () => baseline }),
    );
    data.load({
      tasks: [task("a", 0, 5 * DAY), task("b", 5 * DAY, 10 * DAY)],
      links: [link("l1", "a", "b")],
    });
    const before = api.criticalPathDelta();
    // A data change that does not touch the current critical path's membership still forces a
    // fresh CURRENT-side computation, but the baseline side (identity-keyed, immutable snapshots)
    // must report the exact same added/removed classification either way.
    host.host.dispatch("task/update", { id: "a", after: { end: 5 * DAY } }); // no-op value change
    const after = api.criticalPathDelta();
    expect(after).toEqual(before);
  });
});
