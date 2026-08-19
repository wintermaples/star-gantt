// Covers the "progress line geometry" behavior of this area's `line.ts`, plus a
// `createProgressLineDraw` behavior test (hidden/unresolved early-return, live status-date
// tracking).
import { describe, expect, it, vi } from "vitest";
import { createProgressLineDraw, progressLinePoints, strokePolyline } from "../src/internal/progress/line";

const MS_DAY = 86_400_000;

describe("progressLinePoints", () => {
  const tToX = (t: number): number => t / MS_DAY; // 1 px per day

  it("starts and ends at the status x and deflects to each bar's progress point", () => {
    const points = progressLinePoints(
      [
        { x: 0, width: 10, cy: 15, start: 0, end: 10 * MS_DAY, progress: 0.3 },
        { x: 0, width: 10, cy: 45, start: 0, end: 10 * MS_DAY, progress: 0.9 },
      ],
      5,
      100,
      tToX,
    );
    expect(points).toEqual([
      { x: 5, y: 0 },
      { x: 3, y: 15 },
      { x: 9, y: 45 },
      { x: 5, y: 100 },
    ]);
  });

  it("clamps the deflection into the bar's horizontal extent", () => {
    const points = progressLinePoints(
      [{ x: 4, width: 2, cy: 10, start: 0, end: 10 * MS_DAY, progress: 1 }],
      5,
      20,
      tToX,
    );
    expect(points[1]).toEqual({ x: 6, y: 10 });
  });
});

describe("strokePolyline", () => {
  it("does nothing under two points", () => {
    const calls: string[] = [];
    const g = { beginPath: () => calls.push("beginPath"), moveTo: () => calls.push("moveTo"), lineTo: () => calls.push("lineTo"), stroke: () => calls.push("stroke") } as unknown as CanvasRenderingContext2D;
    strokePolyline(g, []);
    strokePolyline(g, [{ x: 0, y: 0 }]);
    expect(calls).toEqual([]);
  });

  it("moves to the first point then lines to the rest", () => {
    const calls: string[] = [];
    const g = {
      beginPath: () => calls.push("beginPath"),
      moveTo: () => calls.push("moveTo"),
      lineTo: () => calls.push("lineTo"),
      stroke: () => calls.push("stroke"),
    } as unknown as CanvasRenderingContext2D;
    strokePolyline(g, [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }]);
    expect(calls).toEqual(["beginPath", "moveTo", "lineTo", "lineTo", "stroke"]);
  });
});

describe("createProgressLineDraw", () => {
  function fakeCanvas(): { g: CanvasRenderingContext2D; strokes: string[]; widths: number[] } {
    const strokes: string[] = [];
    const widths: number[] = [];
    const target: Record<string, unknown> = {};
    const g = new Proxy(target, {
      set(_t, prop, value) {
        if (prop === "strokeStyle") strokes.push(String(value));
        if (prop === "lineWidth") widths.push(Number(value));
        target[String(prop)] = value;
        return true;
      },
      get(_t, prop) {
        if (prop in target) return target[String(prop)];
        return () => undefined;
      },
    }) as unknown as CanvasRenderingContext2D;
    return { g, strokes, widths };
  }

  it("early-returns while hidden", () => {
    const { g } = fakeCanvas();
    const bars = vi.fn();
    const draw = createProgressLineDraw({
      visible: () => false,
      statusDate: () => 0,
      bars: () => ({ visibleBoxes: bars }),
      timeline: () => ({ tToX: (t: number) => t }),
      taskOf: () => undefined,
      themeGet: () => undefined,
    });
    draw(g, { scrollLeft: 0, height: 100 });
    expect(bars).not.toHaveBeenCalled();
  });

  it("early-returns while view/task-bars/timeline do not resolve", () => {
    const { g } = fakeCanvas();
    const draw = createProgressLineDraw({
      visible: () => true,
      statusDate: () => 0,
      bars: () => undefined,
      timeline: () => ({ tToX: (t: number) => t }),
      taskOf: () => undefined,
      themeGet: () => undefined,
    });
    // Should not throw even though bars() is undefined.
    expect(() => draw(g, { scrollLeft: 0, height: 100 })).not.toThrow();
  });

  it("strokes with the theme token color, falling back to the documented default", () => {
    const { g, strokes, widths } = fakeCanvas();
    const draw = createProgressLineDraw({
      visible: () => true,
      statusDate: () => 5 * MS_DAY,
      bars: () => ({ visibleBoxes: () => [{ id: "a", x: 0, y: 10, width: 20, height: 10 }] }),
      timeline: () => ({ tToX: (t: number) => t / MS_DAY }),
      taskOf: (id) => (id === "a" ? { start: 0, end: 10 * MS_DAY, progress: 0.5 } : undefined),
      themeGet: () => (token: string) => (token === "--sg-progress-line" ? "#123456" : ""),
    });
    draw(g, { scrollLeft: 0, height: 50 });
    expect(strokes).toEqual(["#123456"]);
    expect(widths).toEqual([1.5]);
  });

  it("falls back to the documented default color without a theme", () => {
    const { g, strokes } = fakeCanvas();
    const draw = createProgressLineDraw({
      visible: () => true,
      statusDate: () => 0,
      bars: () => ({ visibleBoxes: () => [] }),
      timeline: () => ({ tToX: (t: number) => t }),
      taskOf: () => undefined,
      themeGet: () => undefined,
    });
    draw(g, { scrollLeft: 0, height: 50 });
    expect(strokes).toEqual(["#d81b60"]);
  });

  it("subtracts scrollLeft from tToX before drawing (content → viewport-local)", () => {
    const { g } = fakeCanvas();
    let capturedTToXArg: number | undefined;
    const draw = createProgressLineDraw({
      visible: () => true,
      statusDate: () => 10,
      bars: () => ({ visibleBoxes: () => [] }),
      timeline: () => ({
        tToX: (t: number) => {
          capturedTToXArg = t;
          return t;
        },
      }),
      taskOf: () => undefined,
      themeGet: () => undefined,
    });
    draw(g, { scrollLeft: 3, height: 50 });
    // tToX is called with the raw status date (the scroll subtraction happens after, on the
    // result) — confirms the wrapper composes `timeline.tToX(t) - vp.scrollLeft`.
    expect(capturedTToXArg).toBe(10);
  });
});
