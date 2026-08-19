/**
 * The eight fixed widths, epoch alignment, the 8192 cap, sub-day boundary cuts, per-bucket
 * `workingDays` and day-grid invariance (§3/§4), expressed through the unified engine
 * (docs/specs/plugins/resource.md §2.2 / §2.3 / §2.6).
 *
 * Notable framing: `coarsenBucketMode` takes the column bound explicitly (`maxColumns` is a
 * `BucketInput` member — §2.1), `bucketsInRange` takes the `edges` policy, and the accrual cases
 * drive `computeUtilization` with `edges: "aligned"` (the load-chart side, §2.5). The
 * report-column and accessible-name cases are NOT covered here: they pin `report-csv.ts` and the
 * message catalog's label builders, exercised elsewhere.
 */
import { describe, expect, it } from "vitest";
import {
  autoBucketMode,
  bucketsInRange,
  coarsenBucketMode,
  createBucketIndexer,
  isBucketMode,
  isSubDayMode,
  resolveBucketMode,
  stepOf,
} from "../src/internal/engine/buckets";
import type { UtilizationBucketUnit } from "../src/internal/engine/buckets";
import { computeUtilization } from "../src/internal/engine/compute";
import {
  MONDAY,
  MS_DAY,
  MS_HOUR,
  MS_MINUTE,
  SHIFT,
  calendarListing,
  loadChartDemands,
  loadChartRoster,
} from "./_engine";
import type { Store } from "./_engine";

const SUB_DAY: readonly UtilizationBucketUnit[] = [
  "minute",
  "minute5",
  "minute15",
  "minute30",
  "hour",
];

describe("bucket widths (§2.2)", () => {
  it("gives every new width its contracted fixed step, each an exact divisor of a day", () => {
    expect(SUB_DAY.map((m) => stepOf(m))).toEqual([60_000, 300_000, 900_000, 1_800_000, 3_600_000]);
    for (const unit of SUB_DAY) expect(MS_DAY % (stepOf(unit) as number)).toBe(0);
    expect(stepOf("month")).toBeNull();
  });

  it("classifies exactly the sub-day widths as sub-day", () => {
    for (const unit of SUB_DAY) expect(isSubDayMode(unit)).toBe(true);
    for (const unit of ["day", "week", "month"] as const) expect(isSubDayMode(unit)).toBe(false);
  });

  it("enumerates each grid aligned to the UTC epoch, covering the range half-openly", () => {
    for (const unit of SUB_DAY) {
      const step = stepOf(unit) as number;
      // A range deliberately starting and ending off the grid, so both ends must be snapped.
      const from = MONDAY + 9 * MS_HOUR + 37 * MS_MINUTE;
      const to = from + 3 * step + step / 2;
      const buckets = bucketsInRange(unit, from, to, 1, "aligned");
      expect(buckets[0]!.start).toBe(Math.floor(from / step) * step);
      expect(buckets[0]!.start % step).toBe(0);
      expect(buckets.at(-1)!.end).toBeGreaterThanOrEqual(to);
      for (let i = 1; i < buckets.length; i += 1) {
        expect(buckets[i]!.start).toBe(buckets[i - 1]!.end);
        expect(buckets[i]!.end - buckets[i]!.start).toBe(step);
      }
    }
  });

  it("keeps the day, week and month grids exactly where they were", () => {
    expect(bucketsInRange("day", MONDAY, MONDAY + 2 * MS_DAY, 1, "aligned")).toEqual([
      { start: MONDAY, end: MONDAY + MS_DAY },
      { start: MONDAY + MS_DAY, end: MONDAY + 2 * MS_DAY },
    ]);
    // Sunday 2023-12-31 with a Monday week start still opens the week of Monday 2023-12-25.
    expect(bucketsInRange("week", MONDAY - MS_DAY, MONDAY, 1, "aligned")[0]!.start).toBe(
      Date.UTC(2023, 11, 25),
    );
    expect(bucketsInRange("month", MONDAY, MONDAY + 40 * MS_DAY, 1, "aligned")).toEqual([
      { start: Date.UTC(2024, 0, 1), end: Date.UTC(2024, 1, 1) },
      { start: Date.UTC(2024, 1, 1), end: Date.UTC(2024, 2, 1) },
    ]);
  });

  it("caps any grid at 8192 buckets", () => {
    expect(bucketsInRange("minute", MONDAY, MONDAY + 30 * MS_DAY, 1, "aligned")).toHaveLength(8192);
  });
});

