/**
 * The header canvas as a live surface: its element, its device-pixel sizing, its placement over the
 * chart pane, the once-per-frame repaint discipline and the text-measurement memo the label rules
 * are decided from.
 *
 * Everything here is about *when* and *onto what* the header is painted; what the paint contains is
 * `header.ts` and `header-layout.ts`. Internal: not part of the published surface.
 */
import type { PluginContext } from "@stargantt/core";
import { drawHeader } from "./header";
import type { HeaderPaintInputs } from "./header-options";

/**
 * Creates the single header canvas.
 *
 * It is positioned absolutely within the gantt root; the surface below places and sizes it over the
 * chart pane, so that the axis it draws lines up with the chart body beneath it.
 */
export function createHeaderCanvas(doc: Document): HTMLCanvasElement {
  // docs/specs/plugins/view.md
  const canvas = doc.createElement("canvas");
  canvas.className = "sg-header";
  canvas.setAttribute("data-sg-header", "timeline-scale");
  canvas.style.position = "absolute";
  canvas.style.left = "0";
  canvas.style.top = "0";
  return canvas;
}

/**
 * Returns the canvas's 2d context. A 2d context is mandatory, so this throws when one cannot be
 * obtained; thrown from `setup()`, that failure is fatal to the plugin.
 */
export function get2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  // docs/specs/architecture.md
  const g = canvas.getContext("2d");
  if (g === null) throw new Error("stargantt.timeline-scale: 2d canvas context unavailable");
  return g;
}

/**
 * Resizes the header canvas, applying the same device-pixel-ratio discipline the renderer uses
 * for its layers: the backing store is scaled by `dpr`, the CSS box keeps its logical size, and
 * the transform is reset before rescaling so repeated calls do not compound.
 */
export function sizeHeader(
  canvas: HTMLCanvasElement,
  g: CanvasRenderingContext2D,
  cssWidth: number,
  cssHeight: number,
  dpr: number,
): void {
  canvas.width = Math.round(cssWidth * dpr);
  // docs/specs/plugins/view.md
  canvas.height = Math.round(cssHeight * dpr);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.scale(dpr, dpr);
}

/** What the header surface has to ask its host for, resolved fresh at each paint. */
export interface HeaderLifecycleDeps {
  /** Total header height in CSS pixels — the `--sg-header-height` value. */
  height: number;
  /**
   * The chart pane, i.e. the box the time axis actually spans.
   *
   * The root also holds the tree grid, which sits to the left, so the root's box is wider than the
   * axis and starts further left (the pane comes from the renderer's own accessor).
   */
  chartPane(): HTMLElement;
  /** The renderer's virtual horizontal scroll offset. */
  scrollLeft(): number;
  /**
   * Everything a paint reads live — level, locale, theme tokens, week start, row geometry, the axis
   * mapping. The surface hands its own measurement channel in, so a paint measures labels with the
   * font it is about to draw them in.
   */
  paintInputs(measureText: (text: string, font: string) => number): HeaderPaintInputs;
}

/** The header surface's controls: request a repaint, or drop what the memo believes about text. */
export interface HeaderLifecycle {
  /** Requests a repaint; several requests within one frame collapse into a single paint. */
  schedule(): void;
  /** Forgets every memoised label width, because the font they were measured with may have changed. */
  clearMeasurements(): void;
  /** Width, in CSS px, `text` paints at in `font` — memoised per font + text. */
  measureText(text: string, font: string): number;
}

/**
 * Creates the header canvas, places it over the chart pane and keeps it painted.
 *
 * Owns, through `ctx.own()`, everything it creates: the canvas element, the pending frame or timer,
 * and the resize observation. Nothing is painted until the first `schedule()`.
 */
