/**
 * The one table that knows what each patch op means.
 *
 * `Patch` is a closed union, and three questions have to be answered for every one of its members:
 * how it is applied to the store, what its inverse is, and which task rows it makes dirty. Answering
 * them in three separate switch statements is how a member added later becomes a silent no-op in the
 * one that was forgotten — a partial undo, or a row that never repaints. The table below is typed
 * against `Patch["op"]`, so a new member is a compile error until all three answers exist.
 */
import { REQUIRED_TASK_FIELDS, asRecord } from "./fields";
import type { Store } from "./store";
import type { Assignment, Link, Patch, Resource, ResourceId, Task, TaskId } from "./types";

/** Which of the three things a patch does to the entity it names. */
export type ChangeKind = "added" | "removed" | "updated";

/**
 * Where a patch reports what it did, so that the post-apply classification can read a patch list
 * without a second switch over `Patch`.
 *
 * Entities are passed along with ids because a removed one is no longer readable from the store by
 * the time classification runs, and a reader needs to know *what* was removed, not only that
 * something was.
 */
export interface ChangeSink {
  task(kind: ChangeKind, id: TaskId): void;
  link(kind: ChangeKind, link: Link): void;
  resource(kind: ChangeKind, id: ResourceId, entity: Resource | undefined): void;
  assignment(kind: ChangeKind, assignment: Assignment): void;
}

/** Everything the system needs to know about one patch op. */
interface PatchOp<P extends Patch> {
  /** Applies the patch to the store, keeping its indexes in step. Throws if the patch does not fit. */
  apply(store: Store, patch: P): void;
  /** The patch that undoes it. */
  invert(patch: P): Patch;
  /** Adds the ids of the task rows the patch changes to `into`. */
  changedIds(patch: P, into: Set<TaskId>): void;
  /**
   * Reports the domain and the kind of change this patch is, for post-apply classification.
   *
   * Called **after** the patch has been applied, so a variant that carries only the changed fields
   * (`resource/update`) can read the whole entity back out of `store`.
   */
  classify(patch: P, sink: ChangeSink, store: Store): void;
}

/** One row per member of the `Patch` union — no member may be left out. */
type PatchOpTable = { readonly [K in Patch["op"]]: PatchOp<Extract<Patch, { op: K }>> };

/**
 * The `clears` list the inverse of a `task/update` must carry.
 *
 * Every key the forward `after` set that the forward `before` lacked **entirely** (genuinely absent,
 * not merely a different value) is named, because assigning `before` back cannot restore a key to
 * *unset* — an omitted key means "leave the current value alone". A required field is excluded: a
 * task is never without one, so such a key can never have been introduced from nothing, and a
 * hand-built patch whose `before` simply omitted an untouched required field would otherwise invert
 * into "delete that required field" and corrupt the task.
 */
// docs/specs/plugins/data-store.md — Field deletion (`clears`): the implicit `before`-only
// deletion, an explicit `clears` list and a `clears` derived while inverting all exclude the
// required fields the same way.
function inverseClears(patch: Extract<Patch, { op: "task/update" }>): (keyof Task)[] {
  const before = asRecord(patch.before);
  return (Object.keys(patch.after) as (keyof Task)[]).filter(
    (key) => !REQUIRED_TASK_FIELDS.has(key) && !((key as string) in before),
  );
}

