// docs/specs/plugins/view.md
/**
 * `view(config?)`'s configuration, and the normalization every module of the plugin reads.
 *
 * Every field is optional and every unusable value falls back to its default silently, so a host
 * that mis-types an option gets the default behaviour rather than a broken chart. Everything is
 * read once, when the factory is called: the object is snapshotted there, and a later mutation of
 * the caller's object changes nothing.
 */
import type { CalendarId } from "@stargantt/plugin-data-store";
import { normalizeNonWorkingDays, normalizeZones } from "./internal/grid-lines/shading";
import type { GridLinesOptions } from "./internal/grid-lines/index";
import type { ViewMode } from "./internal/panes/view-mode";
import type { RenderOptions } from "./internal/render/index";
import type { ColorScheme, ThemePreset } from "./internal/theme/types";
import type { HeaderCell, ZoomLevel } from "./internal/timeline/index";
import { resolveStatusDate } from "./internal/today-line/status-date";
import type { StatusDateInput } from "./internal/today-line/status-date";

/* ------------------------------------------------------------------ *
 * The configuration surface
 * ------------------------------------------------------------------ */

/** Wheel and scrollbar behaviour of the chart body. */
export interface ScrollConfig {
  /**
   * Multiplies wheel deltas before they are clamped and applied, so a host can speed up or slow
   * down wheel scrolling. Defaults to `1`; values that are not finite and positive are ignored.
   */
  wheelSpeedFactor?: number;
  /**
   * Shows the synthetic scrollbars the renderer draws over the chart body — one down the right
   * edge, present while the vertical content extent exceeds the viewport, and one along the
   * bottom edge, present while the horizontal extent does. This single switch governs both; there
   * is no per-axis option. Defaults to `true`; set `false` to suppress them entirely.
   *
   * Neither bar reserves layout space — they float over the chart — and neither is a native scroll
   * container: the thumb can be dragged, but wheel input reaches the chart, not the bar.
   */
  scrollbar?: boolean;
}

/**
 * Options for the pane row. Every field is optional; an unusable value is silently ignored.
 * Each pane's width, side and resizability are properties of the `view/panes` contribution that
 * adds it, not of this object.
 */
export interface PanesConfig {
  /**
   * The view mode the chart starts in, applied once the panes are mounted: `"split"` (side panes
   * and chart together — the default), `"grid"` (table view: left-side panes only, the innermost
   * filling the width) or `"gantt"` (chart view: contributed panes hidden). Any other value — and
   * `"grid"` when no left-side pane exists — is silently ignored and the chart starts in
   * `"split"`. The mode can be changed at any time with the `view/setViewMode` command.
   */
  initialViewMode?: ViewMode;
}

/**
 * Options for the theme layer. Every field is optional and everything defaults to the behaviour a
 * composition had before the option existed. CSS custom properties stay the single source of truth
 * for colours, so ordinary theming is still done in CSS rather than here.
 */
export interface ThemeConfig {
  /**
   * The name of a preset to apply as soon as the plugin activates — one of the bundled preset
   * names (`"high-contrast"`, `"high-contrast-dark"`) or a key of {@link ThemeConfig.presets}. An
   * unknown name is silently ignored. Default: none applied.
   */
  preset?: string;

  /**
   * Additional named presets, selectable at runtime via the service alongside the bundled ones.
   * Each is either a flat map of CSS custom-property names (`--sg-*`) to CSS values, or an object
   * of the form `{ colorScheme?, tokens }` that also pins a colour scheme while it is applied. A
   * preset given a bundled name replaces that bundled preset. Entries whose key is not a
   * custom-property name or whose value is not a non-empty string are silently dropped.
   */
  presets?: Record<string, Record<string, string> | ThemePreset>;

