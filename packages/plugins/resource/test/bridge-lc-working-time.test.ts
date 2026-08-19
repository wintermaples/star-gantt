/**
 * §4 "Cells" / "Working time": a cell accrues both numbers over the WORKING milliseconds inside
 * its bucket, so its ratio is a true utilization fraction at any width
 * (docs/specs/plugins/resource.md §2.3).
 *
 * Working-time RESOLUTION is a roster property (`EngineResource.workingIntervals`), so the pool's
 * listing arrives as that closure — pool wiring itself is exercised elsewhere. Cross-engine parity
 * is a tautology here (one engine, one accumulation order, per §2.6 item 1); what is asserted is
 * that the numbers do not change between the two callers' edge policies for a day-aligned range.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_WORKWEEK, workingIntervals } from "@stargantt/sdk";
import type { TimeRange, WorkingCalendar } from "@stargantt/sdk";
import { computeUtilization } from "../src/internal/engine/compute";
import type { UtilizationBucketUnit } from "../src/internal/engine/buckets";
import { MONDAY, MS_DAY, MS_HOUR, SHIFT, calendarListing, engineResource } from "./_engine";

/** A listing over `calendar` with the given ranges subtracted — what the pool publishes (§2.3). */
function listingWithTimeOff(
  calendar: Readonly<WorkingCalendar>,
  timeOff: readonly TimeRange[],
): (from: number, to: number, out?: TimeRange[]) => TimeRange[] {
  return (from, to, out) => {
    const list = out ?? [];
    const base = workingIntervals(calendar, from, to, []);
    for (const range of base) {
      let pieces: TimeRange[] = [range];
      for (const off of timeOff) {
        const next: TimeRange[] = [];
        for (const piece of pieces) {
          if (off.end <= piece.start || off.start >= piece.end) {
            next.push(piece);
            continue;
          }
          if (off.start > piece.start) next.push({ start: piece.start, end: off.start });
          if (off.end < piece.end) next.push({ start: off.end, end: piece.end });
        }
        pieces = next;
      }
      for (const piece of pieces) if (piece.end > piece.start) list.push(piece);
    }
    return list;
  };
}

function week(
  listing: (from: number, to: number, out?: TimeRange[]) => TimeRange[],
  capacityRate: number,
  taskStart: number,
  taskEnd: number,
  bucket: UtilizationBucketUnit = "week",
  from = MONDAY,
  to = MONDAY + 7 * MS_DAY,
) {
  return computeUtilization({
    resources: [engineResource({ id: "r", name: "Ada", capacityRate, workingIntervals: listing })],
    demands: new Map([["r", [{ start: taskStart, end: taskEnd, units: 1 }]]]),
    start: from,
    end: to,
    bucket,
    edges: "aligned",
    weekStartDay: 1,
  }).rows[0]!.cells;
}

const DEFAULT_LISTING = calendarListing(DEFAULT_WORKWEEK);

describe("working-time capacity (§2.3)", () => {
  it("reads one booked working day inside a week bucket as 1/5, not 1/1", () => {
    const cells = week(DEFAULT_LISTING, 1, MONDAY, MONDAY + MS_DAY);
    expect(cells).toHaveLength(1);
    const cell = cells[0]!;
    // Five full working days at capacity rate 1 = 5 × MS_DAY of capacity; the Monday booking at
    // units 1 covers one of those days = 1 × MS_DAY of allocation, so the ratio is 1/5.
    expect(cell.capacity).toBe(5 * MS_DAY);
    expect(cell.allocated).toBe(MS_DAY);
    expect(cell.ratio).toBe(0.2);
    expect(cell.overallocated).toBe(false);
  });

  it("keeps a full working week at exactly 1", () => {
    const cell = week(DEFAULT_LISTING, 1, MONDAY, MONDAY + 7 * MS_DAY)[0]!;
    expect(cell.capacity).toBe(5 * MS_DAY);
    expect(cell.allocated).toBe(5 * MS_DAY);
    expect(cell.ratio).toBe(1);
    // Exactly at capacity is not over, per the §2.4 epsilon.
    expect(cell.overallocated).toBe(false);
  });

  it("keeps a day bucket over working days at one full day each", () => {
    const cells = week(
      DEFAULT_LISTING,
      1,
      MONDAY,
      MONDAY + 5 * MS_DAY,
      "day",
      MONDAY,
      MONDAY + 5 * MS_DAY,
    );
    expect(cells.map((c) => c.capacity)).toEqual([MS_DAY, MS_DAY, MS_DAY, MS_DAY, MS_DAY]);
    expect(cells.map((c) => c.ratio)).toEqual([1, 1, 1, 1, 1]);
  });

  it("gives a weekend day bucket no capacity and no allocation", () => {
    const cells = week(
      DEFAULT_LISTING,
      1,
      MONDAY,
      MONDAY + 7 * MS_DAY,
      "day",
      MONDAY + 5 * MS_DAY,
      MONDAY + 7 * MS_DAY,
    );
    expect(cells.map((c) => c.capacity)).toEqual([0, 0]);
    expect(cells.map((c) => c.allocated)).toEqual([0, 0]);
    expect(cells.map((c) => c.ratio)).toEqual([null, null]);
  });

  it("scales a month bucket by its own working time", () => {
    // January 2024 has 23 working days (31 days, 8 of them weekend days), each a full 24 h.
    const jan = Date.UTC(2024, 0, 1);
    const feb = Date.UTC(2024, 1, 1);
    const cell = week(DEFAULT_LISTING, 1, jan, feb, "month", jan, feb)[0]!;
    expect(cell.capacity).toBe(23 * MS_DAY);
    expect(cell.allocated).toBe(23 * MS_DAY);
    expect(cell.ratio).toBe(1);
  });

  it("halves the ratio for a double-rate resource at every bucket width", () => {
    const asWeek = week(DEFAULT_LISTING, 2, MONDAY, MONDAY + 7 * MS_DAY)[0]!;
    const asDay = week(DEFAULT_LISTING, 2, MONDAY, MONDAY + 7 * MS_DAY, "day")[0]!;
    expect(asWeek.ratio).toBe(0.5);
    expect(asDay.ratio).toBe(0.5);
  });
});

