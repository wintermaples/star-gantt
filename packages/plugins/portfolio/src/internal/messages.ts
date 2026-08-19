// docs/specs/plugins/portfolio.md §Messages
/**
 * `PortfolioMessages` — the plugin's single merged message catalog.
 *
 * 23 keys, merged from two source catalogs: `portfolio` (3: `nodeName`, `goalName`, `copyName`)
 * and `dashboard` (20). The two key sets are disjoint, so the "prefixed only on collision" rule
 * fires nowhere — every key keeps its original name unchanged.
 *
 * Resolution is `sdk/dom`'s `resolveCatalog`: per-key shallow override, a key of the wrong kind
 * is ignored, the empty string is usable and taken verbatim, and a throwing/non-string-returning
 * builder is reported (`core/pluginError`) and answered by the built-in default for that call and
 * every later one (the catalog's own per-key latch — not the §3.7 `renderWidget` seam, which is
 * the plugin's one *frame-rate* latched barrier). Every builder here is data/gesture-driven, never
 * called per frame, so this per-key latch is the only containment they need.
 */
import { resolveCatalog } from "@stargantt/sdk";
import type {
  BurndownPoint,
  DashboardWidgetId,
  OverdueEntry,
  PortfolioNodeKind,
  PortfolioStatusRow,
  ProgressSummary,
} from "../types";

/** Argument of the `nodeName` builder. */
export interface NodeNameArg {
  kind: PortfolioNodeKind;
  /** 1-based ordinal among generated names of the same kind. */
  ordinal: number;
}

/** Every piece of user-visible text the plugin produces, across both feature areas. */
export interface PortfolioMessages {
  /* --- portfolio (3) --------------------------------------------------- */
  /**
   * Builds the name of a portfolio node defined without one. Defaults to
   * `"Initiative <n>"` / `"Program <n>"` / `"Project <n>"` by kind.
   */
  nodeName: (arg: NodeNameArg) => string;
  /** Builds the name of a goal defined without one, from its 1-based ordinal. Defaults to `"Goal <n>"`. */
  goalName: (ordinal: number) => string;
  /**
   * Builds the name of a duplicated project's root task from the source root task's name.
   * Defaults to `"<source name> (copy)"`.
   */
  copyName: (sourceName: string) => string;

  /* --- dashboard (20) ---------------------------------------------------- */
  /** The panel's title and dialog label. Default `"Dashboard"`. */
  panelTitle: string;
  /** The close button's label. Default `"Close"`. */
  closeLabel: string;
  /** The overdue rows' quick-complete button label. Default `"Mark done"`. */
  markDoneLabel: string;
  /** Shown by a widget whose model is empty. Default `"No data"`. */
  emptyLabel: string;
  /** The status-donut segment labels. Defaults `"Not started"` / `"In progress"` / `"Completed"`. */
  statusNotStarted: string;
  statusInProgress: string;
  statusCompleted: string;
  /** The milestone state labels. Defaults `"reached"` / `"pending"` / `"overdue"`. */
  milestoneReached: string;
  milestonePending: string;
  milestoneOverdue: string;
  /** The exported report's document title. Default `"Dashboard report"`. */
  reportTitle: string;
  /** Builds a widget's card title. Defaults: `"Progress"`, `"Overdue tasks"`, …. */
  widgetTitle: (widget: DashboardWidgetId) => string;
  /** Builds the summary widget's one-line text. */
  summaryText: (summary: ProgressSummary) => string;
  /** Builds one overdue row's text. Default `"<name> — <n> day(s) overdue"`. */
  overdueLine: (entry: OverdueEntry) => string;
  /** Builds the label of a formula defined without one, from its 1-based ordinal. Default `"Metric <n>"`. */
  formulaName: (ordinal: number) => string;
  /** Shown as a formula card's value when its evaluation failed. Default `"—"`. */
  formulaError: string;
  /** Builds the burndown widget's task-count clause. Default `"<n> tasks planned"`. */
  burndownPlanned: (taskCount: number) => string;
  /** Builds the burndown widget's last-snapshot clause. Default `"<n> remaining at last snapshot"`. */
  burndownRemaining: (remaining: number) => string;
  /**
   * Builds one row of the portfolio roll-up widget. Default
   * `"<name>: <pct>, <n> late[, SPI <x.xx>] (<status>)"`.
   */
  portfolioRow: (row: PortfolioStatusRow) => string;
  /**
   * Builds one line of the exported report's burndown section, one per tracking-plugin snapshot.
   * Default `"<YYYY-MM-DD>: <n> remaining"`.
   */
  burndownPoint: (point: BurndownPoint) => string;
}

const KIND_LABEL: Record<PortfolioNodeKind, string> = {
  initiative: "Initiative",
  program: "Program",
  project: "Project",
};

const WIDGET_TITLE: Record<DashboardWidgetId, string> = {
  summary: "Progress",
  overdue: "Overdue tasks",
  burndown: "Burndown",
  workload: "Workload",
  status: "Tasks by status",
  milestones: "Milestones",
  goals: "Goals",
  portfolio: "Portfolio status",
  groups: "Group comparison",
  formulas: "Metrics",
};

/** A 0..1 fraction as a whole-percent label. Shared by the panel, the export and the defaults. */
export function percent(p: number): string {
  return `${Math.round(p * 100)}%`;
}

/** The built-in English catalog. */
const DEFAULT_MESSAGES: PortfolioMessages = {
  nodeName: ({ kind, ordinal }) => `${KIND_LABEL[kind]} ${ordinal}`,
  goalName: (ordinal) => `Goal ${ordinal}`,
  copyName: (sourceName) => `${sourceName} (copy)`,

  panelTitle: "Dashboard",
  closeLabel: "Close",
  markDoneLabel: "Mark done",
  emptyLabel: "No data",
  statusNotStarted: "Not started",
  statusInProgress: "In progress",
  statusCompleted: "Completed",
  milestoneReached: "reached",
  milestonePending: "pending",
  milestoneOverdue: "overdue",
  reportTitle: "Dashboard report",
  widgetTitle: (widget) => WIDGET_TITLE[widget],
  summaryText: (s) =>
    `${Math.round(s.progress * 100)}% complete — ${s.remainingCount} of ${s.taskCount} tasks remaining, ${s.overdueCount} overdue`,
  overdueLine: (e) => `${e.name} — ${e.daysOverdue} day${e.daysOverdue === 1 ? "" : "s"} overdue`,
  formulaName: (ordinal) => `Metric ${ordinal}`,
  formulaError: "—",
  burndownPlanned: (taskCount) => `${taskCount} tasks planned`,
  burndownRemaining: (remaining) => `${remaining} remaining at last snapshot`,
  portfolioRow: (row) =>
    `${row.name}: ${percent(row.progress)}, ${row.lateCount} late` +
    `${row.spi === undefined ? "" : `, SPI ${row.spi.toFixed(2)}`} (${row.status})`,
  burndownPoint: (point) =>
    `${new Date(point.date).toISOString().slice(0, 10)}: ${point.remaining} remaining`,
};

/** The key set of the catalog, in declaration order — the count the spec pins at 23. */
export const PORTFOLIO_MESSAGE_KEYS = Object.keys(
  DEFAULT_MESSAGES,
) as readonly (keyof PortfolioMessages)[];

/** Resolves the host's per-key overrides against the built-in defaults. */
export function resolveMessages(
  overrides: Partial<PortfolioMessages> | undefined,
  onFault: (key: keyof PortfolioMessages & string, error: unknown) => void,
): PortfolioMessages {
  return resolveCatalog(DEFAULT_MESSAGES, overrides, onFault);
}
