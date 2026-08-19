// docs/specs/plugins/tracking.md §7 — entry point of the COST area: wiring + service assembly.
/**
 * Builds `stargantt.cost`'s `CostService` (§1.3, 26 members) and, when the `cost` nest is present
 * AND `stargantt.view` resolves, its three panels.
 *
 * **Presence semantics (§5 preamble, §1).** The SERVICE is built UNCONDITIONALLY, over §5.3's
 * defaults when `config.cost === undefined` (`rates: []`, `hoursPerDay: 8`, no project budget,
 * `budgets: {}`, `alertThreshold: 1`, no fixed status date, `formulas: []`, no `renderPanel`) — a
 * dormant nest leaves rates, budgets, costs, alerts, baselines, the curve and the forecast all
 * fully functional over empty session state. Only the PANELS are nest-gated.
 *
 * **Panel gating (§2.16 + §5).** Every `open…` returns `false` — and mounts nothing — while
 * `stargantt.view` does not resolve ("no composed renderer"), AND while the nest is dormant ("no
 * panel can open"). Both conditions
 * gate, so a headless composition and a `tracking()` without a `cost` nest both answer `false`.
 *
 * **Consumed by the EVM area.** `costOf` is a genuine, side-effect-free computation over the data
 * store; §2.14's BAC/AC fall-through calls this very method through a live object-method reference
 * wired in the plugin root, not through a re-import or a `ctx.use()` lookup.
 *
 * **§3.2 (recorded resolution).** This area contributes to NO extension point: the design card's
 * `grid/columns` and `export/auxiliarySurfaces` lines are card errors and are not carried. The
 * cost area therefore claims no layer and no order.
 */
import { createStore } from "@stargantt/core";
import type { WritableStore } from "@stargantt/core";
import { latchedSeam } from "@stargantt/sdk";
import type { Task, TaskId } from "@stargantt/plugin-data-store";
import type { ThemeService, ViewService } from "@stargantt/plugin-view";
import type {
  BreakdownEntryData,
  BudgetComparisonRow,
  CostBreakdown,
  CostPanelRenderContext,
  CostService,
  CostState,
  CostType,
  TableRow,
} from "../../types";
import type { TrackingAreaDeps } from "../areas";
import { formatAmount } from "../shared/format";
import { statusDateResolver } from "../shared/status-date";
import {
  breakdownByCodeOf,
  breakdownOf,
  costsOf,
  createCostWorld,
  taskOver,
} from "./compute";
import type { CostWorld } from "./compute";
import {
  comparisonRows,
  computeAlerts,
  costVarianceRows,
  createCostBaselineStore,
  currentCostEntries,
  snapshotCostBaseline,
} from "./budgets";
import { costCurvePoints, costForecastPoints, curveTasksOf } from "./curve";
import { evaluateCostFormulas, resolveCostFormulas } from "./formulas";
import type { CostFormulaRow } from "./formulas";
import {
  createBreakdownPanel,
  createCurvePanel,
  createTablePanel,
} from "./panels";
import type { CostPanel, CostPanelSeam, TableEdit } from "./panels";
import { createRateResolver, createRateStore, lookupResourcePool } from "./rates";
import { COST_TYPES, createCostValueMembers, usableAmount, usableCode } from "./values";

/** §5.3 defaults, applied member-wise while the `cost` nest is dormant. */
const DEFAULT_HOURS_PER_DAY = 8;
const DEFAULT_ALERT_THRESHOLD = 1;

