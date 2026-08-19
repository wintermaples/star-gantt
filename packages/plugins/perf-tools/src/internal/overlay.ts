// docs/specs/plugins/perf-tools.md §1.3 — the frame-time overlay and its corner slot.
/**
 * The floating frame-time overlay: a readout line plus an optional sparkline canvas. Deliberately
 * `pointer-events: none` (it can never steal an interaction) and `aria-hidden` (a debug readout
 * updating many times a second would flood assistive tech — the dev-tool exception).
 *
 * The corner-resolution and geometry helpers below (`resolveCorner`, `cornerStyles`,
 * `sparklineBars`, `barColor`) are pure and exported so they are unit-testable without a document
 * or a working 2d canvas context — the resource plugin's load-chart heatmap card is the precedent
 * this mirrors (docs/specs/plugins/resource.md §4.2).
 */
import { styled } from "@stargantt/sdk";
import type { FrameStats, OverlayCorner } from "../types";
import type { RingView } from "./meter";

export const READOUT_INTERVAL_MS = 250;
export const SPARK_WIDTH = 120;
export const SPARK_HEIGHT = 28;
/** The y of the budget guide line, from the canvas bottom, CSS px. */
export const BUDGET_LINE_Y = 18;
/** The margin this plugin owns between the safe-area corner and the overlay's box, CSS px. */
export const OVERLAY_MARGIN_PX = 12;

/** Every corner name the `overlay-corner` slot group knows, in the order `claimSlot` is passed. */
export const OVERLAY_CORNERS: readonly OverlayCorner[] = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
];

export function isOverlayCorner(v: unknown): v is OverlayCorner {
  return v === "top-left" || v === "top-right" || v === "bottom-left" || v === "bottom-right";
}

/**
 * The corner a `claimSlot("overlay-corner", requested, …)` grant resolves to: the requested corner
 * when granted, the proposed alternative when it names one of the four known corners, the
 * requested corner otherwise (no free slot left — the registry already reported the collision).
 * Mirrors the resource plugin's load-chart heatmap `resolveCorner` exactly (§1.3).
 */
export function resolveCorner(
  grant: { granted: boolean; alternative?: string },
  requested: OverlayCorner,
): OverlayCorner {
  return grant.granted || !isOverlayCorner(grant.alternative) ? requested : grant.alternative;
}

/** The `<side>` offset of the slot: the published safe inset plus this plugin's margin. */
function slot(side: "top" | "right" | "bottom" | "left"): string {
  return `calc(var(--sg-safe-${side}, 0px) + ${OVERLAY_MARGIN_PX}px)`;
}

/** The corner-slot positioning, written in terms of that corner's own `--sg-safe-*` pair. */
export function cornerStyles(corner: OverlayCorner): Readonly<Record<string, string>> {
  const vertical = corner === "top-left" || corner === "top-right" ? { top: slot("top") } : { bottom: slot("bottom") };
  const horizontal = corner === "top-left" || corner === "bottom-left" ? { left: slot("left") } : { right: slot("right") };
  return { ...vertical, ...horizontal };
}

// docs/specs/plugins/perf-tools.md §1.3 (architecture.md chapter 1.4): the whole box stays inside
// the safe area at the 720×540 viewport floor. The cap is pane-relative, never a fixed pixel
// maximum, and leaves this plugin's margin on the far side too.
const MAX_WIDTH = `calc(100% - var(--sg-safe-left, 0px) - var(--sg-safe-right, 0px) - ${
  OVERLAY_MARGIN_PX * 2
}px)`;

/* ------------------------------------------------------------------ *
 * Sparkline geometry (pure) and color
 * ------------------------------------------------------------------ */

export interface SparkBar {
  x: number;
  width: number;
  /** Bar height in CSS px, measured up from the canvas bottom. */
  height: number;
  overBudget: boolean;
}

/**
 * Visits the sparkline's bars, newest at the right edge, one per window sample (clamped to
 * `SPARK_WIDTH` — a window far larger than the pixel width still draws one bar per column instead
 * of shrinking every bar to sub-pixel width). An over-budget bar's height is scaled past
 * `BUDGET_LINE_Y`, so it crosses the guide line besides recoloring — meaning is never carried by
 * color alone (§1.3). Allocates nothing: `visit` is called with primitive arguments, never a
 * `SparkBar` object, so this is what the hot draw path (`drawSparkline`) actually calls.
 */
function forEachSparkBar(
  ring: RingView,
  budgetMs: number,
  visit: (x: number, width: number, height: number, overBudget: boolean) => void,
): void {
  if (ring.length === 0 || budgetMs <= 0) return;
  const n = Math.min(ring.length, SPARK_WIDTH);
  const barWidth = Math.max(1, Math.floor(SPARK_WIDTH / n));
  for (let i = 0; i < n; i += 1) {
    // `i` counts back from the newest sample (index 0 = newest); `ring.at` is oldest-first.
    const dur = ring.at(ring.length - 1 - i);
    const height = Math.min(SPARK_HEIGHT, (dur / budgetMs) * BUDGET_LINE_Y);
    const x = SPARK_WIDTH - (i + 1) * barWidth;
    if (x + barWidth <= 0) continue;
    visit(x, barWidth, height, dur > budgetMs);
  }
}

/**
 * The pure, allocating form of {@link forEachSparkBar}, for unit-testing the bar geometry without
 * a canvas. NEVER called from the hot draw path (`drawSparkline` below calls `forEachSparkBar`
 * directly) — §1.3 requires the sparkline "drawn each loop tick from the ring buffer with no
 * allocation", so this collector exists only for tests. A conformance test in `overlay.test.ts`
 * asserts the two agree, per the corpus's duplication rule (gantt-ui-ux code-quality.md §6).
 */
