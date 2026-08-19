/**
 * `internal/baselines/paint.ts` — the drawing primitives, the order-50/order-62 `renderer/layers`
 * draws, the `taskbars/overlays` slip indicator and the critical-path-sets resolver, exercised as
 * plain functions against a recording canvas double and structural fixtures. Hostless: no `ctx`, no
 * DOM, no real view/task-bars/tree-grid plugin composed.
 *
 * The recording double below is this package's own (task instructions: "own prefixed doubles" — not
 * imported from a sibling package's test utilities), mirroring
 * `@stargantt/plugin-scheduling`'s `test/critical-path-paint.test.ts` `CpFakeContext2D`.
 *
 * Pixel geometry, thresholds and label text are exercised here against the pure layer builders
 * directly, rather than only through a full chart boot.
 */
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskId } from "@stargantt/plugin-data-store";
import type { BarBox } from "@stargantt/plugin-task-bars";
import type { RowsService } from "@stargantt/plugin-tree-grid";
import type { Viewport } from "@stargantt/plugin-view";
import type { Baseline } from "../src/types";
import {
  createActualsLayer,
  createBaselineUnderlayLayer,
  createCriticalPathSetsResolver,
  createSlipOverlay,
  drawActualBar,
  drawCpRing,
  drawDiamond,
  drawSlipIndicator,
  drawUnderBar,
  underBarHeight,
  visibleSpan,
} from "../src/internal/baselines/paint";
import { DAY, task } from "./_baselines-boot";

/* ------------------------------------------------------------------ *
 * The recording canvas double
 * ------------------------------------------------------------------ */

interface BpOp {
  op: string;
  args: number[];
  fill: string;
  stroke: string;
  lineWidth: number;
  dash: number[];
}
interface BpText {
  text: string;
  x: number;
  y: number;
  fill: string;
}

class BpFakeContext2D {
  fillStyle = "";
  strokeStyle = "";
  lineWidth = 1;
  font = "";
  textAlign = "";
  textBaseline = "";
  private dash: number[] = [];
  readonly ops: BpOp[] = [];
  readonly texts: BpText[] = [];

  private record(op: string, ...args: number[]): void {
    this.ops.push({ op, args, fill: this.fillStyle, stroke: this.strokeStyle, lineWidth: this.lineWidth, dash: this.dash });
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.record("fillRect", x, y, w, h);
  }
  strokeRect(x: number, y: number, w: number, h: number): void {
    this.record("strokeRect", x, y, w, h);
  }
  beginPath(): void {
    this.record("beginPath");
  }
  closePath(): void {
    this.record("closePath");
  }
  moveTo(x: number, y: number): void {
    this.record("moveTo", x, y);
  }
  lineTo(x: number, y: number): void {
    this.record("lineTo", x, y);
  }
  fill(): void {
    this.record("fill");
  }
  stroke(): void {
    this.record("stroke");
  }
  fillText(text: string, x: number, y: number): void {
    this.texts.push({ text, x, y, fill: this.fillStyle });
  }
  setLineDash(dash: number[]): void {
    this.dash = dash;
  }
  save(): void {
    /* no-op double */
  }
  restore(): void {
    /* no-op double */
  }
  calls(op: string): BpOp[] {
    return this.ops.filter((o) => o.op === op);
  }
}

function asContext(g: BpFakeContext2D): CanvasRenderingContext2D {
  return g as unknown as CanvasRenderingContext2D;
}

const VP: Viewport = { scrollLeft: 0, scrollTop: 0, width: 800, height: 600 };

function bar(id: TaskId, x: number, y: number, width: number, height = 20, gutterEnd = 0): BarBox {
  return { id, x, y, width, height, gutterStart: 0, gutterEnd };
}

function baselineOf(
  snaps: { id: TaskId; start: number; end: number; type?: Task["type"] }[],
): Baseline {
  return {
    id: "b",
    name: "b",
    capturedAt: 0,
    taskCount: snaps.length,
    tasks: new Map(snaps.map((s) => [s.id, s])),
    links: [],
  };
}

const COLORS = { bar: "#9aa5b1", overlayFill: "rgba(154, 165, 177, 0.28)", overlayStroke: "#7b8794" };
const ACTUALS_COLORS = { actual: "#334e68", cpAdded: "#b3261e", cpRemoved: "#52606d" };
const SLIP_COLORS = { late: "#b3261e", early: "#1b6e53", font: "10px sans-serif" };

/* fixed 24 px/day timeline (matches the sibling package's convention) */
const PX_PER_DAY = 24;
const timeline = { tToX: (t: number) => (t / DAY) * PX_PER_DAY };

