// docs/specs/plugins/scheduling.md §7 — critical path.
/**
 * Entry point of the critical-path area: the `sdk/cpm`-backed analysis (§7.1 / §7.2), the
 * store-shaped `CriticalPathService` with its five-rule lazy freshness contract (§1.3), and the
 * three visuals — bar recolouring plus outline overlay, the order-72 critical-link emphasis and the
 * order-56 free-float bars (§7.3).
 *
 * §1.3 provides the service unconditionally while the `criticalPath` nest gates only the visuals;
 * `wireCriticalPath` ALWAYS builds and provides the service, and `src/index.ts` calls it
 * unconditionally (§14, amended) — only the block below the `if (cpConfig === undefined) return;`
 * line is nest-gated.
 */
import { MS_DAY } from "@stargantt/sdk";
import type { LayerContribution, ThemeService, TimelineService, ViewService } from "@stargantt/plugin-view";
import type { TaskBarsService } from "@stargantt/plugin-task-bars";
import type { RowsService } from "@stargantt/plugin-tree-grid";
import type { SchedulingAreaDeps } from "../areas";
import { analyze, criticalLinkObjects, emptyAnalysis, latestTimesOf } from "./analysis";
import type { AnalyzeOptions, CriticalPathAnalysis } from "./analysis";
import { createColorResolver } from "./colors";
import { createBarOverlay, createStyleProvider } from "./overlays";
import { createFloatLayer, createLinkLayer } from "./paint";
import { createCriticalPathAnalysisStore, createCriticalPathShorthands } from "./service";
import type { CriticalPathService } from "./service";

/** The one member this area's visuals read from `stargantt.task-bars`. */
type TaskBarsReader = Pick<TaskBarsService, "barRect">;

const LINK_LAYER_ID = "stargantt.scheduling:cp-links";
const LINK_LAYER_ORDER = 72;
const FLOAT_LAYER_ID = "stargantt.scheduling:cp-float";
const FLOAT_LAYER_ORDER = 56;

/** Wires the critical-path area. */
export function wireCriticalPath(deps: SchedulingAreaDeps): void {
  const { ctx, config, data } = deps;
  const cpConfig = config.criticalPath;

  /* --- §1.3 the service — unconditional (see the module doc's diff note) --------------- */

  const visualsActive =
    cpConfig !== undefined &&
    cpConfig.enabled &&
    (cpConfig.highlightBars || cpConfig.highlightLinks || cpConfig.showFloat);

  // §11.4 defaults (thresholdDays 0, nearCriticalDays 0) apply verbatim while the nest is dormant —
  // the analysis is fully functional either way (§1.3), only the visuals are nest-gated.
  const options = (): AnalyzeOptions => ({
    criticalMs: (cpConfig?.thresholdDays ?? 0) * MS_DAY,
    nearMs: (cpConfig?.nearCriticalDays ?? 0) * MS_DAY,
  });

  function recompute(): CriticalPathAnalysis {
    const view = data.query();
    if (view.byId.size === 0) return emptyAnalysis();
    return analyze(view, latestTimesOf(view), options());
  }

  const store = createCriticalPathAnalysisStore(recompute, () => visualsActive);
  const service: CriticalPathService = {
    analysis: store.analysis,
    ...createCriticalPathShorthands(store.analysis),
  };
  ctx.provide("stargantt.critical-path", service);

  // Set below, only when the visuals are wired and `stargantt.view` resolved — §7.3's "while any
  // visual is active, the data.tasks notification ALSO invalidates the renderer's main layer".
  let invalidateMain: (() => void) | undefined;

  ctx.own(
    data.tasks.subscribe(() => {
      store.markDirty(); // rule 2
      store.recomputeIfActive(); // rule 3, first clause
      if (visualsActive) invalidateMain?.();
    }),
  );

  // §11.4 presence semantics: the nest gates only the visuals below.
  if (cpConfig === undefined) return;

  /* --- §7.3 visuals ------------------------------------------------------------------- */

  // Deferred to `lifecycle/ready` rather than resolved eagerly here (following the earlier
  // implementation, which deferred its one soft lookup, `stargantt.row-model`,
  // the same way): `view` / `task-bars` are §14 optional (inert-degradation) edges with no
  // `dependsOn` entry, so this plugin's own setup-time position relative to theirs is not
  // guaranteed, and a same-tick `useOptional` could read `undefined` even in a correct composition
  // ordered the other way. `lifecycle/ready` fires once every composed plugin has run `setup()`,
  // which is the earliest point these lookups are order-independent. `claimOrder` / `contribute`
  // themselves are timing-agnostic (the core buffers a contribution ahead of its point's
  // definition), so only the service reads below are deferred, not the whole function.
  ctx.on("lifecycle/ready", () => {
    const view: ViewService | undefined = ctx.useOptional("stargantt.view");
    const timeline: TimelineService | undefined = ctx.useOptional("stargantt.timeline");
    const bars: TaskBarsReader | undefined = ctx.useOptional("stargantt.task-bars");
    // §1.1 kept: theme is optional, the four colors fall back to their documented defaults
    // when `stargantt.theme` is not in the composition.
    const theme: ThemeService | undefined = ctx.useOptional("stargantt.theme");

    if (view !== undefined) invalidateMain = () => view.invalidate("main");

    // §14 (amended, M5) — an absent optional service leaves this area silently inert: no
    // `core/pluginError`, which is reserved for foreign-code faults, not for a composition simply
    // not including a chart provider (the same rule links/calendars/diagnostics all follow).
    if (bars === undefined) return;

    const colors = createColorResolver(
      {
        criticalColorOverride: cpConfig.criticalColor,
        nearCriticalColorOverride: cpConfig.nearCriticalColor,
        negativeFloatColorOverride: cpConfig.negativeFloatColor,
        floatColorOverride: cpConfig.floatColor,
      },
      theme,
    );

    // §1.1/§7.3 — `enabled: false` keeps the service (already provided above) but registers no
    // visual contribution at all.
    if (!cpConfig.enabled) return;

    /* --- bar highlighting: taskbars/style + taskbars/overlays ------------------------- */

    if (cpConfig.highlightBars) {
      ctx.contribute("taskbars/style", createStyleProvider(() => store.analysis.get(), colors));
      ctx.contribute("taskbars/overlays", createBarOverlay(() => store.analysis.get(), colors));
    }

    /* --- critical-link emphasis: renderer/layers order 72 ----------------------------- */

    if (cpConfig.highlightLinks) {
      ctx.claimOrder("renderer/layers", LINK_LAYER_ID, LINK_LAYER_ORDER);
      const layer: LayerContribution = {
        id: LINK_LAYER_ID,
        zIndex: LINK_LAYER_ORDER,
        draw: createLinkLayer({
          criticalLinks: () => criticalLinkObjects(store.analysis.get()),
          bars,
          colors,
        }),
      };
      ctx.contribute("renderer/layers", layer);
    }

    /* --- free-float bars: renderer/layers order 56 ------------------------------------ */

    if (cpConfig.showFloat && timeline !== undefined) {
      ctx.claimOrder("renderer/layers", FLOAT_LAYER_ID, FLOAT_LAYER_ORDER);
      const rows: RowsService | undefined = ctx.useOptional("stargantt.rows");
      const layer: LayerContribution = {
        id: FLOAT_LAYER_ID,
        zIndex: FLOAT_LAYER_ORDER,
        draw: createFloatLayer({
          analysis: () => store.analysis.get(),
          bars,
          rows: () => rows,
          pxPerMs: () => timeline.pxPerMs,
          colors,
        }),
      };
      ctx.contribute("renderer/layers", layer);
    }
  });
}