export function sparklineBars(ring: RingView, budgetMs: number): SparkBar[] {
  const bars: SparkBar[] = [];
  forEachSparkBar(ring, budgetMs, (x, width, height, overBudget) => {
    bars.push({ x, width, height, overBudget });
  });
  return bars;
}

// Canvas fills cannot resolve `var()`; a dev overlay uses fixed literals (§1.3) — a dev overlay
// does not participate in theming.
const BAR_COLOR = "#38bdf8";
const OVER_BUDGET_COLOR = "#f87171";
const GUIDE_LINE_COLOR = "rgba(248, 250, 252, 0.6)";

export function barColor(overBudget: boolean): string {
  return overBudget ? OVER_BUDGET_COLOR : BAR_COLOR;
}

/**
 * Paints the sparkline into an already DPR-scaled 2d context, once per loop tick, allocating
 * nothing (§1.3) — walks the ring via `forEachSparkBar`'s primitive-argument callback rather than
 * building a `SparkBar[]`.
 */
export function drawSparkline(ctx: CanvasRenderingContext2D, ring: RingView, budgetMs: number): void {
  ctx.clearRect(0, 0, SPARK_WIDTH, SPARK_HEIGHT);
  // An empty ring clears the canvas and stops there — no guide line painted with nothing to guide.
  if (ring.length === 0) return;
  forEachSparkBar(ring, budgetMs, (x, width, height, overBudget) => {
    ctx.fillStyle = barColor(overBudget);
    ctx.fillRect(x, SPARK_HEIGHT - height, width, height);
  });
  ctx.fillStyle = GUIDE_LINE_COLOR;
  ctx.fillRect(0, SPARK_HEIGHT - BUDGET_LINE_Y, SPARK_WIDTH, 1);
}

/**
 * Sizes the sparkline canvas's backing store for the current `devicePixelRatio` (DPR-correct
 * backing, §1.3): the CSS box stays `SPARK_WIDTH`×`SPARK_HEIGHT`, the backing store is that times
 * the ratio, and the context is scaled so every subsequent draw call still speaks CSS px. Returns
 * `null` where the environment cannot supply a 2d context (a happy-dom/jsdom unit test, in
 * particular) — the caller then simply never draws.
 */
function sizeSparkCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const dpr =
    typeof globalThis.devicePixelRatio === "number" && globalThis.devicePixelRatio > 0
      ? globalThis.devicePixelRatio
      : 1;
  canvas.width = Math.round(SPARK_WIDTH * dpr);
  canvas.height = Math.round(SPARK_HEIGHT * dpr);
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/* ------------------------------------------------------------------ *
 * The overlay element
 * ------------------------------------------------------------------ */

export interface OverlayOptions {
  doc: Document;
  corner: OverlayCorner;
  sparkline: boolean;
  budgetMs: number;
  /** Produces the readout line; the caller passes the already-guarded (§2 latched) builder. */
  readout: (stats: FrameStats) => string;
}

export interface Overlay {
  readonly element: HTMLElement;
  /**
   * Feeds the current window; the readout text is throttled to `READOUT_INTERVAL_MS`, the
   * sparkline redraws every call. `stats` is a lazy provider invoked only when the throttled
   * readout actually updates, so the per-frame hot path never pays the stats scan or its
   * allocation (§1.1).
   */
  render(now: number, stats: () => FrameStats, ring: RingView): void;
  setVisible(visible: boolean): void;
  isVisible(): boolean;
}

/** Builds the overlay DOM. Non-interactive, aria-hidden, no `title` attribute (§1.3). */
export function createOverlay(options: OverlayOptions): Overlay {
  const { doc } = options;
  const root = doc.createElement("div");
  root.className = "sg-perf-tools";
  root.setAttribute("aria-hidden", "true");
  styled(root, {
    position: "absolute",
    ...cornerStyles(options.corner),
    zIndex: "1000",
    pointerEvents: "none",
    display: "flex",
    flexDirection: "column",
    maxWidth: MAX_WIDTH,
    gap: "2px",
    padding: "4px 6px",
    borderRadius: "4px",
    background: "var(--sg-perf-tools-bg, rgba(15, 23, 42, 0.85))",
    color: "var(--sg-perf-tools-fg, #f8fafc)",
    font: "11px ui-monospace, SFMono-Regular, Menlo, monospace",
  });

  const readoutEl = doc.createElement("div");
  readoutEl.className = "sg-perf-tools__readout";
  root.appendChild(readoutEl);

  let sparkCanvas: HTMLCanvasElement | null = null;
  let sparkCtx: CanvasRenderingContext2D | null = null;
  if (options.sparkline) {
    sparkCanvas = doc.createElement("canvas");
    sparkCanvas.className = "sg-perf-tools__spark";
    sparkCtx = sizeSparkCanvas(sparkCanvas);
    styled(sparkCanvas, {
      width: `${SPARK_WIDTH}px`,
      maxWidth: "100%",
      height: `${SPARK_HEIGHT}px`,
      display: "block",
    });
    root.appendChild(sparkCanvas);
  }

  let visible = true;
  let lastTextAt = Number.NEGATIVE_INFINITY;

  return {
    element: root,
    render(now: number, stats: () => FrameStats, ring: RingView): void {
      if (!visible) return;
      if (now - lastTextAt >= READOUT_INTERVAL_MS) {
        lastTextAt = now;
        readoutEl.textContent = options.readout(stats());
      }
      if (sparkCtx !== null) drawSparkline(sparkCtx, ring, options.budgetMs);
    },
    setVisible(next: boolean): void {
      visible = next;
      styled(root, { display: next ? "flex" : "none" });
    },
    isVisible: () => visible,
  };
}
