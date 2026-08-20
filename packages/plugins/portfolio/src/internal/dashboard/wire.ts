// docs/specs/plugins/portfolio.md §3
/**
 * Assembles `DashboardService`: the store snapshot cache, formulas, the portfolio-backed
 * aggregations (always composed — dashboard and portfolio are one plugin, so no
 * `stargantt.portfolio` service lookup is needed here at all), the panel and its live-refresh
 * coalescing, direct task updates, and the report export.
 */
import type { PluginContext } from "@stargantt/core";
import { createFrameScheduler, lateService, latchedSeam } from "@stargantt/sdk";
import type { Assignment, DataService, Resource, Task, TaskId } from "@stargantt/plugin-data-store";
import type { RagStatus } from "@stargantt/plugin-tracking";
import type {} from "@stargantt/plugin-tracking"; // stargantt.progress Services augmentation
import type {} from "@stargantt/plugin-view"; // stargantt.view Services augmentation
import type {
  DashboardFormulaInit,
  DashboardService,
  DashboardWidgetId,
  DashboardWidgetRenderContext,
  GoalRollupEntry,
  PortfolioService,
  PortfolioStatusRow,
  TaskStatusPatch,
} from "../../types";
import type { PortfolioMessages } from "../messages";
import {
  computeBurndown,
  computeGroupProgress,
  computeMilestones,
  computeOverdue,
  computeSpi,
  computeStatusCounts,
  computeSummary,
  computeWorkload,
  leafTasks,
  weightedProgress,
} from "./compute";
import { buildReportLines, exportPdf, exportPng } from "./export";
import { createFormulaRegistry, evaluateFormulas } from "./formulas";
import type { DashboardModel } from "./model";
import { createDashboardPanel } from "./panel";
import type { DashboardPanel } from "./panel";

const PLUGIN_ID = "stargantt.portfolio";

/** Resolved dashboard-area config, as `index.ts`'s factory prepares it. */
export interface DashboardWireConfig {
  open: boolean;
  widgets: readonly DashboardWidgetId[];
  formulas: readonly DashboardFormulaInit[];
  groupOf: ((task: Readonly<Task>) => string | undefined) | undefined;
  renderWidget: ((host: HTMLElement, ctx: DashboardWidgetRenderContext) => void) | undefined;
}

export interface DashboardWireDeps {
  ctx: PluginContext;
  data: DataService;
  config: DashboardWireConfig;
  messages: PortfolioMessages;
  /** The portfolio service this same plugin instance just assembled — always present. */
  portfolio: PortfolioService;
}

const RAG_VALUES: readonly RagStatus[] = ["red", "amber", "green"];

