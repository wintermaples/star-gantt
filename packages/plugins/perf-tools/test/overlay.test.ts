// @vitest-environment happy-dom
// docs/specs/plugins/perf-tools.md §1.3 — corner arbitration outcomes, sparkline geometry (pure,
// no working 2d context required), DPR-correct backing, and the overlay's DOM shape.
import { afterEach, describe, expect, it } from "vitest";
import {
  BUDGET_LINE_Y,
  OVERLAY_CORNERS,
  READOUT_INTERVAL_MS,
  SPARK_HEIGHT,
  SPARK_WIDTH,
  barColor,
  cornerStyles,
  createOverlay,
  drawSparkline,
  isOverlayCorner,
  resolveCorner,
  sparklineBars,
} from "../src/internal/overlay";
import type { RingView } from "../src/internal/meter";

function ringOf(...values: number[]): RingView {
  return { length: values.length, at: (i) => values[i] ?? 0 };
}

describe("resolveCorner (§1.3, mirrors resource's load-chart heatmap resolveCorner)", () => {
  it("keeps the requested corner when the claim is granted", () => {
    expect(resolveCorner({ granted: true }, "top-right")).toBe("top-right");
  });

  it("moves to the proposed alternative when it names one of the four known corners", () => {
    expect(resolveCorner({ granted: false, alternative: "bottom-left" }, "top-right")).toBe("bottom-left");
  });

  it("falls back to the requested corner when the proposal is absent or unknown", () => {
    expect(resolveCorner({ granted: false }, "top-right")).toBe("top-right");
    expect(resolveCorner({ granted: false, alternative: "middle" }, "top-right")).toBe("top-right");
  });

  it("recognizes exactly the four corner names as candidates", () => {
    for (const corner of OVERLAY_CORNERS) expect(isOverlayCorner(corner)).toBe(true);
    expect(isOverlayCorner(undefined)).toBe(false);
    expect(isOverlayCorner("centre")).toBe(false);
  });
});

describe("cornerStyles", () => {
  it("positions each corner against that corner's own --sg-safe-* pair, 12px margin", () => {
    expect(cornerStyles("top-right")).toEqual({
      top: "calc(var(--sg-safe-top, 0px) + 12px)",
      right: "calc(var(--sg-safe-right, 0px) + 12px)",
    });
    expect(cornerStyles("bottom-left")).toEqual({
      bottom: "calc(var(--sg-safe-bottom, 0px) + 12px)",
      left: "calc(var(--sg-safe-left, 0px) + 12px)",
    });
    expect(cornerStyles("top-left")).toEqual({
      top: "calc(var(--sg-safe-top, 0px) + 12px)",
      left: "calc(var(--sg-safe-left, 0px) + 12px)",
    });
    expect(cornerStyles("bottom-right")).toEqual({
      bottom: "calc(var(--sg-safe-bottom, 0px) + 12px)",
      right: "calc(var(--sg-safe-right, 0px) + 12px)",
    });
  });
});

describe("sparklineBars (§1.3 — pure, no canvas needed)", () => {
  it("is empty with no samples", () => {
    expect(sparklineBars(ringOf(), 16.7)).toEqual([]);
  });

  it("draws newest at the right edge, one bar per sample under the pixel width", () => {
    const ring = ringOf(10, 20, 30); // oldest-first
    const bars = sparklineBars(ring, 16.7);
    expect(bars).toHaveLength(3);
    // newest (30) is bars[0], at the rightmost x
    expect(bars[0]!.x).toBeGreaterThan(bars[1]!.x);
    expect(bars[1]!.x).toBeGreaterThan(bars[2]!.x);
  });

  it("clamps to at most SPARK_WIDTH bars when the window holds more samples than pixels", () => {
    const values = Array.from({ length: SPARK_WIDTH + 50 }, (_, i) => i);
    const bars = sparklineBars(ringOf(...values), 16.7);
    expect(bars.length).toBeLessThanOrEqual(SPARK_WIDTH);
  });

  it("an over-budget bar crosses the guide line height AND is flagged — never color alone", () => {
    const underBudget = sparklineBars(ringOf(10), 16.7)[0]!;
    const overBudget = sparklineBars(ringOf(30), 16.7)[0]!;
    expect(underBudget.overBudget).toBe(false);
    expect(overBudget.overBudget).toBe(true);
    // "crosses the line": the over-budget bar's height clears the guide line's y position,
    // the under-budget one's does not.
    expect(underBudget.height).toBeLessThanOrEqual(BUDGET_LINE_Y);
    expect(overBudget.height).toBeGreaterThan(BUDGET_LINE_Y);
    // and it recolors too — never color-alone.
    expect(barColor(overBudget.overBudget)).not.toBe(barColor(underBudget.overBudget));
  });

  it("clamps bar height to SPARK_HEIGHT for a wildly over-budget sample", () => {
    const bar = sparklineBars(ringOf(10_000), 16.7)[0]!;
    expect(bar.height).toBe(SPARK_HEIGHT);
  });

  it("is empty for a non-positive budget (division guard)", () => {
    expect(sparklineBars(ringOf(10), 0)).toEqual([]);
    expect(sparklineBars(ringOf(10), -1)).toEqual([]);
  });
});

