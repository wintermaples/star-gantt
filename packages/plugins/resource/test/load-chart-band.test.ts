/**
 * The aggregate band's data half (docs/specs/plugins/resource.md §3.6): the built-in Σ`units`
 * histogram, the task-count fallback rule, the `resources` allowlist narrowing, the band-level
 * `load` / `capacity` overrides, Σ mode's column sums, and the accessible-name summary.
 */
import { describe, expect, it } from "vitest";
import {
  allowedResources,
  computeBuckets,
  createBandAggregator,
  isFallbackMode,
  sumMatrix,
  summarizeBucketResults,
} from "../src/internal/load-chart/band";
import type { AggregationConfig } from "../src/internal/load-chart/band";
import type { UtilizationMatrix } from "../src/internal/engine/compute";
import { dataView, MONDAY, MS_DAY } from "./load-chart-fixtures";

const plain: AggregationConfig = { resources: [], load: undefined, capacity: undefined };

describe("computeBuckets — the built-in Σ`units` histogram (§3.6)", () => {
  it("sums the assignment units of every task active in a bucket", () => {
    const view = dataView({
      tasks: [
        { id: "a", start: MONDAY, end: MONDAY + 2 * MS_DAY },
        { id: "b", start: MONDAY + MS_DAY, end: MONDAY + 3 * MS_DAY },
      ],
      resources: [{ id: "r1", name: "Alice" }],
      assignments: [
        { taskId: "a", resourceId: "r1", units: 1 },
        { taskId: "b", resourceId: "r1", units: 0.5 },
      ],
    });
    const results = computeBuckets(view, "day", MONDAY, MONDAY + 3 * MS_DAY, 1, plain);
    expect(results.map((r) => r.value)).toEqual([1, 1.5, 0.5]);
    // Σ(`capacity ?? 1`) is bucket-independent.
    expect(results.map((r) => r.capacity)).toEqual([1, 1, 1]);
  });

  it("excludes milestones and non-positive spans", () => {
    const view = dataView({
      tasks: [
        { id: "m", start: MONDAY, end: MONDAY },
        { id: "bad", start: MONDAY + MS_DAY, end: MONDAY },
      ],
      resources: [{ id: "r1", name: "Alice" }],
      assignments: [
        { taskId: "m", resourceId: "r1", units: 1 },
        { taskId: "bad", resourceId: "r1", units: 1 },
      ],
    });
    const results = computeBuckets(view, "day", MONDAY, MONDAY + MS_DAY, 1, plain);
    expect(results.map((r) => r.value)).toEqual([0]);
  });

  it("narrows bars AND the capacity line through the `resources` allowlist", () => {
    const view = dataView({
      tasks: [{ id: "a", start: MONDAY, end: MONDAY + MS_DAY }],
      resources: [
        { id: "r1", name: "Alice", capacity: 1 },
        { id: "r2", name: "Bob", capacity: 2 },
      ],
      assignments: [
        { taskId: "a", resourceId: "r1", units: 1 },
        { taskId: "a", resourceId: "r2", units: 1 },
      ],
    });
    const all = computeBuckets(view, "day", MONDAY, MONDAY + MS_DAY, 1, plain);
    expect(all[0]?.value).toBe(2);
    expect(all[0]?.capacity).toBe(3);

    const narrowed = computeBuckets(view, "day", MONDAY, MONDAY + MS_DAY, 1, {
      ...plain,
      resources: ["r2"],
    });
    expect(narrowed[0]?.value).toBe(1);
    expect(narrowed[0]?.capacity).toBe(2);
  });
});

