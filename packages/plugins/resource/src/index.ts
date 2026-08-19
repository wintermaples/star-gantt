// docs/specs/plugins/resource.md
/**
 * `@stargantt/plugin-resource` — plugin id `stargantt.resource`, Layer 7.
 *
 * Five areas in one package: the resource-pool ledger, assignment editing, the resource-view
 * strip, utilization analysis and the load chart. The boundary between them is strict —
 * `internal/engine/` is the ONE headless aggregation engine every bucketed surface reads (§2;
 * vitest targets it in plain Node, and the architecture lint's `HEADLESS_SUBTREES` entry enforces
 * that it names nothing but the data store, the SDK and its own files) — and the five `internal/`
 * areas carry the services and the UI.
 *
 * The engine half — `computeUtilization` with the eight grids, the two edge policies, the
 * working-time accrual, the hook choke point, the coarsening ladder, the range policies, the
 * rollup folds and the one-entry memo helper — and all five areas' `wire*` entry points
 * (pool, assign, view, utilization, load-chart) are filled; each is wired in the sequence
 * below, gated internally on its own configuration nest (§6).
 *
 * `setup()` below is wiring only.
 */
import { definePlugin } from "@stargantt/core";
import type { Plugin, PluginContext } from "@stargantt/core";
import { resolveConfig } from "./config";
import type { ResourceConfig } from "./config";
import type { LoadChartSurface, ResourceAreaDeps } from "./internal/areas";
import { createWorkingIntervalCache } from "./internal/engine/working-time";
import type { WorkingTimeSource } from "./internal/engine/working-time";
import { resolveMessages } from "./internal/messages";
import { wireAssign } from "./internal/assign/wire";
import { wireLoadChart } from "./internal/load-chart/wire";
import { wirePool } from "./internal/pool/wire";
import { wireUtilization } from "./internal/utilization/wire";
import { wireView } from "./internal/view/wire";

/* ------------------------------------------------------------------ *
 * Public surface
 * ------------------------------------------------------------------ */

export type {
  BookingState,
  LoadChartBucketInput,
  LoadChartConfig,
  ResolvedLoadChart,
  ResolvedResourceAssign,
  ResolvedResourceConfig,
  ResolvedResourcePool,
  ResolvedResourceUtilization,
  ResolvedResourceView,
  ResourceAssignConfig,
  ResourceBookingInit,
  ResourceConfig,
  ResourceKind,
  ResourcePoolConfig,
  ResourcePoolEntry,
  ResourcePoolEntryInit,
  ResourceTimeOffInit,
  ResourceUtilizationConfig,
  ResourceViewConfig,
  ResourceViewTeam,
  ResourceWorkCalendar,
} from "./config";
export type {
  BookingFilter,
  ResourceBooking,
  ResourceFilter,
  ResourcePoolService,
  ResourceTimeOff,
} from "./internal/pool/service";
export type {
  OverallocationInfo,
  UtilizationBucket,
  UtilizationQuery,
  UtilizationReportCell,
  UtilizationReportOptions,
  UtilizationReportRow,
  UtilizationService,
  UtilizationState,
} from "./internal/utilization/service";
export type {
  LoadChartBandLabelInput,
  LoadChartHeatmapCellInput,
  LoadChartLaneLabelInput,
  LoadChartLanesLabelInput,
  ResourceMessages,
  ResourceViewRowLabelInput,
  ResourceViewSegmentLabelInput,
  ResourceViewTeamSummaryInput,
  UtilizationReportColumn,
} from "./internal/messages";

// The aggregation engine itself stays INTERNAL: §10 lists this package's third-party surface —
// the two services, the events, the config-function seams — and `computeUtilization` is not on it.
// What is published here are the TYPES §1.2 makes part of the service surface: the widened bucket
// union the query members accept, and the three rollup shapes they return.
export type { UtilizationBucketUnit } from "./internal/engine/buckets";
export type { RoleDemand, TeamCapacitySummary, TrendPoint } from "./internal/engine/rollups";
// §1.1 — the working-time range shape the pool's listings answer with; re-exported so a consumer
// need not also depend on the SDK for the type alone (the scheduling.md precedent).
export type { TimeRange } from "@stargantt/sdk";
// The plugin's own declaration-merging site (§5's `resourceView/toggled`; the two services
// `stargantt.resource-pool` and `stargantt.utilization` are declared there too). An
// `export type {}` rather than `import type {}`: a plain
// side-effect import is dropped by declaration emission, and the augmentation would then not reach
// a downstream package that only imports from this package's public entry (the scheduling.md
// precedent, verified there against `dist/index.d.ts`).
export type {} from "./types";

