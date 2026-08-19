/**
 * StarGantt — the single-file distribution bundle.
 *
 * This package carries the kernel, the currently-implemented official plugins and the default
 * stylesheet in one artifact. The IIFE build exposes all of it on the global `StarGantt`, so a
 * page needs one `<script>` tag and nothing else:
 *
 * ```html
 * <div id="chart" style="height: 480px"></div>
 * <script src="stargantt.iife.js"></script>
 * <script>
 *   const gantt = StarGantt.create({
 *     element: document.getElementById("chart"),
 *     plugins: StarGantt.presetStandard(),
 *   });
 * </script>
 * ```
 *
 * The standard preset composes nine plugins (data-store, view, tree-grid, task-bars, interaction,
 * undo-redo, a11y, scheduling, export — see `@stargantt/preset-standard`). The remaining six
 * official plugins (tracking, resource, data-sync, portfolio, i18n, perf-tools) ship in this
 * bundle too, but OPT-IN rather than preset-composed: import `StarGantt.tracking`,
 * `StarGantt.resource`, and so on, and add them to the plugin list handed to `create()` alongside
 * `presetStandard()`. All fifteen official plugins ship in this one artifact; the six opt-in ones
 * follow the pattern of a bare side-effect import per plugin (for its
 * `declare module "@stargantt/core"` augmentation) plus a named value + full type re-export, since
 * an opt-in plugin's own package is never otherwise imported by a `stargantt`-only program.
 *
 * Every bundled plugin — preset-composed or opt-in — gets its own bare side-effect import here,
 * regardless of whether `PresetStandardConfig` or an opt-in factory's own import already mentions
 * its config type: a type only becomes *reachable* to a consumer's program when the module that
 * declares it is actually loaded while resolving that consumer's types, and nesting a config type
 * inside another interface's property does not by itself guarantee that. A bare import per plugin
 * is the un-ambiguous fix and costs nothing at runtime — every one of these packages is already
 * bundled in transitively via `presetStandard`.
 */
import { Gantt } from "@stargantt/core";
import type { GanttInstance, GanttOptions } from "@stargantt/core";
import { presetStandard } from "@stargantt/preset-standard";
// These bare imports carry each plugin's `declare module "@stargantt/core"` augmentation to
// anyone who imports `stargantt` alone — see the file header and docs/specs/architecture.md
// chapter 2 (module augmentation reach). `presetStandard`'s own signature mentions no plugin
// type, so its declaration emit alone would not carry these through.
import "@stargantt/plugin-data-store";
import "@stargantt/plugin-view";
import "@stargantt/plugin-tree-grid";
import "@stargantt/plugin-task-bars";
import "@stargantt/plugin-interaction";
import "@stargantt/plugin-undo-redo";
import "@stargantt/plugin-a11y";
import "@stargantt/plugin-scheduling";
import "@stargantt/plugin-export";
import "@stargantt/plugin-tracking";
import "@stargantt/plugin-resource";
import "@stargantt/plugin-data-sync";
import "@stargantt/plugin-portfolio";
import "@stargantt/plugin-i18n";
import "@stargantt/plugin-perf-tools";
import tokensCss from "./styles/tokens.css?inline";
import layoutCss from "./styles/layout.css?inline";
import pluginsCss from "./styles/plugins.css?inline";

export * from "@stargantt/core";
export { presetStandard } from "@stargantt/preset-standard";
export type { PresetStandardConfig } from "@stargantt/preset-standard";
// The one SDK member that is host-facing public API rather than plugin-author tooling: the export
// facade returns bytes/strings and export.md §1.9 names `downloadFile` (sdk/dom) as the host's
// save-to-file one-liner — an IIFE-only consumer has no other way to reach it.
export { downloadFile } from "@stargantt/sdk";

// ---------------------------------------------------------------------- *
// Standalone values contributed by preset plugins
// ---------------------------------------------------------------------- *
// The nine preset plugins are already fully reachable through `gantt.service(id)`, typed via the
// `declare module "@stargantt/core"` augmentations carried by the bare imports above — a
// `stargantt`-only consumer never needs to import `@stargantt/plugin-tree-grid` to get a correctly
// typed `GridService` instance back from `gantt.service("stargantt.tree-grid")`. The handful of
// exports below are the exception: standalone values a preset plugin publishes that are used
// *outside* its own service (passed into config, or read as a constant), so they have no
// service-typed path to a consumer at all. Each is followed by the type(s) needed to name its
// parameter or return value; the rest of that plugin's type surface stays reachable only through
// its service — the same treatment given to other preset plugins'
// non-service values (timeline-scale's `ZoomLevelMetrics`/`GridCell`, tree-grid's bundled column
// editors, theme's preset palettes and token registries).
export { dateEditor, selectEditor } from "@stargantt/plugin-tree-grid";
export type { CellRenderer, ColumnLayoutConfig, InsertPosition, SelectOption } from "@stargantt/plugin-tree-grid";
export { regionCalendar } from "@stargantt/plugin-scheduling";
export type { CalendarInit, RegionCalendarInit } from "@stargantt/plugin-scheduling";
export { DEFAULT_MESSAGES } from "@stargantt/plugin-a11y";
export type { A11yMessages } from "@stargantt/plugin-a11y";
export {
  BUILT_IN_PRESETS,
  CANVAS_READ_TOKENS,
  FORCED_COLOR_TOKENS,
  HIGH_CONTRAST_DARK,
  HIGH_CONTRAST_LIGHT,
  NON_COLOR_CANVAS_TOKENS,
  RETIRED_TOKENS,
} from "@stargantt/plugin-view";
export type {
  ColorScheme,
  GridCell,
  PresetTokens,
  SetPresetOptions,
  ThemeAuditEntry,
  ThemePreset,
  ZoomLevelMetrics,
} from "@stargantt/plugin-view";