/* ------------------------------------------------------------------ *
 * Drawing primitives
 * ------------------------------------------------------------------ */

describe("underBarHeight / visibleSpan", () => {
  it("clamps the under-bar thickness to 2–4 px, ~15% of the row height", () => {
    expect(underBarHeight(10)).toBe(2); // floor(1.5) clamped up to 2
    expect(underBarHeight(30)).toBe(4); // floor(4.5) clamped down to 4
    expect(underBarHeight(20)).toBe(3); // floor(3) — inside the clamp
  });

  it("clips a span to the viewport, one pixel past each edge, dropping degenerate/off-screen spans", () => {
    expect(visibleSpan(-50, -10, 800)).toBeUndefined(); // wholly left of the viewport
    expect(visibleSpan(810, 900, 800)).toBeUndefined(); // wholly right of the viewport
    expect(visibleSpan(5, 5, 800)).toBeUndefined(); // degenerate (zero width)
    expect(visibleSpan(-50, 50, 800)).toEqual({ x1: -1, x2: 50 });
  });
});

describe("drawSlipIndicator", () => {
  it("draws nothing for a zero slip", () => {
    const g = new BpFakeContext2D();
    drawSlipIndicator(asContext(g), { x: 0, y: 0, width: 40, height: 20 }, 0, 0, "", SLIP_COLORS);
    expect(g.ops).toHaveLength(0);
  });

  it("paints a right-pointing triangle in the late color, placed past bar.x+width+gutterEnd", () => {
    const g = new BpFakeContext2D();
    drawSlipIndicator(asContext(g), { x: 0, y: 0, width: 40, height: 20 }, 17, 3 * DAY, "+3d", SLIP_COLORS);
    expect(g.texts).toHaveLength(1);
    expect(g.texts[0]).toMatchObject({ text: "+3d", fill: SLIP_COLORS.late });
    // cx = bar.x + bar.width + gutterEnd + 4 + size(4); label starts at cx + size + 3.
    const expectedX = 0 + 40 + 17 + 4 + 4 + 4 + 3;
    expect(g.texts[0]?.x).toBeCloseTo(expectedX, 5);
  });

  it("paints a left-pointing triangle in the early color for a negative slip", () => {
    const g = new BpFakeContext2D();
    drawSlipIndicator(asContext(g), { x: 0, y: 0, width: 40, height: 20 }, 0, -2 * DAY, "-2d", SLIP_COLORS);
    expect(g.texts[0]?.fill).toBe(SLIP_COLORS.early);
  });
});

/* ------------------------------------------------------------------ *
 * Order-50 baseline underlay
 * ------------------------------------------------------------------ */

