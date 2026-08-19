// docs/specs/plugins/data-sync.md §2.3
/**
 * Pending-change tracker: records the task-domain patches of locally-originated transactions,
 * coalesces them per task, and produces (a) the `ChangeBatch` to push and (b) the inverse command
 * plans that roll the batch back if the push is rejected (§2.4/§2.5).
 *
 * Pure and hostless — fed patches, queried for batches. Only `task/*` patches are tracked.
 */
import type { Patch, Task, TaskId } from "@stargantt/plugin-data-store";
import type { ChangeBatch } from "../../types";

/** Inverse command plans, in safe application order (re-adds before updates before removes). */
export interface RollbackPlan {
  /** Tasks to re-create (they were locally removed). */
  adds: Task[];
  /** Updates restoring the pre-change fields. */
  updates: { id: TaskId; after: Partial<Task>; clears: (keyof Task)[] }[];
  /** Ids to remove (they were locally created). */
  removes: TaskId[];
}

type Pending =
  | { kind: "create"; task: Task }
  | { kind: "remove"; task: Task }
  | {
      kind: "update";
      id: TaskId;
      /** Coalesced forward fields to push. */
      after: Partial<Task>;
      clears: Set<keyof Task>;
      /** Fields to restore on rollback (first-seen `before` values). */
      undoAfter: Partial<Task>;
      /** Fields to delete on rollback (set forward but absent before). */
      undoClears: Set<keyof Task>;
    };

function assignKnown(target: Partial<Task>, source: Partial<Task>): void {
  for (const key of Object.keys(source) as (keyof Task)[]) {
    if (key === "id") continue;
    (target as Record<string, unknown>)[key] = source[key];
  }
}

export class ChangeTracker {
  private readonly byId = new Map<TaskId, Pending>();

  /** Records the task-domain patches of one applied transaction. Non-task patches are ignored. */
  record(patches: readonly Patch[]): void {
    for (const patch of patches) {
      if (patch.op === "task/add") this.onAdd(patch.task);
      else if (patch.op === "task/remove") this.onRemove(patch.task);
      else if (patch.op === "task/update") this.onUpdate(patch.id, patch.before, patch.after, patch.clears);
    }
  }

  /** Drops everything (a bulk replacement established a new baseline — §6.1). */
  clear(): void {
    this.byId.clear();
  }

  get size(): number {
    return this.byId.size;
  }

  /** Whether a pending change for `id` is currently tracked (accumulated after the last `take()`). */
  has(id: TaskId): boolean {
    return this.byId.has(id);
  }

  counts(): { creates: number; updates: number; removes: number } {
    let creates = 0;
    let updates = 0;
    let removes = 0;
    for (const p of this.byId.values()) {
      if (p.kind === "create") creates += 1;
      else if (p.kind === "update") updates += 1;
      else removes += 1;
    }
    return { creates, updates, removes };
  }

  /**
   * Takes the pending set: returns the batch to push and its rollback plan, and resets the
   * tracker so changes made while the push is in flight accumulate separately.
   */
  take(): { batch: ChangeBatch; rollback: RollbackPlan } {
    const batch: ChangeBatch = { creates: [], updates: [], removes: [] };
    const rollback: RollbackPlan = { adds: [], updates: [], removes: [] };
    for (const p of this.byId.values()) {
      if (p.kind === "create") {
        batch.creates.push({ ...p.task });
        rollback.removes.push(p.task.id);
      } else if (p.kind === "remove") {
        batch.removes.push(p.task.id);
        rollback.adds.push({ ...p.task });
      } else {
        const entry: ChangeBatch["updates"][number] = { id: p.id, after: { ...p.after } };
        if (p.clears.size > 0) entry.clears = [...p.clears];
        batch.updates.push(entry);
        rollback.updates.push({ id: p.id, after: { ...p.undoAfter }, clears: [...p.undoClears] });
      }
    }
    this.byId.clear();
    return { batch, rollback };
  }

  private onAdd(task: Task): void {
    const prior = this.byId.get(task.id);
    if (prior?.kind === "remove") {
      // Removed then re-added: relative to the backend this is an update to the new row.
      const after: Partial<Task> = {};
      assignKnown(after, task);
      const undoAfter: Partial<Task> = {};
      assignKnown(undoAfter, prior.task);
      const undoClears = new Set<keyof Task>();
      for (const key of Object.keys(after) as (keyof Task)[]) {
        if (!(key in prior.task)) undoClears.add(key);
      }
      // Forward clears: fields the backend's row (the removed task) carried but the re-added row
      // does not must be unset on push, or the backend would silently keep their stale values.
      const clears = new Set<keyof Task>();
      for (const key of Object.keys(prior.task) as (keyof Task)[]) {
        if (key !== "id" && !(key in after)) clears.add(key);
      }
      this.byId.set(task.id, { kind: "update", id: task.id, after, clears, undoAfter, undoClears });
      return;
    }
    this.byId.set(task.id, { kind: "create", task });
  }

  private onRemove(task: Task): void {
    const prior = this.byId.get(task.id);
    if (prior?.kind === "create") {
      // Created then removed locally: the backend never needs to hear about it.
      this.byId.delete(task.id);
      return;
    }
    // A prior update collapses into the removal; rollback re-adds the pre-update row.
    let original = task;
    if (prior?.kind === "update") {
      const restored: Record<string, unknown> = { ...task, ...prior.undoAfter };
      for (const key of prior.undoClears) delete restored[key as string];
      original = restored as unknown as Task;
    }
    this.byId.set(task.id, { kind: "remove", task: original });
  }

  private onUpdate(
    id: TaskId,
    before: Partial<Task>,
    after: Partial<Task>,
    clears: readonly (keyof Task)[] | undefined,
  ): void {
    const prior = this.byId.get(id);
    if (prior?.kind === "create") {
      // Fold the edit into the pending creation.
      const task = { ...prior.task };
      assignKnown(task as Partial<Task>, after);
      for (const key of clears ?? []) {
        if (key !== "id") delete (task as Record<string, unknown>)[key as string];
      }
      this.byId.set(id, { kind: "create", task: task as Task });
      return;
    }
    if (prior?.kind === "remove") return; // update of a task pending removal: nothing to push
    const entry: Extract<Pending, { kind: "update" }> =
      prior ?? { kind: "update", id, after: {}, clears: new Set(), undoAfter: {}, undoClears: new Set() };
    // Forward: latest value wins per key; a cleared key stops being an `after` key.
    assignKnown(entry.after, after);
    for (const key of Object.keys(after) as (keyof Task)[]) entry.clears.delete(key);
    for (const key of clears ?? []) {
      if (key === "id") continue;
      entry.clears.add(key);
      delete (entry.after as Record<string, unknown>)[key as string];
    }
    // Undo: the first-seen prior value per key is the one to restore.
    const touched = new Set<keyof Task>([...(Object.keys(after) as (keyof Task)[]), ...(clears ?? [])]);
    for (const key of touched) {
      if (key === "id") continue;
      if (key in entry.undoAfter || entry.undoClears.has(key)) continue;
      if (key in before) (entry.undoAfter as Record<string, unknown>)[key as string] = before[key];
      else entry.undoClears.add(key);
    }
    this.byId.set(id, entry);
  }
}
