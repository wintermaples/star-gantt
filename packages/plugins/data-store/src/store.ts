import { createStore } from "@stargantt/core";
import type { WritableStore } from "@stargantt/core";
import { REQUIRED_RESOURCE_FIELDS, mergeTaskUpdate, mergeUpdate } from "./fields";
import { applyPatchTo, invertPatch } from "./ops";
import type {
  Assignment,
  CalendarDef,
  CalendarId,
  Link,
  LinkId,
  Patch,
  ReadonlyDataView,
  Resource,
  ResourceId,
  Task,
  TaskId,
  Transaction,
} from "./types";

export interface LinkBucket {
  in: Link[];
  out: Link[];
}

// docs/specs/plugins/data-store.md — Data model: store structure and indexes.
/**
 * The task/link store and its indexes. The indexes are maintained **incrementally** on every patch
 * (never rebuilt), because at 10k+ rows they are read every frame.
 */
export class Store {
  /** Every task by id. */
  readonly byId = new Map<TaskId, Task>();
  /** Child ids per parent (`null` for roots) — sibling arrays kept in `orderKey` order. */
  readonly children = new Map<TaskId | null, TaskId[]>();
  /** Incoming and outgoing links per task id. */
  readonly linksByTask = new Map<TaskId, LinkBucket>();
  /** Working calendars, exposed through `ReadonlyDataView`. */
  readonly calendars = new Map<CalendarId, CalendarDef>();
  /** Every resource by id, in insertion order. */
  readonly resources = new Map<ResourceId, Resource>();
  /** Assignments grouped by task — at most one per (taskId, resourceId) pair. */
  readonly assignmentsByTask = new Map<TaskId, Assignment[]>();

  /** All links by id. Internal bookkeeping — not one of the published indexes. */
  private readonly _links = new Map<LinkId, Link>();

  /** Stable identity: `query()` hands out the same object every call. */
  private readonly _view: ReadonlyDataView = {
    byId: this.byId,
    children: this.children,
    linksByTask: this.linksByTask,
    calendars: this.calendars,
    resources: this.resources,
    assignmentsByTask: this.assignmentsByTask,
  };

  query(): ReadonlyDataView {
    return this._view;
  }

  linkCount(): number {
    return this._links.size;
  }

  hasLink(id: LinkId): boolean {
    return this._links.has(id);
  }

  getLink(id: LinkId): Link | undefined {
    return this._links.get(id);
  }

  // docs/specs/plugins/data-store.md — Commands (`link/add`): one dependency per ordered pair. The
  // lookup walks the source task's outgoing bucket rather than every link, so it costs the task's
  // out-degree.
  /** Whether a link already runs from `sourceId` to `targetId`, whatever its type and lag. */
  hasLinkBetween(sourceId: TaskId, targetId: TaskId): boolean {
    const out = this.linksByTask.get(sourceId)?.out;
    return out !== undefined && out.some((link) => link.targetId === targetId);
  }

  links(): IterableIterator<Link> {
    return this._links.values();
  }

  hasResource(id: ResourceId): boolean {
    return this.resources.has(id);
  }

  getAssignment(taskId: TaskId, resourceId: ResourceId): Assignment | undefined {
    return this.assignmentsByTask.get(taskId)?.find((a) => a.resourceId === resourceId);
  }

  /** Every assignment, grouped by task in task-insertion order. */
  *assignments(): IterableIterator<Assignment> {
    for (const list of this.assignmentsByTask.values()) yield* list;
  }

  /** Clears every index in place, so the object handed out by `query()` stays valid. */
  clear(): void {
    this.byId.clear();
    this.children.clear();
    this.linksByTask.clear();
    this.calendars.clear();
    this.resources.clear();
    this.assignmentsByTask.clear();
    this._links.clear();
  }

