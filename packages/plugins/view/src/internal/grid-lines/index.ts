// docs/specs/plugins/view.md
/**
 * The grid-lines module of `stargantt.view`.
 *
 * Draws the chart body's grid: vertical lines at the time boundaries of the active zoom level's
 * header rows, and horizontal separator lines at the row boundaries, plus the background shading
 * passes (row stripes, non-working days, zones, the off-hours hatch and the hovered-row fill). The
 * colors come from CSS custom properties, so the grid follows light/dark theming the same way
 * every other painted color does.
 *
 * It publishes no service and emits no event — the module does one thing: contribute a single
 * drawing pass to `renderer/layers`.
 */
import type { PluginContext } from "@stargantt/core";
import type { CalendarDef, CalendarId } from "@stargantt/plugin-data-store";
// Runtime workspace imports (bundled — no third-party runtime dependency is added).
import { alignHalfPixel, listen, MS_DAY, nonWorkingIntervals } from "@stargantt/sdk";
import type { TimeRange } from "@stargantt/sdk";
import { PLUGIN_ID } from "../plugin-id";
import type { LayerContribution, RenderModule, RowGeometryProvider, Viewport } from "../render/index";
import type { ThemeService } from "../theme/index";
import type { ScaleRow, TimelineService } from "../timeline/index";
import {
  MIN_BAND_PX,
  bandIsLegible,
  isWholeDayBand,
  isWithinOneUtcDay,
  normalizeNonWorkingDays,
  normalizeZones,
  rowAt,
  weekendSpans,
} from "./shading";
import type { NonWorkingDaysOption, Zone } from "./shading";

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

/** Identifies this module's contribution to `renderer/layers`, and its `claimOrder` key. */
const LAYER_ID = "view:grid-lines";

// docs/specs/plugins/view.md — `zIndex: 10` is the claimed order: the background canvas, under
// every task bar (60), dependency line (70) and the today line (55), so the grid can never
// obscure figure content.
const LAYER_Z_INDEX = 10;

// docs/specs/plugins/view.md — the consumer pattern is `theme.get(token) ||
// FALLBACK`, and each fallback is the token's own light-mode value
// (docs/specs/plugins/view.md) so an unstyled host still sees a grid.
const TOKEN_MINOR = "--sg-grid-line-minor";
const FALLBACK_MINOR = "#f5f4f1";
const TOKEN_MAJOR = "--sg-grid-line-major";
const FALLBACK_MAJOR = "#e7e5e4";

// docs/specs/plugins/view.md — shading tokens. `--sg-row-hover-bg` is
// the theme registry's existing grid-row hover token, reused so the chart-side hover matches the
// grid pane's; the other three are grid-lines' own, with light-value fallbacks.
const TOKEN_NONWORKING = "--sg-grid-nonworking";
const FALLBACK_NONWORKING = "rgba(220, 38, 38, 0.08)";
const TOKEN_OFFHOURS = "--sg-grid-offhours";
const FALLBACK_OFFHOURS = "rgba(220, 38, 38, 0.08)";
const TOKEN_ZONE = "--sg-grid-zone";
const FALLBACK_ZONE = "rgba(15, 118, 110, 0.1)";
const TOKEN_HOVER = "--sg-row-hover-bg";
const FALLBACK_HOVER = "#f2f0ec";
// §4.5 — the alternating row background that replaced the per-row separator lines.
const TOKEN_STRIPE = "--sg-row-stripe-bg";
const FALLBACK_STRIPE = "#faf9f7";

/** Horizontal distance between the off-hours hatch diagonals, CSS px. */
const HATCH_STEP = 8;

/** Stand-in for "no boundaries this tier", so a skipped tier allocates nothing. */
const NO_TIMES: readonly number[] = [];

/** The normalized form of `GridLinesConfig.vertical`: booleans collapse into this union. */
type VerticalTiers = "none" | "major" | "both";

/* ------------------------------------------------------------------ *
 * Config normalization
 * ------------------------------------------------------------------ */

// docs/specs/plugins/view.md — rules 3 and 5 — read once at setup, and a value that
// is not a boolean degrades to the default instead of failing.
function normalizeFlag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

