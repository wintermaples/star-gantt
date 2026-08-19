// docs/specs/plugins/portfolio.md §1.1, §2
/**
 * Assembles `PortfolioService`: the node/goal stores, config seeding, the `data.tasks`-driven
 * task-model cache §2.1's `tasksOf`/`projectOf` read through, and every other member.
 */
import { createStore } from "@stargantt/core";
import type { PluginContext } from "@stargantt/core";
import { createTransactionBatcher } from "@stargantt/sdk";
import type { DataService, Patch, Task, TaskId } from "@stargantt/plugin-data-store";
import type { FilterService } from "@stargantt/plugin-interaction";
import type {
  DuplicateProjectOptions,
  PortfolioGoal,
  PortfolioGoalId,
  PortfolioGoalInit,
  PortfolioGoalProgress,
  PortfolioHealth,
  PortfolioNode,
  PortfolioNodeId,
  PortfolioNodeInit,
  PortfolioService,
  PortfolioView,
} from "../../types";
import type { PortfolioMessages } from "../messages";
import { createFilterController } from "./filter";
import { computeHealth, weightedProgress } from "./health";
import { PortfolioRegistry } from "./registry";
import { buildDuplicatePlan } from "./template";
import { childIndex, collectSubtree, isInSubtree } from "./tree";

/** Resolved portfolio-area config, as `index.ts`'s factory prepares it. */
export interface PortfolioWireConfig {
  nodes: readonly PortfolioNodeInit[];
  goals: readonly PortfolioGoalInit[];
  views: Record<string, PortfolioView> | undefined;
}

export interface PortfolioWireDeps {
  ctx: PluginContext;
  data: DataService;
  config: PortfolioWireConfig;
  messages: PortfolioMessages;
  /** The (optional, late-binding) `stargantt.filter` service — see `sdk/frame`'s `lateService`. */
  filter(): FilterService | undefined;
}

/**
 * Dispatches the tree-grid plugin's public `view/rowToggle` command (§2.2). This plugin declares
 * no edge to tree-grid — not even a type-only one, since a command dispatch needs no ordering
 * (§2.2, "recorded: the predecessor's ordering-only optional entry on tree-grid is not carried")
 * — so the call
 * is kept narrowly typed here instead of importing tree-grid's `Commands` augmentation. Without
 * tree-grid registered, `ctx.dispatch` reaches no runner and is a silent no-op (core command-bus
 * semantics).
 */
function dispatchRowToggle(
  ctx: { dispatch(key: string, payload: unknown): void },
  id: TaskId,
  expanded: boolean,
): void {
  ctx.dispatch("view/rowToggle", { id, expanded });
}

