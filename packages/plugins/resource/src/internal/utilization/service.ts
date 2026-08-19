// docs/specs/plugins/resource.md §1.2 — `UtilizationService` and its supporting types.
/**
 * The public shape of `stargantt.utilization`. Declared here (mirroring `internal/pool/service.ts`)
 * so `internal/load-chart` can import the report/heatmap-adjacent types (`UtilizationReportRow` /
 * `UtilizationReportCell` / `UtilizationReportOptions`) without a cycle through the package entry —
 * load-chart both CONSUMES these types (it builds the report matrix) and its wiring is called BY
 * `wireUtilization` through `ResourceAreaDeps.loadChartStrips()` for the 13 relocated
 * `LoadChartService` members (§1.2 resolution 2 — 8 strip + 2 heatmap + 3 report).
 */
import type { Store } from "@stargantt/core";
import type { ResourceId } from "@stargantt/plugin-data-store";
import type { UtilizationBucketUnit } from "../engine/buckets";
import type { RoleDemand, TeamCapacitySummary, TrendPoint } from "../engine/rollups";
import type { UtilizationReportColumn } from "../messages";
// `areas.ts` is the canonical declaration site for the three report/heatmap shapes: `LoadChartSurface`
// (the seam `internal/load-chart` binds) is typed in terms of them, and load-chart both builds and
// consumes them, so they live where both `internal/utilization` and `internal/load-chart` can reach
// them without a cycle through the package entry.
import type {
  UtilizationReportCell,
  UtilizationReportOptions,
  UtilizationReportRow,
} from "../areas";

export type {
  RoleDemand,
  TeamCapacitySummary,
  TrendPoint,
  UtilizationReportColumn,
  UtilizationReportCell,
  UtilizationReportOptions,
  UtilizationReportRow,
};

/** One aggregation bucket of a resource's utilization (§1.2). */
export interface UtilizationBucket {
  readonly start: number;
  readonly end: number;
  readonly allocated: number;
  readonly capacity: number;
  readonly ratio: number | null;
  readonly overallocated: boolean;
}

/** One over-allocated resource, as `overallocations()` reports it. */
export interface OverallocationInfo {
  readonly resourceId: ResourceId;
  readonly name: string;
  readonly peakRatio: number | null;
  readonly buckets: readonly UtilizationBucket[];
}

/** Range/bucket selector accepted by every query method. Every member optional. */
export interface UtilizationQuery {
  start?: number;
  end?: number;
  bucket?: UtilizationBucketUnit;
}

/** The observable aggregation state (§1.2's freshness store). */
export interface UtilizationState {
  readonly rows: readonly {
    readonly resourceId: ResourceId;
    readonly name: string;
    readonly buckets: readonly UtilizationBucket[];
  }[];
}

/** §1.2 — 24 members: the `state` store + 23 methods. */
export interface UtilizationService {
  readonly state: Store<UtilizationState>;
  utilization(resourceId: ResourceId, query?: UtilizationQuery): readonly UtilizationBucket[];
  isOverallocated(resourceId: ResourceId, query?: UtilizationQuery): boolean;
  overallocations(query?: UtilizationQuery): readonly OverallocationInfo[];
  demandByRole(query?: UtilizationQuery): readonly RoleDemand[];
  teamSummary(query?: UtilizationQuery): readonly TeamCapacitySummary[];
  trend(query?: UtilizationQuery & { team?: string; role?: string }): readonly TrendPoint[];
  utilizationReport(options?: UtilizationReportOptions): readonly UtilizationReportRow[];
  utilizationReportCSV(options?: UtilizationReportOptions): string;
  utilizationReportPDF(options?: UtilizationReportOptions): Blob;
  openHeatmap(options?: UtilizationReportOptions): void;
  closeHeatmap(): void;
  openSummaryPanel(): void;
  closeSummaryPanel(): void;
  openTrendPanel(): void;
  closeTrendPanel(): void;

  // --- the two load-chart strips (LoadChartService members, carried) ---
  bandVisible(): boolean;
  setBandVisible(visible: boolean): void;
  lanesVisible(): boolean;
  setLanesVisible(visible: boolean): void;
  bandHeight(): number;
  setBandHeight(px: number): void;
  lanesHeight(): number;
  setLanesHeight(px: number): void;
}
