/**
 * The resource lanes' row model (docs/specs/plugins/resource.md §3.6): the three lane scales, the
 * per-lane reference value, the overload count, and the shared ceiling.
 */
import { describe, expect, it } from "vitest";
import { buildLaneModel, EMPTY_LANE_MODEL } from "../src/internal/load-chart/lanes-model";
import type { UtilizationCell, UtilizationMatrix } from "../src/internal/engine/compute";
import type { Resource } from "@stargantt/plugin-data-store";
import { dataView, MS_DAY } from "./load-chart-fixtures";

function cell(over: Partial<UtilizationCell> & Pick<UtilizationCell, "start" | "end">): UtilizationCell {
  const allocated = over.allocated ?? 0;
  const capacity = over.capacity ?? 0;
  return {
    workingMs: over.workingMs ?? capacity,
    allocated,
    capacity,
    ratio: capacity > 0 ? allocated / capacity : null,
    overallocated: allocated > capacity,
    ...over,
  };
}

function matrixOf(
  rows: readonly { resource: Resource; cells: readonly UtilizationCell[] }[],
): UtilizationMatrix<Resource> {
  return {
    bucket: "day",
    rows: rows.map((row) => ({
      resource: {
        id: row.resource.id,
        name: row.resource.name,
        capacityRate: row.resource.capacity ?? 1,
        workingIntervals: () => [],
        source: row.resource,
      },
      cells: row.cells,
    })),
  };
}

const alice: Resource = { id: "r1", name: "Alice", capacity: 1 };
const bob: Resource = { id: "r2", name: "Bob", capacity: 2 };

const twoRows = matrixOf([
  {
    resource: alice,
    cells: [
      cell({ start: 0, end: MS_DAY, allocated: MS_DAY / 2, capacity: MS_DAY }),
      cell({ start: MS_DAY, end: 2 * MS_DAY, allocated: 2 * MS_DAY, capacity: MS_DAY }),
    ],
  },
  {
    resource: bob,
    cells: [
      cell({ start: 0, end: MS_DAY, allocated: MS_DAY, capacity: 2 * MS_DAY }),
      cell({ start: MS_DAY, end: 2 * MS_DAY, allocated: MS_DAY, capacity: 2 * MS_DAY }),
    ],
  },
]);

const view = dataView({ resources: [alice, bob] });

describe("buildLaneModel (§3.6)", () => {
  it("has an empty model for an empty matrix", () => {
    expect(buildLaneModel({ view, matrix: { bucket: "day", rows: [] }, fromT: 0, toT: 1, scale: "ratio" })).toBe(
      EMPTY_LANE_MODEL,
    );
  });

  it("draws utilization fractions under `\"ratio\"`, with the 100 % mark as every lane's line", () => {
    const model = buildLaneModel({ view, matrix: twoRows, fromT: 0, toT: 2 * MS_DAY, scale: "ratio" });
    expect(model.rows[0]?.results.map((r) => r.value)).toEqual([0.5, 2]);
    expect(model.rows[0]?.results.map((r) => r.capacity)).toEqual([1, 1]);
    expect(model.rows[0]?.lineValue).toBe(1);
    // The shared ceiling is `max(1, largest ratio)`, so the 100 % mark aligns across lanes.
    expect(model.sharedMax).toBe(2);
  });

  it("draws working milliseconds under `\"shared\"`, each bucket against its own capacity", () => {
    const model = buildLaneModel({ view, matrix: twoRows, fromT: 0, toT: 2 * MS_DAY, scale: "shared" });
    expect(model.rows[0]?.results.map((r) => r.value)).toEqual([MS_DAY / 2, 2 * MS_DAY]);
    expect(model.rows[0]?.results.map((r) => r.capacity)).toEqual([MS_DAY, MS_DAY]);
    expect(model.sharedMax).toBe(2 * MS_DAY);
  });

  it("leaves every lane to its own peak under `\"auto\"`", () => {
    const model = buildLaneModel({ view, matrix: twoRows, fromT: 0, toT: 2 * MS_DAY, scale: "auto" });
    expect(model.sharedMax).toBeUndefined();
  });

  it("counts a lane's over-allocated buckets from the post-hook matrix verdict", () => {
    const model = buildLaneModel({ view, matrix: twoRows, fromT: 0, toT: 2 * MS_DAY, scale: "ratio" });
    expect(model.rows[0]?.overloadedBuckets).toBe(1);
    expect(model.rows[1]?.overloadedBuckets).toBe(0);
  });

  it("carries the resource's dimensionless capacity RATE for the accessible name", () => {
    const model = buildLaneModel({ view, matrix: twoRows, fromT: 0, toT: 2 * MS_DAY, scale: "ratio" });
    expect(model.rows.map((r) => r.capacity)).toEqual([1, 2]);
  });

  it("reports the rendered bucket range and count", () => {
    const model = buildLaneModel({ view, matrix: twoRows, fromT: 0, toT: 2 * MS_DAY, scale: "ratio" });
    expect(model).toMatchObject({ rangeStart: 0, rangeEnd: 2 * MS_DAY, bucketCount: 2 });
  });

  it("draws no bar for a zero-capacity bucket under `\"ratio\"` while its line stays at 1", () => {
    const zeroCapacity = matrixOf([
      { resource: alice, cells: [cell({ start: 0, end: MS_DAY, allocated: MS_DAY, capacity: 0 })] },
    ]);
    const model = buildLaneModel({ view, matrix: zeroCapacity, fromT: 0, toT: MS_DAY, scale: "ratio" });
    expect(model.rows[0]?.results[0]).toMatchObject({ value: 0, capacity: 1 });
  });
});
