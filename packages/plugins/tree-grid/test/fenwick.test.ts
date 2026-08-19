/** The Fenwick tree backing O(log n) offset↔index conversion. */
import { describe, expect, it } from "vitest";
import { Fenwick } from "../src/internal/fenwick";

describe("Fenwick", () => {
  it("is well defined over an empty row set", () => {
    const f = new Fenwick([]);
    expect(f.n).toBe(0);
    expect(f.total()).toBe(0);
    expect(f.prefix(0)).toBe(0);
    expect(f.prefix(5)).toBe(0);
    expect(f.findIndex(0)).toBe(0);
    expect(f.findIndex(100)).toBe(0);
  });

  it("prefix(count) is the y offset of row `count`", () => {
    const f = new Fenwick([10, 20, 30]);
    expect(f.prefix(0)).toBe(0);
    expect(f.prefix(1)).toBe(10);
    expect(f.prefix(2)).toBe(30);
    expect(f.prefix(3)).toBe(60);
    expect(f.total()).toBe(60);
  });

  it("clamps a prefix query past the last row to the total", () => {
    const f = new Fenwick([10, 20, 30]);
    expect(f.prefix(9)).toBe(60);
  });

  it("findIndex returns the row containing the offset", () => {
    const f = new Fenwick([10, 20, 30]);
    expect(f.findIndex(0)).toBe(0);
    expect(f.findIndex(9)).toBe(0);
    expect(f.findIndex(10)).toBe(1);
    expect(f.findIndex(29)).toBe(1);
    expect(f.findIndex(30)).toBe(2);
    expect(f.findIndex(59)).toBe(2);
    // past the end: n, which the row model clamps to n - 1
    expect(f.findIndex(60)).toBe(3);
  });

  it("update shifts every later prefix by the delta", () => {
    const f = new Fenwick([10, 20, 30]);
    f.update(1, 5);
    expect(f.prefix(1)).toBe(10);
    expect(f.prefix(2)).toBe(35);
    expect(f.total()).toBe(65);
    expect(f.findIndex(34)).toBe(1);
    expect(f.findIndex(35)).toBe(2);
  });

  it("ignores updates outside the row range and zero deltas", () => {
    const f = new Fenwick([10, 20]);
    f.update(-1, 100);
    f.update(2, 100);
    f.update(0, 0);
    expect(f.total()).toBe(30);
  });

  it("agrees with a naive prefix sum over a non-power-of-two row set", () => {
    const heights: number[] = [];
    for (let i = 0; i < 37; i += 1) heights.push(1 + (i % 7));
    const f = new Fenwick(heights);

    let running = 0;
    for (let i = 0; i < heights.length; i += 1) {
      expect(f.prefix(i)).toBe(running);
      // every offset inside row i resolves back to i
      expect(f.findIndex(running)).toBe(i);
      expect(f.findIndex(running + (heights[i] ?? 0) - 1)).toBe(i);
      running += heights[i] ?? 0;
    }
    expect(f.total()).toBe(running);
  });
});
