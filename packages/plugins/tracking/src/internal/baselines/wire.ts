// docs/specs/plugins/tracking.md §7's `internal/baselines/` entry point: `wireBaselines(deps)`.
//
// Builds the full `BaselinesService` UNCONDITIONALLY (§1's presence-semantics paragraph — "a
// dormant config nest leaves its service provided and functional over empty session state", the
// calendars-service precedent scheduling.md §1.2 already established) — and, only while
// `deps.config.baselines` is present, registers the two `renderer/layers` contributions (order 50
// baseline bars, order 62 actual bars + baseline CP rings, §3.2) and the `taskbars/overlays`
// slip-indicator contribution, deferred to `lifecycle/ready` for their `ctx.useOptional` lookups
// (§8's resolution-timing rule) — exactly the split `@stargantt/plugin-scheduling`'s
// `wireCriticalPath` uses for its own always-on service / nest-gated visuals.
//
// Per §7's own note, this area's `wire*` function never calls `ctx.claimOrder` itself: the root
// `index.ts` claims `BASELINES_LAYER_ORDER` / `ACTUALS_LAYER_ORDER` once, centrally: this file only
// `ctx.contribute()`s under the already-claimed id/zIndex (`internal/shared/layer-ids.ts`).
import type { LayerContribution, ThemeService, TimelineService, ViewService } from "@stargantt/plugin-view";
import type { RowsService } from "@stargantt/plugin-tree-grid";
import type { TaskBarsService } from "@stargantt/plugin-task-bars";
import type { ResolvedBaselinesConfig } from "../../config";
import type { BaselinesService } from "../../types";
import type { TrackingAreaDeps } from "../areas";
import { ACTUALS_LAYER_ID, ACTUALS_LAYER_ORDER, BASELINES_LAYER_ID, BASELINES_LAYER_ORDER } from "../shared/layer-ids";
import { createCpmApi } from "./cpm";
import {
  createActualsLayer,
  createBaselineUnderlayLayer,
  createCriticalPathSetsResolver,
  createSlipOverlay,
  resolveActualsColors,
  resolveSlipColors,
  resolveUnderlayColors,
} from "./paint";
import { createBaselinesService } from "./service";
import { createBaselinesState } from "./set";
import { createVarianceApi } from "./variance";

/** The §5.1 defaults, applied when the `baselines` nest is omitted (dormant — §1 presence rule). */
const DORMANT_BASELINES_CONFIG: ResolvedBaselinesConfig = {
  baselines: [],
  active: undefined,
  bars: true,
  barStyle: "under",
  actualBars: true,
  slipIndicators: true,
  slipThresholdMs: 86_400_000,
  criticalPath: false,
};

type TaskBarsReader = Pick<TaskBarsService, "barRect" | "visibleBoxes">;
type RowsReader = Pick<RowsService, "rowCount" | "rowAtY" | "yOf" | "rowHeight" | "taskIdAt">;
type TimelineReader = Pick<TimelineService, "tToX">;

/** Wires the baselines area: the service (always) and the three visuals (nest-gated). */
export function wireBaselines(deps: TrackingAreaDeps): BaselinesService {
  const { ctx, config, messages, data, now } = deps;
  const nest = config.baselines;
  // §1 presence semantics: the service always runs on resolved-or-defaulted fields; only the
  // config SEED (`nest.baselines`/`nest.active`) and the visuals below are gated on the nest
  // actually being present — a dormant nest starts the service on an empty baseline set.
  const resolved = nest ?? DORMANT_BASELINES_CONFIG;

  // Populated once `stargantt.view` resolves inside the nest-gated `lifecycle/ready` block below;
  // every repaint request funnels through this indirection so it is a safe no-op until then (no
  // view composed, or the nest itself is dormant and no layer is ever registered).
  let invalidateMain: (() => void) | undefined;
  const repaint = (): void => invalidateMain?.();

  const state = createBaselinesState({
    ctx,
    data,
    messages,
    now,
    seed: nest === undefined ? [] : resolved.baselines,
    active: nest?.active,
    repaint,
  });

  const variance = createVarianceApi({
    data,
    messages,
    ctx,
    resolveBaseline: state.resolveBaseline,
  });

  const cpm = createCpmApi({
    data,
    ctx,
    resolveBaseline: state.resolveBaseline,
  });

  const service = createBaselinesService(state, variance, cpm);

  // §2.3: "Baseline underlays, actuals and slip glyphs all track the live schedule" — every data
  // change repaints, independent of whether the change touched a baseline itself.
  ctx.own(data.tasks.subscribe(repaint));

  // §5's presence semantics: the nest gates only the visuals below.
  if (nest === undefined) return service;

  ctx.on("lifecycle/ready", () => {
    const view: ViewService | undefined = ctx.useOptional("stargantt.view");
    const timeline: TimelineReader | undefined = ctx.useOptional("stargantt.timeline");
    const theme: ThemeService | undefined = ctx.useOptional("stargantt.theme");
    const taskBars: TaskBarsReader | undefined = ctx.useOptional("stargantt.task-bars");
    const rows: RowsReader | undefined = ctx.useOptional("stargantt.rows");

    if (view !== undefined) invalidateMain = () => view.invalidate("main");

    /* --- order-50 baseline underlay ------------------------------------------------------- */

    const underlayDraw = createBaselineUnderlayLayer({
      bars: resolved.bars,
      barStyle: resolved.barStyle,
      activeBaseline: () => state.resolveBaseline(),
      rows: () => rows,
      timeline: () => timeline,
      taskBars: () => taskBars,
      colors: () => resolveUnderlayColors(theme),
    });
    ctx.contribute("renderer/layers", {
      id: BASELINES_LAYER_ID,
      zIndex: BASELINES_LAYER_ORDER,
      draw: underlayDraw,
    } satisfies LayerContribution);

    /* --- order-62 actual bars + baseline CP rings ------------------------------------------ */

    const criticalPathSets = createCriticalPathSetsResolver({
      enabled: resolved.criticalPath,
      activeBaseline: () => state.resolveBaseline(),
      criticalPath: cpm.criticalPath,
      criticalPathDelta: cpm.criticalPathDelta,
    });

    const actualsDraw = createActualsLayer({
      actualBars: resolved.actualBars,
      taskBars: () => taskBars,
      timeline: () => timeline,
      getTask: (id) => data.getTask(id),
      criticalPathSets,
      colors: () => resolveActualsColors(theme),
    });
    ctx.contribute("renderer/layers", {
      id: ACTUALS_LAYER_ID,
      zIndex: ACTUALS_LAYER_ORDER,
      draw: actualsDraw,
    } satisfies LayerContribution);

    /* --- taskbars/overlays slip indicator -------------------------------------------------- */

    const slipOverlay = createSlipOverlay({
      slipIndicators: resolved.slipIndicators,
      slipThresholdMs: resolved.slipThresholdMs,
      activeBaseline: () => state.resolveBaseline(),
      getTask: (id) => data.getTask(id),
      slipLabel: messages.slipLabel,
      colors: () => resolveSlipColors(theme),
    });
    ctx.contribute("taskbars/overlays", slipOverlay);
  });

  return service;
}
