// docs/specs/plugins/tracking.md §2.10 — budgets, threshold alerts and the budget-vs-actual
// comparison, plus the session-local COST baselines and their variance report.
//
// Cost baselines are a SEPARATE concept from the tracking plugin's schedule `BaselinesService`
// baselines (§1.1): these are cost-only snapshots of each LEAF task's estimated/actual figures,
// session-local and outside the undo pipeline.
import type { TaskId } from "@stargantt/plugin-data-store";
import type {
  BudgetComparisonRow,
  CostAlert,
  CostBaseline,
  CostVarianceRow,
} from "../../types";
import type { CostWorld } from "./compute";
import { taskOver } from "./compute";

/* ------------------------------------------------------------------ *
 * §2.10 comparison rows and alerts — leaf-only
 * ------------------------------------------------------------------ */

/** Budget-vs-actual rows, one per LEAF task in store order (§2.9/§2.10). */
export function comparisonRows(world: CostWorld, threshold: number): BudgetComparisonRow[] {
  return world.leafTasks().map((task) => {
    const cost = world.costOf(task);
    const code = world.valuesOf(task).costCode;
    const row: BudgetComparisonRow = {
      id: task.id,
      name: task.name,
      estimated: cost.estimated,
      actual: cost.actual,
      variance: cost.actual - cost.estimated,
      over: taskOver(cost, threshold),
    };
    if (code !== undefined) row.costCode = code;
    return row;
  });
}

/**
 * Active threshold alerts, tasks first, then cost codes, then the project (§2.10).
 *
 * With `t = alertThreshold`: a task alerts when `actual > t × estimated` and `estimated > 0`; a
 * cost code alerts when a budget is set for it and its estimated total is `> t × budget`; the
 * project likewise against the project budget. Every total covers LEAF tasks only.
 */
export function computeAlerts(
  world: CostWorld,
  threshold: number,
  projectBudget: number | undefined,
  codeBudgets: ReadonlyMap<string, number>,
): CostAlert[] {
  const out: CostAlert[] = [];
  let totalEstimated = 0;
  const codeTotals = new Map<string, number>();
  // Task alerts and the code/project estimated totals cover leaf tasks only.
  for (const task of world.leafTasks()) {
    const cost = world.costOf(task);
    totalEstimated += cost.estimated;
    const code = world.valuesOf(task).costCode;
    if (code !== undefined) codeTotals.set(code, (codeTotals.get(code) ?? 0) + cost.estimated);
    if (taskOver(cost, threshold)) {
      out.push({
        kind: "task",
        subject: String(task.id),
        value: cost.actual,
        limit: threshold * cost.estimated,
      });
    }
  }
  for (const [code, budget] of codeBudgets) {
    const estimated = codeTotals.get(code) ?? 0;
    if (estimated > threshold * budget) {
      out.push({ kind: "costCode", subject: code, value: estimated, limit: threshold * budget });
    }
  }
  if (projectBudget !== undefined && totalEstimated > threshold * projectBudget) {
    out.push({ kind: "project", value: totalEstimated, limit: threshold * projectBudget });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Cost baselines (session-local)
 * ------------------------------------------------------------------ */

export interface CostBaselineStore {
  all(): readonly CostBaseline[];
  /** The named baseline, or — with no id — the most recent one. */
  get(id: string | undefined): CostBaseline | undefined;
  add(baseline: CostBaseline): void;
  remove(id: string): boolean;
  /** How many baselines have ever been saved (drives default naming). */
  saveCount(): number;
  generateId(): string;
}

export function createCostBaselineStore(): CostBaselineStore {
  const baselines: CostBaseline[] = [];
  let saves = 0;
  let nextId = 1;
  return {
    all: () => [...baselines],
    get(id) {
      if (id === undefined) return baselines[baselines.length - 1];
      return baselines.find((b) => b.id === id);
    },
    add(baseline) {
      baselines.push(baseline);
      saves += 1;
    },
    remove(id) {
      const at = baselines.findIndex((b) => b.id === id);
      if (at < 0) return false;
      baselines.splice(at, 1);
      return true;
    },
    saveCount: () => saves,
    generateId: () => `cost-baseline-${String(nextId++)}`,
  };
}

/** Snapshots every LEAF task's estimated/actual cost into a new baseline (§2.9). */
export function snapshotCostBaseline(
  world: CostWorld,
  id: string,
  name: string,
  date: number,
): CostBaseline {
  const tasks = new Map<TaskId, { estimated: number; actual: number }>();
  let totalEstimated = 0;
  let totalActual = 0;
  // The baseline snapshots leaf tasks only.
  for (const task of world.leafTasks()) {
    const cost = world.costOf(task);
    tasks.set(task.id, { estimated: cost.estimated, actual: cost.actual });
    totalEstimated += cost.estimated;
    totalActual += cost.actual;
  }
  return { id, name, date, tasks, totalEstimated, totalActual };
}

/** One current task's identity and estimate, in store order. */
export interface CurrentCostEntry {
  id: TaskId;
  name: string;
  estimated: number;
}

/** The current (leaf-only) side of a cost-variance comparison. */
export function currentCostEntries(world: CostWorld): CurrentCostEntry[] {
  return world.leafTasks().map((task) => ({
    id: task.id,
    name: task.name,
    estimated: world.costOf(task).estimated,
  }));
}

/**
 * Variance rows against a baseline: one row per task present on either side, current store order
 * first, then baseline-only tasks; a task missing from one side counts 0 there.
 */
export function costVarianceRows(
  current: readonly CurrentCostEntry[],
  baseline: CostBaseline,
): CostVarianceRow[] {
  const out: CostVarianceRow[] = [];
  const seen = new Set<TaskId>();
  for (const entry of current) {
    const base = baseline.tasks.get(entry.id)?.estimated ?? 0;
    seen.add(entry.id);
    out.push({
      id: entry.id,
      name: entry.name,
      baselineEstimated: base,
      currentEstimated: entry.estimated,
      variance: entry.estimated - base,
    });
  }
  for (const [id, cost] of baseline.tasks) {
    if (seen.has(id)) continue;
    out.push({
      id,
      name: String(id),
      baselineEstimated: cost.estimated,
      currentEstimated: 0,
      variance: -cost.estimated,
    });
  }
  return out;
}
