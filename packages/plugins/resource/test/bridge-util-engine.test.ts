/**
 * The whole hostless engine suite (§2.2/§2.3), expressed through the unified `computeUtilization`
 * with `edges: "clamped"` — the utilization side's policy (docs/specs/plugins/resource.md §2.5,
 * §2.6).
 *
 * Notable framing, all named by §2.6:
 *  - `utilizationBuckets(resource, demands, range, unit, threshold, weekStart, hooks)` becomes one
 *    `BucketInput` over a ONE-ROW roster (§1.2's single-resource narrowing);
 *  - `EngineResource.workingMs(from, to)` becomes `workingIntervals(from, to, out?)` — the summed
 *    listing, definitionally equal;
 *  - `weekStart: "monday" | "sunday"` becomes `weekStartDay: 1 | 0`;
 *  - `role` / `team` leave the engine: the rollups are folds over the matrix, filtered by the
 *    caller's own role/team metadata (§2.6);
 *  - the hooks' reused input is the engine's own per-build object, so its identity is asserted
 *    across calls rather than against a caller-created one;
 *  - the message cases live in `messages.test.ts` (the merged §7 catalog).
 *
 * Every expected quantity is derived from §2.3's arithmetic.
 */
import { describe, expect, it, vi } from "vitest";
import type { ResourceBucketInput } from "@stargantt/sdk";
import { startOfWeek } from "../src/internal/engine/buckets";
import { computeUtilization } from "../src/internal/engine/compute";
import type {
  BucketInput,
  EngineHooks,
  EngineResource,
  UtilizationCell,
} from "../src/internal/engine/compute";
import { MAX_RANGE_DAYS, alignRange, deriveRange } from "../src/internal/engine/range";
import {
  overlaps,
  peakRatio,
  roleDemands,
  teamSummaries,
  trendPoints,
} from "../src/internal/engine/rollups";
import { alwaysWorking, engineResource } from "./_engine";

const DAY = 86400000;
const HOUR = 3600000;
const MON = Date.UTC(2024, 0, 1); // Monday

interface Demand {
  start: number;
  end: number;
  units: number;
}

/** A `utilizationBuckets(...)`-style call, expressed as one clamped-edge build over one row. */
function utilizationBuckets<R>(
  resource: EngineResource<R>,
  demands: readonly Demand[],
  range: { start: number; end: number },
  unit: BucketInput<R>["bucket"],
  threshold: number,
  weekStartDay = 1,
  hooks?: EngineHooks<R>,
): readonly UtilizationCell[] {
  const input: BucketInput<R> = {
    resources: [resource],
    demands: new Map([[String(resource.id), demands]]),
    start: range.start,
    end: range.end,
    bucket: unit,
    edges: "clamped",
    weekStartDay,
    threshold,
    ...(hooks === undefined ? {} : { hooks }),
  };
  return computeUtilization(input).rows[0]?.cells ?? [];
}

const res = <R = unknown>(over: Partial<EngineResource<R>> = {}): EngineResource<R> =>
  engineResource<R>(over);

describe("ranges", () => {
  it("aligns outward to day boundaries", () => {
    const r = alignRange(MON + 1000, MON + DAY + 1000);
    expect(r).toEqual({ start: MON, end: MON + 2 * DAY });
  });

  it("rejects unusable ranges", () => {
    expect(alignRange(NaN, MON)).toBeNull();
    expect(alignRange(MON, MON)).toBeNull();
    expect(alignRange(MON + DAY, MON)).toBeNull();
  });

  it("clamps to the maximum analysis length", () => {
    const r = alignRange(MON, MON + (MAX_RANGE_DAYS + 100) * DAY);
    expect(r).toEqual({ start: MON, end: MON + MAX_RANGE_DAYS * DAY });
  });

  it("derives the extent of the task set, skipping unusable spans", () => {
    const r = deriveRange([
      { start: MON + DAY, end: MON + 3 * DAY },
      { start: MON, end: MON }, // zero span — skipped
      { start: NaN, end: MON + 9 * DAY }, // non-finite — skipped
      { start: MON + 2 * DAY, end: MON + 5 * DAY },
    ]);
    expect(r).toEqual({ start: MON + DAY, end: MON + 5 * DAY });
    expect(deriveRange([])).toBeNull();
  });

  it("starts weeks on UTC Monday by default", () => {
    expect(startOfWeek(MON, 1)).toBe(MON);
    expect(startOfWeek(MON + 6 * DAY, 1)).toBe(MON); // Sunday belongs to Monday's week
    expect(startOfWeek(MON + 7 * DAY, 1)).toBe(MON + 7 * DAY);
  });

  it("starts weeks on UTC Sunday when weekStartDay is 0", () => {
    const sun = MON - DAY; // the Sunday preceding MON
    expect(startOfWeek(sun, 0)).toBe(sun);
    expect(startOfWeek(MON, 0)).toBe(sun); // Monday belongs to the preceding Sunday's week
    expect(startOfWeek(MON + 5 * DAY, 0)).toBe(sun); // Saturday belongs to the same week
    expect(startOfWeek(MON + 6 * DAY, 0)).toBe(MON + 6 * DAY); // next Sunday starts a new week
  });
});