  /**
   * Applies a transaction **atomically**. If any patch throws, the patches already applied are
   * rolled back by applying their inverses in reverse order and the error is rethrown, so the
   * store is never left half-changed.
   */
  applyTransaction(tx: Transaction): void {
    const applied: Patch[] = [];
    try {
      for (const patch of tx.patches) {
        this.applyPatch(patch);
        applied.push(patch);
      }
    } catch (err) {
      // A rollback failure must never replace the original error — that would erase the diagnostic
      // that explains why the transaction failed in the first place and leave the caller looking at
      // an unrelated stack trace for a store that is now further, differently corrupt. The original
      // error is always rethrown; a rollback failure is reported through its `cause` instead.
      try {
        for (let i = applied.length - 1; i >= 0; i--) {
          this.applyPatch(invertPatch(applied[i] as Patch));
        }
      } catch (rollbackErr) {
        const wrapped =
          err instanceof Error
            ? err
            : new Error(`stargantt: transaction "${tx.id}" failed: ${String(err)}`);
        (wrapped as { cause?: unknown }).cause = rollbackErr;
        throw wrapped;
      }
      throw err;
    }
  }

  /**
   * Applies one patch and updates the affected indexes. Throws if the patch does not fit.
   *
   * Which mutation each op means is decided by the single patch-op table (`ops.ts`), not here, so a
   * patch variant added later cannot be applied by one dispatch site and ignored by another.
   */
  applyPatch(patch: Patch): void {
    applyPatchTo(this, patch);
  }

  /* ---------------------------------------------------------------- *
   * tasks
   *
   * The per-op mutators below are the store's internal surface: the patch-op table calls them, and
   * `applyPatch` is the only entry point outside this file.
   * ---------------------------------------------------------------- */

  addTask(task: Task): void {
    if (this.byId.has(task.id)) {
      throw new Error(`stargantt: task "${String(task.id)}" already exists`);
    }
    this.byId.set(task.id, task);
    this._insertChild(task.parentId, task.id, task.orderKey ?? "");
  }

  removeTask(id: TaskId): void {
    const task = this.byId.get(id);
    if (!task) throw new Error(`stargantt: task "${String(id)}" does not exist`);
    // A bare `task/remove` patch (one not built through `buildTaskRemove`, which cascades over the
    // whole subtree first) that names a task with children would leave `this.children` pointing at
    // ids no longer reachable from `byId` — a phantom bucket that `query().children` would still
    // hand out. The store owns this invariant rather than trusting every caller of `applyPatch` to
    // have cascaded correctly first.
    const own = this.children.get(id);
    if (own && own.length > 0) {
      throw new Error(
        `stargantt: task "${String(id)}" cannot be removed while it still has children`,
      );
    }
    this.byId.delete(id);
    this._detachChild(task.parentId, id);
    const bucket = this.linksByTask.get(id);
    if (bucket && bucket.in.length === 0 && bucket.out.length === 0) this.linksByTask.delete(id);
    if (own) this.children.delete(id);
  }

  /**
   * Merges an update into a task — through the published `mergeTaskUpdate`, so the store and every
   * plugin that replays or projects a `task/update` patch run the same merge — and re-files the task
   * among its siblings when its parent or order changed.
   *
   * `clears` names keys to delete outright. It exists because a patch built from the current store
   * state (as the `task/update` command's runner does — `commands.ts#buildTaskUpdate`) cannot always
   * reconstruct a `before` that names every field to remove: the field may never have had a value at
   * all, so there is nothing to put in `before` to trigger the implicit `before`-only deletion. An
   * unknown key, or one the task does not currently carry, is a no-op; a required field
   * (`REQUIRED_TASK_FIELDS`) is never cleared, `id` included.
   */
  updateTask(
    id: TaskId,
    before: Partial<Task>,
    after: Partial<Task>,
    clears?: readonly (keyof Task)[],
  ): void {
    const current = this.byId.get(id);
    if (!current) throw new Error(`stargantt: task "${String(id)}" does not exist`);

    // `exactOptionalPropertyTypes` — the key is omitted rather than set to `undefined`.
    const updated = mergeTaskUpdate(
      current,
      clears === undefined ? { before, after } : { before, after, clears },
    );
    this.byId.set(id, updated);

    const parentChanged = updated.parentId !== current.parentId;
    const orderChanged = updated.orderKey !== current.orderKey;
    if (parentChanged || orderChanged) {
      this._detachChild(current.parentId, id);
      this._insertChild(updated.parentId, id, updated.orderKey ?? "");
    }
  }