  /**
   * `true` makes the chart honour forced-colors environments (Windows High Contrast): while the
   * `(forced-colors: active)` media query matches, tokens known to be painted on canvas resolve
   * to CSS system colors (`Canvas`, `CanvasText`, `Highlight`, …) so the canvas follows the
   * user's system palette like the surrounding page does, and the chart repaints when the state
   * flips. Default: `false`.
   */
  forcedColors?: boolean;

  /**
   * Pins this chart's colour scheme, so the library's default palette resolves in that scheme on
   * this chart whatever the page and the operating system are doing. Default `"auto"`: the page
   * decides, which is how a chart behaves with no pin at all. While a preset that names a colour
   * scheme is applied, that preset's scheme is used instead; this pin is what the chart returns to
   * when the preset is cleared. See {@link ThemeService.setColorScheme} for what pinning changes.
   */
  colorScheme?: ColorScheme;

  /**
   * `false` silences the two setup-time theme warnings: a token the library has retired that the
   * page still declares, and a palette that overrides only part of the token set on a chart whose
   * colour scheme is not pinned (where the tokens it leaves alone still follow the operating
   * system and can paint the other scheme's values). Default: `true`. Each warning is reported at
   * most once per chart, and only when the situation is actually detected.
   */
  diagnostics?: boolean;
}

/**
 * Options for the timeline-scale plugin.
 */
export interface TimelineConfig {
  /**
   * Epoch milliseconds of the moment placed at content x = 0 when the chart starts.
   *
   * The chart opens scrolled to the left edge of its content, so this is the earliest time the
   * first paint can show. Set it a little before the earliest task in your data to have the
   * project visible without scrolling. Omit it to start at the beginning of the current UTC day.
   *
   * Only the initial position is fixed here: from then on `TimelineService.setOrigin` moves the
   * axis, and horizontal scrolling is the renderer's. Zooming moves neither — it scrolls.
   */
  origin?: number;

  /**
   * Moves the origin earlier by itself when a task starts before it — after a bar is dragged left
   * past the start of the timeline, for instance, or when data is loaded that predates the chart's
   * opening date.
   *
   * Off by default, which leaves such a task at a negative horizontal position that no gesture can
   * scroll to; the chart reports that situation through its plugin-error event instead.
   *
   * Switch it on and the chart begins at whichever is earlier: this option's companion `origin`, or
   * the start of the UTC day the earliest task begins on. It follows the data both ways — an edit
   * reaching further back widens the chart at once, and one that no longer needs the room gives it
   * back shortly after the edit settles — but never past `origin`, so the range the chart was opened
   * with is a floor and repeated editing cannot walk the axis forward. The view is compensated
   * throughout, so nothing appears to jump.
   */
  autoExtendOrigin?: boolean;

  /**
   * Which zoom level the chart starts at, named by its `ZoomLevel.id` — `"day"`, `"week"`, … for
   * the built-in levels, or the id of a level some other plugin contributes.
   *
   * Omit it to start at the first registered level. An id that no registered level carries is
   * ignored silently and that first level is used, so naming a level belonging to a plugin the
   * composition happens not to include degrades to the default rather than failing.
   *
   * Only the starting level is fixed here; Ctrl+wheel and `setZoomLevel` move freely afterwards.
   * No anchor time is involved, so the chart opens at `origin` with no scroll of its own.
   */
  initialZoom?: string;

  /**
   * Replaces the built-in zoom levels.
   *
   * Omit it and the chart offers the built-in `"day"`, `"week"`, `"hour"`, `"month"`, `"quarter"`
   * and `"year"` levels, which is the default. Supply a non-empty array and those six are not
   * contributed at all: the chart offers these levels instead, in this order. Levels other plugins
   * contribute are unaffected either way, and `initialZoom` selects from the whole composed list.
   */
  zoomLevels?: ZoomLevel[];