export function createHeaderLifecycle(
  ctx: PluginContext,
  deps: HeaderLifecycleDeps,
): HeaderLifecycle {
  const canvas = createHeaderCanvas(ctx.root.ownerDocument);
  ctx.root.appendChild(canvas);
  ctx.own({ dispose: () => canvas.remove() });

  // A 2d context is mandatory; failing to get one is a `setup()` throw, i.e. fatal (§1.9).
  const hg = get2d(canvas);

  // docs/specs/plugins/view.md — the header geometry pass (shared by the
  // on-screen paint and both export tile paths) needs to know how wide a label paints before it
  // decides whether a sticky leading label fits its sliver or a row needs fit-based thinning. The
  // header's own canvas context is the one already-live measurement surface, so it sources the
  // channel; results are memoised per resolved font + text and dropped on a runtime theme change,
  // since `--sg-header-font` can change what the same text measures. LRU-bounded (mirroring the
  // renderer's text cache): the labels are date strings, and a long-lived instance scrolling and
  // zooming across years would otherwise grow the memo without limit.
  const MEASURE_CACHE_CAPACITY = 4096;
  /** Insertion order doubles as recency: a hit is re-inserted, so the first key is the LRU one. */
  const measureCache = new Map<string, number>();
  function measureText(text: string, font: string): number {
    const key = `${font}\0${text}`;
    const cached = measureCache.get(key);
    if (cached !== undefined) {
      measureCache.delete(key);
      measureCache.set(key, cached);
      return cached;
    }
    hg.font = font;
    const width = hg.measureText(text).width;
    if (measureCache.size >= MEASURE_CACHE_CAPACITY) {
      const oldest = measureCache.keys().next();
      if (oldest.done !== true) measureCache.delete(oldest.value);
    }
    measureCache.set(key, width);
    return width;
  }

  let frame: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastWidth = Number.NaN;
  let lastHeight = Number.NaN;
  let lastDpr = Number.NaN;
  let lastLeft = Number.NaN;

  /**
   * The last measured pane placement; `null` = stale. Invalidated by the same ResizeObserver
   * (below) that schedules the repaint, so `paint()` — which can run once per scrolled frame —
   * does not force layout with two `getBoundingClientRect` reads per header paint.
   */
  let cachedGeometry: { left: number; width: number } | null = null;

  /** Offset and width of the chart pane, in CSS pixels relative to the root's left edge. */
  function geometry(): { left: number; width: number } {
    if (cachedGeometry !== null) return cachedGeometry;
    const box = deps.chartPane().getBoundingClientRect();
    // The canvas is absolutely positioned inside the root, so the offset is measured from the
    // root's left edge.
    cachedGeometry = { left: box.left - ctx.root.getBoundingClientRect().left, width: box.width };
    return cachedGeometry;
  }

  function paint(): void {
    frame = null;
    timer = null;
    // Read before touching the canvas: resolving the active level can throw (a composition with no
    // zoom level at all), and it must do so before the element has been resized or moved.
    const inputs = deps.paintInputs(measureText);
    const { left, width } = geometry();
    const height = deps.height;
    if (left !== lastLeft) {
      lastLeft = left;
      canvas.style.left = `${left}px`;
    }
    const dpr = globalThis.devicePixelRatio || 1;
    if (width !== lastWidth || height !== lastHeight || dpr !== lastDpr) {
      lastWidth = width;
      lastHeight = height;
      lastDpr = dpr;
      sizeHeader(canvas, hg, width, height, dpr);
    }
    drawHeader(hg, {
      ...inputs,
      height,
      width,
      scrollLeft: deps.scrollLeft(),
      // the on-screen header keeps the sticky leading label (turns it off for
      // export tiles only).
      sticky: true,
    });
  }

  /** Batching discipline: at most one header paint per frame. */
  function schedule(): void {
    // docs/specs/plugins/view.md
    if (frame !== null || timer !== null) return;
    if (typeof globalThis.requestAnimationFrame === "function") {
      frame = globalThis.requestAnimationFrame(paint);
      return;
    }
    timer = globalThis.setTimeout(paint, 16);
  }

  ctx.own({
    dispose: () => {
      if (frame !== null && typeof globalThis.cancelAnimationFrame === "function") {
        globalThis.cancelAnimationFrame(frame);
      }
      if (timer !== null) globalThis.clearTimeout(timer);
      frame = null;
      timer = null;
    },
  });

  if (typeof globalThis.ResizeObserver === "function") {
    const ro = new globalThis.ResizeObserver(() => {
      cachedGeometry = null;
      schedule();
    });
    ro.observe(ctx.root);
    // The chart pane can change width without the root changing at all — dragging the boundary
    // between the tree grid and the chart does exactly that — and the header has to follow it.

    // docs/specs/plugins/view.md — the pane no longer has to be re-resolved once
    // every plugin is up: the renderer creates it in its own `setup()`, which `dependsOn` orders
    // before this one, and its accessor answers with the same element for the instance's lifetime.
    const pane = deps.chartPane();
    if (pane !== ctx.root) ro.observe(pane);
    ctx.own({ dispose: () => ro.disconnect() });
  } else if (typeof globalThis.addEventListener === "function") {
    const onResize = (): void => {
      cachedGeometry = null;
      schedule();
    };
    globalThis.addEventListener("resize", onResize);
    ctx.own({ dispose: () => globalThis.removeEventListener("resize", onResize) });
  }

  return {
    schedule,
    clearMeasurements: () => measureCache.clear(),
    measureText,
  };
}
