# Plugin: tracking (`stargantt.tracking`)

Package: `@stargantt/plugin-tracking` — Layer 7.
Status: normative.

## Purpose

Baselines (schedule snapshots in multiple switchable generations, baseline bars, actual bars, slip indicators, variance report and project summary, critical-path comparison); progress tracking (RAG health, remaining-work / physical-% / remaining-duration input methods, weekly bulk-update panel, the status-date zigzag progress line, status report, trend snapshots); cost (per-resource rate master, automatic labor cost, manual cost fields and classified items, cost codes, budgets and threshold alerts, cost baselines, cumulative cost curve with S-curve forecast, three panels); EVM (PV/EV/AC per task and project, SPI/CPI/SV/CV, EAC/ETC forecasts, four accrual methods, KPI dashboard and S-curve panels).

Core design: the EVM computation's fan-in to cost / baselines / progress data is direct function calls between internal modules, never service edges (§2.14). The shared vocabulary of the four features — status-date resolution, day-stamped snapshot series, duration formatting — is unified in `internal/shared/`. Every mutation of task data goes through the store's public commands (`task/update`), so undo integration is inherited everywhere; session-local state (baseline sets, rates, budgets, snapshot histories, the project-BAC override) lives in the plugin and is observable through the four service stores.

## 1. Services

All four service IDs of architecture ch. 4.1 are provided unconditionally: `stargantt.baselines`, `stargantt.progress`, `stargantt.cost`, `stargantt.evm`. All four are store-shaped: session-state changes are observed through one `state` store per service (§4). A dormant config nest (§5) leaves its service provided and functional over empty session state (the calendars-service precedent, scheduling.md §1.2) — only the visuals and panels of a dormant nest are absent.

### 1.1 `stargantt.baselines` → `BaselinesService`

```ts
import type { Store } from "@stargantt/core";
import type { LinkType, Task, TaskId } from "@stargantt/plugin-data-store";

/** Identifier of a saved baseline. Unique within the plugin's baseline set. */
export type BaselineId = string | number;

/** One task's dates as a baseline captured them. */
export interface BaselineTaskSnapshot {
  id: TaskId;
  /** Epoch ms, UTC-fixed (the data store's date convention). */
  start: number;
  /** Epoch ms, exclusive, like `Task.end`. */
  end: number;
  /** The task's type at capture time; absent means `"task"`. */
  type?: Task["type"];
}

/** One dependency as a baseline captured it (identity is positional; no link id is kept). */
export interface BaselineLinkSnapshot {
  sourceId: TaskId;
  targetId: TaskId;
  type: LinkType;
  /** ms; negative = lead. */
  lag?: number;
}

/**
 * A baseline supplied through config (e.g. restored from host persistence, or produced by the
 * export plugin's MSPDI import — `MsProjectImportResult.baselineInits`, export.md §1.7).
 * CANONICAL DECLARATION: this is the authoritative `BaselineInit`; the export plugin types
 * against it via `import type { BaselineInit } from "@stargantt/plugin-tracking"` (type-only
 * devDependency) or structurally. Every object export produces satisfies this type —
 * `id`/`name` are optional here and always present there; `capturedAt` and `links`
 * default when absent.
 */
export interface BaselineInit {
  /** Defaults to a generated id unique within the set. A colliding id replaces its holder. */
  id?: BaselineId;
  /** Defaults to the catalog's `baselineName` builder applied to the baseline's ordinal. */
  name?: string;
  /** Epoch ms of the capture. Defaults to the time of registration. */
  capturedAt?: number;
  /** Task snapshots. Entries without a usable id or finite start/end are dropped. */
  tasks: readonly BaselineTaskSnapshot[];
  /** Link snapshots, used only by critical-path comparison. Unusable entries are dropped. */
  links?: readonly BaselineLinkSnapshot[];
}

/** Identifying metadata of one saved baseline. */
export interface BaselineInfo {
  id: BaselineId;
  name: string;
  capturedAt: number;
  taskCount: number;
}

/** A saved baseline: its metadata plus the captured snapshots. */
export interface Baseline extends BaselineInfo {
  tasks: ReadonlyMap<TaskId, Readonly<BaselineTaskSnapshot>>;
  links: readonly Readonly<BaselineLinkSnapshot>[];
}

/** A task's recorded actual dates (epoch ms, UTC-fixed). */
export interface ActualDates {
  start?: number;
  end?: number;
}

/** One row of the variance report: a task present both now and in the compared baseline. */
export interface VarianceRow {
  id: TaskId;
  name: string;
  type: "task" | "summary" | "milestone";
  baselineStart: number;
  baselineEnd: number;
  start: number;
  end: number;
  /** `start − baselineStart`, ms — positive = starts later than planned (exact ms). */
  startVarianceMs: number;
  /** `end − baselineEnd`, ms — positive = finishes later than planned. */
  endVarianceMs: number;
  /** Current duration minus baseline duration, ms. */
  durationVarianceMs: number;
}

/** Project-level plan-vs-current duration comparison. */
export interface ScheduleSummary {
  baselineStart: number;
  baselineEnd: number;
  start: number;
  end: number;
  baselineDurationMs: number;
  durationMs: number;
  /** `end − baselineEnd`, ms: how much later the project now finishes than planned. */
  finishVarianceMs: number;
  /** `durationMs − baselineDurationMs`. */
  durationVarianceMs: number;
  /** Number of tasks compared (present in both the store and the baseline). */
  taskCount: number;
}

/** How the critical path changed between a baseline and now. */
export interface CriticalPathDelta {
  /** Critical now, not critical (or absent) at baseline time. */
  added: readonly TaskId[];
  /** Critical at baseline time, not critical (or gone) now. */
  removed: readonly TaskId[];
  /** Critical in both. */
  retained: readonly TaskId[];
}

/** The observable baseline-set state. */
export interface BaselinesState {
  /** The saved baselines, in registration order. */
  readonly baselines: readonly BaselineInfo[];
  /** The active baseline's id, or undefined when none is active. */
  readonly activeId: BaselineId | undefined;
}

export interface BaselinesService {
  /** Set once per observable baseline-set change: save / remove / replace / (de)activation.
   *  A config seed that registered anything sets it once at setup. Mutations that change
   *  nothing set nothing. */
  readonly state: Store<BaselinesState>;
  /** Snapshots the current schedule as a new baseline and makes it active. Returns its id. */
  save(name?: string): BaselineId;
  /** One baseline with its snapshots, or `undefined` for an unknown id. */
  get(id: BaselineId): Readonly<Baseline> | undefined;
  /** Removes a baseline. Unknown ids are a no-op. Removing the active baseline deactivates it. */
  remove(id: BaselineId): void;
  /** Activates a baseline (`undefined` deactivates). An unknown id is a no-op. */
  setActive(id: BaselineId | undefined): void;
  /** One task's snapshot in the given (default: active) baseline. */
  snapshotOf(taskId: TaskId, baselineId?: BaselineId): Readonly<BaselineTaskSnapshot> | undefined;
  /** Variance rows against the given (default: active) baseline, in store task order. */
  variance(baselineId?: BaselineId): readonly VarianceRow[];
  /** The variance rows whose task type is `"milestone"` in either the store or the baseline. */
  milestoneVariance(baselineId?: BaselineId): readonly VarianceRow[];
  /** The project-level summary, or `undefined` when the comparison is empty. */
  summary(baselineId?: BaselineId): ScheduleSummary | undefined;
  /** The variance report as CSV text (headers from the catalog, ISO `YYYY-MM-DD` dates,
   *  variance cells rendered through the resolved `duration` member). */
  reportCSV(baselineId?: BaselineId): string;
  /** A task's recorded actual dates, or `undefined` when it carries none. */
  actualOf(taskId: TaskId): Readonly<ActualDates> | undefined;
  /** Records (number), keeps (omitted) or clears (`null`) a task's actual start/finish by
   *  dispatching one `task/update` writing `meta.actualStart` / `meta.actualEnd` —
   *  transactional and undoable. Unknown tasks and non-finite numbers are a no-op. */
  setActual(taskId: TaskId, actual: { start?: number | null; end?: number | null }): void;
  /** The ids of the tasks on the current schedule's critical path (sdk/cpm `criticalTaskIds`
   *  with `{ toleranceMs: 1 }`; cycle members and cycle-shadowed predecessors
   *  are never reported). */
  criticalPath(): readonly TaskId[];
  /** Compares the given (default: active) baseline's critical path with the current one.
   *  `undefined` when the baseline cannot be resolved. */
  criticalPathDelta(baselineId?: BaselineId): CriticalPathDelta | undefined;
}
```

Member count: 14 (the `state` store + 13 methods; the baseline list and active id are read from `state`).

