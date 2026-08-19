// docs/specs/plugins/tracking.md §2.8 / §2.9 — hostless cost math: labor cost from assignments and
// rates, the per-task composition, and the leaf-only enumeration every AGGREGATE surface uses.
//
// Nothing in this module touches a `PluginContext`, a service or a store: `computeTaskCost` is a
// pure function of (task, its assignments, a rate lookup, hoursPerDay), which is what lets the EVM
// area call it — through `CostService.costOf` — as an ordinary, side-effect-free computation.
import { MS_DAY } from "@stargantt/sdk";
import type { Assignment, ReadonlyDataView, Task, TaskId } from "@stargantt/plugin-data-store";
import type { CostBreakdown, CostType, CostValues, TaskCost } from "../../types";
import type { RateLookup } from "./rates";
import { readCostValues } from "./values";

/* ------------------------------------------------------------------ *
 * §2.8 labor effort
 * ------------------------------------------------------------------ */

// §2.8: labor effort is the task's ELAPSED calendar span at the configured
// hours-per-day density — the plugin deliberately consults no working calendar, because switching
// sources would silently reprice every existing plan.
//
// The reduced form `(elapsedMs / MS_DAY) × hoursPerDay` is the one evaluated, and that choice is
// load-bearing rather than cosmetic: §2.8's guarantee that money output is unchanged is EXACT, and
// multiplying up to milliseconds only to divide straight back down is not bit-exact in IEEE-754 (a
// 7-day span at `hoursPerDay: 7.4` lands on 51.80000000000001 hours instead of 51.800000000000004,
// moving the money by an ulp). Evaluating the reduced form keeps the identity an identity.
/**
 * Labor cost of one task: per assignment, the elapsed span converted to effort hours at the given
 * density; allocation up to full-time costed at the standard rate, allocation above full-time at
 * the overtime rate (falling back to standard). Assignments whose resource has no resolvable rate
 * contribute 0, as do milestones and other zero-or-negative spans.
 */
export function laborCostOf(
  task: Readonly<Task>,
  assignments: readonly Assignment[],
  rateOf: RateLookup,
  hoursPerDay: number,
): number {
  const elapsedMs = Math.max(0, task.end - task.start);
  if (elapsedMs === 0) return 0;
  const effortHours = (elapsedMs / MS_DAY) * hoursPerDay;
  let total = 0;
  for (const a of assignments) {
    const rate = rateOf(a.resourceId);
    if (rate === undefined) continue;
    const standardUnits = Math.min(a.units, 1);
    const overtimeUnits = Math.max(a.units - 1, 0);
    total += effortHours * standardUnits * rate.standard;
    total += effortHours * overtimeUnits * (rate.overtime ?? rate.standard);
  }
  return total;
}

function sumItems(values: Readonly<CostValues>, type: CostType): number {
  let total = 0;
  for (const item of values.items ?? []) if (item.type === type) total += item.amount;
  return total;
}

/* ------------------------------------------------------------------ *
 * §2.9 per-task composition
 * ------------------------------------------------------------------ */

/**
 * Composes one task's cost by component (§1.3's `TaskCost` comments, §2.9).
 *
 * PURE: every input is a parameter. `actual` is NOT computed from assignments — it is purely the
 * manually recorded `values.actualCost`, 0 when none is recorded.
 *
 * This is the computation `CostService.costOf` answers with, and the one the EVM area consumes.
 */
export function computeTaskCost(
  task: Readonly<Task>,
  assignments: readonly Assignment[],
  rateOf: RateLookup,
  hoursPerDay: number,
  values: Readonly<CostValues> = readCostValues(task),
): TaskCost {
  const labor = laborCostOf(task, assignments, rateOf, hoursPerDay) + sumItems(values, "labor");
  const fixed = (values.fixedCost ?? 0) + sumItems(values, "fixed");
  const variable = sumItems(values, "variable");
  const material = (values.materialCost ?? 0) + sumItems(values, "material");
  return {
    id: task.id,
    labor,
    fixed,
    variable,
    material,
    estimated: labor + fixed + variable + material,
    actual: values.actualCost ?? 0,
  };
}