// ---------------------------------------------------------------------- *
// Opt-in plugins
// ---------------------------------------------------------------------- *
// Not part of `presetStandard()`, so re-exported by name for callers who want to compose them onto
// the plugin list themselves, e.g. `[...presetStandard(), tracking(), resource()]`. Unlike the
// preset plugins above, an opt-in plugin's package is never a dependency of a `stargantt`-only
// program (nothing else in the bundle names it), so `stargantt` is the *only* place that program can
// name its types — every type each opt-in package exports is re-exported here, not just its config.
export { tracking } from "@stargantt/plugin-tracking";
export type {
  ActualDates,
  Baseline,
  BaselineId,
  BaselineInfo,
  BaselineInit,
  BaselineLinkSnapshot,
  BaselinesConfig,
  BaselinesService,
  BaselinesState,
  BaselineTaskSnapshot,
  BreakdownEntryData,
  BudgetComparisonRow,
  CostAlert,
  CostBaseline,
  CostBreakdown,
  CostConfig,
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
  CriticalPathDelta,
  EacMethod,
  EarnedValueMethod,
  EvmAccrualFn,
  EvmConfig,
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
  LateTaskEntry,
  ProgressConfig,
  ProgressFieldsBatchEntry,
  ProgressPatch,
  ProgressService,
  ProgressSnapshot,
  ProgressState,
  ProgressValues,
  RagStatus,
  ScheduleSummary,
  StatusReport,
  TableRow,
  TaskCost,
  TrackingConfig,
  TrackingMessages,
  VarianceRow,
} from "@stargantt/plugin-tracking";
export { resource } from "@stargantt/plugin-resource";
export type {
  BookingFilter,
  BookingState,
  LoadChartBandLabelInput,
  LoadChartBucketInput,
  LoadChartConfig,
  LoadChartHeatmapCellInput,
  LoadChartLaneLabelInput,
  LoadChartLanesLabelInput,
  OverallocationInfo,
  ResolvedLoadChart,
  ResolvedResourceAssign,
  ResolvedResourceConfig,
  ResolvedResourcePool,
  ResolvedResourceUtilization,
  ResolvedResourceView,
  ResourceAssignConfig,
  ResourceBooking,
  ResourceBookingInit,
  ResourceConfig,
  ResourceFilter,
  ResourceKind,
  ResourceMessages,
  ResourcePoolConfig,
  ResourcePoolEntry,
  ResourcePoolEntryInit,
  ResourcePoolService,
  ResourceTimeOff,
  ResourceTimeOffInit,
  ResourceUtilizationConfig,
  ResourceViewConfig,
  ResourceViewRowLabelInput,
  ResourceViewSegmentLabelInput,
  ResourceViewTeam,
  ResourceViewTeamSummaryInput,
  ResourceWorkCalendar,
  RoleDemand,
  TeamCapacitySummary,
  TimeRange,
  TrendPoint,
  UtilizationBucket,
  UtilizationBucketUnit,
  UtilizationQuery,
  UtilizationReportCell,
  UtilizationReportColumn,
  UtilizationReportOptions,
  UtilizationReportRow,
  UtilizationService,
  UtilizationState,
} from "@stargantt/plugin-resource";
// data-sync's hostless adapter/transport factories are public API (usable before `create()`), so
// the IIFE global carries them too.
export {
  dataSync,
  restAdapter,
  localAdapter,
  graphqlAdapter,
  webSocketTransport,
  sseTransport,
} from "@stargantt/plugin-data-sync";
export type {
  AppliedCounts,
  ChangeBatch,
  DataSourceAdapter,
  DataSourceFilter,
  DataSyncConfig,
  DataSyncService,
  DeltaChange,
  DeltaRequest,
  DeltaResult,
  EnsureResult,
  EventSourceLike,
  FetchRequest,
  FetchResult,
  FlushResult,
  GraphqlAdapterConfig,
  GraphqlOperations,
  GraphqlSelect,
  GraphqlSourceConfig,
  LazyArea,
  LazyLoadAdapter,
  LazyLoadAppliedCounts,
  LazySourceRegistry,
  LoadResult,
  LocalDocument,
  OfflineArea,
  OfflineStorageResult,
  PersistedDocument,
  PushResult,
  RangeRequest,
  RangeResult,
  RealtimeApplyResult,
  RealtimeArea,
  RealtimeChange,
  RealtimeConnection,
  RealtimeMessage,
  RealtimeStatus,
  RealtimeStatusCause,
  RealtimeTransport,
  RealtimeTransportHandlers,
  RestAdapterConfig,
  RollbackResult,
  SnapshotContribution,
  SourceRegistry,
  SseTransportConfig,
  StreamChange,
  SyncActivity,
  SyncResult,
  TransportRegistry,
  WebSocketLike,
  WebSocketTransportConfig,
} from "@stargantt/plugin-data-sync";
export { portfolio } from "@stargantt/plugin-portfolio";
export type {
  BurndownPoint,
  BurndownSeries,
  DashboardFormulaInit,
  DashboardModel,
  DashboardService,
  DashboardWidgetId,
  DashboardWidgetRenderContext,
  DuplicateProjectOptions,
  FormulaValue,
  GoalRollupEntry,
  GroupProgressEntry,
  MilestoneEntry,
  NodeNameArg,
  OverdueEntry,
  PortfolioConfig,
  PortfolioDashboardConfig,
  PortfolioGoal,
  PortfolioGoalId,
  PortfolioGoalInit,
  PortfolioGoalProgress,
  PortfolioHealth,
  PortfolioHealthStatus,
  PortfolioMessages,
  PortfolioNode,
  PortfolioNodeId,
  PortfolioNodeInit,
  PortfolioNodeKind,
  PortfolioService,
  PortfolioStatusRow,
  PortfolioTreeNode,
  PortfolioView,
  ProgressSummary,
  StatusCounts,
  TaskStatusPatch,
  WorkloadEntry,
} from "@stargantt/plugin-portfolio";
export { i18n, createDictionary } from "@stargantt/plugin-i18n";
export type { I18nConfig, I18nService, I18nState, TranslationEntries } from "@stargantt/plugin-i18n";
export { perfTools } from "@stargantt/plugin-perf-tools";
export type {
  FrameStats,
  OverlayCorner,
  PerfToolsConfig,
  PerfToolsMessages,
  PerfToolsService,
  PerfTrace,
  PerfTraceFrame,
  PerfTraceMark,
} from "@stargantt/plugin-perf-tools";

