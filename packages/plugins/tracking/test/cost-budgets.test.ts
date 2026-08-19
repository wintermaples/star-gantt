/**
 * `internal/cost/compute.ts` + `internal/cost/budgets.ts` — hostless composition, threshold math and
 * cost-baseline variance (docs/specs/plugins/tracking.md §2.8 / §2.9 / §2.10).
 *
 * Every function under test is pure: a hand-built `ReadonlyDataView` is the only input, so nothing
 * here boots a core or touches a DOM. Covers the `variance rows` behavior plus the alert/comparison
 * halves of the service.
 */
import { describe, expect, it } from "vitest";
import { computeTaskCost, createCostWorld, laborCostOf, taskOver } from "../src/internal/cost/compute";
import {
  comparisonRows,
  computeAlerts,
  costVarianceRows,
  createCostBaselineStore,
  currentCostEntries,
  snapshotCostBaseline,
} from "../src/internal/cost/budgets";
import type { CostBaseline } from "../src/types";
import { DAY, task, viewOf } from "./cost-helpers";

const RATES = new Map([
  ["r1", { standard: 10 }],
  ["r2", { standard: 20, overtime: 30 }],
]);
const rateOf = (id: string | number): { standard: number; overtime?: number } | undefined =>
  RATES.get(String(id));

const withCost = (values: Record<string, unknown>): { meta: Record<string, unknown> } => ({
  meta: { costTracking: values },
});

describe("labor cost (§2.8)", () => {
  it("costs standard allocation and overtime above full-time separately", () => {
    const t = task("b", 10 * DAY, 15 * DAY);
    // 5 days × 8 h = 40 h, costed 1 unit at 20/h plus 0.5 unit at the 30/h overtime rate.
    expect(laborCostOf(t, [{ taskId: "b", resourceId: "r2", units: 1.5 }], rateOf, 8)).toBe(1400);
  });

  it("contributes 0 for unrated resources and for zero-or-negative spans", () => {
    const t = task("a", 0, 10 * DAY);
    expect(laborCostOf(t, [{ taskId: "a", resourceId: "nobody", units: 1 }], rateOf, 8)).toBe(0);
    const milestone = task("m", 3 * DAY, 3 * DAY, { type: "milestone" });
    expect(laborCostOf(milestone, [{ taskId: "m", resourceId: "r1", units: 1 }], rateOf, 8)).toBe(0);
    const reversed = task("x", 5 * DAY, DAY);
    expect(laborCostOf(reversed, [{ taskId: "x", resourceId: "r1", units: 1 }], rateOf, 8)).toBe(0);
  });

  it("falls back to the standard rate when no overtime rate is registered", () => {
    const t = task("a", 0, DAY);
    // 8 h, 1 unit at 10 plus 1 unit of overtime also at 10.
    expect(laborCostOf(t, [{ taskId: "a", resourceId: "r1", units: 2 }], rateOf, 8)).toBe(160);
  });
});

describe("computeTaskCost (§2.9 composition)", () => {
  it("composes labor / fixed / variable / material and sums them into `estimated`", () => {
    const t = task("a", 0, 10 * DAY, {
      ...withCost({
        fixedCost: 100,
        materialCost: 50,
        actualCost: 4242,
        items: [
          { id: "i1", amount: 40, type: "variable", label: "rental" },
          { id: "i2", amount: 7, type: "labor", label: "bonus" },
          { id: "i3", amount: 3, type: "fixed", label: "permit" },
          { id: "i4", amount: 1, type: "material", label: "screws" },
        ],
      }),
    });
    const cost = computeTaskCost(t, [{ taskId: "a", resourceId: "r1", units: 1 }], rateOf, 8);
    expect(cost).toEqual({
      id: "a",
      labor: 800 + 7,
      fixed: 100 + 3,
      variable: 40,
      material: 50 + 1,
      estimated: 807 + 103 + 40 + 51,
      actual: 4242,
    });
  });

  it("`actual` is the RECORDED figure only — never derived from assignments", () => {
    const t = task("a", 0, 10 * DAY);
    expect(computeTaskCost(t, [{ taskId: "a", resourceId: "r1", units: 1 }], rateOf, 8).actual).toBe(0);
    const recorded = task("b", 0, 10 * DAY, { ...withCost({ actualCost: 5 }) });
    expect(computeTaskCost(recorded, [{ taskId: "b", resourceId: "r1", units: 1 }], rateOf, 8)).toMatchObject({
      labor: 800,
      actual: 5,
    });
  });

  it("is side-effect free: the same inputs answer identically, repeatedly", () => {
    const t = task("a", 0, 10 * DAY, { ...withCost({ fixedCost: 1 }) });
    const assignments = [{ taskId: "a" as const, resourceId: "r1", units: 1 }];
    const first = computeTaskCost(t, assignments, rateOf, 8);
    const second = computeTaskCost(t, assignments, rateOf, 8);
    expect(second).toEqual(first);
    expect(second).not.toBe(first); // a fresh object each call
    expect(t.meta).toEqual({ costTracking: { fixedCost: 1 } }); // the task was not mutated
  });
});

