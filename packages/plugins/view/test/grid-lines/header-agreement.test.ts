/**
 * The body grid and the chart header must break on the same instants.
 *
 * The plugin used to carry its own copy of
 * timeline-scale's calendar arithmetic, so a divergence between the two (the copy normalized week
 * boundaries slightly differently) could not be caught by either package's own unit tests. The copy
 * is gone and both sides now read `TimelineService.unitBoundaries`, and this suite pins that: one
 * real `Gantt.create()` with the real header beside the real grid, one painted frame, and the two
 * sets of vertical lines compared position by position.
 */
import { afterEach, describe, expect, it } from "vitest";
import { boot, lines, verticalXs } from "./_boot";
import type { Booted, Line } from "./_boot";

/** Fallback grid colors (light values). */
const MINOR = "#f5f4f1";
const MAJOR = "#e7e5e4";

let live: Booted | undefined;

afterEach(() => {
  live?.dispose();
  live = undefined;
});

/** Half-pixel alignment, the rule §3.1 fixes for a crisp 1 px stroke. */
function align(v: number): number {
  return Math.round(v) + 0.5;
}

/**
 * The header's own tick positions, split into its coarse (top) and fine (bottom) row and reduced to
 * the ones that would land inside the body viewport once half-pixel aligned — exactly the culling
 * §3.2 applies to the grid.
 */
function headerTicks(b: Booted, viewportWidth: number): { coarse: number[]; fine: number[] } {
  const verticals = lines(b.header).filter((l: Line) => l.x1 === l.x2);
  // The header's two rows are stacked, so a line's y range identifies its row: the coarse row is
  // the one that starts at the canvas's top edge.
  const coarseRow = verticals.filter((l) => l.y1 === 0);
  const fineRow = verticals.filter((l) => l.y1 !== 0);
  const visible = (ls: Line[]): number[] =>
    ls.map((l) => align(l.x1)).filter((x) => x >= 0 && x < viewportWidth);
  return { coarse: visible(coarseRow), fine: visible(fineRow) };
}

/** Boots the stack at one zoom level, paints once, and returns the viewport the body drew into. */
function paintAt(level: string, scrollLeft = 0): { b: Booted; width: number } {
  const b = boot({ vertical: "both", horizontal: false, rowStripes: false, nonWorkingDays: false });
  live = b;
  b.scale.setZoomLevel(level);
  if (scrollLeft !== 0) {
    const renderer = b.gantt.service("stargantt.view");
    renderer.scrollTo({ scrollLeft });
  }
  b.paint();
  const width = b.gantt.service("stargantt.view").viewport.get().width;
  expect(width).toBeGreaterThan(0);
  return { b, width };
}

describe("grid lines agree with the header's ticks", () => {
  for (const level of ["day", "week", "month"] as const) {
    it(`places a minor line on every fine-row boundary at the ${level} zoom level`, () => {
      const { b, width } = paintAt(level);
      const ticks = headerTicks(b, width);
      expect(ticks.fine.length).toBeGreaterThan(0);
      expect(verticalXs(b.background, MINOR)).toEqual(ticks.fine);
    });

    it(`places a major line on every coarse-row boundary at the ${level} zoom level`, () => {
      const { b, width } = paintAt(level);
      const ticks = headerTicks(b, width);
      expect(verticalXs(b.background, MAJOR)).toEqual(ticks.coarse);
    });
  }

  // A fiscal year reshapes the year level's rows into stepped month rows anchored on
  // `stepOffset`. The header paints on the shifted boundaries, so the body grid has to enumerate
  // with the same offset; dropping it drew January lines under an April header (and put an
  // inserted task's edges mid-cell).
  it("follows a fine row's stepOffset — an April-start fiscal year", () => {
    const b = boot(
      { vertical: "both", horizontal: false, rowStripes: false, nonWorkingDays: false },
      {},
      1,
      [],
      { fiscalYearStartMonth: 4 },
    );
    live = b;
    b.scale.setZoomLevel("year");
    b.paint();
    const width = b.gantt.service("stargantt.view").viewport.get().width;
    const ticks = headerTicks(b, width);
    expect(ticks.fine.length).toBeGreaterThan(0);
    expect(verticalXs(b.background, MINOR)).toEqual(ticks.fine);
    expect(verticalXs(b.background, MAJOR)).toEqual(ticks.coarse);
  });

  it("still agrees after a horizontal scroll", () => {
    const { b, width } = paintAt("day", 137);
    const ticks = headerTicks(b, width);
    expect(ticks.fine.length).toBeGreaterThan(0);
    expect(verticalXs(b.background, MINOR)).toEqual(ticks.fine);
    expect(verticalXs(b.background, MAJOR)).toEqual(ticks.coarse);
  });

  it("keeps a boundary that lands exactly on the viewport's left edge", () => {
    // Content x = 0 is the epoch, which is a day, week and month boundary at once, so an unscrolled
    // day level must show a line at x 0.5. This is the *inclusive* lower bound of the enumeration,
    // not the from-edge widening — the boundary sits exactly at `from`; the widening is covered by
    // the fractional-scroll case below.
    const { b } = paintAt("day");
    expect(verticalXs(b.background, MINOR)).toContain(0.5);
  });

  // The from-edge widening (`1 / pxPerMs`)
  // exists for exactly this case, which no integer scroll can produce: a boundary that has already
  // passed the viewport's left edge, so `unitBoundaries`' inclusive lower bound drops it, yet whose
  // half-pixel-aligned line still lands *inside* the canvas and must therefore be drawn.
  it("keeps a boundary just past the left edge, whose aligned line is still on-canvas", () => {
    // The day level is 40 px/day with the origin at the epoch, so day boundaries sit at content
    // x = 40k. Scrolling by 40.3 px puts the day-1 boundary at viewport x = -0.3, which
    // `Math.round(-0.3) + 0.5` places at 0.5 — the leftmost drawable pixel column.
    const { b, width } = paintAt("day", 40.3);
    expect(b.gantt.service("stargantt.view").viewport.get().scrollLeft).toBe(40.3);
    const minor = verticalXs(b.background, MINOR);
    expect(minor).toContain(0.5);
    // And the header, which always reports its leading boundary, agrees line for line.
    expect(minor).toEqual(headerTicks(b, width).fine);
  });
});