// docs/specs/plugins/view.md — which tiers of vertical line are drawn. `"major"`
// is the default: one line per coarse boundary (the upper header row's period — a month at the
// built-in day and week zooms) instead of one per fine column, which turned the body into a mesh.
function normalizeVertical(value: unknown): VerticalTiers {
  if (value === false) return "none";
  if (value === true) return "both";
  return value === "both" || value === "major" || value === "none" ? value : "major";
}

/* ------------------------------------------------------------------ *
 * Plugin
 * ------------------------------------------------------------------ */

/** The factory-normalized options `setup` receives (read once, unusable values dropped). */
export interface GridLinesOptions {
  vertical: VerticalTiers;
  horizontal: boolean;
  rowStripes: boolean;
  nonWorkingDays: NonWorkingDaysOption | undefined;
  nonWorkingHours: boolean;
  zones: readonly Zone[];
  rowHover: boolean;
}

/** What the grid-lines module reads from the store it shares the composition with. */
export interface GridLinesDataSource {
  /** The stored calendar definitions, by id — the source an explicit `nonWorkingDays.calendar` names. */
  calendar(id: CalendarId): Readonly<CalendarDef> | undefined;
}

/** Creates the grid-lines module: one contributed background pass, or none at all. */
export function createGridLinesModule(
  ctx: PluginContext,
  opt: GridLinesOptions,
  render: RenderModule,
  theme: ThemeService,
  scale: TimelineService,
  data: GridLinesDataSource,
): void {
  const { vertical, horizontal, rowStripes, nonWorkingDays, nonWorkingHours, zones, rowHover } = opt;
  // docs/specs/plugins/view.md — verbatim (non-token) zone colors bypass the
  // theme registry, so the theme plugin's forced-colors mapping cannot neutralize
  // them. The pass consults the media query itself: while `(forced-colors: active)` matches,
  // verbatim-colored zones are not painted, matching how the token path resolves to
  // `transparent`. Configuring a verbatim zone color is the opt-in for this code path — with no
  // verbatim zone the query is never created, so the default composition takes no forced-colors
  // code path at all, matching the theme layer's own opt-in stance. The query object is captured
  // once; `matches` is read live at paint time, and a live flip of the state triggers a background
  // repaint via a `change` listener whose removal is handed to `ctx.own()`.
  const hasVerbatimZone = zones.some((z) => z.color !== undefined && !z.color.startsWith("--"));
  const forcedColorsQuery: { matches: boolean } | undefined =
    hasVerbatimZone && typeof globalThis.matchMedia === "function"
      ? globalThis.matchMedia("(forced-colors: active)")
      : undefined;
  if (forcedColorsQuery !== undefined) {
    const mql = forcedColorsQuery as MediaQueryList;
    // Guarded: test doubles (and very old engines) hand back a bare `{ matches }` object.
    if (typeof mql.addEventListener === "function") {
      const onForcedColorsChange = (): void => {
        render.invalidate("background");
      };
      mql.addEventListener("change", onForcedColorsChange);
      ctx.own({ dispose: () => mql.removeEventListener("change", onForcedColorsChange) });
    }
  }
  const anything =
    vertical !== "none" ||
    horizontal ||
    rowStripes ||
    nonWorkingDays !== undefined ||
    nonWorkingHours ||
    zones.length > 0 ||
    rowHover;

  // Whole-pixel band edges: a shaded band whose edge coincides with a gridline must not bleed a
  // fractional pixel past it. Both helpers stay allocation-free — they are on the paint path, once
  // per band.
  /** The clamped left edge of a time band in viewport space. */
  function bandLeft(vp: Readonly<Viewport>, startMs: number): number {
    return Math.max(0, Math.round(scale.tToX(startMs) - vp.scrollLeft));
  }
  /** The clamped right edge of a time band in viewport space. */
  function bandRight(vp: Readonly<Viewport>, endMs: number): number {
    return Math.min(vp.width, Math.round(scale.tToX(endMs) - vp.scrollLeft));
  }

  /** Fills one clamped vertical band of the viewport, or nothing when it is off-screen. */
  function fillBand(
    g: CanvasRenderingContext2D,
    vp: Readonly<Viewport>,
    startMs: number,
    endMs: number,
  ): void {
    const x1 = bandLeft(vp, startMs);
    const x2 = bandRight(vp, endMs);
    if (x2 <= x1) return;
    g.fillRect(x1, 0, x2 - x1, vp.height);
  }

  /** The non-working bands of one paint, plus whether a working calendar produced them. */
  interface Bands {
    ranges: readonly TimeRange[];
    /** True only for calendar-sourced bands — the weekend fallback can never be intra-day. */
    fromCalendar: boolean;
  }

  // docs/specs/plugins/view.md — **one** engine listing per paint feeds both the solid tint and
  // the hatch, so the two can never disagree about what is non-working. The bands are the shared
  // working-time engine's `nonWorkingIntervals` over the visible span: whole non-working days,
  // exception days, and — whenever the calendar declares intra-day working windows — the sub-day
  // gaps of its working days, with no extra configuration. Resolution happens per paint, so an
  // edit to the stored calendar reaches the grid with no subscription. With no calendar named, or
  // one the store does not hold, the whole-day weekend fallback applies instead, via the same day
  // boundaries the header uses.
  function collectBands(from: number, to: number): Bands | undefined {
    if (nonWorkingDays === undefined && !nonWorkingHours) return undefined;
    // §4.1 guard, gate 1: under a legible day column the whole shading stops. The hatch stops with
    // it, because the contract keeps tint and hatch on one threshold — they appear and disappear
    // together rather than on two.
    if (!(scale.pxPerMs * MS_DAY >= MIN_BAND_PX)) return undefined;
    // docs/specs/plugins/view.md — the calendar source: an explicit `nonWorkingDays.calendar` is
    // read from the data store and evaluated through the shared working-time engine, so the
    // shading and the scheduler agree on what is non-working. An id the store does not hold
    // degrades to the same weekend fallback an unnamed calendar gets.
    const named = nonWorkingDays?.calendar;
    if (named !== undefined) {
      const cal = data.calendar(named);
      if (cal !== undefined) return { ranges: nonWorkingIntervals(cal, from, to), fromCalendar: true };
    }
    // The whole-day fallback exists only for the tint: §4.2 needs a calendar's declared windows,
    // and the fallback workweek declares none. It is `sdk/time`'s `DEFAULT_WORKWEEK` pattern —
    // Saturday and Sunday, UTC, whole days — spelled through the header's own day boundaries so
    // the bands land on the same columns the grid rules, or the configured `weekend` list.
    if (nonWorkingDays === undefined) return undefined;
    return {
      ranges: weekendSpans(scale.unitBoundaries("day", from, to, 1), nonWorkingDays.weekend),
      fromCalendar: false,
    };
  }

  // docs/specs/plugins/view.md — the solid non-working tint. Every
  // band the guard admits is filled; a band it rejects is omitted entirely, never widened and
  // never merged into a neighbour, so the picture degrades to exactly the day-granular shading.
  // Weekend-fallback bands are whole UTC days by construction and therefore always pass the
  // per-band gate: a composition without a calendar renders byte-identically to before.
  function drawNonWorkingDays(
    g: CanvasRenderingContext2D,
    vp: Readonly<Viewport>,
    bands: Bands | undefined,
    from: number,
    to: number,
  ): void {
    if (nonWorkingDays === undefined || bands === undefined || bands.ranges.length === 0) return;
    g.fillStyle = theme.get(TOKEN_NONWORKING) || FALLBACK_NONWORKING;
    for (const band of bands.ranges) {
      if (!bandIsLegible(band, from, to, scale.pxPerMs)) continue;
      fillBand(g, vp, band.start, band.end);
    }
  }

  // docs/specs/plugins/view.md — configured highlight zones, painted over the
  // non-working shading and under the hover fill and the lines. A `color` beginning with `--` is a
  // CSS custom-property name resolved through the theme service (pattern), falling back to
  // the zone token/default chain when the named property is unset; any other string is a verbatim
  // canvas color, unaudited against dark schemes and skipped entirely (rendered transparent)
  // while `(forced-colors: active)` matches, so it never paints over the system palette (,
  // family).
  function drawZones(g: CanvasRenderingContext2D, vp: Readonly<Viewport>): void {
    if (zones.length === 0) return;
    const fallback = theme.get(TOKEN_ZONE) || FALLBACK_ZONE;
    for (const zone of zones) {
      if (zone.color === undefined || zone.color.startsWith("--")) {
        g.fillStyle = zone.color === undefined ? fallback : theme.get(zone.color) || fallback;
      } else {
        if (forcedColorsQuery?.matches === true) continue;
        g.fillStyle = zone.color;
      }
      fillBand(g, vp, zone.start, zone.end);
    }
  }

  // docs/specs/plugins/view.md — diagonal hatch over the off-hours
  // stretches of each visible *working* day. The hatch (a pattern, not only a color) keeps the
  // marking legible for color-impaired viewers and distinct from the solid non-working fill.
  function hatchBand(g: CanvasRenderingContext2D, vp: Readonly<Viewport>, x1: number, x2: number): void {
    g.save();
    g.beginPath();
    g.rect(x1, 0, x2 - x1, vp.height);
    g.clip();
    g.beginPath();
    for (let x = x1 - vp.height; x < x2; x += HATCH_STEP) {
      g.moveTo(x, vp.height);
      g.lineTo(x + vp.height, 0);
    }
    g.stroke();
    g.restore();
  }

  // docs/specs/plugins/view.md — the hatched bands are the spans of
  // the same listing §4.1 tints that lie **within a single UTC day** (whole-day-aligned spans stay
  // §4.1's job), classified by the same arithmetic, so tint and hatch always agree about what is
  // non-working. Merely being unaligned is not enough: the engine merges adjacent non-working
  // ranges, so a calendar with intra-day windows produces one band from Friday evening across the
  // weekend to Monday morning — non-working *time* the tint already conveys, not off-hours.
  // The plugin carries no working-hours complement of its own any more: the engine owns window
  // validation (unusable pairs dropped, overlaps merged, milliseconds from UTC midnight —),
  // and a calendar with no usable window simply yields no sub-day span, which draws nothing here.
  function drawOffHours(
    g: CanvasRenderingContext2D,
    vp: Readonly<Viewport>,
    bands: Bands | undefined,
    from: number,
    to: number,
  ): void {
    if (!nonWorkingHours || bands === undefined || !bands.fromCalendar) return;
    let styled = false;
    for (const band of bands.ranges) {
      if (isWholeDayBand(band, from, to)) continue;
      if (!isWithinOneUtcDay(band)) continue;
      // The same per-band 3 CSS px gate §4.1 applies, on the same spans: tint and hatch appear
      // and disappear together instead of on two different thresholds.
      if (!bandIsLegible(band, from, to, scale.pxPerMs)) continue;
      const x1 = bandLeft(vp, band.start);
      const x2 = bandRight(vp, band.end);
      if (x2 <= x1) continue;
      if (!styled) {
        g.strokeStyle = theme.get(TOKEN_OFFHOURS) || FALLBACK_OFFHOURS;
        g.lineWidth = 1;
        styled = true;
      }
      hatchBand(g, vp, x1, x2);
    }
  }

  // docs/specs/plugins/view.md — row geometry arrives through `renderer/rowGeometry` and is
  // resolved at draw time, per pass: a provider contributed after this module was created is
  // visible from the next paint on, and nothing is cached across paints.
  function getRowModel(): RowGeometryProvider | undefined {
    return render.rowGeometry();
  }

  /**
   * The row-geometry fault barrier.
   *
   * The provider is foreign code invoked at draw time, so a throw costs the pass that hit it its
   * frame and nothing else: the other passes still run, the frame still composites, and the fault
   * is reported once through `core/pluginError` rather than once per member call. Each pass calls
   * this from its own `catch` rather than being wrapped in a closure-taking helper — a helper
   * would allocate one closure per pass per paint, on the hottest path this module has.
   */
  function rowGeometryFault(error: unknown): void {
    render.fault(error);
  }

  /* --- §4.5 alternating row background ------------------------ */

  // docs/specs/plugins/view.md — the stripe replaces the per-row
  // separator line as the cue that tracks one task across the two panes, so it must land on the
  // same rows the grid pane stripes. Parity therefore comes from the *logical* row index, never
  // from a count of the rows this pass happens to visit: with virtual scrolling the first visible
  // row is arbitrary, and parity derived from it would flip as the viewport moved.
  function drawStripes(g: CanvasRenderingContext2D, vp: Readonly<Viewport>): void {
    if (!rowStripes) return;
    const rows = getRowModel();
    if (rows === undefined) return;
    try {
      const count = rows.rowCount();
      const first = Math.max(0, rows.rowAtY(vp.scrollTop));
      g.fillStyle = theme.get(TOKEN_STRIPE) || FALLBACK_STRIPE;
      for (let row = first; row < count; row += 1) {
        const y = rows.yOf(row) - vp.scrollTop;
        if (y >= vp.height) break;
        const height = rows.rowHeight(row);
        if (y + height <= 0) continue;
        if (row % 2 === 0) continue;
        g.fillRect(0, y, vp.width, height);
      }
    } catch (error) {
      rowGeometryFault(error);
    }
  }

  /* --- §4.4 row hover ------------------------------------------------- */

  // The pointer's last y over the chart pane, in pane CSS px; `undefined` while it is outside.
  let hoverY: number | undefined;
  // The last row the hover was resolved to, kept only to skip redundant repaints.
  let hoverRow: number | undefined;

  // docs/specs/plugins/view.md — at paint the fill is recomputed
  // from the stored pointer y plus the *current* `scrollTop`, so a scroll under a resting pointer
  // moves the highlight with no extra listener.
  function drawHover(g: CanvasRenderingContext2D, vp: Readonly<Viewport>): void {
    if (!rowHover || hoverY === undefined) return;
    const rows = getRowModel();
    if (rows === undefined) return;
    try {
      const row = rowAt(rows, hoverY + vp.scrollTop);
      if (row === undefined) return;
      const y = rows.yOf(row) - vp.scrollTop;
      g.fillStyle = theme.get(TOKEN_HOVER) || FALLBACK_HOVER;
      g.fillRect(0, y, vp.width, rows.rowHeight(row));
    } catch (error) {
      rowGeometryFault(error);
    }
  }

  // docs/specs/plugins/view.md — the passes that follow the row model own no subscription of
  // their own: the layer dirty flags are per layer, so a task added or removed marks `main` dirty
  // (task-bars) but never `background`, and repainting this layer when the row set moves is the
  // geometry contributor's responsibility — it holds the row model and calls `invalidate` from its
  // own updates. This module holds no reference to it and cannot observe the change itself.

  if (rowHover) {
    const pane = render.chartPaneElement();
    const sync = (): void => {
      // The resolve runs at pointer rate rather than at draw time, but takes the same barrier:
      // a throwing provider must not break the listener that owns the hover state.
      let row: number | undefined;
      try {
        const rows = getRowModel();
        row =
          hoverY === undefined || rows === undefined
            ? undefined
            : rowAt(rows, hoverY + render.viewport.get().scrollTop);
      } catch (error) {
        rowGeometryFault(error);
        return;
      }
      if (row === hoverRow) return;
      hoverRow = row;
      render.invalidate("background");
    };
    // docs/specs/plugins/view.md — `listen` hands the removal to
    // `ctx.own()`, once per listener, so the instance owns both teardowns.
    listen(ctx, pane, "pointermove", (e) => {
      // `e.offsetY` is relative to whatever element the event target is — a DOM overlay child of
      // the pane (a tooltip, a drag handle) yields a different origin than the pane itself, which
      // put the hover fill under the wrong row whenever the pointer was over such a child. Pane-
      // relative Y is computed from `clientY` against the pane's own rect instead, which is
      // origin-stable regardless of which descendant dispatched the event; the rect is read per
      // event (event-rate, not frame-rate) because page scroll or an ancestor layout change can
      // move the pane without resizing it.
      hoverY = e.clientY - pane.getBoundingClientRect().top;
      sync();
    });
    listen(ctx, pane, "pointerleave", () => {
      hoverY = undefined;
      sync();
    });
  }

  /** Adds one full-height vertical line to the current path, unless it is off-viewport. */
  function strokeVerticals(
    g: CanvasRenderingContext2D,
    vp: Readonly<Viewport>,
    times: readonly number[],
  ): void {
    for (let i = 0; i < times.length; i += 1) {
      const time = times[i];
      if (time === undefined) continue;
      const x = alignHalfPixel(scale.tToX(time) - vp.scrollLeft);
      if (x < 0 || x >= vp.width) continue;
      g.moveTo(x, 0);
      g.lineTo(x, vp.height);
    }
  }

  // docs/specs/plugins/view.md — the two tiers are the active zoom
  // level's bottom (finest) and top (coarsest) `ScaleRow`. A level with more than two rows uses
  // its first and last; a single-row level yields one tier, drawn as major.
  /** The finest header row, whose boundaries carry the minor lines. */
  function minorRow(rows: readonly ScaleRow[]): ScaleRow | undefined {
    return rows.length > 1 ? rows[rows.length - 1] : undefined;
  }
  /** The coarsest header row, whose boundaries carry the major lines. */
  function majorRow(rows: readonly ScaleRow[]): ScaleRow | undefined {
    return rows[0];
  }

  /* --- §3 `renderer/layers` contribution ------------------------------ */

  /**
   * docs/specs/plugins/view.md — the shading passes run before the line
   * passes, so every fill sits under every line: the row stripe first (it is the ground the column
   * shadings read against), then solid non-working days, then zones, then the off-hours hatch,
   * then the transient hover fill on top.
   */
  function drawShading(g: CanvasRenderingContext2D, vp: Readonly<Viewport>): void {
    if (rowStripes) {
      g.save();
      drawStripes(g, vp);
      g.restore();
    }
    if (nonWorkingDays !== undefined || nonWorkingHours || zones.length > 0) {
      const fillFrom = scale.xToT(vp.scrollLeft);
      const fillTo = scale.xToT(vp.scrollLeft + vp.width);
      g.save();
      // One listing per paint, shared by the tint and the hatch even though the zones are
      // painted between them.
      const bands = collectBands(fillFrom, fillTo);
      drawNonWorkingDays(g, vp, bands, fillFrom, fillTo);
      drawZones(g, vp);
      drawOffHours(g, vp, bands, fillFrom, fillTo);
      g.restore();
    }
    if (rowHover) {
      g.save();
      drawHover(g, vp);
      g.restore();
    }
  }

  /**
   * The instants the two vertical tiers draw at.
   *
   * docs/specs/plugins/view.md — the boundary instants come from the time scale's
   * own enumeration, so the body grid and the header ticks are one calendar (UTC arithmetic,
   * calendar-anchored stepping, the chart's week start) rather than two. Only the `from` edge is
   * widened, by the time equivalent of 1 CSS px, so a boundary whose half-pixel-aligned line still
   * lands inside the viewport's left edge is not lost to the enumeration's half-open lower bound;
   * the `to` edge needs none, because a line on the right edge is culled by `strokeVerticals`
   * anyway. A non-positive or non-finite `pxPerMs` (a collapsed axis) leaves the span unwidened
   * instead of producing an infinite offset.
   */
  function boundaryTimes(vp: Readonly<Viewport>): { minor: readonly number[]; major: readonly number[] } {
    if (vertical === "none") return { minor: NO_TIMES, major: NO_TIMES };
    const rowsOfHeader = scale.zoomLevel.get().scales;
    const minor = minorRow(rowsOfHeader);
    const major = majorRow(rowsOfHeader);
    const pxPerMs = scale.pxPerMs;
    const to = scale.xToT(vp.scrollLeft + vp.width);
    const from = scale.xToT(vp.scrollLeft) - (pxPerMs > 0 ? 1 / pxPerMs : 0);
    return {
      // `"major"` skips the fine tier's enumeration entirely rather than enumerating it and
      // discarding the result, so the default composition does no per-day work at all.
      // docs/specs/plugins/view.md — a row's
      // `stepOffset` moves where its stepped sequence breaks (an April-start fiscal year), and the
      // header paints on the shifted boundaries. Passing it here is what keeps the body grid on
      // the same lines as the header and as `gridCellAt`; dropping it drew Jan/Apr/Jul/Oct lines
      // under a Feb/May/Aug/Nov header.
      minor:
        minor !== undefined && vertical === "both"
          ? scale.unitBoundaries(minor.unit, from, to, minor.step, minor.stepOffset)
          : NO_TIMES,
      major:
        major === undefined
          ? NO_TIMES
          : scale.unitBoundaries(major.unit, from, to, major.step, major.stepOffset),
    };
  }

  /**
   * The y of each visible row's lower edge, reused across paints so the separator pass allocates
   * nothing per frame.
   */
  const separatorYs: number[] = [];

  /**
   * Adds the row separators to the open path — one line under each visible row.
   *
   * The geometry is collected before anything is traced, so a provider that throws part-way
   * through leaves the path exactly as it found it: the separators drop out as a whole rather than
   * as a partial ladder, and this pass shares its path and its single `stroke()` with the minor
   * verticals, which are already traced and must still paint.
   */
  function traceRowSeparators(
    g: CanvasRenderingContext2D,
    vp: Readonly<Viewport>,
    rows: RowGeometryProvider,
  ): void {
    separatorYs.length = 0;
    try {
      const count = rows.rowCount();
      const first = Math.max(0, rows.rowAtY(vp.scrollTop));
      for (let row = first; row < count; row += 1) {
        const y = alignHalfPixel(rows.yOf(row) + rows.rowHeight(row) - vp.scrollTop);
        if (y >= vp.height) break;
        if (y < 0) continue;
        separatorYs.push(y);
      }
    } catch (error) {
      // The throw must not escape `draw()`: it would unwind past the `g.save()` the caller took,
      // leaving the context one level deep for every later pass — the major verticals included.
      rowGeometryFault(error);
      return;
    }
    for (let i = 0; i < separatorYs.length; i += 1) {
      const y = separatorYs[i] as number;
      g.moveTo(0, y);
      g.lineTo(vp.width, y);
    }
  }

  function draw(g: CanvasRenderingContext2D, vp: Readonly<Viewport>): void {
    if (!anything) return;
    drawShading(g, vp);
    if (vertical === "none" && !horizontal) return;

    // docs/specs/plugins/view.md — the row model is optional and is
    // resolved on every paint, so a composition with no row-geometry contribution simply gets no
    // horizontal lines while the vertical pass is unaffected.
    const rows = horizontal ? getRowModel() : undefined;
    const times = boundaryTimes(vp);

    g.save();
    g.lineWidth = 1;

    // docs/specs/plugins/view.md — one path per color pass:
    // the minor verticals and the row separators share a color and a single stroke, and the major
    // verticals are painted afterwards so a coincident boundary shows the major color.
    g.strokeStyle = theme.get(TOKEN_MINOR) || FALLBACK_MINOR;
    g.beginPath();
    strokeVerticals(g, vp, times.minor);
    if (rows !== undefined) traceRowSeparators(g, vp, rows);
    g.stroke();

    if (times.major.length > 0) {
      g.strokeStyle = theme.get(TOKEN_MAJOR) || FALLBACK_MAJOR;
      g.beginPath();
      strokeVerticals(g, vp, times.major);
      g.stroke();
    }

    g.restore();
  }

  // `draw` bails out on its very first line when `!anything`, so contributing the layer at all in
  // that composition would only cost the renderer an empty paint call every frame for nothing —
  // skip the contribution entirely instead.
  if (anything) {
    // docs/specs/plugins/view.md — the order is arbitrated in code rather than by a table in a
    // document; the claim and the contribution carry the same key and the same number.
    ctx.claimOrder("renderer/layers", LAYER_ID, LAYER_Z_INDEX);
    const layer: LayerContribution = { id: LAYER_ID, zIndex: LAYER_Z_INDEX, draw };
    ctx.contribute("renderer/layers", layer);
  }

  // No `renderer/hitTest` contribution: the lines are decoration and a pointer over them lands on
  // whatever is behind them (§2).
}
