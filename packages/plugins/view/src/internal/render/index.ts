// docs/specs/plugins/view.md
/**
 * The render module of `stargantt.view` — the canvas host.
 *
 * Three layered canvases (background / main / overlay) + a DOM overlay, devicePixelRatio
 * handling, a fully custom virtual viewport (no native `scrollHeight`), an rAF-batched
 * invalidate/paint loop, and the six `renderer/*` extension points. It knows nothing about
 * *what* is drawn, and reads no sibling module.
 */
import { collect, createStore, first } from "@stargantt/core";
import type { PluginContext, Store, WritableStore } from "@stargantt/core";
import { PLUGIN_ID } from "../plugin-id";
// docs/specs/plugins/view.md — the DOM listener helper is shared, not forked.
import { listen, normalizeWheelDelta } from "@stargantt/sdk";
import { createReadWriteQueue } from "./batch";
import { bidiIsolate } from "./bidi";
import { createDirtyRegions } from "./dirty";
import { LAYER_ORDER, createChartDom, get2d, sizeLayer } from "./dom";
import { createFrameLoop } from "./frame";
import { createMotionWatcher } from "./motion";
import { createFirstPaintMeter } from "./perf";
import { createScrollPredictor } from "./prefetch";
import { createProgressiveDetail } from "./progressive";
import { createTextMeasureCache } from "./text";
import {
  asInsetLayout,
  assignInsetRects,
  createPlacementTracker,
  reduceInsets,
} from "./insets";
import { createLayerOrder, drawLayers, normalizeViewport, paintLayers } from "./layers";
import { createDomOverlays } from "./overlays";
import { createSafeAreaWriter, resolveSafeArea } from "./safearea";
import {
  createGestureMachine,
  createHoverMachine,
  createPointerClaim,
  isChartSurfaceTarget,
} from "./pointer";
import { clampAxis, resolveContentExtent, resolveWheelDelta } from "./scroll";
import { createScrollbars } from "./scrollbars";
import { createDprWatcher, paintableHeight, sameMetrics } from "./sizing";
import type { InsetLayout } from "./insets";
import type { PointerLike } from "./pointer";
import type { ContentExtent } from "./scroll";
import type { SurfaceMetrics } from "./sizing";
import type {
  CanvasLayer,
  ContentExtentContribution,
  DomOverlayContribution,
  HitResult,
  HitTester,
  InvalidateRect,
  LayerContribution,
  RenderSurface,
  RowGeometryProvider,
  Viewport,
} from "./types";

export type {
  CanvasLayer,
  ContentExtentContribution,
  DomOverlayContribution,
  HitResult,
  HitTester,
  InsetContribution,
  InsetRect,
  InvalidateRect,
  LayerContribution,
  RenderSurface,
  ResolvedInsets,
  RowGeometryProvider,
  Viewport,
} from "./types";

/* ------------------------------------------------------------------ *
 * Module
 * ------------------------------------------------------------------ */

/** The render module's handle: the public surface plus the seams its sibling modules read. */
export interface RenderModule extends RenderSurface {
  /**
   * The virtual viewport, published on every scroll and on every size/inset change, in the same
   * pass that composites. The value never carries `detail`: that hint describes a paint pass, not
   * the scroll state.
   */
  readonly viewport: Store<Readonly<Viewport>>;
  /** The contributed row geometry, or `undefined` when nothing contributes one. */
  rowGeometry(): RowGeometryProvider | undefined;
  /** Reports a fault raised while this plugin invoked a contributed callback. */
  fault(error: unknown): void;
}

/** The already-validated render options, closed over into the module. */
export interface RenderOptions {
  wheelSpeedFactor: number;
  scrollbarEnabled: boolean;
  direction: "ltr" | "rtl";
  progressive: boolean;
  dirtyRegions: boolean;
  prefetch: boolean;
}

/**
 * Wires the render module together: the chart DOM, the six extension points, and the feature
 * modules that hold the actual logic (the sibling files). Everything here is registration and
 * glue — the geometry, state machines and per-frame work live in those modules.
 */