describe("drawSparkline / sparklineBars conformance (gantt-ui-ux code-quality.md §6)", () => {
  /**
   * `drawSparkline` (the allocation-free hot draw path) and `sparklineBars` (the pure, allocating
   * test double) share one geometry primitive (`forEachSparkBar`) internally, but that is an
   * implementation detail this test does not rely on — it instead proves the two OUTPUTS agree by
   * recording every `fillRect` call a fake 2d context receives and comparing it, bar for bar,
   * against `sparklineBars`'s independently-computed geometry.
   */
  function recordingContext(): CanvasRenderingContext2D & { rects: number[][]; fills: string[] } {
    const rects: number[][] = [];
    const fills: string[] = [];
    return {
      rects,
      fills,
      clearRect: () => undefined,
      fillRect: (x: number, y: number, w: number, h: number) => void rects.push([x, y, w, h]),
      set fillStyle(v: string) {
        fills.push(v);
      },
    } as unknown as CanvasRenderingContext2D & { rects: number[][]; fills: string[] };
  }

  it("paints exactly the bars sparklineBars computes, in the same order, plus the guide line", () => {
    const ring = ringOf(5, 10, 16.7, 20, 30);
    const budgetMs = 16.7;
    const expected = sparklineBars(ring, budgetMs);

    const ctx = recordingContext();
    drawSparkline(ctx, ring, budgetMs);

    // last rect is the guide line; the rest are the bars, in visit order.
    const guideRect = ctx.rects.at(-1)!;
    const barRects = ctx.rects.slice(0, -1);
    expect(barRects).toEqual(expected.map((b) => [b.x, SPARK_HEIGHT - b.height, b.width, b.height]));
    expect(guideRect).toEqual([0, SPARK_HEIGHT - BUDGET_LINE_Y, SPARK_WIDTH, 1]);

    const expectedFills = [...expected.map((b) => barColor(b.overBudget)), "rgba(248, 250, 252, 0.6)"];
    expect(ctx.fills).toEqual(expectedFills);
  });

  it("draws nothing at all, not even the guide line, with an empty ring", () => {
    const ctx = recordingContext();
    drawSparkline(ctx, ringOf(), 16.7);
    expect(ctx.rects).toEqual([]);
    expect(ctx.fills).toEqual([]);
  });
});