export function wirePortfolio(deps: PortfolioWireDeps): PortfolioService {
  const { ctx, data, config, messages } = deps;

  const registry = new PortfolioRegistry(messages.nodeName, messages.goalName);
  for (const init of config.nodes) registry.defineNode(init);
  for (const init of config.goals) registry.defineGoal(init);

  // §1.1 — seeding happens before the store's first value is observable, so no change event is
  // owed for it; every later observable set change publishes a fresh snapshot.
  const nodesStore = createStore<readonly Readonly<PortfolioNode>[]>(registry.list());
  const goalsStore = createStore<readonly Readonly<PortfolioGoal>[]>(registry.goals());

  /* --- task snapshot, cached per data generation (§2.1, §2.6) ------------- */
  let taskCache: { byId: Map<TaskId, Task>; children: Map<TaskId | null, Task[]> } | null = null;
  function taskModel(): { byId: Map<TaskId, Task>; children: Map<TaskId | null, Task[]> } {
    if (taskCache === null) {
      const tasks = [...data.tasks.get().values()] as Task[];
      taskCache = { byId: new Map(tasks.map((t) => [t.id, t])), children: childIndex(tasks) };
    }
    return taskCache;
  }

  /** The tasks of one node, resolved fresh from the store (§2.1). */
  function tasksOfNode(id: PortfolioNodeId): Task[] {
    const model = taskModel();
    const out: Task[] = [];
    const seen = new Set<TaskId>();
    for (const project of registry.projectsUnder(id)) {
      if (project.taskId === undefined) continue;
      for (const task of collectSubtree(project.taskId, model.byId, model.children)) {
        if (seen.has(task.id)) continue;
        seen.add(task.id);
        out.push(task);
      }
    }
    return out;
  }

  const filterCtl = createFilterController(
    {
      filter: deps.filter,
      tasksOfNodes(nodeIds) {
        const seen = new Set<TaskId>();
        for (const id of nodeIds) for (const task of tasksOfNode(id)) seen.add(task.id);
        return [...seen];
      },
    },
    config.views,
  );

  ctx.own(
    data.tasks.subscribe(() => {
      taskCache = null;
      filterCtl.invalidate();
    }),
  );

  /* --- single-transaction batching for template duplication (§2.5) -------- */
  const batch = createTransactionBatcher<Patch>(ctx, "stargantt.portfolio/duplicate");
  let copySeq = 0;
  // Only checked against existing task ids, never link ids: the data store keeps them in
  // separate id spaces, so a link ever sharing this string is inert.
  function freshTaskId(): string {
    let id: string;
    do id = `pf-copy-${++copySeq}`;
    while (data.getTask(id) !== undefined);
    return id;
  }

  const asNow = (now?: number): number =>
    typeof now === "number" && Number.isFinite(now) ? now : Date.now();

  const service: PortfolioService = {
    nodes: nodesStore,
    goals: goalsStore,

    defineNode(init: PortfolioNodeInit): PortfolioNodeId | undefined {
      const id = registry.defineNode(init);
      if (id !== undefined) nodesStore.set(registry.list());
      return id;
    },
    removeNode(id: PortfolioNodeId): void {
      if (registry.removeNode(id)) nodesStore.set(registry.list());
    },
    node: (id) => registry.node(id),
    tree: () => registry.tree(),
    projectOf(taskId: TaskId): Readonly<PortfolioNode> | undefined {
      const model = taskModel();
      if (!model.byId.has(taskId)) return undefined;
      const roots = new Map<TaskId, PortfolioNode>();
      for (const node of registry.list()) {
        if (node.kind === "project" && node.taskId !== undefined && !roots.has(node.taskId)) {
          roots.set(node.taskId, node);
        }
      }
      let current: TaskId | null | undefined = taskId;
      const seen = new Set<TaskId>();
      while (current !== null && current !== undefined && !seen.has(current)) {
        const hit = roots.get(current);
        if (hit !== undefined) return hit;
        seen.add(current);
        current = model.byId.get(current)?.parentId;
      }
      return undefined;
    },
    tasksOf: (id) => tasksOfNode(id).map((t) => t.id),
    setProjectCollapsed(id: PortfolioNodeId, collapsed: boolean): void {
      const node = registry.node(id);
      if (node?.kind !== "project" || node.taskId === undefined) return;
      if (data.getTask(node.taskId) === undefined) return;
      dispatchRowToggle(ctx, node.taskId, collapsed !== true);
    },
    collapseAllProjects(): void {
      for (const node of registry.list()) service.setProjectCollapsed(node.id, true);
    },
    expandAllProjects(): void {
      for (const node of registry.list()) service.setProjectCollapsed(node.id, false);
    },
    health(id: PortfolioNodeId, now?: number): PortfolioHealth | undefined {
      if (registry.node(id) === undefined) return undefined;
      return { nodeId: id, ...computeHealth(tasksOfNode(id), asNow(now)) };
    },
    healthSummary(now?: number): readonly PortfolioHealth[] {
      const at = asNow(now);
      return registry.list().map((n) => ({ nodeId: n.id, ...computeHealth(tasksOfNode(n.id), at) }));
    },
    defineGoal(init: PortfolioGoalInit): PortfolioGoalId | undefined {
      const id = registry.defineGoal(init);
      if (id !== undefined) goalsStore.set(registry.goals());
      return id;
    },
    removeGoal(id: PortfolioGoalId): void {
      if (registry.removeGoal(id)) goalsStore.set(registry.goals());
    },
    goalProgress(id: PortfolioGoalId): PortfolioGoalProgress | undefined {
      const goal = registry.goal(id);
      if (goal === undefined) return undefined;
      const model = taskModel();
      const seen = new Set<TaskId>();
      const linked: Task[] = [];
      const include = (task: Task): void => {
        if (seen.has(task.id)) return;
        seen.add(task.id);
        linked.push(task);
      };
      for (const nodeId of goal.nodeIds) for (const task of tasksOfNode(nodeId)) include(task);
      for (const taskId of goal.taskIds) {
        for (const task of collectSubtree(taskId, model.byId, model.children)) include(task);
      }
      const { progress, taskCount } = weightedProgress(linked);
      return {
        goalId: id,
        progress,
        target: goal.target,
        achieved: taskCount > 0 && progress >= goal.target,
        taskCount,
      };
    },
    duplicateProject(
      source: PortfolioNodeId | TaskId,
      opts?: DuplicateProjectOptions,
    ): TaskId | undefined {
      // A project node id resolves first; anything else is tried as a root task id.
      const node = registry.node(source);
      const rootId = node?.kind === "project" && node.taskId !== undefined ? node.taskId : source;
      const model = taskModel();
      const subtree = collectSubtree(rootId as TaskId, model.byId, model.children);
      const root = subtree[0];
      if (root === undefined) return undefined;
      const plan = buildDuplicatePlan({
        subtree,
        links: [...data.links.get().values()],
        rootName: typeof opts?.name === "string" ? opts.name : messages.copyName(root.name),
        startAt: typeof opts?.startAt === "number" ? opts.startAt : undefined,
        keepProgress: opts?.keepProgress === true,
        freshId: freshTaskId,
      });
      if (plan === undefined) return undefined;
      // §2.5 — one public command opens the transaction; the remaining patches join it through
      // the batcher, so the whole copy is one undo step.
      batch((origin) => ctx.dispatch("task/add", { task: plan.first, origin }), plan.rest);
      if (node?.kind === "project") {
        const newNode: PortfolioNodeInit = { name: plan.first.name, taskId: plan.rootId };
        if (node.parentId !== undefined) newNode.parentId = node.parentId;
        const id = registry.defineNode(newNode);
        if (id !== undefined) nodesStore.set(registry.list());
      }
      return plan.rootId;
    },
    moveTaskToProject(taskId: TaskId, target: PortfolioNodeId): boolean {
      const node = registry.node(target);
      if (node?.kind !== "project" || node.taskId === undefined) return false;
      const model = taskModel();
      const task = model.byId.get(taskId);
      const rootId = node.taskId;
      if (task === undefined || model.byId.get(rootId) === undefined) return false;
      if (isInSubtree(rootId, taskId, model.byId)) return false; // no cycles, no self-move
      if (task.parentId === rootId) return true; // already there
      ctx.dispatch("task/update", { id: taskId, after: { parentId: rootId } });
      return true;
    },
    applyPortfolioFilter: (nodeIds) => filterCtl.applyPortfolioFilter(nodeIds),
    portfolioFilter: () => filterCtl.portfolioFilter(),
    savePortfolioView: (name) => filterCtl.savePortfolioView(name),
    applyPortfolioView: (name) => filterCtl.applyPortfolioView(name),
    deletePortfolioView: (name) => filterCtl.deletePortfolioView(name),
    portfolioViewNames: () => filterCtl.portfolioViewNames(),
  };

  return service;
}
