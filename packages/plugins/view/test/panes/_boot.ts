/**
 * Shared boot helper for the panes-module tests: a real `Gantt.create()` over the fake DOM, with
 * the panes module as the only part of `stargantt.view` that is built.
 *
 * The six formerly-separate modules merged into one, so booting the whole `view()` factory would also raise the
 * canvases, the timeline header and the two line passes — none of which these tests are about,
 * and all of which would move the DOM they inspect. The module factory is the seam that keeps the
 * module isolation: `createPanesModule` is called directly against a `RenderModule` stand-in, and the
 * result is published under the real service key, so the probes below read exactly the surface a
 * third-party plugin reads. Only `RenderModule.chartPaneElement` is meaningful to the panes
 * module (docs/specs/plugins/view.md); every other member is an inert stub.
 */
import { Gantt, createStore, definePlugin } from "@stargantt/core";
import type { AnyPlugin, GanttInstance, PluginContext, WritableStore } from "@stargantt/core";
import { createPanesModule } from "../../src/internal/panes/index";
import type { PanesModule } from "../../src/internal/panes/index";
import type { PanesConfig } from "../../src/config";
import type { RenderModule, Viewport } from "../../src/internal/render/index";
import type { ViewService } from "../../src/index";
import { asElement, installDom } from "../_utils/index";
import type { DomHarness, DomOptions } from "../_utils/index";

export function probe(
  setup: (ctx: PluginContext) => void,
  id = "test.probe",
  dependsOn: string[] = ["stargantt.view"],
): AnyPlugin {
  return definePlugin({ meta: { id, dependsOn }, setup });
}

/**
 * A `RenderModule` stand-in whose only meaningful member is `chartPaneElement`; every other
 * member is an inert stub — the panes module reads none of them.
 */
function renderStub(chartPaneElement: () => HTMLElement): RenderModule {
  const viewportStore: WritableStore<Readonly<Viewport>> = createStore<Readonly<Viewport>>({
    scrollTop: 0,
    scrollLeft: 0,
    width: 0,
    height: 0,
  });
  return {
    invalidate: () => {},
    refreshInsets: () => {},
    direction: () => "ltr" as const,
    reducedMotion: () => false,
    textWidth: (_g: unknown, text: string) => text.length * 6,
    bidiIsolate: (text: string) => text,
    firstPaintMs: () => undefined,
    batchRead: (fn: () => void) => fn(),
    batchWrite: (fn: () => void) => fn(),
    predictedViewport: () => undefined,
    chartPaneElement,
    wheelSpeedFactor: () => 1,
    scrollTo: () => {},
    renderTo: () => {},
    viewport: viewportStore,
    rowGeometry: () => undefined,
    fault: () => {},
  };
}

/** The default chart pane: a plain `sg-pane sg-pane--chart`, a direct child of the root. */
function defaultChartPane(ctx: PluginContext): HTMLElement {
  const pane = ctx.root.ownerDocument.createElement("div");
  pane.className = "sg-pane sg-pane--chart";
  ctx.root.appendChild(pane);
  return pane;
}

export interface ViewPluginOptions {
  config?: PanesConfig;
  /**
   * Builds the chart pane and returns it. Defaults to a plain `sg-pane sg-pane--chart` appended
   * to the root — the shape most tests need. A test probing the placement guard's edge cases
   * (a chart pane outside the root, or nested inside a renderer-owned wrapper) supplies its own.
   */
  chartPane?: (ctx: PluginContext) => HTMLElement;
  /**
   * `false` skips registering the chart pane's own removal on dispose, so a test can observe
   * exactly what the panes module put back (the "returned exactly as found" guarantee) without the
   * element also vanishing. Default `true`, matching a real renderer's own cleanup.
   */
  removeChartOnDispose?: boolean;
  /** Captures the panes module's own handle, for assertions beyond the published service. */
  sink?: { module?: PanesModule };
}

/**
 * The plugin the panes module is published from: the real plugin id and the real service key, so
 * `dependsOn: ["stargantt.view"]` and `ctx.use("stargantt.view")` behave exactly as they do in a
 * full composition.
 */
export function viewPlugin(opts: ViewPluginOptions = {}): AnyPlugin {
  return definePlugin({
    meta: { id: "stargantt.view" },
    setup(ctx: PluginContext): void {
      const pane = (opts.chartPane ?? defaultChartPane)(ctx);
      if (opts.removeChartOnDispose !== false) ctx.own({ dispose: () => pane.remove() });
      const render = renderStub(() => pane);
      const module = createPanesModule(ctx, opts.config ?? {}, render);
      if (opts.sink) opts.sink.module = module;
      const service: ViewService = { ...render, viewMode: module.viewMode };
      ctx.provide("stargantt.view", service);
    },
  });
}

export interface Booted {
  dom: DomHarness;
  gantt: GanttInstance;
}

/**
 * 400×300 was the fork's fixed default rect; the shared harness defaults to 800×600, so the size
 * is stated here to keep every rect-derived number the ported tests assert unchanged.
 */
export function boot(
  extra: AnyPlugin[] = [],
  viewOpts: ViewPluginOptions = {},
  domOptions: DomOptions = {},
): Booted {
  const dom = installDom({ width: 400, height: 300, ...domOptions });
  const gantt = Gantt.create({
    element: asElement(dom.root),
    plugins: [viewPlugin(viewOpts), ...extra],
  });
  return { dom, gantt };
}
