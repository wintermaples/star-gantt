/**
 * The three §7.3 visuals — the `taskbars/style` provider, the `taskbars/overlays` outline/glyph
 * renderer, and the two `renderer/layers` passes (critical-link emphasis order 72, free-float bars
 * order 56) — exercised as plain functions against a recording canvas double and structural bar
 * boxes. Hostless: no `ctx`, no DOM, no real view/task-bars plugin composed.
 *
 * The recording double below is this package's own (task instructions: "own prefixed doubles" —
 * not reused from `@stargantt/plugin-task-bars`'s test utilities, which is a sibling package's
 * private test-only code). It is a deliberately small subset of the fuller `FakeContext2D` those
 * packages use — only the calls this area's paint code makes.
 */
import { describe, expect, it } from "vitest";
import type { Link, TaskId } from "@stargantt/plugin-data-store";
import type { BarBox, TaskBarsService } from "@stargantt/plugin-task-bars";
import type { RowsService } from "@stargantt/plugin-tree-grid";
import type { Viewport } from "@stargantt/plugin-view";
import { emptyAnalysis } from "../src/internal/critical-path/analysis";
import type { CriticalPathAnalysis } from "../src/internal/critical-path/analysis";
import { createColorResolver } from "../src/internal/critical-path/colors";
import { createBarOverlay, createStyleProvider } from "../src/internal/critical-path/overlays";
import { createFloatLayer, createLinkLayer } from "../src/internal/critical-path/paint";

/** The one member the paint passes read from `stargantt.task-bars` (mirrors `paint.ts`'s own). */
type TaskBarsReader = Pick<TaskBarsService, "barRect">;

/* ------------------------------------------------------------------ *
 * The recording canvas double (own, prefixed `Cp*`)
 * ------------------------------------------------------------------ */

interface CpOp {
  op: string;
  args: number[];
  fill: string;
  stroke: string;
  lineWidth: number;
}

class CpFakeContext2D {
  fillStyle = "";
  strokeStyle = "";
  lineWidth = 1;
  lineJoin = "";
  readonly ops: CpOp[] = [];