describe("createBaselineUnderlayLayer (renderer/layers order 50)", () => {
  function rowsOf(ids: readonly TaskId[], rowHeight = 24): RowsService {
    return {
      rowCount: () => ids.length,
      taskIdAt: (row) => ids[row],
      rowOf: () => undefined,
      rowHeight: () => rowHeight,
      resolvedHeightOf: () => rowHeight,
      yOf: (row) => row * rowHeight,
      rowAtY: (y) => Math.max(0, Math.min(ids.length - 1, Math.floor(y / rowHeight))),
      totalHeight: () => ids.length * rowHeight,
      isExpanded: () => true,
      rows: { get: () => undefined, subscribe: () => ({ dispose: () => undefined }) } as never,
    };
  }

  it("draws nothing when `bars` is off, no baseline is active, or a required reader is missing", () => {
    const baseline = baselineOf([{ id: "a", start: 0, end: 5 * DAY }]);
    const g = new BpFakeContext2D();
    createBaselineUnderlayLayer({
      bars: false,
      barStyle: "under",
      activeBaseline: () => baseline,
      rows: () => rowsOf(["a"]),
      timeline: () => timeline,
      taskBars: () => ({ barRect: () => undefined }),
      colors: () => COLORS,
    })(asContext(g), VP);
    expect(g.ops).toHaveLength(0);

    createBaselineUnderlayLayer({
      bars: true,
      barStyle: "under",
      activeBaseline: () => undefined,
      rows: () => rowsOf(["a"]),
      timeline: () => timeline,
      taskBars: () => ({ barRect: () => undefined }),
      colors: () => COLORS,
    })(asContext(g), VP);
    expect(g.ops).toHaveLength(0);

    createBaselineUnderlayLayer({
      bars: true,
      barStyle: "under",
      activeBaseline: () => baseline,
      rows: () => undefined, // inert without rows (§8)
      timeline: () => timeline,
      taskBars: () => ({ barRect: () => undefined }),
      colors: () => COLORS,
    })(asContext(g), VP);
    expect(g.ops).toHaveLength(0);
  });

  it("draws a thin under-bar spanning the baseline dates, at the bottom of the row band", () => {
    const baseline = baselineOf([{ id: "a", start: 0, end: 5 * DAY }]);
    const g = new BpFakeContext2D();
    createBaselineUnderlayLayer({
      bars: true,
      barStyle: "under",
      activeBaseline: () => baseline,
      rows: () => rowsOf(["a"], 24),
      timeline: () => timeline,
      taskBars: () => ({ barRect: () => undefined }),
      colors: () => COLORS,
    })(asContext(g), VP);
    const fills = g.calls("fillRect").filter((o) => o.fill === COLORS.bar);
    expect(fills).toHaveLength(1);
    const [x, y, w, h] = fills[0]?.args ?? [];
    expect(x).toBeCloseTo(0, 5);
    expect(w).toBeCloseTo(5 * PX_PER_DAY, 5);
    expect(h).toBeLessThanOrEqual(4);
    expect(y).toBeGreaterThanOrEqual(24 - 4 - 1);
  });

  it("draws a milestone snapshot as an outlined diamond at the baseline start", () => {
    const baseline = baselineOf([{ id: "m", start: 2 * DAY, end: 2 * DAY, type: "milestone" }]);
    const g = new BpFakeContext2D();
    createBaselineUnderlayLayer({
      bars: true,
      barStyle: "under",
      activeBaseline: () => baseline,
      rows: () => rowsOf(["m"], 24),
      timeline: () => timeline,
      taskBars: () => ({ barRect: () => undefined }),
      colors: () => COLORS,
    })(asContext(g), VP);
    expect(g.calls("fillRect")).toHaveLength(0); // outlined, not filled
    expect(g.calls("stroke")).toHaveLength(1);
  });

  it("bands the task's own current bar in the `overlay` style, at that bar's y/height", () => {
    const baseline = baselineOf([{ id: "a", start: 0, end: 5 * DAY }]);
    const box = bar("a", 999, 40, 999, 22); // x/width irrelevant here — the span comes from tToX
    const g = new BpFakeContext2D();
    createBaselineUnderlayLayer({
      bars: true,
      barStyle: "overlay",
      activeBaseline: () => baseline,
      rows: () => rowsOf(["a"], 24),
      timeline: () => timeline,
      taskBars: () => ({ barRect: () => box }),
      colors: () => COLORS,
    })(asContext(g), VP);
    const fills = g.calls("fillRect").filter((o) => o.fill === COLORS.overlayFill);
    expect(fills).toHaveLength(1);
    expect(fills[0]?.args[1]).toBeCloseTo(box.y, 5);
    expect(fills[0]?.args[3]).toBeCloseTo(box.height, 5);
  });

  it("keeps the under-bar at the baseline dates independent of the task's current dates", () => {
    const baseline = baselineOf([{ id: "a", start: 0, end: 5 * DAY }]);
    const g = new BpFakeContext2D();
    createBaselineUnderlayLayer({
      bars: true,
      barStyle: "under",
      activeBaseline: () => baseline,
      rows: () => rowsOf(["a"], 24),
      timeline: () => timeline,
      taskBars: () => ({ barRect: () => undefined }),
      colors: () => COLORS,
    })(asContext(g), VP);
    const fills = g.calls("fillRect").filter((o) => o.fill === COLORS.bar);
    // Even though a's CURRENT dates might have slipped, this layer only ever reads the snapshot.
    expect(fills[0]?.args[0]).toBeCloseTo(timeline.tToX(0), 5);
  });
});

/* ------------------------------------------------------------------ *
 * Order-62 actual bars + baseline critical-path rings
 * ------------------------------------------------------------------ */