/* ------------------------------------------------------------------ *
 * Plugin
 * ------------------------------------------------------------------ */

const PLUGIN_ID = "stargantt.resource";

function setup(ctx: PluginContext, raw: ResourceConfig): void {
  const config = resolveConfig(raw);

  // §9 — `data` (L1) is the only edge this plugin cannot function without: rosters, assignments
  // and task spans all ride it. Every chart-surface edge is resolved per use inside its area.
  const data = ctx.use("stargantt.data");

  const reportError = (error: unknown): void => {
    // Function-shaped configuration (the hook pairs, the accessors, the message builders) is
    // foreign code; a fault in it is reported through `core/pluginError`. The contributor's own id
    // is not observable through the public API, so this plugin is named.
    ctx.emit("core/pluginError", { pluginId: PLUGIN_ID, error });
  };

  const messages = resolveMessages(raw.messages, (messageKey, cause) => {
    ctx.emit("core/pluginError", { pluginId: PLUGIN_ID, error: { messageKey, cause } });
  });

  // §2.3 — ONE per-resource working-interval cache for the whole plugin instance, shared by every
  // bucketed surface so two of them can never disagree about a resource's working time. Its
  // source is bound below once `wirePool` runs (the very first call in the sequence at the bottom
  // of this function) via `deps.bindIntervalSource`; in any composition every resource still lists
  // the shared `sdk/time` default week until the pool actually knows it. Created per instance,
  // never a module-level singleton, and dropped with the plugin.
  let intervalSource: WorkingTimeSource | undefined;
  const intervals = createWorkingIntervalCache(() => intervalSource);

  // §1.2 — the eight `LoadChartService` strip members forward from `UtilizationService` to the
  // load-chart area's own strip control, bound once `wireLoadChart` runs (after `wireUtilization`
  // in the sequence below); read lazily by `wireUtilization`, never latched.
  let loadChartStrips: LoadChartSurface | undefined;

  // §9 note (own-service seam) — `wirePool` runs first below and unconditionally provides
  // `stargantt.resource-pool`, so this is non-`undefined` for every other area by the time it runs.
  let resourcePool: ReturnType<ResourceAreaDeps["resourcePool"]>;

  const deps: ResourceAreaDeps = {
    ctx,
    config,
    messages,
    data,
    intervals,
    bindIntervalSource: (source) => {
      intervalSource = source;
    },
    resourcePool: () => resourcePool,
    bindResourcePool: (pool) => {
      resourcePool = pool;
    },
    loadChartStrips: () => loadChartStrips,
    bindLoadChartStrips: (strips) => {
      loadChartStrips = strips;
    },
    reportError,
  };

  // §6 presence semantics: an omitted nest leaves its feature dormant while the two SERVICES stay
  // provided, so the nest guards live inside each `wire*` function rather than here.
  wirePool(deps);
  wireAssign(deps);
  wireView(deps);
  wireUtilization(deps);
  wireLoadChart(deps);
}

/**
 * Creates the resource plugin: the resource-pool ledger, assignment editing, the resource-view
 * strip, utilization analysis and the load chart, over one unified aggregation engine.
 *
 * Configurable plugins are exported as factories because the host passes no per-plugin config to
 * `setup()`: the configuration is closed over here and the produced plugin itself takes `void`.
 */
export function resource(config: ResourceConfig = {}): Plugin<void> {
  // A snapshot, so a later mutation of the caller's object cannot change a running chart.
  const options: ResourceConfig = { ...config };
  return definePlugin<void>({
    meta: {
      id: PLUGIN_ID,
      // §9 — `data` (L1) is the only indispensable edge. Every chart-surface edge follows the
      // scheduling.md §14 optional-inert pattern: absent, every strip, column, glyph, panel and
      // the heatmap stay SILENTLY inert (no `core/pluginError` — that is reserved for foreign-code
      // faults, not for a composition simply not including a chart provider) while both services
      // keep working headless. `dataStore() + resource()` computes utilization and serializes
      // reports in plain Node.
      dependsOn: ["stargantt.data-store"],
      optional: [
        "stargantt.view",
        "stargantt.tree-grid",
        "stargantt.task-bars",
        "stargantt.interaction",
        "stargantt.export",
      ],
    },
    setup: (ctx) => setup(ctx, options),
  });
}
