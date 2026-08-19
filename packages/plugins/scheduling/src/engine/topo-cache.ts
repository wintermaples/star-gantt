// docs/specs/plugins/scheduling.md §2.8 (`engine/topo-cache.ts`)
/**
 * A memo of topological orders over the dependency graph, so repeated passes over the same store
 * state do not re-run Kahn's algorithm.
 *
 * The store hands out **one stable view object** and mutates it in place, so object identity
 * cannot key the cache; instead the owner explicitly calls `invalidate()` whenever the data
 * changes (the plugin does so on every `data.tasks` store notification). Between invalidations an order is computed at most once
 * per distinct (node set, hierarchy flag) pair.
 *
 * The cache is a pure optimization: with no cache (or after any invalidation) every order is
 * recomputed from scratch and results are identical, which is what keeps this safe against a
 * missed hit. A bounded entry count guards the memo against unbounded distinct seed sets.
 */
import type { ReadonlyDataView, TaskId } from "@stargantt/plugin-data-store";
import { topoOrder } from "./graph";

/** Entries kept per generation; oldest-inserted are evicted first. */
const MAX_ENTRIES = 64;

export class TopoCache {
  private entries = new Map<string, readonly TaskId[]>();

  /** Drops every memoized order. Call whenever the underlying data may have changed. */
  invalidate(): void {
    this.entries.clear();
  }

  /**
   * `topoOrder(view, nodes, hierarchy)`, memoized until the next `invalidate()`.
   *
   * The key encodes each id with a type tag so the numeric id `1` and the string id `"1"` cannot
   * collide.
   */
  order(view: ReadonlyDataView, nodes: ReadonlySet<TaskId>, hierarchy: boolean): readonly TaskId[] {
    const parts: string[] = [];
    for (const id of nodes) {
      parts.push((typeof id === "number" ? "n" : "s") + String(id));
    }
    parts.sort();
    const key = (hierarchy ? "h|" : "l|") + parts.join(" ");

    const hit = this.entries.get(key);
    if (hit !== undefined) return hit;

    const order = topoOrder(view, nodes, hierarchy);
    if (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, order);
    return order;
  }
}
