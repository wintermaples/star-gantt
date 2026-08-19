// docs/specs/plugins/resource.md §3.6 — the load chart.
/**
 * Entry point of the load-chart area: the aggregate band (`stargantt.load-chart:total`, order 0)
 * and the per-resource lanes (`stargantt.load-chart:lanes`, order 1), the heatmap card in its
 * claimed `overlay-corner` slot, the CSV/PDF reports, and the `export/auxiliarySurfaces` band
 * surface.
 *
 * This area owns the ONE `engine/memo.ts` instance of the whole plugin (§2.5's M1 ruling): the
 * Σ-mode band and the lanes need the same matrix in the same frame, and within this consumer the
 * roster, hook pair, threshold and edge policy are constants between invalidations. Every surface
 * here passes `edges: "aligned"`; the heatmap and the reports additionally pass `maxColumns: 200`,
 * the strips and the Σ-mode band none.
 *
 * Dormant while the `loadChart` nest is omitted, and inert without `stargantt.view` — in which case
 * `bindLoadChartStrips` is never called and the thirteen relocated `UtilizationService` members
 * keep their documented inert answers (§1.2).
 */
import { createFrameScheduler, createStripHeightTracker, parsePx } from "@stargantt/sdk";
import type { StripHeightTracker, StripToggle } from "@stargantt/sdk";
import type { Resource } from "@stargantt/plugin-data-store";
import type { ResolvedLoadChart } from "../../config";
// Type-only: brings the view plugin's `Services` / `ExtensionPoints` / `Commands` / `Events`
// augmentations into the program (`view/bottomPanes`, `view/setBottomPaneHeight`, `view/scrolled`).
import type {} from "@stargantt/plugin-view";
import type {
  BottomPaneContribution,
  BottomPaneElements,
  ThemeService,
  TimelineService,
  ViewService,
} from "@stargantt/plugin-view";
// Type-only: the export plugin's `export/auxiliarySurfaces` point declaration.
import type {} from "@stargantt/plugin-export";
// Type-only: `stargantt.selection`, resolved per use for the lanes' reveal-on-selection.
import type {} from "@stargantt/plugin-interaction";
import type { LoadChartSurface, ResourceAreaDeps, UtilizationReportOptions, UtilizationReportRow } from "../areas";
import { resolveBucketMode } from "../engine/buckets";
import type { UtilizationBucketUnit } from "../engine/buckets";
import { computeUtilization } from "../engine/compute";
import type { DemandInterval, EngineHooks, EngineResource, UtilizationMatrix } from "../engine/compute";
import { createMatrixMemo } from "../engine/memo";
import { resolveReportRange, taskExtent } from "../engine/range";
import { REPORT_COLUMNS } from "../messages";
import {
  aggregationConfig,
  allowedResources,
  createBandAggregator,
  summarizeBucketResults,
} from "./band";
import type { AggregationConfig, BandAggregator, BucketResult } from "./band";
import { DEFAULT_LABEL_FONT, createBandExportSurface, createBandView, resolveBandColors } from "./band-view";
import type { BandColors, BandView } from "./band-view";
import { createStripControl } from "./geometry";
import type { StripControl } from "./geometry";
import { createHeatmapPanel, HEATMAP_CORNERS, REQUESTED_CORNER, resolveCorner } from "./heatmap";
import type { HeatmapHandle } from "./heatmap";
import { buildLaneModel, EMPTY_LANE_MODEL } from "./lanes-model";
import type { LaneModel, LaneRow } from "./lanes-model";
import { createLanesView, resolveLaneColors } from "./lanes-view";
import type { LaneColors, LanesView } from "./lanes-view";
import { bucketStamps, reportNumber, reportToCsv } from "./report-csv";
import { buildReportPdf } from "./report-pdf";

/** The two `view/bottomPanes` strip ids — also the ids `view/bottomPaneResized` carries. */
const TOTAL_PANE_ID = "stargantt.load-chart:total";
const LANES_PANE_ID = "stargantt.load-chart:lanes";

const SLOT_GROUP = "overlay-corner";

