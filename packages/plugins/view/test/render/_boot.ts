/**
 * Shared boot helper for the render-module tests: a real `Gantt.create()` over the fake DOM, with
 * the render module as the only part of `stargantt.view` that is built.
 *
 * The six formerly-separate modules merged into one, so booting the whole `view()` factory would also raise the
 * timeline header, the pane row and the two line passes — none of which these tests are about, and
 * all of which would move the DOM they inspect. The module factory is the seam that keeps the
 * module isolation: `createRenderModule` is called directly and its handle is published under the real
 * service key, so the probes below read exactly the surface a third-party plugin reads.
 */
import { Gantt, definePlugin } from "@stargantt/core";
import type { AnyPlugin, GanttInstance, PluginContext } from "@stargantt/core";
import { createRenderModule } from "../../src/internal/render/index";
import type { CanvasLayer, RenderModule, RenderOptions } from "../../src/internal/render/index";
import type { ViewService } from "../../src/index";
import { asElement, installDom } from "../_utils/index";
import type {
  DomHarness,
  DomOptions,
  FakeCanvas,
  FakeContext2D,
  FakeElement,
} from "../_utils/index";

/** The render-relevant slice of `ViewConfig`, in the shape these tests were written against. */
export interface RenderConfig {
  wheelSpeedFactor?: number;
  scrollbar?: boolean;
  direction?: "ltr" | "rtl";
  progressive?: boolean;
  dirtyRegions?: boolean;
  prefetch?: boolean;
}

/** The same normalization `normalizeViewConfig` performs for the render group. */
export function renderOptions(config?: RenderConfig): RenderOptions {
  const raw = config?.wheelSpeedFactor;
  return {
    wheelSpeedFactor: typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 1,
    scrollbarEnabled: config?.scrollbar !== false,
    direction: config?.direction === "rtl" ? "rtl" : "ltr",
    progressive: config?.progressive === true,
    dirtyRegions: config?.dirtyRegions === true,
    prefetch: config?.prefetch === true,
  };
}

export interface Booted {
  dom: DomHarness;
  gantt: GanttInstance;
  pane: FakeElement;
  /** The render module's own handle, for the assertions that predate the published service. */
  module: RenderModule;
  canvas(layer: CanvasLayer): FakeCanvas;
  /** The recording 2d context of one layer's canvas. */
  ctx(layer: CanvasLayer): FakeContext2D;
  layerNameOf(g: unknown): CanvasLayer | "unknown";
}

/**
 * A fake canvas's recording context.
 *
 * The harness models `getContext("2d")` returning `null` (a real browser can), so the non-null
 * assertion the tests need is made once, here.
 */
export function ctxOf(canvas: FakeCanvas): FakeContext2D {
  const g = canvas.context;
  if (g === null) throw new Error("canvas has no 2d context");
  return g;
}

export function probe(
  setup: (ctx: PluginContext) => void,
  id = "test.probe",
  dependsOn: string[] = ["stargantt.view"],
): AnyPlugin {
  return definePlugin({ meta: { id, dependsOn }, setup });
}

/**
 * The plugin the render module is published from: the real plugin id and the real service key, so
 * `dependsOn: ["stargantt.view"]` and `ctx.use("stargantt.view")` behave exactly as they do in a
 * full composition. `viewMode` is the one member the render module does not own; nothing in this
 * suite reads it, and it is stubbed with an inert store rather than pulled in from the panes
 * module.
 */
function renderPlugin(options: RenderOptions, sink: { module?: RenderModule }): AnyPlugin {
  return definePlugin({
    meta: { id: "stargantt.view" },
    setup(ctx: PluginContext): void {
      const module = createRenderModule(ctx, options);
      sink.module = module;
      const service: ViewService = {
        invalidate: module.invalidate,
        refreshInsets: module.refreshInsets,
        direction: module.direction,
        reducedMotion: module.reducedMotion,
        textWidth: module.textWidth,
        bidiIsolate: module.bidiIsolate,
        firstPaintMs: module.firstPaintMs,
        batchRead: module.batchRead,
        batchWrite: module.batchWrite,
        predictedViewport: module.predictedViewport,
        chartPaneElement: module.chartPaneElement,
        wheelSpeedFactor: module.wheelSpeedFactor,
        scrollTo: module.scrollTo,
        renderTo: module.renderTo,
        viewport: module.viewport,
        viewMode: { get: () => "split", subscribe: () => ({ dispose: () => {} }) },
      };
      ctx.provide("stargantt.view", service);
    },
  });
}

export function boot(
  extra: AnyPlugin[] = [],
  options: DomOptions = {},
  config?: RenderConfig,
  /**
   * Runs against the fresh harness before the chart is created, for the rare test that has to be in
   * place before `setup()` — the module creates its pane there, so anything instrumenting the pane
   * cannot wait until `boot` returns.
   */
  prepare?: (dom: DomHarness) => void,
): Booted {
  const dom = installDom(options);
  prepare?.(dom);
  const sink: { module?: RenderModule } = {};
  const gantt = Gantt.create({
    element: asElement(dom.root),
    plugins: [renderPlugin(renderOptions(config), sink), ...extra],
  });

  const pane = dom.root.children[0];
  if (pane === undefined) throw new Error("chart pane was not created");
  const module = sink.module;
  if (module === undefined) throw new Error("render module was not created");

  const canvas = (layer: CanvasLayer): FakeCanvas => {
    const found = pane.children.find((c) => c.getAttribute("data-layer") === layer);
    if (found === undefined) throw new Error(`missing canvas for layer ${layer}`);
    return found as FakeCanvas;
  };

  const layerNameOf = (g: unknown): CanvasLayer | "unknown" => {
    for (const layer of ["background", "main", "overlay"] as const) {
      if (canvas(layer).context === g) return layer;
    }
    return "unknown";
  };

  return { dom, gantt, pane, module, canvas, ctx: (layer) => ctxOf(canvas(layer)), layerNameOf };
}
