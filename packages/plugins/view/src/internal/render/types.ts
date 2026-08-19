// docs/specs/plugins/view.md
/**
 * The render module's value types: the eleven the renderer publishes, plus the row-geometry
 * provider the `renderer/rowGeometry` point takes and the surface the module exposes.
 *
 * They live in their own file because the module root is wiring, and the two grow independently.
 */

/* ------------------------------------------------------------------ *
 * Public types (contract §3.2)
 * ------------------------------------------------------------------ */

// docs/specs/plugins/view.md
/** Names of the three stacked canvases, back to front. */
export type CanvasLayer = "background" | "main" | "overlay";

// docs/specs/plugins/view.md
/**
 * Scroll offsets and CSS-pixel size of the visible chart area.
 *
 * Entirely virtual: the offsets are plain numbers maintained by the renderer and are never
 * materialized as native scroll geometry or as an oversized canvas.
 */
export interface Viewport {
  scrollTop: number;
  scrollLeft: number;
  width: number;
  height: number;
  /**
   * Detail hint for the frame being painted, present only when progressive rendering is enabled
   * (`ViewConfig.progressive`): `"coarse"` while the chart is actively scrolling — a layer
   * contribution may skip expensive detail such as text and gradients — and `"fine"` on the settled
   * repaint that follows. Absent (the default) means full detail, and contributions are free to
   * ignore the hint entirely.
   */
  detail?: "coarse" | "fine";
}

/** A rectangle in viewport-local CSS pixels, as accepted by partial invalidation. */
export interface InvalidateRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// docs/specs/plugins/view.md
/**
 * A drawing contribution to the `renderer/layers` extension point.
 *
 * `zIndex` orders contributions within the composite pass and selects the canvas they paint
 * into; `draw` receives that canvas's 2d context, already scaled to CSS pixels, together with
 * the current viewport.
 */
export interface LayerContribution {
  id: string;
  zIndex: number;
  draw(g: CanvasRenderingContext2D, vp: Readonly<Viewport>): void;
}

// docs/specs/plugins/view.md
/**
 * What the hit test found under a point.
 *
 * `kind` names the shape — `"bar"`, `"handle"` and `"link"` are the built-in values, and any
 * other string is allowed so plugins can report their own shapes. `id` identifies the object
 * the shape belongs to, and `cursor` is the CSS cursor to show while hovering it.
 */
export interface HitResult {
  kind: "bar" | "handle" | "link" | (string & {});
  id: string | number;
  cursor: string;
}

export type HitTester = (x: number, y: number) => HitResult | undefined;

// docs/specs/plugins/view.md
/**
 * The rectangle a `renderer/insets` contribution was assigned, in CSS pixels relative to the chart
 * body's border box: `y = 0` is the body's top edge, and the rect spans the body's full width.
 */
export interface InsetRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// docs/specs/plugins/view.md
/**
 * One horizontal strip reserved at the chart body's top or bottom edge for chrome the contributor
 * draws itself — a timeline header, a load histogram, a footer chart.
 *
 * Contributions to the same side are stacked outermost-first by ascending `order` (ties by
 * registration order), each is assigned its own rectangle, and the side reserves the sum of the
 * contributed sizes.
 */
export interface InsetContribution {
  /** Which edge of the chart body the strip is reserved at. */
  side: "top" | "bottom";
  /** Stacking rank within the side: lower values sit closer to the body's edge. */
  order: number;
  /** Height of the strip in CSS pixels. Non-finite or negative values are treated as `0`. */
  size: number;
  /**
   * Called with the rectangle this strip was assigned — once before the first paint pass, and
   * again whenever layout moves it (a resize, or another contribution changing the stack).
   */
  placed?(rect: Readonly<InsetRect>): void;
}

// docs/specs/plugins/view.md
/** The space reserved at each edge of the chart body: the sum of that side's strip sizes. */
export interface ResolvedInsets {
  top: number;
  bottom: number;
}

