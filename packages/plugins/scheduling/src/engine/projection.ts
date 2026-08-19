// docs/specs/plugins/scheduling.md §2.1 (`engine/projection.ts`)
/**
 * A `ReadonlyDataView` that shows the store **as it will be** once a transaction's patches are
 * applied.
 *
 * The command runner builds the patch list *before* anything is applied, and the
 * `data/willApplyTransaction` handler runs at that point. The live view therefore still shows the
 * pre-transaction state, while the follow-on patches this plugin appends must be computed against
 * the post-transaction state and must land in the same transaction.
 *
 * The overlay is sparse: only the entries a patch touches are copied, so a transaction costs
 * O(patches) and not O(tasks). The data-store indexes are read every frame at 10k+ rows, so a full
 * copy per transaction is not an option.
 */
// The store publishes the `task/update` merge; the projection applies it rather than
// re-implementing it, so the view handed to the engine can never disagree with the store's
// post-transaction state. A value import, so `@stargantt/plugin-data-store` is a runtime
// `dependencies` entry.
import { mergeTaskUpdate } from "@stargantt/plugin-data-store";
import type { Link, Patch, ReadonlyDataView, Task, TaskId } from "@stargantt/plugin-data-store";

type LinkBucket = { readonly in: readonly Link[]; readonly out: readonly Link[] };

/**
 * Copy-on-write view of a `ReadonlyMap`. Point reads (`get`/`has`) stay O(1) against base+overlay;
 * iteration materializes a flat `Map` once and caches it until the next write.
 */
export class OverlayMap<K, V> implements ReadonlyMap<K, V> {
  private readonly _over = new Map<K, V>();
  private readonly _removed = new Set<K>();
  private _flat: Map<K, V> | null = null;

  constructor(private readonly _base: ReadonlyMap<K, V>) {}

  set(key: K, value: V): void {
    this._over.set(key, value);
    this._removed.delete(key);
    this._flat = null;
  }

  delete(key: K): void {
    this._over.delete(key);
    this._removed.add(key);
    this._flat = null;
  }

  get(key: K): V | undefined {
    if (this._removed.has(key)) return undefined;
    if (this._over.has(key)) return this._over.get(key);
    return this._base.get(key);
  }

  has(key: K): boolean {
    if (this._removed.has(key)) return false;
    return this._over.has(key) || this._base.has(key);
  }

  get size(): number {
    return this._materialize().size;
  }

  keys(): MapIterator<K> {
    return this._materialize().keys();
  }

  values(): MapIterator<V> {
    return this._materialize().values();
  }

  entries(): MapIterator<[K, V]> {
    return this._materialize().entries();
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this._materialize()[Symbol.iterator]();
  }

  forEach(fn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this._materialize()) fn.call(thisArg, value, key, this);
  }

  private _materialize(): Map<K, V> {
    const cached = this._flat;
    if (cached !== null) return cached;
    const flat = new Map<K, V>();
    for (const [key, value] of this._base) {
      if (!this._removed.has(key)) flat.set(key, value);
    }
    for (const [key, value] of this._over) flat.set(key, value);
    this._flat = flat;
    return flat;
  }
}

/** A `ReadonlyDataView` onto which patches can be replayed without touching the store. */
export class Projection {
  private readonly _byId: OverlayMap<TaskId, Readonly<Task>>;
  private readonly _children: OverlayMap<TaskId | null, readonly TaskId[]>;
  private readonly _linksByTask: OverlayMap<TaskId, LinkBucket>;

  /** The projected view — hand this to the engine. */
  readonly view: ReadonlyDataView;

  constructor(base: ReadonlyDataView) {
    this._byId = new OverlayMap(base.byId);
    this._children = new OverlayMap(base.children);
    this._linksByTask = new OverlayMap(base.linksByTask);
    this.view = {
      byId: this._byId,
      children: this._children,
      linksByTask: this._linksByTask,
      // No patch variant touches calendars, so the base map is shared rather than overlaid.
      calendars: base.calendars,
      // The scheduling engine reads none of the resource model, and no patch the projection
      // replays touches it, so the base indexes are shared rather than overlaid, like `calendars`.
      resources: base.resources,
      assignmentsByTask: base.assignmentsByTask,
    };
  }

