// docs/specs/plugins/portfolio.md
/**
 * `@stargantt/plugin-portfolio` — plugin id `stargantt.portfolio`, Layer 8.
 *
 * The multi-project surface, in two feature areas sharing one plugin (docs/specs/plugins/
 * portfolio.md, Purpose): **portfolio** — a ranked grouping hierarchy (initiative > program >
 * project) over the task store, per-project collapse/expand, traffic-light health aggregation,
 * goal/OKR roll-up, template duplication, portfolio-scoped row narrowing with saved views, and
 * cross-project task moves — and **dashboard** — a headless KPI aggregation service plus an
 * opt-in widget panel, direct task updates, and a PNG/PDF report export. Because both areas are
 * one plugin, the dashboard's portfolio-backed aggregations (§3.3) are always composed.
 *
 * With no config the plugin registers both services over empty sets and changes nothing: no
 * node, no filter, no panel, no DOM.
 *
 * This file is wiring only: config resolution (read once, here), the shared message
 * catalog, and handing the two areas' assembly off to their own `wire.ts`.
 *
 * `meta.optional` below names the *providing plugin's* id, per the spec's Dependencies section:
 * the tracking/interaction services this plugin consumes are `stargantt.tracking` /
 * `stargantt.interaction`, not their service keys (`stargantt.progress` / `stargantt.filter`) —
 * the core's `ctx.useOptional` gate (`services.ts`'s `_declared`) checks `meta.optional` against
 * the provider's plugin id. `stargantt.view` is unaffected — the view plugin's id and its one
 * service happen to share the string. Matches the same provider-plugin-id convention already used
 * by the `export`/`tracking` plugins wherever a consumed service's key differs from its provider's
 * id.
 */
import { definePlugin } from "@stargantt/core";
import type { Plugin, PluginContext } from "@stargantt/core";
import { lateService } from "@stargantt/sdk";
// Type-only imports: they load the sibling packages' `declare module "@stargantt/core"`
// augmentations so services and commands are checked against the real declarations. Erased at
// emit — no runtime dependency is added. No edge to tree-grid exists here, not even a
// type-only one (§2.2 — command dispatch needs no ordering; see `internal/portfolio/wire.ts`'s
// narrowly-typed `dispatchRowToggle`).
import type { Task } from "@stargantt/plugin-data-store";
import type {} from "@stargantt/plugin-interaction";
import type {} from "@stargantt/plugin-tracking";
import type {} from "@stargantt/plugin-view";
import { resolveMessages } from "./internal/messages";
import type { PortfolioMessages } from "./internal/messages";
import { wireDashboard } from "./internal/dashboard/wire";
import { wirePortfolio } from "./internal/portfolio/wire";
import type {
  DashboardFormulaInit,
  DashboardService,
  DashboardWidgetId,
  DashboardWidgetRenderContext,
  PortfolioConfig,
  PortfolioGoalInit,
  PortfolioNodeInit,
  PortfolioService,
  PortfolioView,
} from "./types";

export type { NodeNameArg, PortfolioMessages } from "./internal/messages";
export type {
  DashboardFormulaInit,
  DashboardModel,
  DashboardService,
  DashboardWidgetId,
  DashboardWidgetRenderContext,
  BurndownPoint,
  BurndownSeries,
  DuplicateProjectOptions,
  FormulaValue,
  GoalRollupEntry,
  GroupProgressEntry,
  MilestoneEntry,
  OverdueEntry,
  PortfolioConfig,
  PortfolioDashboardConfig,
  PortfolioGoal,
  PortfolioGoalId,
  PortfolioGoalInit,
  PortfolioGoalProgress,
  PortfolioHealth,
  PortfolioHealthStatus,
  PortfolioNode,
  PortfolioNodeId,
  PortfolioNodeInit,
  PortfolioNodeKind,
  PortfolioService,
  PortfolioStatusRow,
  PortfolioTreeNode,
  PortfolioView,
  ProgressSummary,
  StatusCounts,
  TaskStatusPatch,
  WorkloadEntry,
} from "./types";

const PLUGIN_ID = "stargantt.portfolio";

const ALL_WIDGETS: readonly DashboardWidgetId[] = [
  "summary",
  "overdue",
  "burndown",
  "workload",
  "status",
  "milestones",
  "goals",
  "portfolio",
  "groups",
  "formulas",
];