**Critical-path engine (normative).** This plugin declares NO edge to `stargantt.critical-path`, optional or otherwise. Both sides of `criticalPathDelta` run `sdk/cpm`'s `criticalTaskIds` (tolerance 1 ms): the baseline side can only be fed from this plugin's snapshots, and reading the current side from `CriticalPathService` would either change the reported set (its threshold/exclusion rules differ: `thresholdDays`-based classes, summary exclusion) or make the delta composition-dependent — so one engine classifies both sides. The `stargantt.critical-path` service's first official consumer is the export plugin (`criticalPathOnly`, export.md §1.3); third parties consume it freely.

Baseline results are memoized and invalidated on `data.tasks` store notifications; baseline-side paths are memoized per baseline (snapshots are immutable once captured).

### 1.2 `stargantt.progress` → `ProgressService`

Store-shaped: the session state (line toggle, snapshot series) is observable through the `state` store.

```ts
/** The three RAG health classifications. */
export type RagStatus = "red" | "amber" | "green";

/** The progress-tracking attributes of one task, stored under `task.meta.progressTracking`.
 *  Every member optional; an absent member means the task has no value for that attribute. */
export interface ProgressValues {
  /** Health classification, shown as a badge on the bar (and, opt-in, as the bar color). */
  rag?: RagStatus;
  /** Remaining effort, in resource-milliseconds. Non-negative. */
  remainingWork?: number;
  /** Total planned effort, in resource-milliseconds. Positive. */
  totalWork?: number;
  /** Physical (inspection-based) percent complete, 0–100 — independent of `task.progress`. */
  physicalPercent?: number;
}

/** A partial update: an absent key is untouched; a key present with `undefined` removes it. */
export type ProgressPatch = { [K in keyof ProgressValues]?: ProgressValues[K] | undefined };

/** One task's contribution to a `setProgressFieldsBatch` call. */
export interface ProgressFieldsBatchEntry {
  id: TaskId;
  patch: Readonly<ProgressPatch>;
}

/** One recorded point of the progress trend. */
export interface ProgressSnapshot {
  /** Start of the snapshot's UTC day, epoch ms. */
  date: number;
  /** Mean task progress across the project, 0–100. */
  percentComplete: number;
  completedCount: number;
  lateCount: number;
  taskCount: number;
}

/** One behind-schedule task in a status report. */
export interface LateTaskEntry {
  id: TaskId;
  name: string;
  /** How far the task's progress point trails the status date, ms (> 0). */
  lateMs: number;
}

/** The generated status report (§2.6). */
export interface StatusReport {
  statusDate: number;
  taskCount: number;
  completedCount: number;
  inProgressCount: number;
  notStartedCount: number;
  /** Behind-schedule tasks, in store order. */
  lateTasks: readonly LateTaskEntry[];
  /** Mean task progress, 0–100 (weighting per `progressWeighting`). */
  percentComplete: number;
  /** How many tasks carry each RAG value; `none` counts tasks without one. */
  ragCounts: { red: number; amber: number; green: number; none: number };
}

/** The observable progress session state. */
export interface ProgressState {
  /** Whether the status-date zigzag line is currently drawn. */
  readonly progressLineVisible: boolean;
  /** All trend snapshots, oldest first — config seed plus recorded ones. */
  readonly snapshots: readonly ProgressSnapshot[];
}

export interface ProgressService {
  /** Set on every effective `setProgressLineVisible` change and every `recordSnapshot`
   *  that changes the series. */
  readonly state: Store<ProgressState>;
  /** The task's stored progress-tracking values, `{}` when it has none. Never `undefined`. */
  progressOf(id: TaskId): Readonly<ProgressValues>;
  /** Merges the given values into the task's stored attributes via one `task/update`
   *  (undoable). A key set to `undefined` removes it; unusable values are ignored per key.
   *  Unknown task = no-op. A patch stating `remainingWork` recomputes `task.progress`
   *  in the same transaction whenever a positive `totalWork` is known (§2.5). */
  setProgressFields(id: TaskId, patch: Readonly<ProgressPatch>): void;
  /** Writes several tasks' values as ONE undoable transaction (sdk/aggregate
   *  `createTransactionBatcher`, §2.5). Same-task entries merge first (later entry winning
   *  per field, explicit `undefined` included); unknown tasks / unusable patches are skipped
   *  per entry; an empty or all-skipped list dispatches nothing. */
  setProgressFieldsBatch(entries: readonly ProgressFieldsBatchEntry[]): void;
  /** The task's RAG status, `undefined` when unset or the task is unknown. */
  ragOf(id: TaskId): RagStatus | undefined;
  /** Sets or (with `undefined`) clears the task's RAG status. One undo step. */
  setRag(id: TaskId, rag: RagStatus | undefined): void;
  /** Records remaining work (resource-ms). With a positive `totalWork` on the task, the same
   *  transaction recomputes `task.progress = clamp(1 − remaining/total, 0, 1)`. One undo step. */
  setRemainingWork(id: TaskId, ms: number): void;
  /** Records the physical percent complete, clamped 0–100; never touches `task.progress`. */
  setPhysicalPercent(id: TaskId, percent: number): void;
  /** Reschedules by remaining duration: `end = max(statusDate, start) + ms` and `progress` =
   *  the elapsed fraction of the new span, one `task/update` (stored `remainingWork` is
   *  recomputed in the same transaction — §2.5). */
  setRemainingDuration(id: TaskId, ms: number): void;
  /** The status date in effect: the configured one, else the start of the current UTC day. */
  statusDate(): number;
  /** Builds the status report at the given date (default: the effective status date). */
  statusReport(statusDate?: number): StatusReport;
  /** The report as plain text, one line per catalog entry (§6 builders), "\n"-joined. */
  statusReportText(statusDate?: number): string;
  /** Shows or hides the progress line; sets the store and invalidates the main layer.
   *  Non-boolean arguments and no-change calls do nothing. */
  setProgressLineVisible(visible: boolean): void;
  /** Records (or replaces, same UTC day) a trend snapshot; returns the recorded point.
   *  Host-initiated only — the plugin never calls it itself. */
  recordSnapshot(date?: number): ProgressSnapshot;
  /** Opens the bulk-update panel over the chart. `false` when `stargantt.view` is absent. */
  openBulkUpdatePanel(): boolean;
  /** Closes the bulk-update panel; a no-op when it is not open. */
  closeBulkUpdatePanel(): void;
  /** Opens the progress-trend panel. `false` when `stargantt.view` is absent. */
  openTrendPanel(): boolean;
  /** Closes the trend panel; a no-op when it is not open. */
  closeTrendPanel(): void;
}
```

Member count: 18 (the `state` store + 17 methods; the line toggle and snapshot series are read from `state`).

### 1.3 `stargantt.cost` → `CostService`

Store-shaped: rates, budgets, and cost baselines are observed through the `state` store.