/* ------------------------------------------------------------------ *
 * Style injection
 * ------------------------------------------------------------------ */

/** Id of the `<style>` element the default stylesheet is injected as. */
const STYLE_ELEMENT_ID = "sg-styles";

// The default stylesheet is authored as one document but
// split into three parts on disk to respect this repo's 800-line-per-file convention (see each
// part's header comment); concatenating them in order reproduces the intended stylesheet's rules
// exactly (part-marker comments aside — the split added a one-line banner to each part's header).
const defaultStyles = tokensCss + layoutCss + pluginsCss;

/**
 * Adds the default stylesheet to a document, once.
 *
 * Nothing is added if an element with the injection id is already present — so several charts in
 * one document, or a page that ships the stylesheet itself under that id, all end up with exactly
 * one copy. Documents without a place to put a `<style>` element are left alone.
 */
function injectDefaultStyles(doc: Document | null | undefined): void {
  if (doc === null || doc === undefined) return;
  if (typeof doc.getElementById !== "function") return;
  if (doc.getElementById(STYLE_ELEMENT_ID) !== null) return;

  const parent = doc.head ?? doc.documentElement;
  if (parent === null || parent === undefined) return;

  const style = doc.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = defaultStyles;
  parent.appendChild(style);
}

/* ------------------------------------------------------------------ *
 * Public entry point
 * ------------------------------------------------------------------ */

/**
 * Options for {@link create} — the options the kernel takes, plus control over style injection.
 */
export interface CreateOptions extends GanttOptions {
  /**
   * Whether to add the default stylesheet to the document. Defaults to `true`.
   *
   * Set it to `false` under a Content Security Policy that forbids inline styles, and load the
   * stylesheet yourself instead. The chart renders either way; without any stylesheet the panes
   * lose their layout and the theme falls back to the colours built into each plugin.
   */
  injectStyles?: boolean;
}

/**
 * Creates a chart in the given element.
 *
 * This is `Gantt.create` with one addition: the first call adds the default stylesheet to the
 * element's document as a `<style>` element, unless `injectStyles` is `false` or the document
 * already has one. The plugin list is passed through unchanged — call {@link presetStandard} for
 * the full official set, or hand over any array to compose your own chart.
 *
 * Call `dispose()` on the returned instance to tear the chart down; the stylesheet is shared by
 * every chart in the document and is left in place.
 */
export function create(opts: CreateOptions): GanttInstance {
  if (opts.injectStyles !== false) injectDefaultStyles(opts.element?.ownerDocument);
  return Gantt.create(opts);
}
