/**
 * The per-resource `resourceLoad` / `resourceCapacity` hooks on the matrix, expressed through the
 * unified engine's one choke point (docs/specs/plugins/resource.md §2.4).
 *
 * Σ mode, the lane/band accessible names and the CSV report are band/lane/report CONSUMER
 * behavior (§2.6 item 6, §3.6) and are exercised elsewhere. What the engine owns — post-hook
 * ratios and verdicts, baseline-fed hooks, one reused input per build, per-build containment,
 * unlatched reporting, the silent non-finite fallback — is asserted here against
 * `computeUtilization` with `edges: "aligned"`.
 *
 * Epoch day 0 (1970-01-01) is a Thursday, so days 0 and 1 are working days under the shared default
 * calendar and each contributes a full `MS_DAY` of working time.
 */
import { describe, expect, it, vi } from "vitest";
import type { ResourceBucketInput } from "@stargantt/sdk";
import { computeUtilization } from "../src/internal/engine/compute";
import type { BucketInput, EngineHooks } from "../src/internal/engine/compute";
import { MS_DAY, engineResource, loadChartDemands, loadChartRoster } from "./_engine";
import type { Store, StoreResource } from "./_engine";

/**
 * Alice (rate 1) and Bob (rate 2) both work the whole of day 0 at `units: 1`, so the built-in
 * matrix reads: allocated `MS_DAY` each, capacity `MS_DAY` and `2 × MS_DAY`.
 */
function twoResources(days = 1): Store {
  return {
    tasks: [{ id: "t1", start: 0, end: days * MS_DAY }],
    resources: [
      { id: "r1", name: "Alice", capacity: 1 },
      { id: "r2", name: "Bob", capacity: 2 },
    ],
    assignments: [
      { taskId: "t1", resourceId: "r1", units: 1 },
      { taskId: "t1", resourceId: "r2", units: 1 },
    ],
  };
}

function report(
  store: Store,
  hooks?: EngineHooks<StoreResource>,
  days = 1,
): ReturnType<typeof computeUtilization<StoreResource>> {
  const roster = loadChartRoster(store, undefined);
  const input: BucketInput<StoreResource> = {
    resources: roster,
    demands: loadChartDemands(store, roster),
    start: 0,
    end: days * MS_DAY,
    bucket: "day",
    edges: "aligned",
    weekStartDay: 1,
    ...(hooks === undefined ? {} : { hooks }),
  };
  return computeUtilization(input);
}

describe("per-resource hooks on the matrix (§2.4)", () => {
  it("lets `resourceLoad` replace a cell's allocation, and recomputes ratio and overload", () => {
    // Alice's built-in cell is `MS_DAY` allocated over `MS_DAY` capacity (ratio 1, not over);
    // doubling the allocation must make it ratio 2 and overloaded.
    const matrix = report(twoResources(), {
      resourceLoad: (input) => (input.resourceId === "r1" ? input.allocated * 2 : input.allocated),
    });
    const alice = matrix.rows[0]!.cells[0]!;
    expect(alice.allocated).toBe(2 * MS_DAY);
    expect(alice.capacity).toBe(MS_DAY);
    expect(alice.ratio).toBe(2);
    expect(alice.overallocated).toBe(true);
    // Bob is untouched: `MS_DAY` over `2 × MS_DAY`.
    expect(matrix.rows[1]!.cells[0]!.allocated).toBe(MS_DAY);
    expect(matrix.rows[1]!.cells[0]!.ratio).toBe(0.5);
    expect(matrix.rows[1]!.cells[0]!.overallocated).toBe(false);
  });

  it("lets `resourceCapacity` replace a cell's capacity", () => {
    const matrix = report(twoResources(), {
      resourceCapacity: (input) =>
        input.resourceId === "r1" ? input.capacity / 2 : input.capacity,
    });
    const alice = matrix.rows[0]!.cells[0]!;
    expect(alice.capacity).toBe(MS_DAY / 2);
    expect(alice.ratio).toBe(2);
  });

  it("hands the hook the documented per-resource, per-bucket input", () => {
    const seen: ResourceBucketInput<StoreResource>[] = [];
    report(twoResources(), {
      resourceLoad: (input) => {
        // The object is reused, so a test that keeps it must copy — exactly what the SDK type says.
        seen.push({ ...input });
        return input.allocated;
      },
    });
    const alice = seen.find((i) => i.resourceId === "r1")!;
    expect(alice.resourceName).toBe("Alice");
    expect(alice.resource.id).toBe("r1");
    expect(alice.capacityRate).toBe(1);
    expect(alice.bucketStart).toBe(0);
    expect(alice.bucketEnd).toBe(MS_DAY);
    // One whole working day inside a one-day bucket.
    expect(alice.workingMs).toBe(MS_DAY);
    expect(alice.workingDays).toBe(1);
    expect(alice.allocated).toBe(MS_DAY);
    expect(alice.capacity).toBe(MS_DAY);
    const bob = seen.find((i) => i.resourceId === "r2")!;
    expect(bob.capacityRate).toBe(2);
    expect(bob.capacity).toBe(2 * MS_DAY);
  });

  it("reuses one input object across every call of a build, one per build", () => {
    const identities = new Set<unknown>();
    const hooks: EngineHooks<StoreResource> = {
      resourceLoad: (input) => {
        identities.add(input);
        return input.allocated;
      },
    };
    report(twoResources(2), hooks, 2);
    // Two resources × two buckets = four calls of one build, one object.
    expect(identities.size).toBe(1);
    // §2.4 — the lifetime is the build, so the next one brings its own object rather than
    // rewriting one a re-entrant caller might still be reading.
    report(twoResources(2), hooks, 2);
    expect(identities.size).toBe(2);
  });

  it("gives a re-entrant build its own input, so the running call's fields survive", () => {
    const capacitySeen: {
      resourceId: string | number;
      resourceName: string;
      bucketStart: number;
    }[] = [];
    let armed = true;
    let reentered = false;
    let depth = 0;
    const store = twoResources(2);
    const hooks: EngineHooks<StoreResource> = {
      resourceLoad: (input) => {
        if (armed && depth === 0) {
          armed = false;
          reentered = true;
          depth += 1;
          try {
            report(store, hooks, 2);
          } finally {
            depth -= 1;
          }
        }
        return input.allocated;
      },
      resourceCapacity: (input) => {
        if (depth === 0) {
          capacitySeen.push({
            resourceId: input.resourceId,
            resourceName: input.resourceName,
            bucketStart: input.bucketStart,
          });
        }
        return input.capacity;
      },
    };
    const matrix = report(store, hooks, 2);
    expect(reentered).toBe(true);
    // The outer build's very first capacity call is the one the re-entrant load hook interrupted:
    // it must still describe Alice's first bucket, not the last cell of the nested build.
    expect(capacitySeen[0]).toEqual({ resourceId: "r1", resourceName: "Alice", bucketStart: 0 });
    // Two resources × two buckets, each call describing its own cell, in row-major order.
    expect(capacitySeen.slice(0, 4)).toEqual([
      { resourceId: "r1", resourceName: "Alice", bucketStart: 0 },
      { resourceId: "r1", resourceName: "Alice", bucketStart: MS_DAY },
      { resourceId: "r2", resourceName: "Bob", bucketStart: 0 },
      { resourceId: "r2", resourceName: "Bob", bucketStart: MS_DAY },
    ]);
    // The matrix itself is unharmed: a full working day of allocation in every cell.
    expect(matrix.rows[0]!.cells[0]!.allocated).toBe(MS_DAY);
    expect(matrix.rows[1]!.cells[1]!.allocated).toBe(MS_DAY);
  });

  it("hands `resourceCapacity` the built-in baselines even after `resourceLoad` replaced one", () => {
    let seenAllocated = -1;
    report(twoResources(), {
      resourceLoad: () => 999,
      resourceCapacity: (input) => {
        if (input.resourceId === "r1") seenAllocated = input.allocated;
        return input.capacity;
      },
    });
    expect(seenAllocated).toBe(MS_DAY);
  });
});

