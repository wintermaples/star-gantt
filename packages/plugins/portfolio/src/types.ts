// docs/specs/plugins/portfolio.md §1
/**
 * Public types of `@stargantt/plugin-portfolio`: the portfolio node hierarchy (initiative >
 * program > project), project health, goals/OKRs, template duplication, the portfolio filter
 * views, and the dashboard's aggregation model, panel and formula surface.
 *
 * This is the package's single `declare module "@stargantt/core"` site (§Internal modules):
 * the two services (`stargantt.portfolio`, `stargantt.dashboard`) and the three `dashboard/*`
 * events are declared at the bottom of this file.
 */
import type { Store } from "@stargantt/core";
import type { ResourceId, Task, TaskId } from "@stargantt/plugin-data-store";
import type { RagStatus } from "@stargantt/plugin-tracking";
import type { DashboardModel } from "./internal/dashboard/model";

// Re-exported: `DashboardWidgetRenderContext.model` below hands `DashboardModel` to host code, so
// it is part of the public surface even though the module that assembles it stays internal
// (type-only, erased at emit, no runtime coupling).
export type { DashboardModel } from "./internal/dashboard/model";

/* ==================================================================== *
 * Portfolio — node hierarchy, health, goals, templates, filter/views
 * ==================================================================== */

/** Identifier of a portfolio node. Unique within the plugin's node set. */
export type PortfolioNodeId = string | number;

/**
 * The rank of a portfolio node, highest first: an initiative groups programs, a program groups
 * projects, and a project binds to one task subtree of the store.
 */
export type PortfolioNodeKind = "initiative" | "program" | "project";

/** A portfolio node supplied through config or `PortfolioService.defineNode`. */
export interface PortfolioNodeInit {
  /** Defaults to a generated id unique within the set. A colliding id replaces its holder. */
  id?: PortfolioNodeId;
  /** Defaults to a generated name built by the `nodeName` message builder. */
  name?: string;
  /** Defaults to `"project"`. An unknown kind counts as absent. */
  kind?: PortfolioNodeKind;
  /**
   * The grouping parent. Usable only when it names an already-defined node of a strictly higher
   * rank (initiative above program above project); otherwise the node is a root.
   */
  parentId?: PortfolioNodeId;
  /**
   * Project nodes only: the id of the task whose subtree is the project. Ignored on programs and
   * initiatives. The task does not have to exist yet; a project without a resolvable root task
   * simply has no tasks.
   */
  taskId?: TaskId;
}

/** One node of the portfolio hierarchy. */
export interface PortfolioNode {
  id: PortfolioNodeId;
  name: string;
  kind: PortfolioNodeKind;
  /** The grouping parent, absent on roots. */
  parentId?: PortfolioNodeId;
  /** The project's root task, present only on project nodes that declared one. */
  taskId?: TaskId;
}

/** A portfolio node with its children nested, as `PortfolioService.tree()` returns it. */
export interface PortfolioTreeNode extends PortfolioNode {
  children: readonly PortfolioTreeNode[];
}

/** The traffic-light health state of a project. */
export type PortfolioHealthStatus = "on-track" | "at-risk" | "late";

/** The aggregated schedule health of one portfolio node. */
export interface PortfolioHealth {
  nodeId: PortfolioNodeId;
  /**
   * `"late"` when at least one task is past its end and unfinished, `"at-risk"` when at least
   * one running task is behind its time-linear expected progress, `"on-track"` otherwise.
   */
  status: PortfolioHealthStatus;
  /** Number of tasks aggregated (summary rows are not counted). */
  taskCount: number;
  /** Tasks past their end date with progress below 1. */
  lateCount: number;
  /** Running tasks whose progress trails the elapsed fraction of their duration. */
  atRiskCount: number;
  /** Duration-weighted mean progress over the aggregated tasks, 0..1. 0 when there are none. */
  progress: number;
}

/** Identifier of a portfolio goal. Unique within the plugin's goal set. */
export type PortfolioGoalId = string | number;