export function createRenderModule(ctx: PluginContext, options: RenderOptions): RenderModule {
  const { wheelSpeedFactor, scrollbarEnabled } = options;
  /* --- §3.1 DOM ------------------------------------------------------ */
  const dom = createChartDom(ctx.root.ownerDocument);
  ctx.root.appendChild(dom.pane);
  const own = (dispose: () => void): void => ctx.own({ dispose });
  own(() => dom.pane.remove());

  const contexts: Record<CanvasLayer, CanvasRenderingContext2D> = {
    background: get2d(dom.canvases.background),
    main: get2d(dom.canvases.main),
    overlay: get2d(dom.canvases.overlay),
  };

  // docs/specs/plugins/view.md — the RTL switch: the pane carries
  // `dir="rtl"` so DOM chrome (scrollbars, overlays, contributed HTML) mirrors natively, and the
  // canvas contexts shape text right-to-left. With the default "ltr" nothing is touched, so the
  // rendered DOM stays byte-identical.
  if (options.direction === "rtl") {
    dom.pane.setAttribute("dir", "rtl");
    for (const name of LAYER_ORDER) {
      // `direction` is missing from some older 2d-context implementations; assigning it is inert
      // there and shapes text right-to-left everywhere it exists.
      (contexts[name] as CanvasRenderingContext2D & { direction?: string }).direction = "rtl";
    }
  }

  /* --- §3.3 virtual viewport (plain numbers; nothing is materialized) - */
  const vp: Viewport = { scrollTop: 0, scrollLeft: 0, width: 0, height: 0 };

  // docs/specs/plugins/view.md — the published viewport. A snapshot, not the live object: a held
  // reference must not mutate under its holder, and `detail` is deliberately absent (the
  // progressive-rendering hint describes a paint pass, not the scroll state).
  const viewportStore: WritableStore<Readonly<Viewport>> = createStore<Readonly<Viewport>>({
    ...vp,
  });

  /**
   * Publishes the current viewport.
   *
   * Called from the two mutation paths — a scroll that moved and a layout that resized — on the
   * same stack, so a subscriber observes the same state the composite is about to paint. A
   * subscriber that scrolls back synchronously re-enters the store and is refused by the core's
   * re-entrancy guard, which is the documented rule: react by scheduling, never by writing back.
   */
  function publishViewport(): void {
    viewportStore.set({
      scrollTop: vp.scrollTop,
      scrollLeft: vp.scrollLeft,
      width: vp.width,
      height: vp.height,
    });
  }

  function fault(error: unknown): void {
    // §1.9 / function-shaped contributions are invoked by the point-owning plugin, which
    // must guard them and report via `core/pluginError`. The contributor's own plugin id is not
    // observable through the public API, so the invoking plugin (this one) is reported.
    ctx.emit("core/pluginError", { pluginId: PLUGIN_ID, error });
  }

  /* --- §1.6 extension points ---------------------------------------- */
  function guardHitTester(fn: HitTester): HitTester {
    return (x, y) => {
      try {
        return fn(x, y);
      } catch (error) {
        fault(error);
        return undefined;
      }
    };
  }

  const layersPoint = ctx.defineExtensionPoint("renderer/layers", collect<LayerContribution>());
  const hitPoint = ctx.defineExtensionPoint(
    "renderer/hitTest",
    (inputs: HitTester[]): HitTester =>
      first<[x: number, y: number], HitResult>()(inputs.map(guardHitTester)),
  );
  // docs/specs/plugins/view.md
  // a pure reducer: it maps the contributions to the per-side sums plus the ordered strip
  // list, and the consumer below reads the strips off the reduced value. `get()` is reference-stable
  // while the contribution set is unchanged (docs/specs/architecture.md §1.4), so this costs one
  // reduction per contribution rather than one per read.
  const insetPoint = ctx.defineExtensionPoint("renderer/insets", reduceInsets);
  const domOverlayPoint = ctx.defineExtensionPoint(
    "renderer/domOverlays",
    collect<DomOverlayContribution>(),
  );
  const contentExtentPoint = ctx.defineExtensionPoint(
    "renderer/contentExtent",
    collect<ContentExtentContribution>(),
  );
  // docs/specs/plugins/view.md — `first`: the first registered provider wins and the others are
  // never consulted. The members are objects rather than functions, so the composition is the
  // plain "first contribution" fold rather than the core's function-shaped `first()` helper.
  const rowGeometryPoint = ctx.defineExtensionPoint(
    "renderer/rowGeometry",
    (inputs: RowGeometryProvider[]): RowGeometryProvider | undefined => inputs[0],
  );

  /**
   * The reserved bands and the strips that make them up.
   *
   * docs/specs/plugins/view.md — the reduction is re-run here on every read
   * rather than served from the point's cache. `get()` is reference-stable while the *contribution
   * set* is unchanged (docs/specs/architecture.md §1.4), which is not the same as the *sizes*
   * being unchanged:
   * a strip whose size follows the data (load-chart's lanes) mutates its own contribution in
   * place and asks for a re-layout through `refreshInsets()`. Both invalidation triggers — a
   * changed contribution set (a new `get()` reference) and `refreshInsets()`/resize (which land in
   * `syncSize()`, clearing the cache below) — funnel through here, so the reduced value can be
   * cached between them: `localPoint()` reads it once per raw `pointermove`, and re-running the
   * reduction (a map + sort) on every pointer report was measurable churn for a value that only
   * changes on those two triggers.
   */
  let insetCacheSource: unknown = null;
  let insetCache: InsetLayout | null = null;
  function insets(): InsetLayout {
    const registered = asInsetLayout(insetPoint.get());
    if (insetCache !== null && insetCacheSource === registered) return insetCache;
    insetCacheSource = registered;
    insetCache = reduceInsets(registered.strips.map((placement) => placement.contribution));
    return insetCache;
  }

  /**
   * The resolved content extent per axis.
   *
   * Called at every clamp — never cached across calls, since the content size tracks live data
   * (docs/specs/plugins/view.md).
   */
  function measureExtent(): ContentExtent {
    return resolveContentExtent(contentExtentPoint.get(), fault);
  }

  /** Contributions in zIndex order, recomputed only when the contribution set changes. */
  const orderedLayers = createLayerOrder(() => layersPoint.get());

  /* --- §1 / ordered-strip insets -------------------------------- */
  const stripPlacements = createPlacementTracker();

  /** Assigns every strip its rectangle and reports the ones that moved to their `placed`. */
  function placeStrips(bodyWidth: number, bodyHeight: number): void {
    const assigned = assignInsetRects(insets().strips, bodyWidth, bodyHeight);
    for (const placement of stripPlacements.moved(assigned)) {
      const placed = placement.contribution.placed;
      if (typeof placed !== "function") continue;
      try {
        // §3 fault isolation — each contributed callback is guarded individually.
        placed.call(placement.contribution, placement.rect);
      } catch (error) {
        fault(error);
      }
    }
  }

  /* --- §5 overlay safe area --------------------------- */
  // The four `--sg-safe-*` lengths are published on the pane itself, so a corner-anchored overlay
  // positions with plain CSS (`calc(var(--sg-safe-top, 0px) + 8px)`) and needs no event: the
  // browser recomputes every dependent `var()` when a value is rewritten. They are outputs of this
  // layout, not theme tokens — nothing declares them in the stylesheet and `ThemeService.get`,
  // which reads the chart root, cannot reach them.
  const safeArea = createSafeAreaWriter(dom.pane.style);

  /* --- §4 DOM overlays ---------------------------------------- */
  const overlays = createDomOverlays({
    region: dom.domOverlay,
    contributions: () => domOverlayPoint.get(),
    scroll: () => ({ left: vp.scrollLeft, top: vp.scrollTop }),
    own,
    onFault: fault,
  });

  /* --- §3 pointer ownership ------------------------------------------- */
  // The canvas gesture, the scrollbar thumb drag and the hover resolution are mutually exclusive,
  // and this claim is what enforces it: whichever machine holds the pointer keeps it until it ends,
  // and hover resolves only while the pointer is free.
  const claim = createPointerClaim();

  /* --- synthetic scrollbars ----------------------------- */
  const scrollbars = createScrollbars({
    pane: dom.pane,
    enabled: scrollbarEnabled,
    direction: options.direction,
    claim,
    viewState: () => ({ vp, insets: insets(), extent: measureExtent() }),
    scrollAxisTo: (axis, offset) => {
      if (axis === "vertical") setScroll(vp.scrollLeft, offset);
      else setScroll(offset, vp.scrollTop);
    },
    scheduleFrame: () => frame.schedule(),
    listen: (el, type, fn) => listen(ctx, el, type, fn),
    own,
  });

  /* --- §3.2 rendering pipeline --------------------------------------- */
  const frame = createFrameLoop(runFrame);

  /* --- §6 default-off performance features ---------------------------- */
  // §6.2 — time to the first completed composite, exposed as `firstPaintMs()`.
  const firstPaint = createFirstPaintMeter();
  // §6.6 — the measureText cache behind `textWidth()`.
  const textCache = createTextMeasureCache();
  // §6.8 — layout read/write batching behind `batchRead` / `batchWrite`.
  const batch = createReadWriteQueue(() => frame.schedule());
  // §6.3 — coarse frames while scrolling, one fine repaint after the quiet period.
  const progressive = createProgressiveDetail({
    enabled: options.progressive,
    onRefine: () => invalidateAllLayers(),
  });
  own(() => progressive.dispose());
  // §6.5 — scroll extrapolation behind `predictedViewport()` and the warm pass below.
  const predictor = createScrollPredictor({ enabled: options.prefetch });
  // §6.4 — per-layer dirty-rect union; disabled, every repaint is full (historical behavior).
  const dirtyRegions = createDirtyRegions(options.dirtyRegions);

  // §6.4 — every full invalidation must clear a pending partial region, or a later rect-only
  // repaint would wrongly clip a repaint that owed the whole viewport.
  function invalidateAllLayers(): void {
    for (const name of LAYER_ORDER) dirtyRegions.add(name);
    frame.invalidateAll();
  }

  /** A lazily created off-screen surface the prefetch warm pass composites into. */
  let warmContext: CanvasRenderingContext2D | null | undefined;
  /** The warm surface's element, kept so it can be resized to track the viewport. */
  let warmCanvas: HTMLCanvasElement | null = null;

  // §6.5 — the warm pass: composite the predicted viewport off screen so contribution-side caches
  // (text measurements, resolved colors, generated paths) are populated before the region scrolls
  // in. Purely additive: it touches no on-screen canvas, no dirty flag and no scroll state.
  function warmPrefetch(): void {
    if (!options.prefetch) return;
    const predicted = predictor.predict(vp);
    if (predicted === undefined) return;
    if (warmContext === undefined) {
      try {
        const canvas = ctx.root.ownerDocument.createElement("canvas") as HTMLCanvasElement;
        warmContext = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
        warmCanvas = warmContext === null ? null : canvas;
      } catch {
        warmContext = null;
      }
    }
    if (warmContext === null || warmContext === undefined) return;
    // The warm surface tracks the viewport: at the 300×150 element default nearly everything the
    // predicted viewport covers would be clipped away before a contribution's caches got warm.
    if (warmCanvas !== null) {
      const w = Math.max(1, Math.round(vp.width));
      const h = Math.max(1, Math.round(vp.height));
      if (warmCanvas.width !== w) warmCanvas.width = w;
      if (warmCanvas.height !== h) warmCanvas.height = h;
    }
    drawLayers(warmContext, predicted, orderedLayers(), null, fault);
  }

  function runFrame(): void {
    // docs/specs/plugins/view.md — a scroll position left out of
    // the reach of a shrunk viewport or extent is pulled back no later than this paint pass.
    reclampScroll();
    // §6.8 — queued layout reads run before queued layout writes, once per pass.
    batch.flush(fault);
    // §4.4 — creation and the `mount` calls happen no later than the first paint pass; §4.5 — the
    // wrapper offsets are updated in the same pass that composites the layers.
    overlays.build();
    overlays.sync(vp.scrollLeft, vp.scrollTop);
    // Hover first: it reads layout, and painting only touches canvases, so nothing between the two
    // can invalidate the measurement.
    hover.resolve();
    // §6.3 — with progressive rendering off, `detail()` is undefined and the untouched `vp` object
    // is painted with, exactly as before.
    const detail = progressive.detail();
    const paintVp: Readonly<Viewport> = detail === undefined ? vp : { ...vp, detail };
    paintLayers(contexts, paintVp, orderedLayers(), frame.claimDirty, fault, (layer) =>
      dirtyRegions.take(layer),
    );
    firstPaint.markPaint();
    // the thumb tracks the scroll position within the same frame as the canvas composite.
    scrollbars.update();
    // §6.5 — after the visible frame is out, warm the predicted next viewport.
    warmPrefetch();
  }

  own(() => frame.dispose());

  // docs/specs/plugins/view.md
  /**
   * The off-screen composite: every layer contribution, in the same z order and coordinate space
   * the on-screen pass uses, drawn into a caller-supplied surface for a caller-supplied viewport.
   *
   * Nothing on screen is read or written: the live viewport, the dirty flags, the hover state and
   * the frame schedule are all untouched, and no canvas of the renderer's own is drawn into. The
   * target is composited onto as it arrives — it is not cleared, so a caller reusing a surface
   * clears it itself — and only the members the on-screen composite uses (`save` / `restore`, plus
   * whatever the contributions call) are touched, which is what lets a recording proxy stand in for
   * a real context.
   */
  function renderTo(target: CanvasRenderingContext2D, viewport: Readonly<Viewport>): void {
    if (target === null || typeof target !== "object") return;
    drawLayers(target, normalizeViewport(viewport), orderedLayers(), null, fault);
  }

  /* --- §3.2-4 devicePixelRatio + sizing ------------------------------ */
  /** The metrics the canvases were last sized for; `null` until the first pass. */
  let sized: SurfaceMetrics | null = null;

  /**
   * Re-measures the pane and re-sizes the canvases to it.
   *
   * Returns whether the backing stores were re-sized — i.e. whether the surfaces were cleared and
   * now owe a repaint. Callers that clear on a user-visible frame pay that debt through
   * `resyncAndPaint()` below; the first-paint callers ignore it.
   */
  function syncSize(): boolean {
    // Every `refreshInsets()`, resize and DPR change arrives here: drop the cached inset
    // reduction so an in-place strip mutation is re-read below.
    insetCache = null;
    const rect = dom.pane.getBoundingClientRect();
    // docs/specs/plugins/view.md — the insets reserve chrome
    // space: the canvases and the DOM overlay sit between the top and bottom bands and the viewport
    // height excludes both.
    const inset = insets();
    const metrics: SurfaceMetrics = {
      width: rect.width,
      height: rect.height,
      dpr: globalThis.devicePixelRatio || 1,
      insetTop: inset.top,
      insetBottom: inset.bottom,
    };
    // strip placement is reported before the size early-out, because a stack can be
    // rearranged (a strip moving within the same total) without the per-side sums changing.
    placeStrips(metrics.width, metrics.height);
    // docs/specs/plugins/view.md — the safe area is published in
    // the same pass that re-places the strips and from the same read of them, so an overlay's CSS
    // can never see a band the strips have already moved past. This is every trigger the rule
    // names: setup, resize, DPR change and `refreshInsets()` all arrive here, and it sits before
    // the size early-out so the write is driven by the bands rather than by the canvas metrics.
    // The direction is the one the bars themselves mirror by (§6.1) and is fixed at creation, so
    // it is read from the same options object rather than tracked.
    safeArea.write(resolveSafeArea(inset, scrollbarEnabled, options.direction));
    if (sameMetrics(sized, metrics)) return false;
    sized = metrics;
    const height = paintableHeight(metrics);
    vp.width = metrics.width;
    vp.height = height;
    dom.domOverlay.style.top = `${metrics.insetTop}px`;
    dom.domOverlay.style.height = `${height}px`;
    // §4.5 — resize and inset changes re-size the clip host, keeping it on the viewport rectangle.
    overlays.resize(vp.width, vp.height);
    for (const name of LAYER_ORDER) {
      const canvas = dom.canvases[name];
      canvas.style.top = `${metrics.insetTop}px`;
      sizeLayer(canvas, contexts[name], metrics.width, height, metrics.dpr);
    }
    // a viewport that grew may leave the current scroll position past the new maximum.
    reclampScroll();
    invalidateAllLayers();
    // A resize or an inset change moved the viewport's size, which the store carries too.
    publishViewport();
    return true;
  }

  // docs/specs/plugins/view.md — `sizeLayer` re-initializes each backing
  // store, so the canvases are transparent the moment the size is written. They carry no background
  // of their own, so a repaint left to the frame clock would let the host background be composited
  // for one frame: a white (or, in a dark theme, near-black) flash on every resize. Painting here,
  // on the handler's own stack, keeps the clear and the repaint in one frame. Nothing is painted
  // more often for it — `ResizeObserver` delivers at most one callback per frame either way.
  function resyncAndPaint(): void {
    if (syncSize()) frame.flush();
  }

  const dpr = createDprWatcher(() => {
    // §6.6 — a DPR change (monitor move, browser zoom) can change text rasterization metrics, so
    // the measured-width cache is dropped with it.
    textCache.clear();
    resyncAndPaint();
  });
  own(() => dpr.dispose());

  // §6.7 — the reduced-motion source of truth, one live media-query subscription. Subscribed after
  // the DPR watcher, whose query being the first `matchMedia` subscription is observable order.
  const motion = createMotionWatcher();
  own(() => motion.dispose());

  if (typeof globalThis.ResizeObserver === "function") {
    const ro = new globalThis.ResizeObserver(() => resyncAndPaint());
    ro.observe(dom.pane);
    own(() => ro.disconnect());
  } else if (typeof globalThis.addEventListener === "function") {
    const onResize = (): void => resyncAndPaint();
    globalThis.addEventListener("resize", onResize);
    own(() => globalThis.removeEventListener("resize", onResize));
  }

  /* --- §3.4 hit testing + pointer capture ---------------------------- */
  /**
   * Client coordinates to viewport-local ones.
   *
   * The pane's box is measured on each call rather than cached, because it moves whenever an
   * ancestor scrolls or reflows — neither of which the resize and DPR paths observe. Callers keep
   * the cost down by calling this at most once per gesture event or once per frame (hover), never
   * once per pointer report.
   */
  function localPoint(e: PointerLike): { x: number; y: number } {
    // During a gesture the box is measured once per raw `pointermove`: `pointer/barMove` must be
    // delivered synchronously with exact coordinates, so it cannot ride the frame clock.
    const rect = dom.pane.getBoundingClientRect();
    // The viewport starts below the reserved top band, so its origin is offset from
    // the pane's by the top inset; subtracting it keeps hit-test coordinates in the space `draw`
    // paints in. The bottom band only shortens the viewport and does not move its origin.
    return { x: e.clientX - rect.left, y: e.clientY - rect.top - insets().top };
  }

  /** Viewport-local CSS pixels — the same space `LayerContribution.draw` paints in. */
  function hitAt(x: number, y: number): HitResult | undefined {
    const tester = hitPoint.get();
    if (typeof tester !== "function") return undefined;
    return tester(x, y);
  }

  const hover = createHoverMachine({
    claim,
    localPoint,
    hitAt,
    onHover: (hit, x, y) => {
      ctx.emit("pointer/barHover", hit === undefined ? { x, y } : { hit, x, y });
    },
    setCursor: (cursor) => {
      dom.pane.style.cursor = cursor;
    },
  });

  const gestures = createGestureMachine({
    pane: dom.pane,
    claim,
    localPoint,
    hitAt,
    // No hover is resolved during a gesture, so a move recorded just before the press is dropped.
    onStart: () => hover.discard(),
    sink: {
      barDown: (hit, x, y, event) => ctx.emit("pointer/barDown", { hit, x, y, event }),
      background: (x, y, event) => ctx.emit("pointer/background", { x, y, event }),
      barMove: (hit, x, y, event) => {
        ctx.emit(
          "pointer/barMove",
          hit === undefined ? { x, y, event } : { hit, x, y, event },
        );
      },
      barUp: (hit, x, y, event) => {
        ctx.emit("pointer/barUp", hit === undefined ? { x, y, event } : { hit, x, y, event });
      },
    },
  });

  // docs/specs/plugins/view.md — "Pointer events" /
  // docs/specs/plugins/view.md — the chart surface is the pane and its layer
  // canvases; everything else the pane hosts (the DOM-overlay region, corner-slot widgets other
  // plugins mount) keeps its native pointer/click/focus stream.
  const chartSurfaces: readonly unknown[] = LAYER_ORDER.map((layer) => dom.canvases[layer]);

  listen(ctx, dom.pane, "pointerdown", (e) => {
    // An overlay press starts no gesture, captures no pointer and emits no `pointer/*`.
    if (!isChartSurfaceTarget(e.target, dom.pane, chartSurfaces)) return;
    gestures.onDown(e);
  });
  listen(ctx, dom.pane, "pointerup", (e) => gestures.onEnd(e));
  // A cancelled capture (the browser taking the pointer over for a scroll or a system gesture) ends
  // the gesture exactly like a release: one `pointer/barUp`, never zero and never two.
  listen(ctx, dom.pane, "pointercancel", (e) => gestures.onEnd(e));
  listen(ctx, dom.pane, "pointermove", (e) => {
    if (gestures.onMove(e)) return;
    hover.record(e);
    // Rides the existing paint frame: scheduling is a no-op when a pass is already queued, and the
    // pass repaints nothing when no layer is dirty.
    frame.schedule();
  });

  /* --- §3.3 fully custom virtual scroll (no native scrollHeight) ----- */
  /**
   * The single scroll path: clamps the target to the scrollable range, repaints, and announces a
   * position that actually moved. Wheel input, `RendererService.scrollTo` and the scrollbar thumb
   * drag share it, so the "reusing the existing clamp + `view/scrolled` path" is structural
   * rather than duplicated.
   */
  function setScroll(left: number, top: number): void {
    // docs/specs/plugins/view.md
    // every scroll mutation clamps to the resolved content extent, unbounded on an axis
    // nothing contributes to.
    const extent = measureExtent();
    const scrollLeft = clampAxis(left, extent.width, vp.width);
    const scrollTop = clampAxis(top, extent.height, vp.height);
    if (scrollTop === vp.scrollTop && scrollLeft === vp.scrollLeft) return;
    vp.scrollTop = scrollTop;
    vp.scrollLeft = scrollLeft;
    invalidateAllLayers();
    scrollbars.noteActivity();
    // §6.3 / §6.5 — the progressive and prefetch machines observe every scroll through this one
    // path; both are inert no-ops when their option is off.
    progressive.noteScroll();
    predictor.sample(scrollLeft, scrollTop);
    // The store first, the retained input event second: both channels describe the same committed
    // position, and a listener that scrolls again from the event keeps working as it always did.
    publishViewport();
    ctx.emit("view/scrolled", { scrollTop, scrollLeft });
  }

  /**
   * Re-applies the clamp to the current scroll position, without moving it on purpose.
   *
   * Pulls `scrollTop`/`scrollLeft` back when a shrinking viewport or content extent has left them
   * past the new maximum (docs/specs/plugins/view.md — 's re-clamp
   * rule); a no-op — silent, like any unchanged `setScroll` — when the current position is still
   * within range.
   */
  function reclampScroll(): void {
    setScroll(vp.scrollLeft, vp.scrollTop);
  }

  listen(
    ctx,
    dom.pane,
    "wheel",
    (e) => {
      e.preventDefault();
      // docs/specs/plugins/view.md — line/page `deltaMode` units resolve to
      // CSS px first (the shared normalization), so a line-mode wheel scrolls by pixels here
      // exactly like a pixel-mode one.
      const px = normalizeWheelDelta(e, vp.height);
      // docs/specs/plugins/view.md — the pane owns the whole gesture, so it
      // performs the Shift axis swap the browser's own scroller would have performed.
      const { dx, dy } = resolveWheelDelta({ deltaX: px.dx, deltaY: px.dy, shiftKey: e.shiftKey });
      // docs/specs/plugins/view.md — the speed factor multiplies the resolved
      // deltas *before* the clamp.
      setScroll(vp.scrollLeft + dx * wheelSpeedFactor, vp.scrollTop + dy * wheelSpeedFactor);
    },
    { passive: false },
  );

  /* --- §1.5-5 first paint on lifecycle/ready ------------------------- */
  ctx.on("lifecycle/ready", () => {
    syncSize();
    invalidateAllLayers();
  });

  syncSize();

  const surface: RenderSurface = {
    // §6.4 — a rect narrows the repaint only when `dirtyRegions` is on; the region tracker is an
    // inert no-op otherwise, so the historical full-repaint behavior is untouched.
    invalidate: (layer, rect) => {
      dirtyRegions.add(layer, rect);
      frame.invalidate(layer);
    },
    // docs/specs/plugins/view.md — the pull a contributor uses when its own
    // strip size changed for a reason `syncSize`'s own triggers (resize, DPR) never observe.
    // `syncSize` already re-reads the extension point, re-places the strips, early-outs on
    // unchanged metrics and re-clamps plus invalidates when they did change — so the whole rule
    // is this one call. It clears the canvases exactly as a resize does, so it repaints on the
    // caller's stack too. Called from inside a paint pass, the frame loop's re-entrancy
    // guard drops the same-stack repaint — a pass cannot nest inside itself — and the invalidation
    // schedules an ordinary next-frame pass instead.
    refreshInsets: () => resyncAndPaint(),
    // §6.1 — the composition-wide base direction, fixed at creation.
    direction: () => options.direction,
    // §6.7 — the one live reduced-motion subscription.
    reducedMotion: () => motion.reduced(),
    // §6.6 — the bounded measureText cache.
    textWidth: (g, text) => textCache.width(g, String(text)),
    // §6.9 — directional-isolate wrapping for mixed-direction labels.
    bidiIsolate: (text, base) => bidiIsolate(text, base === "ltr" || base === "rtl" ? base : undefined),
    // §6.2 — time from setup to the first completed composite.
    firstPaintMs: () => firstPaint.ms(),
    // §6.8 — layout read/write batching, drained reads-then-writes once per paint pass.
    batchRead: (fn) => batch.read(fn),
    batchWrite: (fn) => batch.write(fn),
    // §6.5 — the extrapolated viewport, or undefined while disabled / at rest.
    predictedViewport: () => predictor.predict(vp),
    // docs/specs/plugins/view.md — the sanctioned replacement for the
    // `.sg-pane--chart` class-string lookup consumers used to run: the pane is created in this
    // `setup()` and lives as long as the instance, so the accessor is a plain read of it.
    chartPaneElement: () => dom.pane,
    // docs/specs/plugins/view.md — the shared-speed seam: the tree grid's
    // vertical wheel multiplies by the same resolved factor this pane's own wheel path uses.
    wheelSpeedFactor: () => wheelSpeedFactor,
    // docs/specs/plugins/view.md — instant jump only; a non-finite or omitted
    // member leaves that axis where it was.
    scrollTo: (target) => {
      const pick = (value: number | undefined, current: number): number =>
        typeof value === "number" && Number.isFinite(value) ? value : current;
      setScroll(pick(target?.scrollLeft, vp.scrollLeft), pick(target?.scrollTop, vp.scrollTop));
    },
    // docs/specs/plugins/view.md — the off-screen composite for exporters and
    // thumbnailers: same contributions, same z order, a virtual viewport of the caller's choosing.
    renderTo,
  };

  return {
    ...surface,
    viewport: viewportStore,
    rowGeometry: () => rowGeometryPoint.get(),
    fault,
  };
}
