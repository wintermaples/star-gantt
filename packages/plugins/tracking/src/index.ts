// docs/specs/plugins/tracking.md
/**
 * `@stargantt/plugin-tracking` — plugin id `stargantt.tracking`, Layer 7.
 *
 * Four feature areas merged into one package: baselines (schedule snapshots, baseline/actual bars, slip
 * indicators, variance report, critical-path comparison), progress tracking (RAG health, the three
 * progress-input methods, the status-date zigzag line, status report, trend snapshots), cost
 * (rate master, labor cost, manual cost fields, budgets and alerts, cost baselines, the cumulative
 * cost curve and S-curve forecast) and EVM (PV/EV/AC, SPI/CPI/SV/CV, EAC/ETC, four accrual methods,
 * a KPI dashboard and an S-curve panel).
 *
 * The evm → cost / baselines / progress service consumption uses direct internal calls (§2.14)
 * rather than lazy service lookups between the four areas: the EVM
 * area's `wireEvm` takes an `EvmAreaExtras` object this file fills in with the OTHER three areas'
 * already-built, live functions (`CostService.costOf`, `BaselinesService.snapshotOf`) — plain
 * function references, never a `*Service` type import or a `ctx.use()` lookup between the four
 * areas. The shared vocabulary (status-date resolution, day-stamped snapshot series, the meta-bag
 * read/write discipline) lives in `internal/shared/` and is used directly by every area.
 *
 * This file does the five `claimKey` calls, the three `claimOrder` calls (§7: "root does all
 * claimKey/claimOrder calls" — no area's own `wire*` function claims anything itself, see
 * `internal/shared/layer-ids.ts`), the single `declare module "@stargantt/core"` site for this
 * plugin's own four service ids, and the plain wiring of the four areas. Every other behavior lives
 * in `internal/{baselines,progress,cost,evm}/`.
 */
import { definePlugin } from "@stargantt/core";
import type { Plugin, PluginContext } from "@stargantt/core";
// Type-only: bring the sibling packages' `declare module "@stargantt/core"` augmentations into this
// program so the `renderer/layers` / `taskbars/overlays` / `taskbars/style` contributions and the
// `stargantt.rows` / `stargantt.resource-pool` optional lookups below are checked against the real
// declarations. Erased at emit — no runtime dependency is added (all four are `devDependencies`,
// so type-only imports carry no runtime dependency). `@stargantt/plugin-resource` ships alongside
// this package, so `internal/cost/rates.ts`'s `stargantt.resource-pool` lookup is a genuine
// `Services`-typed `ctx.useOptional` call.
import type {} from "@stargantt/plugin-resource";
import type {} from "@stargantt/plugin-task-bars";
import type {} from "@stargantt/plugin-tree-grid";
import type {} from "@stargantt/plugin-view";
import { resolveConfig } from "./config";
import type { TrackingConfig } from "./config";
import type { TrackingAreaDeps } from "./internal/areas";
import { wireBaselines } from "./internal/baselines/wire";
import { wireCost } from "./internal/cost/wire";
import { wireEvm } from "./internal/evm/wire";
import type { EvmAreaExtras } from "./internal/evm/wire";
import { resolveMessages } from "./internal/messages";
import { wireProgress } from "./internal/progress/wire";
import {
  ACTUALS_LAYER_ID,
  ACTUALS_LAYER_ORDER,
  BASELINES_LAYER_ID,
  BASELINES_LAYER_ORDER,
  PROGRESS_LINE_LAYER_ID,
  PROGRESS_LINE_LAYER_ORDER,
} from "./internal/shared/layer-ids";
import type {
  BaselinesService,
  CostService,
  EvmService,
  ProgressService,
} from "./types";

/* ------------------------------------------------------------------ *
 * Public surface
 * ------------------------------------------------------------------ */

export type {
  BaselinesConfig,
  CostConfig,
  EvmConfig,
  ProgressConfig,
  TrackingConfig,
} from "./config";
export type { TrackingMessages } from "./internal/messages";
export type {
  // baselines (§1.1)
  ActualDates,
  Baseline,
  BaselineId,
  BaselineInfo,
  BaselineInit,
  BaselineLinkSnapshot,
  BaselinesService,
  BaselinesState,
  BaselineTaskSnapshot,
  CriticalPathDelta,
  ScheduleSummary,
  VarianceRow,
  // progress (§1.2)
  LateTaskEntry,
  ProgressFieldsBatchEntry,
  ProgressPatch,
  ProgressService,
  ProgressSnapshot,
  ProgressState,
  ProgressValues,
  RagStatus,
  StatusReport,
  // cost (§1.3)
  BreakdownEntryData,
  BudgetComparisonRow,
  CostAlert,
  CostBaseline,
  CostBreakdown,
  CostCurvePoint,
  CostFormulaInit,
  CostFormulaInput,
  CostFormulaValue,
  CostItem,
  CostItemInit,
  CostPanelModel,
  CostPanelRenderContext,
  CostPatch,
  CostRate,
  CostRateInit,
  CostService,
  CostState,
  CostType,
  CostVarianceRow,
  TableRow,
  TaskCost,
  // evm (§1.4)
  EacMethod,
  EarnedValueMethod,
  EvmAccrualFn,
  EvmCurvePoint,
  EvmEacFn,
  EvmFormulaInit,
  EvmFormulaInput,
  EvmIndices,
  EvmKpiTile,
  EvmMilestone,
  EvmPanelModel,
  EvmPanelRenderContext,
  EvmPatch,
  EvmService,
  EvmSnapshot,
  EvmState,
  EvmTaskMetrics,
  EvmValues,
} from "./types";