  /** Inserts `id` among its siblings at the position given by `orderKey` (stable on ties). */
  private _insertChild(parentId: TaskId | null, id: TaskId, orderKey: string): void {
    let arr = this.children.get(parentId);
    if (!arr) {
      arr = [];
      this.children.set(parentId, arr);
    }
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const other = this.byId.get(arr[mid] as TaskId);
      const key = other?.orderKey ?? "";
      if (key <= orderKey) lo = mid + 1;
      else hi = mid;
    }
    arr.splice(lo, 0, id);
  }

  private _detachChild(parentId: TaskId | null, id: TaskId): void {
    const arr = this.children.get(parentId);
    if (!arr) return;
    const i = arr.indexOf(id);
    if (i >= 0) arr.splice(i, 1);
    if (arr.length === 0) this.children.delete(parentId);
  }

  /* ---------------------------------------------------------------- *
   * links
   * ---------------------------------------------------------------- */

  addLink(link: Link): void {
    if (this._links.has(link.id)) {
      throw new Error(`stargantt: link "${String(link.id)}" already exists`);
    }
    this._links.set(link.id, link);
    this._bucket(link.sourceId).out.push(link);
    this._bucket(link.targetId).in.push(link);
  }

  /**
   * Replaces the stored link carrying `link.id` with `link`, keeping the per-task buckets pointing
   * at the new object. Endpoints are re-bucketed when they differ, so the indexes stay consistent
   * even for a hand-built patch that moves a link between tasks.
   */
  updateLink(link: Link): void {
    const current = this._links.get(link.id);
    if (!current) throw new Error(`stargantt: link "${String(link.id)}" does not exist`);
    this._links.set(link.id, link);
    this._refileLink(current, link, "out");
    this._refileLink(current, link, "in");
  }

  private _refileLink(current: Link, next: Link, side: "in" | "out"): void {
    const taskId = side === "out" ? current.sourceId : current.targetId;
    const nextTaskId = side === "out" ? next.sourceId : next.targetId;
    if (taskId === nextTaskId) {
      const list = this.linksByTask.get(taskId)?.[side];
      const i = list?.findIndex((l) => l.id === next.id) ?? -1;
      if (list !== undefined && i >= 0) list[i] = next;
      else this._bucket(nextTaskId)[side].push(next);
      return;
    }
    this._unbucket(taskId, next.id, side);
    this._bucket(nextTaskId)[side].push(next);
  }

  removeLink(id: LinkId): void {
    const link = this._links.get(id);
    if (!link) throw new Error(`stargantt: link "${String(id)}" does not exist`);
    this._links.delete(id);
    this._unbucket(link.sourceId, id, "out");
    this._unbucket(link.targetId, id, "in");
  }

  /* ---------------------------------------------------------------- *
   * resources / assignments
   * ---------------------------------------------------------------- */

  addResource(resource: Resource): void {
    if (this.resources.has(resource.id)) {
      throw new Error(`stargantt: resource "${String(resource.id)}" already exists`);
    }
    this.resources.set(resource.id, resource);
  }

  removeResource(id: ResourceId): void {
    if (!this.resources.delete(id)) {
      throw new Error(`stargantt: resource "${String(id)}" does not exist`);
    }
  }

  /** Same merge semantics as `updateTask` (no `clears`); resource identity is not updatable. */
  updateResource(id: ResourceId, before: Partial<Resource>, after: Partial<Resource>): void {
    const current = this.resources.get(id);
    if (!current) throw new Error(`stargantt: resource "${String(id)}" does not exist`);
    this.resources.set(id, mergeUpdate(current, before, after, REQUIRED_RESOURCE_FIELDS));
  }

  addAssignment(assignment: Assignment): void {
    const { taskId, resourceId } = assignment;
    if (this.getAssignment(taskId, resourceId) !== undefined) {
      throw new Error(
        `stargantt: assignment (${String(taskId)}, ${String(resourceId)}) already exists`,
      );
    }
    let list = this.assignmentsByTask.get(taskId);
    if (!list) {
      list = [];
      this.assignmentsByTask.set(taskId, list);
    }
    list.push(assignment);
  }

  removeAssignment(taskId: TaskId, resourceId: ResourceId): void {
    const list = this.assignmentsByTask.get(taskId);
    const i = list?.findIndex((a) => a.resourceId === resourceId) ?? -1;
    if (list === undefined || i < 0) {
      throw new Error(
        `stargantt: assignment (${String(taskId)}, ${String(resourceId)}) does not exist`,
      );
    }
    list.splice(i, 1);
    if (list.length === 0) this.assignmentsByTask.delete(taskId);
  }

  updateAssignment(taskId: TaskId, resourceId: ResourceId, units: number): void {
    const list = this.assignmentsByTask.get(taskId);
    const i = list?.findIndex((a) => a.resourceId === resourceId) ?? -1;
    if (list === undefined || i < 0) {
      throw new Error(
        `stargantt: assignment (${String(taskId)}, ${String(resourceId)}) does not exist`,
      );
    }
    list[i] = { ...(list[i] as Assignment), units };
  }

  private _bucket(taskId: TaskId): LinkBucket {
    let b = this.linksByTask.get(taskId);
    if (!b) {
      b = { in: [], out: [] };
      this.linksByTask.set(taskId, b);
    }
    return b;
  }

  private _unbucket(taskId: TaskId, linkId: LinkId, side: "in" | "out"): void {
    const b = this.linksByTask.get(taskId);
    if (!b) return;
    const list = b[side];
    const i = list.findIndex((l) => l.id === linkId);
    if (i >= 0) list.splice(i, 1);
    if (b.in.length === 0 && b.out.length === 0 && !this.byId.has(taskId)) {
      this.linksByTask.delete(taskId);
    }
  }
}

