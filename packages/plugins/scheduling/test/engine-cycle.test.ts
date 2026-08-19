/**
 * docs/specs/plugins/scheduling.md §2.7 — cycle detection, the will-phase validity guard's engine
 * half.
 */
import { describe, expect, it } from "vitest";
import { detectCycle } from "../src/engine/graph";
import { link, task, view } from "./_helpers";

const three = [task("a", 0, 10), task("b", 10, 20), task("c", 20, 30)];

describe("detectCycle", () => {
  it("rejects a self link", () => {
    expect(detectCycle(view(three), link("cand", "a", "a"))).toEqual(["cand"]);
  });

  it("rejects a link that closes a two-node loop", () => {
    const v = view(three, [link("l1", "a", "b")]);
    expect(detectCycle(v, link("cand", "b", "a"))).toEqual(["cand", "l1"]);
  });

  it("rejects a link that closes a longer loop and reports the whole chain", () => {
    const v = view(three, [link("l1", "a", "b"), link("l2", "b", "c")]);
    expect(detectCycle(v, link("cand", "c", "a"))).toEqual(["cand", "l1", "l2"]);
  });

  it("accepts a link that only adds a parallel path", () => {
    const v = view(three, [link("l1", "a", "b"), link("l2", "b", "c")]);
    expect(detectCycle(v, link("cand", "a", "c"))).toBeUndefined();
  });

  it("accepts a link into an unrelated component", () => {
    const v = view(three, [link("l1", "b", "c")]);
    expect(detectCycle(v, link("cand", "a", "b"))).toBeUndefined();
  });

  it("accepts a duplicate of an existing link", () => {
    const v = view(three, [link("l1", "a", "b")]);
    expect(detectCycle(v, link("cand", "a", "b"))).toBeUndefined();
  });

  it("accepts anything on an empty graph", () => {
    expect(detectCycle(view(three), link("cand", "a", "b"))).toBeUndefined();
  });

  it("ignores the link type — a cycle is a cycle whichever ends are joined", () => {
    const v = view(three, [link("l1", "a", "b", "SS")]);
    expect(detectCycle(v, link("cand", "b", "a", "FF"))).toEqual(["cand", "l1"]);
  });

  it("terminates on an already-cyclic graph", () => {
    const v = view(three, [link("l1", "a", "b"), link("l2", "b", "a")]);
    expect(detectCycle(v, link("cand", "c", "c"))).toEqual(["cand"]);
    expect(detectCycle(v, link("cand", "b", "c"))).toBeUndefined();
  });
});