describe("createOverlay — DOM shape", () => {
  let overlays: { element: HTMLElement }[] = [];
  afterEach(() => {
    for (const o of overlays) o.element.remove();
    overlays = [];
  });

  function make(options: Partial<Parameters<typeof createOverlay>[0]> = {}) {
    const overlay = createOverlay({
      doc: document,
      corner: "top-right",
      sparkline: true,
      budgetMs: 16.7,
      readout: (stats) => `${stats.frames}`,
      ...options,
    });
    overlays.push(overlay);
    return overlay;
  }

  it("is non-interactive and excluded from the accessibility tree, with no title attribute", () => {
    const overlay = make();
    expect(overlay.element.className).toBe("sg-perf-tools");
    expect(overlay.element.getAttribute("aria-hidden")).toBe("true");
    expect(overlay.element.hasAttribute("title")).toBe(false);
    expect((overlay.element.style as unknown as Record<string, string>)["pointerEvents"]).toBe("none");
  });

  it("includes the sparkline canvas by default, sized to 120x28 CSS px", () => {
    const overlay = make();
    const canvas = overlay.element.querySelector<HTMLCanvasElement>(".sg-perf-tools__spark");
    expect(canvas).not.toBeNull();
    expect(canvas!.style.width).toBe(`${SPARK_WIDTH}px`);
    expect(canvas!.style.height).toBe(`${SPARK_HEIGHT}px`);
  });

  it("sparkline: false omits the canvas", () => {
    const overlay = make({ sparkline: false });
    expect(overlay.element.querySelector(".sg-perf-tools__spark")).toBeNull();
  });

  it("DPR-corrects the sparkline's backing store without changing its CSS size", () => {
    const g = globalThis as { devicePixelRatio?: number };
    const had = "devicePixelRatio" in g;
    const saved = g.devicePixelRatio;
    g.devicePixelRatio = 2;
    try {
      const overlay = make();
      const canvas = overlay.element.querySelector<HTMLCanvasElement>(".sg-perf-tools__spark")!;
      expect(canvas.width).toBe(SPARK_WIDTH * 2);
      expect(canvas.height).toBe(SPARK_HEIGHT * 2);
      expect(canvas.style.width).toBe(`${SPARK_WIDTH}px`); // CSS size unaffected
    } finally {
      if (had) g.devicePixelRatio = saved!;
      else delete g.devicePixelRatio;
    }
  });

  it("shows the initial readout once rendered, then throttles updates to READOUT_INTERVAL_MS", () => {
    let calls = 0;
    const overlay = make({
      readout: (stats) => {
        calls += 1;
        return `${stats.frames}`;
      },
    });
    const readout = overlay.element.querySelector(".sg-perf-tools__readout")!;
    const emptyRing = ringOf();
    overlay.render(0, () => ({ fps: 0, avgMs: 0, maxMs: 0, lastMs: 0, frames: 1, overBudget: 0 }), emptyRing);
    expect(calls).toBe(1);
    expect(readout.textContent).toBe("1");
    // inside the throttle window: no further builder calls
    overlay.render(READOUT_INTERVAL_MS - 1, () => ({ fps: 0, avgMs: 0, maxMs: 0, lastMs: 0, frames: 2, overBudget: 0 }), emptyRing);
    expect(calls).toBe(1);
    // at the throttle boundary: updates again
    overlay.render(READOUT_INTERVAL_MS, () => ({ fps: 0, avgMs: 0, maxMs: 0, lastMs: 0, frames: 3, overBudget: 0 }), emptyRing);
    expect(calls).toBe(2);
    expect(readout.textContent).toBe("3");
  });

  it("computes stats only when the throttled readout actually updates (lazy provider, hot-path allocation guard)", () => {
    let statsCalls = 0;
    const overlay = make();
    const stats = () => {
      statsCalls += 1;
      return { fps: 0, avgMs: 0, maxMs: 0, lastMs: 0, frames: 0, overBudget: 0 };
    };
    const emptyRing = ringOf();
    overlay.render(0, stats, emptyRing);
    expect(statsCalls).toBe(1);
    for (let t = 16; t < READOUT_INTERVAL_MS; t += 16) overlay.render(t, stats, emptyRing);
    expect(statsCalls).toBe(1);
    overlay.render(READOUT_INTERVAL_MS, stats, emptyRing);
    expect(statsCalls).toBe(2);
  });

  it("setVisible toggles display and isVisible; render is a no-op while hidden", () => {
    const overlay = make();
    expect(overlay.isVisible()).toBe(true);
    overlay.setVisible(false);
    expect(overlay.isVisible()).toBe(false);
    expect((overlay.element.style as unknown as Record<string, string>)["display"]).toBe("none");
    let calls = 0;
    overlay.render(0, () => {
      calls += 1;
      return { fps: 0, avgMs: 0, maxMs: 0, lastMs: 0, frames: 0, overBudget: 0 };
    }, ringOf());
    expect(calls).toBe(0);
  });
});
