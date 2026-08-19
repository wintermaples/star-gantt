// docs/specs/plugins/view.md
/**
 * The plugin's `setup()`: it creates the six internal modules in dependency order and publishes
 * the three services they add up to.
 *
 * Everything here is construction and registration. The modules themselves hold the logic, and
 * what used to be six plugins reading each other through the service registry is now six factory
 * calls passing each other their handles — the same wiring, resolved at construction time instead
 * of at lookup time.
 */
import type { PluginContext } from "@stargantt/core";
import type { ViewOptions } from "../config";
import { createGridLinesModule } from "./grid-lines/index";
import { createPanesModule } from "./panes/index";
import { createRenderModule } from "./render/index";
import { createThemeModule } from "./theme/index";
import { createTimelineModule } from "./timeline/index";
import { createTodayLineModule } from "./today-line/index";
import type { ViewService } from "../index";

/**
 * Builds the chart surface and publishes `stargantt.view`, `stargantt.timeline` and
 * `stargantt.theme`.
 *
 * The order is the old `dependsOn` graph, flattened: the render module owns the DOM every other
 * module positions against, the theme module answers the token reads the timeline header makes at
 * construction time, and the two line modules paint through the timeline's mapping.
 */
export function setupView(ctx: PluginContext, options: ViewOptions): void {
  const data = ctx.use("stargantt.data");

  const render = createRenderModule(ctx, options.render);
  const theme = createThemeModule(ctx, options.theme, render);
  const timeline = createTimelineModule(ctx, options.timeline, render, theme, {
    tasks: data.tasks,
  });
  const panes = createPanesModule(ctx, options.panes, render);

  // docs/specs/plugins/view.md — the two internalized line passes. They contribute to
  // `renderer/layers` on the same terms as any third party, and claim their order the same way.
  createGridLinesModule(ctx, options.gridLines, render, theme, timeline, {
    calendar: (id) => data.query().calendars.get(id),
  });
  // `todayLine: false` replaces leaving the pass out of the composition entirely:
  // with the pass switched off, nothing is contributed and no rollover timer is armed.
  if (options.todayLine !== undefined) {
    createTodayLineModule(ctx, options.todayLine.statusDateMs, render, theme, timeline);
  }

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
    viewMode: panes.viewMode,
  };

  ctx.provide("stargantt.view", view);
  ctx.provide("stargantt.timeline", timeline);
  ctx.provide("stargantt.theme", theme);
}
