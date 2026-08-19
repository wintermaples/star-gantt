// docs/specs/plugins/view.md — hostless helpers for the opt-in
// background shading passes (non-working days, off-hours hatch, zones, row hover). Pure functions
// only: no host, no canvas, no services, so every rule is unit-testable in isolation.
import { MS_DAY, startOfUtcDay } from "@stargantt/sdk";
// The band type is the SDK's own `TimeRange` — the shape `nonWorkingIntervals` returns — rather
// than a hand-copied local twin: one working-time vocabulary, no per-plugin forks.
import type { TimeRange } from "@stargantt/sdk";

/* ------------------------------------------------------------------ *
 * Config normalization (unusable values silently ignored)
 * ------------------------------------------------------------------ */

/** Normalized `nonWorkingDays` option: which calendar (if any) and the weekend fallback. */
export interface NonWorkingDaysOption {
  /** Calendar id to shade; `undefined` selects the built-in weekend fallback. */
  calendar: string | number | undefined;
  /** Weekend fallback weekdays (0 = Sunday … 6 = Saturday, UTC), deduplicated, ascending. */
  weekend: readonly number[];
}

const DEFAULT_WEEKEND: readonly number[] = [0, 6];

function isCalendarId(v: unknown): v is string | number {
  return typeof v === "string" || typeof v === "number";
}

/** Keeps the integers 0–6, deduplicated and sorted; anything else is dropped. */
function normalizeWeekend(v: unknown): readonly number[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const days = new Set<number>();
  for (const d of v) {
    if (typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6) days.add(d);
  }
  return [...days].sort((a, b) => a - b);
}

// docs/specs/plugins/view.md — `true` means "shade the default
// calendar, weekend fallback Sat/Sun"; an object refines either; anything else disables the pass.
export function normalizeNonWorkingDays(v: unknown): NonWorkingDaysOption | undefined {
  if (v === true) return { calendar: undefined, weekend: DEFAULT_WEEKEND };
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const o = v as { calendar?: unknown; weekend?: unknown };
  return {
    calendar: isCalendarId(o.calendar) ? o.calendar : undefined,
    weekend: normalizeWeekend(o.weekend) ?? DEFAULT_WEEKEND,
  };
}

/** One normalized highlight zone. */
export interface Zone {
  start: number;
  end: number;
  /** Canvas color override; `undefined` means "use the zone token". */
  color: string | undefined;
}