// docs/specs/plugins/view.md
/**
 * A block of HTML anchored in *content coordinates* — the pre-scroll pixel space in which `x = 0`
 * is the timeline origin at `scrollLeft = 0` and `y = 0` is the top of the first row.
 *
 * The renderer creates one wrapper element per contribution and keeps it aligned with the canvas
 * layers while the chart scrolls; the contribution positions its own children inside that wrapper
 * with `position: absolute` and content-coordinate `left` / `top`. Converting domain data to those
 * coordinates is the contribution's job: the renderer knows nothing about time or rows and promises
 * only that a content coordinate stays pinned under scrolling, resizing and inset changes.
 */
export interface DomOverlayContribution {
  /** Stable identifier, reflected on the wrapper as its `data-overlay-id` attribute. */
  id: string;
  /**
   * Called once with the wrapper element, which is empty, owned by the renderer, and already
   * scroll-aligned. Append children here and reposition them later as the data they depend on
   * changes; do not detach or restyle the wrapper itself.
   */
  mount(wrapper: HTMLElement): void;
}

// docs/specs/plugins/view.md
/**
 * One contribution to the chart body's content size, used to bound the scrollable range.
 *
 * `measure` is called every time the renderer needs to clamp a scroll position — never cached
 * across clamps, since the content size changes on every data load, collapse/expand or zoom — and
 * returns the contributor's current size in content-coordinate CSS pixels. An absent or
 * non-finite axis means "this contribution says nothing about that axis"; the renderer combines
 * every contribution's report for an axis by taking the maximum of the finite values.
 */
export interface ContentExtentContribution {
  /** Stable identifier, used only for diagnostics. */
  id: string;
  measure(): { width?: number; height?: number };
}