/** A goal/OKR supplied through config or `PortfolioService.defineGoal`. */
export interface PortfolioGoalInit {
  /** Defaults to a generated id unique within the set. A colliding id replaces its holder. */
  id?: PortfolioGoalId;
  /** Defaults to a generated name built by the `goalName` message builder. */
  name?: string;
  /** Portfolio nodes whose project task subtrees feed the goal's progress. Unknown ids contribute nothing. */
  nodeIds?: readonly PortfolioNodeId[];
  /** Tasks (each with its subtree) that feed the goal's progress directly. */
  taskIds?: readonly TaskId[];
  /** The progress the goal aims for, 0..1. Defaults to 1; non-finite values are ignored. */
  target?: number;
}

/** One goal of the portfolio. */
export interface PortfolioGoal {
  id: PortfolioGoalId;
  name: string;
  nodeIds: readonly PortfolioNodeId[];
  taskIds: readonly TaskId[];
  target: number;
}

/** The computed progress of one goal against its target. */
export interface PortfolioGoalProgress {
  goalId: PortfolioGoalId;
  /** Duration-weighted mean progress over the linked tasks, 0..1. 0 when none resolve. */
  progress: number;
  target: number;
  /** Whether `progress >= target` and at least one task is linked. */
  achieved: boolean;
  /** Number of distinct tasks that fed the aggregate. */
  taskCount: number;
}

/** Options of `PortfolioService.duplicateProject`. */
export interface DuplicateProjectOptions {
  /** Name of the duplicated root task. Defaults to the `copyName` message builder's output. */
  name?: string;
  /**
   * Epoch ms the duplicate starts at: every copied date is shifted by
   * `startAt − sourceRootStart`. Defaults to no shift.
   */
  startAt?: number;
  /** Keep each task's progress instead of resetting it. Defaults to `false` (progress cleared). */
  keepProgress?: boolean;
}

/** A saved portfolio view: which portfolio nodes the row filter is narrowed to. */
export interface PortfolioView {
  /** The node ids the filter narrows to; `null` or absent = no narrowing. */
  nodeIds?: readonly PortfolioNodeId[] | null;
}

/** The portfolio service: node hierarchy, health, goals, templates, filtering and task moves. */
export interface PortfolioService {
  /** The node set, definition order. A fresh snapshot array per observable set change. */
  readonly nodes: Store<readonly Readonly<PortfolioNode>[]>;
  /** The goal set, definition order. A fresh snapshot array per observable set change. */
  readonly goals: Store<readonly Readonly<PortfolioGoal>[]>;

