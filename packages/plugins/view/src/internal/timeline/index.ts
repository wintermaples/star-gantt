/**
 * The timeline module of `stargantt.view`.
 *
 * The time axis: multi-tier scale definitions selected by zoom level, the `tToX` / `xToT`
 * date↔x mapping published as the `stargantt.timeline` service, the `timeline/zoomLevels`
 * extension point, and a dedicated header canvas that renders the scale rows and follows
 * horizontal scroll.
 */
import { collect, createStore } from "@stargantt/core";
import type { PluginContext, Store, WritableStore } from "@stargantt/core";
import type { Task, TaskId } from "@stargantt/plugin-data-store";
import type { TimelineConfig } from "../../config";
import { PLUGIN_ID } from "../plugin-id";
import type { CanvasLayer, RenderModule } from "../render/index";
import type { ThemeService } from "../theme/index";
import {
  DEFAULT_HEADER_HEIGHT,
  normalizeLabelPadding,
  normalizeRowRatio,
  resolveFont,
  resolveMajorFont,
} from "./header";
import { headerAuxiliarySurface } from "./export-contrib";
import { createHeaderLifecycle } from "./header-lifecycle";
import type { HeaderPaintInputs, HeaderTier } from "./header-options";
import { contributeUpward } from "../upward";
// docs/specs/plugins/view.md — the numeric parse of a CSS custom property
// is a shared micro-helper, not a per-package fork. This is a value import, so the manifest edge is
// a runtime `dependencies` entry.
import { parsePx } from "@stargantt/sdk";
import {
  defaultZoomLevels,
  formatInstant,
  normalizeCalendar,
  normalizeFiscalStartMonth,
} from "./levels";
import type { BuiltInLevelOptions } from "./levels";
import { createOriginGuard } from "./origin-guard";
import { cellAt, normalizeFirstDayOfWeek, unitBoundaries } from "./scale";
import { normalizeTimeZone, retainZone } from "./zone";
import { createZoomAxis, usableLevel } from "./zoom";

/* ------------------------------------------------------------------ *
 * Public types (contract §3.3)
 * ------------------------------------------------------------------ */

// docs/specs/plugins/view.md — named publicly so `unitBoundaries` callers can
// spell the argument they pass without restating the union.
/**
 * A calendar unit a header row is divided into, and the unit a boundary enumeration counts in.
 *
 * All five are UTC units: a `"week"` starts on the chart's configured first weekday, a `"day"` and
 * an `"hour"` on their UTC boundary.
 */
export type ScaleUnit = "year" | "month" | "week" | "day" | "hour";

export interface ScaleRow {
  unit: ScaleUnit;
  step?: number;
  /**
   * Shifts where a stepped row anchors its sequence, as a calendar-index remainder in units of
   * `unit`.
   *
   * By default a `step: 3` month row breaks where the month's absolute calendar count is a
   * multiple of 3 — January, April, July, October. A `stepOffset` moves that anchor: `step: 12,
   * stepOffset: 3` breaks every April, i.e. an April-start fiscal year. The value is reduced
   * modulo `step`; anything that is not a finite number acts as 0, the default anchoring.
   * Ignored when the row has no effective `step` above 1.
   */
  stepOffset?: number;
  /**
   * Renders one boundary label of this row.
   *
   * `t` is the boundary instant in epoch milliseconds and `locale` is the chart's language tag —
   * whatever `Gantt.create` was given, or `"en"`. Instants are UTC, so a formatter built here
   * should pass `timeZone: "UTC"`.
   */
  format: (t: number, locale: string) => string;
}

export interface ZoomLevel {
  id: string;
  pxPerDay: number;
  scales: ScaleRow[];
}

// docs/specs/plugins/view.md — the header-cell template hook's
// argument.
/**
 * One header cell as presented to the `headerCellFormat` hook.
 *
 * `time` and `endTime` bound the cell as a half-open span in epoch milliseconds, `unit` and
 * `step` describe the row's calendar granularity, `rowIndex` is the row's position from the top
 * of the header (0 = the coarsest row), `locale` is the chart's language tag, and `defaultLabel`
 * is the text the header would paint without the hook.
 */
export interface HeaderCell {
  time: number;
  endTime: number;
  unit: ScaleUnit;
  step: number;
  rowIndex: number;
  locale: string;
  defaultLabel: string;
}