  /**
   * The day the week starts on, as a weekday number: 0 = Sunday through 6 = Saturday.
   *
   * Defaults to 1 (Monday). It drives week-boundary computation only — where the week zoom level
   * and the header draw a week's start — and has no effect on how labels are worded or formatted,
   * which stays a property of the chart's locale. A value other than an integer 0 through 6 is
   * ignored and the default is used. Read once, when the chart starts.
   */
  firstDayOfWeek?: 0 | 1 | 2 | 3 | 4 | 5 | 6;

  /**
   * How the header's height is split between its two rows, as the top row's fraction of the
   * whole: a number greater than 0 and less than 1.
   *
   * Defaults to 0.5, an even split. A value outside that open range, or not a finite number, is
   * ignored and the default is used. Read once, when the chart starts. A zoom level whose header
   * has some row count other than two divides its height evenly regardless.
   */
  headerRowRatio?: number;

  /**
   * The inner padding between a header label and its cell edge, in CSS px.
   *
   * Defaults to 4. Must be a finite number of at least 0; anything else is ignored and the
   * default is used. Read once, when the chart starts.
   */
  headerLabelPadding?: number;

  /**
   * First month of the fiscal year, 1 (January) through 12 (December).
   *
   * With a value of 2..12, the built-in `month`, `quarter` and `year` zoom levels divide the
   * timeline into fiscal periods starting on that month: year cells run from that month to the
   * month before it in the next calendar year and are labelled with the year the period starts
   * in (an April-2026 fiscal year reads "2026"), and quarter cells start on that month and every
   * third month after it. The day-grained levels (`day`, `week`, `hour`) keep their calendar
   * month rows. Omitted, 1, or anything that is not an integer 1..12 means calendar years and
   * quarters, exactly as before. Read once, when the chart starts.
   */
  fiscalYearStartMonth?: number;

  /**
   * Produces custom text for header cells — a holiday name on a day cell, a sprint number on a
   * week cell.
   *
   * Called once per painted header cell with the cell's span, calendar granularity, row index
   * and the label the header would otherwise paint. Return a string to replace that label;
   * return `null` or `undefined` (or any non-string) to keep the default. Label fitting and
   * thinning are computed on the returned text, so an overlong replacement thins exactly as an
   * overlong built-in label would. If the function throws, the error is reported through the
   * chart's plugin-error event and the hook is not called again for the chart's lifetime — the
   * header falls back to its default labels rather than failing on every frame.
   */
  headerCellFormat?(cell: HeaderCell): string | null | undefined;

  /**
   * Calendar the built-in header labels (and `formatDate`) are worded in, as an Intl calendar
   * identifier — `"japanese"` for Japanese era (wareki) years such as Reiwa, `"buddhist"`,
   * `"iso8601"`, and so on.
   *
   * Omitted, labels use the locale's default calendar (Gregorian for most locales), exactly as
   * before. An identifier the platform does not recognize is ignored and the default is used.
   * The calendar changes wording only; boundary arithmetic stays on the Gregorian calendar, so
   * cells begin and end where they always did. Read once, when the chart starts.
   */
  calendar?: string;

  /**
   * IANA time zone the timeline is displayed in — `"Asia/Tokyo"`, `"America/New_York"`, and so
   * on.
   *
   * Task data stays in UTC epoch milliseconds; with a zone configured, the header's cell
   * boundaries and labels are converted to that zone's wall clock, so a "day" cell spans the
   * zone's local day (including daylight-saving shifts) and `unitBoundaries` reports the same
   * shifted instants. Omitted, `"UTC"`, or an identifier the platform does not recognize means
   * the previous UTC display, unchanged. Read once, when the chart starts.
   */
  displayTimeZone?: string;
}