```ts
import type { ResourceId } from "@stargantt/plugin-data-store";

/** The four cost classifications used as aggregation axes. */
export type CostType = "labor" | "fixed" | "variable" | "material";

/** A resource's hourly rates in the rate master. */
export interface CostRate {
  /** Standard hourly rate, in the host's currency unit. Finite, ≥ 0. */
  standard: number;
  /** Overtime hourly rate. Omitted = the standard rate. Finite, ≥ 0. */
  overtime?: number;
}

/** Input shape for a rate-master entry (config seed or `setRate`). */
export interface CostRateInit {
  resourceId?: ResourceId;
  standard?: number;
  overtime?: number;
}

/** One free-form cost item on a task, classified by type. */
export interface CostItem {
  /** Unique within the task. Generated when the init omitted it. */
  readonly id: string;
  readonly label: string;
  /** Finite, ≥ 0. */
  readonly amount: number;
  readonly type: CostType;
}

/** Input shape for adding a cost item. */
export interface CostItemInit {
  id?: string;
  label?: string;
  amount?: number;
  type?: CostType;
}

/** The manually entered cost attributes of one task, stored under `task.meta.costTracking`. */
export interface CostValues {
  /** Task fixed cost independent of resource effort. Finite, ≥ 0. */
  fixedCost?: number;
  /** Material / consumables cost, kept separate from labor. Finite, ≥ 0. */
  materialCost?: number;
  /** Recorded actual cost to date. Finite, ≥ 0. */
  actualCost?: number;
  /** Accounting / cost code tag (free-form, trimmed, non-empty). */
  costCode?: string;
  /** Additional classified cost items. */
  items?: readonly CostItem[];
}

/** A partial update: an absent key is untouched; a key present with `undefined` removes it. */
export type CostPatch = {
  [K in "fixedCost" | "materialCost" | "actualCost" | "costCode"]?: CostValues[K] | undefined;
};

/** One task's computed cost, by component and in total. */
export interface TaskCost {
  id: TaskId;
  /** Auto-computed labor cost (§2.8) plus `labor`-typed items. */
  labor: number;
  /** `fixedCost` plus `fixed`-typed items. */
  fixed: number;
  /** `variable`-typed items. */
  variable: number;
  /** `materialCost` plus `material`-typed items. */
  material: number;
  /** The estimated (planned) cost: labor + fixed + variable + material. */
  estimated: number;
  /** The recorded actual cost, 0 when none is recorded. */
  actual: number;
}

/** Totals per cost type across a task set. */
export type CostBreakdown = Record<CostType, number>;

/** One row of the budget-vs-actual comparison. */
export interface BudgetComparisonRow {
  id: TaskId;
  name: string;
  estimated: number;
  actual: number;
  /** `actual − estimated` (positive = over). */
  variance: number;
  costCode?: string;
  /** Whether the row trips the alert threshold (§2.10). */
  over: boolean;
}

/** A saved cost baseline. */
export interface CostBaseline {
  readonly id: string;
  readonly name: string;
  /** Epoch ms of the save. */
  readonly date: number;
  /** Per-task estimated and actual cost at save time. */
  readonly tasks: ReadonlyMap<TaskId, { estimated: number; actual: number }>;
  readonly totalEstimated: number;
  readonly totalActual: number;
}

/** One row of a cost-baseline variance report. */
export interface CostVarianceRow {
  id: TaskId;
  name: string;
  baselineEstimated: number;
  currentEstimated: number;
  /** `currentEstimated − baselineEstimated`. */
  variance: number;
}

/** One point of a cumulative cost curve. `t` is epoch ms. */
export interface CostCurvePoint {
  t: number;
  planned: number;
  actual: number;
  /** Present on every point at or after the status date in `costForecast()`'s output;
   *  never present in `costCurve()`'s (§2.11). */
  forecast?: number;
}

/** One threshold alert. */
export interface CostAlert {
  kind: "task" | "costCode" | "project";
  /** The task id (`kind: "task"`) or cost code (`kind: "costCode"`); absent for `"project"`. */
  subject?: string;
  /** The figure that tripped the threshold. */
  value: number;
  /** The reference: `threshold × estimated` (task) or `threshold × budget` (code/project). */
  limit: number;
}

/** One row of the budget-vs-actual table panel. */
export interface TableRow {
  row: BudgetComparisonRow;
  values: Readonly<CostValues>;
}

/** One row of the cost-breakdown panel. */
export interface BreakdownEntryData {
  type: CostType;
  amount: number;
  /** Share of the total, 0–100. */
  percent: number;
}

/** A custom cost metric (§2.12). */
export interface CostFormulaInit {
  id?: string;
  label?: string;
  /** Narrows which tasks feed the formula. Omitted, every leaf task in the table does. */
  filter?: (task: Readonly<Task>, values: Readonly<CostValues>) => boolean;
  /** Computes the value from the kept rows plus the project totals. Required. */
  evaluate: (input: Readonly<CostFormulaInput>) => number;
  /** Renders the value. Defaults to the plugin's rounded number formatting. */
  format?: (value: number) => string;
}

/** What a `CostFormulaInit.evaluate` call receives. */
export interface CostFormulaInput {
  readonly rows: readonly { task: Readonly<Task>; values: Readonly<CostValues> }[];
  /** Sum of each kept row's `fixedCost` / `materialCost` / `actualCost`; `costCode`/`items`
   *  are never aggregated. */
  readonly totals: Readonly<CostValues>;
  /** The same totals grouped by trimmed cost code; uncoded rows aggregate under `""`. */
  readonly byCode: ReadonlyMap<string, Readonly<CostValues>>;
  /** The configured `cost.statusDate`, or `undefined` when none was set. */
  readonly statusDate: number | undefined;
}

/** One custom formula that evaluated successfully. */
export interface CostFormulaValue {
  id: string;
  label: string;
  value: number;
  text: string;
}

/** What a `cost.renderPanel` call receives (the uniform body seam; §2.13). */
export interface CostPanelRenderContext {
  readonly panel: "table" | "curve" | "breakdown";
  readonly model: CostPanelModel;
  close(): void;
}

/** The data one of the three cost panels renders, discriminated by `panel`. */
export type CostPanelModel =
  | { readonly panel: "table"; readonly rows: readonly TableRow[]; readonly formulas: readonly CostFormulaValue[] }
  | { readonly panel: "curve"; readonly points: readonly CostCurvePoint[] }
  | { readonly panel: "breakdown"; readonly entries: readonly BreakdownEntryData[] };

/** The observable cost session state. */
export interface CostState {
  /** The rate master, keyed by resource id (`rateOf` answers from it). */
  readonly rates: ReadonlyMap<ResourceId, Readonly<CostRate>>;
  /** The project budget, or undefined when none is set. */
  readonly budget: number | undefined;
  /** Per-cost-code budgets (`budgetForCode` answers from them). */
  readonly codeBudgets: ReadonlyMap<string, number>;
  /** Saved cost baselines, oldest first. */
  readonly baselines: readonly CostBaseline[];
}

export interface CostService {
  /** Set once per observable session-state mutation (rates, budgets, cost baselines);
   *  a config seed that loaded anything sets it once at setup; no-change mutations set
   *  nothing (the seed is subsumed by the store's initial value). */
  readonly state: Store<CostState>;
  /** Shorthand: the rate-master entry, else — with `stargantt.resource-pool` resolvable and
   *  its entry carrying a `costRate` — `{ standard: costRate }`, else `undefined` (§2.8). */
  rateOf(resourceId: ResourceId): CostRate | undefined;
  /** Registers or updates a rate. Unusable init = no-op. */
  setRate(resourceId: ResourceId, rate: { standard?: number; overtime?: number }): void;
  /** Removes a rate-master entry. Unknown id = no-op. */
  removeRate(resourceId: ResourceId): void;
  /** The task's stored manual cost values, `{}` when it has none. */
  costValuesOf(id: TaskId): Readonly<CostValues>;
  /** Merges manual cost fields via one `task/update` (undoable). Unknown task = no-op. */
  setCostFields(id: TaskId, patch: Readonly<CostPatch>): void;
  /** Adds a classified cost item; returns its id, or `undefined` when unusable. Undoable. */
  addCostItem(id: TaskId, init: CostItemInit): string | undefined;
  /** Removes a cost item. Unknown task or item = no-op. Undoable. */
  removeCostItem(id: TaskId, itemId: string): void;
  /** The task's computed cost. Unknown task = `undefined`. */
  costOf(id: TaskId): TaskCost | undefined;
  /** Computed costs for every task, in store order. */
  costs(): readonly TaskCost[];
  /** Totals per cost type across all leaf tasks (an explicit subset is leaf-filtered too). */
  breakdown(ids?: readonly TaskId[]): CostBreakdown;
  /** Totals per cost code over leaf tasks; uncoded tasks aggregate under `""`. */
  breakdownByCode(): ReadonlyMap<string, { estimated: number; actual: number }>;
  /** Sets (or with `undefined` clears) the project budget. */
  setBudget(amount: number | undefined): void;
  /** Shorthand for `state.get().codeBudgets.get(code)`. */
  budgetForCode(code: string): number | undefined;
  /** Sets (or with `undefined` clears) a cost code's budget. */
  setBudgetForCode(code: string, amount: number | undefined): void;
  /** Budget-vs-actual rows for every leaf task, in store order. */
  comparison(): readonly BudgetComparisonRow[];
  /** Active threshold alerts, tasks first, then cost codes, then the project. */
  alerts(): readonly CostAlert[];
  /** Saves a cost baseline; returns it. */
  saveCostBaseline(name?: string): CostBaseline;
  /** Removes a cost baseline. Unknown id = no-op. */
  removeCostBaseline(id: string): void;
  /** Variance rows against a baseline (default: the most recent). Empty without baselines. */
  costVariance(baselineId?: string): readonly CostVarianceRow[];
  /** Cumulative planned/actual curve points across the project span (§2.11). */
  costCurve(): readonly CostCurvePoint[];
  /** The same point set as `costCurve()`, with `forecast` added to every point at or after
   *  the status date (§2.11). */
  costForecast(): readonly CostCurvePoint[];
  /** Opens the budget-vs-actual table panel. `false` when `stargantt.view` is absent. */
  openCostTablePanel(): boolean;
  /** Opens the cumulative cost-curve panel. `false` when `stargantt.view` is absent. */
  openCostCurvePanel(): boolean;
  /** Opens the cost-breakdown chart panel. `false` when `stargantt.view` is absent. */
  openBreakdownPanel(): boolean;
  /** Closes whichever cost panel is open; a no-op when none is. */
  closePanels(): void;
}
```

Member count: 26 (the `state` store + 25 methods; `rateOf` and `budgetForCode` are shorthands over the store — the CriticalPathService shorthand precedent).

### 1.4 `stargantt.evm` → `EvmService`

Store-shaped: the BAC override and snapshot series are observed through the `state` store.

