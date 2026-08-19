// docs/specs/plugins/tree-grid.md § Config — "Completion auto-record": appends one `task/update`
// patch stamping `actualEnd` when a transaction flips a task's status to `done`, riding inside the
// same transaction (the data-store's appendable-handler path) so one undo removes both.
import type { Task, TaskId } from "@stargantt/plugin-data-store";
import type { TaskFieldValues } from "../../types";
import { fieldsOfTask, metaWith } from "./fields";

interface UpdatePatchLike {
  op: "task/update";
  id: TaskId;
  before: Partial<Task>;
  after: Partial<Task>;
  clears?: readonly (keyof Task)[];
}

function fieldsOfMeta(meta: unknown): Readonly<TaskFieldValues> {
  return fieldsOfTask({ meta } as unknown as Task);
}

/**
 * Scans a transaction's patches and appends the `actualEnd` stamps. `getTask` reads the
 * pre-apply store state; `now` is the recorded completion instant. Mutates `patches` in place
 * (the contractually appendable list) and returns how many stamps were appended.
 */
export function appendCompletionStamps(
  patches: unknown[],
  getTask: (id: TaskId) => Readonly<Task> | undefined,
  now: number,
): number {
  let appended = 0;
  // Snapshot the length: our own appended patches must not be re-scanned.
  const length = patches.length;
  for (let i = 0; i < length; i += 1) {
    const p = patches[i] as Partial<UpdatePatchLike> | null;
    if (typeof p !== "object" || p === null || p.op !== "task/update") continue;
    const after = p.after;
    if (typeof after !== "object" || after === null || !("meta" in after)) continue;
    const newFields = fieldsOfMeta(after.meta);
    if (newFields.status !== "done" || newFields.actualEnd !== undefined) continue;
    const task = p.id === undefined ? undefined : getTask(p.id);
    if (task === undefined) continue;
    if (fieldsOfTask(task).status === "done") continue;
    const stamped: TaskFieldValues = { ...newFields, actualEnd: now };
    patches.push({
      op: "task/update",
      id: p.id,
      before: { meta: after.meta },
      after: { meta: metaWith(after.meta ?? undefined, stamped) },
    });
    appended += 1;
  }
  return appended;
}