describe("the task-count fallback (§3.6)", () => {
  const emptyStore = dataView({
    tasks: [
      { id: "a", start: MONDAY, end: MONDAY + 2 * MS_DAY },
      { id: "b", start: MONDAY + MS_DAY, end: MONDAY + 2 * MS_DAY },
    ],
  });

  it("counts active tasks and draws no capacity line when the store has neither side", () => {
    expect(isFallbackMode(emptyStore, plain)).toBe(true);
    const results = computeBuckets(emptyStore, "day", MONDAY, MONDAY + 2 * MS_DAY, 1, plain);
    expect(results.map((r) => r.value)).toEqual([1, 2]);
    expect(results.map((r) => r.capacity)).toEqual([null, null]);
  });

  it("never engages once a custom `load` is configured", () => {
    const config: AggregationConfig = { ...plain, load: () => 42 };
    expect(isFallbackMode(emptyStore, config)).toBe(false);
    const results = computeBuckets(emptyStore, "day", MONDAY, MONDAY + MS_DAY, 1, config);
    expect(results[0]?.value).toBe(42);
  });

  it("is tied to the STORE, not to the post-allowlist set: a filtered-out roster reads zero", () => {
    const view = dataView({
      tasks: [{ id: "a", start: MONDAY, end: MONDAY + MS_DAY }],
      resources: [{ id: "r1", name: "Alice" }],
      assignments: [{ taskId: "a", resourceId: "r1", units: 1 }],
    });
    const config: AggregationConfig = { ...plain, resources: ["nobody"] };
    expect(isFallbackMode(view, config)).toBe(false);
    const results = computeBuckets(view, "day", MONDAY, MONDAY + MS_DAY, 1, config);
    expect(results[0]?.value).toBe(0);
    expect(results[0]?.capacity).toBe(0);
  });
});

describe("the band-level `load` / `capacity` overrides (§6.5)", () => {
  const view = dataView({
    tasks: [{ id: "a", start: MONDAY, end: MONDAY + MS_DAY }],
    resources: [{ id: "r1", name: "Alice" }],
    assignments: [{ taskId: "a", resourceId: "r1", units: 1 }],
  });

  it("hands the already-narrowed tasks, resources and assignments to the custom functions", () => {
    const seen: { tasks: number; resources: number; assignments: number }[] = [];
    computeBuckets(view, "day", MONDAY, MONDAY + MS_DAY, 1, {
      resources: [],
      load: (input) => {
        seen.push({
          tasks: input.tasks.length,
          resources: input.resources.length,
          assignments: input.assignments.length,
        });
        return 5;
      },
      capacity: undefined,
    });
    expect(seen).toEqual([{ tasks: 1, resources: 1, assignments: 1 }]);
  });

  it("draws no line where a custom `capacity` answers `null`, keeping the built-in bar value", () => {
    const results = computeBuckets(view, "day", MONDAY, MONDAY + MS_DAY, 1, {
      resources: [],
      load: undefined,
      capacity: () => null,
    });
    expect(results[0]?.value).toBe(1);
    expect(results[0]?.capacity).toBeNull();
  });
});

describe("Σ mode column sums (§3.6)", () => {
  const matrix: UtilizationMatrix<never> = {
    bucket: "day",
    rows: [
      {
        resource: {
          id: "r1",
          name: "Alice",
          capacityRate: 1,
          workingIntervals: () => [],
          source: undefined as never,
        },
        cells: [
          { start: 0, end: MS_DAY, workingMs: MS_DAY, allocated: 3, capacity: 4, ratio: 0.75, overallocated: false },
          { start: MS_DAY, end: 2 * MS_DAY, workingMs: 0, allocated: 0, capacity: 0, ratio: null, overallocated: false },
        ],
      },
      {
        resource: {
          id: "r2",
          name: "Bob",
          capacityRate: 1,
          workingIntervals: () => [],
          source: undefined as never,
        },
        cells: [
          { start: 0, end: MS_DAY, workingMs: MS_DAY, allocated: 2, capacity: 1, ratio: 2, overallocated: true },
          { start: MS_DAY, end: 2 * MS_DAY, workingMs: 0, allocated: 0, capacity: 0, ratio: null, overallocated: false },
        ],
      },
    ],
  };

  it("sums allocated into the bar and capacity into the line, per bucket", () => {
    const results = sumMatrix(matrix);
    expect(results[0]).toMatchObject({ value: 5, capacity: 5 });
  });

  it("draws no line where the summed capacity is zero", () => {
    expect(sumMatrix(matrix)[1]?.capacity).toBeNull();
  });

  it("has no results at all for an empty matrix", () => {
    expect(sumMatrix({ bucket: "day", rows: [] })).toEqual([]);
  });
});