describe("working-time resolution (§2.3)", () => {
  it("takes the Monday–Friday default for a resource no pool listing covers", () => {
    expect(week(DEFAULT_LISTING, 1, MONDAY, MONDAY + 7 * MS_DAY)[0]!.capacity).toBe(5 * MS_DAY);
  });

  it("follows a six-day calendar the listing publishes", () => {
    const listing = calendarListing({ workingDays: [1, 2, 3, 4, 5, 6] });
    const cell = week(listing, 1, MONDAY, MONDAY + 7 * MS_DAY)[0]!;
    expect(cell.capacity).toBe(6 * MS_DAY);
    expect(cell.allocated).toBe(6 * MS_DAY);
  });

  it("resolves an intra-day working-hours window at instant granularity", () => {
    // 5 × 8 h = 144 000 000 ms of week capacity.
    const cell = week(calendarListing(SHIFT), 1, MONDAY, MONDAY + 7 * MS_DAY)[0]!;
    expect(cell.capacity).toBe(5 * 8 * MS_HOUR);
    expect(cell.capacity).toBe(144_000_000);
    expect(cell.allocated).toBe(144_000_000);
    expect(cell.ratio).toBe(1);
  });

  it("bills a sub-day task only the working time it actually covers", () => {
    // Monday 00:00–12:00 against a 09:00–17:00 window: three working hours, not a whole day.
    const cell = week(calendarListing(SHIFT), 1, MONDAY, MONDAY + 12 * MS_HOUR)[0]!;
    expect(cell.allocated).toBe(3 * MS_HOUR);
    expect(cell.allocated).toBe(10_800_000);
    expect(cell.capacity).toBe(144_000_000);
    expect(cell.ratio).toBe(0.075);
  });

  it("lets part-day time off remove only its own hours", () => {
    const listing = listingWithTimeOff(SHIFT, [
      { start: MONDAY + 9 * MS_HOUR, end: MONDAY + 13 * MS_HOUR },
    ]);
    const cell = week(listing, 1, MONDAY, MONDAY + 7 * MS_DAY)[0]!;
    expect(cell.capacity).toBe(144_000_000 - 4 * MS_HOUR);
    expect(cell.allocated).toBe(144_000_000 - 4 * MS_HOUR);
  });

  it("agrees with a four-day calendar minus a whole day of time off", () => {
    const listing = listingWithTimeOff({ workingDays: [1, 2, 3, 4] }, [
      { start: MONDAY + MS_DAY, end: MONDAY + 2 * MS_DAY },
    ]);
    const cell = week(listing, 1, MONDAY, MONDAY + 7 * MS_DAY)[0]!;
    // Mon–Thu working days, Tuesday removed by time off ⇒ three full working days.
    expect(cell.capacity).toBe(3 * MS_DAY);
    expect(cell.allocated).toBe(3 * MS_DAY);
  });
});

describe("the retired cross-engine parity case (§2.6 item 1)", () => {
  it("gives the two callers' edge policies identical numbers over a day-aligned range", () => {
    // One engine now handles both callers, so the surviving question is whether `edges` changes
    // anything when the range already sits on the grid. It must not.
    const common = {
      resources: [engineResource({ id: "r", name: "Ada" })],
      demands: new Map([["r", [{ start: MONDAY, end: MONDAY + 7 * MS_DAY, units: 1 }]]]),
      start: MONDAY,
      end: MONDAY + 7 * MS_DAY,
      bucket: "day" as const,
      weekStartDay: 1,
    };
    const aligned = computeUtilization({ ...common, edges: "aligned" });
    const clamped = computeUtilization({ ...common, edges: "clamped" });
    expect(clamped.rows[0]!.cells).toEqual(aligned.rows[0]!.cells);
  });
});
