/**
 * Shared boot helper for the timeline-module tests: a real `Gantt.create()` over the fake DOM, with
 * only the parts of `stargantt.view` the time axis actually stands on.
 *
 * The six formerly-separate modules merged into one, so booting the whole `view()` factory would also raise the
 * pane row and the two background line passes — none of which these tests are about, and all of
 * which contribute layers and insets that would move the geometry they inspect. The module factory
 * is the seam that keeps the module isolation: `createTimelineModule` is called directly and its handle
 * is published under the real service key, so the probes below read exactly the surface a
 * third-party plugin reads.
 *
 * Unlike the render- and theme-module suites, the two siblings are built for real rather than
 * stubbed. The header canvas is positioned over the render module's chart pane, follows its
 * viewport store and repaints on its theme's token store, and the anchored zoom compensates through
 * its `scrollTo` clamp — a stub of either would be a re-implementation of the behaviour under
 * test.
 * The one dependency that *is* doubled is the task store, which only the origin guard reads.
 */
import { Gantt, createStore, definePlugin } from "@stargantt/core";
import type { AnyPlugin, GanttInstance, PluginContext } from "@stargantt/core";
import { dataStore } from "@stargantt/plugin-data-store";
import type { DataService, Task, TaskId } from "@stargantt/plugin-data-store";
import { createRenderModule } from "../../src/internal/render/index";
import type { RenderOptions } from "../../src/internal/render/index";
import { createThemeModule } from "../../src/internal/theme/index";
import { createTimelineModule } from "../../src/internal/timeline/index";
import type { TimelineDataSource, TimelineService } from "../../src/internal/timeline/index";
import type { TimelineConfig } from "../../src/config";
import type { ViewService } from "../../src/index";
import { asElement, installDom, wheelEvent } from "../_utils/index";
import type {
  DomHarness,
  DomOptions,
  FakeCanvas,
  FakeContext2D,
  FakeElement,
} from "../_utils/index";

/**
 * A fake canvas whose 2d context is known to exist.
 *
 * The shared harness models `getContext("2d")` returning `null`, which a real browser can; every
 * canvas this file hands out has one, so the narrowing is done once here.
 */
export type PaintedCanvas = FakeCanvas & { context: FakeContext2D };

function painted(canvas: FakeCanvas): PaintedCanvas {
  if (canvas.context === null) throw new Error("canvas has no 2d context");
  return canvas as PaintedCanvas;
}

/** What `normalizeViewConfig` produces for the render group with no `ViewConfig` at all. */
const RENDER_OPTIONS: RenderOptions = {
  wheelSpeedFactor: 1,
  scrollbarEnabled: true,
  direction: "ltr",
  progressive: false,
  dirtyRegions: false,
  prefetch: false,
};

export interface Booted {
  dom: DomHarness;
  gantt: GanttInstance;
  /** The timeline module's dedicated header canvas. */
  header: PaintedCanvas;
  root: FakeElement;
  /** The render module's chart pane — the element its virtual-scroll wheel handler sits on. */
  pane: FakeElement;
  /** One of the render module's three canvases, by `data-layer`. */
  layer(name: "background" | "main" | "overlay"): PaintedCanvas;
}

export function probe(
  setup: (ctx: PluginContext) => void,
  id = "test.probe",
  dependsOn: string[] = ["stargantt.view"],
): AnyPlugin {
  return definePlugin({ meta: { id, dependsOn }, setup });
}

/**
 * Default config for `boot`: origin pinned at epoch 0.
 *
 * The axis origin is configurable and defaults to the start of the current UTC day, which would
 * make every pixel assertion below depend on the day the suite runs. Pinning it makes the whole
 * suite deterministic; the *default* origin is covered by its own tests, which pass an explicit
 * `{}`.
 */
const EPOCH_ORIGIN: TimelineConfig = { origin: 0 };

/* ------------------------------------------------------------------ *
 * The task store the origin guard follows
 * ------------------------------------------------------------------ */

/** How much of the task store the timeline module read, counted at its own seam. */
export interface StoreReads {
  /** Whole-store walks: reads of `tasks`, which is the guard's escalation path. */
  full: number;
}