/** Wires the cost area and returns the service the plugin root provides as `stargantt.cost`. */
export function wireCost(deps: TrackingAreaDeps): CostService {
  const { ctx, data, messages } = deps;
  const cost = deps.config.cost;

  const hoursPerDay = cost?.hoursPerDay ?? DEFAULT_HOURS_PER_DAY;
  const threshold = cost?.alertThreshold ?? DEFAULT_ALERT_THRESHOLD;
  // §2.11/§2.14 — cost's own two-link chain: the configured date, else the start of the current UTC
  // day, re-read on every call so an unconfigured composition tracks the day live.
  const statusDate = statusDateResolver(cost?.statusDate, deps.now);
  // §2.12 — `CostFormulaInput.statusDate` is the CONFIGURED value, `undefined` when none was set;
  // it is deliberately not the resolved fallback.
  const configuredStatusDate = cost?.statusDate;

  /* --- session-local state (§1.3 `CostState`) ---------------------------------------- */

  const rates = createRateStore(cost?.rates ?? []);
  const baselines = createCostBaselineStore();
  let projectBudget = usableAmount(cost?.budget) ? cost.budget : undefined;
  const codeBudgets = new Map<string, number>();
  for (const [rawCode, amount] of Object.entries(cost?.budgets ?? {})) {
    const code = usableCode(rawCode);
    if (code !== undefined && usableAmount(amount)) codeBudgets.set(code, amount);
  }

  const snapshotState = (): CostState => ({
    rates: rates.entries(),
    budget: projectBudget,
    codeBudgets: new Map(codeBudgets),
    baselines: baselines.all(),
  });
  // §1.3: "a config seed that loaded anything sets it once at setup" — the store's INITIAL value is
  // that set. Only real changes set again.
  const state: WritableStore<CostState> = createStore<CostState>(snapshotState());
  const publish = (): void => void state.set(snapshotState());

  /* --- §2.8 rate resolution, with the per-use resource-pool fallback ------------------ */

  // `lookupResourcePool` makes the one, VISIBLE, `Services`-typed `ctx.useOptional("stargantt.
  // resource-pool")` call (see its doc in `rates.ts` — no aliasing, no `.bind`, no cast on the
  // member expression itself, so `tools/lint-deps.mjs` sees it like any other service lookup).
  // Called fresh on every `rateOf` invocation, which is what §8's "resolved per use, never
  // latched into variables at setup" rule requires — a pool that activates after this plugin's
  // own `setup()` is still seen.
  const rateOf = createRateResolver(rates, () => lookupResourcePool(ctx));

  /* --- the computation world --------------------------------------------------------- */

  // Memoized per invalidation window: the world materializes the task list and the leaf set once,
  // then answers a burst of `costOf`/`costs`/`comparison`/… calls from it. Assignments and stored
  // values are read LIVE off the data view's own indexes, and `rateOf` re-resolves the pool per
  // call, so only the task set itself needs an invalidation edge.
  let cachedWorld: CostWorld | undefined;
  const world = (): CostWorld =>
    (cachedWorld ??= createCostWorld(data.query(), rateOf, hoursPerDay));
  ctx.own(
    data.tasks.subscribe(() => {
      cachedWorld = undefined;
    }),
  );

  /* --- §2.1 the meta-bag write members ------------------------------------------------ */

  const values = createCostValueMembers(ctx, data);

  /* --- §2.12 custom formulas (resolved once, at setup) -------------------------------- */

  const formulaEntries = resolveCostFormulas(cost?.formulas ?? [], messages.formulaName);

  /* --- §2.13 the LATCHED panel-body seam --------------------------------------------- */

  // One latch for all three panels: the first throw anywhere reports once (`where: "renderPanel"`)
  // and disables the seam for the rest of this instance's life, in every cost panel.
  const seam: CostPanelSeam | undefined =
    cost?.renderPanel === undefined
      ? undefined
      : latchedSeam<CostPanelRenderContext>(cost.renderPanel, (error) =>
          deps.reportError("renderPanel", error),
        );

  /* --- §2.16 the three panels --------------------------------------------------------- */

  let panel: CostPanel | undefined;

  function closePanels(): void {
    panel?.dispose();
    panel = undefined;
  }
  // Owned ONCE at setup (code-quality §3): disposal removes whichever panel is current. Each panel
  // is an `sdk/dialog` that owns its own chrome listeners and drains them in `dispose()`, so no
  // per-open bag is ever registered here.
  ctx.own({ dispose: closePanels });

  /**
   * The element the panels mount into, or `undefined` when no panel may open.
   *
   * Two independent gates (§2.16 + §5): a dormant `cost` nest, and an unresolvable
   * `stargantt.view`. Resolved PER CALL — `optional` is not an ordering edge, so a view plugin
   * that activates after this one still hosts the panels.
   */
  function panelHost(): HTMLElement | undefined {
    if (cost === undefined) return undefined;
    const view: ViewService | undefined = ctx.useOptional("stargantt.view");
    return view === undefined ? undefined : ctx.root;
  }

  // Theme is likewise resolved per call, so a theme plugin registered after this one still supplies
  // the panel tokens; absent, every color falls back to its documented default.
  const themeGet = (token: string): string => {
    const theme: ThemeService | undefined = ctx.useOptional("stargantt.theme");
    return theme?.get(token) ?? "";
  };

  /** §2.10 — Apply commits ONE `task/update` per changed task, each its own undo step. */
  function applyTableEdits(edits: readonly TableEdit[]): void {
    for (const edit of edits) {
      const patch: { fixedCost?: number; materialCost?: number; actualCost?: number } = {};
      if (edit.fixedCost !== undefined) patch.fixedCost = edit.fixedCost;
      if (edit.materialCost !== undefined) patch.materialCost = edit.materialCost;
      if (edit.actualCost !== undefined) patch.actualCost = edit.actualCost;
      values.setCostFields(edit.id, patch);
    }
  }

  function openCostTablePanel(): boolean {
    const host = panelHost();
    if (host === undefined) return false;
    closePanels();
    const w = world();
    // One pass over the leaf set: each task's cost and values are computed once and shared between
    // its comparison row and its formula row, rather than walking the set twice.
    const rows: TableRow[] = [];
    const formulaRows: CostFormulaRow[] = [];
    for (const task of w.leafTasks()) {
      const taskCost = w.costOf(task);
      const taskValues = w.valuesOf(task);
      const code = taskValues.costCode;
      const row: BudgetComparisonRow = {
        id: task.id,
        name: task.name,
        estimated: taskCost.estimated,
        actual: taskCost.actual,
        variance: taskCost.actual - taskCost.estimated,
        over: taskOver(taskCost, threshold),
      };
      if (code !== undefined) row.costCode = code;
      rows.push({ row, values: taskValues });
      formulaRows.push({ task, values: taskValues });
    }
    const formulaValues = evaluateCostFormulas(
      formulaEntries,
      formulaRows,
      configuredStatusDate,
      formatAmount,
      (formulaId, cause) => deps.reportError(`formulas.${formulaId}`, cause),
    );
    panel = createTablePanel(host, rows, formulaValues, messages, {
      apply: applyTableEdits,
      close: closePanels,
      themeGet,
      amountText: formatAmount,
      seam,
    });
    panel.focus();
    return true;
  }

  function openCostCurvePanel(): boolean {
    const host = panelHost();
    if (host === undefined) return false;
    closePanels();
    const points = costForecastPoints(curveTasksOf(world()), statusDate());
    panel = createCurvePanel(host, points, messages, {
      close: closePanels,
      themeGet,
      pointText: (p) => messages.costCurvePoint(p),
      seam,
    });
    panel.focus();
    return true;
  }

  function openBreakdownPanel(): boolean {
    const host = panelHost();
    if (host === undefined) return false;
    closePanels();
    const w = world();
    const totals = breakdownOf(w, w.leafTasks());
    const sum = totals.labor + totals.fixed + totals.variable + totals.material;
    const entries: BreakdownEntryData[] = COST_TYPES.map((type: CostType) => ({
      type,
      amount: totals[type],
      percent: sum === 0 ? 0 : (totals[type] / sum) * 100,
    }));
    panel = createBreakdownPanel(host, entries, messages, {
      close: closePanels,
      themeGet,
      entryText: (e) => messages.breakdownEntry(e),
      seam,
    });
    panel.focus();
    return true;
  }

  /* --- §1.3 the service --------------------------------------------------------------- */

  const service: CostService = {
    state,
    rateOf,
    setRate(resourceId, rate) {
      if (rates.set(resourceId, rate)) publish();
    },
    removeRate(resourceId) {
      if (rates.remove(resourceId)) publish();
    },
    costValuesOf: values.costValuesOf,
    setCostFields: values.setCostFields,
    addCostItem: values.addCostItem,
    removeCostItem: values.removeCostItem,
    costOf(id: TaskId) {
      const task = data.getTask(id);
      if (task === undefined) return undefined;
      return world().costOf(task);
    },
    costs: () => costsOf(world()),
    breakdown(ids?: readonly TaskId[]): CostBreakdown {
      const w = world();
      // §2.9 — leaf tasks only; an explicit subset is leaf-filtered the same way.
      let tasks: readonly Readonly<Task>[];
      if (ids === undefined) {
        tasks = w.leafTasks();
      } else {
        const leafIds = new Set(w.leafTasks().map((t) => t.id));
        tasks = ids
          .map((id) => data.getTask(id))
          .filter((t): t is Readonly<Task> => t !== undefined && leafIds.has(t.id));
      }
      return breakdownOf(w, tasks);
    },
    breakdownByCode: () => breakdownByCodeOf(world()),
    setBudget(amount) {
      const next =
        amount === undefined ? undefined : usableAmount(amount) ? amount : projectBudget;
      if (next === projectBudget) return;
      projectBudget = next;
      publish();
    },
    budgetForCode(code) {
      const trimmed = usableCode(code);
      return trimmed === undefined ? undefined : codeBudgets.get(trimmed);
    },
    setBudgetForCode(code, amount) {
      const trimmed = usableCode(code);
      if (trimmed === undefined) return;
      if (amount === undefined) {
        if (codeBudgets.delete(trimmed)) publish();
        return;
      }
      if (!usableAmount(amount) || codeBudgets.get(trimmed) === amount) return;
      codeBudgets.set(trimmed, amount);
      publish();
    },
    comparison: () => comparisonRows(world(), threshold),
    alerts: () => computeAlerts(world(), threshold, projectBudget, codeBudgets),
    saveCostBaseline(name) {
      const usableName = typeof name === "string" && name.trim() !== "" ? name.trim() : undefined;
      const baseline = snapshotCostBaseline(
        world(),
        baselines.generateId(),
        usableName ?? messages.costBaselineName(baselines.saveCount() + 1),
        deps.now(),
      );
      baselines.add(baseline);
      publish();
      return baseline;
    },
    removeCostBaseline(id) {
      if (baselines.remove(id)) publish();
    },
    costVariance(baselineId) {
      const baseline = baselines.get(baselineId);
      if (baseline === undefined) return [];
      // §2.9 — the current side of the variance covers leaf tasks only.
      return costVarianceRows(currentCostEntries(world()), baseline);
    },
    costCurve: () => costCurvePoints(curveTasksOf(world()), statusDate()),
    costForecast: () => costForecastPoints(curveTasksOf(world()), statusDate()),
    openCostTablePanel,
    openCostCurvePanel,
    openBreakdownPanel,
    closePanels,
  };
  return service;
}
