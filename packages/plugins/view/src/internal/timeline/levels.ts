/**
 * The zoom levels this plugin contributes to its own `timeline/zoomLevels` point.
 *
 * Six levels ship by default — `"day"`, `"week"`, `"hour"`, `"month"`, `"quarter"` and `"year"` —
 * each a two-row header with the coarser unit on top. Further levels are added by contributing to
 * `timeline/zoomLevels`, which is the mechanism provided for exactly that.
 */
import type { ScaleRow, ZoomLevel } from "./index";
import { advance } from "./scale";

/**
 * How the built-in levels format and divide the calendar; every field optional, absent means the
 * pre-existing behavior (UTC display, Gregorian labels, calendar-year periods).
 */
export interface BuiltInLevelOptions {
  // docs/specs/plugins/view.md — display time zone.
  /** IANA zone labels and boundaries are converted to; absent means UTC. */
  timeZone?: string;
  // docs/specs/plugins/view.md — e.g. "japanese" for wareki.
  /** Intl calendar identifier the built-in labels are worded in; absent means the locale's default. */
  calendar?: string;
  // docs/specs/plugins/view.md — fiscal-year periods.
  /** First month of the fiscal year, 2..12; absent means calendar years and quarters. */
  fiscalYearStartMonth?: number;
}

// docs/specs/plugins/view.md — an unusable `calendar` degrades
// to the locale's default calendar silently rule 3.
/**
 * The configured display calendar, normalized: an identifier `Intl.DateTimeFormat` accepts comes
 * back verbatim; a non-string or an identifier the platform rejects comes back `undefined`,
 * meaning "the locale's default calendar".
 */
export function normalizeCalendar(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  try {
    new Intl.DateTimeFormat("en", { calendar: value });
  } catch {
    return undefined;
  }
  return value;
}

// docs/specs/plugins/view.md — 1 equals the calendar-year
// default, so only 2..12 turns fiscal periods on; anything unusable degrades silently.
/**
 * The configured fiscal start month, normalized: an integer 2..12 comes back verbatim; 1 (a
 * January fiscal year is a calendar year) and every unusable value come back `undefined`,
 * meaning calendar years and quarters.
 */
export function normalizeFiscalStartMonth(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 2 && value <= 12
    ? value
    : undefined;
}

/**
 * `Intl.DateTimeFormat` construction is the expensive part of formatting; the header re-formats
 * every visible boundary on every paint, so the formatters are memoised per locale + option set.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(
  locale: string,
  key: string,
  options: Intl.DateTimeFormatOptions,
  o: BuiltInLevelOptions,
): Intl.DateTimeFormat {
  const id = `${locale} ${key} ${o.timeZone ?? "UTC"} ${o.calendar ?? ""}`;
  let f = formatters.get(id);
  if (f === undefined) {
    f = new Intl.DateTimeFormat(locale, {
      ...options,
      timeZone: o.timeZone ?? "UTC",
      ...(o.calendar === undefined ? {} : { calendar: o.calendar }),
    });
    formatters.set(id, f);
  }
  return f;
}

// docs/specs/plugins/view.md — the service's `formatDate`
// member shares this memo, so a consumer (a tooltip, a side panel) that formats an instant
// through the service words it exactly as the header would.
/**
 * Formats one instant with the chart's locale, display time zone and calendar, memoising the
 * underlying `Intl.DateTimeFormat` per option set. `options` defaults to a plain year-month-day
 * date.
 */
export function formatInstant(
  locale: string,
  o: BuiltInLevelOptions,
  t: number,
  options?: Intl.DateTimeFormatOptions,
): string {
  const resolved = options ?? { year: "numeric", month: "short", day: "numeric" };
  return formatter(locale, `svc:${JSON.stringify(resolved)}`, resolved, o).format(t);
}

const monthRow = (o: BuiltInLevelOptions): ScaleRow => ({
  unit: "month",
  format: (t, locale) => formatter(locale, "ym", { year: "numeric", month: "long" }, o).format(t),
});

const dayRow = (o: BuiltInLevelOptions): ScaleRow => ({
  unit: "day",
  format: (t, locale) => formatter(locale, "d", { day: "numeric" }, o).format(t),
});

const weekRow = (o: BuiltInLevelOptions): ScaleRow => ({
  unit: "week",
  format: (t, locale) =>
    formatter(locale, "md", { month: "numeric", day: "numeric" }, o).format(t),
});

// docs/specs/plugins/view.md — the rows the four coarser levels are built from.

/** Full calendar date; the coarse row of the `hour` level. */
const dateRow = (o: BuiltInLevelOptions): ScaleRow => ({
  unit: "day",
  format: (t, locale) =>
    formatter(locale, "ymd", { year: "numeric", month: "long", day: "numeric" }, o).format(t),
});

const hourRow = (o: BuiltInLevelOptions): ScaleRow => ({
  unit: "hour",
  format: (t, locale) => formatter(locale, "h", { hour: "numeric" }, o).format(t),
});

