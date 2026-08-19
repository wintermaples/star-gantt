/**
 * `src/internal/value-diff.ts` — the value comparison an inline-edit commit diffs a task against,
 * so a `setValue` that rebuilds an object-valued field does not produce a phantom undo step.
 */
import { describe, expect, it } from "vitest";
import { sameValue } from "../src/internal/value-diff";

describe("sameValue", () => {
  it("agrees with `Object.is` on primitives, including NaN and signed zero", () => {
    expect(sameValue(1, 1)).toBe(true);
    expect(sameValue("a", "a")).toBe(true);
    expect(sameValue(Number.NaN, Number.NaN)).toBe(true);
    expect(sameValue(0, -0)).toBe(false);
    expect(sameValue(1, "1")).toBe(false);
    expect(sameValue(undefined, null)).toBe(false);
  });

  it("holds for an identical reference", () => {
    const shared = { a: 1 };
    expect(sameValue(shared, shared)).toBe(true);
  });

  it("compares rebuilt plain objects by value — the reason the diff exists", () => {
    const before = { priority: 2, tags: { hot: true } };
    expect(sameValue(before, { ...before })).toBe(true);
    expect(sameValue(before, { priority: 2, tags: { hot: true } })).toBe(true);
    expect(sameValue(before, { priority: 3, tags: { hot: true } })).toBe(false);
  });

  it("treats a differing key set as a change", () => {
    expect(sameValue({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(sameValue({ a: 1, b: undefined }, { a: 1, c: undefined })).toBe(false);
  });

  it("compares arrays element-wise, length first", () => {
    expect(sameValue([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(sameValue([1, 2], [1, 2, 3])).toBe(false);
    expect(sameValue([{ a: 1 }], [{ a: 1 }])).toBe(true);
    expect(sameValue([1, 2], { 0: 1, 1: 2 })).toBe(false);
  });

  it("does not structurally compare class instances", () => {
    class Box {
      constructor(readonly n: number) {}
    }
    expect(sameValue(new Box(1), new Box(1))).toBe(false);
    expect(sameValue(new Date(0), new Date(0))).toBe(false);
  });

  it("reports a change past the depth cap rather than recursing without bound", () => {
    const nest = (depth: number): unknown => {
      let value: unknown = "leaf";
      for (let i = 0; i < depth; i += 1) value = { inner: value };
      return value;
    };
    expect(sameValue(nest(7), nest(7))).toBe(true);
    expect(sameValue(nest(20), nest(20))).toBe(false);
  });

  it("terminates on a cyclic structure", () => {
    const a: Record<string, unknown> = {};
    a["self"] = a;
    const b: Record<string, unknown> = {};
    b["self"] = b;
    expect(sameValue(a, b)).toBe(false);
  });
});
