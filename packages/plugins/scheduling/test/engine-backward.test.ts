/**
 * docs/specs/plugins/scheduling.md §1.1 — `latestTimes`, the engine's backward pass. Its cycle
 * handling is engine-own: members keep their stored dates rather than being omitted.
 */
import { describe, expect, it } from "vitest";
import { latestTimes } from "../src/engine/engine";
import { link, task, view } from "./_helpers";

describe("latestTimes", () => {
  it("returns an empty map for an empty view", () => {
    expect([...latestTimes(view([]))]).toEqual([]);
  });

  it("pins a sink to the project finish", () => {
    const v = view([task("a", 0, 10), task("b", 0, 40)]);
    expect(latestTimes(v).get("a")).toEqual({ latestStart: 30, latestFinish: 40 });
    expect(latestTimes(v).get("b")).toEqual({ latestStart: 0, latestFinish: 40 });
  });

  it("walks an FS chain backwards", () => {
    const v = view(
      [task("a", 0, 10), task("b", 10, 20), task("c", 20, 30)],
      [link("l1", "a", "b", "FS"), link("l2", "b", "c", "FS")],
    );
    const latest = latestTimes(v);
    expect(latest.get("c")).toEqual({ latestStart: 20, latestFinish: 30 });
    expect(latest.get("b")).toEqual({ latestStart: 10, latestFinish: 20 });
    expect(latest.get("a")).toEqual({ latestStart: 0, latestFinish: 10 });
  });

  it("subtracts the lag", () => {
    const v = view([task("a", 0, 10), task("b", 15, 25)], [link("l1", "a", "b", "FS", 5)]);
    expect(latestTimes(v).get("a")).toEqual({ latestStart: 0, latestFinish: 10 });
  });

  it("takes the tightest of several successors", () => {
    const v = view(
      [task("a", 0, 10), task("b", 10, 60), task("c", 10, 20)],
      [link("l1", "a", "b", "FS"), link("l2", "a", "c", "FS")],
    );
    // project finish 60; "c" may finish as late as 60, so it bounds "a" at 50 — "b" bounds it at 10.
    expect(latestTimes(v).get("c")).toEqual({ latestStart: 50, latestFinish: 60 });
    expect(latestTimes(v).get("a")).toEqual({ latestStart: 0, latestFinish: 10 });
  });

  it("reports the float of an off-critical task", () => {
    const v = view(
      [task("a", 0, 10), task("b", 10, 50), task("c", 0, 5)],
      [link("l1", "a", "b", "FS")],
    );
    expect(latestTimes(v).get("c")).toEqual({ latestStart: 45, latestFinish: 50 });
  });

  it("inverts SS", () => {
    const v = view([task("a", 0, 10), task("b", 0, 30)], [link("l1", "a", "b", "SS")]);
    // b.latestStart = 0 ⇒ a may start no later than 0, i.e. finish no later than its duration.
    expect(latestTimes(v).get("a")).toEqual({ latestStart: 0, latestFinish: 10 });
  });

  it("inverts FF", () => {
    const v = view([task("a", 0, 10), task("b", 0, 30)], [link("l1", "a", "b", "FF")]);
    expect(latestTimes(v).get("a")).toEqual({ latestStart: 20, latestFinish: 30 });
  });

  it("inverts SF", () => {
    const v = view([task("a", 0, 10), task("b", 0, 30)], [link("l1", "a", "b", "SF")]);
    expect(latestTimes(v).get("a")).toEqual({ latestStart: 30, latestFinish: 40 });
  });

  it("falls back to a task's own times when it sits in a link cycle", () => {
    const v = view(
      [task("a", 0, 10), task("b", 3, 7)],
      [link("l1", "a", "b", "FS"), link("l2", "b", "a", "FS")],
    );
    const latest = latestTimes(v);
    expect(latest.get("a")).toEqual({ latestStart: 0, latestFinish: 10 });
    expect(latest.get("b")).toEqual({ latestStart: 3, latestFinish: 7 });
  });

  it("covers every task in the view", () => {
    const v = view([task("a", 0, 10), task("b", 10, 20), task("c", 0, 3)]);
    expect(latestTimes(v).size).toBe(3);
  });
});