/** Options for the background grid. */
export interface GridLinesConfig {
  /**
   * Which tiers of vertical time-boundary gridline are drawn. Defaults to `"major"`.
   *
   * `"major"` draws one line per coarse boundary — the boundary of the upper of the two header
   * rows the active zoom level shows — which is enough to read dates against without ruling every
   * column. Every built-in level below `"month"` has a month row up there, so at the day and week
   * zooms the major tier rules the months; a coarse tier of any other period needs a zoom level of
   * your own. `"both"` adds a line at every fine boundary as well (the pre-`"major"` behaviour, and
   * what `true` selects), and `"none"` draws no vertical lines at all (what `false` selects). Any
   * other value is ignored and the default is used. Read once at setup.
   */
  vertical?: boolean | "none" | "major" | "both";
  /**
   * Whether the horizontal row-separator lines are drawn. Defaults to `false`.
   *
   * The default is off because {@link GridLinesConfig.rowStripes} carries the same information
   * with less ink: a rule under every row reads as a mesh once the chart is more than a few rows
   * tall. Turn this on for a dense, spreadsheet-like grid — the two can also be combined.
   *
   * The lines follow the chart's row layout, so they render only in compositions that include a
   * row model (the standard preset's tree-grid provides one). A value that is not a boolean is
   * ignored and the default is used. Read once at setup.
   */
  horizontal?: boolean;
  /**
   * Whether alternating rows carry a faint background band. Defaults to `true`.
   *
   * The band is painted in the CSS custom property `--sg-row-stripe-bg` on every odd row, counting
   * from the top of the chart's own row order — so a row keeps its stripe as the chart scrolls,
   * and the chart pane's stripes line up with the grid pane's. It is the faintest of the row
   * backgrounds, so a hovered or selected row still reads on top of it.
   *
   * Needs a row model, like the horizontal lines do. A value that is not a boolean is ignored and
   * the default is used. Read once at setup.
   */
  rowStripes?: boolean;
  /**
   * Shades the non-working stretches of the timeline across the chart body. Defaults to on.
   *
   * With `true`, a built-in Saturday/Sunday weekend pattern (UTC, whole days) is shaded. Name a
   * calendar instead — `{ calendar: id }` — and the shaded ranges come from that stored
   * `CalendarDef`: its weekly pattern plus its exception days, re-read on every paint so an edit
   * to the calendar reaches the grid with no subscription. A calendar that declares intra-day
   * working windows is honored at that granularity with no further configuration: the gaps
   * before, between and after a working day's windows shade in the same fill as whole non-working
   * days. An id the data store does not hold falls back to the weekend pattern, silently.
   *
   * The object form refines both sides: `calendar` names the calendar to follow, and `weekend`
   * replaces the fallback weekday list (0 = Sunday … 6 = Saturday). The fill color is the CSS
   * custom property `--sg-grid-nonworking`. Bands narrower than a few pixels are not shaded — a
   * too-narrow sub-day gap is left out and the whole-day picture remains — so coarse zoom levels
   * stay clean. Any other value disables the option.
   */
  nonWorkingDays?: boolean | { calendar?: CalendarId; weekend?: readonly number[] };
  /**
   * Hatches the out-of-working-hours stretches of each working day with faint diagonals.
   * Defaults to off.
   *
   * It needs intra-day working windows, which only a calendar can declare — so it draws nothing
   * unless `nonWorkingDays.calendar` names a stored calendar that has them. The weekend fallback
   * declares none, so with no calendar named the hatch never appears. The hatched stretches are
   * exactly the sub-day non-working gaps the non-working shading also fills, so the hatch adds a
   * pattern on top of that tint rather than a second opinion about what is non-working, and both
   * disappear together once a band is too narrow to read. The stroke color is the CSS custom
   * property `--sg-grid-offhours`. A value that is not a boolean is ignored.
   */
  nonWorkingHours?: boolean;
  /**
   * Vertical highlight bands ("zones") for caller-chosen time spans — sprint windows, release
   * freezes, and the like. Defaults to none.
   *
   * Each entry spans `[start, end)` in epoch milliseconds and is filled behind the gridlines and
   * every task bar. `color` overrides the default fill (the CSS custom property
   * `--sg-grid-zone`) for that zone: a value starting with `--` is read as the name of a CSS
   * custom property through the theme service, so it follows the active theme and dark schemes
   * the same way `--sg-grid-zone` does, falling back to the default fill when the named property
   * is unset; any other value is a canvas color string used verbatim, unaudited for dark-scheme
   * contrast, and not painted at all while the browser reports forced colors active (Windows
   * High Contrast), so an arbitrary author color never covers the system palette. Configuring
   * such a verbatim color is what enables that forced-colors check — with no verbatim zone the
   * plugin never touches the media query — and while at least one verbatim zone exists the chart
   * repaints automatically when the forced-colors state changes. Entries whose
   * span is not a finite positive range are dropped. Read once at setup.
   */
  zones?: readonly { start: number; end: number; color?: string }[];
  /**
   * Fills the chart-body row under the mouse pointer with the same hover color the grid pane
   * uses (the CSS custom property `--sg-row-hover-bg`), so the eye can follow one task across
   * both panes. Defaults to off; it needs a row model to resolve rows, and draws nothing without
   * one. A value that is not a boolean is ignored.
   */
  rowHover?: boolean;
}

