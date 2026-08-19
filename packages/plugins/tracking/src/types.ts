// docs/specs/plugins/tracking.md §1 — the four service surfaces (`BaselinesService`,
// `ProgressService`, `CostService`, `EvmService`) and every type they exchange. Transcribed from
// the spec's own TypeScript blocks, which are already the normative shape — this file adds nothing
// beyond combining per-section imports and keeping the doc comments verbatim.
import type { Store } from "@stargantt/core";
import type { LinkType, ResourceId, Task, TaskId } from "@stargantt/plugin-data-store";

/* ==================================================================== *
 * §1.1 `stargantt.baselines` → `BaselinesService`
 * ==================================================================== */

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
 * CANONICAL DECLARATION: this is the authoritative `BaselineInit`; the export plugin imports it as
 * `import type { BaselineInit } from "@stargantt/plugin-tracking"` (type-only devDependency).
 * Reconciliation (recorded): every object export produces satisfies this
 * type — `id`/`name` are optional here and always present there; `capturedAt` and `links`
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

/** The observable baseline-set state (replaces `baselines/changed` + `baselines/activeChanged`). */
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

/* ==================================================================== *
 * §1.2 `stargantt.progress` → `ProgressService`
 * ==================================================================== */

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

/* ==================================================================== *
 * §1.3 `stargantt.cost` → `CostService`
 * ==================================================================== */

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

/** What a `cost.renderPanel` call receives (the uniform seam; §2.13). */
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

/** The observable cost session state (replaces `costTracking/changed`). */
export interface CostState {
  /** The rate master, keyed by resource id. */
  readonly rates: ReadonlyMap<ResourceId, Readonly<CostRate>>;
  /** The project budget, or undefined when none is set. */
  readonly budget: number | undefined;
  /** Per-cost-code budgets. */
  readonly codeBudgets: ReadonlyMap<string, number>;
  /** Saved cost baselines, oldest first. */
  readonly baselines: readonly CostBaseline[];
}

export interface CostService {
  /** Set once per observable session-state mutation (rates, budgets, cost baselines);
   *  a config seed that loaded anything sets it once at setup; no-change mutations set
   *  nothing (store-shaped — the deferred `cause: "config"` seed event is subsumed by the
   *  store's initial value). */
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

/* ==================================================================== *
 * §1.4 `stargantt.evm` → `EvmService`
 * ==================================================================== */

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

/** The observable EVM session state (replaces `evm/changed`). */
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