/** An empty task store, for the compositions that carry no data-store plugin. */
function emptyDataSource(): TimelineDataSource {
  return { tasks: createStore<ReadonlyMap<TaskId, Readonly<Task>>>(new Map()) };
}

/**
 * Wraps a data source so every read the timeline module makes is counted.
 *
 * The guard's incremental path derives its answer from the snapshot pair the subscription already
 * hands it, so a `tasks.get()` can only be the whole-store walk — which is precisely the work the
 * §1.17 budget tests are about.
 */
function countingDataSource(source: TimelineDataSource, reads: StoreReads): TimelineDataSource {
  return {
    tasks: {
      get: () => {
        reads.full++;
        return source.tasks.get();
      },
      subscribe: (fn) => source.tasks.subscribe(fn),
    },
  };
}

/* ------------------------------------------------------------------ *
 * The harness plugin
 * ------------------------------------------------------------------ */

/**
 * The plugin the timeline module is published from: the real plugin id and the real service keys,
 * so `dependsOn: ["stargantt.view"]`, `ctx.use("stargantt.view")` and
 * `ctx.use("stargantt.timeline")` behave exactly as they do in a full composition.
 *
 * `viewMode` is the one `ViewService` member no module built here owns; nothing in this suite reads
 * it, and it is stubbed with an inert store rather than pulling in the panes module.
 */
function timelinePlugin(
  config: TimelineConfig,
  data: { source?: TimelineDataSource; reads?: StoreReads },
): AnyPlugin {
  const useDataStore = data.source === undefined;
  return definePlugin({
    meta: {
      id: "stargantt.view",
      // Declared only when the store is actually in the composition: the plain `boot` runs without
      // one, which is the "no data store" case §1.17 has its own test for.
      dependsOn: useDataStore ? ["stargantt.data-store"] : [],
    },
    setup(ctx: PluginContext): void {
      const render = createRenderModule(ctx, RENDER_OPTIONS);
      const theme = createThemeModule(ctx, {}, render);
      let source = data.source;
      if (source === undefined) {
        const store = ctx.use("stargantt.data");
        source = { tasks: store.tasks };
      }
      const reads = data.reads;
      const timeline = createTimelineModule(
        ctx,
        config,
        render,
        theme,
        reads === undefined ? source : countingDataSource(source, reads),
      );

      const view: ViewService = {
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
        viewMode: { get: () => "split", subscribe: () => ({ dispose: () => {} }) },
      };
      ctx.provide("stargantt.view", view);
      ctx.provide("stargantt.theme", theme);
      ctx.provide("stargantt.timeline", timeline);
    },
  });
}

/** Finds the harness's pieces in the freshly created DOM. */
function collectDom(dom: DomHarness, gantt: GanttInstance): Booted {
  const header = dom.root.children.find(
    (c) => c.getAttribute("data-sg-header") === "timeline-scale",
  );
  if (header === undefined) throw new Error("header canvas was not created");

  const pane = dom.root.children[0];
  if (pane === undefined) throw new Error("chart pane was not created");

  const layer = (name: "background" | "main" | "overlay"): PaintedCanvas => {
    const found = pane.children.find((c) => c.getAttribute("data-layer") === name);
    if (found === undefined) throw new Error(`missing canvas for layer ${name}`);
    return painted(found as FakeCanvas);
  };

  return { dom, gantt, header: painted(header as FakeCanvas), root: dom.root, pane, layer };
}

export function boot(
  extra: AnyPlugin[] = [],
  options: DomOptions = {},
  config: TimelineConfig = EPOCH_ORIGIN,
  // Omitted means `ctx.locale` is `"en"`, which is what every pre-existing test relies on.
  locale?: string,
): Booted {
  const dom = installDom(options);
  const gantt = Gantt.create({
    element: asElement(dom.root),
    plugins: [timelinePlugin(config, { source: emptyDataSource() }), ...extra],
    ...(locale === undefined ? {} : { locale }),
  });
  return collectDom(dom, gantt);
}

