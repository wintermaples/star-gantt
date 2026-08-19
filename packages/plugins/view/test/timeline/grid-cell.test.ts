/**
 * `gridCellAt` — the chart's unit of time.
 *
 * the member answers the half-open span of the cell
 * the *fine* scale row (the level's last row) draws around an instant, using the same calendar
 * arithmetic `unitBoundaries` runs on, and `undefined` where no cell exists.
 */
import { afterEach, describe, expect, it } from "vitest";
import { boot } from "./_boot";
import type { Booted } from "./_boot";

let booted: Booted | null = null;

afterEach(() => {
  booted?.dom.restore();
  booted = null;
});

const DAY = 86_400_000;

function scaleAt(levelId: string, config: Parameters<typeof boot>[2] = { origin: 0 }) {
  booted = boot([], {}, config);
  const scale = booted.gantt.service("stargantt.timeline");
  scale.setZoomLevel(levelId);
  return scale;
}

describe("the cell each built-in level measures in", () => {
  it("is a day at the day level", () => {
    const cell = scaleAt("day").gridCellAt(Date.UTC(2026, 7, 10, 13, 45));
    expect(cell).toEqual({ start: Date.UTC(2026, 7, 10), end: Date.UTC(2026, 7, 11) });
  });

  it("is a week, starting on the chart's first weekday, at the week level", () => {
    // 2026-08-10 is a Monday; the default first day of week is Monday.
    const cell = scaleAt("week").gridCellAt(Date.UTC(2026, 7, 13, 9));
    expect(cell).toEqual({ start: Date.UTC(2026, 7, 10), end: Date.UTC(2026, 7, 17) });
  });

  it("follows a non-default first weekday", () => {
    booted = boot([], {}, { origin: 0, firstDayOfWeek: 0 });
    const scale = booted.gantt.service("stargantt.timeline");
    scale.setZoomLevel("week");
    expect(scale.gridCellAt(Date.UTC(2026, 7, 13, 9))).toEqual({
      start: Date.UTC(2026, 7, 9),
      end: Date.UTC(2026, 7, 16),
    });
  });

  it("is an hour at the hour level", () => {
    const cell = scaleAt("hour").gridCellAt(Date.UTC(2026, 7, 10, 13, 45));
    expect(cell).toEqual({
      start: Date.UTC(2026, 7, 10, 13),
      end: Date.UTC(2026, 7, 10, 14),
    });
  });

  it("is a month at the month level", () => {
    const cell = scaleAt("month").gridCellAt(Date.UTC(2026, 7, 10));
    expect(cell).toEqual({ start: Date.UTC(2026, 7, 1), end: Date.UTC(2026, 8, 1) });
  });

  it("is a calendar-anchored quarter at the quarter level", () => {
    const cell = scaleAt("quarter").gridCellAt(Date.UTC(2026, 7, 10));
    expect(cell).toEqual({ start: Date.UTC(2026, 6, 1), end: Date.UTC(2026, 9, 1) });
  });

  it("is a year at the year level", () => {
    const cell = scaleAt("year").gridCellAt(Date.UTC(2026, 7, 10));
    expect(cell).toEqual({ start: Date.UTC(2026, 0, 1), end: Date.UTC(2027, 0, 1) });
  });

  it("follows the fiscal anchor the fine row carries", () => {
    booted = boot([], {}, { origin: 0, fiscalYearStartMonth: 4 });
    const scale = booted.gantt.service("stargantt.timeline");
    scale.setZoomLevel("year");
    // With an April-start fiscal year the year level's fine row is a step-12 month row anchored
    // on April, so February 2026 belongs to the period that opened in April 2025.
    expect(scale.gridCellAt(Date.UTC(2026, 1, 10))).toEqual({
      start: Date.UTC(2025, 3, 1),
      end: Date.UTC(2026, 3, 1),
    });
  });
});

describe("edges", () => {
  it("puts an instant exactly on a boundary in the cell that boundary opens", () => {
    const scale = scaleAt("day");
    const start = Date.UTC(2026, 7, 10);
    expect(scale.gridCellAt(start)).toEqual({ start, end: start + DAY });
    expect(scale.gridCellAt(start - 1)).toEqual({ start: start - DAY, end: start });
  });

  it("answers undefined for a non-finite instant", () => {
    const scale = scaleAt("day");
    expect(scale.gridCellAt(Number.NaN)).toBeUndefined();
    expect(scale.gridCellAt(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it("keeps answering when a level with no scale rows is offered — it is never activated", () => {
    // §1.4: a level whose `scales` is empty is unusable and is dropped, so the built-in ladder
    // stays in force and the member has a fine row to measure with. The `undefined` branch for a
    // row-less level is defensive, not reachable through configuration.
    booted = boot([], {}, { origin: 0, zoomLevels: [{ id: "bare", pxPerDay: 40, scales: [] }] });
    const scale = booted.gantt.service("stargantt.timeline");
    expect(scale.gridCellAt(Date.UTC(2026, 7, 10))).toEqual({
      start: Date.UTC(2026, 7, 10),
      end: Date.UTC(2026, 7, 11),
    });
  });

  it("agrees with unitBoundaries — the cell edges are boundaries the chart draws", () => {
    const scale = scaleAt("week");
    const t = Date.UTC(2026, 7, 13, 9);
    const cell = scale.gridCellAt(t);
    if (cell === undefined) throw new Error("expected a cell");
    // Half-open on both ends: the only week boundary inside (start, end] is `end` itself.
    expect(scale.unitBoundaries("week", cell.start + 1, cell.end + 1)).toEqual([cell.end]);
  });
});