  private record(op: string, ...args: number[]): void {
    this.ops.push({ op, args, fill: this.fillStyle, stroke: this.strokeStyle, lineWidth: this.lineWidth });
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
  calls(op: string): CpOp[] {
    return this.ops.filter((o) => o.op === op);
  }
}

function asContext(g: CpFakeContext2D): CanvasRenderingContext2D {
  return g as unknown as CanvasRenderingContext2D;
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const VP: Viewport = { scrollLeft: 0, scrollTop: 0, width: 800, height: 600 };

function bar(id: TaskId, x: number, y: number, width: number, height = 20): BarBox {
  return { id, x, y, width, height, gutterStart: 0, gutterEnd: 0 };
}

function barsOf(boxes: readonly BarBox[]): TaskBarsReader {
  const byId = new Map(boxes.map((b) => [b.id, b]));
  return { barRect: (id) => byId.get(id) };
}

function link(id: string, sourceId: TaskId, targetId: TaskId, type: Link["type"] = "FS"): Link {
  return { id, sourceId, targetId, type };
}

const NO_OVERRIDES = {
  criticalColorOverride: undefined,
  nearCriticalColorOverride: undefined,
  negativeFloatColorOverride: undefined,
  floatColorOverride: undefined,
};
const colors = createColorResolver(NO_OVERRIDES, undefined);

function analysisWith(over: Partial<CriticalPathAnalysis>): CriticalPathAnalysis {
  return { ...emptyAnalysis(), ...over };
}

/* ------------------------------------------------------------------ *
 * taskbars/style
 * ------------------------------------------------------------------ */

describe("createStyleProvider (taskbars/style)", () => {
  it("recolors a classified task with the class color and declines everything else", () => {
    const analysis = analysisWith({ classes: new Map([["a", "critical"]]) });
    const style = createStyleProvider(() => analysis, colors);
    expect(style({ id: "a", parentId: null, name: "A", start: 0, end: 1 })).toEqual({
      color: "#c62828",
    });
    expect(style({ id: "b", parentId: null, name: "B", start: 0, end: 1 })).toBeUndefined();
  });

  it("uses the near-critical and negative-float colors for their classes", () => {
    const analysis = analysisWith({
      classes: new Map([
        ["a", "nearCritical"],
        ["b", "negativeFloat"],
      ]),
    });
    const style = createStyleProvider(() => analysis, colors);
    expect(style({ id: "a", parentId: null, name: "A", start: 0, end: 1 })?.color).toBe("#ef6c00");
    expect(style({ id: "b", parentId: null, name: "B", start: 0, end: 1 })?.color).toBe("#7f1d1d");
  });
});

/* ------------------------------------------------------------------ *
 * taskbars/overlays — outline + warning glyph
 * ------------------------------------------------------------------ */

describe("createBarOverlay (taskbars/overlays)", () => {
  it("draws a 2px inset outline in the class color for a classified bar", () => {
    const analysis = analysisWith({ classes: new Map([["a", "critical"]]) });
    const overlay = createBarOverlay(() => analysis, colors);
    const g = new CpFakeContext2D();
    overlay(asContext(g), bar("a", 10, 20, 100, 24));
    const strokes = g.calls("strokeRect");
    expect(strokes).toEqual([
      expect.objectContaining({ args: [11, 21, 98, 22], stroke: "#c62828", lineWidth: 2 }),
    ]);
  });

  it("draws nothing for an unclassified bar", () => {
    const overlay = createBarOverlay(() => emptyAnalysis(), colors);
    const g = new CpFakeContext2D();
    overlay(asContext(g), bar("a", 0, 0, 100, 24));
    expect(g.ops).toHaveLength(0);
  });

  it("adds the warning glyph (white halo + class-color triangle) for negativeFloat only", () => {
    const analysis = analysisWith({ classes: new Map([["a", "negativeFloat"]]) });
    const overlay = createBarOverlay(() => analysis, colors);
    const g = new CpFakeContext2D();
    overlay(asContext(g), bar("a", 0, 0, 100, 24));
    const fills = g.calls("fill");
    expect(fills.some((o) => o.fill === "#ffffff")).toBe(true);
    expect(fills.some((o) => o.fill === "#7f1d1d")).toBe(true);
  });

  it("draws no glyph for critical/nearCritical bars, only the outline", () => {
    const analysis = analysisWith({ classes: new Map([["a", "critical"]]) });
    const overlay = createBarOverlay(() => analysis, colors);
    const g = new CpFakeContext2D();
    overlay(asContext(g), bar("a", 0, 0, 100, 24));
    expect(g.calls("fill")).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * renderer/layers order 72 — critical-link emphasis
 * ------------------------------------------------------------------ */

describe("createLinkLayer (renderer/layers order 72)", () => {
  it("draws a 2.5px elbow polyline in the critical color for each critical link", () => {
    const l = link("l1", "a", "b");
    const bars = barsOf([bar("a", 0, 0, 40, 20), bar("b", 100, 60, 40, 20)]);
    const draw = createLinkLayer({ criticalLinks: () => [l], bars, colors });
    const g = new CpFakeContext2D();
    draw(asContext(g), VP);
    const strokes = g.calls("stroke");
    expect(strokes).toHaveLength(1);
    expect(strokes[0]?.stroke).toBe("#c62828");
    expect(strokes[0]?.lineWidth).toBe(2.5);
  });

  it("draws nothing when there is no critical link", () => {
    const bars = barsOf([]);
    const draw = createLinkLayer({ criticalLinks: () => [], bars, colors });
    const g = new CpFakeContext2D();
    draw(asContext(g), VP);
    expect(g.ops).toHaveLength(0);
  });

  it("skips a link whose endpoint has no bar (e.g. scrolled out / hidden)", () => {
    const l = link("l1", "a", "missing");
    const bars = barsOf([bar("a", 0, 0, 40, 20)]);
    const draw = createLinkLayer({ criticalLinks: () => [l], bars, colors });
    const g = new CpFakeContext2D();
    draw(asContext(g), VP);
    expect(g.calls("stroke")).toHaveLength(0);
  });

  it("culls a link wholly outside the viewport", () => {
    const l = link("l1", "a", "b");
    const bars = barsOf([bar("a", 5000, 0, 40, 20), bar("b", 5100, 20, 40, 20)]);
    const draw = createLinkLayer({ criticalLinks: () => [l], bars, colors });
    const g = new CpFakeContext2D();
    draw(asContext(g), VP);
    expect(g.calls("stroke")).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * renderer/layers order 56 — free-float bars
 * ------------------------------------------------------------------ */

describe("createFloatLayer (renderer/layers order 56)", () => {
  const PX_PER_MS = 24 / 86_400_000; // 24 px/day

  it("draws a strip sized to freeFloat * pxPerMs plus a 1px end tick, full height inset 2px", () => {
    const analysis = analysisWith({ floats: new Map([["a", { totalFloat: 0, freeFloat: 3 * 86_400_000 }]]) });
    const bars = barsOf([bar("a", 0, 0, 40, 24)]);
    const draw = createFloatLayer({
      analysis: () => analysis,
      bars,
      rows: () => undefined,
      pxPerMs: () => PX_PER_MS,
      colors,
    });
    const g = new CpFakeContext2D();
    draw(asContext(g), VP);
    const fills = g.calls("fillRect");
    // The strip: one third of the 24px bar height (8), width = 3 days * 24px/day = 72.
    expect(fills[0]).toEqual(expect.objectContaining({ args: [40, 8, 72, 8], fill: "rgba(96, 125, 139, 0.3)" }));
    // The end tick: flush at the strip's outer end, full bar height inset 2px top/bottom.
    expect(fills[1]).toEqual(expect.objectContaining({ args: [111, 2, 1, 20] }));
  });

  it("floors the strip height at 4 CSS px on a very short bar", () => {
    const analysis = analysisWith({ floats: new Map([["a", { totalFloat: 0, freeFloat: 1 * 86_400_000 }]]) });
    const bars = barsOf([bar("a", 0, 0, 40, 6)]); // height/3 = 2, floored to 4
    const draw = createFloatLayer({
      analysis: () => analysis,
      bars,
      rows: () => undefined,
      pxPerMs: () => PX_PER_MS,
      colors,
    });
    const g = new CpFakeContext2D();
    draw(asContext(g), VP);
    expect(g.calls("fillRect")[0]?.args[3]).toBe(4);
  });

  it("draws nothing for a task with zero or negative free float", () => {
    const analysis = analysisWith({ floats: new Map([["a", { totalFloat: 0, freeFloat: 0 }]]) });
    const bars = barsOf([bar("a", 0, 0, 40, 24)]);
    const draw = createFloatLayer({
      analysis: () => analysis,
      bars,
      rows: () => undefined,
      pxPerMs: () => PX_PER_MS,
      colors,
    });
    const g = new CpFakeContext2D();
    draw(asContext(g), VP);
    expect(g.ops).toHaveLength(0);
  });

  it("draws nothing when pxPerMs is not usable (e.g. 0)", () => {
    const analysis = analysisWith({ floats: new Map([["a", { totalFloat: 0, freeFloat: 86_400_000 }]]) });
    const bars = barsOf([bar("a", 0, 0, 40, 24)]);
    const draw = createFloatLayer({ analysis: () => analysis, bars, rows: () => undefined, pxPerMs: () => 0, colors });
    const g = new CpFakeContext2D();
    draw(asContext(g), VP);
    expect(g.ops).toHaveLength(0);
  });

  it("walks only the visible row range when a row model is supplied", () => {
    const analysis = analysisWith({
      floats: new Map([
        ["a", { totalFloat: 0, freeFloat: 86_400_000 }],
        ["b", { totalFloat: 0, freeFloat: 86_400_000 }],
      ]),
    });
    const bars = barsOf([bar("a", 0, 0, 40, 24), bar("b", 0, 24, 40, 24)]);
    let queried: TaskId[] = [];
    const rows: RowsService = {
      rowCount: () => 1, // only row 0 ("a") is "visible"
      taskIdAt: (row) => {
        queried.push(row === 0 ? "a" : "b");
        return row === 0 ? "a" : undefined;
      },
      rowOf: () => undefined,
      rowHeight: () => 24,
      resolvedHeightOf: () => 24,
      yOf: (row) => row * 24,
      rowAtY: (y) => Math.min(0, Math.floor(y / 24)),
      totalHeight: () => 24,
      isExpanded: () => true,
      rows: { get: () => undefined, subscribe: () => ({ dispose: () => {} }) } as never,
    };
    const draw = createFloatLayer({
      analysis: () => analysis,
      bars,
      rows: () => rows,
      pxPerMs: () => PX_PER_MS,
      colors,
    });
    const g = new CpFakeContext2D();
    draw(asContext(g), VP);
    // Row model reports one row (a): only "a"'s float bar is drawn (strip + tick = 2 fillRect calls).
    expect(g.calls("fillRect")).toHaveLength(2);
    expect(queried).toEqual(["a"]);
  });
});
