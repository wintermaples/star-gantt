/**
 * docs/specs/plugins/tracking.md §2.9 — EVERY cost aggregate enumerates leaf tasks
 * only: a parent's own fixed cost and assignments are ignored by rollups (never double-counted
 * beside its children) while the per-task reads — `costOf`, `costValuesOf`, `costs()` — keep
 * answering for the parent.
 */
import { afterEach, describe, expect, it } from "vitest";
import { DAY, bootCost, task } from "./cost-helpers";
import type { CostBoot } from "./cost-helpers";

let boot: CostBoot | undefined;
afterEach(() => {
  boot?.dispose();
  boot = undefined;
});

/**
 * A parent spanning two children. The parent carries its own fixed cost, an assignment and an
 * actual — the classic rolled-up summary row — none of which may enter any aggregate.
 *
 * Rate r1 = 10/h at the default 8 h/day: the parent's own labor would be 10d × 8h × 10 = 800, c1's
 * labor is 5d × 8h × 10 = 400; c2 carries a fixed cost of 50 and no actual.
 */
function loadTree(b: CostBoot): void {
  b.data.load({
    tasks: [
      task("p", 0, 10 * DAY, {
        meta: { costTracking: { fixedCost: 100, actualCost: 999, costCode: "X" } },
      }),
      task("c1", 0, 5 * DAY, {
        parentId: "p",
        meta: { costTracking: { costCode: "X", actualCost: 500 } },
      }),
      task("c2", 5 * DAY, 10 * DAY, {
        parentId: "p",
        meta: { costTracking: { fixedCost: 50 } },
      }),
    ],
    resources: [{ id: "r1", name: "Dev" }],
    assignments: [
      { taskId: "p", resourceId: "r1", units: 1 },
      { taskId: "c1", resourceId: "r1", units: 1 },
    ],
  });
}

const config = { cost: { rates: [{ resourceId: "r1", standard: 10 }] } };

describe("leaf-only aggregation (§2.9)", () => {
  it("keeps the parent's own cost readable per task", () => {
    boot = bootCost(config);
    loadTree(boot);
    expect(boot.service.costOf("p")).toMatchObject({
      labor: 800,
      fixed: 100,
      estimated: 900,
      actual: 999,
    });
    expect(boot.service.costValuesOf("p")).toMatchObject({ fixedCost: 100, actualCost: 999 });
    // `costs()` is a per-task read, so it is NOT leaf-filtered.
    expect(boot.service.costs().map((c) => c.id)).toEqual(["p", "c1", "c2"]);
  });

  it("excludes the parent from breakdowns, including an explicit ids subset", () => {
    boot = bootCost(config);
    loadTree(boot);
    // Leaves only: c1's labor 400 and c2's fixed 50 — no 800/100 from the parent.
    expect(boot.service.breakdown()).toEqual({ labor: 400, fixed: 50, variable: 0, material: 0 });
    expect(boot.service.breakdown(["p", "c1"])).toEqual({
      labor: 400,
      fixed: 0,
      variable: 0,
      material: 0,
    });
    // Code "X" totals only c1; the parent's coded 900/999 stays out.
    expect(boot.service.breakdownByCode().get("X")).toEqual({ estimated: 400, actual: 500 });
  });

  it("returns comparison rows for leaves only", () => {
    boot = bootCost(config);
    loadTree(boot);
    expect(boot.service.comparison().map((r) => r.id)).toEqual(["c1", "c2"]);
  });

  it("computes alert thresholds over leaves", () => {
    // Project budget 500: the leaf estimated total is 450 (≤ 500), so no project alert — with the
    // parent's 900 counted it would fire. c1 alerts (actual 500 > estimated 400); the parent's
    // 999 > 900 must not. Code X's leaf estimated total is 400 ≤ 450 — likewise.
    boot = bootCost({ cost: { ...config.cost, budget: 500, budgets: { X: 450 } } });
    loadTree(boot);
    expect(boot.service.alerts()).toEqual([
      { kind: "task", subject: "c1", value: 500, limit: 400 },
    ]);
  });

  it("snapshots baselines and variance over leaves", () => {
    boot = bootCost(config);
    loadTree(boot);
    const baseline = boot.service.saveCostBaseline();
    expect(baseline.totalEstimated).toBe(450);
    expect(baseline.totalActual).toBe(500);
    expect([...baseline.tasks.keys()].sort()).toEqual(["c1", "c2"]);
    expect(boot.service.costVariance().map((r) => r.id)).toEqual(["c1", "c2"]);
  });

  it("accrues the cost curve — and the forecast — from leaves only", () => {
    boot = bootCost({ cost: { ...config.cost, statusDate: 10 * DAY } });
    loadTree(boot);
    const points = boot.service.costCurve();
    expect(points[points.length - 1]?.planned).toBeCloseTo(450, 9);
    const forecast = boot.service.costForecast();
    expect(forecast).toHaveLength(points.length);
  });

  it("re-derives the leaf set when a leaf becomes a parent by reparenting", () => {
    // c1 gains a new child, so it stops being a leaf: the memoized leaf list must be recomputed on
    // the `data.tasks` notification the command fires, not answer from a stale snapshot.
    boot = bootCost(config);
    loadTree(boot);
    expect(
      boot.service
        .comparison()
        .map((r) => r.id)
        .sort(),
    ).toEqual(["c1", "c2"]);

    boot.host.host.dispatch("task/add", {
      task: { id: "g", parentId: "c1", name: "G", start: 0, end: 5 * DAY },
    });

    // c1 no longer counts (it now has a child "g"); c2 and the new leaf "g" do.
    expect(
      boot.service
        .comparison()
        .map((r) => r.id)
        .sort(),
    ).toEqual(["c2", "g"]);
  });

  it("all-ancestors chain: only the true leaf at the bottom counts", () => {
    boot = bootCost(config);
    boot.data.load({
      tasks: [
        task("p1", 0, 10 * DAY, { meta: { costTracking: { fixedCost: 100 } } }),
        task("p2", 0, 10 * DAY, { parentId: "p1", meta: { costTracking: { fixedCost: 200 } } }),
        task("leaf", 0, 10 * DAY, { parentId: "p2", meta: { costTracking: { fixedCost: 5 } } }),
      ],
    });
    // p1 and p2 are both ancestors — their 100/200 fixed costs are excluded; only "leaf"'s 5 counts.
    expect(boot.service.breakdown()).toEqual({ labor: 0, fixed: 5, variable: 0, material: 0 });
    expect(boot.service.comparison().map((r) => r.id)).toEqual(["leaf"]);
  });

  it("empty tree: every aggregate is the empty/zero identity", () => {
    boot = bootCost(config);
    expect(boot.service.breakdown()).toEqual({ labor: 0, fixed: 0, variable: 0, material: 0 });
    expect(boot.service.breakdownByCode().size).toBe(0);
    expect(boot.service.comparison()).toEqual([]);
    expect(boot.service.alerts()).toEqual([]);
    expect(boot.service.costs()).toEqual([]);
    expect(boot.service.costCurve()).toEqual([]);
    expect(boot.service.costForecast()).toEqual([]);
    const baseline = boot.service.saveCostBaseline();
    expect(baseline.totalEstimated).toBe(0);
    expect(baseline.tasks.size).toBe(0);
  });
});