describe("utilizationBuckets", () => {
  const range = { start: MON, end: MON + 7 * DAY };
  const demands: Demand[] = [{ start: MON, end: MON + 5 * DAY, units: 0.5 }];

  it("accrues allocation and capacity over working milliseconds only", () => {
    const buckets = utilizationBuckets(res(), demands, range, "day", 1);
    expect(buckets).toHaveLength(7);
    // A weekday bucket holds one full working day: capacity = 1 × DAY, allocation = 0.5 × DAY.
    for (const b of buckets.slice(0, 5)) {
      expect(b.allocated).toBe(0.5 * DAY);
      expect(b.capacity).toBe(DAY);
      expect(b.ratio).toBe(0.5);
      expect(b.overallocated).toBe(false);
    }
    // Saturday / Sunday: no working time, so neither term accrues and no warning is raised.
    for (const b of buckets.slice(5)) {
      expect(b.allocated).toBe(0);
      expect(b.capacity).toBe(0);
      expect(b.ratio).toBeNull();
      expect(b.overallocated).toBe(false);
    }
  });

  it("bills a sub-day task only the hours it covers", () => {
    const buckets = utilizationBuckets(
      res(),
      [{ start: MON + 9 * HOUR, end: MON + 13 * HOUR, units: 1 }],
      { start: MON, end: MON + DAY },
      "day",
      1,
    );
    expect(buckets[0]?.allocated).toBe(4 * HOUR);
    expect(buckets[0]?.capacity).toBe(DAY);
    expect(buckets[0]?.ratio).toBe((4 * HOUR) / DAY);
  });

  it("scales capacity by the dimensionless rate", () => {
    const half = utilizationBuckets(res({ capacityRate: 0.5 }), demands, range, "day", 1);
    expect(half[0]?.capacity).toBe(0.5 * DAY);
    expect(half[0]?.ratio).toBe(1);
  });

  it("detects over-allocation against the threshold", () => {
    const heavy: Demand[] = [
      { start: MON, end: MON + 5 * DAY, units: 1 },
      { start: MON, end: MON + 5 * DAY, units: 1 },
    ];
    const at1 = utilizationBuckets(res(), heavy, range, "day", 1);
    expect(at1[0]?.allocated).toBe(2 * DAY); // two full-time assignments over one working day
    expect(at1[0]?.ratio).toBe(2);
    expect(at1[0]?.overallocated).toBe(true);
    const at2 = utilizationBuckets(res(), heavy, range, "day", 2);
    expect(at2[0]?.overallocated).toBe(false);
  });

  it("marks positive allocation on a zero-capacity day as over-allocated", () => {
    const unpaid = res({ workingIntervals: alwaysWorking, capacityRate: 0 });
    const buckets = utilizationBuckets(unpaid, demands, { start: MON, end: MON + DAY }, "day", 1);
    expect(buckets[0]?.capacity).toBe(0);
    expect(buckets[0]?.allocated).toBe(0.5 * DAY);
    expect(buckets[0]?.ratio).toBeNull();
    expect(buckets[0]?.overallocated).toBe(true);
  });

  it("aggregates week buckets clamped to the range", () => {
    const wide = { start: MON + 3 * DAY, end: MON + 10 * DAY };
    const buckets = utilizationBuckets(
      res(),
      [{ start: MON, end: MON + 14 * DAY, units: 1 }],
      wide,
      "week",
      1,
    );
    expect(buckets).toHaveLength(2);
    // Thu+Fri of the first week (Sat/Sun add nothing), then Mon–Wed of the second.
    expect(buckets[0]).toMatchObject({
      start: MON + 3 * DAY,
      end: MON + 7 * DAY,
      allocated: 2 * DAY,
      capacity: 2 * DAY,
    });
    expect(buckets[1]).toMatchObject({
      start: MON + 7 * DAY,
      end: MON + 10 * DAY,
      allocated: 3 * DAY,
      capacity: 3 * DAY,
    });
  });

  // Week buckets follow the given week start.
  it("aggregates week buckets starting on Sunday when weekStartDay is 0", () => {
    const sun = MON - DAY;
    const wide = { start: sun, end: sun + 10 * DAY }; // Sun..next Wed
    const buckets = utilizationBuckets(
      res(),
      [{ start: sun, end: sun + 14 * DAY, units: 1 }],
      wide,
      "week",
      1,
      0,
    );
    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toMatchObject({ start: sun, end: sun + 7 * DAY });
    expect(buckets[1]).toMatchObject({ start: sun + 7 * DAY, end: sun + 10 * DAY });
  });

  it("measures a partially covered bucket, not the whole bucket", () => {
    const buckets = utilizationBuckets(
      res(),
      [{ start: MON, end: MON + 2 * DAY, units: 1 }],
      { start: MON, end: MON + 7 * DAY },
      "week",
      1,
    );
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({ allocated: 2 * DAY, capacity: 5 * DAY });
    expect(buckets[0]?.ratio).toBe(0.4);
  });
});