describe("bucket indexing (§2.2)", () => {
  // The indexer replaces a per-bucket activity test with arithmetic, so it has to agree with that
  // test everywhere — boundary-aligned endpoints above all.
  it("agrees with a naive per-bucket activity test at every sub-day width", () => {
    for (const unit of SUB_DAY) {
      const step = stepOf(unit) as number;
      const from = MONDAY;
      const buckets = bucketsInRange(unit, from, from + 6 * step, 1, "aligned");
      const indexer = createBucketIndexer(unit, buckets);
      const probes = [0, 1, step / 2, step, step + 1, 3 * step, 6 * step - 1, 6 * step];
      for (const s of probes) {
        for (const e of probes) {
          const start = from + s;
          const end = from + e;
          if (!(end > start)) continue;
          const naive = buckets
            .map((b, i) => (start < b.end && end > b.start ? i : -1))
            .filter((i) => i >= 0);
          const lo = Math.max(0, indexer.firstIndex(start));
          const hi = Math.min(buckets.length - 1, indexer.lastIndex(end));
          const fast: number[] = [];
          for (let i = lo; i <= hi; i += 1) fast.push(i);
          expect(fast).toEqual(naive);
        }
      }
    }
  });
});

describe('"auto" resolution (§2.2)', () => {
  it("resolves each density band to its contracted width", () => {
    expect(autoBucketMode(2881)).toBe("minute");
    expect(autoBucketMode(2880)).toBe("hour");
    expect(autoBucketMode(480)).toBe("hour"); // the built-in `hour` zoom level
    expect(autoBucketMode(101)).toBe("hour");
    expect(autoBucketMode(100)).toBe("day");
    expect(autoBucketMode(40)).toBe("day"); // the built-in `day` zoom level
    expect(autoBucketMode(21)).toBe("day");
    expect(autoBucketMode(20)).toBe("week");
    expect(autoBucketMode(12)).toBe("week"); // the built-in `week` zoom level
    expect(autoBucketMode(5)).toBe("week");
    expect(autoBucketMode(4)).toBe("month");
    expect(autoBucketMode(0.5)).toBe("month"); // the built-in `year` zoom level
  });

  it("never picks a sub-hour width", () => {
    for (const px of [0.1, 1, 4, 12, 40, 480, 2880, 100_000]) {
      expect(["minute5", "minute15", "minute30"]).not.toContain(autoBucketMode(px));
    }
  });

  it("passes an explicit width through and falls back to day for anything unusable", () => {
    for (const unit of SUB_DAY) expect(resolveBucketMode(unit, 40)).toBe(unit);
    expect(resolveBucketMode(undefined, 0.5)).toBe("day");
    expect(resolveBucketMode("quarter" as UtilizationBucketUnit, 0.5)).toBe("day");
    expect(resolveBucketMode("auto", 480)).toBe("hour");
  });

  it("names the concrete widths and rejects `auto`", () => {
    for (const unit of [...SUB_DAY, "day", "week", "month"]) expect(isBucketMode(unit)).toBe(true);
    for (const value of ["auto", "", undefined, null, 3, {}]) {
      expect(isBucketMode(value)).toBe(false);
    }
  });
});