```ts
/** Earned-value accrual methods (§2.15). */
export type EarnedValueMethod =
  | "percentComplete"
  | "zeroHundred"
  | "fiftyFifty"
  | "milestoneWeighted";

/** EAC forecast formulas (§2.15). */
export type EacMethod = "cpi" | "remaining" | "cpiSpi";

/** One weighted progress milestone of a task (`milestoneWeighted` accrual). */
export interface EvmMilestone {
  /** Relative weight. Finite, > 0. */
  weight: number;
  complete: boolean;
  label?: string;
}

/** The per-task EVM attributes stored under `task.meta.evm`. */
export interface EvmValues {
  /** The task's Budget at Completion. Finite, ≥ 0. */
  bac?: number;
  /** The task's recorded actual cost to date. Finite, ≥ 0. */
  actualCost?: number;
  /** Per-task accrual-method override. */
  method?: EarnedValueMethod;
  /** Weighted milestones used by the `milestoneWeighted` method. */
  milestones?: readonly EvmMilestone[];
}

/** A partial update: an absent key is untouched; a key present with `undefined` removes it. */
export type EvmPatch = { [K in keyof EvmValues]?: EvmValues[K] | undefined };

/** The derived indices shared by task and project metrics. */
export interface EvmIndices {
  bac: number;
  /** Planned Value at the status date. */
  pv: number;
  /** Earned Value at the status date. */
  ev: number;
  /** Actual Cost at the status date. */
  ac: number;
  /** Schedule Variance, `ev − pv`. */
  sv: number;
  /** Cost Variance, `ev − ac`. */
  cv: number;
  /** Schedule Performance Index, `ev / pv`; absent when `pv` is 0. */
  spi?: number;
  /** Cost Performance Index, `ev / ac`; absent when `ac` is 0. */
  cpi?: number;
  /** Estimate At Completion per the configured `eacMethod`. */
  eac: number;
  /** Estimate To Complete, `eac − ac`. */
  etc: number;
}

/** One task's EVM metrics. */
export interface EvmTaskMetrics extends EvmIndices {
  id: TaskId;
  /** The earned fraction (0–1) the accrual method yielded. */
  earned: number;
}

/** One point of the S-curve. `t` is epoch ms. */
export interface EvmCurvePoint {
  t: number;
  /** Cumulative planned value at `t`. */
  pv: number;
  /** Cumulative earned value; absent past the status date. */
  ev?: number;
  /** Cumulative actual cost; absent past the status date. */
  ac?: number;
}

/** One recorded EV/AC history point (session-local). */
export interface EvmSnapshot {
  /** Epoch ms, normalized to the start of its UTC day. */
  t: number;
  ev: number;
  ac: number;
}

/** A host accrual rule: the earned value of one task at `at`, given its budget. */
export type EvmAccrualFn = (task: Readonly<Task>, at: number, budget: number) => number;

/** A host EAC rule: the forecast total cost, from the finished indices. */
export type EvmEacFn = (indices: Readonly<EvmIndices>) => number;

/** What a custom KPI formula is given. */
export interface EvmFormulaInput {
  readonly indices: Readonly<EvmIndices>;
  readonly curve: readonly EvmCurvePoint[];
  readonly statusDate: number;
}

/** A custom KPI tile. */
export interface EvmFormulaInit {
  /** Defaults to `formula-<n>` (n counted over usable inits); a colliding id replaces its
   *  holder in place. */
  id?: string;
  /** Defaults to the resolved id. */
  label?: string;
  /** Required — an init without it is dropped at setup. */
  evaluate: (input: Readonly<EvmFormulaInput>) => number;
  format?: (value: number) => string;
}

/** One dashboard tile. */
export interface EvmKpiTile {
  label: string;
  value: string;
  /** One line explaining what the figure means, in plain language. */
  gloss?: string;
  /** A textual status flag — never a color-only signal. */
  flag?: string;
}

/** What the built-in rendering of a panel would have drawn. */
export type EvmPanelModel =
  | { readonly panel: "dashboard"; readonly tiles: readonly EvmKpiTile[] }
  | { readonly panel: "curve"; readonly points: readonly EvmCurvePoint[] };

/** What a host body renderer is given. */
export interface EvmPanelRenderContext {
  readonly panel: "dashboard" | "curve";
  readonly model: EvmPanelModel;
  close(): void;
}

/** The observable EVM session state. */
export interface EvmState {
  /** The session-local project-BAC override, or undefined when none is set. */
  readonly projectBacOverride: number | undefined;
  /** All EV/AC snapshots, oldest first — config seed plus recorded ones. */
  readonly snapshots: readonly EvmSnapshot[];
}

export interface EvmService {
  /** Set once per observable session-state mutation (BAC override, snapshots); a config seed
   *  that loaded anything sets it once at setup; no-change mutations (including a same-day
   *  snapshot replacement with identical figures) set nothing. */
  readonly state: Store<EvmState>;
  /** The task's stored EVM attributes, `{}` when it has none. */
  valuesOf(id: TaskId): Readonly<EvmValues>;
  /** Merges EVM fields via one `task/update` (undoable). Unknown task = no-op. */
  setFields(id: TaskId, patch: Readonly<EvmPatch>): void;
  /** The task's resolved BAC (§2.14). 0 when nothing resolves. */
  bacOf(id: TaskId): number;
  /** The project BAC: the session override when set, else the sum of task BACs. */
  projectBac(): number;
  /** Sets (or with `undefined` clears) the session-local project-BAC override. */
  setProjectBac(amount: number | undefined): void;
  /** The default accrual method in effect; `"percentComplete"` under a host rule. */
  method(): EarnedValueMethod;
  /** The accrual method effective for a task: its stored override, else the default. */
  methodOf(id: TaskId): EarnedValueMethod;
  /** The task's earned fraction (0–1) per its effective method. 0 for unknown tasks. */
  earnedOf(id: TaskId): number;
  /** The status date in effect (§2.14 resolution chain). */
  statusDate(): number;
  /** One task's metrics at the status date. `undefined` for an unknown task. */
  metricsOf(id: TaskId): EvmTaskMetrics | undefined;
  /** Metrics for every task, in store order. A fresh array per call. */
  metrics(): readonly EvmTaskMetrics[];
  /** The project-level aggregate (indices derived from the sums, never averaged). */
  projectMetrics(): EvmIndices;
  /** The cumulative PV/EV/AC S-curve points (§2.15). */
  scurve(): readonly EvmCurvePoint[];
  /** Records (or replaces, same UTC day) the CURRENT project EV/AC onto the status date's
   *  UTC day (no date argument; backdating is a host seeding concern). */
  recordSnapshot(): EvmSnapshot;
  /** Opens the EVM KPI dashboard panel. `false` when `stargantt.view` is absent. */
  openDashboardPanel(): boolean;
  /** Opens the S-curve panel. `false` when `stargantt.view` is absent. */
  openCurvePanel(): boolean;
  /** Closes whichever EVM panel is open; a no-op when none is. */
  closePanels(): void;
}
```

Member count: 18 (the `state` store + 17 methods; the snapshot series is read from `state`).

## 2. Behavior

### 2.1 Storage model — the five claimed `task.meta` keys

`ctx.claimKey("task.meta", …)` registers exactly five keys at setup:

| Key | Shape | Written by | Semantics |
|---|---|---|---|
| `actualStart` | `number` (epoch ms) | `BaselinesService.setActual` | Recorded actual start; drives the actual bars (§2.4). |
| `actualEnd` | `number` (epoch ms) | `BaselinesService.setActual` | Recorded actual finish. |
| `progressTracking` | `ProgressValues` object | `ProgressService` setters | RAG / remainingWork / totalWork / physicalPercent (§1.2). |
| `costTracking` | `CostValues` object | `CostService` setters | Manual cost fields, cost code, classified items (§1.3). |
| `evm` | `EvmValues` object | `EvmService.setFields` | BAC / actual cost / accrual method / weighted milestones (§1.4). |

Distinctness note (recorded): the top-level `actualStart` / `actualEnd` keys are NOT tree-grid's `taskFields.actualStart` / `taskFields.actualEnd` fields, which live INSIDE the `taskFields` bag tree-grid claims — the two storages deliberately coexist; no claim collides. Bag reads are defensive everywhere: a non-object bag yields `{}`; per-member validation as documented on each type; a finite `physicalPercent` clamps 0–100 on read. Bag writes produce a NEW `meta` object preserving sibling keys; an emptied bag drops its key, and an emptied `meta` is cleared via the `clears` path. Every write is one `task/update` (undoable).

### 2.2 Millisecond units (normative)

Variances (`*VarianceMs`), slips (`slipMs`, `slipThresholdMs`), `lateMs`, `setRemainingDuration`'s argument, and the effort quantities `remainingWork` / `totalWork` are exact milliseconds (effort in resource-ms). Money, percents, indices, fractions, and counts keep their units. Day stamps (snapshot series, default status dates) stay day stamps — only quantities are ms, never bucket widths. Invariance guarantee, pinned by the unit-invariance tests: figures are numerically unchanged for plans without intra-day working windows.