describe("createActualsLayer (renderer/layers order 62)", () => {
  it("draws nothing when task-bars is not composed", () => {
    const g = new BpFakeContext2D();
    createActualsLayer({
      actualBars: true,
      taskBars: () => undefined,
      timeline: () => timeline,
      getTask: () => undefined,
      criticalPathSets: () => undefined,
      colors: () => ACTUALS_COLORS,
    })(asContext(g), VP);
    expect(g.ops).toHaveLength(0);
  });

  it("draws an actual bar as a centered stripe (30% height, min 2px) inside the current bar band", () => {
    const box = bar("a", 0, 40, 120, 20);
    const t = task("a", 0, 5 * DAY, { meta: { actualStart: DAY, actualEnd: 4 * DAY } });
    const g = new BpFakeContext2D();
    createActualsLayer({
      actualBars: true,
      taskBars: () => ({ visibleBoxes: () => [box] }),
      timeline: () => timeline,
      getTask: () => t,
      criticalPathSets: () => undefined,
      colors: () => ACTUALS_COLORS,
    })(asContext(g), VP);
    const fills = g.calls("fillRect").filter((o) => o.fill === ACTUALS_COLORS.actual);
    expect(fills).toHaveLength(1);
    const [x, y, w, h] = fills[0]?.args ?? [];
    expect(x).toBeCloseTo(timeline.tToX(DAY), 5);
    expect(w).toBeCloseTo(timeline.tToX(4 * DAY) - timeline.tToX(DAY), 5);
    expect(y).toBeGreaterThan(box.y);
    expect(h).toBeLessThan(box.height);
  });

  it("draws a filled diamond for a milestone's actual start", () => {
    const box = bar("m", 0, 40, 20, 20);
    const t = task("m", 2 * DAY, 2 * DAY, { type: "milestone", meta: { actualStart: 2 * DAY } });
    const g = new BpFakeContext2D();
    createActualsLayer({
      actualBars: true,
      taskBars: () => ({ visibleBoxes: () => [box] }),
      timeline: () => timeline,
      getTask: () => t,
      criticalPathSets: () => undefined,
      colors: () => ACTUALS_COLORS,
    })(asContext(g), VP);
    expect(g.calls("fillRect")).toHaveLength(0);
    expect(g.calls("fill")).toHaveLength(1); // filled (unlike the baseline diamond, which outlines)
  });

  it("draws no actual bar for a task without a recorded actual start", () => {
    const box = bar("a", 0, 40, 120, 20);
    const t = task("a", 0, 5 * DAY);
    const g = new BpFakeContext2D();
    createActualsLayer({
      actualBars: true,
      taskBars: () => ({ visibleBoxes: () => [box] }),
      timeline: () => timeline,
      getTask: () => t,
      criticalPathSets: () => undefined,
      colors: () => ACTUALS_COLORS,
    })(asContext(g), VP);
    expect(g.ops).toHaveLength(0);
  });

  it("rings critical-path-added tasks solid and removed tasks dashed", () => {
    const boxA = bar("a", 0, 0, 100, 24);
    const boxB = bar("b", 0, 24, 100, 24);
    const g = new BpFakeContext2D();
    createActualsLayer({
      actualBars: false,
      taskBars: () => ({ visibleBoxes: () => [boxA, boxB] }),
      timeline: () => timeline,
      getTask: (id) => task(id, 0, DAY),
      criticalPathSets: () => ({ added: new Set(["a"]), removed: new Set(["b"]) }),
      colors: () => ACTUALS_COLORS,
    })(asContext(g), VP);
    const rings = g.calls("strokeRect");
    expect(rings).toHaveLength(2);
    const added = rings.find((r) => r.stroke === ACTUALS_COLORS.cpAdded);
    const removed = rings.find((r) => r.stroke === ACTUALS_COLORS.cpRemoved);
    expect(added?.dash).toEqual([]);
    expect(removed?.dash).toEqual([4, 3]);
  });
});

/* ------------------------------------------------------------------ *
 * taskbars/overlays slip indicator
 * ------------------------------------------------------------------ */