  /**
   * Defines a portfolio node (or replaces the holder of a colliding id). Returns the node's id,
   * or `undefined` for an unusable init. A parent id is honored only when it names an existing
   * node of a strictly higher rank.
   */
  defineNode(init: PortfolioNodeInit): PortfolioNodeId | undefined;
  /** Removes a node; its children are lifted to its parent. Unknown ids are a no-op. */
  removeNode(id: PortfolioNodeId): void;
  /** One node, or `undefined` for an unknown id. */
  node(id: PortfolioNodeId): Readonly<PortfolioNode> | undefined;
  /** The hierarchy nested: roots in definition order, children in definition order. */
  tree(): readonly PortfolioTreeNode[];
  /**
   * The project node a task belongs to — the first project whose root task is the task itself
   * or one of its ancestors — or `undefined` for none.
   */
  projectOf(taskId: TaskId): Readonly<PortfolioNode> | undefined;
  /**
   * The task ids at or below a node: a project's root-task subtree (root included), or the union
   * over a program's/initiative's project descendants. Empty for unknown ids and unbound
   * projects.
   */
  tasksOf(id: PortfolioNodeId): readonly TaskId[];
  /**
   * Collapses or expands a project's task group in the chart by toggling its root task's row.
   * Unknown ids, non-project nodes and unbound projects are a no-op.
   */
  setProjectCollapsed(id: PortfolioNodeId, collapsed: boolean): void;
  /** Collapses every bound project's task group. */
  collapseAllProjects(): void;
  /** Expands every bound project's task group. */
  expandAllProjects(): void;
  /**
   * The aggregated schedule health of a node's tasks as of `now` (default: the current time), or
   * `undefined` for an unknown id.
   */
  health(id: PortfolioNodeId, now?: number): PortfolioHealth | undefined;
  /** The health of every node in definition order, as of `now` (default: the current time). */
  healthSummary(now?: number): readonly PortfolioHealth[];
  /**
   * Defines a goal (or replaces the holder of a colliding id). Returns the goal's id, or
   * `undefined` for an unusable init.
   */
  defineGoal(init: PortfolioGoalInit): PortfolioGoalId | undefined;
  /** Removes a goal. Unknown ids are a no-op. */
  removeGoal(id: PortfolioGoalId): void;
  /**
   * The computed progress of a goal — the duration-weighted mean progress over the distinct
   * tasks its linked nodes and task subtrees resolve to — or `undefined` for an unknown id.
   */
  goalProgress(id: PortfolioGoalId): PortfolioGoalProgress | undefined;
  /**
   * Duplicates a project as a template instance: deep-copies its task subtree (and the links
   * internal to it) under fresh ids as a new top-level project, optionally shifted so the copy
   * starts at `options.startAt`, with progress cleared unless `options.keepProgress`. The whole
   * copy is one transaction — one undo step. `source` is a project node id (resolved first) or a
   * root task id. When the source is a project node, a new project node bound to the copy is
   * defined. Returns the new root task's id, or `undefined` when the source resolves to nothing.
   */
  duplicateProject(
    source: PortfolioNodeId | TaskId,
    options?: DuplicateProjectOptions,
  ): TaskId | undefined;
  /**
   * Moves a task (with its whole subtree) into another project by reparenting it under that
   * project's root task, as one undoable transaction. Returns `false` — and changes nothing —
   * when the task or target is unknown, the target project is unbound, or the move would place a
   * task inside its own subtree.
   */
  moveTaskToProject(taskId: TaskId, target: PortfolioNodeId): boolean;
  /**
   * Narrows the visible rows to the tasks of the given nodes through the interaction plugin's
   * `stargantt.filter` service; `null` removes the narrowing. A silent no-op without that
   * service. The task set is re-resolved from the store whenever data changes, so the narrowing
   * follows edits.
   */
  applyPortfolioFilter(nodeIds: readonly PortfolioNodeId[] | null): void;
  /** The node ids of the active portfolio narrowing, or `null` when none is active. */
  portfolioFilter(): readonly PortfolioNodeId[] | null;
  /** Saves the current narrowing under a name. Empty or non-string names are a no-op; a same-named save replaces. */
  savePortfolioView(name: string): void;
  /** Applies a saved view's narrowing. Returns `false` (changing nothing) for an unknown name. */
  applyPortfolioView(name: string): boolean;
  /** Deletes a saved view. Returns whether the name existed. */
  deletePortfolioView(name: string): boolean;
  /** The saved view names, in insertion order. */
  portfolioViewNames(): string[];
}

/* ==================================================================== *
 * Dashboard — KPI aggregations, panel, formulas, direct updates, export
 * ==================================================================== */

/** The identifier of one standard dashboard widget. */
export type DashboardWidgetId =
  | "summary"
  | "overdue"
  | "burndown"
  | "workload"
  | "status"
  | "milestones"
  | "goals"
  | "portfolio"
  | "groups"
  | "formulas";

/** The project-wide progress KPIs shown by the summary widget. */
export interface ProgressSummary {
  /** Leaf tasks counted (summary rows and tasks without finite dates are skipped). */
  taskCount: number;
  /** Tasks whose progress reached 1. */
  completedCount: number;
  /** `taskCount - completedCount`. */
  remainingCount: number;
  /** Tasks whose end passed the reference time with progress below 1. */
  overdueCount: number;
  /** Milestone-typed tasks counted separately (not part of `taskCount`). */
  milestoneCount: number;
  /** Duration-weighted mean progress over the counted tasks, 0..1; 0 for an empty set. */
  progress: number;
}