/**
 * Options for the today line.
 *
 * All fields are optional; with no config only the today line is drawn. Line colors come from CSS
 * custom properties (`--sg-today-line`, `--sg-status-line`), not from config options, following
 * the project convention that colors live in CSS.
 */
export interface TodayLineConfig {
  /**
   * When set, additionally draws a dashed vertical status-date line at this instant — the
   * reference date against which progress is evaluated, which need not be "today".
   *
   * Accepts epoch milliseconds, a `Date`, or a date string parseable by `Date.parse` (a
   * date-only ISO string such as `"2026-03-01"` resolves to UTC midnight of that day). The
   * instant is used as given — it is not snapped to a day boundary. Unusable values (non-finite
   * numbers, invalid dates, unparseable strings) are silently ignored and no status line is
   * drawn. The value is fixed when the factory is called; changing the status date means
   * recreating the chart with a new config.
   *
   * The line is 1 CSS px wide, dashed (so it is distinguishable from the solid today line even
   * without color), and colored by the CSS custom property `--sg-status-line` (falling back to a
   * blue `#2f6fd6` when the property is unset).
   */
  statusDate?: StatusDateInput;
}

/**
 * Options for the `view` plugin: the canvas surface, the pane row, the theme, the timeline and
 * the two background line passes, nested one group per former plugin.
 */
export interface ViewConfig {
  /** Wheel speed and the synthetic scrollbars. */
  scroll?: ScrollConfig;
  /**
   * The chart's base text direction. `"rtl"` marks the chart pane `dir="rtl"`, sets the canvas
   * contexts' text direction to right-to-left, and is reported to every plugin through
   * `ViewService.direction()` so the composition mirrors consistently. Defaults to `"ltr"`;
   * any other value is ignored.
   */
  direction?: "ltr" | "rtl";
  /**
   * Enables progressive rendering: frames painted while the chart is actively scrolling carry
   * `Viewport.detail === "coarse"` so layer contributions may skip expensive detail, and a short
   * quiet period after the last scroll triggers one full repaint with `detail === "fine"`.
   * Defaults to `false`, in which case `Viewport.detail` is never set and nothing changes.
   */
  progressive?: boolean;
  /**
   * Enables dirty-region repaints: a layer invalidated only through rectangles repaints just the
   * union of those rectangles instead of the full viewport. Defaults to `false`; rectangles passed
   * to `invalidate` are then ignored and every repaint stays full, which is the historical
   * behavior.
   */
  dirtyRegions?: boolean;
  /**
   * Enables scroll prediction and off-screen prefetch: recent scroll velocity is extrapolated
   * into the viewport about to become visible (`ViewService.predictedViewport()`), and after
   * each painted scroll frame the renderer runs a warm off-screen composite over that predicted
   * viewport so contribution-side caches are populated before the region scrolls in. Defaults to
   * `false`.
   */
  prefetch?: boolean;
  /** The pane row's own options. */
  panes?: PanesConfig;
  /** Theme presets, the colour-scheme pin, forced colors and the setup diagnostics. */
  theme?: ThemeConfig;
  /** The time axis: origin, zoom ladder, header layout, display calendar and zone. */
  timeline?: TimelineConfig;
  /** The background grid: lines, stripes, shading, zones and the hovered-row fill. */
  gridLines?: GridLinesConfig;
  /**
   * The today line and its optional dashed status line. `false` switches the whole pass off — the
   * replacement for simply leaving the plugin out of the composition.
   */
  todayLine?: TodayLineConfig | false;
}

