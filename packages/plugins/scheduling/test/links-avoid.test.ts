/**
 * docs/specs/plugins/scheduling.md §5.3 (`avoidBars`) — best-effort obstacle avoidance for elbow
 * routes, hostless.
 */
import { describe, expect, it } from "vitest";
import { AVOID_MARGIN, MAX_PASSES, adjustRoute } from "../src/internal/links/avoid";
import type { Point } from "../src/internal/links/geometry";
import { rect } from "./links-doubles";

/** A 6-point detour route whose middle horizontal segment runs at `midY` from x 10 to 200. */
function detour(midY: number): Point[] {
  return [
    { x: 0, y: 10 },
    { x: 10, y: 10 },
    { x: 10, y: midY },
    { x: 200, y: midY },
    { x: 200, y: 80 },
    { x: 210, y: 80 },
  ];
}

describe("adjustRoute (§5.3)", () => {
  it("returns the same array when nothing collides", () => {
    const route = detour(45);
    expect(adjustRoute(route, [rect(50, 100, 100, 20)])).toBe(route);
    expect(adjustRoute(route, [])).toBe(route);
  });

  it("shifts a crossing interior horizontal segment past the nearer bar edge", () => {
    // Bar occupies y 40..60; the segment at y 45 is nearer the top, so it moves to y 40 - margin.
    const out = adjustRoute(detour(45), [rect(50, 40, 100, 20)]);
    expect(out[2]?.y).toBe(40 - AVOID_MARGIN);
    expect(out[3]?.y).toBe(40 - AVOID_MARGIN);
    // The far side wins when the segment sits in the lower half.
    const below = adjustRoute(detour(55), [rect(50, 40, 100, 20)]);
    expect(below[2]?.y).toBe(60 + AVOID_MARGIN);
  });

  it("never moves the anchors or the anchor-adjacent segments", () => {
    const out = adjustRoute(detour(45), [rect(50, 40, 100, 20)]);
    expect(out[0]).toEqual({ x: 0, y: 10 });
    expect(out[1]?.y).toBe(10);
    expect(out[4]?.y).toBe(80);
    expect(out[5]).toEqual({ x: 210, y: 80 });
  });

  it("leaves a segment alone when the bar does not overlap its x range", () => {
    const out = adjustRoute(detour(45), [rect(300, 40, 50, 20)]);
    expect(out[2]?.y).toBe(45);
  });

  it("shifts a crossing interior vertical segment sideways", () => {
    // The vertical segment at x 10 (y 10..45) crosses a bar at x 0..30, y 20..35.
    const out = adjustRoute(detour(45), [rect(0, 20, 30, 15)]);
    // Nearer side of the bar horizontally from x 10 is the left edge at 0.
    expect(out[1]?.x).toBe(0 - AVOID_MARGIN);
    expect(out[2]?.x).toBe(0 - AVOID_MARGIN);
  });

  it("stays bounded on layouts it cannot resolve", () => {
    // Two bars whose margins interlock so every candidate y collides; must return, not loop.
    const wallA = rect(0, 30, 300, 20);
    const wallB = rect(0, 50 + AVOID_MARGIN, 300, 20);
    expect(() => adjustRoute(detour(45), [wallA, wallB])).not.toThrow();
  });

  it("ignores short routes with no interior segment", () => {
    const straight: Point[] = [
      { x: 0, y: 10 },
      { x: 100, y: 10 },
    ];
    expect(adjustRoute(straight, [rect(20, 0, 30, 40)])).toBe(straight);
  });

  it("keeps the margin and the pass bound at their published values", () => {
    expect(AVOID_MARGIN).toBe(4);
    expect(MAX_PASSES).toBe(3);
  });
});