// docs/specs/plugins/view.md — the read-only per-level metrics
// consumers need to choose a level without activating one.
/**
 * The measurable properties of one registered zoom level: what it is called and how dense it is.
 *
 * Handed out by `TimelineService.levelMetrics()` as a plain snapshot so a consumer can compare
 * densities — pick the level at which a span fits a width, sort a zoom ladder — without touching
 * the level's header rows or activating it.
 */
export interface ZoomLevelMetrics {
  /** The level's `ZoomLevel.id`, the string `setZoomLevel` takes. */
  readonly id: string;
  /** The level's horizontal density in CSS pixels per day. */
  readonly pxPerDay: number;
}

export interface TimelineService {
  tToX(t: number): number;
  xToT(x: number): number;
  readonly pxPerMs: number;
  // docs/specs/plugins/view.md
  /**
   * Activates the zoom level with this `ZoomLevel.id`, throwing when no registered level carries
   * it. Already being on that level does nothing at all — no event, no repaint.
   *
   * A finite `anchorTime` (epoch milliseconds) keeps that instant under the same point of the
   * visible chart area, so the chart appears to expand or contract around it rather than jumping.
   * Omit it and horizontal positions are simply recomputed at the new density, which moves the
   * visible time range.
   *
   * The anchor is held by scrolling, so zooming never changes where the axis begins and can neither
   * put content out of reach nor open up empty space before it. The anchor cannot be held exactly
   * when the chart runs out of scrollable range: zooming out near the chart's left edge stops there,
   * and zooming in anchored past the end of the data stops at the right edge of the content.
   */
  setZoomLevel(id: string, anchorTime?: number): void;
  // docs/specs/plugins/view.md
  /**
   * Moves the instant placed at content x = 0, in epoch milliseconds.
   *
   * Horizontal positions are measured from that instant and the chart cannot scroll left of it, so
   * anything earlier is unreachable: move the origin back to bring a plan that starts before the
   * chart's opening date into view. `xToT(0)` reports where the origin currently sits.
   *
   * **The view does not move.** The scroll position is adjusted by exactly the distance the content
   * shifted, so the same time span stays on screen and nothing appears to jump sideways. The one
   * exception is the scrollable range's own left edge: moving the origin *later* can push the
   * compensated position below zero, where it is clamped, and the view then shifts by the
   * remainder.
   *
   * A value that is not a finite number, or that leaves the axis where it already begins, does
   * nothing at all. Otherwise the header is re-laid out, every canvas layer is repainted, and the
   * chart's zoom change event is emitted with `cause: "origin"` — every consumer that caches
   * horizontal positions has to recompute them, which is the same thing a zoom asks of it, while
   * `cause` still tells a listener that the zoom level itself did not move.
   *
   * With `autoExtendOrigin` enabled this sets the *latest* instant the axis may begin at rather than
   * the instant it does begin at: the chart still starts earlier while a task does, and comes back
   * here when none does. `xToT(0)` reports where the axis actually begins.
   */
  setOrigin(ms: number): void;
  // docs/specs/plugins/view.md
  /**
   * Asks the chart to make an instant reachable, moving the origin back to the start of its UTC day
   * when the instant would otherwise sit at a content x no gesture can scroll to.
   *
   * This is the automatic extension `autoExtendOrigin` performs, offered to a caller that knows an
   * instant the chart's data does not contain yet — a drag in progress, which needs the room before
   * anything is written. The view is compensated exactly as `setOrigin` compensates it.
   *
   * It does nothing at all when `autoExtendOrigin` is off, when the value is not a finite number, or
   * when the chart already begins early enough, and it never moves the origin later.
   *
   * The request also **holds** the extension: while a hold is outstanding the chart never gives room
   * back, so an axis cannot move underneath a gesture that has simply stopped moving. Pair every
   * request with `releaseOriginExtension` when the gesture ends, however it ended.
   */
  requestOriginExtension(t: number): void;
  // docs/specs/plugins/view.md
  /**
   * Drops the hold `requestOriginExtension` took, so the chart reconciles its start against the data
   * again — giving back any room the gesture asked for and did not end up needing.
   *
   * Call it from wherever the gesture ends, whether it committed or was abandoned. Holds do not
   * nest, and calling this without one — or on a chart with `autoExtendOrigin` off — does nothing,
   * so an extra call from a cancel path is harmless.
   */
  releaseOriginExtension(): void;
  // docs/specs/plugins/view.md
  /**
   * Every registered zoom level's id and pixels-per-day density, in the order the levels were
   * registered — the chart's own levels first, then whatever other plugins contributed.
   *
   * Reading this is the way to choose a level by density (fitting a project span to the viewport,
   * building a zoom ladder, showing the available levels in a menu) without activating levels to
   * measure them, so nothing observes a zoom change that the user did not ask for. The array and
   * its entries are fresh snapshots — mutating them changes nothing — and the list is re-read on
   * every call, so a level contributed after startup appears in it.
   */
  levelMetrics(): readonly ZoomLevelMetrics[];
  /**
   * The weekday this chart treats as the start of the week (0 = Sunday … 6 = Saturday).
   *
   * Returns the normalized value of the `firstDayOfWeek` configuration option, defaulting to
   * Monday (1). Fixed for the instance's lifetime; consumers that bucket or align by weeks read
   * it here so their week boundaries match the header's.
   */
  // docs/specs/plugins/view.md — clauses/docs/specs/plugins/view.md
  firstDayOfWeek(): 0 | 1 | 2 | 3 | 4 | 5 | 6;
  // docs/specs/plugins/view.md
  /**
   * Enumerates the calendar boundaries of a unit within a half-open time span, in ascending order
   * of epoch milliseconds.
   *
   * The result contains every instant in `[fromMs, toMs)` at which a cell of the given unit
   * begins, computed with the same calendar rules the chart header itself uses: UTC arithmetic,
   * weeks starting on the weekday `firstDayOfWeek()` reports, and — when `step` is greater than
   * 1 — calendar-anchored stepping. The anchor is the unit's absolute calendar index in UTC: years
   * and months are counted from year 0, days and hours from the Unix epoch, and weeks from the
   * epoch-aligned week that starts on that weekday; a boundary falls where that index is an exact
   * multiple of `step`, so a 3-month enumeration always breaks at January, April, July and October
   * regardless of the span queried. A fractional `step` is floored — the same reading a header
   * row's own step gets — and a `step` that is omitted or does not floor to a finite integer
   * greater than 1 (including 1, 0, negatives, `NaN` and infinities) enumerates every unit
   * boundary.
   * The result never holds more than 4096 boundaries, the same cap the header's tick generation
   * uses, so a degenerate span cannot build an unbounded array; a span with `toMs` at or before
   * `fromMs` yields an empty array.
   *
   * `stepOffset` shifts the stepped anchor by that many units, exactly as a header row's own
   * `stepOffset` does — `("month", …, 12, 3)` enumerates April-start fiscal years — and a value
   * that is not a finite number acts as 0. When the chart is configured with a display time
   * zone, the boundaries are that zone's wall-clock boundaries, matching what the header paints.
   */
  unitBoundaries(
    unit: ScaleUnit,
    fromMs: number,
    toMs: number,
    step?: number,
    stepOffset?: number,
  ): readonly number[];
  // docs/specs/plugins/view.md
  /**
   * Formats one instant the way the chart's own header would: with the chart's locale, its
   * configured display calendar (Gregorian by default, or e.g. the Japanese era calendar when the
   * `calendar` option selects it) and its configured display time zone (UTC by default).
   *
   * `options` are standard `Intl.DateTimeFormat` options selecting which fields appear; omitted,
   * a plain year-month-day date is produced. The underlying formatter is memoised per option
   * set, so calling this per frame is as cheap as the header's own label formatting. Consumers
   * that show dates next to the chart — tooltips, side panels — use this so their wording always
   * matches the header's calendar and zone.
   */
  formatDate(t: number, options?: Intl.DateTimeFormatOptions): string;
  // docs/specs/plugins/view.md
  /**
   * The grid cell holding `t`: the half-open span of the cell the chart's finest scale row draws
   * around that instant, in epoch milliseconds.
   *
   * This is the unit the chart is currently measured in — a day at the day zoom level, a week at
   * the week level, a quarter at the quarter level — so a consumer that creates or sizes a task
   * can make it exactly one cell long and have its edges line up with the grid the chart paints.
   * The cell comes from the same calendar arithmetic as the header's own boundaries: UTC units,
   * the chart's first weekday, its display time zone, and calendar-anchored stepping.
   *
   * Returns `undefined` when `t` is not a finite number, or when the active zoom level defines no
   * scale rows at all.
   */
  gridCellAt(t: number): GridCell | undefined;

