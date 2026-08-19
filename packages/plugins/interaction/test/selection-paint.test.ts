// `strokeSelectionFrame` is pure drawing arithmetic against a supplied box, unit-tested without
// a view service or a real canvas.
import { describe, expect, it } from "vitest";
import {
  SELECTION_LINE_WIDTH,
  SELECTION_OUTSET,
  SELECTION_STROKE,
  strokeSelectionFrame,
} from "../src/internal/selection/paint";
import { fakeCanvas } from "./_selection-fakes";

describe("strokeSelectionFrame", () => {
  it("strokes a single rectangle outset around the bar", () => {
    const g = fakeCanvas();
    strokeSelectionFrame(g, { x: 10, y: 20, width: 40, height: 20 });
    expect(g.ops).toHaveLength(1);
    expect(g.ops[0]?.op).toBe("strokeRect");
    expect(g.ops[0]?.args).toEqual([
      10 - SELECTION_OUTSET,
      20 - SELECTION_OUTSET,
      40 + SELECTION_OUTSET * 2,
      20 + SELECTION_OUTSET * 2,
    ]);
  });

  it("uses the frame's stroke colour and width", () => {
    const g = fakeCanvas();
    strokeSelectionFrame(g, { x: 0, y: 0, width: 1, height: 1 });
    expect(g.ops[0]?.strokeStyle).toBe(SELECTION_STROKE);
    expect(g.ops[0]?.lineWidth).toBe(SELECTION_LINE_WIDTH);
  });

  it("never draws inside the bar, so the bar's fill stays visible", () => {
    const g = fakeCanvas();
    const box = { x: 100, y: 50, width: 30, height: 20 };
    strokeSelectionFrame(g, box);
    const args = g.ops[0]?.args ?? [0, 0, 0, 0];
    expect(args[0]).toBeLessThan(box.x);
    expect(args[1]).toBeLessThan(box.y);
    expect(args[2]).toBeGreaterThan(box.width);
    expect(args[3]).toBeGreaterThan(box.height);
  });

  it("handles a zero-size box without producing a negative extent", () => {
    const g = fakeCanvas();
    strokeSelectionFrame(g, { x: 0, y: 0, width: 0, height: 0 });
    const args = g.ops[0]?.args ?? [0, 0, 0, 0];
    expect(args[2]).toBeGreaterThan(0);
    expect(args[3]).toBeGreaterThan(0);
  });

  it("takes an explicit stroke colour over the built-in default", () => {
    const g = fakeCanvas();
    strokeSelectionFrame(g, { x: 0, y: 0, width: 1, height: 1 }, "rgb(1, 2, 3)");
    expect(g.ops[0]?.strokeStyle).toBe("rgb(1, 2, 3)");
  });

  // Byte-exact against the theme's documented light-mode value, so a drift in the built-in
  // fallback colour is caught here rather than only in a screenshot diff.
  it("mirrors the theme's light value as the built-in fallback", () => {
    expect(SELECTION_STROKE).toBe("#1c1917");
  });
});