describe("hook containment (§2.4)", () => {
  it("reports a throwing hook once per build, names it, and keeps the built-in value", () => {
    const reported: { where: string; error: unknown }[] = [];
    const matrix = report(twoResources(), {
      resourceLoad: () => {
        throw new Error("boom");
      },
      onError: (where, error) => reported.push({ where, error }),
    });
    // One report for the build, whatever the number of failing cells (two resources here).
    expect(reported).toHaveLength(1);
    expect(reported[0]!.where).toBe("resourceLoad");
    // No cell is omitted and each keeps its built-in number.
    expect(matrix.rows).toHaveLength(2);
    expect(matrix.rows[0]!.cells[0]!.allocated).toBe(MS_DAY);
  });

  it("is unlatched: a later build reports again", () => {
    const reported: string[] = [];
    const hooks: EngineHooks<StoreResource> = {
      resourceCapacity: () => {
        throw new Error("boom");
      },
      onError: (where) => reported.push(where),
    };
    report(twoResources(), hooks);
    report(twoResources(), hooks);
    expect(reported).toEqual(["resourceCapacity", "resourceCapacity"]);
  });

  it("keeps a throw contained to its own call rather than latching the hook off", () => {
    const load = vi.fn((input: ResourceBucketInput<StoreResource>) =>
      input.bucketStart === 0
        ? (() => {
            throw new Error("boom");
          })()
        : input.allocated * 2,
    );
    const matrix = report(twoResources(2), { resourceLoad: load }, 2);
    // Day 0 keeps its built-in `MS_DAY`; day 1 still gets the hook's doubled value.
    expect(matrix.rows[0]!.cells[0]!.allocated).toBe(MS_DAY);
    expect(matrix.rows[0]!.cells[1]!.allocated).toBe(2 * MS_DAY);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it("falls back silently on a non-finite result", () => {
    const reported: string[] = [];
    const matrix = report(twoResources(), {
      resourceLoad: () => Number.NaN,
      resourceCapacity: () => Infinity,
      onError: (where) => reported.push(where),
    });
    expect(matrix.rows[0]!.cells[0]!.allocated).toBe(MS_DAY);
    expect(matrix.rows[0]!.cells[0]!.capacity).toBe(MS_DAY);
    expect(reported).toEqual([]);
  });

  it("leaves the built-in numbers alone when neither hook is given", () => {
    const matrix = report(twoResources());
    expect(matrix.rows[0]!.cells[0]!.allocated).toBe(MS_DAY);
    expect(matrix.rows[0]!.cells[0]!.capacity).toBe(MS_DAY);
  });
});

describe("hook-pair agnosticism (§2.4 — whichever pair the build carries applies)", () => {
  it("calls only for the roster the build was handed (the one-row narrowing of §1.2)", () => {
    const seen: (string | number)[] = [];
    computeUtilization({
      resources: [engineResource({ id: "p1", name: "Ana" })],
      demands: new Map([["p1", [{ start: 0, end: MS_DAY, units: 1 }]]]),
      start: 0,
      end: MS_DAY,
      bucket: "day",
      edges: "clamped",
      weekStartDay: 1,
      hooks: {
        resourceLoad: (input) => {
          seen.push(input.resourceId);
          return input.allocated;
        },
      },
    });
    expect(seen).toEqual(["p1"]);
  });
});