  // docs/specs/plugins/view.md
  /**
   * The active zoom level.
   *
   * Set on **every** change to the time→x mapping: a level change publishes the new level, and an
   * origin move re-publishes the unchanged level object. Stores gate on nothing, so both notify. A
   * subscriber that only expires cached geometry treats every notification alike; one that has to
   * tell the two apart compares `next.id !== prev.id` — different ids mean a zoom, equal ids mean
   * the origin moved.
   */
  readonly zoomLevel: Store<Readonly<ZoomLevel>>;
}

// docs/specs/plugins/view.md
/** A half-open span of the time axis, in epoch milliseconds. */
export interface GridCell {
  /** First instant of the span. */
  start: number;
  /** First instant after the span. */
  end: number;
}

/* ------------------------------------------------------------------ *
 * Module
 * ------------------------------------------------------------------ */

/** Every canvas the zoom affects; a zoom change re-lays out the whole chart. */
const ALL_LAYERS: readonly CanvasLayer[] = ["background", "main", "overlay"];

/**
 * What the timeline module reads from the store it shares the composition with.
 *
 * The task snapshot and nothing else: the origin guard weighs starts against the origin, and the
 * snapshot pair its subscription already carries answers both the incremental and the whole-store
 * question, so no per-task lookup is needed.
 */