interface ResolvedDashboardOptions {
  open: boolean;
  widgets: readonly DashboardWidgetId[];
  formulas: readonly DashboardFormulaInit[];
  groupOf: ((task: Readonly<Task>) => string | undefined) | undefined;
  renderWidget: ((host: HTMLElement, ctx: DashboardWidgetRenderContext) => void) | undefined;
}

interface ResolvedOptions {
  nodes: readonly PortfolioNodeInit[];
  goals: readonly PortfolioGoalInit[];
  views: Record<string, PortfolioView> | undefined;
  dashboard: ResolvedDashboardOptions;
  messages: Partial<PortfolioMessages> | undefined;
}

function setup(ctx: PluginContext, options: ResolvedOptions): void {
  const data = ctx.use("stargantt.data");
  const messages = resolveMessages(options.messages, (messageKey, cause) => {
    ctx.emit("core/pluginError", { pluginId: PLUGIN_ID, error: { messageKey, cause } });
  });

  // §2.6, Dependencies — `stargantt.filter` is resolved late (never latched at setup): this
  // plugin's tier can precede the interaction plugin's.
  const portfolioService: PortfolioService = wirePortfolio({
    ctx,
    data,
    config: { nodes: options.nodes, goals: options.goals, views: options.views },
    messages,
    filter: lateService(ctx, "stargantt.filter"),
  });
  ctx.provide("stargantt.portfolio", portfolioService);

  // The dashboard area consumes the portfolio service directly (both areas are one plugin
  // instance), so §3.3's portfolio-backed aggregations need no service lookup of their own.
  const dashboardService: DashboardService = wireDashboard({
    ctx,
    data,
    config: {
      open: options.dashboard.open,
      widgets: options.dashboard.widgets,
      formulas: options.dashboard.formulas,
      groupOf: options.dashboard.groupOf,
      renderWidget: options.dashboard.renderWidget,
    },
    messages,
    portfolio: portfolioService,
  });
  ctx.provide("stargantt.dashboard", dashboardService);
}

/**
 * Creates the portfolio plugin: the ranked grouping hierarchy, health, goals, template
 * duplication, cross-project moves and the portfolio filter/saved views, plus the dashboard's
 * headless KPI aggregations, its opt-in widget panel, direct task updates and PNG/PDF report
 * export.
 *
 * Without configuration both services are provided over empty sets and nothing changes: no node,
 * no filter, no panel, no DOM — rendered output is byte-identical.
 */
export function portfolio(config?: PortfolioConfig): Plugin<void> {
  // Options are read here, once.
  const known = new Set<DashboardWidgetId>(ALL_WIDGETS);
  const dashboardRaw = config?.dashboard;
  const options: ResolvedOptions = {
    nodes: Array.isArray(config?.nodes) ? [...config.nodes] : [],
    goals: Array.isArray(config?.goals) ? [...config.goals] : [],
    views:
      config?.views !== null && typeof config?.views === "object" ? { ...config.views } : undefined,
    dashboard: {
      open: dashboardRaw?.open === true,
      widgets: Array.isArray(dashboardRaw?.widgets)
        ? dashboardRaw.widgets.filter((w): w is DashboardWidgetId => known.has(w))
        : ALL_WIDGETS,
      formulas: Array.isArray(dashboardRaw?.formulas) ? [...dashboardRaw.formulas] : [],
      groupOf: typeof dashboardRaw?.groupOf === "function" ? dashboardRaw.groupOf : undefined,
      renderWidget:
        typeof dashboardRaw?.renderWidget === "function" ? dashboardRaw.renderWidget : undefined,
    },
    messages: config?.messages,
  };
  return definePlugin({
    meta: {
      id: PLUGIN_ID,
      dependsOn: ["stargantt.data-store"],
      // `meta.optional`/`dependsOn` name the PROVIDING PLUGIN's id (`core/internal/services.ts`'s
      // `_declared` gates `ctx.useOptional` against it), not the service key — `stargantt.view`
      // happens to equal both for the view plugin, but the tracking/interaction services this
      // plugin consumes (`stargantt.progress`, `stargantt.filter`) are provided by plugins named
      // `stargantt.tracking` / `stargantt.interaction`. See this file's module doc comment above.
      optional: ["stargantt.view", "stargantt.tracking", "stargantt.interaction"],
    },
    setup: (ctx: PluginContext): void => setup(ctx, options),
  });
}
