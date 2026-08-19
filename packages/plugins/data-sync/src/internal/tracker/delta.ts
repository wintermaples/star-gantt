// docs/specs/plugins/data-sync.md §2.2 / §5.1
/**
 * Converge-exactly delta application, shared by §2.2's `sync()` and §5.1's realtime message
 * pipeline: turns a list of `DeltaChange`/`RealtimeChange` entries into store command plans
 * against the current data view. Pure and hostless.
 *
 * Every incoming field is assigned; every optional field the current task carries that the
 * incoming row lacks is cleared — the store row converges to the sender's row exactly. Two knobs
 * parameterize the one shared rule for the realtime caller (§5.1): `preserveKey` exempts one field
 * from the "lacks it → clear it" rule (the store-managed `orderKey`), and `suppressEcho` skips
 * planning an update whose row is value-identical to the current task (echo suppression).
 */
import type { ReadonlyDataView, Task, TaskId } from "@stargantt/plugin-data-store";
import type { DeltaChange } from "../../types";

export interface DeltaPlan {
  adds: Task[];
  updates: { id: TaskId; after: Partial<Task>; clears: (keyof Task)[] }[];
  removes: TaskId[];
}

/** Whether a raw value carries the required task fields (`id`, `name`, numeric `start`/`end`). */
export function isTaskLike(value: unknown): value is Task {
  if (value === null || typeof value !== "object") return false;
  const t = value as Partial<Task>;
  return (
    (typeof t.id === "string" || typeof t.id === "number") &&
    typeof t.name === "string" &&
    typeof t.start === "number" &&
    typeof t.end === "number"
  );
}

export interface DeltaApplyOptions {
  /** A field never cleared even when the incoming row lacks it (realtime's `orderKey` exception). */
  preserveKey?: keyof Task;
  /** Skip planning an upsert whose row is `Object.is`-shallow-equal to the current task (§5.1). */
  suppressEcho?: boolean;
}

/**
 * Plans the store commands that apply `changes` against `view`. Unusable entries are skipped: an
 * upsert whose row lacks the required task fields, a removal of an id the store does not hold.
 * Duplicate upserts of the same not-yet-known id within one batch collapse into the queued add
 * (the latest row wins wholesale, not field-by-field), mirroring the removes-side de-dup.
 */
export function planDelta(
  changes: readonly DeltaChange[],
  view: ReadonlyDataView,
  options: DeltaApplyOptions = {},
): DeltaPlan {
  const plan: DeltaPlan = { adds: [], updates: [], removes: [] };
  if (!Array.isArray(changes)) return plan;
  const removeIds = new Set<TaskId>();
  const pendingAdds = new Map<TaskId, number>();
  for (const change of changes) {
    if (change === null || typeof change !== "object") continue;
    if (change.type === "remove") {
      if (view.byId.has(change.id) && !removeIds.has(change.id)) {
        removeIds.add(change.id);
        plan.removes.push(change.id);
      }
      continue;
    }
    if (change.type !== "upsert" || !isTaskLike(change.task)) continue;
    const incoming = change.task;
    const current = view.byId.get(incoming.id);
    if (current === undefined) {
      const queued = pendingAdds.get(incoming.id);
      if (queued === undefined) {
        pendingAdds.set(incoming.id, plan.adds.length);
        plan.adds.push({ ...incoming });
      } else {
        plan.adds[queued] = { ...incoming };
      }
      continue;
    }
    const after: Partial<Task> = {};
    let differs = false;
    for (const key of Object.keys(incoming) as (keyof Task)[]) {
      if (key === "id") continue;
      (after as Record<string, unknown>)[key] = incoming[key];
      if (options.suppressEcho === true && !Object.is(incoming[key], current[key])) differs = true;
    }
    const clears: (keyof Task)[] = [];
    for (const key of Object.keys(current) as (keyof Task)[]) {
      if (key === options.preserveKey) continue;
      if (!(key in incoming)) clears.push(key);
    }
    if (options.suppressEcho === true && !differs && clears.length === 0) continue;
    plan.updates.push({ id: incoming.id, after, clears });
  }
  return plan;
}