describe("coarsening ladder (§2.1 maxColumns)", () => {
  it("stops at the first width holding at most 200 buckets", () => {
    // Two hours: 120 minute buckets already fit, so nothing is coarsened.
    expect(coarsenBucketMode("minute", MONDAY, MONDAY + 2 * MS_HOUR, 1, 200)).toBe("minute");
    // Half a day: 720 minutes, 144 five-minute buckets.
    expect(coarsenBucketMode("minute", MONDAY, MONDAY + 12 * MS_HOUR, 1, 200)).toBe("minute5");
    // Two days: 576 five-minute, 192 fifteen-minute buckets.
    expect(coarsenBucketMode("minute", MONDAY, MONDAY + 2 * MS_DAY, 1, 200)).toBe("minute15");
    // Five days: 480 fifteen-minute, 240 half-hour, 120 hour buckets.
    expect(coarsenBucketMode("minute", MONDAY, MONDAY + 5 * MS_DAY, 1, 200)).toBe("hour");
    // Thirty days: 720 hours, 30 days.
    expect(coarsenBucketMode("minute", MONDAY, MONDAY + 30 * MS_DAY, 1, 200)).toBe("day");
    // Three years: 1095 days, 157 weeks.
    expect(coarsenBucketMode("minute", MONDAY, MONDAY + 1095 * MS_DAY, 1, 200)).toBe("week");
    // Nine years: 470 weeks, past every rung.
    expect(coarsenBucketMode("minute", MONDAY, MONDAY + 3285 * MS_DAY, 1, 200)).toBe("month");
  });

  it("never narrows a width that was already coarse enough", () => {
    expect(coarsenBucketMode("day", MONDAY, MONDAY + 10 * MS_DAY, 1, 200)).toBe("day");
    expect(coarsenBucketMode("month", MONDAY, MONDAY + 2 * MS_HOUR, 1, 200)).toBe("month");
  });
});

/* --------------------------------------------------------------------------------------- *
 * §2.3 working time under a grid whose boundaries are not midnights.
 * --------------------------------------------------------------------------------------- */

const SHIFT_LISTING = calendarListing(SHIFT);
const ada = { id: "r", name: "Ada", capacity: 1 };

function allDay(id: string) {
  return { id, start: MONDAY, end: MONDAY + MS_DAY };
}

function hourly(fromT: number, toT: number, store: Store, unit: UtilizationBucketUnit = "hour") {
  const roster = loadChartRoster(store, undefined, SHIFT_LISTING);
  return computeUtilization({
    resources: roster,
    demands: loadChartDemands(store, roster),
    start: fromT,
    end: toT,
    bucket: unit,
    edges: "aligned",
    weekStartDay: 1,
  });
}

