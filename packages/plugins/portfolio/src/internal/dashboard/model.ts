// docs/specs/plugins/portfolio.md §3 — the assembled dashboard model: one plain object per
// refresh, consumed by the panel renderer and the report exporter.
import type {
  BurndownSeries,
  DashboardWidgetId,
  FormulaValue,
  GoalRollupEntry,
  GroupProgressEntry,
  MilestoneEntry,
  OverdueEntry,
  PortfolioStatusRow,
  ProgressSummary,
  StatusCounts,
  WorkloadEntry,
} from "../../types";

export interface DashboardModel {
  /** The widgets to show, in order. */
  widgets: readonly DashboardWidgetId[];
  summary: ProgressSummary;
  overdue: readonly OverdueEntry[];
  burndown: BurndownSeries;
  workload: readonly WorkloadEntry[];
  status: StatusCounts;
  milestones: readonly MilestoneEntry[];
  goals: readonly GoalRollupEntry[];
  portfolio: readonly PortfolioStatusRow[];
  groups: readonly GroupProgressEntry[];
  formulas: readonly FormulaValue[];
}