describe("createSlipOverlay (taskbars/overlays)", () => {
  const baseline = baselineOf([{ id: "a", start: 0, end: 5 * DAY }]);

  it("draws nothing when `slipIndicators` is off, no baseline is active, or the task is unknown", () => {
    const g = new BpFakeContext2D();
    const box = bar("a", 0, 0, 100, 20);
    createSlipOverlay({
      slipIndicators: false,
      slipThresholdMs: DAY,
      activeBaseline: () => baseline,
      getTask: () => task("a", 0, 8 * DAY),
      slipLabel: (ms) => String(ms),
      colors: () => SLIP_COLORS,
    })(asContext(g), box);
    expect(g.ops).toHaveLength(0);
  });

  it("draws the default label when the finish slips at or past the threshold", () => {
    const g = new BpFakeContext2D();
    const box = bar("a", 0, 0, 100, 20, 0);
    createSlipOverlay({
      slipIndicators: true,
      slipThresholdMs: DAY,
      activeBaseline: () => baseline,
      getTask: () => task("a", 0, 8 * DAY),
      slipLabel: (ms) => `+${String(ms / DAY)}d`,
      colors: () => SLIP_COLORS,
    })(asContext(g), box);
    expect(g.texts[0]?.text).toBe("+3d");
    expect(g.texts[0]?.fill).toBe(SLIP_COLORS.late);
  });

  it("suppresses the indicator below the threshold", () => {
    const g = new BpFakeContext2D();
    const box = bar("a", 0, 0, 100, 20);
    createSlipOverlay({
      slipIndicators: true,
      slipThresholdMs: DAY,
      activeBaseline: () => baseline,
      getTask: () => task("a", 0, 5 * DAY + 51_840_000), // 0.6 day slip
      slipLabel: (ms) => String(ms),
      colors: () => SLIP_COLORS,
    })(asContext(g), box);
    expect(g.ops).toHaveLength(0);
  });

  it("paints outside a non-zero end gutter", () => {
    const g = new BpFakeContext2D();
    const box = bar("a", 0, 0, 100, 20, 17);
    createSlipOverlay({
      slipIndicators: true,
      slipThresholdMs: DAY,
      activeBaseline: () => baseline,
      getTask: () => task("a", 0, 8 * DAY),
      slipLabel: () => "+3d",
      colors: () => SLIP_COLORS,
    })(asContext(g), box);
    const expectedX = box.x + box.width + 17 + 15;
    expect(g.texts[0]?.x).toBeCloseTo(expectedX, 5);
  });
});

/* ------------------------------------------------------------------ *
 * Critical-path sets resolver
 * ------------------------------------------------------------------ */

describe("createCriticalPathSetsResolver", () => {
  it("returns undefined when disabled or no baseline is active", () => {
    const resolve = createCriticalPathSetsResolver({
      enabled: false,
      activeBaseline: () => baselineOf([]),
      criticalPath: () => [],
      criticalPathDelta: () => ({ added: [], removed: [], retained: [] }),
    });
    expect(resolve()).toBeUndefined();

    const resolve2 = createCriticalPathSetsResolver({
      enabled: true,
      activeBaseline: () => undefined,
      criticalPath: () => [],
      criticalPathDelta: () => ({ added: [], removed: [], retained: [] }),
    });
    expect(resolve2()).toBeUndefined();
  });

  it("memoizes the sets while the baseline object and current-path reference are unchanged", () => {
    const baseline = baselineOf([]);
    const current: TaskId[] = ["a"];
    const deltaFn = vi.fn(() => ({ added: ["a"], removed: [], retained: [] }));
    const resolve = createCriticalPathSetsResolver({
      enabled: true,
      activeBaseline: () => baseline,
      criticalPath: () => current,
      criticalPathDelta: deltaFn,
    });
    const first = resolve();
    const second = resolve();
    expect(second).toBe(first);
    expect(deltaFn).toHaveBeenCalledTimes(1);
  });

  it("recomputes when the current-path reference changes", () => {
    const baseline = baselineOf([]);
    let current: TaskId[] = ["a"];
    const deltaFn = vi.fn(() => ({ added: [...current], removed: [], retained: [] }));
    const resolve = createCriticalPathSetsResolver({
      enabled: true,
      activeBaseline: () => baseline,
      criticalPath: () => current,
      criticalPathDelta: deltaFn,
    });
    resolve();
    current = ["a", "b"]; // fresh reference
    resolve();
    expect(deltaFn).toHaveBeenCalledTimes(2);
  });
});

/* ------------------------------------------------------------------ *
 * end gutter parity sanity for the primitives directly
 * ------------------------------------------------------------------ */

describe("drawUnderBar / drawDiamond / drawActualBar / drawCpRing — degenerate guards", () => {
  it("draws nothing for a degenerate span or non-positive row height", () => {
    const g = new BpFakeContext2D();
    drawUnderBar(asContext(g), 10, 10, 0, 24, "#000"); // x2 === x1
    drawUnderBar(asContext(g), 0, 10, 0, 0, "#000"); // rowHeight 0
    drawActualBar(asContext(g), 10, 10, 0, 20, "#000");
    drawDiamond(asContext(g), 0, 0, 0, "#000", true); // zero radius
    expect(g.ops).toHaveLength(0);
  });

  it("draws a 2px ring inset outward by 2px on each side, dashed when requested", () => {
    const g = new BpFakeContext2D();
    drawCpRing(asContext(g), { x: 10, y: 10, width: 100, height: 24 }, "#b3261e", true);
    const [ring] = g.calls("strokeRect");
    expect(ring?.args).toEqual([8, 8, 104, 28]);
    expect(ring?.dash).toEqual([4, 3]);
  });
});