export function wireDashboard(deps: DashboardWireDeps): DashboardService {
  const { ctx, data, config, messages, portfolio } = deps;

  // Optional services (Dependencies §): resolved at lifecycle/ready or per use, never latched at
  // setup — this plugin's tier can precede either provider's.
  const view = lateService(ctx, "stargantt.view");
  const progress = lateService(ctx, "stargantt.progress");

  const asNow = (now?: number): number =>
    typeof now === "number" && Number.isFinite(now) ? now : Date.now();

  /* --- store snapshot, cached per data generation (§3) --------------------- */
  let snapshot: { tasks: Task[]; assignments: Assignment[]; resources: Resource[] } | null = null;
  function model(): { tasks: Task[]; assignments: Assignment[]; resources: Resource[] } {
    if (snapshot === null) {
      snapshot = {
        tasks: [...data.tasks.get().values()],
        assignments: [...data.assignments.get().values()].flat(),
        resources: [...data.resources.get().values()],
      };
    }
    return snapshot;
  }

  /* --- formulas (§3.4) ----------------------------------------------------- */
  const formulas = createFormulaRegistry(messages.formulaName);
  for (const init of config.formulas) formulas.define(init);
  const formulaError = (formulaId: string, cause: unknown): void =>
    ctx.emit("core/pluginError", { pluginId: PLUGIN_ID, error: { formulaId, cause } });

  // --- renderWidget seam, latched per plugin instance (§3.7) ---------------
  const renderWidget =
    config.renderWidget === undefined
      ? undefined
      : latchedSeam(config.renderWidget, (cause) =>
          ctx.emit("core/pluginError", {
            pluginId: PLUGIN_ID,
            error: { option: "renderWidget", cause },
          }),
        );

  /* --- group hook, contained per call (§3.2) -------------------------------- */
  function groupOf(task: Task): string | undefined {
    if (config.groupOf !== undefined) {
      try {
        const label = config.groupOf(task);
        return typeof label === "string" ? label : undefined;
      } catch (cause) {
        ctx.emit("core/pluginError", { pluginId: PLUGIN_ID, error: { hook: "groupOf", cause } });
        return undefined;
      }
    }
    const { assignments, resources } = model();
    const first = assignments.find((a) => a.taskId === task.id);
    if (first === undefined) return undefined;
    return resources.find((r) => r.id === first.resourceId)?.name ?? String(first.resourceId);
  }

  /* --- portfolio-backed aggregations (§3.3) --------------------------------- */
  function goalRollups(): GoalRollupEntry[] {
    const out: GoalRollupEntry[] = [];
    for (const goal of portfolio.goals.get()) {
      const rolled = portfolio.goalProgress(goal.id);
      if (rolled === undefined) continue;
      out.push({
        goalId: goal.id,
        name: goal.name,
        progress: rolled.progress,
        target: rolled.target,
        achieved: rolled.achieved,
        taskCount: rolled.taskCount,
      });
    }
    return out;
  }
  function portfolioStatus(now?: number): PortfolioStatusRow[] {
    const at = asNow(now);
    const byId = new Map(model().tasks.map((t) => [t.id, t]));
    const out: PortfolioStatusRow[] = [];
    for (const node of portfolio.nodes.get()) {
      const health = portfolio.health(node.id, at);
      if (health === undefined) continue;
      const tasks: Task[] = [];
      for (const id of portfolio.tasksOf(node.id)) {
        const task = byId.get(id);
        if (task !== undefined) tasks.push(task);
      }
      out.push({
        nodeId: node.id,
        name: node.name,
        progress: weightedProgress(leafTasks(tasks)),
        lateCount: health.lateCount,
        taskCount: health.taskCount,
        spi: computeSpi(tasks, at),
        status: health.status,
      });
    }
    return out;
  }

  /* --- the assembled widget model (§3) -------------------------------------- */
  function buildModel(now?: number): DashboardModel {
    const at = asNow(now);
    const { tasks, assignments, resources } = model();
    return {
      widgets: config.widgets,
      summary: computeSummary(tasks, at),
      overdue: computeOverdue(tasks, at),
      burndown: computeBurndown(tasks, progress()?.state.get().snapshots ?? []),
      workload: computeWorkload(tasks, assignments, resources),
      status: computeStatusCounts(tasks),
      milestones: computeMilestones(tasks, at),
      goals: goalRollups(),
      portfolio: portfolioStatus(at),
      groups: computeGroupProgress(tasks, groupOf),
      formulas: evaluateFormulas(formulas, tasks, messages.formulaError, formulaError),
    };
  }

  /* --- the panel and its refresh coalescing (§3.6, §3.8) -------------------- */
  let panel: DashboardPanel | null = null;
  const scheduler = createFrameScheduler(() => doRefresh("data"));
  ctx.own(scheduler);
  // One owned disposable for "the current panel" — open/close swaps the variable, never re-owns.
  ctx.own({
    dispose: () => {
      panel?.dispose();
      panel = null;
    },
  });

  // Nothing to re-render and no live view depending on fresh aggregations while the panel is
  // closed, so a closed-panel refresh recomputes nothing and emits nothing (§3.8).
  function doRefresh(cause: "data" | "api"): void {
    if (panel === null) return;
    panel.update(buildModel());
    ctx.emit("dashboard/refreshed", { cause });
  }
  function scheduleRefresh(): void {
    if (panel !== null) scheduler.schedule();
  }

  // Data changes always invalidate the snapshot (headless reads must stay fresh regardless of the
  // panel), but a live re-render is only *scheduled* while the panel is open — the handler only
  // schedules, never dispatches on the store's own notification stack (architecture ch. 1.1).
  ctx.own(
    data.tasks.subscribe(() => {
      snapshot = null;
      scheduleRefresh();
    }),
  );
  ctx.own(portfolio.nodes.subscribe(() => scheduleRefresh()));
  ctx.own(portfolio.goals.subscribe(() => scheduleRefresh()));

  function updateTaskStatus(id: TaskId, patch: TaskStatusPatch): boolean {
    if (data.getTask(id) === undefined || patch === null || typeof patch !== "object") {
      return false;
    }
    let applied = false;
    if (typeof patch.progress === "number" && Number.isFinite(patch.progress)) {
      const clamped = patch.progress < 0 ? 0 : patch.progress > 1 ? 1 : patch.progress;
      ctx.dispatch("task/update", { id, after: { progress: clamped } });
      applied = true;
    }
    const tracking = progress();
    if (tracking !== undefined && patch.rag !== undefined) {
      if (patch.rag === null) {
        tracking.setRag(id, undefined);
        applied = true;
      } else if (RAG_VALUES.includes(patch.rag)) {
        tracking.setRag(id, patch.rag);
        applied = true;
      }
    }
    return applied;
  }

  // The element that held focus before the panel opened, so close() can hand focus back instead
  // of dropping it to <body>.
  let restoreFocusTo: { focus?: () => void; isConnected?: boolean } | null = null;
  // `moveFocus: false` is the declarative boot path (`config.dashboard.open: true`): the panel
  // mounts during chart initialization without a user gesture, so stealing page focus there would
  // be an unexpected focus change on load — and close() then restores nothing (§3.6).
  function open(moveFocus = true): boolean {
    if (panel !== null) return true;
    // §3.6 — without a composed `stargantt.view` there is no chart worth floating the panel over.
    // Every dialog hosts on the gantt root (`ctx.root`), so it opens centred over the whole widget
    // and drags across the tree grid as well as the chart.
    if (view() === undefined) return false;
    const host = ctx.root;
    restoreFocusTo = moveFocus
      ? (host.ownerDocument.activeElement as typeof restoreFocusTo)
      : null;
    panel = createDashboardPanel(host, buildModel(), messages, {
      close: () => close(),
      markDone: (taskId) => void updateTaskStatus(taskId, { progress: 1 }),
      renderWidget,
    });
    // Move focus into the dialog so its Escape-to-close is reachable keyboard-only.
    if (moveFocus) panel.focus();
    ctx.emit("dashboard/opened", undefined);
    return true;
  }
  function close(): void {
    if (panel === null) return;
    panel.dispose();
    panel = null;
    const back = restoreFocusTo;
    restoreFocusTo = null;
    if (back !== null && back.isConnected !== false && typeof back.focus === "function") {
      back.focus();
    }
    ctx.emit("dashboard/closed", undefined);
  }

  if (config.open) {
    // Plugin activation order is not layout order — the chart pane exists only after ready.
    ctx.on("lifecycle/ready", () => void open(false));
  }

  const service: DashboardService = {
    open: () => open(true),
    close,
    isOpen: () => panel !== null,
    refresh: () => doRefresh("api"),
    element: () => panel?.root,
    summary: (now) => computeSummary(model().tasks, asNow(now)),
    overdueTasks: (now) => computeOverdue(model().tasks, asNow(now)),
    statusCounts: () => computeStatusCounts(model().tasks),
    milestones: (now) => computeMilestones(model().tasks, asNow(now)),
    workload: () => {
      const { tasks, assignments, resources } = model();
      return computeWorkload(tasks, assignments, resources);
    },
    groupComparison: () => computeGroupProgress(model().tasks, groupOf),
    burndown: () => computeBurndown(model().tasks, progress()?.state.get().snapshots ?? []),
    goalRollups,
    portfolioStatus,
    defineFormula(init: DashboardFormulaInit): string | undefined {
      const id = formulas.define(init);
      if (id !== undefined) scheduleRefresh();
      return id;
    },
    removeFormula(id: string): boolean {
      const existed = formulas.remove(id);
      if (existed) scheduleRefresh();
      return existed;
    },
    formulaValues: () =>
      evaluateFormulas(formulas, model().tasks, messages.formulaError, formulaError),
    updateTaskStatus,
    exportReport(format?: "png" | "pdf"): string | undefined {
      const lines = buildReportLines(buildModel(), messages);
      if (format === "pdf") return exportPdf(messages.reportTitle, lines);
      // Same `stargantt.view` gate as `open()` — a composition with no chart exports no image —
      // but the document comes from the root the panel is hosted on, not the chart pane.
      if (view() === undefined) return undefined;
      return exportPng(ctx.root.ownerDocument, messages.reportTitle, lines);
    },
  };
  return service;
}
