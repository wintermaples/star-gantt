/**
 * `stargantt.cost` — the assembled `CostService` over a real core host and the real data store
 * (docs/specs/plugins/tracking.md §1.3 / §2.8–§2.12).
 *
 * Covers the four `costTracking/changed` assertions, re-expressed against the `state` STORE
 * that replaces the abolished event (§1/§4), and the `budget()` / `costBaselines()` reads
 * folded into `state.get()`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DAY, bootCost, task } from "./cost-helpers";
import type { CostBoot } from "./cost-helpers";

let boot: CostBoot | undefined;
afterEach(() => {
  boot?.dispose();
  boot = undefined;
});

/** Loads two tasks with one assigned resource each; task "a" spans 10 days, "b" spans 5. */
function loadProject(b: CostBoot): void {
  b.data.load({
    tasks: [task("a", 0, 10 * DAY), task("b", 10 * DAY, 15 * DAY)],
    resources: [
      { id: "r1", name: "Dev" },
      { id: "r2", name: "Rig" },
    ],
    assignments: [
      { taskId: "a", resourceId: "r1", units: 1 },
      { taskId: "b", resourceId: "r2", units: 1.5 },
    ],
  });
}

describe("rate master and labor cost (§2.8)", () => {
  it("computes labor from span × hoursPerDay × units × rate, overtime above full-time", () => {
    boot = bootCost({
      cost: {
        rates: [
          { resourceId: "r1", standard: 10 },
          { resourceId: "r2", standard: 20, overtime: 30 },
        ],
      },
    });
    loadProject(boot);
    // a: 10 days × 8 h × 1 × 10 = 800
    expect(boot.service.costOf("a")).toMatchObject({ labor: 800, estimated: 800, actual: 0 });
    // b: 5 days × 8 h × (1 × 20 + 0.5 × 30) = 40 h × 35 = 1400
    expect(boot.service.costOf("b")?.labor).toBe(1400);
    expect(boot.service.costOf("nope")).toBeUndefined();
  });

  it("respects hoursPerDay and treats unrated resources as 0", () => {
    boot = bootCost({ cost: { hoursPerDay: 4, rates: [{ resourceId: "r1", standard: 10 }] } });
    loadProject(boot);
    expect(boot.service.costOf("a")?.labor).toBe(400);
    expect(boot.service.costOf("b")?.labor).toBe(0);
  });

  it("falls back to the resource pool's costRate when the master has no entry", () => {
    const pool = new Map([["r1", { costRate: 5 }]]);
    boot = bootCost({ cost: {} }, { resourcePool: { get: (id) => pool.get(String(id)) } });
    loadProject(boot);
    expect(boot.service.rateOf("r1")).toEqual({ standard: 5 });
    expect(boot.service.costOf("a")?.labor).toBe(10 * 8 * 5);
    // The master, once set, wins over the pool.
    boot.service.setRate("r1", { standard: 7 });
    expect(boot.service.rateOf("r1")).toEqual({ standard: 7 });
    // …and removing it hands the resolution back to the pool.
    boot.service.removeRate("r1");
    expect(boot.service.rateOf("r1")).toEqual({ standard: 5 });
  });

  it("refreshes costs after a pool costRate edit that follows a cached read (§8, per-use lookup)", () => {
    // A pool edit mutates no store data and fires no event this plugin can see, so the resolution
    // must be genuinely per-use rather than cached behind an invalidation edge.
    const entry = { costRate: 5 };
    boot = bootCost({ cost: {} }, { resourcePool: { get: () => entry } });
    loadProject(boot);
    expect(boot.service.costOf("a")?.labor).toBe(10 * 8 * 5);
    entry.costRate = 6;
    expect(boot.service.rateOf("r1")).toEqual({ standard: 6 });
    expect(boot.service.costOf("a")?.labor).toBe(10 * 8 * 6);
  });

  it("ignores unusable rates and sets the state store only on real changes", () => {
    boot = bootCost({ cost: {} });
    const sets: number[] = [];
    boot.service.state.subscribe((next) => sets.push(next.rates.size));
    boot.service.setRate("r1", { standard: -3 });
    expect(boot.service.rateOf("r1")).toBeUndefined();
    expect(sets).toEqual([]);
    boot.service.setRate("r1", { standard: 3 });
    expect(sets).toEqual([1]);
    boot.service.setRate("r1", { standard: 3 }); // no change
    expect(sets).toEqual([1]);
    boot.service.removeRate("nobody"); // unknown id
    expect(sets).toEqual([1]);
    boot.service.removeRate("r1");
    expect(sets).toEqual([1, 0]);
  });

  it("the config seed is already in the store's INITIAL value (§1.3)", () => {
    boot = bootCost({
      cost: { rates: [{ resourceId: "r1", standard: 10 }], budget: 500, budgets: { X: 5 } },
    });
    const state = boot.service.state.get();
    expect(state.rates.get("r1")).toEqual({ standard: 10 });
    expect(state.budget).toBe(500);
    expect(state.codeBudgets.get("X")).toBe(5);
    expect(state.baselines).toEqual([]);
  });

  it("a dormant cost nest still provides a fully functional service over §5.3 defaults", () => {
    boot = bootCost({}); // no `cost` nest at all
    loadProject(boot);
    expect(boot.service.state.get()).toEqual({
      rates: new Map(),
      budget: undefined,
      codeBudgets: new Map(),
      baselines: [],
    });
    boot.service.setRate("r1", { standard: 10 });
    // hoursPerDay defaults to 8.
    expect(boot.service.costOf("a")?.labor).toBe(800);
    expect(boot.service.comparison()).toHaveLength(2);
    // …but no panel can open.
    expect(boot.service.openCostTablePanel()).toBe(false);
  });
});