export interface TimelineDataSource {
  readonly tasks: Store<ReadonlyMap<TaskId, Readonly<Task>>>;
}

/** Creates the timeline module and returns the service it publishes. */
export function createTimelineModule(
  ctx: PluginContext,
  config: TimelineConfig,
  render: RenderModule,
  theme: ThemeService,
  data: TimelineDataSource,
): TimelineService {
  // docs/specs/plugins/view.md — the `locale` argument of
  // every `ScaleRow.format` call. Read once: it is immutable for the instance, and with the option
  // omitted it is the literal `"en"` this plugin used to hardcode.
  const locale = ctx.locale;

  // docs/specs/plugins/view.md — `--sg-header-height` is the single source
  // of truth for the header's total height; it is fixed at startup and contributed to
  // `renderer/insets` (top side) so the chart body starts below the header instead of underneath
  // it.
  const headerTotal = parsePx(theme.get("--sg-header-height"), DEFAULT_HEADER_HEIGHT);
  // docs/specs/plugins/view.md
  // `renderer/insets` is an ordered strip: one top slot, sized by the token. `order: 0`
  // puts the header hard against the body's top edge, above any strip a third party stacks below
  // it. No `placed` callback: this plugin positions its own canvas over the chart pane, which the
  // default composition's geometry depends on being unchanged.
  ctx.contribute("renderer/insets", { side: "top", order: 0, size: headerTotal });

  // docs/specs/plugins/view.md — rule 5: read once at setup, with an
  // unusable value degrading to the default (rule 3).
  const firstDayOfWeek = normalizeFirstDayOfWeek(config.firstDayOfWeek);
  const rowRatio = normalizeRowRatio(config.headerRowRatio);
  const labelPadding = normalizeLabelPadding(config.headerLabelPadding);
  // docs/specs/plugins/view.md — all three
  // display options are read once at setup, with unusable values degrading to the previous
  // behavior silently (rule 3): calendar-year periods, UTC display, Gregorian labels.
  const timeZone = normalizeTimeZone(config.displayTimeZone);
  // docs/specs/plugins/view.md — the per-zone conversion memo is dropped when
  // the last instance displaying that zone disposes, so it never outlives its users.
  if (timeZone !== undefined) ctx.own({ dispose: retainZone(timeZone) });
  const calendar = normalizeCalendar(config.calendar);
  const fiscalMonth = normalizeFiscalStartMonth(config.fiscalYearStartMonth);
  const builtInOptions: BuiltInLevelOptions = {
    ...(timeZone === undefined ? {} : { timeZone }),
    ...(calendar === undefined ? {} : { calendar }),
    ...(fiscalMonth === undefined ? {} : { fiscalYearStartMonth: fiscalMonth }),
  };

  /** Reports faults raised while this plugin invokes a contributed function. */
  function fault(error: unknown): void {
    // docs/specs/architecture.md
    // function-shaped contributions are invoked by the point-owning plugin, which must guard them
    // and report via `core/pluginError`.
    ctx.emit("core/pluginError", { pluginId: PLUGIN_ID, error });
  }

  /* --- §3.5 zoom levels ---------------------------------------------- */
  const point = ctx.defineExtensionPoint("timeline/zoomLevels", collect<ZoomLevel>());
  // docs/specs/plugins/view.md — `timeline/zoomLevels` stays a purely additive
  // collect point; `ViewConfig.timeline.zoomLevels` changes only what *this* plugin contributes to
  // it. Unlike tree-grid's `columns`, the empty array is *unusable* rather than a deliberate
  // suppression: a chart with no zoom level has no `pxPerDay`, so `tToX` has no mapping and the
  // header has no rows — rule 3 therefore restores the built-ins. The same applies when every
  // configured entry is skipped as unusable.
  const configuredLevels = Array.isArray(config.zoomLevels)
    ? config.zoomLevels.filter(usableLevel)
    : [];
  const startingLevels =
    configuredLevels.length > 0 ? configuredLevels : defaultZoomLevels(builtInOptions);
  for (const level of startingLevels) ctx.contribute("timeline/zoomLevels", level);

  /* --- §3.3/§3.5 the axis -------------------------------------------- */
  /**
   * The published mapping. Assigned once the axis exists (the axis is what knows the active
   * level), so the two callbacks below publish through this handle rather than capturing it.
   */
  let zoomStore: WritableStore<Readonly<ZoomLevel>> | null = null;
  /** Publishes the active level — the one notification every t↔x mapping change travels on. */
  const publishLevel = (): void => zoomStore?.set(axis.currentLevel());

  const composedLevels = (): ZoomLevel[] => {
    const list = point.get();
    return Array.isArray(list) ? list : [];
  };
  const axis = createZoomAxis({
    pluginId: PLUGIN_ID,
    origin: config.origin,
    initialZoom: config.initialZoom,
    levels: composedLevels,
    onZoomChanged: () => {
      publishLevel();
      for (const layer of ALL_LAYERS) render.invalidate(layer);
      header.schedule();
    },
    // docs/specs/plugins/view.md — how an anchored zoom holds its anchor. The
    // origin never takes part, so the anchor's content x moved and `scrollLeft` follows it by the
    // same distance, leaving the anchor under the same point of the chart area. The renderer clamps
    // the target to the scrollable range, and both ends of that clamp are load-bearing: at 0
    // a zoom-out settles at the axis's left edge, and at the extent a zoom-in anchored in empty
    // space past the data settles at the content's right edge instead of following it into the void.
    onAnchorScroll: (deltaPx) => {
      render.scrollTo({ scrollLeft: render.viewport.get().scrollLeft + deltaPx });
    },
    // docs/specs/plugins/view.md — the mandatory scroll compensation. Lowering the
    // origin by Δt raises every content x by `Δt * pxPerMs`, so `scrollLeft` must rise by the same
    // number of pixels or the whole chart slides sideways under the reader. The renderer clamps the
    // target to the scrollable range; the content extent is re-measured through the axis
    // that has already moved, so it has already grown by the same amount.
    onOriginChanged: (shiftPx) => {
      if (shiftPx !== 0) {
        render.scrollTo({ scrollLeft: render.viewport.get().scrollLeft + shiftPx });
      }
      for (const layer of ALL_LAYERS) render.invalidate(layer);
      header.schedule();
      // Consumers cache horizontal positions against the pair (origin, pxPerMs) — the dependency
      // router's elbow cache is the documented case — and the zoom-level store is the signal that
      // invalidates them. An origin move asks exactly the same recomputation of them as a zoom, so
      // it re-publishes the still-current level object: stores gate on nothing, so the
      // notification arrives all the same, and the two are told apart by comparing the two
      // values' ids rather than by a discriminator field.
      publishLevel();
    },
  });

  /* --- §3.5 header paints -------------------------------------------- */
  // Everything a header paint reads live, taken once per paint and shared by the on-screen canvas
  // and every export tile (§2.1), so the two can only ever differ in which slice of the axis
  // they cover. `measure` is the paint's own measurement channel; the font token is read once here
  // and both drawn and measured with, since a mismatch would mis-size every label.
  // docs/specs/plugins/view.md — the header-cell template is
  // foreign code invoked on every paint, so it runs behind a *latched* fault barrier: the first
  // throw is reported via `core/pluginError` and the hook is never called again, leaving the
  // default labels rather than reporting the same fault once per frame.
  const configuredCellFormat = config.headerCellFormat;
  let cellFormatFaulted = false;
  const cellFormat =
    typeof configuredCellFormat !== "function"
      ? undefined
      : (cell: HeaderCell): string | null | undefined => {
          if (cellFormatFaulted) return undefined;
          try {
            return configuredCellFormat(cell);
          } catch (error) {
            cellFormatFaulted = true;
            fault(error);
            return undefined;
          }
        };

  function paintInputs(measure: (text: string, font: string) => number): HeaderPaintInputs {
    const font = theme.get("--sg-header-font");
    const fontMajor = theme.get("--sg-header-major-font");
    // docs/specs/plugins/view.md — each tier is measured in the font it is
    // painted in; the memo is keyed on that resolved font, so the two tiers never share a width.
    const resolvedFine = resolveFont(font);
    const resolvedMajor = resolveMajorFont(fontMajor, font);
    return {
      level: axis.currentLevel(),
      locale,
      // docs/specs/plugins/view.md — absent fields mean
      // the pre-existing UTC, untemplated paint.
      ...(timeZone === undefined ? {} : { timeZone }),
      ...(cellFormat === undefined ? {} : { cellFormat }),
      // docs/specs/plugins/view.md — theme tokens; empty strings make the paint
      // fall back to its built-in light-mode defaults.
      fg: theme.get("--sg-header-fg"),
      bg: theme.get("--sg-header-bg"),
      border: theme.get("--sg-header-tick"),
      // the fine tier's day ticks are ground, at the body grid's coarse weight.
      borderMinor: theme.get("--sg-grid-line-major"),
      // docs/specs/plugins/view.md — canvas text became themeable; the token's
      // documented default equals the canvas default that was previously in effect.
      font,
      fontMajor,
      firstDayOfWeek,
      rowRatio,
      labelPadding,
      tToX: axis.tToX,
      xToT: axis.xToT,
      onFormatError: fault,
      measureText: (text: string, tier: HeaderTier) =>
        measure(text, tier === "major" ? resolvedMajor : resolvedFine),
    };
  }

  const header = createHeaderLifecycle(ctx, {
    height: headerTotal,
    // docs/specs/plugins/view.md
    // the pane comes from the renderer's own accessor, which this plugin's `dependsOn`
    // guarantees is available; the former `.sg-pane--chart` class-string lookup is gone, so
    // a renderer-internal DOM rename can no longer silently break the header's placement.
    chartPane: () => render.chartPaneElement(),
    scrollLeft: () => render.viewport.get().scrollLeft,
    paintInputs,
  });

  // docs/specs/plugins/view.md `internal/timeline/` file-plan note; docs/specs/plugins/export.md
  // §4 "Official contributors (dovetail)" — the header band's contribution to
  // `export/auxiliarySurfaces` (a Layer-8 point this plugin only contributes upward to, never
  // owns). Registered unconditionally: the core buffers the contribution until the export plugin
  // is composed (or forever, in a composition without it), so nothing is lost either way. The
  // export path reuses the header lifecycle's own measurement memo (`header.measureText`) rather
  // than opening a second canvas measurement channel.
  contributeUpward(
    ctx,
    "export/auxiliarySurfaces",
    headerAuxiliarySurface({
      height: headerTotal,
      paintInputs: () => paintInputs(header.measureText),
      tToX: axis.tToX,
    }),
  );

  /* --- redraw triggers ----------------------------------------------- */
  // §3.5: the header follows horizontal scroll and is *not* vertically scroll-linked, so a pure
  // `scrollTop` change must not repaint it. `header.schedule()` coalesces onto the next frame, so
  // the subscription itself does no work beyond the comparison.
  ctx.own(
    render.viewport.subscribe((next, prev) => {
      if (next.scrollLeft === prev.scrollLeft) return;
      header.schedule();
    }),
  );
  ctx.on("lifecycle/ready", () => header.schedule());
  // docs/specs/plugins/view.md — the header canvas is not a renderer layer, so the theme module's
  // `invalidate` sweep cannot reach it; its repaint signal is the token store. The token cache has
  // already been re-read by the time the store is set, so a plain repaint picks up the new
  // colours. The font token can change with them, so the font-keyed measurement memo is dropped
  // too — a stale entry keyed on the old font would otherwise never be evicted.
  ctx.own(
    theme.tokens.subscribe(() => {
      header.clearMeasurements();
      header.schedule();
    }),
  );

  /* --- §1.17 origin reachability guard -------------------------------- */
  // docs/specs/plugins/view.md — the guard weighs task starts against the origin. Its incremental
  // path wants the earliest start among only the tasks a change touched, and the snapshot pair
  // yields exactly those by identity: an entry whose object is the one the previous snapshot held
  // cannot have moved.
  /** The earliest finite start among the entries `next` changed or added relative to `prev`. */
  const earliestChangedStart = (
    next: ReadonlyMap<TaskId, Readonly<Task>>,
    prev: ReadonlyMap<TaskId, Readonly<Task>>,
  ): number | undefined => {
    let earliest: number | undefined;
    for (const [id, task] of next) {
      if (prev.get(id) === task) continue;
      const start = task.start;
      if (!Number.isFinite(start)) continue;
      if (earliest === undefined || start < earliest) earliest = start;
    }
    return earliest;
  };

  // docs/specs/plugins/view.md — the base origin: the latest instant the axis may
  // begin at. The axis itself begins at `min(this, the earliest task's UTC day)` while
  // `autoExtendOrigin` is on, which is what lets the extension retract without ever shrinking the
  // range the host asked for. Seeded from the axis, so the day-aligned default applies to it too.
  let baseOrigin = axis.origin();

  const guard = createOriginGuard({
    origin: axis.origin,
    setOrigin: axis.setOrigin,
    baseOrigin: () => baseOrigin,
    // The whole-store walk, over the store's own index. Only the startup check and the guard's own
    // escalations reach it; the per-transaction path below scans the transaction's tasks instead.
    earliestTaskStart: () => {
      let earliest: number | undefined;
      for (const task of data.tasks.get().values()) {
        const start = task.start;
        if (!Number.isFinite(start)) continue;
        if (earliest === undefined || start < earliest) earliest = start;
      }
      return earliest;
    },
    autoExtend: config.autoExtendOrigin === true,
    report: fault,
    // docs/specs/plugins/view.md — one re-armed timer, not one disposable per
    // arming: the guard swaps its own handle and the plugin owns the single cancellation below.
    setTimer: (run, ms) => globalThis.setTimeout(run, ms),
    clearTimer: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  });
  ctx.own({ dispose: () => guard.dispose() });
  ctx.on("lifecycle/ready", () => guard.checkAll());
  // docs/specs/plugins/view.md — the task store is set once per frame while a bar is being dragged
  // (one `task/move` per pointer move, one per peer in a multi-drag), so this subscriber hands the
  // guard only the entries that actually moved; the guard escalates to the whole-store walk on the
  // rare occasions that is not enough.
  ctx.own(
    data.tasks.subscribe((next, prev) => {
      guard.checkChanged(() => earliestChangedStart(next, prev));
    }),
  );

  /* --- §3.5 Ctrl+wheel anchored zoom --------------------------------- */
  const wheelOptions: AddEventListenerOptions = { capture: true, passive: false };
  const onWheel = (e: WheelEvent): void => {
    if (!e.ctrlKey || e.deltaY === 0) return;
    // Capture phase on the root: the renderer's own pane-level wheel handler (virtual scroll,
    // §3.3) must not also act on a zoom gesture.
    e.preventDefault();
    e.stopPropagation();
    // Measured from the chart pane, the box `scrollLeft` and the axis are expressed in — not from
    // the root, whose left edge is the tree grid's when one is present. Asked for only when the
    // gesture really changes level, so a notch at either end costs no forced layout read.
    axis.zoomByWheel(e.deltaY, () => {
      const left = render.chartPaneElement().getBoundingClientRect().left;
      return render.viewport.get().scrollLeft + (e.clientX - left);
    });
  };
  ctx.root.addEventListener("wheel", onWheel, wheelOptions);
  ctx.own({ dispose: () => ctx.root.removeEventListener("wheel", onWheel, wheelOptions) });

  /* --- §1.9 zoom commands --------------------------------------------- */
  // docs/specs/plugins/view.md — the command payload's optional
  // `anchorTime` names the instant to hold in place; omitted, the middle of the visible chart
  // area anchors, so a command-driven zoom never yanks the viewport sideways (the wheel gesture
  // anchors at the pointer for the same reason).
  const commandAnchor = (anchorTime: number | undefined): number => {
    if (anchorTime !== undefined && Number.isFinite(anchorTime)) return anchorTime;
    const vp = render.viewport.get();
    return axis.xToT(vp.scrollLeft + vp.width / 2);
  };
  ctx.registerCommand("timeline/zoomIn", (payload) => {
    axis.stepZoom("in", commandAnchor(payload?.anchorTime));
  });
  ctx.registerCommand("timeline/zoomOut", (payload) => {
    axis.stepZoom("out", commandAnchor(payload?.anchorTime));
  });

  /* --- §3.3 service --------------------------------------------------- */
  // docs/specs/plugins/view.md — the store needs a value now, but `initialZoom` must not be
  // resolved yet: the ladder is only this plugin's own levels until every other plugin has had its
  // `setup()`, and `currentLevel()` latches the resolution against whatever it first sees. `peek`
  // answers from the partial ladder without consuming that resolution; `lifecycle/ready` below
  // performs it, once the composed list is final.
  zoomStore = createStore<Readonly<ZoomLevel>>(axis.peekLevel());
  ctx.on("lifecycle/ready", () => {
    // Republished only when the composed ladder actually resolved to a different level than the
    // seed — an ordinary composition names no contributed level and sees no notification at all.
    const resolved = axis.currentLevel();
    if (resolved !== zoomStore?.get()) publishLevel();
  });

  const service: TimelineService = {
    tToX: axis.tToX,
    xToT: axis.xToT,
    get pxPerMs(): number {
      return axis.pxPerMs();
    },
    zoomLevel: zoomStore,
    setZoomLevel: axis.setZoomLevel,
    // docs/specs/plugins/view.md — the compensation, the repaint and the change
    // event all hang off the axis's `onOriginChanged` callback above, so every path that moves the
    // origin deliberately (this member and the auto-extend of §1.17) shares one implementation.

    // docs/specs/plugins/view.md — what this member sets is the *base* origin. The
    // guard then derives the axis from it and the data and applies the result in a single move: two
    // moves would let the intermediate position be clamped at the range's left edge and never come
    // back, which is exactly the jump the compensation exists to prevent.
    setOrigin: (ms: number): void => {
      if (typeof ms !== "number" || !Number.isFinite(ms)) return;
      baseOrigin = ms;
      guard.rebase();
    },
    // docs/specs/plugins/view.md — the extension reached from a caller holding an
    // instant the store does not have yet, so a drag can reach a date before the chart's opening day
    // without waiting for a commit. A no-op unless `autoExtendOrigin` is on. The request holds the
    // extension for the gesture's lifetime; the release below is what ends it.
    requestOriginExtension: guard.requestExtension,
    releaseOriginExtension: guard.releaseExtension,
    // docs/specs/plugins/view.md — the composed ladder's densities, published read-only so a
    // consumer never has to activate levels to measure them (which would set the zoom-level store
    // for changes no user asked for). Mapped to a fresh array of fresh entries so a caller cannot
    // reach the contributed `ZoomLevel` objects through it.
    levelMetrics: () => {
      const list = point.get();
      if (!Array.isArray(list)) return [];
      return list.map((level) => ({ id: level.id, pxPerDay: level.pxPerDay }));
    },
    // docs/specs/plugins/view.md — static per instance, normalized at setup.
    firstDayOfWeek: () => firstDayOfWeek,
    // docs/specs/plugins/view.md — the one calendar: the same internal
    // `floorToStep` / `advance` pair and the same `MAX_TICKS` cap the header's own tick generation
    // runs on, so a consumer's boundaries can never disagree with the ones the header paints.
    unitBoundaries: (unit, fromMs, toMs, step, stepOffset) =>
      unitBoundaries(fromMs, toMs, unit, step, firstDayOfWeek, timeZone, stepOffset),
    // docs/specs/plugins/view.md — one formatting channel for
    // consumers, sharing the header's own memoised formatters, locale, calendar and zone.
    formatDate: (t, options) => formatInstant(locale, builtInOptions, t, options),
    // docs/specs/plugins/view.md — the chart's unit of time: the cell the *fine*
    // scale row draws (the level's last row, the one grid-lines takes its minor verticals from),
    // resolved through the same calendar arithmetic `unitBoundaries` runs on.
    gridCellAt: (t) => {
      const rows = axis.currentLevel().scales;
      const fine = rows.length > 0 ? rows[rows.length - 1] : undefined;
      if (fine === undefined) return undefined;
      return cellAt(t, fine.unit, fine.step, firstDayOfWeek, timeZone, fine.stepOffset);
    },
  };
  return service;
}
