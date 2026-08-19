// docs/specs/plugins/a11y.md § Extension points — the contributed focus box.
/**
 * `internal/focus-layer.ts` on its own: when the focus box paints, and the geometry it strokes —
 * against a recording 2D-context double, no host (`references/code-quality.md` §1). The composed
 * behavior (theme token, invalidation, claimed order) stays in `plugin.test.ts`.
 */
import { describe, expect, it } from "vitest";
import type { TaskId } from "@stargantt/plugin-data-store";
import type { BarBox } from "@stargantt/plugin-task-bars";
import type { Viewport } from "@stargantt/plugin-view";
import {
  FOCUS_LAYER_ID,
  FOCUS_LAYER_Z_INDEX,
  FOCUS_STROKE_FALLBACK,
  FOCUS_STROKE_TOKEN,
  createFocusLayer,
} from "../src/internal/focus-layer";
import { FakeCanvasContext } from "./_boot";

const VIEWPORT: Viewport = { scrollTop: 0, scrollLeft: 0, width: 400, height: 300 };
const BOX: BarBox = { id: "t0", x: 10, y: 20, width: 100, height: 16, gutterStart: 0, gutterEnd: 0 };

function draw(state: {
  placed?: boolean;
  visible?: boolean;
  focused?: TaskId | undefined;
  box?: BarBox | undefined;
}): FakeCanvasContext {
  const layer = createFocusLayer({
    focusPlaced: () => state.placed === true,
    focusVisible: () => state.visible === true,
    focusedId: () => (state.focused === undefined ? undefined : state.focused),
    barBoxOf: () => state.box,
    stroke: () => "rgb(1, 2, 3)",
  });
  const g = new FakeCanvasContext();
  layer.draw(g as unknown as CanvasRenderingContext2D, VIEWPORT);
  return g;
}

describe("the focus layer", () => {
  it("registers above the bars and the selection frame, on the main canvas", () => {
    const layer = createFocusLayer({
      focusPlaced: () => false,
      focusVisible: () => false,
      focusedId: () => undefined,
      barBoxOf: () => undefined,
      stroke: () => "#000",
    });
    expect(layer.id).toBe(FOCUS_LAYER_ID);
    expect(FOCUS_LAYER_ID).toBe("stargantt.a11y:focus");
    expect(layer.zIndex).toBe(FOCUS_LAYER_Z_INDEX);
    // docs/specs/render-order.md — bars 60, selection frame 70, focus box 75, decorations 80,
    // overlay band from 100.
    expect(FOCUS_LAYER_Z_INDEX).toBe(75);
    expect(FOCUS_LAYER_Z_INDEX).toBeGreaterThan(70);
    expect(FOCUS_LAYER_Z_INDEX).toBeLessThan(80);
  });

  it("names the theme token and a visible built-in fallback", () => {
    expect(FOCUS_STROKE_TOKEN).toBe("--sg-focus-stroke");
    expect(FOCUS_STROKE_FALLBACK).toBe("#0f766e");
  });

  it("strokes the box outside the bar's edges, in the given colour", () => {
    const g = draw({ placed: true, focused: "t0", box: BOX });
    expect(g.strokes.length).toBe(1);
    expect(g.strokes[0]).toMatchObject({
      x: 8,
      y: 18,
      width: 104,
      height: 20,
      strokeStyle: "rgb(1, 2, 3)",
      lineWidth: 2,
    });
  });

  it("draws nothing before the focus is placed and while the DOM focus is elsewhere", () => {
    expect(draw({ focused: "t0", box: BOX }).strokes.length).toBe(0);
  });

  // Tabbing into the widget paints the box even before any effective placement.
  it("draws once the DOM focus rests on a mirror row, even unplaced", () => {
    expect(draw({ visible: true, focused: "t0", box: BOX }).strokes.length).toBe(1);
  });

  it("draws nothing while nothing is focused, or when the bar is not visible", () => {
    expect(draw({ placed: true, box: BOX }).strokes.length).toBe(0);
    expect(draw({ placed: true, focused: "t0" }).strokes.length).toBe(0);
  });
});
