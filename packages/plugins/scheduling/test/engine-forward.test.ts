/**
 * docs/specs/plugins/scheduling.md §2.1 forward pass: differential propagation from the changed set
 * through the link graph.
 */
import { describe, expect, it } from "vitest";
import { schedule } from "../src/engine/engine";
import { link, moves, task, view } from "./_helpers";

describe("schedule — link relations", () => {
  it("FS pushes the successor to the predecessor's finish", () => {
    const v = view([task("a", 0, 10), task("b", 0, 5)], [link("l1", "a", "b", "FS")]);
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [10, 15] });
  });

  it("FS honours a positive lag", () => {
    const v = view([task("a", 0, 10), task("b", 0, 5)], [link("l1", "a", "b", "FS", 5)]);
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [15, 20] });
  });

  it("FS honours a negative lag (lead)", () => {
    const v = view([task("a", 0, 10), task("b", 0, 5)], [link("l1", "a", "b", "FS", -3)]);
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [7, 12] });
  });

  it("SS aligns the starts", () => {
    const v = view([task("a", 100, 110), task("b", 0, 5)], [link("l1", "a", "b", "SS", 2)]);
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [102, 107] });
  });

  it("FF aligns the finishes", () => {
    const v = view([task("a", 100, 110), task("b", 0, 5)], [link("l1", "a", "b", "FF")]);
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [105, 110] });
  });

  it("SF ends the successor at the predecessor's start", () => {
    const v = view([task("a", 100, 110), task("b", 0, 5)], [link("l1", "a", "b", "SF")]);
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [95, 100] });
  });

  it("takes the maximum over several predecessors", () => {
    const v = view(
      [task("a", 0, 10), task("b", 0, 40), task("c", 0, 5)],
      [link("l1", "a", "c", "FS"), link("l2", "b", "c", "FS")],
    );
    expect(moves(schedule(v, new Set(["a", "b"])))).toEqual({ c: [40, 45] });
  });

  it("preserves duration", () => {
    const v = view([task("a", 0, 10), task("b", 0, 7)], [link("l1", "a", "b", "FS")]);
    expect(moves(schedule(v, new Set(["a"])))["b"]).toEqual([10, 17]);
  });
});

describe("schedule — propagation", () => {
  it("propagates transitively along a chain", () => {
    const v = view(
      [task("a", 0, 10), task("b", 0, 5), task("c", 0, 5)],
      [link("l1", "a", "b", "FS"), link("l2", "b", "c", "FS")],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [10, 15], c: [15, 20] });
  });

  it("pulls a successor earlier when the predecessor moved back (ASAP)", () => {
    const v = view([task("a", 0, 10), task("b", 100, 105)], [link("l1", "a", "b", "FS")]);
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [10, 15] });
  });

  it("never moves a seed", () => {
    // "b" is the change point; its predecessor "a" and its own times stay put.
    const v = view([task("a", 0, 10), task("b", 50, 55)], [link("l1", "a", "b", "FS")]);
    expect(schedule(v, new Set(["b"]))).toEqual([]);
  });

  it("emits nothing when the successor already sits at its earliest start", () => {
    const v = view([task("a", 0, 10), task("b", 10, 15)], [link("l1", "a", "b", "FS")]);
    expect(schedule(v, new Set(["a"]))).toEqual([]);
  });

  it("is differential — an unrelated sub-graph is untouched", () => {
    const v = view(
      [task("a", 0, 10), task("b", 0, 5), task("x", 0, 3), task("y", 999, 1000)],
      [link("l1", "a", "b", "FS"), link("l2", "x", "y", "FS")],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [10, 15] });
  });

  it("returns no patches for an empty changed set", () => {
    const v = view([task("a", 0, 10), task("b", 0, 5)], [link("l1", "a", "b", "FS")]);
    expect(schedule(v, new Set<string>())).toEqual([]);
  });

  it("ignores changed ids that are not in the view", () => {
    const v = view([task("a", 0, 10)]);
    expect(schedule(v, new Set(["ghost"]))).toEqual([]);
  });

  it("produces reversible task/update patches carrying the previous times", () => {
    const v = view([task("a", 0, 10), task("b", 0, 5)], [link("l1", "a", "b", "FS")]);
    expect(schedule(v, new Set(["a"]))).toEqual([
      { op: "task/update", id: "b", before: { start: 0, end: 5 }, after: { start: 10, end: 15 } },
    ]);
  });

  it("terminates and emits nothing when the graph is cyclic", () => {
    const v = view(
      [task("a", 0, 10), task("b", 0, 5)],
      [link("l1", "a", "b", "FS"), link("l2", "b", "a", "FS")],
    );
    expect(schedule(v, new Set(["a"]))).toEqual([]);
  });
});