describe("working time on a sub-day grid (§2.3)", () => {
  it("spreads a shift across its hour buckets instead of heaping it in the first", () => {
    // Without the boundary cut the whole 09:00–17:00 interval would bill to the 09:00 bucket.
    const matrix = hourly(MONDAY, MONDAY + MS_DAY, {
      tasks: [allDay("t")],
      resources: [ada],
      assignments: [{ taskId: "t", resourceId: "r", units: 1 }],
    });
    const capacity = matrix.rows[0]!.cells.map((c) => c.capacity);
    expect(capacity).toHaveLength(24);
    // One full hour of capacity in each of the eight shift hours, nothing outside them.
    expect(capacity.slice(9, 17)).toEqual(new Array(8).fill(MS_HOUR));
    expect(capacity.slice(0, 9)).toEqual(new Array(9).fill(0));
    expect(capacity.slice(17)).toEqual(new Array(7).fill(0));
    expect(matrix.rows[0]!.cells.map((c) => c.allocated).slice(9, 17)).toEqual(
      new Array(8).fill(MS_HOUR),
    );
  });

  it("bills a task's true overlap per bucket at fifteen-minute granularity", () => {
    // 09:20 → 10:10: 09:15 bucket 10 min, 09:30 and 09:45 buckets 15 min each, 10:00 bucket 10 min.
    const matrix = hourly(
      MONDAY + 9 * MS_HOUR,
      MONDAY + 11 * MS_HOUR,
      {
        tasks: [
          {
            id: "t",
            start: MONDAY + 9 * MS_HOUR + 20 * MS_MINUTE,
            end: MONDAY + 10 * MS_HOUR + 10 * MS_MINUTE,
          },
        ],
        resources: [ada],
        assignments: [{ taskId: "t", resourceId: "r", units: 1 }],
      },
      "minute15",
    );
    expect(matrix.rows[0]!.cells.map((c) => c.allocated)).toEqual([
      0,
      10 * MS_MINUTE,
      15 * MS_MINUTE,
      15 * MS_MINUTE,
      10 * MS_MINUTE,
      0,
      0,
      0,
    ]);
  });

  it("handles a range that starts and ends off any day boundary", () => {
    // The interval window is indexed by whole days, so a 10:30 → 14:30 range must still resolve.
    const matrix = hourly(
      MONDAY + 10 * MS_HOUR + 30 * MS_MINUTE,
      MONDAY + 14 * MS_HOUR + 30 * MS_MINUTE,
      {
        tasks: [allDay("t")],
        resources: [ada],
        assignments: [{ taskId: "t", resourceId: "r", units: 1 }],
      },
    );
    // The grid snaps out to 10:00 → 15:00: five hour buckets, all inside the shift.
    expect(matrix.rows[0]!.cells).toHaveLength(5);
    expect(matrix.rows[0]!.cells[0]!.start).toBe(MONDAY + 10 * MS_HOUR);
    expect(matrix.rows[0]!.cells.map((c) => c.capacity)).toEqual(new Array(5).fill(MS_HOUR));
  });

  it("spans a midnight, where the working window closes and reopens", () => {
    // Mon 16:00 → Tue 10:00. Only 16:00–17:00 and 09:00–10:00 are working hours.
    const matrix = hourly(MONDAY + 16 * MS_HOUR, MONDAY + MS_DAY + 10 * MS_HOUR, {
      tasks: [{ id: "t", start: MONDAY, end: MONDAY + 2 * MS_DAY }],
      resources: [ada],
      assignments: [{ taskId: "t", resourceId: "r", units: 1 }],
    });
    const capacity = matrix.rows[0]!.cells.map((c) => c.capacity);
    expect(capacity).toHaveLength(18);
    expect(capacity[0]).toBe(MS_HOUR); // Mon 16:00–17:00
    expect(capacity.slice(1, 17)).toEqual(new Array(16).fill(0)); // 17:00 → Tue 09:00
    expect(capacity[17]).toBe(MS_HOUR); // Tue 09:00–10:00
  });

  it("counts working days per bucket, not per row", () => {
    // `workingDays` reaches nobody but the per-resource hooks, so the hook is how it is observed.
    const seen: number[] = [];
    const store: Store = {
      tasks: [allDay("t")],
      resources: [ada],
      assignments: [{ taskId: "t", resourceId: "r", units: 1 }],
    };
    const roster = loadChartRoster(store, undefined, SHIFT_LISTING);
    computeUtilization({
      resources: roster,
      demands: loadChartDemands(store, roster),
      start: MONDAY,
      end: MONDAY + MS_DAY,
      bucket: "hour",
      edges: "aligned",
      weekStartDay: 1,
      hooks: {
        resourceCapacity: (input) => {
          seen.push(input.workingDays);
          return input.capacity;
        },
      },
    });
    // Each of the eight shift hours is its own bucket and each reads 1 — not 1 in the first and 0
    // in the seven that share its UTC day, which is what a row-wide counter would produce.
    expect(seen.slice(9, 17)).toEqual(new Array(8).fill(1));
    expect(seen.slice(0, 9)).toEqual(new Array(9).fill(0));
    expect(seen.slice(17)).toEqual(new Array(7).fill(0));
  });

  it("leaves the day grid's numbers exactly as they were", () => {
    const matrix = hourly(
      MONDAY,
      MONDAY + 5 * MS_DAY,
      {
        tasks: [
          {
            id: "t",
            start: MONDAY + MS_DAY + 10 * MS_HOUR,
            end: MONDAY + 3 * MS_DAY + 14 * MS_HOUR,
          },
        ],
        resources: [ada],
        assignments: [{ taskId: "t", resourceId: "r", units: 1 }],
      },
      "day",
    );
    expect(matrix.rows[0]!.cells.map((c) => c.allocated)).toEqual([
      0,
      7 * MS_HOUR,
      8 * MS_HOUR,
      5 * MS_HOUR,
      0,
    ]);
    expect(matrix.rows[0]!.cells.map((c) => c.capacity)).toEqual(new Array(5).fill(8 * MS_HOUR));
  });
});