### 2.3 Baseline set, baseline bars, variance (internal/baselines)

The baseline set is session-local, seeded from `baselines.baselines` config, edited through the service, outside the transaction/undo pipeline (`setActual` is the one exception — it is a `task/update`). `save()` snapshots every task's `id`/`start`/`end`/`type` and every link, names via the `baselineName` builder, generates a unique id, and ACTIVATES the new baseline; snapshots are immutable once captured.

**Baseline bars** (order-50 underlay; only while a baseline is active and `bars` is true; visible rows only): `"under"` style paints a thin bar (2–4 px, at most 15 % of the row height) along the bottom of the row band from `tToX(baselineStart)` to `tToX(baselineEnd)`; milestone snapshots paint a small outlined diamond at the baseline start. `"overlay"` style paints a translucent filled rect with a 1 px outline over the task's current bar band (`TaskBarsService.barRect`). Tokens: `--sg-baseline-bar` (`#9aa5b1`), `--sg-baseline-overlay-fill` (`rgba(154, 165, 177, 0.28)`), `--sg-baseline-overlay-stroke` (`#7b8794`). Tasks the baseline does not know draw nothing.

**Variance** (§1.1 members): rows in store order over tasks present on both sides, exact signed ms; `summary()` compares the project envelopes; `reportCSV()` is RFC-4180-style with catalog headers, ISO `YYYY-MM-DD` dates, and duration-formatted variance cells.

**Slip indicators** (`taskbars/overlays`): per visible bar the active baseline knows, `slipMs = end − baselineEnd`, exact; drawn when non-zero and `|slipMs| ≥ slipThresholdMs` — a small triangle pointing right (late) / left (early) plus the `slipLabel` text, placed immediately right of `bar.x + bar.width + bar.gutterEnd` (outside the resolved end gutter). Tokens `--sg-baseline-slip-late` (`#b3261e`), `--sg-baseline-slip-early` (`#1b6e53`), font `--sg-baseline-slip-font` (`10px sans-serif`). Direction and signed text carry meaning; color is never the sole channel.

**Critical-path comparison** (`criticalPath: true` + active baseline; drawn on the order-62 layer): `added` tasks get a solid 2 px ring (`--sg-baseline-cp-added`, `#b3261e`), `removed` a dashed 2 px ring (`--sg-baseline-cp-removed`, `#52606d`) — solid vs dashed keeps the distinction off color alone. Engine per §1.1 (sdk/cpm on both sides).

### 2.4 Actual bars

Order-62 layer, while `actualBars` is true, for visible tasks whose `meta.actualStart` is finite: a centered stripe (30 % of bar height, min 2 px) inside the current bar band from `actualStart` to `actualEnd` when recorded, else to the task's current `end`; a milestone's actual is a small filled diamond at `actualStart`. Token `--sg-actual-bar` (`#334e68`). No baseline needed — actuals are per-task data.

### 2.5 Progress input methods and batched writes (internal/progress)

The §1.2 setter semantics: the `remainingWork` recompute is a property of the PATCH (any patch stating `remainingWork` with a positive known `totalWork` recomputes `task.progress` in the same transaction); `setRemainingDuration` recomputes a stored `remainingWork` in its transaction — from `(1 − progress) × totalWork` when a positive total exists, else proportionally from the stored pair, else untouched. Unusable numeric arguments are silent no-ops.

Multi-task writes — `setProgressFieldsBatch` and the bulk panel's Apply — commit as ONE transaction via `sdk/aggregate`'s `createTransactionBatcher`, origin prefix `stargantt.tracking/progress-bulk`.

**Bulk panel** (`openBulkUpdatePanel`): an `sdk/dialog` modal over the gantt root listing every task in store order (parents included — an editing surface, not an aggregate), one row = name + progress-% input + remaining-work input. Remaining-work entry accepts the shared duration grammar: bare number = days; `d`/`h`/`m`/`s` suffix with optional decimal fraction and whitespace; the field echoes the stored value back through the resolved `duration` member; unparsable entries leave the stored value untouched. An explicitly edited progress % wins over the remaining-work recompute. Cancel/Escape closes with no change; Apply commits edited rows as one undo step and closes. At most one of the plugin's panels per feature area is open at a time (opening one closes that area's other); dialog chrome, sizing (`minWidth: "420px"`, `maxWidth: "640px"`, `top: 24`, `maxHeight: "80%"`, `resizable: true`; trend panel `minWidth: "344px"`), tokens (`--sg-dialog-*`), Escape, drag, and focus behavior come from `sdk/dialog`'s `createDialog`.

### 2.6 Status report and lateness (internal/progress)

Completed = the task's `meta.taskFields.status` reads `"done"` (a defensive read of the bag tree-grid claims — design note below) OR `progress ≥ 1`; not-started = not completed, progress absent or ≤ 0, and `start ≥ statusDate`; in-progress otherwise. Late = not completed, `start < statusDate`, progress point (`start + clamp(progress,0,1) × (end − start)`) earlier than the status date; `lateMs` is the exact gap. `percentComplete` under `"count"` is the unweighted mean × 100; under `"duration"` each task weighs `max(0, end − start)` (milestones 0; all-zero weights fall back to the count mean). The report enumerates LEAF tasks only: a task another task names as parent is excluded from every count, tally, and the late list. `statusReportText()` joins `reportTitle`, `reportSummary`, and — when late tasks exist — `reportLateHeading` plus one `reportLateLine` per late task with `"\n"`.

Design note: the `"done"` check is a direct defensive read of `task.meta.taskFields.status` — the storage tree-grid's task-fields feature writes — so it works in any composition where that data exists, and degrades to the `progress ≥ 1` half alone where it does not. No service edge to tree-grid results.

**Trend snapshots**: `recordSnapshot(date?)` computes the report figures at the date (leaf-only inherited), normalizes to the UTC day start, inserts in date order REPLACING a same-day point. Recording is host-initiated only: no timer, no subscription records a point. The trend panel shows a small canvas polyline of `percentComplete`, an accessible per-snapshot list built with `trendLine`, and Close; `trendEmpty` with no snapshots.

### 2.7 Progress line (order 65)

