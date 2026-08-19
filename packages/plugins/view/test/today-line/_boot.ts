/**
 * Shared boot helper for the today-line module tests: a real `Gantt.create()` over the fake DOM.
 *
 * The render module is real — `createRenderModule` — so the actual canvas, its `renderer/layers`
 * extension point and its rAF-batched paint loop are the ones the today-line module's contributed
 * pass draws through, exactly as in a live composition. The theme and timeline services it is
 * handed are minimal stand-ins, not the real modules: the theme stub's `get` reads the same
 * `getComputedStyle(root).getPropertyValue(token)` lookup the real theme module performs, so the
 * token-fallback and token-override tests exercise a real read rather than a canned value; the
 * timeline stub's `tToX` reproduces the "day" zoom level's linear day→px mapping from a
 * configurable origin. Every other member of both stand-ins is inert — the today-line module reads
 * nothing else off its `theme` and `scale` parameters.
 */
import { Gantt, createStore, definePlugin } from "@stargantt/core";
import type { AnyPlugin, GanttInstance, PluginContext } from "@stargantt/core";
import { MS_DAY } from "@stargantt/sdk";
import { normalizeViewConfig } from "../../src/config";
import type { TodayLineConfig } from "../../src/config";
import type { ViewService } from "../../src/index";
import { createRenderModule } from "../../src/internal/render/index";
import type { CanvasLayer, RenderModule, Viewport } from "../../src/internal/render/index";
import type { ThemeService, ThemeTokens } from "../../src/internal/theme/index";
import type { TimelineService, ZoomLevel } from "../../src/internal/timeline/index";
import { createTodayLineModule } from "../../src/internal/today-line/index";
import { asElement, installDom } from "../_utils/index";
import type {
  DomHarness,
  DomOptions,
  FakeCanvas,
  FakeContext2D,
  FakeElement,
} from "../_utils/index";

export interface Booted {
  dom: DomHarness;
  gantt: GanttInstance;
  pane: FakeElement;
  /**
   * The render module's own handle, for the assertions that predate the published service.
   *
   * `createTodayLineModule` is given this same object as its `render` argument and calls
   * `render.invalidate("main")` on it directly (never through the published `stargantt.view`
   * service), so a spy needs to sit on this handle — spying on the published service's own
   * `invalidate` would watch a different copy of the reference and see nothing.
   */
  render: RenderModule;
  canvas(layer: CanvasLayer): FakeCanvas;
  /** The `main` canvas's recording 2d context — where the today line lands. */
  main(): FakeContext2D;
  /** Runs the pending animation frames, i.e. performs one paint pass. */
  paint(): void;
}

export function probe(
  setup: (ctx: PluginContext) => void,
  id = "test.probe",
  dependsOn: string[] = ["stargantt.view"],
): AnyPlugin {
  return definePlugin({ meta: { id, dependsOn }, setup });
}

/** The one part of `TimelineConfig` these tests exercise: the axis origin. */
export interface ScaleConfig {
  origin?: number;
}

// the axis origin defaults to the start of the current UTC day; pinning it at epoch 0 keeps fixed
// pixel positions across the test suite.
const EPOCH_ORIGIN: ScaleConfig = { origin: 0 };

// Default `day` zoom level density: 40px per day (per the shared boot helpers elsewhere in the
// repo).
const PX_PER_DAY = 40;

/**
 * A stand-in for `TimelineService`: only `tToX` (and its inverse, `xToT`) do real work — the linear
 * day→px mapping the built-in "day" zoom level uses, anchored at `config.origin` (default the
 * epoch). Every other member is inert; the today-line module reads nothing else off its `scale`
 * parameter.
 */
export function stubTimelineService(config: ScaleConfig = EPOCH_ORIGIN): TimelineService {
  const origin = config.origin ?? 0;
  const pxPerMs = PX_PER_DAY / MS_DAY;
  const level: ZoomLevel = { id: "day", pxPerDay: PX_PER_DAY, scales: [] };
  return {
    tToX: (t) => (t - origin) * pxPerMs,
    xToT: (x) => origin + x / pxPerMs,
    pxPerMs,
    setZoomLevel: () => {},
    setOrigin: () => {},
    requestOriginExtension: () => {},
    releaseOriginExtension: () => {},
    levelMetrics: () => [{ id: level.id, pxPerDay: level.pxPerDay }],
    firstDayOfWeek: () => 1,
    unitBoundaries: () => [],
    formatDate: (t) => new Date(t).toISOString(),
    gridCellAt: () => undefined,
    zoomLevel: createStore<Readonly<ZoomLevel>>(level),
  };
}

/**
 * A stand-in for `ThemeService`: only `get` does real work, reading the same
 * `getComputedStyle(root).getPropertyValue(token)` lookup the real theme module performs, so a test
 * that stubs `--sg-today-line` / `--sg-status-line` through `installDom`'s `tokens` option exercises
 * a real read. Every other member is inert.
 */
