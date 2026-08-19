/**
 * The heatmap card's pure rules (docs/specs/plugins/resource.md §3.6 / §4.2): the cell shading, the
 * threshold-1 overload verdict the `!` glyph and the outline ride on, and the `overlay-corner`
 * grant resolution with its `--sg-safe-*` positioning.
 *
 * The card's DOM itself needs a document and is exercised by the area's E2E coverage; everything
 * decided WITHOUT one is pinned here.
 */
import { describe, expect, it } from "vitest";
import { OVERLOAD_EPSILON } from "../src/internal/engine/compute";
import {
  cellOpacity,
  HEATMAP_CORNERS,
  isHeatmapCorner,
  isOverloadedCell,
  REQUESTED_CORNER,
  resolveCorner,
  slotStyles,
} from "../src/internal/load-chart/heatmap";

describe("cell shading (§3.6)", () => {
  it("shades by the ratio, clamped into [0, 1]", () => {
    expect(cellOpacity(0, 0)).toBe(0);
    expect(cellOpacity(0.5, 1)).toBe(0.5);
    expect(cellOpacity(1, 1)).toBe(1);
    expect(cellOpacity(3, 1)).toBe(1);
  });

  it("reads a null ratio as fully shaded when anything is allocated, and empty otherwise", () => {
    expect(cellOpacity(null, 5)).toBe(1);
    expect(cellOpacity(null, 0)).toBe(0);
  });
});

describe("the overload verdict (§2.4 — load-chart surfaces judge at threshold 1)", () => {
  const cell = (allocated: number, capacity: number): Parameters<typeof isOverloadedCell>[0] => ({
    start: 0,
    end: 1,
    allocated,
    capacity,
    ratio: capacity > 0 ? allocated / capacity : null,
  });

  it("is not over exactly at capacity, nor within the unified epsilon of it", () => {
    expect(isOverloadedCell(cell(10, 10))).toBe(false);
    expect(isOverloadedCell(cell(10 + OVERLOAD_EPSILON / 2, 10))).toBe(false);
  });

  it("is over past the epsilon, and over at zero capacity with any real allocation", () => {
    expect(isOverloadedCell(cell(10 + OVERLOAD_EPSILON * 2, 10))).toBe(true);
    expect(isOverloadedCell(cell(1, 0))).toBe(true);
    expect(isOverloadedCell(cell(0, 0))).toBe(false);
  });
});

describe("the `overlay-corner` grant (§4.2)", () => {
  it("keeps the requested corner when the claim is granted", () => {
    expect(resolveCorner({ granted: true })).toBe(REQUESTED_CORNER);
  });

  it("moves to the proposed alternative when it names one of the four known corners", () => {
    expect(resolveCorner({ granted: false, alternative: "bottom-left" })).toBe("bottom-left");
  });

  it("falls back to the requested corner when the proposal is absent or unknown", () => {
    expect(resolveCorner({ granted: false })).toBe(REQUESTED_CORNER);
    expect(resolveCorner({ granted: false, alternative: "middle" })).toBe(REQUESTED_CORNER);
  });

  it("recognizes exactly the four corner names it offers as candidates", () => {
    for (const corner of HEATMAP_CORNERS) expect(isHeatmapCorner(corner)).toBe(true);
    expect(isHeatmapCorner(undefined)).toBe(false);
    expect(isHeatmapCorner("centre")).toBe(false);
  });

  it("positions each corner against that corner's own `--sg-safe-*` pair", () => {
    expect(slotStyles("top-right")).toEqual({
      top: "calc(var(--sg-safe-top, 0px) + 8px)",
      right: "calc(var(--sg-safe-right, 0px) + 8px)",
    });
    expect(slotStyles("bottom-left")).toEqual({
      bottom: "calc(var(--sg-safe-bottom, 0px) + 8px)",
      left: "calc(var(--sg-safe-left, 0px) + 8px)",
    });
  });
});