/** One row of the overdue-task widget. */
export interface OverdueEntry {
  id: TaskId;
  name: string;
  /** The task's exclusive end, epoch milliseconds. */
  end: number;
  /** Whole days the end trails the reference time; at least 1. */
  daysOverdue: number;
  /** The task's progress, read as 0 when absent, clamped to 0..1. */
  progress: number;
}

/** Task counts by completion state. */
export interface StatusCounts {
  notStarted: number;
  inProgress: number;
  completed: number;
}

/** One row of the milestone summary. */
export interface MilestoneEntry {
  id: TaskId;
  name: string;
  /** The milestone's date (its start), epoch milliseconds. */
  date: number;
  /** Whether the milestone's progress reached 1. */
  reached: boolean;
  /** Whether the date passed the reference time while the milestone is unreached. */
  overdue: boolean;
}

/** One bar of the per-assignee workload widget. */
export interface WorkloadEntry {
  resourceId: ResourceId;
  name: string;
  /** Sum over the resource's assignments of `units × task duration in days`. */
  personDays: number;
  /** Distinct non-summary tasks the resource is assigned to. */
  taskCount: number;
}

/** One bar of the group comparison widget. */
export interface GroupProgressEntry {
  /** The group label the `groupOf` hook (or the default grouping) produced. */
  group: string;
  /** Duration-weighted mean progress of the group's tasks, 0..1. */
  progress: number;
  taskCount: number;
}

/** One point of a burndown series. */
export interface BurndownPoint {
  /** Epoch milliseconds. */
  date: number;
  /** Tasks still incomplete at that date. */
  remaining: number;
}

/** The burndown model: the planned curve, and the actual curve where snapshots exist. */
export interface BurndownSeries {
  /** Leaf tasks counted (the curves' starting height). */
  taskCount: number;
  /**
   * The planned curve: each task counts as done at its end date, so the series steps down from
   * `taskCount` at the earliest start to 0 at the latest end. Empty for an empty task set.
   */
  planned: readonly BurndownPoint[];
  /**
   * The actual curve, derived from the tracking plugin's recorded progress snapshots
   * (`taskCount − completedCount` per snapshot, oldest first). Empty without that plugin or
   * without snapshots.
   */
  actual: readonly BurndownPoint[];
}

/** One row of the executive portfolio roll-up view. */
export interface PortfolioStatusRow {
  nodeId: PortfolioNodeId;
  name: string;
  /** Duration-weighted mean progress of the node's tasks, 0..1. */
  progress: number;
  /** The node's late-task count (the portfolio plugin's health rule). */
  lateCount: number;
  taskCount: number;
  /**
   * Schedule performance index: earned value over planned value, where each task's planned
   * value is its elapsed duration fraction and its earned value is its progress, both
   * duration-weighted. `undefined` when no planned value has accrued yet.
   */
  spi: number | undefined;
  /** The portfolio plugin's traffic-light status string for the node. */
  status: PortfolioHealthStatus;
}

/** One goal roll-up card row (the portfolio plugin's goal progress, ready for display). */
export interface GoalRollupEntry {
  goalId: PortfolioGoalId;
  name: string;
  /** Duration-weighted mean progress over the goal's linked tasks, 0..1. */
  progress: number;
  target: number;
  achieved: boolean;
  taskCount: number;
}

/** A custom metric supplied through config or `defineFormula`. */
export interface DashboardFormulaInit {
  /** Default: generated, unique among formulas; a colliding id replaces. */
  id?: string;
  /** Default: the `formulaName` message builder's output. */
  label?: string;
  /**
   * Narrows the task set the formula sees; absent = every task (summary rows included).
   * A throwing filter is contained per evaluation and counts as matching nothing.
   */
  filter?: (task: Readonly<Task>) => boolean;
  /** Computes the metric over the filtered tasks. Required — an init without it is ignored. */
  evaluate: (tasks: readonly Task[]) => number;
  /** Formats the computed number for display. Default: decimal with up to 2 fraction digits. */
  format?: (value: number) => string;
}