// docs/specs/plugins/view.md — a cell that spans several
// years is labelled with the range it covers, not with its first year alone: the `year` level's
// coarse row steps ten years, and a cell covering 2020 through 2029 reading "2020" is
// indistinguishable from a bug.
/** En dash, the typographic separator for a numeric range. */
const RANGE_DASH = "–";

/**
 * `first`, or `first`–`last` when the two differ.
 *
 * Both bounds go through the *same* `Intl` year formatter, so the chart's `calendar`,
 * `displayTimeZone` and locale keep applying and no message catalog is needed — the string is
 * still nothing but formatter output. Equal bounds collapse to one label, which is what keeps a
 * single-year row (and any calendar in which both bounds word identically) unchanged.
 */
function yearSpanLabel(first: string, last: string): string {
  return first === last ? first : `${first}${RANGE_DASH}${last}`;
}

/**
 * A year row. `step` is the number of years one cell spans; a cell spanning more than one is
 * labelled with the first and last year it covers.
 */
const yearRow = (o: BuiltInLevelOptions, step?: number): ScaleRow => ({
  unit: "year",
  ...(step === undefined ? {} : { step }),
  format: (t, locale) => {
    const f = formatter(locale, "y", { year: "numeric" }, o);
    if (step === undefined || step <= 1) return f.format(t);
    // The last year the cell covers, not the next cell's first: a decade cell starting in 2020
    // ends in 2029. `advance` runs the same calendar arithmetic the row's boundaries do, display
    // time zone included, so the two can never disagree about which years the cell holds.
    return yearSpanLabel(f.format(t), f.format(advance(t, "year", step - 1, o.timeZone)));
  },
});

/** Abbreviated month name; used both as the `month` level's fine row and as a quarter marker. */
const monthShortRow = (o: BuiltInLevelOptions, step?: number, stepOffset?: number): ScaleRow => ({
  unit: "month",
  ...(step === undefined ? {} : { step }),
  ...(stepOffset === undefined ? {} : { stepOffset }),
  format: (t, locale) => formatter(locale, "M", { month: "short" }, o).format(t),
});

// docs/specs/plugins/view.md — a fiscal year is a `step`-month
// row anchored on the fiscal start month; its label is the year the period starts in, so an April
// 2026 boundary reads "2026" (fiscal year 2026), in whatever calendar the labels use.
// A cell spanning several fiscal years (the `year` level's ten-fiscal-year coarse row) is labelled
// with the range of fiscal years it covers — §1.15, the same rule the calendar `yearRow` follows.
const fiscalYearRow = (o: BuiltInLevelOptions, months: number, startMonth: number): ScaleRow => ({
  unit: "month",
  step: months,
  stepOffset: startMonth - 1,
  format: (t, locale) => {
    const f = formatter(locale, "y", { year: "numeric" }, o);
    if (months <= 12) return f.format(t);
    // The *last fiscal year* the cell covers, i.e. the start of the final 12-month period inside
    // it: a ten-fiscal-year cell starting in April 2020 covers FY2020 through FY2029, so its right
    // bound is April 2029 — not the March 2030 the period ends on, which would read "2030".
    return yearSpanLabel(f.format(t), f.format(advance(t, "month", months - 12, o.timeZone)));
  },
});

/**
 * Fresh objects per call: each plugin instance contributes its own, so a consumer mutating a
 * level it read back from `zoomLevel()` cannot reach another instance's state.
 */
export function defaultZoomLevels(options: BuiltInLevelOptions = {}): ZoomLevel[] {
  // docs/specs/plugins/view.md — six built-in levels, contributed in this order.
  // `day` and `week` stay first so an omitted `initialZoom` still resolves to `day` and the
  // committed screenshot baselines are untouched. Contribution order is not zoom order: the
  // Ctrl+wheel gesture sorts by `pxPerDay`, which is strictly decreasing across
  // hour > day > week > month > quarter > year.
  const o = options;
  const fiscal = o.fiscalYearStartMonth;
  // docs/specs/plugins/view.md — fiscal periods reshape only the
  // year-and-quarter rows of the `month` / `quarter` / `year` levels; the day-grained levels keep
  // their calendar-month top rows.
  const year = (): ScaleRow => (fiscal === undefined ? yearRow(o) : fiscalYearRow(o, 12, fiscal));
  const quarterFine = (): ScaleRow =>
    fiscal === undefined ? monthShortRow(o, 3) : monthShortRow(o, 3, (fiscal - 1) % 3);
  const yearCoarse = (): ScaleRow =>
    fiscal === undefined ? yearRow(o, 10) : fiscalYearRow(o, 120, fiscal);
  return [
    { id: "day", pxPerDay: 40, scales: [monthRow(o), dayRow(o)] },
    { id: "week", pxPerDay: 12, scales: [monthRow(o), weekRow(o)] },
    { id: "hour", pxPerDay: 480, scales: [dateRow(o), hourRow(o)] },
    { id: "month", pxPerDay: 4, scales: [year(), monthShortRow(o)] },
    { id: "quarter", pxPerDay: 1.6, scales: [year(), quarterFine()] },
    { id: "year", pxPerDay: 0.5, scales: [yearCoarse(), year()] },
  ];
}
