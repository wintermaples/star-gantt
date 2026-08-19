/**
 * `forEachVisibleRow` (docs/specs/sdk.md, Module: sdk/frame): the shared visible-row walk of the
 * row-aligned canvas layers.
 */
import { describe, expect, it } from "vitest";
import { forEachVisibleRow } from "../src/index";
import type { VisibleRowSource } from "../src/index";

/** Uniform 20 px rows, `count` of them, clamping `rowAtY` like the row model does. */
function uniformRows(count: number): VisibleRowSource {
  return {
    rowCount: () => count,
    rowAtY: (y) => Math.min(count - 1, Math.max(0, Math.floor(y / 20))),
    yOf: (row) => row * 20,
    rowHeight: () => 20,
  };
}

function walk(rows: VisibleRowSource, vp: { scrollTop: number; height: number }): number[][] {
  const seen: number[][] = [];
  forEachVisibleRow(rows, vp, (row, top, height) => void seen.push([row, top, height]));
  return seen;
}

describe("forEachVisibleRow", () => {
  it("visits exactly the rows intersecting the band, with content-space tops", () => {
    expect(walk(uniformRows(100), { scrollTop: 30, height: 40 })).toEqual([
      [1, 20, 20],
      [2, 40, 20],
      [3, 60, 20],
    ]);
  });

  it("clamps the last row at the end of the content", () => {
    expect(walk(uniformRows(3), { scrollTop: 40, height: 500 })).toEqual([[2, 40, 20]]);
  });

  it("visits nothing with zero rows or a non-positive viewport height", () => {
    expect(walk(uniformRows(0), { scrollTop: 0, height: 100 })).toEqual([]);
    expect(walk(uniformRows(5), { scrollTop: 0, height: 0 })).toEqual([]);
  });
});