describe("the resourceLoad / resourceCapacity hooks", () => {
  const range = { start: MON, end: MON + 7 * DAY };
  const demands: Demand[] = [{ start: MON, end: MON + 5 * DAY, units: 1 }];

  function hooksOf(
    over: Partial<EngineHooks<unknown>> = {},
  ): EngineHooks<unknown> & { faults: [string, unknown][] } {
    const faults: [string, unknown][] = [];
    return {
      onError: (where, error) => faults.push([where, error]),
      faults,
      ...over,
    };
  }

  it("judges ratio and over-allocation against the post-hook numbers", () => {
    const hooks = hooksOf({
      resourceLoad: (i) => i.allocated * 3,
      resourceCapacity: (i) => i.capacity / 2,
    });
    const buckets = utilizationBuckets(res(), demands, range, "day", 1, 1, hooks);
    // Built-in Monday: allocated 1 × DAY, capacity 1 × DAY. After the hooks: 3 × DAY over 0.5 × DAY.
    expect(buckets[0]).toMatchObject({ allocated: 3 * DAY, capacity: 0.5 * DAY, ratio: 6 });
    expect(buckets[0]?.overallocated).toBe(true);
  });

  it("hands both hooks the built-in baselines and the bucket's working time", () => {
    const seen: ResourceBucketInput<unknown>[] = [];
    const copies: { workingMs: number; workingDays: number; capacityRate: number }[] = [];
    const hooks = hooksOf({
      resourceLoad: (i) => {
        seen.push(i);
        copies.push({
          workingMs: i.workingMs,
          workingDays: i.workingDays,
          capacityRate: i.capacityRate,
        });
        return i.allocated;
      },
      resourceCapacity: (i) => {
        // The capacity hook sees the built-in allocation, not the load hook's result.
        expect(i.allocated).toBe(5 * DAY);
        return i.capacity;
      },
    });
    const resource = res({ capacityRate: 0.5, name: "Ana", id: 7 });
    const buckets = utilizationBuckets(resource, demands, range, "week", 1, 1, hooks);
    expect(buckets).toHaveLength(1);
    expect(copies[0]).toEqual({ workingMs: 5 * DAY, workingDays: 5, capacityRate: 0.5 });
    expect(seen[0]?.resourceId).toBe(7);
    expect(seen[0]?.resourceName).toBe("Ana");
    expect(seen[0]?.bucketStart).toBe(MON);
    expect(seen[0]?.bucketEnd).toBe(MON + 7 * DAY);
  });

  it("reuses ONE input object per build across every call of that build", () => {
    const seen: ResourceBucketInput<unknown>[] = [];
    const hooks = hooksOf({
      resourceLoad: (i) => {
        seen.push(i);
        return i.allocated;
      },
    });
    utilizationBuckets(res(), demands, range, "day", 1, 1, hooks);
    expect(seen).toHaveLength(7);
    for (const input of seen) expect(input).toBe(seen[0]);
  });

  it("reports a throw and keeps the built-in value for that bucket, never retiring the hook", () => {
    const load = vi.fn((i: ResourceBucketInput<unknown>) =>
      i.bucketStart === MON
        ? (() => {
            throw new Error("boom");
          })()
        : i.allocated * 2,
    );
    const hooks = hooksOf({ resourceLoad: load });
    const buckets = utilizationBuckets(res(), demands, range, "day", 1, 1, hooks);
    // Monday keeps its built-in 1 × DAY; Tuesday still gets the hook's doubled value, because a
    // throw contains to its own call rather than latching the hook off.
    expect(buckets[0]?.allocated).toBe(DAY);
    expect(buckets[1]?.allocated).toBe(2 * DAY);
    expect(load).toHaveBeenCalledTimes(7);
    expect(hooks.faults).toHaveLength(1);
    expect(hooks.faults[0]?.[0]).toBe("resourceLoad");
  });

  // The ratio is `null` only when capacity is 0; the epsilon belongs to the over-allocation
  // verdict alone (§2.4). A 1e-6 epsilon keeps the same verdict a tighter 1e-9 epsilon would.
  it("keeps a ratio for a capacity below the over-allocation epsilon", () => {
    const hooks = hooksOf({ resourceLoad: () => 1e-12, resourceCapacity: () => 2e-12 });
    const buckets = utilizationBuckets(res(), demands, range, "day", 1, 1, hooks);
    expect(buckets[0]?.ratio).toBe(0.5);
    expect(buckets[0]?.overallocated).toBe(false);
  });

  it("falls back silently on a non-finite result", () => {
    const hooks = hooksOf({ resourceLoad: () => NaN, resourceCapacity: () => Infinity });
    const buckets = utilizationBuckets(res(), demands, range, "day", 1, 1, hooks);
    expect(buckets[0]).toMatchObject({ allocated: DAY, capacity: DAY, ratio: 1 });
    expect(hooks.faults).toEqual([]);
  });

  it("leaves the built-in numbers alone when neither hook is given", () => {
    const hooks = hooksOf();
    const buckets = utilizationBuckets(res(), demands, range, "day", 1, 1, hooks);
    expect(buckets[0]).toMatchObject({ allocated: DAY, capacity: DAY });
    expect(buckets).toHaveLength(7);
  });
});