describe("createBandAggregator — the one aggregation seam (§3.6)", () => {
  const view = dataView({
    tasks: [{ id: "a", start: MONDAY, end: MONDAY + MS_DAY }],
    resources: [{ id: "r1", name: "Alice" }],
    assignments: [{ taskId: "a", resourceId: "r1", units: 1 }],
  });

  function matrix(rows: number): UtilizationMatrix<never> {
    return {
      bucket: "day",
      rows: Array.from({ length: rows }, (_, i) => ({
        resource: {
          id: `r${String(i)}`,
          name: `R${String(i)}`,
          capacityRate: 1,
          workingIntervals: () => [],
          source: undefined as never,
        },
        cells: [
          {
            start: MONDAY,
            end: MONDAY + MS_DAY,
            workingMs: MS_DAY,
            allocated: 7,
            capacity: 9,
            ratio: 7 / 9,
            overallocated: false,
          },
        ],
      })),
    };
  }

  it("resolves `\"auto\"` against the current zoom density, per call", () => {
    let density = 480;
    const aggregator = createBandAggregator({
      view: () => view,
      bucket: "auto",
      pxPerDay: () => density,
      weekStartDay: () => 1,
      aggregation: plain,
    });
    expect(aggregator.unit()).toBe("hour");
    density = 4;
    expect(aggregator.unit()).toBe("month");
  });

  it("sums the matrix in Σ mode, overriding the built-in aggregation entirely", () => {
    const aggregator = createBandAggregator({
      view: () => view,
      bucket: "day",
      pxPerDay: () => 40,
      weekStartDay: () => 1,
      aggregation: plain,
      matrix: () => matrix(2),
      rowCount: () => 2,
    });
    expect(aggregator.isSigma()).toBe(true);
    const results = aggregator.buckets(MONDAY, MONDAY + MS_DAY);
    expect(results[0]).toMatchObject({ value: 14, capacity: 18 });
    expect(aggregator.peak(MONDAY, MONDAY + MS_DAY)).toBe(18);
  });

  it("reverts to the built-in path — fallback included — when the matrix has no rows", () => {
    const emptyStore = dataView({ tasks: [{ id: "a", start: MONDAY, end: MONDAY + MS_DAY }] });
    const aggregator = createBandAggregator({
      view: () => emptyStore,
      bucket: "day",
      pxPerDay: () => 40,
      weekStartDay: () => 1,
      aggregation: plain,
      matrix: () => matrix(0),
      rowCount: () => 0,
    });
    expect(aggregator.isSigma()).toBe(false);
    expect(aggregator.isFallback()).toBe(true);
    expect(aggregator.buckets(MONDAY, MONDAY + MS_DAY)[0]).toMatchObject({
      value: 1,
      capacity: null,
    });
  });

  it("never reports the fallback while Σ mode is what it would return", () => {
    const emptyStore = dataView({ tasks: [{ id: "a", start: MONDAY, end: MONDAY + MS_DAY }] });
    const aggregator = createBandAggregator({
      view: () => emptyStore,
      bucket: "day",
      pxPerDay: () => 40,
      weekStartDay: () => 1,
      aggregation: plain,
      matrix: () => matrix(1),
      rowCount: () => 1,
    });
    expect(aggregator.isFallback()).toBe(false);
  });
});

describe("allowedResources (§2.3)", () => {
  const view = dataView({
    resources: [
      { id: "r1", name: "Alice" },
      { id: "r2", name: "Bob" },
    ],
  });

  it("keeps store order with no allowlist", () => {
    expect(allowedResources(view, []).map((r) => r.id)).toEqual(["r1", "r2"]);
  });

  it("follows the allowlist's own order and drops unknown and duplicate ids", () => {
    expect(allowedResources(view, ["r2", "r2", "ghost", "r1"]).map((r) => r.id)).toEqual([
      "r2",
      "r1",
    ]);
  });
});

describe("summarizeBucketResults — the `bandLabel` input (§7)", () => {
  it("reports the covered range, peaks and the overloaded-bucket count", () => {
    const summary = summarizeBucketResults(
      [
        { bucket: { start: 0, end: MS_DAY }, value: 3, capacity: 2 },
        { bucket: { start: MS_DAY, end: 2 * MS_DAY }, value: 1, capacity: 2 },
      ],
      0,
      2 * MS_DAY,
    );
    expect(summary).toEqual({
      rangeStart: 0,
      rangeEnd: 2 * MS_DAY,
      bucketCount: 2,
      peakLoad: 3,
      peakCapacity: 2,
      overloadedBuckets: 1,
    });
  });

  it("falls back to the queried range and a null peak capacity when nothing was drawn", () => {
    expect(summarizeBucketResults([], 10, 20)).toEqual({
      rangeStart: 10,
      rangeEnd: 20,
      bucketCount: 0,
      peakLoad: 0,
      peakCapacity: null,
      overloadedBuckets: 0,
    });
  });
});