  /**
   * Replays one patch onto the projection.
   *
   * Which projection edit each patch op means is decided by one table (`PROJECTION_OPS`), so an op
   * added to the union later cannot be quietly left out of the projected result — the projection
   * would then hand the engine a view that disagrees with the store's post-transaction state.
   */
  apply(patch: Patch): void {
    // The row is looked up by the patch's own `op`, so for a well-typed patch its handler is by
    // construction the one for that exact variant; the cast only restates that to the compiler. An
    // op the table does not know (only reachable from untyped code, `Patch` being a closed union)
    // fails fast with an explicit diagnostic instead of leaving the projection disagreeing with the
    // store's post-transaction state.
    const op = PROJECTION_OPS[patch.op] as ProjectionOp<Patch> | undefined;
    if (op === undefined) {
      throw new Error(`stargantt: unknown patch op "${String((patch as { op: unknown }).op)}"`);
    }
    op(this, patch);
  }

  /* -- the per-op edits `PROJECTION_OPS` performs; not part of the public surface -- */

  addTask(task: Readonly<Task>): void {
    this._byId.set(task.id, task);
    this._attach(task.parentId, task.id);
  }

  removeTask(task: Readonly<Task>): void {
    this._byId.delete(task.id);
    this._detach(task.parentId, task.id);
  }

  /**
   * Projects a `task/update`. The patch is handed to the store's own merge whole — `clears`
   * included — so the projected task is exactly the task the store will hold once the transaction
   * is applied.
   */
  updateTask(patch: Extract<Patch, { op: "task/update" }>): void {
    const current = this._byId.get(patch.id);
    if (current === undefined) return;
    const updated = mergeTaskUpdate(current, patch);
    this._byId.set(patch.id, updated);
    if (updated.parentId !== current.parentId) {
      this._detach(current.parentId, patch.id);
      this._attach(updated.parentId, patch.id);
    }
  }

  addLink(link: Link): void {
    this._rebucket(link, true);
  }

  removeLink(link: Link): void {
    this._rebucket(link, false);
  }

  private _attach(parentId: TaskId | null, id: TaskId): void {
    const siblings = this._children.get(parentId) ?? [];
    if (siblings.includes(id)) return;
    // Sibling order is irrelevant to scheduling, because a summary rolls up min(start)/max(end)
    // over its children.
    this._children.set(parentId, [...siblings, id]);
  }

  private _detach(parentId: TaskId | null, id: TaskId): void {
    const siblings = this._children.get(parentId);
    if (siblings === undefined) return;
    this._children.set(
      parentId,
      siblings.filter((sibling) => sibling !== id),
    );
  }

  private _rebucket(link: Link, add: boolean): void {
    this._side(link.sourceId, "out", link, add);
    this._side(link.targetId, "in", link, add);
  }

  private _side(taskId: TaskId, side: "in" | "out", link: Link, add: boolean): void {
    const bucket = this._linksByTask.get(taskId) ?? { in: [], out: [] };
    const list = bucket[side];
    const next = add ? [...list, link] : list.filter((l) => l.id !== link.id);
    this._linksByTask.set(
      taskId,
      side === "in" ? { in: next, out: bucket.out } : { in: bucket.in, out: next },
    );
  }
}

/** What one patch op does to a projection. */
type ProjectionOp<P extends Patch> = (projection: Projection, patch: P) => void;

/** One row per member of the `Patch` union — no member may be left out. */
type ProjectionOpTable = { readonly [K in Patch["op"]]: ProjectionOp<Extract<Patch, { op: K }>> };

/**
 * How each patch op changes the projected view.
 *
 * The resource and assignment ops are deliberately no-ops: the scheduling engine reads none of the
 * resource model, so the projection shares those indexes with the base view rather than overlaying
 * them. They still have rows, because "this op does not affect scheduling" has to be a decision
 * someone wrote down rather than an omission.
 */
export const PROJECTION_OPS = {
  "task/add": (projection, patch) => projection.addTask(patch.task),
  "task/remove": (projection, patch) => projection.removeTask(patch.task),
  "task/update": (projection, patch) => projection.updateTask(patch),
  "link/add": (projection, patch) => projection.addLink(patch.link),
  // A retype / re-lag replaces the stored link: the old edge leaves both endpoint buckets and the
  // new one takes its place, so the engine reads the constraint the transaction will leave behind.
  "link/update": (projection, patch) => {
    projection.removeLink(patch.before);
    projection.addLink(patch.after);
  },
  "link/remove": (projection, patch) => projection.removeLink(patch.link),
  "resource/add": () => {},
  "resource/remove": () => {},
  "resource/update": () => {},
  "assignment/add": () => {},
  "assignment/remove": () => {},
  "assignment/update": () => {},
} satisfies ProjectionOpTable;