// docs/specs/plugins/view.md — entries whose span is not a finite,
// positive-length range are dropped one by one; a non-array input yields no zones at all.
export function normalizeZones(v: unknown): readonly Zone[] {
  if (!Array.isArray(v)) return [];
  const out: Zone[] = [];
  for (const entry of v) {
    if (typeof entry !== "object" || entry === null) continue;
    const { start, end, color } = entry as { start?: unknown; end?: unknown; color?: unknown };
    if (typeof start !== "number" || !Number.isFinite(start)) continue;
    if (typeof end !== "number" || !Number.isFinite(end)) continue;
    if (end <= start) continue;
    out.push({
      start,
      end,
      color: typeof color === "string" && color !== "" ? color : undefined,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Calendar-free weekend arithmetic
 * ------------------------------------------------------------------ */

/** The UTC weekday (0 = Sunday … 6 = Saturday) of an instant. Allocation-free. */
export function utcWeekday(t: number): number {
  // Epoch day 0 (1970-01-01) was a Thursday (= 4); floor handles pre-epoch instants.
  return (((Math.floor(t / MS_DAY) + 4) % 7) + 7) % 7;
}

/**
 * The weekend day-spans among consecutive day boundaries, adjacent days merged.
 *
 * `dayBounds` is an ascending list of UTC-midnight instants (as `unitBoundaries("day", …)`
 * returns them, possibly missing the first/last partial day of the queried window); each
 * consecutive pair is one day column. `weekend` holds the non-working weekdays.
 */
export function weekendSpans(
  dayBounds: readonly number[],
  weekend: readonly number[],
): readonly TimeRange[] {
  if (weekend.length === 0 || dayBounds.length === 0) return [];
  const set = new Set(weekend);
  const out: TimeRange[] = [];
  // Extends one day before the first boundary, so a weekend day only partially inside the
  // enumerated window at its *start* is still shaded across the visible part. Deliberately
  // one-sided: no synthetic day is appended past the last boundary, and existing tests pin the
  // leading-only behavior.
  const first = dayBounds[0];
  const start = first === undefined ? 0 : first - MS_DAY;
  for (let i = -1; i < dayBounds.length; i += 1) {
    const dayStart = i < 0 ? start : (dayBounds[i] as number);
    if (!set.has(utcWeekday(dayStart))) continue;
    const dayEnd = dayStart + MS_DAY;
    const last = out[out.length - 1];
    if (last !== undefined && last.end === dayStart) last.end = dayEnd;
    else out.push({ start: dayStart, end: dayEnd });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The minimum-band-width guard (§4.1)
 * ------------------------------------------------------------------ */

// docs/specs/plugins/view.md — the one legibility rule both shading
// passes obey, and the same threshold and constant the calendars plugin's own shading uses. There
// is deliberately no second threshold for sub-day bands: below it the picture degrades to exactly
// the day-granular shading rather than smearing sub-pixel slivers across the body.
/** Minimum on-screen width, in CSS px, of a band the shading passes will paint. */
export const MIN_BAND_PX = 3;

/**
 * Whether a band counts as **whole-day** for the guard.
 *
 * A band is whole-day when each of its ends falls on a UTC midnight — or on the queried window's
 * own bound, the clipped-edge exemption. The working-time engine clips the first and last band of
 * a listing to the query (docs/specs/plugins/view.md), so a partially visible
 * non-working day arrives without its midnight alignment through clipping alone; without the
 * exemption the guard would suppress the viewport-edge sliver that the day-granular picture drew.
 * Only genuinely intra-day bands can therefore be suppressed.
 */
export function isWholeDayBand(
  band: Readonly<TimeRange>,
  queryFrom: number,
  queryTo: number,
): boolean {
  // `startOfUtcDay` rather than `% MS_DAY`, so a pre-1970 instant is classified correctly.
  const startAligned = startOfUtcDay(band.start) === band.start || band.start === queryFrom;
  const endAligned = startOfUtcDay(band.end) === band.end || band.end === queryTo;
  return startAligned && endAligned;
}

/**
 * Whether a band lies inside one UTC day — both ends within, or on the boundaries of, the day its
 * start falls in.
 *
 * This is what makes a band *off-hours* rather than non-working time in general: the gap before,
 * between or after one day's working windows. Not being whole-day-aligned is deliberately not
 * enough, because the working-time engine merges adjacent non-working ranges: a calendar with
 * intra-day windows yields a single band running from Friday's last working instant across the
 * weekend to Monday's first, which is unaligned yet is mostly whole non-working days.
 */
export function isWithinOneUtcDay(band: Readonly<TimeRange>): boolean {
  // `startOfUtcDay` rather than `% MS_DAY`, so a pre-1970 instant is classified correctly.
  return band.end <= startOfUtcDay(band.start) + MS_DAY;
}

/**
 * Whether the guard admits a band for the solid non-working shading.
 *
 * Whole-day bands always pass (the pass-level day-width gate has already run); an intra-day band
 * passes only while it is at least {@link MIN_BAND_PX} wide on screen. A band that fails is
 * **omitted entirely** — never widened to a minimum width, never merged into a neighbour.
 */
export function bandIsLegible(
  band: Readonly<TimeRange>,
  queryFrom: number,
  queryTo: number,
  pxPerMs: number,
): boolean {
  if (isWholeDayBand(band, queryFrom, queryTo)) return true;
  return pxPerMs * (band.end - band.start) >= MIN_BAND_PX;
}

/* ------------------------------------------------------------------ *
 * Hover row resolution
 * ------------------------------------------------------------------ */

/** The subset of the row model the hover resolver reads. */
export interface RowGeometry {
  rowCount(): number;
  rowAtY(y: number): number;
  yOf(row: number): number;
  rowHeight(row: number): number;
}

/**
 * The row index under a content-space y, or `undefined` when the y falls outside every row.
 *
 * `rowAtY` implementations clamp out-of-range queries to the nearest row, so the answer is
 * verified against the row's actual span before it is accepted.
 */
export function rowAt(rows: RowGeometry, contentY: number): number | undefined {
  const count = rows.rowCount();
  if (count <= 0 || contentY < 0) return undefined;
  const row = rows.rowAtY(contentY);
  if (!Number.isInteger(row) || row < 0 || row >= count) return undefined;
  const top = rows.yOf(row);
  if (contentY < top || contentY >= top + rows.rowHeight(row)) return undefined;
  return row;
}