describe("manual cost fields and items (§2.1)", () => {
  it("stores fixed/material/actual/costCode via task/update and clears an emptied meta", () => {
    boot = bootCost({ cost: {} });
    loadProject(boot);
    boot.service.setCostFields("a", { fixedCost: 100, materialCost: 50, costCode: "CC-1" });
    expect(boot.service.costValuesOf("a")).toEqual({
      fixedCost: 100,
      materialCost: 50,
      costCode: "CC-1",
    });
    expect(boot.service.costOf("a")).toMatchObject({ fixed: 100, material: 50, estimated: 150 });
    boot.service.setCostFields("a", {
      fixedCost: undefined,
      materialCost: undefined,
      costCode: undefined,
    });
    expect(boot.data.getTask("a")?.meta).toBeUndefined();
  });

  it("preserves sibling meta keys", () => {
    boot = bootCost({ cost: {} });
    boot.data.load([task("a", 0, DAY, { meta: { other: 1 } })]);
    boot.service.setCostFields("a", { fixedCost: 10 });
    expect(boot.data.getTask("a")?.meta).toEqual({ other: 1, costTracking: { fixedCost: 10 } });
    boot.service.setCostFields("a", { fixedCost: undefined });
    expect(boot.data.getTask("a")?.meta).toEqual({ other: 1 });
  });

  it("skips the dispatch (and the undo entry) when a patch resolves to what is already stored", () => {
    boot = bootCost({ cost: {} });
    loadProject(boot);
    boot.service.setCostFields("a", { fixedCost: 100 });
    const changed = vi.fn();
    boot.data.tasks.subscribe(changed);
    // Re-sending the same value (as the table panel's Apply would for an unedited cell) must not
    // dispatch: no store notification, no new undo step.
    boot.service.setCostFields("a", { fixedCost: 100 });
    expect(changed).not.toHaveBeenCalled();
    // An absent key is untouched, so this patch is also a no-op against current storage.
    boot.service.setCostFields("a", {});
    expect(changed).not.toHaveBeenCalled();
    boot.service.setCostFields("nope", { fixedCost: 1 }); // unknown task
    expect(changed).not.toHaveBeenCalled();
    // A genuinely different value still dispatches normally.
    boot.service.setCostFields("a", { fixedCost: 200 });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(boot.service.costValuesOf("a")).toEqual({ fixedCost: 200 });
  });

  it("adds and removes classified cost items, aggregated per type", () => {
    boot = bootCost({ cost: {} });
    loadProject(boot);
    const id = boot.service.addCostItem("a", { label: "rental", amount: 40, type: "variable" });
    expect(id).toBeDefined();
    expect(boot.service.addCostItem("a", { amount: 40, type: "junk" as never })).toBeUndefined();
    expect(boot.service.addCostItem("nope", { amount: 1, type: "fixed" })).toBeUndefined();
    boot.service.addCostItem("a", { amount: 10, type: "material" });
    expect(boot.service.costOf("a")).toMatchObject({ variable: 40, material: 10, estimated: 50 });
    boot.service.removeCostItem("a", id as string);
    expect(boot.service.costOf("a")?.variable).toBe(0);
    boot.service.removeCostItem("a", "gone"); // unknown item: no-op
    expect(boot.service.costOf("a")?.material).toBe(10);
  });

  it("breaks down by type and by cost code", () => {
    boot = bootCost({ cost: { rates: [{ resourceId: "r1", standard: 1 }] } });
    loadProject(boot);
    boot.service.setCostFields("a", { fixedCost: 10, costCode: "X" });
    boot.service.setCostFields("b", { materialCost: 20, actualCost: 5 });
    expect(boot.service.breakdown()).toEqual({ labor: 80, fixed: 10, variable: 0, material: 20 });
    expect(boot.service.breakdown(["b"])).toEqual({
      labor: 0,
      fixed: 0,
      variable: 0,
      material: 20,
    });
    const byCode = boot.service.breakdownByCode();
    expect(byCode.get("X")).toEqual({ estimated: 90, actual: 0 });
    expect(byCode.get("")).toEqual({ estimated: 20, actual: 5 });
  });

  it("`costs()` answers for EVERY task, in store order (§2.9)", () => {
    boot = bootCost({ cost: {} });
    boot.data.load([
      task("p", 0, DAY, { meta: { costTracking: { fixedCost: 7 } } }),
      task("c", 0, DAY, { parentId: "p", meta: { costTracking: { fixedCost: 3 } } }),
    ]);
    expect(boot.service.costs().map((c) => [c.id, c.estimated])).toEqual([
      ["p", 7],
      ["c", 3],
    ]);
  });
});

