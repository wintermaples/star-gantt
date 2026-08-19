// docs/specs/plugins/scheduling.md §3.2 / §6.2
/**
 * The order-8 non-working shading layer: the full-viewport-height background band over the shade
 * calendar's non-working time, and the minimum-band-width guard restated normatively in §6.2
 * (the grid-lines contract stated it previously; view.md does not carry it, so §6.2 is its home).
 *
 * Pure and hostless: `createShadingLayer` takes plain callbacks, never a `PluginContext`, so it is
 * unit-testable with recording doubles standing in for the timeline/theme services (`TimelineReader`
 * / `ThemeReader`, narrow `Pick`s over the real `@stargantt/plugin-view` service types below).
 * `wireCalendars` is the only caller that supplies the real (or `useOptional`-absent) services.
 */
import { nonWorkingIntervals } from "@stargantt/sdk";
import type { TimeRange } from "@stargantt/sdk";
import type { CalendarDef, CalendarId } from "@stargantt/plugin-data-store";
import type { LayerContribution, ThemeService, TimelineService, Viewport } from "@stargantt/plugin-view";

/**
 * The narrow read this pass makes of `stargantt.timeline` — a `Pick` over the real service type
 * (not a hand-kept mirror), so a unit test double satisfies it with a plain object literal while
 * staying in sync with `@stargantt/plugin-view`'s actual shape automatically.
 */
type TimelineReader = Pick<TimelineService, "pxPerMs" | "tToX" | "xToT">;

/** The narrow read this pass makes of `stargantt.theme` — the one token lookup it calls. */
type ThemeReader = Pick<ThemeService, "get">;

/** calendars zIndex 8 — under view's grid-lines (10) and every figure element (§3.2). */
export const SHADING_LAYER_ORDER = 8;
/** This plugin's `renderer/layers` claim key for the shading pass (§3.2). */
export const SHADING_LAYER_KEY = "stargantt.scheduling:shading";

const MS_DAY = 86_400_000;

/** Ground color: token first, then the translucent-red fallback (§6.2). */
const TOKEN_SHADE = "--sg-calendar-nonworking";
const FALLBACK_SHADE = "rgba(220, 38, 38, 0.08)";

/**
 * The minimum-band-width guard's one threshold, in CSS px: below it a day column draws nothing at
 * all (gate 1), and a sub-day band narrower than it is omitted rather than widened or merged
 * (gate 2). Whole-day-aligned bands are exempt from gate 2 (gate 4) — only gate 1 can suppress them.
 */
const MIN_BAND_PX = 3;

/** What the shading pass needs to resolve the shade calendar and paint it. */
export interface ShadingDeps {
  /** `calendars.shadeCalendar` when configured, else the registry default (§6.2). */
  shadeCalendarId(): CalendarId | undefined;
  /** Resolves a calendar id — registry first, then the data store (§1.2 `resolve`). */
  resolve(id: CalendarId): Readonly<CalendarDef> | undefined;
  /** Late, non-latched lookup — `undefined` while no `stargantt.timeline` is composed/declared. */
  timeline(): TimelineReader | undefined;
  /** Late, non-latched lookup — `undefined` while no `stargantt.theme` is composed/declared. */
  theme(): ThemeReader | undefined;
}

/**
 * A band's start/end each qualify as whole-day-aligned by falling on a UTC midnight — a positive
 * modulo against `MS_DAY`, so pre-1970 instants classify correctly — or by equaling the query's own
 * `from`/`to` (the clipped-edge exemption: the engine clips edge bands to the query, so a partially
 * visible non-working day loses its midnight alignment through clipping alone). A band counts as
 * whole-day exactly when BOTH ends qualify (§6.2 rule 3).
 */
function isWholeDayAligned(range: TimeRange, from: number, to: number): boolean {
  const startAligned = (((range.start % MS_DAY) + MS_DAY) % MS_DAY === 0) || range.start === from;
  const endAligned = (((range.end % MS_DAY) + MS_DAY) % MS_DAY === 0) || range.end === to;
  return startAligned && endAligned;
}

/**
 * Builds the shading layer contribution. One range buffer is reused across paints (§6.1 "the
 * engine's `out` parameter"), so the pass allocates nothing else per frame.
 */
export function createShadingLayer(deps: ShadingDeps): LayerContribution {
  const buffer: TimeRange[] = [];

  function draw(g: CanvasRenderingContext2D, vp: Readonly<Viewport>): void {
    const id = deps.shadeCalendarId();
    if (id === undefined) return;
    const cal = deps.resolve(id);
    if (cal === undefined) return;
    const timeline = deps.timeline();
    if (timeline === undefined) return;

    // Gate 1 (§6.2 rule 1): below this day-column width the whole pass draws nothing.
    const pxPerDay = timeline.pxPerMs * MS_DAY;
    if (!(pxPerDay >= MIN_BAND_PX)) return;

    const from = timeline.xToT(vp.scrollLeft);
    const to = timeline.xToT(vp.scrollLeft + vp.width);
    const theme = deps.theme();

    g.save();
    g.fillStyle = (theme?.get(TOKEN_SHADE) ?? "") || FALLBACK_SHADE;
    buffer.length = 0;
    for (const range of nonWorkingIntervals(cal, from, to, buffer)) {
      const wholeDay = isWholeDayAligned(range, from, to);
      // Gate 2 (§6.2 rule 2), exempted for whole-day bands (§6.2 rule 4): a sub-day band under the
      // threshold is skipped entirely — never widened, never merged into a neighbour.
      if (!wholeDay && !(timeline.pxPerMs * (range.end - range.start) >= MIN_BAND_PX)) continue;
      const x1 = Math.max(0, timeline.tToX(range.start) - vp.scrollLeft);
      const x2 = Math.min(vp.width, timeline.tToX(range.end) - vp.scrollLeft);
      if (x2 <= x1) continue;
      g.fillRect(x1, 0, x2 - x1, vp.height);
    }
    g.restore();
  }

  return { id: SHADING_LAYER_KEY, zIndex: SHADING_LAYER_ORDER, draw };
}