/** One evaluated formula card. */
export interface FormulaValue {
  id: string;
  label: string;
  /** The evaluated number, or `undefined` when the formula threw or returned a non-finite value. */
  value: number | undefined;
  /** The display text: the formatted value, or the `formulaError` message when it failed. */
  text: string;
}

/** A direct status update applied from the dashboard. */
export interface TaskStatusPatch {
  /** New progress, clamped to 0..1; non-finite values are ignored. */
  progress?: number;
  /** New RAG status (`null` clears it). Ignored when the tracking plugin is not composed or the
   *  value is not a known status. */
  rag?: RagStatus | null;
}

/**
 * What a `renderWidget` call receives for one widget's card body.
 *
 * The hook runs once per configured widget on every render, and is handed the card's body
 * element with its title already in place — everything below the title is yours.
 */
export interface DashboardWidgetRenderContext {
  /** Which widget's body this is. */
  readonly widget: DashboardWidgetId;
  /** The whole computed model — a widget often needs more than its own slice. */
  readonly model: Readonly<DashboardModel>;
  /** The overdue rows' quick-complete action, so a custom body can keep it. */
  markDone(taskId: TaskId): void;
}

/** The dashboard service: the panel, the widget aggregations and the report export. */
export interface DashboardService {
  /**
   * Opens the dashboard panel over the chart pane. Returns `false` — and does nothing — while
   * `stargantt.view` does not resolve; `true` when the panel is open (including when it already
   * was).
   */
  open(): boolean;
  /** Closes the panel; a no-op when it is not open. */
  close(): void;
  /** Whether the panel is currently open. */
  isOpen(): boolean;
  /**
   * Recomputes every widget and re-renders the open panel immediately. Aggregations are
   * otherwise recomputed automatically after data changes, so calling this is only needed to
   * reflect out-of-band inputs (for example a changed formula set) without waiting for one.
   * A no-op — nothing recomputed, nothing emitted — while the panel is not open.
   */
  refresh(): void;
  /** The panel's root element, or `undefined` when it is not open. */
  element(): HTMLElement | undefined;
  /** The progress KPIs: task counts, overdue count and weighted completion, as of `now` (default: the current time). */
  summary(now?: number): ProgressSummary;
  /** The overdue tasks (end passed, progress below 1), most-overdue first, as of `now`. */
  overdueTasks(now?: number): readonly OverdueEntry[];
  /** Task counts by completion state (not started / in progress / completed). */
  statusCounts(): StatusCounts;
  /** The milestone summary in date order, reached/pending/overdue as of `now`. */
  milestones(now?: number): readonly MilestoneEntry[];
  /** Per-resource assigned effort in person-days, largest first. */
  workload(): readonly WorkloadEntry[];
  /** Weighted progress per group label (the `groupOf` hook, or per first assigned resource). */
  groupComparison(): readonly GroupProgressEntry[];
  /**
   * The burndown model: the planned remaining-task curve derived from task end dates, and the
   * actual curve derived from the tracking plugin's recorded snapshots (empty without that
   * plugin).
   */
  burndown(): BurndownSeries;
  /** The portfolio goals with their rolled-up progress. */
  goalRollups(): readonly GoalRollupEntry[];
  /**
   * One row per portfolio node — progress, late count, traffic-light status and schedule
   * performance index as of `now`.
   */
  portfolioStatus(now?: number): readonly PortfolioStatusRow[];
  /**
   * Adds or replaces a user-defined formula card. Returns its id, or `undefined` for an init
   * without a usable `evaluate` function.
   */
  defineFormula(init: DashboardFormulaInit): string | undefined;
  /** Removes a formula card. Returns whether the id existed. */
  removeFormula(id: string): boolean;
  /** Every formula evaluated over the current task set, in definition order. */
  formulaValues(): readonly FormulaValue[];
  /**
   * Applies a status update to a task directly (the panel's quick actions commit through this).
   * A supplied `progress` is clamped to 0..1 and committed as one undoable `task/update`; a
   * supplied `rag` goes through the tracking plugin when composed (its own single undo step) and
   * is ignored otherwise. Returns `false` — changing nothing — for an unknown task or a patch
   * with no usable field.
   */
  updateTaskStatus(id: TaskId, patch: TaskStatusPatch): boolean;
  /**
   * Exports the dashboard as a report: `"png"` (default) returns a PNG data URL drawn from the
   * widget data (`undefined` while `stargantt.view` does not resolve, or no canvas 2D context is
   * available), `"pdf"` returns a single-page PDF data URL and always succeeds.
   */
  exportReport(format?: "png" | "pdf"): string | undefined;
}

