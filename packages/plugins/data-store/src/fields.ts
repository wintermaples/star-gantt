/**
 * Field-level helpers shared by every path that reads or writes an entity's fields by name:
 * the store's patch application, the command builders that derive a patch from the current state,
 * and the patch inverter. Keeping them here is what makes "which fields can never be deleted" and
 * "how an update merges" single facts rather than four copies of the same loop.
 */
import type { ResourceId, Task, TaskId } from "./types";

// docs/specs/plugins/data-store.md — Data model: the fields a Task cannot be without. Every
// deletion path — the store's update merge, `commands.ts`'s `clears` filter and the inverter's
// derived `clears` — excludes them from one place, and sibling plugins that replay or project this
// store's patches import this very set instead of copying it.
/**
 * The task fields no deletion path may remove: `id`, `parentId`, `name`, `start` and `end`.
 *
 * A `task/update` patch that names one of them in its `clears`, or whose `before` carries one that
 * its `after` omits, leaves that field alone: a task is never without them.
 */
export const REQUIRED_TASK_FIELDS: ReadonlySet<keyof Task> = new Set<keyof Task>([
  "id",
  "parentId",
  "name",
  "start",
  "end",
]);

/** Fields of `Resource` that must always be present, and are therefore never deleted by an update. */
export const REQUIRED_RESOURCE_FIELDS: ReadonlySet<string> = new Set(["id", "name"]);

/**
 * Views an entity as a plain string-keyed record.
 *
 * Update patches name the fields they touch as runtime strings (`before` / `after` / `clears`), and
 * TypeScript cannot express "some key of this interface, unknown until runtime" for reads *and*
 * writes, so the conversion is done here once instead of at every call site.
 */
export function asRecord(entity: object): Record<string, unknown> {
  return entity as unknown as Record<string, unknown>;
}

/** Takes a record built by `asRecord` back to the entity type it was assembled for. */
export function asEntity<T>(record: Record<string, unknown>): T {
  return record as unknown as T;
}

/**
 * The result of applying an update patch to one entity: a new object, leaving `current` untouched.
 *
 * The rules, identical for every entity type:
 * 1. assign every key of `after` — except `id`, since identity is not updatable;
 * 2. delete every key `before` carries that `after` does not, which is what makes an update that
 *    *introduced* an optional field reversible (the inverse patch has the field in `before` and not
 *    in `after`, so applying it removes the field again);
 * 3. delete every key named in `clears`.
 *
 * A key named in `required` survives both deletion rules, and a key the entity does not carry is a
 * no-op in either.
 */
export function mergeUpdate<T extends object>(
  current: T,
  before: Partial<T>,
  after: Partial<T>,
  required: ReadonlySet<string>,
  clears?: readonly (keyof T)[],
): T {
  const next = { ...asRecord(current) };
  const source = asRecord(after);

  for (const key of Object.keys(source)) {
    if (key === "id") continue;
    next[key] = source[key];
  }
  for (const key of Object.keys(before)) {
    if (required.has(key)) continue;
    if (Object.prototype.hasOwnProperty.call(source, key)) continue;
    delete next[key];
  }
  if (clears !== undefined) {
    for (const key of clears) {
      const name = key as string;
      if (required.has(name)) continue;
      delete next[name];
    }
  }
  return asEntity<T>(next);
}

// docs/specs/plugins/data-store.md — Data model: the published entry point onto the task-update
// merge. It is the very routine the store runs inside a transaction (`Store#updateTask` calls this
// function), so a plugin that replays or projects a `task/update` patch cannot drift from the
// store's semantics.
/**
 * Applies a `task/update` patch to a task, returning the resulting task.
 *
 * The three steps, in order: every field of `patch.after` is assigned (`id` excepted — identity
 * is not updatable); then every field
 * `patch.before` carries that `patch.after` does not mention is deleted (that is what makes an
 * update which *introduced* an optional field reversible — the inverse patch carries the field in
 * `before` and not in `after`); then every field named in `patch.clears` is deleted. A field a task
 * can never be without — `id`, `parentId`, `name`, `start`, `end` — survives all three steps
 * whatever the patch says, and a field the task does not currently carry is a no-op in either
 * deletion step.
 *
 * Pure: `task` is not modified, and the returned object is a new one.
 */
export function mergeTaskUpdate(
  task: Readonly<Task>,
  patch: {
    before: Partial<Task>;
    after: Partial<Task>;
    clears?: readonly (keyof Task)[];
  },
): Task {
  // `mergeUpdate` walks a patch's keys at runtime (`Object.keys` yields `string`), while the
  // published set is keyed by `keyof Task` — the same five names, viewed as plain strings.
  return mergeUpdate(
    task,
    patch.before,
    patch.after,
    REQUIRED_TASK_FIELDS as ReadonlySet<string>,
    patch.clears,
  );
}

/**
 * Splits an update command's payload into the two halves of the patch it implies: `after` holds
 * every key the payload names (`id` excluded — identity is not updatable) and `before` the current
 * value of each of those keys, omitted when the entity carries no value for it so that undoing the
 * change removes the key again rather than writing `undefined` into it.
 */
export function splitUpdate<T extends object>(
  current: T,
  payload: Partial<T>,
): { after: Record<string, unknown>; before: Record<string, unknown> } {
  const source = asRecord(payload);
  const now = asRecord(current);
  const after: Record<string, unknown> = {};
  const before: Record<string, unknown> = {};

  for (const key of Object.keys(source)) {
    if (key === "id") continue;
    // A payload key whose value is explicitly `undefined` is not a "set to undefined" request —
    // this API has a dedicated spelling for deletion (`clears`), and an update payload only ever
    // means "leave alone" for a key it omits. Copying an explicit `undefined` into `after` would
    // make `mergeUpdate`'s `next[key] = source[key]` write `undefined` into the entity, which is a
    // different, unintended state from the key being genuinely absent.
    if (source[key] === undefined) continue;
    after[key] = source[key];
    const value = now[key];
    if (value !== undefined) before[key] = value;
  }
  return { after, before };
}

/**
 * The identity of an assignment as a single string — its (taskId, resourceId) pair.
 *
 * Ids may be strings or numbers, so each half carries its own type tag: without it the number `1`
 * and the string `"1"` would name the same assignment.
 */
export function assignmentKey(taskId: TaskId, resourceId: ResourceId): string {
  return `${typeof taskId}:${String(taskId)} ${typeof resourceId}:${String(resourceId)}`;
}