declare module "@stargantt/core" {
  interface Services {
    "stargantt.baselines": BaselinesService;
    "stargantt.progress": ProgressService;
    "stargantt.cost": CostService;
    "stargantt.evm": EvmService;
  }
}

/* ------------------------------------------------------------------ *
 * Plugin
 * ------------------------------------------------------------------ */

const PLUGIN_ID = "stargantt.tracking";

/** The bag every §2.1 claim names. */
const TASK_META_BAG = "task.meta";

function setup(ctx: PluginContext, raw: TrackingConfig): void {
  const config = resolveConfig(raw);

  const reportError = (where: string, error: unknown): void => {
    ctx.emit("core/pluginError", { pluginId: PLUGIN_ID, error: { where, cause: error } });
  };
  const messages = resolveMessages(raw.messages, (messageKey, cause) => {
    reportError(`messages.${messageKey}`, cause);
  });

  const data = ctx.use("stargantt.data");

  /* --- §2.1 the five claimed `task.meta` keys ---------------------------- */

  ctx.claimKey(TASK_META_BAG, "actualStart");
  ctx.claimKey(TASK_META_BAG, "actualEnd");
  ctx.claimKey(TASK_META_BAG, "progressTracking");
  ctx.claimKey(TASK_META_BAG, "costTracking");
  ctx.claimKey(TASK_META_BAG, "evm");

  /* --- §7 the three `renderer/layers` claims, made once, centrally ------- */

  ctx.claimOrder("renderer/layers", BASELINES_LAYER_ID, BASELINES_LAYER_ORDER);
  ctx.claimOrder("renderer/layers", ACTUALS_LAYER_ID, ACTUALS_LAYER_ORDER);
  ctx.claimOrder("renderer/layers", PROGRESS_LINE_LAYER_ID, PROGRESS_LINE_LAYER_ORDER);

  /* --- the four areas ----------------------------------------------------- */

  const deps: TrackingAreaDeps = {
    ctx,
    config,
    messages,
    data,
    now: () => Date.now(),
    reportError,
  };

  // Independent of one another: each area's service is built unconditionally over its own
  // resolved-or-default config, per §5's presence semantics.
  const baselines = wireBaselines(deps);
  const progress = wireProgress(deps);
  const cost = wireCost(deps);

  // §2.14's fan-in, as DIRECT calls into the other three areas' already-live functions — never a
  // `*Service` type import or a `ctx.use()` lookup between the four areas (the acceptance grep this
  // task card names). `costOf`/`snapshotOf` are genuine, side-effect-free, publicly-typed methods of
  // the services just built above; binding them here is exactly what "the root wires it in" means.
  const evmExtras: EvmAreaExtras = {
    costOf: (id) => cost.costOf(id),
    baselineSnapshotOf: (id) => baselines.snapshotOf(id),
  };
  const evm = wireEvm(deps, evmExtras);

  ctx.provide("stargantt.baselines", baselines);
  ctx.provide("stargantt.progress", progress);
  ctx.provide("stargantt.cost", cost);
  ctx.provide("stargantt.evm", evm);
}

/**
 * Creates the tracking plugin: baselines, progress tracking, cost tracking and earned-value
 * management, over the data store alone. Every chart-surface edge (`view`, `task-bars`, `tree-grid`,
 * `resource`) is optional with silent-inert degradation (§8) — a headless composition of just
 * `dataStore() + tracking()` computes variance, status reports, costs and EVM in plain Node.
 *
 * Configurable plugins are exported as factories because the host passes no per-plugin config to
 * `setup()`: the configuration is closed over here and the produced plugin itself takes `void`.
 */
export function tracking(config: TrackingConfig = {}): Plugin<void> {
  // A snapshot, so a later mutation of the caller's object cannot change a running chart.
  const options: TrackingConfig = { ...config };
  return definePlugin<void>({
    meta: {
      id: PLUGIN_ID,
      // §8 — the only edge this plugin cannot function without: every service computes from the
      // data stores and every write is a data command.
      dependsOn: ["stargantt.data-store"],
      // §8 — chart-surface edges follow the scheduling.md §14 optional-inert pattern: absent, every
      // visual area stays silently inert (no `core/pluginError`) while the four services, the
      // reports and the meta write paths keep working. `stargantt.resource` is the same-layer
      // sanctioned edge (architecture ch. 5) for the §2.8 cost-rate fallback.
      optional: ["stargantt.view", "stargantt.task-bars", "stargantt.tree-grid", "stargantt.resource"],
    },
    setup: (ctx) => setup(ctx, options),
  });
}
