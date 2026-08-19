// docs/specs/plugins/data-sync.md §3.1 / §3.2
/**
 * Row validation and stream-change planning: turns backend page rows and incremental changes into
 * store command plans against the current data view. Pure and hostless.
 */
import type { Task, TaskId } from "@stargantt/plugin-data-store";
import type { StreamChange } from "../../types";

/** Whether a raw row carries the required task fields (`id`, `name`, numeric `start`/`end`). */
export function isTaskLike(value: unknown): value is Task {
  if (value === null || typeof value !== "object") return false;
  const t = value as Partial<Task>;
  return (
    (typeof t.id === "string" || typeof t.id === "number") &&
    typeof t.name === "string" &&
    typeof t.start === "number" &&
    Number.isFinite(t.start) &&
    typeof t.end === "number" &&
    Number.isFinite(t.end)
  );
}

/** A validated page row as a complete task (`parentId` defaults to `null`). */
export function toTask(row: Task): Task {
  return row.parentId === undefined ? { ...row, parentId: null } : { ...row };
}

export interface StreamPlan {
  adds: Task[];
  updates: { id: TaskId; after: Partial<Task> }[];
  removes: TaskId[];
}

/**
 * Plans the store commands that apply a batch of stream changes (§3.2). Unusable entries are
 * skipped: an upsert whose row lacks the required fields, a removal of an unknown id. Updates
 * assign every incoming field and leave fields the row lacks untouched — the minimal merge,
 * deliberately weaker than the source/realtime areas' converge-exactly rule.
 */
export function planChanges(changes: readonly StreamChange[], has: (id: TaskId) => boolean): StreamPlan {
  const plan: StreamPlan = { adds: [], updates: [], removes: [] };
  if (!Array.isArray(changes)) return plan;
  const pendingAdds = new Map<TaskId, number>();
  for (const change of changes) {
    if (change === null || typeof change !== "object") continue;
    if (change.type === "remove") {
      if (has(change.id) && !plan.removes.includes(change.id)) plan.removes.push(change.id);
      continue;
    }
    if (change.type !== "upsert" || !isTaskLike(change.task)) continue;
    const incoming = change.task;
    if (!has(incoming.id)) {
      const queued = pendingAdds.get(incoming.id);
      if (queued === undefined) {
        pendingAdds.set(incoming.id, plan.adds.length);
        plan.adds.push(toTask(incoming));
      } else {
        // Minimal merge, latest value per field, like the update path.
        plan.adds[queued] = { ...plan.adds[queued]!, ...toTask(incoming) };
      }
      continue;
    }
    const after: Partial<Task> = {};
    for (const key of Object.keys(incoming) as (keyof Task)[]) {
      if (key === "id") continue;
      (after as Record<string, unknown>)[key] = incoming[key];
    }
    plan.updates.push({ id: incoming.id, after });
  }
  return plan;
}
