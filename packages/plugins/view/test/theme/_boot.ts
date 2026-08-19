/**
 * Shared boot helper for the theme-module tests: a real `Gantt.create()` over the fake DOM, with
 * the theme module as the only part of `stargantt.view` that is built.
 *
 * The six formerly-separate modules merged into one, so booting the whole `view()` factory would also raise the
 * render module's real canvases, the timeline header, the pane row and the two line passes — none
 * of which these tests are about. The module factory is the seam that keeps the module isolation:
 * `createThemeModule` is called directly and its handle is published under the real service key,
 * so the probes below read exactly the surface a third-party plugin reads. The render module it
 * depends on is a stub — same shape as `RenderModule`, only `invalidate` doing real work — which is
 * what the earlier `rendererStub` helper amounted to for this suite.
 */
import { Gantt, createStore, definePlugin } from "@stargantt/core";
import type { AnyPlugin, GanttInstance, PluginContext } from "@stargantt/core";
import { createThemeModule } from "../../src/internal/theme/index";
import type { CanvasLayer, RenderModule, Viewport } from "../../src/internal/render/index";
import type { ThemeConfig } from "../../src/config";
import { asElement, installDom } from "../_utils/index";
import type { DomHarness, DomOptions } from "../_utils/index";

export interface Booted {
  dom: DomHarness;
  gantt: GanttInstance;
  /** Every `invalidate(layer)` the theme module asked the render module for, in order. */
  invalidated: CanvasLayer[];
}

export function probe(
  setup: (ctx: PluginContext) => void,
  id = "test.probe",
  dependsOn: string[] = ["stargantt.view"],
): AnyPlugin {
  return definePlugin({ meta: { id, dependsOn }, setup });
}

/**
 * A stand-in for the render module: the full `RenderModule` shape, but every member is inert
 * except `invalidate`, which records into `sink`. The theme module reads nothing else from its
 * sibling — this is what the earlier `rendererStub` helper amounted to, updated for the merged plugin's
 * `RenderModule` surface (`viewport` as a store, plus `rowGeometry` and `fault`).
 */
function renderStub(sink: CanvasLayer[], root: HTMLElement): RenderModule {
  const viewport = createStore<Readonly<Viewport>>({
    scrollTop: 0,
    scrollLeft: 0,
    width: 0,
    height: 0,
  });
  return {
    invalidate: (layer: CanvasLayer) => {
      sink.push(layer);
    },
    // Test stub: the off-screen composite is irrelevant to these tests.
    refreshInsets: () => {},
    direction: () => "ltr",
    reducedMotion: () => false,
    textWidth: () => 0,
    bidiIsolate: (text: string) => text,
    firstPaintMs: () => undefined,
    batchRead: (fn: () => void) => fn(),
    batchWrite: (fn: () => void) => fn(),
    predictedViewport: () => undefined,
    // The pane element is never read by the code under test.
    chartPaneElement: () => root,
    wheelSpeedFactor: () => 1,
    // Scroll position is irrelevant to theme tests.
    scrollTo: () => {},
    renderTo: () => {},
    viewport,
    rowGeometry: () => undefined,
    fault: () => {},
  };
}

/**
 * The plugin the theme module is published from: the real plugin id and the real service key, so
 * `dependsOn: ["stargantt.view"]` and `ctx.use("stargantt.theme")` behave exactly as they do in a
 * full composition.
 */
function themePlugin(config: ThemeConfig | undefined, sink: CanvasLayer[]): AnyPlugin {
  return definePlugin({
    meta: { id: "stargantt.view" },
    setup(ctx: PluginContext): void {
      const render = renderStub(sink, ctx.root);
      const service = createThemeModule(ctx, config ?? {}, render);
      ctx.provide("stargantt.theme", service);
    },
  });
}

export function boot(
  extra: AnyPlugin[] = [],
  options: DomOptions = {},
  config?: ThemeConfig,
): Booted {
  const dom = installDom(options);
  const invalidated: CanvasLayer[] = [];
  const gantt = Gantt.create({
    element: asElement(dom.root),
    plugins: [themePlugin(config, invalidated), ...extra],
  });
  return { dom, gantt, invalidated };
}
