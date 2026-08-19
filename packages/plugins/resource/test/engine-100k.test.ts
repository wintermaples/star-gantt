/**
 * The engine's 100k-scale operability sanity check (COVERAGE review item: `computeUtilization` at
 * 100k-cell scale). Not a micro-benchmark (no assertion on wall-clock beyond a generous ceiling that only
 * catches an accidental quadratic regression) — the point is that a build this large completes at
 * all, produces mathematically sane numbers for a spot-checked row, and respects the 8192-bucket
 * cap without throwing or truncating a roster.
 *
 * Scale: 2,000 resources × 50 day-buckets = 100,000 resource×bucket cells, each resource carrying
 * a handful of demand intervals — large enough that the accrual sweep's per-row scratch-buffer
 * growth and the difference-array walk are genuinely exercised at volume, not just unit-tested at
 * a handful of rows (`engine-edges.test.ts`) or covered incidentally in the memo's 20-row suite.
 */
import { describe, expect, it } from "vitest";
import { computeUtilization } from "../src/internal/engine/compute";
import type { BucketInput, DemandInterval, EngineResource } from "../src/internal/engine/compute";
import { MONDAY, MS_DAY, calendarListing } from "./_engine";
import { DEFAULT_WORKWEEK } from "@stargantt/sdk";

const RESOURCE_COUNT = 2000;
const DAYS = 50;

function bigRoster(): EngineResource<unknown>[] {
  const listing = calendarListing(DEFAULT_WORKWEEK);
  return Array.from({ length: RESOURCE_COUNT }, (_, i) => ({
    id: `r${String(i)}`,
    name: `Resource ${String(i)}`,
    // A varied capacity rate so the test cannot pass by coincidence of every row being identical.
    capacityRate: 1 + (i % 3) * 0.5,
    workingIntervals: listing,
    source: undefined,
  }));
}

function bigDemands(): Map<string, readonly DemandInterval[]> {
  const out = new Map<string, DemandInterval[]>();
  for (let i = 0; i < RESOURCE_COUNT; i += 1) {
    // Three staggered demand intervals per resource, so the difference-array delta path and the
    // partial-overlap path (§ engine compute.ts `accrueRow`) both see real work at this row.
    const base = MONDAY + (i % 10) * MS_DAY;
    out.set(`r${String(i)}`, [
      { start: base, end: base + 2 * MS_DAY, units: 1 },
      { start: base + 3 * MS_DAY, end: base + 5 * MS_DAY, units: 0.5 },
      { start: MONDAY + 40 * MS_DAY, end: MONDAY + 40 * MS_DAY + 12 * 3_600_000, units: 1 },
    ]);
  }
  return out;
}

describe("computeUtilization at 100k-cell scale", () => {
  it("completes, respects the roster/bucket count exactly, and one spot-checked row is correct", () => {
    const input: BucketInput<unknown> = {
      resources: bigRoster(),
      demands: bigDemands(),
      start: MONDAY,
      end: MONDAY + DAYS * MS_DAY,
      bucket: "day",
      edges: "aligned",
      weekStartDay: 1,
    };

    const startedAt = Date.now();
    const matrix = computeUtilization(input);
    const elapsedMs = Date.now() - startedAt;

    expect(matrix.rows).toHaveLength(RESOURCE_COUNT);
    expect(matrix.rows[0]!.cells).toHaveLength(DAYS);
    // A generous ceiling: this is a correctness/operability gate, not a performance regression
    // budget with a tight tolerance — it only needs to catch an accidental O(n^2) blow-up.
    expect(elapsedMs).toBeLessThan(5000);

    // Spot-check resource r0: Monday 2024-01-01 is a working Monday, capacityRate = 1 + 0*0.5 = 1.
    // Its first demand interval [MONDAY, MONDAY+2d) at units=1 fully covers a working Mon/Tue.
    const row0 = matrix.rows[0]!;
    expect(row0.resource.id).toBe("r0");
    const mondayCell = row0.cells[0]!;
    expect(mondayCell.workingMs).toBe(MS_DAY); // Monday is a full working day
    expect(mondayCell.allocated).toBe(MS_DAY); // fully covered by the units=1 interval
    expect(mondayCell.capacity).toBe(MS_DAY); // capacityRate 1 * workingMs
    expect(mondayCell.ratio).toBe(1);
    expect(mondayCell.overallocated).toBe(false); // exactly at capacity, not over (OVERLOAD_EPSILON)

    // Spot-check a resource with a different capacity rate (r1: capacityRate = 1.5).
    const row1 = matrix.rows[1]!;
    expect(row1.resource.capacityRate).toBe(1.5);
    expect(row1.cells[0]!.capacity).toBe(MS_DAY * 1.5);

    // No row was silently dropped and no row exceeds the requested bucket count even at this
    // volume — the 8192-bucket cap applies per BUILD (bucket count), not per roster size, and 50
    // buckets is nowhere near it, but every row must still see the exact same grid.
    for (const row of matrix.rows) {
      expect(row.cells).toHaveLength(DAYS);
    }
  });

  it("stays within the 8192-bucket cap when the requested grid is far wider than the range needs", () => {
    // A degenerate width/range combination (minute buckets over 50 days = 72,000 buckets) must
    // still cap at 8192 rather than allocate an unbounded grid, however large the roster is.
    const input: BucketInput<unknown> = {
      resources: bigRoster().slice(0, 50), // roster size is irrelevant to the bucket cap; keep it small here
      demands: new Map(),
      start: MONDAY,
      end: MONDAY + DAYS * MS_DAY,
      bucket: "minute",
      edges: "aligned",
      weekStartDay: 1,
    };
    const matrix = computeUtilization(input);
    expect(matrix.rows[0]!.cells.length).toBeLessThanOrEqual(8192);
  });
});
