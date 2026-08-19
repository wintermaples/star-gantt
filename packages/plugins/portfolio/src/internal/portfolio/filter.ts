// docs/specs/plugins/portfolio.md §2.6
/**
 * The portfolio filter and saved views: narrows visible rows to chosen portfolio nodes' tasks
 * through the interaction plugin's `stargantt.filter` service (optional, resolved late — see
 * `wire.ts`'s use of `sdk/frame`'s `lateService`), and an in-memory saved-view map.
 *
 * The predicate consults a task-id set derived from the caller's `tasksOfNodes`, cached here and
 * invalidated by `invalidate()` — `wire.ts` calls that from its `data.tasks` subscription — so the
 * narrowing follows store edits without the host ever re-applying it.
 */
import type { TaskId } from "@stargantt/plugin-data-store";
import type { FilterService } from "@stargantt/plugin-interaction";
import type { PortfolioNodeId, PortfolioView } from "../../types";

export interface FilterDeps {
  /** The (optional, late-binding) `stargantt.filter` service, or `undefined` when not composed. */
  filter(): FilterService | undefined;
  /** The task ids the given node ids resolve to (their `tasksOf` union), fresh from the store. */
  tasksOfNodes(nodeIds: readonly PortfolioNodeId[]): readonly TaskId[];
}

export interface FilterController {
  applyPortfolioFilter(nodeIds: readonly PortfolioNodeId[] | null): void;
  portfolioFilter(): readonly PortfolioNodeId[] | null;
  savePortfolioView(name: string): void;
  applyPortfolioView(name: string): boolean;
  deletePortfolioView(name: string): boolean;
  portfolioViewNames(): string[];
  /** Drops the cached visible-task-id set; call on every `data.tasks` store notification. */
  invalidate(): void;
}

function seedViewMap(
  seed: Record<string, PortfolioView> | undefined,
): Map<string, PortfolioNodeId[] | null> {
  const views = new Map<string, PortfolioNodeId[] | null>();
  if (seed === undefined) return views;
  for (const [name, view] of Object.entries(seed)) {
    if (name === "" || view === null || typeof view !== "object") continue;
    views.set(name, Array.isArray(view.nodeIds) ? [...view.nodeIds] : null);
  }
  return views;
}

/** Builds the §2.6 filter/saved-view controller. `seedViews` is `config.views`, as given. */
export function createFilterController(
  deps: FilterDeps,
  seedViews: Record<string, PortfolioView> | undefined,
): FilterController {
  let activeFilter: PortfolioNodeId[] | null = null;
  let visibleCache: Set<TaskId> | null = null;

  function visibleSet(): Set<TaskId> {
    if (visibleCache === null) visibleCache = new Set(deps.tasksOfNodes(activeFilter ?? []));
    return visibleCache;
  }

  function applyFilter(nodeIds: readonly PortfolioNodeId[] | null): void {
    const service = deps.filter();
    if (service === undefined) return;
    activeFilter = nodeIds === null ? null : [...nodeIds];
    visibleCache = null;
    if (activeFilter === null) {
      service.setCriteria(null);
      return;
    }
    service.setCriteria({ predicate: (task) => visibleSet().has(task.id) });
  }

  const views = seedViewMap(seedViews);

  return {
    applyPortfolioFilter: (nodeIds) => applyFilter(nodeIds),
    portfolioFilter: () => (activeFilter === null ? null : [...activeFilter]),
    savePortfolioView(name: string): void {
      if (typeof name !== "string" || name === "") return;
      views.set(name, activeFilter === null ? null : [...activeFilter]);
    },
    applyPortfolioView(name: string): boolean {
      const stored = views.get(name);
      if (stored === undefined) return false;
      applyFilter(stored);
      return true;
    },
    deletePortfolioView: (name) => views.delete(name),
    portfolioViewNames: () => [...views.keys()],
    invalidate(): void {
      visibleCache = null;
    },
  };
}