describe("taskOver (§2.10)", () => {
  const cost = { id: "a", labor: 0, fixed: 100, variable: 0, material: 0, estimated: 100, actual: 0 };
  it("needs a positive estimate and a strictly greater actual", () => {
    expect(taskOver({ ...cost, actual: 100 }, 1)).toBe(false);
    expect(taskOver({ ...cost, actual: 100.01 }, 1)).toBe(true);
    expect(taskOver({ ...cost, estimated: 0, actual: 999 }, 1)).toBe(false);
    expect(taskOver({ ...cost, actual: 60 }, 0.5)).toBe(true);
    expect(taskOver({ ...cost, actual: 40 }, 0.5)).toBe(false);
  });
});

describe("comparison rows and alerts (§2.10)", () => {
  const world = (): ReturnType<typeof createCostWorld> =>
    createCostWorld(
      viewOf([
        task("a", 0, 10 * DAY, { ...withCost({ fixedCost: 80, actualCost: 90, costCode: "X" }) }),
        task("b", 10 * DAY, 15 * DAY, { ...withCost({ fixedCost: 30 }) }),
      ]),
      () => undefined,
      8,
    );

  it("flags tasks over the threshold and project/code budget overruns, in order", () => {
    const alerts = computeAlerts(world(), 1, 100, new Map([["X", 10]]));
    expect(alerts).toEqual([
      { kind: "task", subject: "a", value: 90, limit: 80 },
      { kind: "costCode", subject: "X", value: 80, limit: 10 },
      { kind: "project", value: 110, limit: 100 },
    ]);
  });

  it("emits no alert without a budget, and none for a task at exactly its estimate", () => {
    expect(computeAlerts(world(), 2, undefined, new Map())).toEqual([]);
  });

  it("builds one comparison row per task, with the textual over flag", () => {
    const rows = comparisonRows(world(), 1);
    expect(rows[0]).toEqual({
      id: "a",
      name: "task a",
      estimated: 80,
      actual: 90,
      variance: 10,
      costCode: "X",
      over: true,
    });
    expect(rows[1]?.over).toBe(false);
    expect(rows[1]).not.toHaveProperty("costCode");
  });
});

describe("cost baselines and variance (§2.10)", () => {
  it("stores baselines oldest-first, defaults the target to the most recent, and removes", () => {
    const store = createCostBaselineStore();
    expect(store.get(undefined)).toBeUndefined();
    const first = { id: store.generateId(), name: "one", date: 0, tasks: new Map(), totalEstimated: 0, totalActual: 0 };
    store.add(first);
    expect(store.saveCount()).toBe(1);
    const second = { ...first, id: store.generateId(), name: "two" };
    store.add(second);
    expect(store.all().map((b) => b.id)).toEqual(["cost-baseline-1", "cost-baseline-2"]);
    expect(store.get(undefined)?.id).toBe("cost-baseline-2");
    expect(store.get("cost-baseline-1")?.name).toBe("one");
    expect(store.get("nope")).toBeUndefined();
    expect(store.remove("cost-baseline-2")).toBe(true);
    expect(store.remove("cost-baseline-2")).toBe(false);
    expect(store.get(undefined)?.id).toBe("cost-baseline-1");
    // The save counter never rewinds — the next default name keeps climbing.
    expect(store.saveCount()).toBe(2);
  });

  it("snapshots each leaf task's estimated/actual plus the totals", () => {
    const w = createCostWorld(
      viewOf([
        task("a", 0, DAY, { ...withCost({ fixedCost: 10, actualCost: 4 }) }),
        task("b", 0, DAY, { ...withCost({ fixedCost: 5 }) }),
      ]),
      () => undefined,
      8,
    );
    const baseline = snapshotCostBaseline(w, "bl", "Cost baseline 1", 1234);
    expect(baseline).toMatchObject({ id: "bl", name: "Cost baseline 1", date: 1234, totalEstimated: 15, totalActual: 4 });
    expect(baseline.tasks.get("a")).toEqual({ estimated: 10, actual: 4 });
  });

  it("pairs current and baseline tasks, counting a missing side as 0", () => {
    const baseline: CostBaseline = {
      id: "b1",
      name: "b1",
      date: 0,
      tasks: new Map([
        ["a", { estimated: 100, actual: 0 }],
        ["gone", { estimated: 50, actual: 0 }],
      ]),
      totalEstimated: 150,
      totalActual: 0,
    };
    const rows = costVarianceRows(
      [
        { id: "a", name: "A", estimated: 120 },
        { id: "new", name: "N", estimated: 30 },
      ],
      baseline,
    );
    expect(rows).toEqual([
      { id: "a", name: "A", baselineEstimated: 100, currentEstimated: 120, variance: 20 },
      { id: "new", name: "N", baselineEstimated: 0, currentEstimated: 30, variance: 30 },
      { id: "gone", name: "gone", baselineEstimated: 50, currentEstimated: 0, variance: -50 },
    ]);
  });

  it("`currentCostEntries` reports the leaf side in store order", () => {
    const w = createCostWorld(
      viewOf([
        task("p", 0, DAY, { ...withCost({ fixedCost: 999 }) }),
        task("c", 0, DAY, { parentId: "p", ...withCost({ fixedCost: 3 }) }),
      ]),
      () => undefined,
      8,
    );
    expect(currentCostEntries(w)).toEqual([{ id: "c", name: "task c", estimated: 3 }]);
  });
});
