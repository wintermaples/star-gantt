/**
 * Shared boot helpers for the portfolio plugin's test suites: a real host with the real data
 * store (`@stargantt/sdk`'s `createTestHost`), no chart DOM required unless a suite opts in.
 * Collapse dispatching and the filter integration are observed through tiny recording plugins
 * standing in for tree-grid and the interaction plugin's filter service.
 */
import type { AnyPlugin, GanttInstance, PluginContext } from "@stargantt/core";
import { createStore, definePlugin } from "@stargantt/core";
import { createTestHost } from "@stargantt/sdk";
import { dataStore } from "@stargantt/plugin-data-store";
import type { DataService, Link, Task, TaskId } from "@stargantt/plugin-data-store";
import type { FilterCriteria, FilterService, FilterState } from "@stargantt/plugin-interaction";
import { portfolio } from "../src/index";
import type { DashboardService, PortfolioConfig, PortfolioService } from "../src/index";

export const DAY0 = Date.UTC(2026, 0, 5);
export const MS_DAY = 86_400_000;

export function task(id: TaskId, start: number, end: number, over: Partial<Task> = {}): Task {
  return { id, parentId: null, name: `task ${String(id)}`, start, end, ...over };
}

export function link(sourceId: TaskId, targetId: TaskId, over: Partial<Link> = {}): Link {
  return {
    id: `${String(sourceId)}->${String(targetId)}`,
    sourceId,
    targetId,
    type: "FS",
    ...over,
  };
}

/**
 * A two-project tree: project roots `p1` (children `a`, `b`) and `p2` (child `c`), plus a loose
 * top-level task `x`. Days are `DAY0`-relative.
 */
export function loadTwoProjects(data: DataService): void {
  data.load({
    tasks: [
      task("p1", DAY0, DAY0 + 10 * MS_DAY, { name: "Project One", type: "summary" }),
      task("a", DAY0, DAY0 + 4 * MS_DAY, { parentId: "p1", progress: 1 }),
      task("b", DAY0 + 4 * MS_DAY, DAY0 + 10 * MS_DAY, { parentId: "p1", progress: 0.5 }),
      task("p2", DAY0, DAY0 + 6 * MS_DAY, { name: "Project Two", type: "summary" }),
      task("c", DAY0, DAY0 + 6 * MS_DAY, { parentId: "p2", progress: 0 }),
      task("x", DAY0, DAY0 + 2 * MS_DAY),
    ],
    links: [link("a", "b")],
  });
}

export interface Boot {
  host: GanttInstance;
  data: DataService;
  portfolioSvc: PortfolioService;
  dashboardSvc: DashboardService;
  ctxOf(pluginId: string): PluginContext;
  dispatch: GanttInstance["dispatch"];
  on: GanttInstance["on"];
  dispose(): void;
}

function wrap(t: ReturnType<typeof createTestHost>): Boot {
  return {
    host: t.host,
    data: t.host.service("stargantt.data"),
    portfolioSvc: t.host.service("stargantt.portfolio"),
    dashboardSvc: t.host.service("stargantt.dashboard"),
    ctxOf: (id) => t.ctxOf(id),
    dispatch: t.host.dispatch.bind(t.host),
    on: t.host.on.bind(t.host),
    dispose: () => t.dispose(),
  };
}

/** Boots a headless host (no DOM) with `dataStore()`, any `extra` plugins, then `portfolio()`. */
export function bootHeadless(config?: PortfolioConfig, extra: readonly AnyPlugin[] = []): Boot {
  return wrap(createTestHost({ plugins: [dataStore(), ...extra, portfolio(config)] }));
}

/**
 * Same as {@link bootHeadless}, but `extra` (e.g. the filter stub) registers *after* portfolio's
 * `setup()` — the ordering the portfolio spec guards against: `optional` is a
 * service-registry allowlist, not a startup ordering edge.
 */
export function bootHeadlessFilterAfter(
  config: PortfolioConfig | undefined,
  extra: readonly AnyPlugin[],
): Boot {
  return wrap(createTestHost({ plugins: [dataStore(), portfolio(config), ...extra] }));
}

/** Records `view/rowToggle` dispatches the way the tree-grid plugin would receive them. */
export function rowToggleRecorder(log: { id: TaskId; expanded?: boolean }[]): AnyPlugin {
  return definePlugin({
    meta: { id: "test.row-toggle-recorder" },
    setup: (ctx) => {
      ctx.registerCommand("view/rowToggle", (p) => {
        log.push(p.expanded === undefined ? { id: p.id } : { id: p.id, expanded: p.expanded });
      });
    },
  });
}

/** A minimal in-memory stand-in for the interaction plugin's `stargantt.filter` service. */
export function filterStub(state: { criteria: FilterCriteria | null }): AnyPlugin {
  return definePlugin({
    // Registered under the interaction plugin's real id: `ctx.useOptional` gates a soft lookup
    // against `meta.optional` naming the *providing plugin's* id (`core/internal/services.ts`'s
    // `_declared`), not the service key — see `src/index.ts`'s module doc comment.
    // `meta.optional` does not influence startup *order* though: registering
    // this before or after `portfolio()` makes no difference, since `stargantt.filter` is
    // resolved late (`sdk/frame`'s `lateService`).
    meta: { id: "stargantt.interaction" },
    setup: (ctx) => {
      const stateStore = createStore<FilterState>({
        query: "",
        criteria: null,
        active: false,
        matchCount: 0,
      });
      const service: FilterService = {
        state: stateStore,
        setQuery: () => undefined,
        setCriteria: (criteria) => {
          state.criteria = criteria;
        },
        clear: () => {
          state.criteria = null;
        },
        isTaskVisible: () => true,
        saveView: () => undefined,
        applyView: () => false,
        deleteView: () => false,
        viewNames: () => [],
      };
      ctx.provide("stargantt.filter", service);
    },
  });
}
