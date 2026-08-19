import { describe, expect, it } from "vitest";
import { midKey, sequenceKey } from "../src/order-key";

describe("orderKey — fractional indexing", () => {
  it("produces a key after `prev` when there is no next sibling", () => {
    const k = midKey("", undefined);
    expect(k > "").toBe(true);
  });

  it("keeps growing forward without an upper bound", () => {
    let prev = "";
    const keys: string[] = [];
    for (let i = 0; i < 50; i++) {
      prev = midKey(prev, undefined);
      keys.push(prev);
    }
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i - 1]! < keys[i]!).toBe(true);
    }
  });

  it("produces a key strictly between two neighbours", () => {
    const a = sequenceKey(0);
    const b = sequenceKey(1);
    const m = midKey(a, b);
    expect(a < m).toBe(true);
    expect(m < b).toBe(true);
  });

  it("survives repeated insertion at the same slot", () => {
    const lo = sequenceKey(0);
    const hi = sequenceKey(1);
    let prev = lo;
    for (let i = 0; i < 50; i++) {
      const m = midKey(prev, hi);
      expect(prev < m).toBe(true);
      expect(m < hi).toBe(true);
      prev = m;
    }
  });

  it("inserts before the very first sibling", () => {
    const first = sequenceKey(0);
    const m = midKey("", first);
    expect(m > "").toBe(true);
    expect(m < first).toBe(true);
  });

  it("never returns `prev` itself for numerically equal, textually distinct neighbours", () => {
    // User-supplied keys reach midKey through load() and task/add: "1" and "10" are both 1/62.
    expect(midKey("1", "10")).not.toBe("1");
    expect(midKey("1", "1000")).not.toBe("1");
  });

  it("is unaffected by trailing zeros on its neighbours", () => {
    expect(midKey("10", "20")).toBe(midKey("1", "2"));
    expect(midKey("10", undefined)).toBe(midKey("1", undefined));
  });

  it("sequenceKey is monotonically increasing", () => {
    const keys = Array.from({ length: 200 }, (_, i) => sequenceKey(i));
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i - 1]! < keys[i]!).toBe(true);
    }
  });

  it("sequenceKey stays above the empty key even at index 0", () => {
    expect(sequenceKey(0) > "").toBe(true);
  });

  it("sequenceKey rolls over digit boundaries in order", () => {
    expect(sequenceKey(60) < sequenceKey(61)).toBe(true);
    expect(sequenceKey(61) < sequenceKey(62)).toBe(true);
    expect(sequenceKey(3843) < sequenceKey(3844)).toBe(true);
  });
});
