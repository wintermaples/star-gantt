// docs/specs/plugins/view.md — the published surface is only the plugin value, its public
// types and its `declare module` augmentation; this module is not part of it.
/**
 * Internal DOM/canvas plumbing for `stargantt.renderer`.
 *
 * Not part of the package's published surface — these helpers exist so the canvas host can be
 * unit-tested in isolation.
 */
import type { CanvasLayer } from "./index";

// docs/specs/plugins/view.md
/** The three canvases, back to front. */
export const LAYER_ORDER: readonly CanvasLayer[] = ["background", "main", "overlay"];

/**
 * Maps a contribution's `zIndex` to the canvas it paints into.
 *
 * Below 50 paints into `background`, below 100 into `main`, and the rest into `overlay`.
 * `LayerContribution` carries no canvas selector of its own, so this banding is the renderer's
 * own choice and is deliberately not a stable part of the plugin API.
 */
export function layerOf(zIndex: number): CanvasLayer {
  // docs/specs/plugins/view.md — the zIndex→canvas mapping is explicitly left to the
  // renderer. The one fixed point is the spec's `todayLine` example (`zIndex: 55` paired with
  // `invalidate("main")`), so 55 must land on `main`; the bands are otherwise arbitrary.
  if (zIndex < 50) return "background";
  if (zIndex < 100) return "main";
  return "overlay";
}

// docs/specs/plugins/view.md — class names and subtree shape.
/** The chart-pane subtree: the pane element, the DOM overlay, and the three layer canvases. */
export interface ChartDom {
  /** The chart pane element, classed `.sg-pane.sg-pane--chart`. */
  pane: HTMLElement;
  /** `.sg-dom-overlay` — the DOM UI host for tooltip / inline edit / handles. */
  domOverlay: HTMLElement;
  canvases: Record<CanvasLayer, HTMLCanvasElement>;
}

/** Builds the chart-pane subtree. The caller owns attaching and removing it. */
export function createChartDom(doc: Document): ChartDom {
  // docs/specs/plugins/view.md — three stacked canvases plus a DOM overlay.
  const pane = doc.createElement("div");
  pane.className = "sg-pane sg-pane--chart";
  // docs/specs/plugins/view.md
  // the pane is mouse-focusable so a press on the canvas leaves the DOM focus inside the
  // chart root. A canvas is not focusable, so the `mousedown` default action used to clear the
  // focus to `<body>` right after `pointer/barDown` handlers had placed it, and every
  // focus-scoped keyboard binding (selection's Ctrl/Cmd+A and Delete) went dead after the most
  // ordinary gesture there is: clicking a bar. `-1` keeps the pane out of the tab order — the
  // keyboard entry point stays keyboard-a11y's roving mirror row, which owns the focus when that
  // plugin places it during the same press.
  pane.setAttribute("tabindex", "-1");
  // Structural only: the three canvases are stacked, and the pane must never become a native
  // scroll container — docs/specs/plugins/view.md — forbids relying on native
  // scrollHeight.
  pane.style.position = "relative";
  pane.style.overflow = "hidden";

  const make = (layer: CanvasLayer): HTMLCanvasElement => {
    const c = doc.createElement("canvas");
    c.className = "sg-layer";
    c.setAttribute("data-layer", layer);
    c.style.position = "absolute";
    c.style.left = "0";
    c.style.top = "0";
    pane.appendChild(c);
    return c;
  };

  const canvases: Record<CanvasLayer, HTMLCanvasElement> = {
    background: make("background"),
    main: make("main"),
    overlay: make("overlay"),
  };

  const domOverlay = doc.createElement("div");
  domOverlay.className = "sg-dom-overlay";
  domOverlay.style.position = "absolute";
  domOverlay.style.left = "0";
  domOverlay.style.top = "0";
  domOverlay.style.width = "100%";
  domOverlay.style.height = "100%";
  domOverlay.style.pointerEvents = "none";
  pane.appendChild(domOverlay);

  return { pane, domOverlay, canvases };
}

// docs/specs/plugins/view.md — class names and box shape of the
// DOM-overlay clip host and of the per-contribution wrappers.
/** `.sg-dom-overlays` class name — the clip host for `renderer/domOverlays` wrappers. */
export const OVERLAY_HOST_CLASS = "sg-dom-overlays";
/** `.sg-dom-overlay-item` class name — one wrapper per `renderer/domOverlays` contribution. */
export const OVERLAY_ITEM_CLASS = "sg-dom-overlay-item";