/* ------------------------------------------------------------------ *
 * Normalization
 * ------------------------------------------------------------------ */

/** The already-validated options the plugin's modules are built from. */
export interface ViewOptions {
  render: RenderOptions;
  panes: PanesConfig;
  theme: ThemeConfig;
  timeline: TimelineConfig;
  gridLines: GridLinesOptions;
  /** `undefined` when `todayLine: false` switched the pass off entirely. */
  todayLine: { statusDateMs: number | undefined } | undefined;
}

/** `true` unless a boolean says otherwise; anything that is not a boolean keeps `fallback`. */
function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

// docs/specs/plugins/view.md — which tiers of vertical line are drawn. `"major"` is the default:
// one line per coarse boundary (the upper header row's period — a month at the built-in day and
// week zooms) instead of one per fine column, which turned the body into a mesh.
function normalizeVertical(value: unknown): GridLinesOptions["vertical"] {
  if (value === false) return "none";
  if (value === true) return "both";
  return value === "both" || value === "major" || value === "none" ? value : "major";
}

/**
 * Reads the configuration once and answers with the options every module is built from.
 *
 * Unusable values are dropped here rather than at their point of use, so no module ever has to
 * defend against them: the whole "silently fall back" rule lives in this one function.
 */
export function normalizeViewConfig(config?: ViewConfig): ViewOptions {
  const wheel = config?.scroll?.wheelSpeedFactor;
  const todayLine = config?.todayLine;
  return {
    render: {
      wheelSpeedFactor:
        typeof wheel === "number" && Number.isFinite(wheel) && wheel > 0 ? wheel : 1,
      // On by default; only an explicit `false` suppresses the scrollbars.
      scrollbarEnabled: config?.scroll?.scrollbar !== false,
      // Only the literal "rtl" flips direction; anything else is the LTR default.
      direction: config?.direction === "rtl" ? "rtl" : "ltr",
      progressive: config?.progressive === true,
      dirtyRegions: config?.dirtyRegions === true,
      prefetch: config?.prefetch === true,
    },
    // The two module configs whose own normalization happens where they are read: both are
    // snapshotted here so a later mutation of the caller's object cannot change behaviour.
    panes: { ...config?.panes },
    theme: { ...config?.theme },
    timeline: { ...config?.timeline },
    gridLines: {
      vertical: normalizeVertical(config?.gridLines?.vertical),
      horizontal: flag(config?.gridLines?.horizontal, false),
      rowStripes: flag(config?.gridLines?.rowStripes, true),
      nonWorkingDays: normalizeNonWorkingDays(config?.gridLines?.nonWorkingDays ?? true),
      nonWorkingHours: config?.gridLines?.nonWorkingHours === true,
      zones: normalizeZones(config?.gridLines?.zones),
      rowHover: config?.gridLines?.rowHover === true,
    },
    // The status date is resolved (and thereby snapshotted) here, so a later mutation of the
    // caller's config object or `Date` cannot change what is drawn; an unusable value resolves to
    // `undefined`, which simply leaves the status line out.
    todayLine:
      todayLine === false ? undefined : { statusDateMs: resolveStatusDate(todayLine?.statusDate) },
  };
}
