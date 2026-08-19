// docs/specs/plugins/resource.md §1.2 / §3.5 — the utilization surfaces.
/**
 * Entry point of the utilization area: the `stargantt.utilization` service with its §1.2 freshness
 * store (the CriticalPathService dirty-flag pattern, replicated here), the task-bar overload
 * glyph, the `resource.overallocation` grid column, and the summary / trend panels.
 *
 * Every query member reads the §2 engine with `edges: "clamped"`, the union roster (§2.3), and the
 * `utilization` nest's own hook pair (§2.4 / §2.5). The service is provided UNCONDITIONALLY (§6),
 * so the nest guard gates only the warning surfaces and the panels.
 *
 * The 13 relocated `LoadChartService` members (§1.2 resolution 2) forward to
 * `deps.loadChartStrips()`, read lazily per call — `wireLoadChart` runs after this area, and
 * `optional` service resolution is never an ordering edge (§9).
 */
import { createStore } from "@stargantt/core";
import type { WritableStore } from "@stargantt/core";
import type { ResourceId } from "@stargantt/plugin-data-store";
import { computeUtilization } from "../engine/compute";
import type { BucketInput, EngineHooks, UtilizationMatrixRow } from "../engine/compute";
import { alignRange, taskExtent } from "../engine/range";
import { overlaps, peakRatio, roleDemands, teamSummaries, trendPoints } from "../engine/rollups";
import type { RollupMember } from "../engine/rollups";
import type { ResourceAreaDeps } from "../areas";
import { buildUnionRoster, buildUtilizationDemands } from "./roster";
import type { UtilizationResourceSource } from "./roster";
import {
  emptyUtilizationReport,
  emptyUtilizationReportCSV,
  emptyUtilizationReportPDF,
} from "./empty-report";
import type {
  OverallocationInfo,
  UtilizationBucket,
  UtilizationQuery,
  UtilizationReportOptions,
  UtilizationReportRow,
  UtilizationService,
  UtilizationState,
} from "./service";
import { createWarningIndex, wireWarningGlyph } from "./warnings";
import { wireColumn } from "./column";
import { wirePanels } from "./panels";

const EMPTY_STATE: UtilizationState = { rows: [] };