describe("budgets and alerts (§2.10)", () => {
  it("flags tasks over the threshold and project/code budget overruns", () => {
    boot = bootCost({ cost: { budget: 100, budgets: { X: 10 }, alertThreshold: 1 } });
    loadProject(boot);
    boot.service.setCostFields("a", { fixedCost: 80, actualCost: 90, costCode: "X" });
    boot.service.setCostFields("b", { fixedCost: 30 });
    expect(boot.service.alerts()).toEqual([
      { kind: "task", subject: "a", value: 90, limit: 80 },
      { kind: "costCode", subject: "X", value: 80, limit: 10 },
      { kind: "project", value: 110, limit: 100 },
    ]);
    const rows = boot.service.comparison();
    expect(rows[0]).toMatchObject({ id: "a", estimated: 80, actual: 90, variance: 10, over: true });
    expect(rows[1]?.over).toBe(false);
  });

  it("setBudget / setBudgetForCode mutate and clear, ignoring unusable values", () => {
    boot = bootCost({ cost: {} });
    const budget = (): number | undefined => boot!.service.state.get().budget;
    boot.service.setBudget(500);
    expect(budget()).toBe(500);
    boot.service.setBudget(Number.NaN);
    expect(budget()).toBe(500);
    boot.service.setBudget(undefined);
    expect(budget()).toBeUndefined();
    boot.service.setBudgetForCode(" X ", 50);
    expect(boot.service.budgetForCode("X")).toBe(50);
    expect(boot.service.state.get().codeBudgets.get("X")).toBe(50);
    boot.service.setBudgetForCode("  ", 50); // unusable code
    expect(boot.service.state.get().codeBudgets.size).toBe(1);
    boot.service.setBudgetForCode("X", undefined);
    expect(boot.service.budgetForCode("X")).toBeUndefined();
  });

  it("applies a fractional alert threshold", () => {
    boot = bootCost({ cost: { alertThreshold: 0.5 } });
    loadProject(boot);
    boot.service.setCostFields("a", { fixedCost: 100, actualCost: 60 });
    expect(boot.service.alerts()).toEqual([{ kind: "task", subject: "a", value: 60, limit: 50 }]);
  });
});

