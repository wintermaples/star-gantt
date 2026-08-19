/**
 * docs/specs/plugins/scheduling.md §2.1 — "Summary tasks roll up to `min(child.start)` /
 * `max(child.end)` of their children, expressed as patches in the same transaction."
 */
import { describe, expect, it } from "vitest";
import { schedule } from "../src/engine/engine";
import { link, moves, task, view } from "./_helpers";

describe("schedule — summary roll-up", () => {
  it("rolls a parent up to min(start)/max(end) of its children", () => {
    const v = view([
      task("p", 0, 0, { type: "summary" }),
      task("a", 10, 20, { parentId: "p" }),
      task("b", 5, 30, { parentId: "p" }),
    ]);
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ p: [5, 30] });
  });

  it("rolls up nested summaries bottom-up in one pass", () => {
    const v = view([
      task("g", 0, 0),
      task("p", 0, 0, { parentId: "g" }),
      task("a", 10, 20, { parentId: "p" }),
      // "q" is outside the changed sub-graph and already consistent with its own child.
      task("q", 40, 50, { parentId: "g" }),
      task("b", 40, 50, { parentId: "q" }),
    ]);
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ p: [10, 20], g: [10, 50] });
  });

  it("rolls the parent up after a propagated child move", () => {
    const v = view(
      [task("p", 0, 0), task("a", 0, 10, { parentId: "p" }), task("b", 0, 5, { parentId: "p" })],
      [link("l1", "a", "b", "FS")],
    );
    // "a" is the seed, "b" is propagated to [10,15], and "p" spans both.
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [10, 15], p: [0, 15] });
  });

  it("derives a summary from its children even when the summary is itself the seed", () => {
    const v = view([task("p", 100, 200), task("a", 10, 20, { parentId: "p" })]);
    expect(moves(schedule(v, new Set(["p"])))).toEqual({ p: [10, 20] });
  });

  it("gives the roll-up precedence over the summary's own incoming links", () => {
    const v = view(
      [task("x", 0, 1000), task("p", 0, 0), task("a", 10, 20, { parentId: "p" })],
      [link("l1", "x", "p", "FS")],
    );
    expect(moves(schedule(v, new Set(["x"])))).toEqual({ p: [10, 20] });
  });

  it("propagates a rolled-up summary onward through its own links", () => {
    const v = view(
      [task("p", 0, 0), task("a", 10, 20, { parentId: "p" }), task("z", 0, 5)],
      [link("l1", "p", "z", "FS")],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ p: [10, 20], z: [20, 25] });
  });

  it("emits nothing when the summary already matches its children", () => {
    const v = view([task("p", 10, 20), task("a", 10, 20, { parentId: "p" })]);
    expect(schedule(v, new Set(["a"]))).toEqual([]);
  });

  it("leaves a childless task alone", () => {
    const v = view([task("a", 10, 20)]);
    expect(schedule(v, new Set(["a"]))).toEqual([]);
  });
});