/** Wires the utilization area; returns the assembled service (also `ctx.provide`d). */
export function wireUtilization(deps: ResourceAreaDeps): UtilizationService {
  const { ctx, config, data, messages, intervals, reportError } = deps;
  const nest = config.utilization;

  /* --- §2.5 range resolution: query -> config range -> task extent, member-wise ------------- */

  function extentRange(): { start: number; end: number } | null {
    return taskExtent(data.query().byId.values());
  }

  function resolveRange(query: UtilizationQuery | undefined): { start: number; end: number } | null {
    const configRange = nest?.range;
    const extent = extentRange();
    const start =
      usableNumber(query?.start) ?? (configRange !== undefined ? configRange.start : undefined) ??
      extent?.start;
    const end =
      usableNumber(query?.end) ?? (configRange !== undefined ? configRange.end : undefined) ??
      extent?.end;
    if (start === undefined || end === undefined) return null;
    return alignRange(start, end);
  }

  function usableNumber(value: number | undefined): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }

  function weekStartDay(): number {
    return nest?.weekStart === "sunday" ? 0 : 1;
  }

  function threshold(): number {
    return nest?.threshold ?? 1;
  }

  /**
   * §6.4 — `utilization.role` / `utilization.team` are host-supplied foreign code (`role` is
   * always a function once config resolution defaults it to the built-in "first skill tag, else
   * kind" rule; `team` stays `undefined` unless the host supplied one — see `config.ts`). Latched:
   * the first throw is reported once via `deps.reportError`, and every later call for the rest of
   * this plugin instance's life answers `undefined` instead of calling through again (the same
   * latched-builder-barrier shape `view/wire.ts`'s `projectOf` uses, §3.4).
   */
  function latchedAccessor<T>(
    fn: ((entry: import("../pool/service").ResourcePoolEntry) => T | undefined) | undefined,
    where: string,
  ): ((entry: import("../pool/service").ResourcePoolEntry) => T | undefined) | undefined {
    if (fn === undefined) return undefined;
    let latched = false;
    return (entry) => {
      if (latched) return undefined;
      try {
        return fn(entry);
      } catch (error) {
        latched = true;
        reportError({ where, error });
        return undefined;
      }
    };
  }
  const roleAccessor = latchedAccessor(nest?.role, "utilization.role");
  const teamAccessor = latchedAccessor(nest?.team, "utilization.team");

  function hooks(): EngineHooks<UtilizationResourceSource> {
    const h: EngineHooks<UtilizationResourceSource> = {
      onError: (where, error) => reportError({ where, error }),
    };
    if (nest?.resourceLoad !== undefined) h.resourceLoad = nest.resourceLoad;
    if (nest?.resourceCapacity !== undefined) h.resourceCapacity = nest.resourceCapacity;
    return h;
  }

  /* --- the §2 build, over a caller-chosen roster subset -------------------------------------- */

  function build(
    roster: ReturnType<typeof buildUnionRoster>,
    query: UtilizationQuery | undefined,
  ): readonly UtilizationMatrixRow<UtilizationResourceSource>[] {
    const range = resolveRange(query);
    if (range === null || roster.length === 0) return [];
    const input: BucketInput<UtilizationResourceSource> = {
      resources: roster,
      demands: buildUtilizationDemands(data),
      start: range.start,
      end: range.end,
      bucket: query?.bucket ?? nest?.bucket ?? "day",
      edges: "clamped",
      weekStartDay: weekStartDay(),
      threshold: threshold(),
      hooks: hooks(),
    };
    return computeUtilization(input).rows;
  }

  function toPublicBucket(cell: UtilizationMatrixRow<UtilizationResourceSource>["cells"][number]): UtilizationBucket {
    return {
      start: cell.start,
      end: cell.end,
      allocated: cell.allocated,
      capacity: cell.capacity,
      ratio: cell.ratio,
      overallocated: cell.overallocated,
    };
  }

  /* --- §1.2 freshness store (the CriticalPathService dirty-flag pattern, replicated) --------- */

  const store: WritableStore<UtilizationState> = createStore(EMPTY_STATE);
  let dirty = false;
  let subscriberCount = 0;
  let summaryPanelOpen = false;
  let trendPanelOpen = false;

  // §1.2 (spec line ~398): "any warning surface is active per config (`warnings`, `column`, an
  // open panel OR STRIP)" — a visible load-chart band/lanes strip counts toward `visualsActive()`
  // too, alongside the two panels, even though load-chart's own paint reads its OWN matrix (not
  // `state`): the two nests share one freshness umbrella (the very next spec sentence pairs
  // "the `utilization` AND `loadChart` nests dormant" as the one case that pays nothing). Read via
  // `deps.loadChartStrips()`, lazily — `wireLoadChart` runs after this area (§9's timing rule).
  function visualsActive(): boolean {
    const strips = deps.loadChartStrips();
    return (
      nest?.warnings === true ||
      nest?.column === true ||
      summaryPanelOpen ||
      trendPanelOpen ||
      (strips !== undefined && (strips.bandVisible() || strips.lanesVisible()))
    );
  }

  function ensureFresh(): void {
    if (!dirty) return;
    dirty = false;
    store.set(recomputeState());
  }

  function markDirty(): void {
    dirty = true;
  }

  function recomputeIfActive(): void {
    if (visualsActive() || subscriberCount > 0) ensureFresh();
  }

  const state = {
    get(): UtilizationState {
      ensureFresh();
      return store.get();
    },
    subscribe(fn: (next: UtilizationState, prev: UtilizationState) => void) {
      ensureFresh();
      subscriberCount += 1;
      const sub = store.subscribe(fn);
      let disposed = false;
      const wrapped = Object.create(sub) as typeof sub;
      wrapped.dispose = () => {
        if (disposed) return;
        disposed = true;
        subscriberCount -= 1;
        sub.dispose();
      };
      return wrapped;
    },
  };

  /* --- pool service (always provided, §6) ----------------------------------------------------- */

  // `deps.resourcePool()`, not `ctx.use("stargantt.resource-pool")`: this plugin provides that
  // service on ITSELF (`wirePool` runs first in `src/index.ts`'s single `setup()`), and routing an
  // intra-plugin self-provided lookup through the public service registry would make
  // `expectDepsConsistency`'s mock context (which does not model the real core's `consumer ===
  // provider` self-use exemption, `packages/core/src/internal/services.ts`) misreport it as an
  // undeclared hard dependency — `meta.dependsOn` must stay exactly `["stargantt.data-store"]`
  // (§9). The `bindResourcePool`/`resourcePool` seam in `areas.ts` is the sanctioned cross-area
  // path instead, mirroring `bindIntervalSource`/`bindLoadChartStrips`. The fallback branch below
  // is unreachable in the real host (§6: the pool service is provided unconditionally, before this
  // area wires) but keeps the type honest.
  const poolOrUndefined = deps.resourcePool();
  if (poolOrUndefined === undefined) {
    const service: UtilizationService = {
      state,
      utilization: () => [],
      isOverallocated: () => false,
      overallocations: () => [],
      demandByRole: () => [],
      teamSummary: () => [],
      trend: () => [],
      utilizationReport: () => emptyUtilizationReport(),
      utilizationReportCSV: () => emptyUtilizationReportCSV(messages),
      utilizationReportPDF: () => emptyUtilizationReportPDF(),
      openHeatmap: () => undefined,
      closeHeatmap: () => undefined,
      openSummaryPanel: () => undefined,
      closeSummaryPanel: () => undefined,
      openTrendPanel: () => undefined,
      closeTrendPanel: () => undefined,
      bandVisible: () => false,
      setBandVisible: () => undefined,
      lanesVisible: () => false,
      setLanesVisible: () => undefined,
      bandHeight: () => 0,
      setBandHeight: () => undefined,
      lanesHeight: () => 0,
      setLanesHeight: () => undefined,
    };
    ctx.provide("stargantt.utilization", service);
    return service;
  }
  // Re-bound to a non-optional name: TS's control-flow narrowing of a `const` does not carry into
  // a function declared later in the same scope, and every closure below needs the pool resolved.
  const poolService: import("../pool/service").ResourcePoolService = poolOrUndefined;

  function fullRoster(): ReturnType<typeof buildUnionRoster> {
    return buildUnionRoster(poolService, data, intervals);
  }

  function recomputeState(): UtilizationState {
    // §6 presence semantics: an omitted `utilization` nest leaves the FEATURE (warnings, column,
    // panels) dormant, but the SERVICE stays provided "computing over whatever data exists" — the
    // exact same rule the query methods already follow via `nest?.x ?? default` throughout `build`/
    // `resolveRange`/`weekStartDay`/`threshold`/`hooks`. `state` is the default-range aggregation
    // every one of those defaults, so it must compute identically; forcing it to `EMPTY_STATE`
    // whenever `nest` is `undefined` (a prior draft's early return) made a nest-omitted reader see
    // stale/empty rows through `state` while `utilization()`/`overallocations()`/etc. on the SAME
    // service instance answered real data — an inconsistency the spec does not sanction.
    const rows = build(fullRoster(), undefined);
    return {
      rows: rows.map((row) => ({
        resourceId: row.resource.id,
        name: row.resource.name,
        buckets: row.cells.map(toPublicBucket),
      })),
    };
  }

  function markAndMaybeRecompute(): void {
    markDirty();
    recomputeIfActive();
  }

  ctx.own(data.tasks.subscribe(markAndMaybeRecompute));
  ctx.own(data.resources.subscribe(markAndMaybeRecompute));
  ctx.own(data.assignments.subscribe(markAndMaybeRecompute));
  ctx.own(poolService.resources.subscribe(markAndMaybeRecompute));
  ctx.own(poolService.bookings.subscribe(markAndMaybeRecompute));
  markDirty();
  recomputeIfActive();

  /* --- single-resource narrowing (§1.2) -------------------------------------------------------- */

  function utilizationOf(resourceId: ResourceId, query: UtilizationQuery | undefined): UtilizationBucket[] {
    // String-form id matching (matches `byKey.get(String(id))`; consistency with `view`/`assign`'s own
    // string-keyed lookups, §3.4/§3.3): a pool entry's id and a caller's query id can be a number
    // and its string form (or vice versa) for the SAME resource, and strict `===` would silently
    // return "unknown resource" for that entirely legitimate case.
    const key = String(resourceId);
    const row = fullRoster().find((r) => String(r.id) === key);
    if (row === undefined) return [];
    const rows = build([row], query);
    return (rows[0]?.cells ?? []).map(toPublicBucket);
  }

  function isOverallocatedImpl(resourceId: ResourceId, query?: UtilizationQuery): boolean {
    return utilizationOf(resourceId, query).some((b) => b.overallocated);
  }

  /* --- the service ------------------------------------------------------------------------------ */

  const service: UtilizationService = {
    state,
    utilization: (resourceId, query) => utilizationOf(resourceId, query),
    isOverallocated: isOverallocatedImpl,
    overallocations(query) {
      const rows = build(fullRoster(), query);
      const out: OverallocationInfo[] = [];
      for (const row of rows) {
        const buckets = row.cells.filter((c) => c.overallocated).map(toPublicBucket);
        if (buckets.length === 0) continue;
        out.push({
          resourceId: row.resource.id,
          name: row.resource.name,
          peakRatio: peakRatio(row.cells),
          buckets,
        });
      }
      return out;
    },
    demandByRole(query) {
      const rows = build(fullRoster(), query);
      const members: RollupMember[] = rows.map((row) => ({
        role: isPoolEntry(row.resource.source) ? roleAccessor?.(row.resource.source) : undefined,
        cells: row.cells,
      }));
      return roleDemands(members);
    },
    teamSummary(query) {
      const rows = build(fullRoster(), query);
      const members: RollupMember[] = rows.map((row) => ({
        team: teamOf(row.resource.source, teamAccessor, messages.defaultTeamName),
        cells: row.cells,
      }));
      return teamSummaries(members);
    },
    trend(query) {
      let rows = build(fullRoster(), query);
      if (query?.team !== undefined || query?.role !== undefined) {
        rows = rows.filter((row) => {
          const source = row.resource.source;
          if (!isPoolEntry(source)) return false;
          if (query.team !== undefined && teamOf(source, teamAccessor, messages.defaultTeamName) !== query.team) {
            return false;
          }
          if (query.role !== undefined && roleAccessor?.(source) !== query.role) return false;
          return true;
        });
      }
      return trendPoints(rows.map((r) => r.cells));
    },
    // §1.2 resolution 1/2 — reports, heatmap and the 8 strip members read the SAME `loadChart`
    // matrix consumer the band and lanes read (allowlisted roster, edges "aligned"), so they
    // forward to `internal/load-chart`'s own build rather than this area's union roster.
    utilizationReport: (options) => loadChart()?.utilizationReport(options) ?? emptyUtilizationReport(),
    utilizationReportCSV: (options) => loadChart()?.utilizationReportCSV(options) ?? emptyUtilizationReportCSV(messages),
    utilizationReportPDF: (options) => loadChart()?.utilizationReportPDF(options) ?? emptyUtilizationReportPDF(),
    openHeatmap: (options) => loadChart()?.openHeatmap(options),
    closeHeatmap: () => loadChart()?.closeHeatmap(),
    openSummaryPanel() {
      summaryPanelOpen = panels.openSummary();
      recomputeIfActive();
    },
    closeSummaryPanel() {
      panels.closeSummary();
      summaryPanelOpen = false;
    },
    openTrendPanel() {
      trendPanelOpen = panels.openTrend();
      recomputeIfActive();
    },
    closeTrendPanel() {
      panels.closeTrend();
      trendPanelOpen = false;
    },
    bandVisible: () => loadChart()?.bandVisible() ?? false,
    setBandVisible: (visible) => loadChart()?.setBandVisible(visible),
    lanesVisible: () => loadChart()?.lanesVisible() ?? false,
    setLanesVisible: (visible) => loadChart()?.setLanesVisible(visible),
    bandHeight: () => loadChart()?.bandHeight() ?? 0,
    setBandHeight: (px) => loadChart()?.setBandHeight(px),
    lanesHeight: () => loadChart()?.lanesHeight() ?? 0,
    setLanesHeight: (px) => loadChart()?.setLanesHeight(px),
  };

  function loadChart(): ReturnType<ResourceAreaDeps["loadChartStrips"]> {
    return deps.loadChartStrips();
  }

  ctx.provide("stargantt.utilization", service);

  /* --- §3.5 warnings glyph + grid column, sharing the one cached warned-task index ----------- */

  // §1.2 lazy path: `createWarningIndex` reads `state.get()` and then holds a `state.subscribe()`
  // for the rest of the instance's life — building it (and so the index's own `buildIndex` pass)
  // only when at least one of the two surfaces it feeds is actually active keeps a composition
  // with `warnings: false, column: false` (and no panel) from ever pinning `state`'s
  // `subscriberCount` above zero. Both `wireWarningGlyph`/`wireColumn` already early-return on
  // their own flag, so skipping this block when neither is active changes nothing observable.
  if (nest?.warnings === true || nest?.column === true) {
    const warningIndex = createWarningIndex(deps, state);
    wireWarningGlyph(deps, warningIndex);
    wireColumn(deps, warningIndex);
  }

  /* --- §3.5 the two panels --------------------------------------------------------------------- */

  const panels = wirePanels(deps, {
    demandByRole: () => service.demandByRole(),
    teamSummary: () => service.teamSummary(),
    trend: () => service.trend(),
    state,
  });
  // §3.5 — the config-gated panels open on `lifecycle/ready`, not here at `setup()` time:
  // `panelHost()` needs `stargantt.view` resolved, and `optional` is not an ordering edge (§9) —
  // a composition that lists this plugin BEFORE the
  // view plugin would otherwise see `openSummary()`/`openTrend()` fail silently even though both
  // are present. `lifecycle/ready` fires synchronously inside `Gantt.create()`, so the panels are
  // already up when it returns.
  if (nest?.summaryPanel === true || nest?.trendPanel === true) {
    ctx.on("lifecycle/ready", () => {
      if (nest?.summaryPanel === true) summaryPanelOpen = panels.openSummary();
      if (nest?.trendPanel === true) trendPanelOpen = panels.openTrend();
      recomputeIfActive();
    });
  }

  return service;
}

function isPoolEntry(
  source: UtilizationResourceSource,
): source is import("../pool/service").ResourcePoolEntry {
  return "skills" in source;
}

function teamOf(
  source: UtilizationResourceSource,
  accessor: ((entry: import("../pool/service").ResourcePoolEntry) => string | undefined) | undefined,
  defaultTeamName: string,
): string | undefined {
  if (accessor === undefined) return defaultTeamName;
  if (!isPoolEntry(source)) return undefined;
  return accessor(source);
}