/** Whether a task's actual trips the threshold against its own estimate (§2.10). */
export function taskOver(cost: TaskCost, threshold: number): boolean {
  return cost.estimated > 0 && cost.actual > threshold * cost.estimated;
}

/* ------------------------------------------------------------------ *
 * The world — one consistent view per computation
 * ------------------------------------------------------------------ */

/**
 * What every cost computation sees of the data, built once per invalidation window over a
 * `ReadonlyDataView` (which the data store hands out with stable identity and live indexes).
 */
export interface CostWorld {
  /** Every task, in store order. Per-task reads answer for ALL of these (§2.9). */
  tasks(): readonly Readonly<Task>[];
  /**
   * The tasks no other task names as its parent — the ONLY tasks an aggregate enumerates (§2.9):
   * a parent's own cost fields and assignments are ignored by rollups while staying
   * readable per task.
   */
  leafTasks(): readonly Readonly<Task>[];
  /** The task's assignments, live off the view's own grouping. */
  assignmentsOf(id: TaskId): readonly Assignment[];
  /** The task's stored manual cost values (defensive read). */
  valuesOf(task: Readonly<Task>): Readonly<CostValues>;
  /** The task's composed cost. */
  costOf(task: Readonly<Task>): TaskCost;
}

/** Builds the world over one data view. Task/leaf lists materialize lazily, once each. */
export function createCostWorld(
  view: ReadonlyDataView,
  rateOf: RateLookup,
  hoursPerDay: number,
): CostWorld {
  let all: readonly Readonly<Task>[] | undefined;
  let leaves: readonly Readonly<Task>[] | undefined;

  const tasks = (): readonly Readonly<Task>[] => (all ??= [...view.byId.values()]);
  const leafTasks = (): readonly Readonly<Task>[] =>
    // A task with at least one child is not a leaf. `children` is the data view's own
    // parent→children index, so no second parent scan is needed.
    (leaves ??= tasks().filter((t) => (view.children.get(t.id)?.length ?? 0) === 0));

  const assignmentsOf = (id: TaskId): readonly Assignment[] =>
    view.assignmentsByTask.get(id) ?? [];

  return {
    tasks,
    leafTasks,
    assignmentsOf,
    valuesOf: readCostValues,
    costOf: (task) =>
      computeTaskCost(task, assignmentsOf(task.id), rateOf, hoursPerDay, readCostValues(task)),
  };
}

/* ------------------------------------------------------------------ *
 * §2.9 aggregate surfaces
 * ------------------------------------------------------------------ */

/**
 * Computed costs for EVERY task, in store order (§2.9: "per-task reads … answer for every task,
 * parents included" — `costs()` is deliberately NOT leaf-filtered).
 */
export function costsOf(world: CostWorld): TaskCost[] {
  return world.tasks().map((task) => world.costOf(task));
}

/** Totals per cost type over a task set (§2.9; callers pass a leaf-filtered set). */
export function breakdownOf(world: CostWorld, tasks: readonly Readonly<Task>[]): CostBreakdown {
  const out: CostBreakdown = { labor: 0, fixed: 0, variable: 0, material: 0 };
  for (const task of tasks) {
    const cost = world.costOf(task);
    out.labor += cost.labor;
    out.fixed += cost.fixed;
    out.variable += cost.variable;
    out.material += cost.material;
  }
  return out;
}

/** Estimated/actual totals grouped by trimmed cost code, `""` for uncoded LEAF tasks (§2.9). */
export function breakdownByCodeOf(
  world: CostWorld,
): Map<string, { estimated: number; actual: number }> {
  const out = new Map<string, { estimated: number; actual: number }>();
  // Aggregates enumerate leaf tasks only.
  for (const task of world.leafTasks()) {
    const cost = world.costOf(task);
    const code = world.valuesOf(task).costCode ?? "";
    const bucket = out.get(code) ?? { estimated: 0, actual: 0 };
    bucket.estimated += cost.estimated;
    bucket.actual += cost.actual;
    out.set(code, bucket);
  }
  return out;
}