describe("cost baselines (§2.10)", () => {
  it("saves, names, compares and removes baselines", () => {
    boot = bootCost({ cost: {} }, { now: 4242 });
    loadProject(boot);
    boot.service.setCostFields("a", { fixedCost: 100 });
    const baseline = boot.service.saveCostBaseline();
    expect(baseline.name).toBe("Cost baseline 1");
    expect(baseline.totalEstimated).toBe(100);
    expect(baseline.date).toBe(4242);
    boot.service.setCostFields("a", { fixedCost: 130 });
    expect(boot.service.costVariance().find((r) => r.id === "a")).toMatchObject({
      baselineEstimated: 100,
      currentEstimated: 130,
      variance: 30,
    });
    const named = boot.service.saveCostBaseline("  Q3  ");
    expect(named.name).toBe("Q3");
    expect(boot.service.state.get().baselines).toHaveLength(2);
    boot.service.removeCostBaseline(baseline.id);
    expect(boot.service.state.get().baselines).toHaveLength(1);
    // The default variance target is now the latest remaining baseline.
    expect(boot.service.costVariance().find((r) => r.id === "a")?.baselineEstimated).toBe(130);
    expect(boot.service.costVariance("unknown")).toEqual([]);
  });

  it("costVariance is empty without any baseline", () => {
    boot = bootCost({ cost: {} });
    loadProject(boot);
    expect(boot.service.costVariance()).toEqual([]);
  });
});

describe("cost curve and forecast (§2.11)", () => {
  it("builds the cumulative curve at a fixed status date", () => {
    boot = bootCost({ cost: { statusDate: 5 * DAY } });
    loadProject(boot);
    boot.service.setCostFields("a", { fixedCost: 1000, actualCost: 400 });
    const mid = boot.service.costCurve().find((p) => p.t === 5 * DAY);
    expect(mid).toEqual({ t: 5 * DAY, planned: 500, actual: 400 });
    const forecast = boot.service.costForecast();
    // f = 400/500 = 0.8; total planned = 1000 → forecast total 400 + 0.8 × 500 = 800.
    expect(forecast[forecast.length - 1]?.forecast).toBeCloseTo(800);
  });

  it("without a configured status date, the current UTC day is re-read per call", () => {
    boot = bootCost({ cost: {} }, { now: 0 });
    boot.data.load([task("a", 0, 10 * DAY)]);
    boot.service.setCostFields("a", { fixedCost: 1000 });
    expect(boot.service.costCurve().map((p) => p.t)).toEqual([0, 10 * DAY]);
    // Move the clock into the middle of the task: the status date joins the sample set.
    boot.setNow(5 * DAY + 3);
    expect(boot.service.costCurve().map((p) => p.t)).toEqual([0, 5 * DAY, 10 * DAY]);
  });
});

describe("panel gating (§2.16 + §5)", () => {
  it("every open… returns false and mounts nothing while `stargantt.view` does not resolve", () => {
    boot = bootCost({ cost: {} });
    expect(boot.service.openCostTablePanel()).toBe(false);
    expect(boot.service.openCostCurvePanel()).toBe(false);
    expect(boot.service.openBreakdownPanel()).toBe(false);
    boot.service.closePanels(); // a no-op when none is open
  });

  it("…and likewise while the cost nest is dormant, even with a view composed", () => {
    boot = bootCost({}, { view: true });
    expect(boot.service.openCostTablePanel()).toBe(false);
    expect(boot.service.openCostCurvePanel()).toBe(false);
    expect(boot.service.openBreakdownPanel()).toBe(false);
  });
});