export function stubThemeService(root: HTMLElement): ThemeService {
  return {
    get: (token) => {
      if (typeof globalThis.getComputedStyle !== "function") return "";
      return globalThis.getComputedStyle(root).getPropertyValue(token).trim();
    },
    audit: () => [],
    setPreset: () => {},
    preset: () => null,
    presets: () => [],
    setColorScheme: () => {},
    colorScheme: () => "auto",
    refresh: () => {},
    tokens: createStore<ThemeTokens>({}),
  };
}

/**
 * A stand-in for `RenderModule`, for the tests that drive `createTodayLineModule` directly against
 * a fake `PluginContext` instead of a full `boot()`: only `invalidate` records into `sink`, which
 * is the one member the module reads off its `render` parameter (the midnight-rollover timer's
 * `render.invalidate("main")`). Every other member is inert.
 */
export function stubRenderModule(sink: string[]): RenderModule {
  const viewport = createStore<Readonly<Viewport>>({
    scrollTop: 0,
    scrollLeft: 0,
    width: 0,
    height: 0,
  });
  return {
    invalidate: (layer) => void sink.push(layer),
    refreshInsets: () => {},
    direction: () => "ltr",
    reducedMotion: () => false,
    textWidth: () => 0,
    bidiIsolate: (text) => text,
    firstPaintMs: () => undefined,
    batchRead: (fn) => fn(),
    batchWrite: (fn) => fn(),
    predictedViewport: () => undefined,
    // Never read by these tests.
    chartPaneElement: () => ({}) as HTMLElement,
    wheelSpeedFactor: () => 1,
    scrollTo: () => {},
    renderTo: () => {},
    viewport,
    rowGeometry: () => undefined,
    fault: () => {},
  };
}

/**
 * The plugin the today-line module is exercised from: the real plugin id and the real render
 * module, so `dependsOn: ["stargantt.view"]` and `ctx.use("stargantt.view")` behave exactly as they
 * do in a full composition. The render module itself is also handed back through `sink`, for
 * `Booted.render` — see its doc comment for why that, and not the published service, is what a
 * test spies on. `config: false` mirrors `ViewConfig.todayLine: false`: the module is never
 * created, exactly as `setupView` skips it.
 */
function todayLinePlugin(
  scaleConfig: ScaleConfig,
  config: TodayLineConfig | false,
  sink: { render?: RenderModule },
): AnyPlugin {
  return definePlugin({
    meta: { id: "stargantt.view" },
    setup(ctx: PluginContext): void {
      const render: RenderModule = createRenderModule(ctx, {
        wheelSpeedFactor: 1,
        scrollbarEnabled: true,
        direction: "ltr",
        progressive: false,
        dirtyRegions: false,
        prefetch: false,
      });
      const theme = stubThemeService(ctx.root);
      const scale = stubTimelineService(scaleConfig);
      sink.render = render;

      // The same normalization `normalizeViewConfig` performs on `ViewConfig.todayLine`, so `false`
      // and an unusable `statusDate` behave exactly as they do in a full composition.
      const todayLine = normalizeViewConfig({ todayLine: config }).todayLine;
      if (todayLine !== undefined) {
        createTodayLineModule(ctx, todayLine.statusDateMs, render, theme, scale);
      }

      const service: ViewService = {
        invalidate: render.invalidate,
        refreshInsets: render.refreshInsets,
        direction: render.direction,
        reducedMotion: render.reducedMotion,
        textWidth: render.textWidth,
        bidiIsolate: render.bidiIsolate,
        firstPaintMs: render.firstPaintMs,
        batchRead: render.batchRead,
        batchWrite: render.batchWrite,
        predictedViewport: render.predictedViewport,
        chartPaneElement: render.chartPaneElement,
        wheelSpeedFactor: render.wheelSpeedFactor,
        scrollTo: render.scrollTo,
        renderTo: render.renderTo,
        viewport: render.viewport,
        // `viewMode` is owned by the panes module, not built here; nothing in this suite reads it.
        viewMode: { get: () => "split", subscribe: () => ({ dispose: () => {} }) },
      };
      ctx.provide("stargantt.view", service);
    },
  });
}

export function boot(
  extra: AnyPlugin[] = [],
  options: DomOptions = {},
  scaleConfig: ScaleConfig = EPOCH_ORIGIN,
  config: TodayLineConfig | false = {},
): Booted {
  const dom = installDom(options);
  const sink: { render?: RenderModule } = {};
  const gantt = Gantt.create({
    element: asElement(dom.root),
    plugins: [todayLinePlugin(scaleConfig, config, sink), ...extra],
  });

  const pane = dom.root.children[0];
  if (pane === undefined) throw new Error("chart pane was not created");
  const render = sink.render;
  if (render === undefined) throw new Error("render module was not created");

  const canvas = (layer: CanvasLayer): FakeCanvas => {
    const found = pane.children.find((c) => c.getAttribute("data-layer") === layer);
    if (found === undefined) throw new Error(`missing canvas for layer ${layer}`);
    return found as FakeCanvas;
  };

  return {
    dom,
    gantt,
    pane,
    render,
    canvas,
    main: (): FakeContext2D => {
      // The shared harness models `getContext("2d")` returning `null`, which a real browser can.
      const g = canvas("main").context;
      if (g === null) throw new Error("main canvas has no 2d context");
      return g;
    },
    paint: () => void dom.flushFrames(),
  };
}