describe("rollups and trend", () => {
  const range = { start: MON, end: MON + 5 * DAY }; // five working days
  const mk = (key: string, role: string | undefined, team: string | undefined, units: number) => {
    const resource = res({ id: key, name: key });
    return {
      role,
      team,
      cells: utilizationBuckets(
        resource,
        [{ start: MON, end: MON + 5 * DAY, units }],
        range,
        "day",
        1,
      ),
    };
  };

  it("zips per-resource series into trend points", () => {
    const points = trendPoints([
      mk("a", undefined, undefined, 2).cells,
      mk("b", undefined, undefined, 0.5).cells,
    ]);
    expect(points).toHaveLength(5);
    // Per day: demand (2 + 0.5) × DAY, supply 2 resources × 1 × DAY.
    expect(points[0]).toMatchObject({ start: MON, demand: 2.5 * DAY, supply: 2 * DAY });
  });

  it("returns no trend points for no series", () => {
    expect(trendPoints([])).toEqual([]);
  });

  it("rolls demand up by role, omitting roleless resources", () => {
    const roles = roleDemands([
      mk("a", "dev", undefined, 2),
      mk("b", "dev", undefined, 1),
      mk("c", undefined, undefined, 1),
    ]);
    // dev: (2 + 1) × 5 working days of demand against 2 × 5 working days of capacity.
    expect(roles).toEqual([{ role: "dev", demand: 15 * DAY, capacity: 10 * DAY, ratio: 1.5 }]);
  });

  it("summarizes teams with over-allocation counts", () => {
    const teams = teamSummaries([
      mk("a", undefined, "core", 2),
      mk("b", undefined, "core", 0.5),
      mk("c", undefined, undefined, 9),
    ]);
    expect(teams).toEqual([
      {
        team: "core",
        allocated: 12.5 * DAY, // (2 + 0.5) × 5 working days
        capacity: 10 * DAY, // 2 members × 5 working days
        available: 0,
        resourceCount: 2,
        overallocatedCount: 1,
      },
    ]);
  });

  it("reports the peak ratio over buckets", () => {
    expect(peakRatio(mk("a", undefined, undefined, 2).cells)).toBe(2);
    expect(peakRatio([])).toBeNull();
  });

  it("detects interval overlap", () => {
    const spans = [{ start: MON, end: MON + DAY }];
    expect(overlaps(spans, MON + DAY - 1, MON + 2 * DAY)).toBe(true);
    expect(overlaps(spans, MON + DAY, MON + 2 * DAY)).toBe(false);
  });
});