The classic zigzag at the effective status date: from the status-date x at the viewport top, deflecting horizontally at each visible bar's vertical center to the task's progress point (clamped into the bar's extent), back to the status-date x at the bottom. Bars read from `TaskBarsService.visibleBoxes()` — never re-derived. Stroke `--sg-progress-line` (`#d81b60`), width 1.5, solid. With a fixed `progress.statusDate` the line is static; without one it tracks the current UTC day per paint (no timer of its own). Visibility is a runtime toggle, initial state `progress.progressLine` (default false); the layer claim is registered unconditionally (a `renderer/layers` contribution has no withdrawal path) and its draw early-returns while hidden or while `view`/`task-bars` do not resolve; toggling on/off invalidates the `main` layer.

### 2.8 Rate master and labor cost (internal/cost)

`rateOf` resolves master entry first, then — resolved per use, never latched (the `lateService` pattern) — the `stargantt.resource-pool` entry's `costRate` as `{ standard: costRate }`, else `undefined`. The master never writes to the pool.

Labor effort per assignment of a task with a resolvable rate (a reduced-form evaluation, for deterministic money output): effort in hours = `(elapsedMs / 86_400_000) × hoursPerDay`; standard portion `hours × min(units, 1) × rate.standard`; overtime portion `hours × max(units − 1, 0) × (rate.overtime ?? rate.standard)`. The plugin deliberately consults no working calendar for labor effort (a named deferral — switching to the working-time engine would silently reprice existing plans). Unrated assignments and milestones contribute 0.

### 2.9 Task cost, breakdown, leaf-only aggregation

`costOf` composes labor / fixed / variable / material per §1.3's `TaskCost` comments. EVERY aggregate surface — `breakdown`, `breakdownByCode`, `comparison`, alerts and their totals, cost baselines and variance, curve/forecast, the breakdown panel, formula rows — enumerates leaf tasks only; per-task reads (`costOf`, `costValuesOf`, `costs()`) answer for every task, parents included.

### 2.10 Budgets and alerts

With `t = alertThreshold` (finite > 0, default 1): a task alerts when `actual > t × estimated` and `estimated > 0`; a cost code when a budget is set and its estimated total `> t × budget`; the project likewise against the project budget. `alerts()` recomputes on call. The table panel renders comparison rows plus totals with three editable inputs (fixed / material / actual cost); Apply dispatches one `task/update` per changed task (each its own undo step — a deliberate per-task grain); over rows carry the textual `overBudgetFlag`.

### 2.11 Cost curve and S-curve forecast

Each leaf task's `estimated` spreads uniformly over its span (zero-span = a step at its date); `actual` spreads over the span's part up to the status date. `costCurve()` returns cumulative planned/actual at every distinct task boundary plus the status date, ascending. `costForecast()` returns the SAME point set — nothing is appended: points strictly before the status date are unchanged, and every point at or after the status date (the status-date point itself included) additionally carries `forecast = actualToDate + f × (planned(t) − plannedToDate)` with `f = actualToDate / plannedToDate` (1 when planned-to-date is 0) — the classic CPI extrapolation, landing on `f × totalPlanned`. The curve panel draws planned solid, actual solid in a second color, forecast dashed; tokens `--sg-cost-planned` (`#1565c0`), `--sg-cost-actual` (`#c62828`); accessible per-point list via `costCurvePoint`; `costCurveEmpty` with no data. Breakdown panel: one labelled horizontal bar per non-zero type, text via `breakdownEntry`; per-type tokens `--sg-cost-labor` / `--sg-cost-fixed` / `--sg-cost-variable` / `--sg-cost-material` (`#1565c0` / `#6a1b9a` / `#b45309` / `#2e7d32`); type names always printed beside the bars.

### 2.12 Custom cost formulas

`cost.formulas` resolves at setup: omitted `id` → `formula-<n>` (n over usable inits), omitted `label` → `formulaName(n)`, colliding id replaces its holder in place, no-`evaluate` inits dropped. Evaluated per table-panel open, in configuration order, over the leaf rows (`filter` → `totals`/`byCode` sums of `fixedCost`/`materialCost`/`actualCost` only → `evaluate` → `format` or the built-in `Intl.NumberFormat("en-US")` rounding). Containment per call, UNLATCHED: a throw reports once via `core/pluginError` (`where: "formulas.<id>"`) and drops the row for that render; non-finite results drop silently. Rows render below the totals row.

### 2.13 The `renderPanel` seams

`cost.renderPanel` and `evm.renderPanel` are the uniform host rendering seam: the plugin builds the chrome (dialog, title, footer buttons) and hands the seam the empty scrolling body; called on every open with `ctx.panel` / `ctx.model` / `ctx.close()`; returning empty is not a fallback signal; a throw hits the LATCHED barrier — one `core/pluginError` (`where: "renderPanel"`), the body emptied and rendered built-in, and the seam never called again for the instance's life (per config field: cost's latch spans its three panels, evm's its two). The seam replaces the body only — role, label, focus, Escape, and Close stay the plugin's.

### 2.14 EVM input resolution and status date (internal/evm)

Per task at computation time: **BAC** = usable `meta.evm.bac`, else the internal cost module's `costOf(id).estimated`, else 0; **AC** = usable `meta.evm.actualCost`, else `costOf(id).actual`, else 0; **planned dates** = the task's snapshot in the ACTIVE baseline when one is active (absent snapshots fall through), else current `start`/`end`; **raw progress `p`** = usable `physicalPercent / 100` from `meta.progressTracking`, else `clamp(task.progress, 0, 1)`.

Design note: the four areas are one plugin and the fan-in is unconditional internal calls: BAC/AC always fall through to the cost computation, planned dates always honor an active baseline, `p` always honors a stored physical percent — a task carrying `meta.costTracking` data always feeds the EVM fallback.

**Status date chain** (internal/shared): evm = `evm.statusDate` when finite → the progress area's `statusDate()` → start of the current UTC day, tracked live. cost = `cost.statusDate` when finite → start of the current UTC day. progress = `progress.statusDate` when finite → start of the current UTC day. (The evm→progress hop is an internal call.)

### 2.15 Accrual, indices, S-curve

Accrual methods over `p`: `percentComplete` → `p`; `zeroHundred` → 1 iff `p ≥ 1`; `fiftyFifty` → 0 / 0.5 / 1; `milestoneWeighted` → completed-weight fraction over the stored milestones, falling back to `percentComplete` without usable milestones. EV = `earned × BAC`. PV spreads BAC uniformly: `BAC × clamp((s − start) / (end − start), 0, 1)`; a zero-or-negative span contributes its whole BAC once `s ≥ start`. Project metrics sum PV/EV/AC, use `projectBac()` as aggregate BAC, and derive indices from sums. EAC: `"cpi"` → `BAC / CPI` (BAC when CPI absent/0); `"remaining"` → `AC + (BAC − EV)`; `"cpiSpi"` → `AC + (BAC − EV) / (CPI × SPI)` falling back to `"remaining"` when the factor is absent/≤ 0; `etc = eac − ac` always.

Function forms: `method` accepts an `EvmAccrualFn` (earned value at the status date; becomes the fraction `value / BAC`, 0 at zero budget; fractions above 1 legal; non-finite ignored per task) standing only where the enum default would; `eacMethod` accepts an `EvmEacFn` called with FINISHED indices (`eac`/`etc` pre-filled with the `"cpi"` result). Each is latched: first throw reports (`where: "method"` / `"eacMethod"`), then `"percentComplete"` / `"cpi"` answer for the instance's life; `method()`/`methodOf()` report the fallback name.

S-curve: sample times = ascending distinct set of every planned boundary, every snapshot date, and the status date; `pv` cumulative everywhere; `ev`/`ac` present only at times ≤ status date, interpolating linearly over `(earliest planned start, 0)` → snapshots (≤ status date, ascending; a snapshot at or before the zero anchor drops the anchor) → `(status date, current EV/AC)`; absent past the status date. No tasks ⇒ empty curve.

Dashboard panel: ten built-in tiles (BAC PV EV AC SV CV SPI CPI EAC ETC), each label / rounded value (`Intl.NumberFormat("en-US")`; SPI/CPI two decimals, `"—"` when absent) / gloss / optional textual flag (`spiBehindFlag` on SPI < 1, `cpiOverFlag` on CPI < 1); grid `repeat(auto-fit, minmax(150px, 1fr))` in the scrolling body; opens with `dashboardDescription`; `evmCurveEmpty` when BAC 0, no values, no formulas. Custom tiles append after the ten, in configuration order: an unusable init (non-object, or no `evaluate` function) is dropped at setup; an omitted `id` generates `formula-<n>` (n over the usable inits); an omitted `label` falls back to the RESOLVED id (deliberately not `formulaName` — that builder belongs to the cost area); a colliding id replaces its holder in place. Evaluation is per panel open, per-call contained (unlatched; `where: "formulas.<id>.evaluate"` / `".format"`; non-finite results dropped silently, a throwing `format` answered by the built-in rounding); formula tiles carry no gloss. Curve panel: PV solid, EV dashed `[6,3]`, AC dashed `[2,2]`; tokens `--sg-evm-pv` / `--sg-evm-ev` / `--sg-evm-ac` (`#1565c0` / `#2e7d32` / `#c62828`); accessible list via `evmCurvePoint`; opens with `curveDescription`.

### 2.16 Panels — shared rules

All panels of this plugin are `sdk/dialog` dialogs hosted by the gantt root (header/title, scrolling body, footer buttons, drag, resize grip, Escape, pointer containment, `--sg-dialog-*` tokens; cost/evm panels `minWidth: "360px"`, `top: 24`, `maxHeight: "80%"`, `resizable: true`). At most one panel per feature area is open at a time. Every `open…` returns `false` — and mounts nothing — while `stargantt.view` does not resolve (no composed chart provider, no panel). All panel DOM and listeners exist only while open, torn down by one `ctx.own()`-registered disposer.

## 3. Extension points

### 3.1 Defined by this plugin

None.

### 3.2 Contributed by this plugin

| Target | Contribution | Order / condition |
|---|---|---|
| `renderer/layers` | baseline bars underlay (§2.3) | `ctx.claimOrder("renderer/layers", "stargantt.tracking:baselines", 50)` — ground under the today line (55) and the bars (60). Registered unconditionally with the `baselines` nest present; draws only while a baseline is active and `bars` is on. |
| `renderer/layers` | actual bars + baseline CP rings (§2.3/§2.4) | `ctx.claimOrder("renderer/layers", "stargantt.tracking:actuals", 62)` — above the bars (60), below the progress line (65) and the link lines (69). |
| `renderer/layers` | progress line (§2.7) | `ctx.claimOrder("renderer/layers", "stargantt.tracking:progress-line", 65)` — above the actuals band, below the link lines (69). Registered unconditionally with the `progress` nest present (§2.7's toggle rule). |
| `taskbars/overlays` | slip indicators (§2.3) | with the `baselines` nest present; skipped per bar while off-threshold. |
| `taskbars/overlays` | RAG badge — filled circle radius 5, letter `R`/`A`/`G` in `--sg-rag-badge-fg` (`#ffffff`), centered 8 px left of `bar.x − bar.gutterStart`; skipped for unclassified tasks and bars under 12 px tall | with the `progress` nest present, unless `showRagOnBars: false`. |
| `taskbars/style` | RAG recoloring — returns the class token color for classified tasks, `undefined` otherwise (tokens `--sg-rag-red` / `--sg-rag-amber` / `--sg-rag-green`, fallbacks `#c62828` / `#b45309` / `#2e7d32`) | only under `progress.colorBars: true` (recoloring is gated, never default). |

Collision cross-check: against every claim in the corpus — view 10/55, task-bars 60/80, interaction 70/100, a11y 75, scheduling 8/56/69/72/110 — the three orders 50 / 62 / 65 collide with nothing (they are the values scheduling.md's cross-check lists for this plugin). Contribution types for `taskbars/*` arrive via `import type` from `@stargantt/plugin-task-bars` (devDependency — the type-only exemption).

This plugin deliberately contributes to neither `grid/columns` nor `export/auxiliarySurfaces` (the auxiliary-surface contributors are view's header band and resource's load band, per export.md §4).

## 4. Commands and events

**Commands:** none. Every mutation is a public data-store command dispatch.

**Events:**

- Emits: none of its own. There are no `baselines/changed` / `baselines/activeChanged` / `costTracking/changed` / `evm/changed` events — the four service `state` stores are the change channels (§1).
- Consumes the hook `data/willApplyTransaction` (via `sdk/aggregate`'s `createTransactionBatcher` for the one-transaction batch writes of §2.5).
- Store subscriptions: `data.tasks` (layer repaints, CPM memo invalidation, panel refreshes), plus per-use reads of `rows`, `timeline`, `theme`, `task-bars` surfaces at draw time (§6).

## 5. Config

Factory: `tracking(config?: TrackingConfig)`. Each feature = one nested config group. **Presence semantics (normative):** each of the four nests omitted leaves that feature DORMANT — no layer draw, no bar contribution, no panel can open — while the nest's service stays provided over empty state (§1). Passing a nest (even `{}`) enables the feature with the defaults below. Unusable field values silently fall back to their defaults; everything is read once at `setup()` except the live "current UTC day" status-date fallbacks. A single top-level `messages?: Partial<TrackingMessages>` covers every feature (§6).

### 5.1 `baselines` — 8 fields

| Field | Type | Default | Semantics |
|---|---|---|---|
| `baselines` | `readonly BaselineInit[]` | `[]` | Baselines registered at setup, in order (host persistence or export.md's `baselineInits`). |
| `active` | `BaselineId` | none | The initially active baseline; unknown ids ignored. |
| `bars` | `boolean` | `true` | Draw the active baseline's bars (§2.3). |
| `barStyle` | `"under" \| "overlay"` | `"under"` | Thin bottom-of-row bars vs translucent overlay rects. |
| `actualBars` | `boolean` | `true` | Draw actual bars for tasks carrying actual dates (§2.4). |
| `slipIndicators` | `boolean` | `true` | Per-task slip glyph+text beside bars (§2.3). |
| `slipThresholdMs` | `number` (ms) | `86_400_000` | Minimum absolute slip an indicator is shown for; exact comparison. |
| `criticalPath` | `boolean` | `false` | Critical-path change rings (§2.3). |

### 5.2 `progress` — 6 fields

| Field | Type | Default | Semantics |
|---|---|---|---|
| `statusDate` | `number` (epoch ms) | start of current UTC day, live | Fixed status date for line and report. |
| `progressLine` | `boolean` | `false` | Initial state of the runtime line toggle (§2.7). |
| `colorBars` | `boolean` | `false` | Recolor bars by RAG via `taskbars/style` (§3.2). |
| `progressWeighting` | `"count" \| "duration"` | `"count"` | How the report's `percentComplete` weights each leaf (§2.6). |
| `showRagOnBars` | `boolean` | `true` | The lettered RAG badge left of classified bars. |
| `snapshots` | `readonly ProgressSnapshot[]` | `[]` | Seed trend snapshots; unusable entries dropped, order normalized. |

### 5.3 `cost` — 8 fields

| Field | Type | Default | Semantics |
|---|---|---|---|
| `rates` | `readonly CostRateInit[]` | `[]` | Rate-master seed; unusable inits dropped. |
| `hoursPerDay` | `number` | `8` | Working hours per UTC day — the labor-effort density (§2.8). |
| `budget` | `number` | none | Project budget. |
| `budgets` | `Readonly<Record<string, number>>` | `{}` | Per-cost-code budgets; unusable entries dropped. |
| `alertThreshold` | `number` | `1` | Alert threshold as a fraction of the reference (§2.10). |
| `statusDate` | `number` (epoch ms) | start of current UTC day | Fixed status date for curve/forecast. |
| `formulas` | `readonly CostFormulaInit[]` | `[]` | Custom table-panel metrics (§2.12). |
| `renderPanel` | `(host, ctx: CostPanelRenderContext) => void` | none | The §2.13 body seam over the three cost panels. |

(Message keys of all four areas live in the single top-level catalog — §6.)

### 5.4 `evm` — 7 fields

| Field | Type | Default | Semantics |
|---|---|---|---|
| `method` | `EarnedValueMethod \| EvmAccrualFn` | `"percentComplete"` | Default accrual method or host rule (§2.15). |
| `eacMethod` | `EacMethod \| EvmEacFn` | `"cpi"` | EAC formula or host rule (§2.15). |
| `formulas` | `readonly EvmFormulaInit[]` | none | Extra KPI tiles after the ten built-ins (§2.15). |
| `renderPanel` | `(host, ctx: EvmPanelRenderContext) => void` | none | The §2.13 body seam over the two EVM panels. |
| `statusDate` | `number` (epoch ms) | §2.14 chain | Fixed status date. |
| `projectBac` | `number` | sum of task BACs | Seed of the session project-BAC override. |
| `snapshots` | `readonly EvmSnapshot[]` | `[]` | Seed EV/AC snapshots; last entry per UTC day kept, unusable dropped. |

## 6. Messages

`TrackingMessages` — one merged catalog (single top-level `messages` key), resolved once at setup with the shared catalog merge rules (`sdk/dom` `resolveCatalog`). Latched builders (first throw reported once, then the built-in default for the instance's life): `slipLabel` and `duration` (per-paint paths). Every other builder is gesture/report-driven and guarded per call, unlatched.

One catalog covers the four feature areas — **73 keys**. Shared keys: `duration` is the plugin's ONE duration formatter, routed through `internal/shared/` to every built-in duration-embedding builder (`slipLabel`'s default, the variance CSV cells, `reportLateLine`, the bulk-panel echo); `panelClose` (`"Close"`) serves every cost/EVM panel. Area-specific curve keys are prefixed (`costCurveTitle` / `evmCurveTitle`, `costCurveEmpty` / `evmCurveEmpty`, `costCurvePoint` / `evmCurvePoint`); the cost area's baseline-name builder is `costBaselineName` while the baselines area owns the plain `baselineName`.

| Key | Area | Default |
|---|---|---|
| `baselineName` | baselines | builder `(ordinal) => "Baseline <n>"` |
| `slipLabel` | baselines | builder `(slipMs) => signed auto-magnitude duration` (`"+3d"`, `"-4h"`) — composes the resolved `duration` |
| `duration` | baselines + progress | builder `(ms) => auto-magnitude duration` (`"1.5d"` / `"4h"` / `"30m"` / `"12s"` — the sdk formatter) |
| `reportTask` | baselines | `"Task"` |
| `reportBaselineStart` | baselines | `"Baseline start"` |
| `reportBaselineFinish` | baselines | `"Baseline finish"` |
| `reportStart` | baselines | `"Start"` |
| `reportFinish` | baselines | `"Finish"` |
| `reportStartVariance` | baselines | `"Start variance"` |
| `reportFinishVariance` | baselines | `"Finish variance"` |
| `reportDurationVariance` | baselines | `"Duration variance"` |
| `bulkTitle` | progress | `"Update progress"` |
| `bulkTaskHeader` | progress | `"Task"` |
| `bulkProgressHeader` | progress | `"Progress %"` |
| `bulkRemainingHeader` | progress | `"Remaining work"` |
| `bulkApply` | progress | `"Apply"` |
| `bulkCancel` | progress | `"Cancel"` |
| `trendTitle` | progress | `"Progress trend"` |
| `trendClose` | progress | `"Close"` |
| `trendEmpty` | progress | `"No snapshots recorded"` |
| `trendLine` | progress | builder `(s: ProgressSnapshot) => "<YYYY-MM-DD> — <p>% complete, <n> late, <m> done"` |
| `reportTitle` | progress | builder `(statusDate) => "Status report — <YYYY-MM-DD>"` |
| `reportSummary` | progress | builder `(r: StatusReport) => "<t> tasks — <c> completed, <i> in progress, <n> not started, <p>% complete"` |
| `reportLateHeading` | progress | builder `(count) => "Late tasks (<count>)"` |
| `reportLateLine` | progress | builder `(e: LateTaskEntry) => "<name> — <lateness> late"` — lateness through the resolved `duration` |
| `tableTitle` | cost | `"Budget vs actual"` |
| `tableTaskHeader` | cost | `"Task"` |
| `tableEstimatedHeader` | cost | `"Planned"` |
| `tableActualHeader` | cost | `"Actual"` |
| `tableVarianceHeader` | cost | `"Variance"` |
| `tableFixedHeader` | cost | `"Fixed cost"` |
| `tableMaterialHeader` | cost | `"Material cost"` |
| `tableActualInputHeader` | cost | `"Actual cost"` |
| `tableApply` | cost | `"Apply"` |
| `tableCancel` | cost | `"Cancel"` |
| `overBudgetFlag` | cost | `"over budget"` |
| `totalLabel` | cost | `"Total"` |
| `costCurveTitle` | cost | `"Cost curve"` |
| `costCurveEmpty` | cost | `"No cost data"` |
| `panelClose` | cost + evm | `"Close"` |
| `costCurvePoint` | cost | builder `(p: CostCurvePoint) => "<YYYY-MM-DD> — planned <p>, actual <a>"` (`, forecast <f>` on forecast points) |
| `breakdownTitle` | cost | `"Cost breakdown"` |
| `breakdownEntry` | cost | builder `(e) => "<type> — <amount> (<percent>%)"` |
| `costBaselineName` | cost | builder `(n) => "Cost baseline <n>"` |
| `formulaName` | cost | builder `(n) => "Formula <n>"` |
| `dashboardTitle` | evm | `"Earned value"` |
| `evmCurveTitle` | evm | `"EVM S-curve"` |
| `evmCurveEmpty` | evm | `"No EVM data"` |
| `bacLabel` | evm | `"BAC"` |
| `pvLabel` | evm | `"PV"` |
| `evLabel` | evm | `"EV"` |
| `acLabel` | evm | `"AC"` |
| `svLabel` | evm | `"SV"` |
| `cvLabel` | evm | `"CV"` |
| `spiLabel` | evm | `"SPI"` |
| `cpiLabel` | evm | `"CPI"` |
| `eacLabel` | evm | `"EAC"` |
| `etcLabel` | evm | `"ETC"` |
| `spiBehindFlag` | evm | `"behind schedule"` |
| `cpiOverFlag` | evm | `"over cost"` |
| `bacGloss` | evm | `"Total budget for all the work."` |
| `pvGloss` | evm | `"Budgeted cost of the work planned by now."` |
| `evGloss` | evm | `"Budgeted cost of the work actually finished."` |
| `acGloss` | evm | `"What has actually been spent."` |
| `svGloss` | evm | `"Earned minus planned. Below zero means behind schedule."` |
| `cvGloss` | evm | `"Earned minus spent. Below zero means over budget."` |
| `spiGloss` | evm | `"Schedule efficiency. Above 1 is ahead of plan."` |
| `cpiGloss` | evm | `"Cost efficiency. Above 1 is under budget."` |
| `eacGloss` | evm | `"Projected total cost if the current trend holds."` |
| `etcGloss` | evm | `"Projected cost of the work still to do."` |
| `dashboardDescription` | evm | `"Earned-value metrics as of the status date, in the project's cost unit."` |
| `curveDescription` | evm | `"Cumulative cost over time: planned (PV), earned (EV) and actual (AC)."` |
| `evmCurvePoint` | evm | builder `(p: EvmCurvePoint) => "<YYYY-MM-DD> — PV <pv>"` (`, EV <ev>` / `, AC <ac>` when present) |

Amounts in cost/EVM builders render rounded through `Intl.NumberFormat("en-US")` with no currency symbol (SPI/CPI two decimals); the plugin never assumes a currency — hosts wanting locale/currency formatting replace the builders.

## 7. Internal modules

Directory = feature area; every file ≤ 800 lines; every area enters through `wire.ts`.

| Directory | Files | Content |
|---|---|---|
| root (4) | `index.ts`, `types.ts`, `config.ts`, `internal/messages.ts` | factory, wiring, the five `claimKey` and three `claimOrder` calls; the single declaration-merging site; nest resolution; the 73-key catalog + resolver |
| `internal/shared/` (3) | `status-date.ts` | the §2.14 resolution chains |
| | `snapshot-series.ts` | the day-stamped, replace-per-day snapshot series |
| | `meta-bag.ts` | the defensive bag read / sibling-preserving write / `clears` cleanup shared by the three object bags |
| `internal/baselines/` (6) | `wire.ts`, `set.ts`, `variance.ts`, `paint.ts`, `cpm.ts`, `service.ts` | area wiring + config; baseline set + actuals storage; variance/summary/CSV; the 50/62 layers + slip overlay; sdk/cpm comparison + memos; the store-shaped service (new split) |
| `internal/progress/` (8) | `wire.ts`, `values.ts`, `report.ts`, `line.ts`, `rag.ts`, `bulk-panel.ts`, `trend-panel.ts`, `service.ts` | wiring; meta storage + setters; status report + lateness; the order-65 layer; style provider + badge overlay; the two panels; the service |
| `internal/cost/` (8) | `wire.ts`, `rates.ts`, `values.ts`, `compute.ts`, `budgets.ts`, `curve.ts`, `formulas.ts`, `panels.ts` | wiring + service assembly; rate master; meta storage; cost composition + leaf rules; budgets + alerts + cost baselines; curve/forecast; custom formulas; the three panels + renderPanel seam |
| `internal/evm/` (6) | `wire.ts`, `values.ts`, `engine.ts`, `scurve.ts`, `formulas.ts`, `panels.ts` | wiring + service assembly; meta storage; input resolution, accrual, indices, EAC; the §2.15 curve; KPI formulas; the two panels + seam |

## 8. Dependencies

`dependsOn` (hard): `data` (L1) — the only edge the plugin cannot function without: every service computes from the data stores and every write is a data command. All chart-surface edges follow the scheduling.md §14 optional-inert pattern: `view` (L2 — layers, theme tokens, timeline t↔x, panel host/gating) and `task-bars` (L4 — bar geometry, gutters, style/overlay points) are optional; absent, every visual area stays silently inert (no `core/pluginError`) while the four services, the reports, and the meta write paths keep working — the headless composition `dataStore() + tracking()` computes variance, status reports, costs, and EVM in plain Node. `meta.optional`: `stargantt.view`, `stargantt.task-bars`, `stargantt.tree-grid`, `stargantt.resource`. Resolution timing per the §14 rule: claims (`claimKey`/`claimOrder`) at setup; optional services resolved at `lifecycle/ready` or per use, never latched into variables at setup.

Also optional (late lookup): `rows` (tree-grid, L3 — visible-row walks for the baseline underlay; absent, that pass is inert), `resource-pool` (resource, L7, same-layer optional — the §2.8 cost-rate fallback; the architecture ch. 5 "tracking ⇄ resource" sanctioned edge). No edge to `stargantt.critical-path` exists (§1.1). No upward `ctx.use` edge exists. Sibling types arrive via `import type` (devDependencies).

## 9. Third-party surface

- **Consumable services:** `stargantt.baselines` (`BaselinesService` — baseline-set store, snapshots, variance/CSV, actuals, CP delta), `stargantt.progress` (`ProgressService` — session-state store, RAG/effort/physical setters, report, trend, panels), `stargantt.cost` (`CostService` — rates/budgets/baselines store, computed costs, alerts, curve, panels), `stargantt.evm` (`EvmService` — override/snapshot store, metrics, S-curve, panels). The collaboration among the four areas is internal, but each datum remains reachable through these services.
- **Contributable extension points:** none defined by this plugin. The points it contributes to (`renderer/layers`, `taskbars/style`, `taskbars/overlays`) remain public points of lower-layer plugins, open to third parties alongside tracking's contributions.
- **Subscribable events:** none of its own; all tracking state is observed via the four `state` stores (and the `data` stores for the meta bags).
- **Config-function seams:** `cost.formulas` / `evm.formulas` (custom metrics/tiles), `cost.renderPanel` / `evm.renderPanel` (the body seam), `evm.method` / `evm.eacMethod` function forms — all foreign code, contained per §2.12/§2.13/§2.15.
- **`task.meta` bag:** the five claimed keys of §2.1; third parties reading or writing them get exactly the documented semantics, patch/undo-integrated (`claimKey` collision reporting protects against double claims).
- **Canonical types:** `BaselineInit` (§1.1) is the authoritative baseline-seed shape consumed by export.md's MSPDI import result and by host persistence flows.
- **Reserved namespaces (documentation convention only):** the `stargantt.baselines` / `stargantt.progress` / `stargantt.cost` / `stargantt.evm` service IDs, the `stargantt.tracking:*` keys in the `renderer/layers` order scope, and the five claimed meta keys. Not enforced in core beyond arbitration-registry conflict reporting.
- **Hardening:** every host-supplied function (message builders, formulas, accrual/EAC rules, renderPanel) is guarded by the core error boundary with the latch/unlatch classification recorded per seam (§2.12, §2.13, §2.15, §6). Store snapshots handed out are immutable per the core store contract. All query members are side-effect-free.