// docs/specs/plugins/data-store.md — Data model (the reversible `Patch` union) and the
// resource/assignment variants inverse-paired like the task/link ones; an assignment change marks
// its task, a resource-only change marks nothing.
export const PATCH_OPS = {
  "task/add": {
    apply: (store, patch) => store.addTask(patch.task),
    invert: (patch) => ({ op: "task/remove", task: patch.task }),
    changedIds: (patch, into) => void into.add(patch.task.id),
    classify: (patch, sink) => sink.task("added", patch.task.id),
  },
  "task/remove": {
    apply: (store, patch) => store.removeTask(patch.task.id),
    invert: (patch) => ({ op: "task/add", task: patch.task }),
    changedIds: (patch, into) => void into.add(patch.task.id),
    classify: (patch, sink) => sink.task("removed", patch.task.id),
  },
  "task/update": {
    apply: (store, patch) => store.updateTask(patch.id, patch.before, patch.after, patch.clears),
    invert: (patch) => {
      const clears = inverseClears(patch);
      // `exactOptionalPropertyTypes` — omit the key rather than assign an empty list, so that an
      // inversion that clears nothing is deep-equal to the plain swapped patch.
      return clears.length === 0
        ? { op: "task/update", id: patch.id, before: patch.after, after: patch.before }
        : { op: "task/update", id: patch.id, before: patch.after, after: patch.before, clears };
    },
    changedIds: (patch, into) => void into.add(patch.id),
    classify: (patch, sink) => sink.task("updated", patch.id),
  },
  "link/add": {
    apply: (store, patch) => store.addLink(patch.link),
    invert: (patch) => ({ op: "link/remove", link: patch.link }),
    // Both endpoints: the dependency line drawn between their rows changes.
    changedIds: (patch, into) => {
      into.add(patch.link.sourceId);
      into.add(patch.link.targetId);
    },
    classify: (patch, sink) => sink.link("added", patch.link),
  },
  "link/remove": {
    apply: (store, patch) => store.removeLink(patch.link.id),
    invert: (patch) => ({ op: "link/add", link: patch.link }),
    changedIds: (patch, into) => {
      into.add(patch.link.sourceId);
      into.add(patch.link.targetId);
    },
    classify: (patch, sink) => sink.link("removed", patch.link),
  },
  "link/update": {
    apply: (store, patch) => {
      // A `link/update` patch retypes/re-lags one link in place — its id is never one of the
      // fields the patch can change. A hand-built patch whose `before.id` and `after.id` disagree
      // would silently rename a link's identity underneath `Store#updateLink`, which keys off
      // `patch.after.id` alone and would leave the old id's bucket entries dangling.
      if (patch.before.id !== patch.after.id) {
        throw new Error(
          `stargantt: link/update before.id "${String(patch.before.id)}" does not match after.id "${String(patch.after.id)}"`,
        );
      }
      store.updateLink(patch.after);
    },
    invert: (patch) => ({ op: "link/update", before: patch.after, after: patch.before }),
    // Every endpoint either side names: the line drawn between those rows changes.
    changedIds: (patch, into) => {
      into.add(patch.before.sourceId);
      into.add(patch.before.targetId);
      into.add(patch.after.sourceId);
      into.add(patch.after.targetId);
    },
    // The link as it now stands, which is exactly what the patch replaced the stored one with.
    classify: (patch, sink) => sink.link("updated", patch.after),
  },
  "resource/add": {
    apply: (store, patch) => store.addResource(patch.resource),
    invert: (patch) => ({ op: "resource/remove", resource: patch.resource }),
    changedIds: () => {},
    classify: (patch, sink) => sink.resource("added", patch.resource.id, patch.resource),
  },
  "resource/remove": {
    apply: (store, patch) => store.removeResource(patch.resource.id),
    invert: (patch) => ({ op: "resource/add", resource: patch.resource }),
    changedIds: () => {},
    classify: (patch, sink) => sink.resource("removed", patch.resource.id, patch.resource),
  },
  "resource/update": {
    apply: (store, patch) => store.updateResource(patch.id, patch.before, patch.after),
    invert: (patch) => ({
      op: "resource/update",
      id: patch.id,
      before: patch.after,
      after: patch.before,
    }),
    changedIds: () => {},
    // Only the changed fields are in the patch, so the whole resource is read back post-apply.
    classify: (patch, sink, store) =>
      sink.resource("updated", patch.id, store.resources.get(patch.id)),
  },
  "assignment/add": {
    apply: (store, patch) => store.addAssignment(patch.assignment),
    invert: (patch) => ({ op: "assignment/remove", assignment: patch.assignment }),
    changedIds: (patch, into) => void into.add(patch.assignment.taskId),
    classify: (patch, sink) => sink.assignment("added", patch.assignment),
  },
  "assignment/remove": {
    apply: (store, patch) =>
      store.removeAssignment(patch.assignment.taskId, patch.assignment.resourceId),
    invert: (patch) => ({ op: "assignment/add", assignment: patch.assignment }),
    changedIds: (patch, into) => void into.add(patch.assignment.taskId),
    classify: (patch, sink) => sink.assignment("removed", patch.assignment),
  },
  "assignment/update": {
    apply: (store, patch) =>
      store.updateAssignment(patch.taskId, patch.resourceId, patch.after.units),
    invert: (patch) => ({
      op: "assignment/update",
      taskId: patch.taskId,
      resourceId: patch.resourceId,
      before: patch.after,
      after: patch.before,
    }),
    changedIds: (patch, into) => void into.add(patch.taskId),
    classify: (patch, sink) =>
      sink.assignment("updated", {
        taskId: patch.taskId,
        resourceId: patch.resourceId,
        units: patch.after.units,
      }),
  },
} satisfies PatchOpTable;

/**
 * The row for `patch`.
 *
 * The row is looked up by the patch's own `op`, so for a well-typed patch its handlers are by
 * construction the ones for that exact variant; the cast only restates that to the compiler, which
 * cannot follow the correlation between a table key and a union member.
 *
 * A patch carrying an op the table does not know — only reachable from untyped code, since `Patch`
 * is a closed union — throws, naming the op. Ignoring it would be worse than the error: the patch
 * would be dropped from an apply, an inversion or a changed-id set without a trace, which is exactly
 * how a transaction and its undo come to disagree.
 */
function opFor(patch: Patch): PatchOp<Patch> {
  const row = PATCH_OPS[patch.op] as PatchOp<Patch> | undefined;
  if (row === undefined) {
    throw new Error(`stargantt: unknown patch op "${String((patch as { op: unknown }).op)}"`);
  }
  return row;
}

/** Applies one patch to `store`, updating the affected indexes. Throws if the patch does not fit. */
export function applyPatchTo(store: Store, patch: Patch): void {
  opFor(patch).apply(store, patch);
}

/**
 * The inverse of a patch — the patch that undoes it. `add` and `remove` are duals, and `update` is
 * inverted by swapping `before` and `after` (plus the `clears` that restore fields the forward patch
 * introduced from nothing).
 */
export function invertPatch(patch: Patch): Patch {
  return opFor(patch).invert(patch);
}

/** Adds the ids of the task rows `patch` changes to `into`. */
export function collectChangedIds(patch: Patch, into: Set<TaskId>): void {
  opFor(patch).changedIds(patch, into);
}

/**
 * Reports what `patch` did to `sink`. Call only after the patch has been applied to `store` — a
 * patch carrying just the changed fields resolves the entity by reading the store back.
 */
export function classifyPatch(patch: Patch, sink: ChangeSink, store: Store): void {
  opFor(patch).classify(patch, sink, store);
}
