/**
 * `internal/cost/values.ts` + `internal/cost/rates.ts` — hostless storage reads/merges, cost-item
 * normalization and the rate master (docs/specs/plugins/tracking.md §2.1 / §2.8).
 *
 * Covers the `fields` and `rate store` behaviors for this area.
 */
import { describe, expect, it } from "vitest";
import type { ResourceId, Task } from "@stargantt/plugin-data-store";
import type { ResourcePoolEntry, ResourcePoolService } from "@stargantt/plugin-resource";
import { buildBagWrite } from "../src/internal/shared/meta-bag";
import {
  COST_META_KEY,
  mergeCostValues,
  readCostValues,
  resolveItemInit,
} from "../src/internal/cost/values";
import { createRateResolver, createRateStore } from "../src/internal/cost/rates";
import { DAY } from "./cost-helpers";

const taskWith = (meta: Record<string, unknown> | undefined): Task =>
  ({ id: "t", parentId: null, name: "t", start: 0, end: DAY, meta }) as Task;

describe("cost meta bag (§2.1)", () => {
  it("reads defensively: unusable members are treated as absent", () => {
    const values = readCostValues(
      taskWith({
        [COST_META_KEY]: {
          fixedCost: -5,
          materialCost: 30,
          actualCost: "x",
          costCode: "  CC-1  ",
          items: [
            { id: "a", amount: 10, type: "variable", label: "misc" },
            { id: "a", amount: 5, type: "variable" }, // duplicate id dropped
            { amount: 5, type: "nope" }, // bad type dropped
            { id: "b", amount: Number.NaN, type: "fixed" }, // bad amount dropped
          ],
        },
      }),
    );
    expect(values).toEqual({
      materialCost: 30,
      costCode: "CC-1",
      items: [{ id: "a", amount: 10, type: "variable", label: "misc" }],
    });
    expect(readCostValues(taskWith({ [COST_META_KEY]: "junk" }))).toEqual({});
    expect(readCostValues(taskWith(undefined))).toEqual({});
    expect(readCostValues(undefined)).toEqual({});
  });

  it("merges scalars: undefined removes, unusable dropped, items preserved", () => {
    const current = readCostValues(
      taskWith({
        [COST_META_KEY]: { fixedCost: 5, items: [{ id: "a", amount: 1, type: "labor", label: "" }] },
      }),
    );
    const merged = mergeCostValues(current, {
      fixedCost: undefined,
      actualCost: 12,
      costCode: "   ",
    });
    expect(merged.fixedCost).toBeUndefined();
    expect(merged.actualCost).toBe(12);
    expect(merged.costCode).toBeUndefined();
    expect(merged.items).toHaveLength(1);
  });

  it("the bag write preserves sibling meta keys and clears an emptied meta", () => {
    const withSibling = taskWith({ other: 1 });
    expect(buildBagWrite(withSibling, COST_META_KEY, { fixedCost: 2 })).toEqual({
      after: { meta: { other: 1, [COST_META_KEY]: { fixedCost: 2 } } },
    });
    const onlyCost = taskWith({ [COST_META_KEY]: { fixedCost: 2 } });
    expect(buildBagWrite(onlyCost, COST_META_KEY, {})).toEqual({ after: {}, clears: ["meta"] });
  });

  it("resolveItemInit rejects bad inits and generates non-colliding ids", () => {
    const existing = [{ id: "cost-item-1", amount: 1, type: "fixed" as const, label: "" }];
    expect(resolveItemInit([], { amount: -1, type: "fixed" }, () => "x")).toBeUndefined();
    expect(resolveItemInit([], { amount: 1 }, () => "x")).toBeUndefined();
    expect(
      resolveItemInit([...existing], { id: "cost-item-1", amount: 1, type: "fixed" }, () => "x"),
    ).toBeUndefined();
    let n = 0;
    const item = resolveItemInit([...existing], { amount: 2, type: "material" }, () =>
      n++ === 0 ? "cost-item-1" : "cost-item-2",
    );
    expect(item).toEqual({ id: "cost-item-2", amount: 2, type: "material", label: "" });
  });
});

describe("rate master (§2.8)", () => {
  it("seeds usable entries and updates member-wise", () => {
    const rates = createRateStore([
      { resourceId: "r1", standard: 100, overtime: 150 },
      { resourceId: "r2", standard: -1 }, // unusable: dropped
      { standard: 50 }, // no id: dropped
    ]);
    expect(rates.get("r1")).toEqual({ standard: 100, overtime: 150 });
    expect(rates.get("r2")).toBeUndefined();
    expect(rates.set("r1", { overtime: 200 })).toBe(true);
    expect(rates.get("r1")).toEqual({ standard: 100, overtime: 200 });
    expect(rates.set("r1", { standard: 100, overtime: 200 })).toBe(false); // no change
    expect(rates.set("r3", { overtime: 10 })).toBe(false); // no standard yet
    expect(rates.remove("r1")).toBe(true);
    expect(rates.remove("r1")).toBe(false);
  });

  it("entries() hands out an independent snapshot", () => {
    const rates = createRateStore([{ resourceId: "r1", standard: 10 }]);
    const snapshot = rates.entries();
    rates.set("r2", { standard: 20 });
    expect(snapshot.size).toBe(1);
    expect(rates.entries().size).toBe(2);
  });
});

/** A minimal, fully-typed `ResourcePoolEntry` — only `costRate` varies per test. */
function poolEntry(id: ResourceId, costRate: number): ResourcePoolEntry {
  return { id, name: id.toString(), kind: "person", skills: [], billable: true, costRate };
}

describe("rateOf resolution order (§2.8)", () => {
  it("prefers the master, then the pool's costRate, then undefined", () => {
    const rates = createRateStore([]);
    const pool: Pick<ResourcePoolService, "get"> = {
      get: (id) => (id === "r1" ? poolEntry("r1", 5) : undefined),
    };
    const rateOf = createRateResolver(rates, () => pool);
    expect(rateOf("r1")).toEqual({ standard: 5 });
    expect(rateOf("r2")).toBeUndefined();
    rates.set("r1", { standard: 7 });
    expect(rateOf("r1")).toEqual({ standard: 7 }); // the master wins
  });

  it("resolves the pool PER USE, never latching it (§8)", () => {
    // A pool that is absent at first — the composition activated it later — and whose `costRate`
    // is then edited in place. Both must be seen without any invalidation call.
    let pool: Pick<ResourcePoolService, "get"> | undefined;
    let lookups = 0;
    const rateOf = createRateResolver(createRateStore([]), () => {
      lookups += 1;
      return pool;
    });
    expect(rateOf("r1")).toBeUndefined();
    let costRate = 5;
    pool = { get: () => poolEntry("r1", costRate) };
    expect(rateOf("r1")).toEqual({ standard: 5 });
    costRate = 6;
    expect(rateOf("r1")).toEqual({ standard: 6 });
    expect(lookups).toBe(3); // one fresh lookup per call
  });
});
