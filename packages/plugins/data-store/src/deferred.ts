// docs/specs/plugins/data-store.md — Bulk paths / deferred children: lazy hierarchy construction —
// raw child rows handed to `load()` under `deferredTasks` are kept unbuilt until a caller asks for
// them, so a large collapsed subtree costs nothing at load time.
/**
 * Deferred-children buckets: raw, un-normalized child rows parked per parent task id at `load()`
 * time and materialized into the store on demand.
 *
 * Hostless — nothing here touches the plugin context; `index.ts` wires the service methods and the
 * store publication around it.
 */
import type { IdGen } from "./ids";
import { isLinkRaw, normalizeTask } from "./mapping";
import { midKey } from "./order-key";
import type { Store } from "./store";
import type { FieldMapping, TaskId } from "./types";

/** The `orderKey` of the last current child of `parentId`, or `""` when it has none. */
function lastSiblingKey(store: Store, parentId: TaskId): string {
  const siblings = store.children.get(parentId);
  if (siblings === undefined || siblings.length === 0) return "";
  const last = siblings[siblings.length - 1] as TaskId;
  return store.byId.get(last)?.orderKey ?? "";
}

export class DeferredChildren {
  /** Raw rows per parent id, in the order they were handed to `load()`. */
  private readonly _buckets = new Map<TaskId, unknown[]>();
  /** The mapping the surrounding `load()` used — materialized rows read fields the same way. */
  private _mapping: FieldMapping<unknown> | undefined;

  /** Drops every pending bucket and remembers the mapping of the load that is starting. */
  reset(mapping?: FieldMapping<unknown>): void {
    this._buckets.clear();
    this._mapping = mapping;
  }

  /** Parks rows under `parentId`; a second bucket for the same parent concatenates in order. */
  add(parentId: TaskId, rows: readonly unknown[]): void {
    const existing = this._buckets.get(parentId);
    if (existing === undefined) this._buckets.set(parentId, [...rows]);
    else existing.push(...rows);
  }

  has(parentId: TaskId): boolean {
    return this._buckets.has(parentId);
  }

  /**
   * Materializes the bucket of `parentId`: normalizes each row as a task, forces its `parentId` to
   * the bucket's parent, files it after the parent's current children and applies it to the store
   * as a plain `task/add` patch (no transaction — this is the load path's continuation, so it is
   * not undoable, exactly like `load()` itself).
   *
   * Returns the ids of the tasks created, or `undefined` when there is nothing to do — no bucket
   * pending for `parentId`, or the parent not (yet) present in the store. The bucket is consumed
   * only on success, so a bucket whose parent is itself still deferred stays pending until that
   * parent has been materialized.
   *
   * Unusable rows are silently skipped (the uniform unusable-argument treatment): link-shaped rows
   * and rows whose id is already taken by a stored task.
   */
  materialize(store: Store, ids: IdGen, parentId: TaskId): Set<TaskId> | undefined {
    const rows = this._buckets.get(parentId);
    if (rows === undefined) return undefined;
    if (!store.byId.has(parentId)) return undefined;
    this._buckets.delete(parentId);

    const changed = new Set<TaskId>();
    // Fallback order keys chain strictly upward from the last existing sibling, so materialized
    // children land after the eagerly-loaded ones, in row order.
    let prevKey = lastSiblingKey(store, parentId);
    for (const raw of rows) {
      if (isLinkRaw(raw, this._mapping)) continue;
      const fallbackKey = midKey(prevKey, undefined);
      const task = normalizeTask(raw, this._mapping, ids.nextTaskId(store), fallbackKey);
      task.parentId = parentId;
      if (store.byId.has(task.id)) continue;
      store.applyPatch({ op: "task/add", task });
      changed.add(task.id);
      // Advance to the task's *actual* orderKey (it may carry its own, distinct from the
      // fallback minted above) so the next fallback is computed after where this task truly
      // landed, keeping materialized children in strictly increasing order.
      prevKey = task.orderKey ?? fallbackKey;
    }
    return changed;
  }
}