/* ==================================================================== *
 * Store-ization (docs/specs/plugins/data-store.md — Services / Store
 * snapshot semantics): the four `DataService` stores this plugin
 * publishes.
 * ==================================================================== */

/** Immutable snapshot of every task, by id — `tasks.get()`'s value. */
export function snapshotTasks(store: Store): ReadonlyMap<TaskId, Readonly<Task>> {
  return new Map(store.byId);
}

/** Immutable snapshot of every link, by id — `links.get()`'s value. */
export function snapshotLinks(store: Store): ReadonlyMap<LinkId, Readonly<Link>> {
  const map = new Map<LinkId, Link>();
  for (const link of store.links()) map.set(link.id, link);
  return map;
}

/** Immutable snapshot of every resource, by id — `resources.get()`'s value. */
export function snapshotResources(store: Store): ReadonlyMap<ResourceId, Readonly<Resource>> {
  return new Map(store.resources);
}

/**
 * Immutable snapshot of every assignment, grouped by task in task-insertion order —
 * `assignments.get()`'s value. Assignments carry no id of their own, so the map is task-keyed.
 */
export function snapshotAssignments(
  store: Store,
): ReadonlyMap<TaskId, readonly Assignment[]> {
  const map = new Map<TaskId, readonly Assignment[]>();
  for (const [taskId, list] of store.assignmentsByTask) map.set(taskId, [...list]);
  return map;
}

/** The four writable stores backing `DataService`'s public `Store<...>` properties. */
export interface DataStores {
  readonly tasks: WritableStore<ReadonlyMap<TaskId, Readonly<Task>>>;
  readonly links: WritableStore<ReadonlyMap<LinkId, Readonly<Link>>>;
  readonly resources: WritableStore<ReadonlyMap<ResourceId, Readonly<Resource>>>;
  readonly assignments: WritableStore<ReadonlyMap<TaskId, readonly Assignment[]>>;
}

/** Creates the four stores, seeded from `store`'s current (normally empty) contents. */
export function createDataStores(store: Store): DataStores {
  return {
    tasks: createStore(snapshotTasks(store)),
    links: createStore(snapshotLinks(store)),
    resources: createStore(snapshotResources(store)),
    assignments: createStore(snapshotAssignments(store)),
  };
}