export interface RenderSurface {
  /**
   * Marks a canvas layer dirty so the next animation-frame pass repaints it. With a rectangle —
   * and with `ViewConfig.dirtyRegions` enabled — the repaint of that layer is clipped to the
   * union of the rectangles invalidated since the last paint, in viewport-local CSS pixels;
   * without one, or with the option off, the whole layer repaints as before. An unusable
   * rectangle (non-finite or non-positive size) counts as a full invalidation.
   */
  invalidate(layer: CanvasLayer, rect?: InvalidateRect): void;
  /**
   * Re-reads the bands reserved at the chart's top and bottom edges and re-lays out the chart's
   * surfaces when they have changed since the last layout.
   *
   * Call this after the size a plugin reserves has changed for a reason the chart cannot observe
   * on its own — a footer whose height follows the data, for instance. Resizes and device-pixel
   * ratio changes already re-read the bands by themselves. When nothing changed, this costs only
   * the read.
   *
   * When the layout did change, the chart repaints before this call returns rather than on the next
   * animation frame — re-sizing a canvas clears it, so a repaint left to the frame clock would show
   * the empty surface for a frame. The one exception is a call from inside a layer's `draw`: a
   * repaint cannot be nested inside the one already running, so it happens on the next frame
   * instead. Prefer calling this outside `draw`.
   */
  refreshInsets(): void;
  /**
   * The chart's base text direction, `"ltr"` unless the plugin was created with
   * `direction: "rtl"`. Plugins that mirror their own geometry or text for right-to-left locales
   * read the value here so the whole composition agrees on one direction.
   */
  direction(): "ltr" | "rtl";
  /**
   * `true` while the user agent reports `prefers-reduced-motion: reduce`. The renderer itself
   * animates nothing, and plugins that do (scroll easing, transitions) consult this single source
   * and disable their motion when it is `true`. Tracked live: an OS-level toggle flips the value
   * without a reload.
   */
  reducedMotion(): boolean;
  /**
   * The advance width of `text` under the context's current font, measured with
   * `measureText` at most once per font-and-string pair and served from a bounded cache
   * afterwards. Use it in per-frame label painting instead of calling `measureText` directly.
   * The cache is cleared automatically when the device pixel ratio changes.
   */
  textWidth(g: CanvasRenderingContext2D, text: string): number;
  /**
   * Prepares a label that may mix right-to-left text with digits or Latin characters for canvas
   * painting: direction-mixed strings are wrapped in a Unicode directional-isolate pair so they
   * render in the correct visual order for the given base direction (defaulting to a first-strong
   * isolate), while purely one-directional strings are returned unchanged. Safe to apply
   * unconditionally; it never double-wraps.
   */
  bidiIsolate(text: string, base?: "ltr" | "rtl"): string;
  /**
   * Milliseconds from the renderer's setup to the completion of its first on-screen paint pass,
   * or `undefined` before that first paint has happened. Lets a host watch its initial-render
   * budget on real data without external instrumentation.
   */
  firstPaintMs(): number | undefined;
  /**
   * Queues a callback that reads layout (`getBoundingClientRect`, `getComputedStyle`, …) for the
   * next animation-frame pass. All queued reads run before all queued writes in that pass, so
   * interleaved call sites cannot force one synchronous reflow each. Callbacks are isolated: a
   * throwing one is reported and the rest still run.
   */
  batchRead(fn: () => void): void;
  /**
   * Queues a callback that writes layout (style mutations, DOM insertion, …) for the next
   * animation-frame pass, after every queued read has run. See `batchRead`.
   */
  batchWrite(fn: () => void): void;
  /**
   * The viewport the current scroll velocity predicts will be visible a moment from now, or
   * `undefined` when prefetch is disabled (`ViewConfig.prefetch`), the chart is not moving,
   * or the last scroll is too old to extrapolate. Data-producing plugins may use it to warm
   * caches for the region about to scroll in.
   */
  predictedViewport(): Readonly<Viewport> | undefined;
  // docs/specs/plugins/view.md
  /**
   * The chart pane's element — the renderer-owned container the canvases live in.
   *
   * Plugins that position their own chrome against the chart pane's box (a header band, a footer
   * chart, a side pane) read it here; the pane's CSS class names are a renderer-internal detail,
   * not a lookup contract. The element is created while the renderer starts up and is the same
   * element for the chart instance's whole lifetime.
   */
  chartPaneElement(): HTMLElement;
  // docs/specs/plugins/view.md
  /**
   * The resolved wheel-scroll speed multiplier, `1` unless the plugin was created with a usable
   * `wheelSpeedFactor`. Other wheel-scrolling panes that share the chart's vertical viewport (the
   * tree grid above all) read it here so one wheel notch moves every pane by the same amount.
   */
  wheelSpeedFactor(): number;
  // docs/specs/plugins/view.md
  /**
   * Scrolls the chart body programmatically. An omitted member leaves that axis untouched. The
   * jump is instant (no animation), the target is clamped to the scrollable range exactly like a
   * wheel scroll, and a position that actually changed emits `view/scrolled` as usual.
   */
  scrollTo(target: { scrollLeft?: number; scrollTop?: number }): void;
  // docs/specs/plugins/view.md
  /**
   * Draws the full layer composite into the supplied 2D context for a caller-chosen virtual
   * viewport, without touching what is on screen.
   *
   * Every registered layer contribution is invoked in its normal z order with the same coordinate
   * conventions as on-screen painting, but positioned by `viewport` rather than the live scroll
   * state — the caller picks any scroll offset and size, including ranges outside the scrollable
   * content, and receives the pixels (or, with a recording context, the drawing calls) for exactly
   * that window. On-screen canvases, scroll position, hover state and scheduled frames are
   * unaffected. Intended for exporters and thumbnailers; each layer's draw is fault-isolated the
   * same way as in the on-screen composite.
   */
  renderTo(g: CanvasRenderingContext2D, viewport: Readonly<Viewport>): void;
}

/* ------------------------------------------------------------------ *
 * Row geometry (the `renderer/rowGeometry` contribution)
 * ------------------------------------------------------------------ */

// docs/specs/plugins/view.md
/**
 * Row geometry supplied by whichever plugin owns the chart's row model, contributed to
 * `renderer/rowGeometry` (`first` — the first registered provider wins and the rest are never
 * consulted).
 *
 * Every member is called at draw time, once per pass, and no result is cached across paints, so a
 * provider is free to answer from live state. Because the view holds no reference to the
 * contributor, keeping the picture current is the contributor's job: invalidate the background
 * layer whenever the geometry moves.
 */
export interface RowGeometryProvider {
  rowCount(): number;
  /**
   * The row index under a content-space y. Implementations clamp an out-of-range query to the
   * nearest row rather than answering with a gap.
   */
  rowAtY(y: number): number;
  /** Row index → content-space y of the row's top edge. */
  yOf(row: number): number;
  rowHeight(row: number): number;
}