/** Token fallbacks: the band's total height, the lane strip's cap, and one lane's height. */
const DEFAULT_BAND_HEIGHT = 64;
const DEFAULT_LANES_HEIGHT = 96;
const DEFAULT_LANE_HEIGHT = 28;

/** The density `"auto"` resolves against when no timeline is composed (a day-level chart). */
const DEFAULT_PX_PER_DAY = 40;

/** The week-start weekday when the view plugin is absent (§2.5). */
const DEFAULT_WEEK_START = 1;

/** A usable dimensionless capacity rate: unusable reads as 1, never as itself. */
function capacityRateOf(resource: Resource): number {
  const capacity = resource.capacity;
  return typeof capacity === "number" && Number.isFinite(capacity) && capacity > 0 ? capacity : 1;
}

/** The inert report every surface answers with before the strips are bound. */
const EMPTY_ROWS: readonly UtilizationReportRow[] = [];

/** Wires the load-chart area. */
export function wireLoadChart(deps: ResourceAreaDeps): void {
  const { ctx, config, data, messages, intervals } = deps;
  const nest = config.loadChart;
  // §6 presence semantics: an omitted nest leaves the whole feature dormant — no strip, no claim,
  // no export contribution, and `bindLoadChartStrips` is never called.
  if (nest === undefined) return;
  // Re-bound as a non-optional local: the hoisted function declarations below are created before
  // the guard as far as the checker is concerned, so they cannot see its narrowing.
  const loadChart: ResolvedLoadChart = nest;

  /* ------------------------------------------------------------------ *
   * The matrix consumer: roster, demands, hook pair, memo
   * ------------------------------------------------------------------ */

  // The engine's own `onError` already contains the hooks per build (first throw reported, later
  // ones swallowed, a later build reports again); no second latch is added on top.
  const hooks: EngineHooks<Resource> = {
    ...(loadChart.resourceLoad === undefined ? {} : { resourceLoad: loadChart.resourceLoad }),
    ...(loadChart.resourceCapacity === undefined
      ? {}
      : { resourceCapacity: loadChart.resourceCapacity }),
    onError: (_where, error) => deps.reportError(error),
  };
  const sigmaConfigured =
    loadChart.resourceLoad !== undefined || loadChart.resourceCapacity !== undefined;

  /** The allowlisted STORE roster (§2.3), rebuilt only when the data notifications say so. */
  let rosterCache: EngineResource<Resource>[] | null = null;
  /** One demand interval per assignment over its task's span (§2.6 item 8). */
  let demandCache: Map<string, readonly DemandInterval[]> | null = null;

  function roster(): readonly EngineResource<Resource>[] {
    if (rosterCache !== null) return rosterCache;
    rosterCache = allowedResources(data.query(), loadChart.resources).map((resource) => ({
      id: resource.id,
      name: resource.name,
      capacityRate: capacityRateOf(resource),
      // Working time comes from the surface that OWNS its policy: the shared per-resource interval
      // cache dispatches to `ResourcePoolService` for pool-known resources and to the `sdk/time`
      // default week for every other, and is invalidated wholesale by the pool alone (§2.3).
      workingIntervals: (from, to, out) => intervals.intervalsFor(resource.id, from, to, out),
      source: resource,
    }));
    return rosterCache;
  }

  function demands(): ReadonlyMap<string, readonly DemandInterval[]> {
    if (demandCache !== null) return demandCache;
    const view = data.query();
    const admitted = new Set<string>();
    for (const entry of roster()) admitted.add(String(entry.id));
    const out = new Map<string, DemandInterval[]>();
    for (const [taskId, list] of view.assignmentsByTask) {
      const task = view.byId.get(taskId);
      if (task === undefined) continue;
      // Milestones and non-positive-duration tasks carry no demand (§2.6 item 8).
      if (!(Number.isFinite(task.start) && task.end > task.start)) continue;
      if (task.type === "milestone") continue;
      for (const assignment of list) {
        // Defensive: the store's own `Assignment` guarantees a positive finite `units`, but a
        // plugin ecosystem writing through another path may not.
        if (!(typeof assignment.units === "number" && assignment.units > 0)) continue;
        const key = String(assignment.resourceId);
        if (!admitted.has(key)) continue;
        let bucket = out.get(key);
        if (bucket === undefined) {
          bucket = [];
          out.set(key, bucket);
        }
        bucket.push({ start: task.start, end: task.end, units: assignment.units });
      }
    }
    demandCache = out;
    return out;
  }

  function timeline(): TimelineService | undefined {
    return ctx.useOptional("stargantt.timeline");
  }

  function weekStartDay(): number {
    return timeline()?.firstDayOfWeek() ?? DEFAULT_WEEK_START;
  }

  function pxPerDay(): number {
    return timeline()?.zoomLevel.get().pxPerDay ?? DEFAULT_PX_PER_DAY;
  }

  function buildMatrix(
    bucket: UtilizationBucketUnit,
    start: number,
    end: number,
    week: number,
    maxColumns?: number,
  ): UtilizationMatrix<Resource> {
    return computeUtilization<Resource>({
      resources: roster(),
      demands: demands(),
      start,
      end,
      bucket,
      // Every load-chart surface aligns its edges to the grid (§2.5).
      edges: "aligned",
      weekStartDay: week,
      // Load-chart surfaces judge overload at threshold 1 (§2.4).
      threshold: 1,
      ...(maxColumns === undefined ? {} : { maxColumns }),
      hooks,
    });
  }

  // §2.5's M1 ruling: the ONE memo instance of the plugin, shared by the Σ-mode band and the lanes
  // within a frame. Invalidated on the data/pool notifications AND at every frame boundary, so no
  // result outlives its own frame.
  const memo = createMatrixMemo<Resource>((bucket, start, end, week) =>
    buildMatrix(bucket, start, end, week),
  );

  /* ------------------------------------------------------------------ *
   * The band-level aggregation (non-engine)
   * ------------------------------------------------------------------ */

  // A mutable copy: a throwing band-level `load` / `capacity` is contained by dropping BOTH for the
  // rest of the instance's life and re-aggregating through the built-in path (the latched-seam
  // rule — a broken host function must not report at frame rate).
  const aggregation: AggregationConfig = aggregationConfig(loadChart);
  let bandFnFaulted = false;

  const aggregator: BandAggregator = createBandAggregator({
    view: () => data.query(),
    bucket: loadChart.bucket,
    pxPerDay,
    weekStartDay,
    aggregation,
    ...(sigmaConfigured
      ? {
          matrix: (unit, from, to, week) => memo.get(unit, from, to, week),
          rowCount: () => roster().length,
        }
      : {}),
  });

  /** The band's aggregation with the host-function fault barrier around it. */
  function bandBuckets(from: number, to: number): readonly BucketResult[] {
    try {
      return aggregator.buckets(from, to);
    } catch (error) {
      if (!bandFnFaulted) {
        bandFnFaulted = true;
        deps.reportError(error);
      }
      aggregation.load = undefined;
      aggregation.capacity = undefined;
      return aggregator.buckets(from, to);
    }
  }

  function bandPeak(from: number, to: number): number {
    let peak = 0;
    for (const r of bandBuckets(from, to)) {
      if (r.value > peak) peak = r.value;
      if (r.capacity !== null && r.capacity > peak) peak = r.capacity;
    }
    return peak;
  }

  /* ------------------------------------------------------------------ *
   * Reports (§1.2) — always `edges: "aligned"`, always `maxColumns: 200`
   * ------------------------------------------------------------------ */

  function reportRows(options?: UtilizationReportOptions): readonly UtilizationReportRow[] {
    const view = data.query();
    const range = resolveReportRange(
      taskExtent(view.byId.values()),
      options?.start,
      options?.end,
    );
    if (range === null) return EMPTY_ROWS;
    const unit = options?.bucket ?? resolveBucketMode(loadChart.bucket, pxPerDay());
    const matrix = buildMatrix(unit, range.start, range.end, weekStartDay(), 200);
    return matrix.rows.map((row) => ({
      resourceId: row.resource.id,
      resourceName: row.resource.name,
      cells: row.cells.map((cell) => ({
        start: cell.start,
        end: cell.end,
        allocated: cell.allocated,
        capacity: cell.capacity,
        ratio: cell.ratio,
      })),
    }));
  }

  function reportHeaders(): string[] {
    return REPORT_COLUMNS.map((column) => messages.reportColumnHeader(column));
  }

  function reportCsv(options?: UtilizationReportOptions): string {
    return reportToCsv(reportRows(options), reportHeaders(), messages.duration);
  }

  function reportPdf(options?: UtilizationReportOptions): Blob {
    const rows = reportRows(options);
    const lines: string[][] = [];
    for (const row of rows) {
      for (const cell of row.cells) {
        const { from, to } = bucketStamps(cell.start, cell.end);
        lines.push([
          row.resourceName,
          from,
          to,
          messages.duration(cell.allocated),
          messages.duration(cell.capacity),
          cell.ratio === null ? "" : reportNumber(cell.ratio),
        ]);
      }
    }
    const bytes = buildReportPdf({ title: messages.reportTitle, headers: reportHeaders(), lines });
    return new Blob([bytes], { type: "application/pdf" });
  }


  /* ------------------------------------------------------------------ *
   * §4.2 — the `overlay-corner` claim, at setup()
   * ------------------------------------------------------------------ */

  // Claimed at setup(), not deferred to `lifecycle/ready`: the claim itself touches no DOM, and
  // claiming here keeps the corner arbitration's registration-order determinism tied to plugin
  // registration order rather than to `lifecycle/ready` LISTENER order.
  const corner = resolveCorner(ctx.claimSlot(SLOT_GROUP, REQUESTED_CORNER, HEATMAP_CORNERS));

  /* ------------------------------------------------------------------ *
   * Theme-derived geometry and colours
   * ------------------------------------------------------------------ */

  function theme(): ThemeService | undefined {
    return ctx.useOptional("stargantt.theme");
  }
  function token(name: string): string {
    return theme()?.get(name) ?? "";
  }

  /** The three geometry tokens, read ONCE and fixed for the instance's life (§3.6). */
  let metrics: { band: number; lanesMax: number; lane: number } | null = null;
  function heights(): { band: number; lanesMax: number; lane: number } {
    metrics ??= {
      band: parsePx(token("--sg-load-chart-height"), DEFAULT_BAND_HEIGHT),
      lanesMax: parsePx(token("--sg-load-lanes-height"), DEFAULT_LANES_HEIGHT),
      lane: parsePx(token("--sg-load-lane-height"), DEFAULT_LANE_HEIGHT),
    };
    return metrics;
  }

  // A canvas has no cascade, so the colours and the label font are resolved values, cached until a
  // theme switch drops them.
  let bandColors: BandColors | null = null;
  let laneColors: LaneColors | null = null;
  let labelFont: string | null = null;
  function colorsOfBand(): BandColors {
    bandColors ??= resolveBandColors(token);
    return bandColors;
  }
  function colorsOfLanes(): LaneColors {
    laneColors ??= resolveLaneColors(token);
    return laneColors;
  }
  function font(): string {
    labelFont ??= token("--sg-header-font") || DEFAULT_LABEL_FONT;
    return labelFont;
  }

  /* ------------------------------------------------------------------ *
   * §3.6 the two strips
   * ------------------------------------------------------------------ */

  /**
   * The chart surface, resolved at `lifecycle/ready`. `undefined` for the instance's life in a
   * composition without `stargantt.view`, which is what keeps this whole area SILENTLY inert there:
   * nothing paints, no heatmap opens, and `bindLoadChartStrips` is never called.
   */
  let chart: ViewService | undefined;

  const repaint = createFrameScheduler(() => paintFrame());
  ctx.own(repaint);
  const schedule = (): void => repaint.schedule();

  const bandTracker: StripHeightTracker = createStripHeightTracker();
  const lanesTracker: StripHeightTracker = createStripHeightTracker();

  /** The lanes' roster formula: `min(--sg-load-lanes-height, laneCount × --sg-load-lane-height)`. */
  const lanesSize = (): number => {
    if (!lanesToggle.visible()) return 0;
    const geometry = heights();
    return Math.min(geometry.lanesMax, roster().length * geometry.lane);
  };

  const stripControl = (id: string, tracker: StripHeightTracker, initial: boolean, defaultHeight: () => number): StripControl =>
    createStripControl({
      tracker,
      initial,
      defaultHeight,
      dispatch: (height) => ctx.dispatch("view/setBottomPaneHeight", { id, height }),
      onChange: schedule,
    });

  const band = stripControl(TOTAL_PANE_ID, bandTracker, loadChart.total, () => heights().band);
  const lanes = stripControl(LANES_PANE_ID, lanesTracker, loadChart.lanes, () => lanesSize());
  const bandToggle = band.toggle;
  const lanesToggle = lanes.toggle;

  const bandView: BandView = createBandView({
    axisLabels: loadChart.axisLabels,
    valueLabels: loadChart.valueLabels,
    onResize: schedule,
  });
  ctx.own({ dispose: () => bandView.dispose() });

  const lanesView: LanesView = createLanesView({
    laneHeight: () => heights().lane,
    laneValueLabels: loadChart.laneValueLabels,
    onResize: schedule,
  });
  ctx.own({ dispose: () => lanesView.dispose() });

  // Contributed at setup(), NOT from `lifecycle/ready`: the view plugin collects `view/bottomPanes`
  // in its own ready listener, and listener order between two plugins is not guaranteed. A
  // contribution to a point no composed plugin declares is simply never delivered, which is exactly
  // the inert answer a composition without `stargantt.view` needs.
  const bandContribution: BottomPaneContribution = {
    id: TOTAL_PANE_ID,
    order: 0,
    // A getter: the contribution is registered here but read at collection time, so a toggle
    // flipped in between is honoured — and a strip hidden then is contributed at 0, which the view
    // plugin renders as no reserved height and no divider at all.
    get height() {
      return bandToggle.visible() ? heights().band : 0;
    },
    resizable: loadChart.resizable,
    label: messages.bandResizeLabel,
    onResize: (height) => {
      bandTracker.resized(height);
      schedule();
    },
    mount: (elements: BottomPaneElements) => {
      // Seeds the tracker with the height the contribution carried: the view plugin reads `height`
      // and calls `mount` in the same synchronous collection pass, and `mount` runs exactly once.
      bandTracker.seed(bandToggle.visible() ? heights().band : 0);
      bandView.mount(elements);
      schedule();
    },
  };
  const lanesContribution: BottomPaneContribution = {
    id: LANES_PANE_ID,
    order: 1,
    // The initial height follows the roster at mount time. Read-only: the tracker is
    // seeded in `mount` below, so how often the collector reads this cannot alter plugin state.
    get height() {
      return lanesSize();
    },
    resizable: loadChart.resizable,
    label: messages.lanesResizeLabel,
    onResize: (height) => {
      lanesTracker.resized(height);
      schedule();
    },
    mount: (elements: BottomPaneElements) => {
      lanesTracker.seed(lanesSize());
      lanesView.mount(elements);
      schedule();
    },
  };
  ctx.contribute("view/bottomPanes", bandContribution);
  ctx.contribute("view/bottomPanes", lanesContribution);

  /* ------------------------------------------------------------------ *
   * The frame
   * ------------------------------------------------------------------ */

  /** The visible timeline span the strips bucket over, or `null` when there is none. */
  function visibleSpan(): { from: number; to: number; scrollLeft: number } | null {
    const scale = timeline();
    if (chart === undefined || scale === undefined) return null;
    const viewport = chart.viewport.get();
    if (!(viewport.width > 0)) return null;
    const from = scale.xToT(viewport.scrollLeft);
    const to = scale.xToT(viewport.scrollLeft + viewport.width);
    return to > from ? { from, to, scrollLeft: viewport.scrollLeft } : null;
  }

  const ratioLanes = loadChart.laneScale === "ratio";
  const formatLaneValue = (value: number): string =>
    ratioLanes ? `${String(Math.round(value * 100))}%` : messages.duration(value);
  const laneLabelOf = (row: LaneRow, model: LaneModel): string =>
    messages.laneLabel({
      resourceName: row.resourceName,
      rangeStart: model.rangeStart,
      rangeEnd: model.rangeEnd,
      bucketCount: model.bucketCount,
      peakLoad: row.peak,
      capacity: row.capacity,
      overloadedBuckets: row.overloadedBuckets,
      valueKind: ratioLanes ? "ratio" : "durationMs",
    });
  const lanesLabelOf = (model: LaneModel): string =>
    messages.lanesLabel({ laneCount: model.rows.length });

  function paintFrame(): void {
    // The frame boundary: nothing a previous frame built may be served to this one, so the hooks
    // observe at most one call per (resource, bucket) per frame (§2.5).
    memo.invalidate();
    if (chart === undefined) return;
    const span = visibleSpan();
    const scale = timeline();
    if (span === null || scale === undefined) return;
    const xOf = (t: number): number => scale.tToX(t) - span.scrollLeft;

    if (bandToggle.visible() && bandTracker.height() > 0) {
      const measured = bandView.measure();
      if (measured !== null) {
        const results = bandBuckets(span.from, span.to);
        const sigma = aggregator.isSigma();
        bandView.render({
          results,
          width: measured.width,
          height: bandTracker.height(),
          gutterWidth: measured.gutterWidth,
          xOf,
          colors: colorsOfBand(),
          font: font(),
          durationScale: sigma,
          formatDuration: messages.duration,
        });
        const summary = summarizeBucketResults(results, span.from, span.to);
        bandView.describe(
          messages.bandLabel({
            rangeStart: summary.rangeStart,
            rangeEnd: summary.rangeEnd,
            bucketCount: summary.bucketCount,
            peakLoad: summary.peakLoad,
            peakCapacity: summary.peakCapacity,
            overloadedBuckets: summary.overloadedBuckets,
            fallback: aggregator.isFallback(),
            valueKind: sigma ? "durationMs" : "units",
          }),
        );
      }
    }

    if (lanesToggle.visible() && lanesTracker.height() > 0) {
      const measured = lanesView.measure();
      if (measured !== null) {
        // The lanes read the band's OWN uncoarsened grid, through the same memo entry the Σ-mode
        // band used this frame — one build per frame, shared (§2.5).
        const model: LaneModel =
          roster().length === 0
            ? EMPTY_LANE_MODEL
            : buildLaneModel({
                view: data.query(),
                matrix: memo.get(
                  aggregator.unit(),
                  span.from,
                  span.to,
                  aggregator.weekStartDay(),
                ),
                fromT: span.from,
                toT: span.to,
                scale: loadChart.laneScale,
              });
        lanesView.render({
          model,
          width: measured.width,
          height: lanesTracker.height(),
          gutterWidth: measured.gutterWidth,
          xOf,
          colors: colorsOfLanes(),
          font: font(),
          laneLabel: laneLabelOf,
          lanesLabel: lanesLabelOf,
          formatValue: formatLaneValue,
        });
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * The heatmap card
   * ------------------------------------------------------------------ */

  let heatmap: HeatmapHandle | null = null;
  let heatmapOptions: UtilizationReportOptions | undefined;
  const refreshHeatmap = createFrameScheduler(() => heatmap?.refresh());
  ctx.own(refreshHeatmap);

  function openHeatmap(options?: UtilizationReportOptions): void {
    if (chart === undefined) return;
    // Re-opened options re-read the matrix (§3.6).
    heatmapOptions = options;
    if (heatmap !== null) {
      heatmap.refresh();
      return;
    }
    heatmap = createHeatmapPanel({
      mount: chart.chartPaneElement(),
      corner,
      title: messages.heatmapTitle,
      closeLabel: messages.closeLabel,
      rows: () => reportRows(heatmapOptions),
      cellLabel: messages.heatmapCellLabel,
      onClose: () => closeHeatmap(),
    });
  }
  function closeHeatmap(): void {
    heatmap?.dispose();
    heatmap = null;
  }
  ctx.own({ dispose: () => closeHeatmap() });

  /* ------------------------------------------------------------------ *
   * §1.2 — the strip control surface the thirteen relocated members forward to
   * ------------------------------------------------------------------ */

  /**
   * §1.2 — non-finite/negative heights are IGNORED (never a release); exactly 0 releases the
   * strip; a positive height opens a hidden strip at that height in one dispatch
   * or resizes a shown one. The resulting `onResize` lands outside `selfRequest`, so the strip
   * counts as reader-sized from then on and the derived formula never overrides it again.
   */
  function setHeight(
    id: string,
    toggle: StripToggle,
    openAt: (height: number) => void,
    px: number,
  ): void {
    if (!Number.isFinite(px) || px < 0) return;
    if (px === 0) {
      toggle.set(false);
      return;
    }
    if (!toggle.visible()) {
      openAt(px);
      return;
    }
    ctx.dispatch("view/setBottomPaneHeight", { id, height: px });
  }

  const surface: LoadChartSurface = {
    bandVisible: () => bandToggle.visible(),
    setBandVisible: (visible) => bandToggle.set(visible),
    lanesVisible: () => lanesToggle.visible(),
    setLanesVisible: (visible) => lanesToggle.set(visible),
    bandHeight: () => (bandToggle.visible() ? bandTracker.height() : 0),
    setBandHeight: (px) => setHeight(TOTAL_PANE_ID, bandToggle, band.openAt, px),
    lanesHeight: () => (lanesToggle.visible() ? lanesTracker.height() : 0),
    setLanesHeight: (px) => setHeight(LANES_PANE_ID, lanesToggle, lanes.openAt, px),
    openHeatmap: (options) => openHeatmap(options),
    closeHeatmap: () => closeHeatmap(),
    utilizationReport: (options) => reportRows(options),
    utilizationReportCSV: (options) => reportCsv(options),
    utilizationReportPDF: (options) => reportPdf(options),
  };

  /* ------------------------------------------------------------------ *
   * Notifications
   * ------------------------------------------------------------------ */

  /** One y-scale for a whole exported span, memoized so the peak is aggregated once per export. */
  let spanPeak: { from: number; to: number; peak: number } | null = null;

  const dropData = (): void => {
    rosterCache = null;
    demandCache = null;
    memo.invalidate();
    // The export's per-span peak must be dropped whenever the aggregation's inputs move, or two
    // exports of the same range would share the first one's stale scale — and, since the projection
    // fits bars to `max(scaleMax, the tile's own peak)`, only the tile holding the new peak would
    // outgrow it: the very seam stepping the export-wide peak exists to prevent.
    spanPeak = null;
    // The lanes strip stays roster-tracked until the reader (or a host height dispatch) sizes it.
    if (lanesToggle.visible() && !lanesTracker.isManual()) {
      const next = lanesSize();
      if (next > 0 && next !== lanesTracker.height()) {
        lanesTracker.selfRequest(() =>
          ctx.dispatch("view/setBottomPaneHeight", { id: LANES_PANE_ID, height: next }),
        );
      }
    }
    schedule();
    refreshHeatmap.schedule();
  };
  ctx.own(data.tasks.subscribe(dropData));
  ctx.own(data.resources.subscribe(dropData));
  ctx.own(data.assignments.subscribe(dropData));

  // The pool owns working-time policy; its `resources` store notification is the ONE edge that may
  // move a resource's working intervals, so every matrix built before it is stale.
  //
  // `deps.resourcePool()`, not `ctx.useOptional("stargantt.resource-pool")`: the pool is provided
  // UNCONDITIONALLY by `wirePool`, which runs before this area (§6), so it is never `undefined` in
  // the real host here. The previous `useOptional` + `if (pool !== undefined)` guard was dead code
  // (always true) that also routed a self-provided lookup through the public service registry —
  // the same class of bug `assign`/`view`'s `wire.ts` had (see their comments); `bindResourcePool`/
  // `resourcePool` in `areas.ts` is the sanctioned path. No conditional: an `undefined` here would
  // mean `wirePool` itself failed to run, which nothing downstream could recover from anyway.
  const pool = deps.resourcePool();
  if (pool === undefined) throw new Error("stargantt.resource: resource-pool not bound before load-chart");
  ctx.own(
    pool.resources.subscribe(() => {
      memo.invalidate();
      spanPeak = null;
      schedule();
      refreshHeatmap.schedule();
    }),
  );

  ctx.own(ctx.on("view/scrolled", () => schedule()));

  /* ------------------------------------------------------------------ *
   * §3.6 the export surface — one contribution, the aggregate band only
   * ------------------------------------------------------------------ */

  function peakOfSpan(from: number, to: number): number {
    if (spanPeak !== null && spanPeak.from === from && spanPeak.to === to) return spanPeak.peak;
    const peak = bandPeak(from, to);
    spanPeak = { from, to, peak };
    return peak;
  }

  // Registered with the `loadChart` nest present and inert without the export plugin (a contribution
  // to an undeclared point is simply never collected).
  ctx.contribute(
    "export/auxiliarySurfaces",
    createBandExportSurface({
      buckets: bandBuckets,
      peak: peakOfSpan,
      colors: colorsOfBand,
      font,
      valueLabels: loadChart.valueLabels,
      durationScale: () => aggregator.isSigma(),
      formatDuration: messages.duration,
      height: () => (chart !== undefined && bandToggle.visible() ? bandTracker.height() : 0),
    }),
  );

  /* ------------------------------------------------------------------ *
   * §14 — the one deferred service resolution
   * ------------------------------------------------------------------ */

  // Deferred to `lifecycle/ready`: `stargantt.view` is an optional (inert-degradation) edge with no
  // `dependsOn` entry, so this plugin's setup-time position relative to it is not guaranteed and a
  // same-tick `useOptional` could read `undefined` even in a correct composition. Only the SERVICE
  // reads are deferred — the contributions and the slot claim above are timing-agnostic.
  ctx.on("lifecycle/ready", () => {
    const resolved: ViewService | undefined = ctx.useOptional("stargantt.view");
    // An absent optional service leaves this area SILENTLY inert — no `core/pluginError`, which is
    // reserved for foreign-code faults, not for a composition without a chart provider.
    if (resolved === undefined) return;
    chart = resolved;

    const scale: TimelineService | undefined = timeline();
    if (scale !== undefined) {
      ctx.own(
        scale.zoomLevel.subscribe(() => {
          // `"auto"` re-buckets against the new density, so nothing built at the old one survives.
          memo.invalidate();
          spanPeak = null;
          schedule();
          refreshHeatmap.schedule();
        }),
      );
    }

    // A canvas has no cascade: a theme switch must drop the resolved colours and the label font, so
    // the next frame re-reads them and label omission re-measures in the new font.
    const themeService = theme();
    if (themeService !== undefined) {
      ctx.own(
        themeService.tokens.subscribe(() => {
          bandColors = null;
          laneColors = null;
          labelFont = null;
          schedule();
        }),
      );
    }

    // Reveal-on-selection: resolved HERE rather than at setup — `optional` does not order plugin
    // start-up, so a selection provider registered after this one would have been captured as
    // `undefined` at setup and the feature silently disabled for the instance's life.
    const selection = ctx.useOptional("stargantt.selection");
    if (selection !== undefined) {
      ctx.own(
        selection.state.subscribe((next) => {
          if (next.taskIds.size === 0 || !lanesToggle.visible()) return;
          const assignments = data.query().assignmentsByTask;
          for (const id of next.taskIds) {
            const first = assignments.get(id)?.[0];
            if (first === undefined) continue;
            // The one reduced-motion source: an animated scroll is this plugin's own motion.
            lanesView.reveal(first.resourceId, !resolved.reducedMotion());
            return;
          }
        }),
      );
    }

    deps.bindLoadChartStrips(surface);
    if (loadChart.heatmap) openHeatmap();
    schedule();
  });
}