export interface BootedWithStore extends Booted {
  data: DataService;
  renderer: ViewService;
  /** The half-open time span the chart pane currently shows, in epoch milliseconds. */
  visibleRange(): { from: number; to: number };
  /**
   * Every `core/pluginError` the merged plugin reported since boot, newest last.
   *
   * The six formerly-separate modules share one id now, so this can no longer be narrowed to the timeline module
   * alone; in practice only the origin guard reports anything in these compositions, since nothing
   * here contributes the foreign callbacks the render module guards.
   */
  faults: unknown[];
  /**
   * Zeroes the task-store read counters and hands back the live object, so a test can budget the
   * work one gesture costs without counting what startup already did.
   */
  countStoreReads(): StoreReads;
}

/**
 * `boot`, plus the official data store, for the origin-reachability rules of §1.16 / §1.17.
 *
 * The store is a real `dataStore()` rather than a double: the guard follows `DataService.tasks`,
 * and the incremental path it takes depends on the store publishing one snapshot per transaction
 * with the untouched entries kept by identity — which only the real implementation does.
 */
export function bootWithStore(
  config: TimelineConfig,
  options: DomOptions = {},
  extra: AnyPlugin[] = [],
): BootedWithStore {
  const faults: unknown[] = [];
  const collect = definePlugin({
    meta: { id: "test.fault-collector" },
    setup: (ctx: PluginContext) => {
      ctx.on("core/pluginError", (e) => {
        if (e.pluginId === "stargantt.view") faults.push(e.error);
      });
    },
  });
  const reads: StoreReads = { full: 0 };
  const dom = installDom(options);
  // The store is listed *after* the plugin that reads it: `dependsOn` is what orders startup, so
  // this is the composition order the guard has to cope with, and listing it first would hide a
  // setup-time service lookup that the declared dependency is what actually makes safe.
  const gantt = Gantt.create({
    element: asElement(dom.root),
    plugins: [timelinePlugin(config, { reads }), collect, dataStore(), ...extra],
  });
  const booted = collectDom(dom, gantt);

  const rendererService = booted.gantt.service("stargantt.view");
  const scale = booted.gantt.service("stargantt.timeline");
  return {
    ...booted,
    data: booted.gantt.service("stargantt.data"),
    renderer: rendererService,
    visibleRange: () => {
      const vp = rendererService.viewport.get();
      return { from: scale.xToT(vp.scrollLeft), to: scale.xToT(vp.scrollLeft + vp.width) };
    },
    faults,
    countStoreReads: () => {
      reads.full = 0;
      return reads;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Observing the zoom-level store
 * ------------------------------------------------------------------ */

/**
 * One notification of `TimelineService.zoomLevel`, in the shape the abolished
 * `timeline/zoomChanged` event carried.
 *
 * The store is set on every change to the t↔x mapping and gates on nothing, so an origin move
 * re-publishes the unchanged level object and still notifies. The two are told apart exactly as a
 * consumer tells them apart: equal ids mean the origin moved, different ids mean a real zoom. The
 * level *index* is not in the store either — it is recovered from `levelMetrics()`, which is the
 * documented way to map a level id onto its position in the composed ladder.
 */
export interface ZoomNotice {
  /** The new level's position in `levelMetrics()` — its index in the composed level list. */
  level: number;
  /** `"zoom"` when the level itself changed, `"origin"` when only content x = 0 moved. */
  cause: "zoom" | "origin";
}

/**
 * Records every `zoomLevel` notification from now on.
 *
 * The subscription lives for the chart's lifetime, which in these tests is the test body; the
 * returned array is appended to synchronously, so it can be asserted immediately after the call
 * that moved the axis.
 */
export function watchZoom(b: Booted): ZoomNotice[] {
  const service: TimelineService = b.gantt.service("stargantt.timeline");
  const notices: ZoomNotice[] = [];
  service.zoomLevel.subscribe((next, prev) => {
    notices.push({
      level: service.levelMetrics().findIndex((m) => m.id === next.id),
      cause: next.id === prev.id ? "origin" : "zoom",
    });
  });
  return notices;
}

/** Fires the horizontal-scroll wheel gesture the render module's virtual scroll listens for. */
export function wheelScroll(b: Booted, deltaX: number): void {
  b.pane.fire("wheel", wheelEvent({ deltaX }));
}
