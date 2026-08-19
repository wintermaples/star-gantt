// docs/specs/plugins/resource.md §8 — the five internal feature areas.
/**
 * One bag every area's `wire*` entry point takes.
 *
 * The unified aggregation engine (`internal/engine/`, §2) is headless and reference-free of this
 * bag entirely; all five UI/service areas — pool, assign, view, utilization, load-chart — are
 * wired through it from `src/index.ts`'s single `setup()`, each gated internally on its own
 * configuration nest (§6). A later addition needing a service this plugin does not consume yet
 * (an optional edge under §9's per-use/`lifecycle/ready` timing rule) adds the member here and the
 * one resolution line that fills it in `index.ts`, without restructuring the areas that already
 * consume the bag. `dependsOn` stays `["stargantt.data-store"]` regardless — every cross-area
 * service this bag carries (`resourcePool`, `loadChartStrips`) is provided BY this plugin on
 * ITSELF, routed around the public service registry precisely so it never needs a `dependsOn`
 * entry of its own (see the `resourcePool`/`bindResourcePool` doc below) — which
 * `expectDepsConsistency` pins.
 */
import type { PluginContext } from "@stargantt/core";
import type { DataService } from "@stargantt/plugin-data-store";
import type { ResolvedResourceConfig } from "../config";
import type { ResourceMessages } from "./messages";
import type { WorkingIntervalCache, WorkingTimeSource } from "./engine/working-time";
import type { UtilizationBucketUnit } from "./engine/buckets";
import type { ResourcePoolService } from "./pool/service";

/** What every `wire*` entry point is handed. */
export interface ResourceAreaDeps {
  /** This plugin's own context — claims, contributions, ownership. */
  ctx: PluginContext;
  /** The whole resolved configuration; each area reads its own nest (`undefined` = dormant). */
  config: ResolvedResourceConfig;
  /** The resolved message catalog, shared by all five areas (§7). */
  messages: ResourceMessages;
  /** The data store (L1) — the one hard service dependency (§9). */
  data: DataService;
  /**
   * The shared per-resource working-interval windows (§2.3). Every bucketed surface reads working
   * time through this one cache, and it is invalidated wholesale on the pool `resources` store
   * notification and by nothing else — a task edit cannot move working time.
   */
  intervals: WorkingIntervalCache;
  /**
   * Called by the pool area, once its service exists, so the shared `intervals` cache begins
   * reading pool policy instead of the `sdk/time` default week for every resource (§2.3). The pool
   * area itself is responsible for calling `intervals.invalidate()` on its own `resources` store
   * notification — the ONLY invalidation edge (§2.3) — this setter only rebinds the source.
   */
  bindIntervalSource(source: WorkingTimeSource): void;
  /**
   * The pool service, once `wirePool` has built and `ctx.provide`d it. `wirePool` runs first in
   * `index.ts`'s fixed sequence and the service is UNCONDITIONAL (§6), so every other area sees it
   * non-`undefined` by the time its own `wire*` runs — this bag entry exists so the other areas
   * read the plugin's own pool the same way they read every other cross-area seam here, rather
   * than round-tripping through `ctx.use("stargantt.resource-pool")` (which `expectDepsConsistency`
   * would then require in `dependsOn`, for an edge that is this plugin talking to itself).
   */
  resourcePool(): ResourcePoolService | undefined;
  /** Called once by the pool area after it provides the service. */
  bindResourcePool(pool: ResourcePoolService): void;
  /**
   * The load-chart area's strip control, once it has wired the two `view/bottomPanes` strips
   * (§1.2's eight relocated `LoadChartService` members live on `UtilizationService`, but the
   * strips themselves are `internal/load-chart`'s — `wireUtilization` runs before `wireLoadChart`
   * in `index.ts`, so it reads this lazily, per use, never latching an `undefined` at wire time).
   * `undefined` until the load-chart area calls `bindLoadChartStrips`, and permanently `undefined`
   * in a composition without the `loadChart` nest or without `stargantt.view` — both of which leave
   * the eight members inert (§1.2's "inert while `stargantt.view` is absent" extended the one step
   * further the presence rule already implies: no strip, no control surface for it).
   */
  loadChartStrips(): LoadChartSurface | undefined;
  /**
   * Called once by the load-chart area after it wires its two strips, the heatmap card and the
   * report writers. `undefined` (the initial state) makes every one of the thirteen forwarded
   * `UtilizationService` members (§1.2) behave exactly as the "inert while `stargantt.view` is
   * absent" rule already requires: visibility reads `false`, heights read `0`, the setters are
   * no-ops, `openHeatmap`/`closeHeatmap` do nothing, and the three report methods answer the empty
   * report (an empty row list, a header-only CSV, a valid empty-table PDF) — the same shape a
   * composition without the `loadChart` nest, or without `stargantt.view`, already produces.
   */
  bindLoadChartStrips(strips: LoadChartSurface): void;
  /** Reports a fault in host-supplied code through `core/pluginError`. */
  reportError(error: unknown): void;
}

/**
 * The load-chart area's own control of its two strips, its heatmap card and its report writers —
 * the primitives the thirteen `LoadChartService` members relocated onto `UtilizationService`
 * (§1.2) forward to. `internal/load-chart` builds this over the SAME matrix consumer the band and
 * lanes read (the `loadChart` nest's allowlisted roster, hook pair, `edges: "aligned"`), which is
 * why the reports and the heatmap live here rather than in `internal/utilization` despite being
 * named on `UtilizationService` (§2.5: "every load-chart surface ... passes edges: 'aligned'").
 */
export interface LoadChartSurface {
  bandVisible(): boolean;
  setBandVisible(visible: boolean): void;
  lanesVisible(): boolean;
  setLanesVisible(visible: boolean): void;
  bandHeight(): number;
  setBandHeight(px: number): void;
  lanesHeight(): number;
  setLanesHeight(px: number): void;
  openHeatmap(options?: UtilizationReportOptions): void;
  closeHeatmap(): void;
  utilizationReport(options?: UtilizationReportOptions): readonly UtilizationReportRow[];
  utilizationReportCSV(options?: UtilizationReportOptions): string;
  utilizationReportPDF(options?: UtilizationReportOptions): Blob;
}

/** §1.2 — one resource x bucket cell of the utilization report and the heatmap. */
export interface UtilizationReportCell {
  readonly start: number;
  readonly end: number;
  readonly allocated: number;
  readonly capacity: number;
  readonly ratio: number | null;
}

/** §1.2 — one resource row of the utilization report. */
export interface UtilizationReportRow {
  readonly resourceId: string | number;
  readonly resourceName: string;
  readonly cells: readonly UtilizationReportCell[];
}

/** §1.2 — range/bucket selector of the report methods; the report path auto-coarsens toward
 *  `"month"` to keep at most 200 columns (§2.5). */
export interface UtilizationReportOptions {
  start?: number;
  end?: number;
  bucket?: UtilizationBucketUnit;
}