/* ==================================================================== *
 * Config
 * ==================================================================== */

/** Options for `dashboard.widgets` gating: the panel boot behavior nested under `PortfolioConfig`. */
export interface PortfolioDashboardConfig {
  /** Opens the panel on `lifecycle/ready`. Default `false`. Focus is left untouched. */
  open?: boolean;
  /** The widgets to show, in order. Unknown entries are dropped. Default: all ten, union declaration order. */
  widgets?: readonly DashboardWidgetId[];
  /** Formula cards defined at setup, in order. */
  formulas?: readonly DashboardFormulaInit[];
  /**
   * Maps a task to its comparison-group label (for example a department name). Default: the
   * name of the task's first assigned resource. A throwing hook is contained per call and the
   * task is left out of the comparison.
   */
  groupOf?: (task: Readonly<Task>) => string | undefined;
  /**
   * Renders one widget's card body in place of the built-in one. Called once per configured
   * widget, per render, with the card's body element (already carrying its title) and the widget
   * being drawn. Appending nothing leaves an empty card body — that is not a fallback signal, it
   * is what the host asked for. A throw is reported once through `core/pluginError`, the body is
   * emptied, and the built-in body fills it instead; the seam then declines silently — no further
   * report, no further call — for the rest of the instance's life (a close/reopen does not reset
   * this).
   */
  renderWidget?: (host: HTMLElement, ctx: DashboardWidgetRenderContext) => void;
}

/** Options for the portfolio plugin. */
export interface PortfolioConfig {
  /** Nodes defined at setup, in order (parents must precede children to be honored). */
  nodes?: readonly PortfolioNodeInit[];
  /** Goals defined at setup, in order. */
  goals?: readonly PortfolioGoalInit[];
  /** Saved portfolio views seeded before any `savePortfolioView`. */
  views?: Record<string, PortfolioView>;
  /** The dashboard panel's own options. */
  dashboard?: PortfolioDashboardConfig;
  /** Per-key overrides of the plugin's built-in English text. */
  messages?: Partial<import("./internal/messages").PortfolioMessages>;
}

/* ==================================================================== *
 * Declaration merging (the single site, §Internal modules)
 * ==================================================================== */

declare module "@stargantt/core" {
  interface Services {
    /** The portfolio service: node hierarchy, health, goals, templates, filtering and task moves. */
    "stargantt.portfolio": PortfolioService;
    /** The dashboard service: the KPI panel, the widget aggregations and the report export. */
    "stargantt.dashboard": DashboardService;
  }
  interface Events {
    /** The dashboard panel was opened. */
    "dashboard/opened": void;
    /** The dashboard panel was closed. */
    "dashboard/closed": void;
    /**
     * The dashboard aggregations were recomputed: `cause` is `"data"` for the automatic
     * post-change refresh, `"api"` for an explicit `refresh()` call.
     */
    "dashboard/refreshed": { cause: "data" | "api" };
  }
}