/**
 * Builds the clip host that contains the DOM-overlay wrappers.
 *
 * It covers the chart viewport rectangle exactly and clips its content, so nothing a contribution
 * mounts can paint over the bands reserved at the top and bottom edges or outside the chart pane.
 * The caller sizes it and owns attaching and removing it.
 */
export function createOverlayHost(doc: Document): HTMLElement {
  const host = doc.createElement("div");
  host.className = OVERLAY_HOST_CLASS;
  host.style.position = "absolute";
  host.style.left = "0";
  host.style.top = "0";
  host.style.overflow = "hidden";
  // Matches the enclosing `.sg-dom-overlay`: overlay content is inert unless a contribution's own
  // children opt back in with `pointer-events: auto`.
  host.style.pointerEvents = "none";
  return host;
}

/**
 * Builds one wrapper element for a DOM-overlay contribution.
 *
 * The wrapper sits at the viewport rectangle's origin with a zero-size box, so it establishes a
 * containing block for the absolutely positioned children the contribution mounts while occupying
 * no space itself. Its `data-overlay-id` attribute carries the contribution's id.
 */
export function createOverlayItem(doc: Document, id: string): HTMLElement {
  const item = doc.createElement("div");
  item.className = OVERLAY_ITEM_CLASS;
  item.setAttribute("data-overlay-id", id);
  item.style.position = "absolute";
  item.style.left = "0";
  item.style.top = "0";
  item.style.width = "0";
  item.style.height = "0";
  item.style.pointerEvents = "none";
  return item;
}

// docs/specs/plugins/view.md
/** `.sg-scrollbar` class name — a synthetic overlay scrollbar's track. */
export const SCROLLBAR_TRACK_CLASS = "sg-scrollbar";
/** `.sg-scrollbar__thumb` class name — the track's thumb child. */
export const SCROLLBAR_THUMB_CLASS = "sg-scrollbar__thumb";

/** Which axis a synthetic scrollbar scrolls. */
export type ScrollbarAxis = "vertical" | "horizontal";

/** `.sg-scrollbar--vertical` / `.sg-scrollbar--horizontal` — the track's axis modifier. */
export function scrollbarAxisClass(axis: ScrollbarAxis): string {
  return `${SCROLLBAR_TRACK_CLASS}--${axis}`;
}

/**
 * Builds one synthetic overlay scrollbar: a track with one thumb child.
 *
 * The track is inert (`pointer-events: none`), so pressing its empty space does nothing, while the
 * thumb is a drag target — `pointer-events: auto` plus `touch-action: none`, so a touch drag is not
 * taken over by the browser's own panning. Colors, thickness and edge offset come from the bundled
 * stylesheet; the caller sizes and positions the track/thumb per frame and owns attaching and
 * removing the track.
 */
export function createScrollbar(
  doc: Document,
  axis: ScrollbarAxis,
): { track: HTMLElement; thumb: HTMLElement } {
  const track = doc.createElement("div");
  track.className = `${SCROLLBAR_TRACK_CLASS} ${scrollbarAxisClass(axis)}`;
  track.style.position = "absolute";
  track.style.pointerEvents = "none";

  const thumb = doc.createElement("div");
  thumb.className = SCROLLBAR_THUMB_CLASS;
  thumb.style.position = "absolute";
  // docs/specs/plugins/view.md — the thumb, and only the thumb, is grabbable.
  thumb.style.pointerEvents = "auto";
  thumb.style.touchAction = "none";
  track.appendChild(thumb);

  return { track, thumb };
}

/**
 * Returns the canvas's 2d context, throwing if the host cannot supply one.
 *
 * A 2d context is mandatory, so the throw propagates out of the plugin's `setup()` and is fatal
 * to plugin activation rather than something callers are expected to recover from.
 */
export function get2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  // docs/specs/architecture.md — a throw from `setup()` is a fatal activation failure.
  const g = canvas.getContext("2d");
  if (g === null) throw new Error("stargantt.renderer: 2d canvas context unavailable");
  return g;
}

/**
 * Resizes one layer canvas for a CSS size at a given devicePixelRatio.
 *
 * The backing store is set to `cssSize * dpr` (rounded, since the ratio can be fractional), the
 * CSS size is pinned in pixels, and the transform is reset before scaling so repeated calls on
 * DPR change cannot compound.
 */
export function sizeLayer(
  canvas: HTMLCanvasElement,
  g: CanvasRenderingContext2D,
  cssWidth: number,
  cssHeight: number,
  dpr: number,
): void {
  // docs/specs/plugins/view.md — `canvas.width = cssW * dpr; ctx.scale(dpr, dpr)`.
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.scale(dpr, dpr);
}
