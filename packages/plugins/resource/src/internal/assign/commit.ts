// docs/specs/plugins/resource.md §3.3 "Editor" / "Drag reassign" — raw patch construction for the
// editor's Apply and for a chip drop, plus the head/tail split that lands either as one
// `sdk/aggregate` transaction (`createTransactionBatcher`) or, in the drag-reassign case where the
// target side needs no change, as a single ordinary command with nothing to batch at all.
//
// Patches are built from PRE-transaction state (mirroring exactly what the data store's own
// `assignment/set` / `assignment/remove` / `resource/add` command builders would produce for the
// same inputs) because the tail rides into the transaction as raw patches, bypassing the command
// builders' own re-validation entirely — see `docs/specs/sdk.md`, Module: sdk/aggregate.
import type { PluginContext } from "@stargantt/core";
import type { Patch, ResourceId, TaskId } from "@stargantt/plugin-data-store";
import type { TransactionBatch } from "@stargantt/sdk";
import { diffAssignments, sameId, unitsOf } from "./model";
import type { AssignmentLike, Id } from "./model";

/** The only four patch ops this area ever builds — narrower than the store's full `Patch` union
 * (which also covers task/link ops this area never touches) so the dispatch switch below can be
 * checked exhaustive against `never` instead of an unreachable `default: return`. */
export type AssignPatch = Extract<
  Patch,
  { op: "resource/add" | "assignment/add" | "assignment/update" | "assignment/remove" }
>;

/** The pre-transaction read surface `commit.ts` needs: current store membership/assignments, and
 * the pool's own idea of a resource, so a pool-only pick can be mirrored into the store. Kept
 * narrow and DOM-free so every function below is testable without a host. */
export interface AssignStoreView {
  /** Whether the store already knows this resource id (string-form id matching, §3.3). */
  hasResource(resourceId: Id): boolean;
  /** A task's current assignments, in store order; empty for an unknown task. */
  assignmentsOf(taskId: Id): readonly AssignmentLike[];
  /** The pool's own record of a resource, `undefined` when the pool does not carry it either. */
  poolEntry(resourceId: Id): { id: Id; name: string; capacity?: number } | undefined;
}

/** The raw patch that mirrors a pool entry into the store, `undefined` when already there or known
 * to neither store nor pool. */
function resourceAddPatch(view: AssignStoreView, resourceId: Id): AssignPatch | undefined {
  if (view.hasResource(resourceId)) return undefined;
  const entry = view.poolEntry(resourceId);
  if (entry === undefined) return undefined;
  const resource: { id: ResourceId; name: string; capacity?: number } = { id: entry.id, name: entry.name };
  if (entry.capacity !== undefined) resource.capacity = entry.capacity;
  return { op: "resource/add", resource };
}

/** The raw patch for setting `taskId`/`resourceId` to `units`, given the task's current
 * assignments — mirrors what `assignment/set`'s own command handler would produce. `undefined`
 * when the pair already carries exactly that rate (no observable change). */
function assignmentSetPatch(
  current: readonly AssignmentLike[],
  taskId: Id,
  resourceId: Id,
  units: number,
): AssignPatch | undefined {
  const existing = unitsOf(current, resourceId);
  if (existing === undefined) {
    return { op: "assignment/add", assignment: { taskId: taskId as TaskId, resourceId: resourceId as ResourceId, units } };
  }
  if (existing === units) return undefined;
  return {
    op: "assignment/update",
    taskId: taskId as TaskId,
    resourceId: resourceId as ResourceId,
    before: { units: existing },
    after: { units },
  };
}

/** The raw patch for removing `taskId`/`resourceId`, `undefined` when the pair is already gone. */
function assignmentRemovePatch(
  current: readonly AssignmentLike[],
  taskId: Id,
  resourceId: Id,
): AssignPatch | undefined {
  const existing = current.find((a) => sameId(a.resourceId, resourceId));
  if (existing === undefined) return undefined;
  return {
    op: "assignment/remove",
    assignment: { taskId: taskId as TaskId, resourceId: existing.resourceId as ResourceId, units: existing.units },
  };
}

/**
 * Builds the ordered patch list for one editor Apply: for each checked-and-changed resource, a
 * `resource/add` mirror first when it is pool-only, then its `assignment/set` patch; then every
 * unchecked-but-currently-assigned resource's `assignment/remove` patch. A resource named by
 * neither the store nor the pool is silently skipped (§3.3).
 */
export function buildEditorApplyPatches(
  view: AssignStoreView,
  taskId: Id,
  desired: ReadonlyMap<Id, number>,
): AssignPatch[] {
  const current = view.assignmentsOf(taskId);
  const diff = diffAssignments(current, desired);
  const patches: AssignPatch[] = [];
  for (const { resourceId, units } of diff.set) {
    if (!view.hasResource(resourceId)) {
      const add = resourceAddPatch(view, resourceId);
      if (add === undefined) continue; // known to neither store nor pool: skip the whole pair
      patches.push(add);
    }
    const setPatch = assignmentSetPatch(current, taskId, resourceId, units);
    if (setPatch !== undefined) patches.push(setPatch);
  }
  for (const resourceId of diff.remove) {
    const removePatch = assignmentRemovePatch(current, taskId, resourceId);
    if (removePatch !== undefined) patches.push(removePatch);
  }
  return patches;
}

/**
 * Builds the patch list for one drag-reassign drop: the target's assignment (mirroring a pool-only
 * target resource first) before the source's removal, both carrying the source's own units.
 *
 * Same task, an unknown source pair, or a target resource known to neither store nor pool all
 * yield an empty list (no-op, §3.3). When the target already carries exactly the moved units, the
 * list is just `[removal]` — the natural degenerate case that makes the caller's head/tail split
 * dispatch a single `assignment/remove` command with nothing to batch.
 */
export function buildReassignPatches(
  view: AssignStoreView,
  fromTaskId: Id,
  toTaskId: Id,
  resourceId: Id,
): AssignPatch[] {
  if (sameId(fromTaskId, toTaskId)) return [];
  const source = view.assignmentsOf(fromTaskId).find((a) => sameId(a.resourceId, resourceId));
  if (source === undefined) return [];

  const patches: AssignPatch[] = [];
  if (!view.hasResource(resourceId)) {
    const add = resourceAddPatch(view, resourceId);
    if (add === undefined) return []; // unknown to both store and pool: nothing written at all
    patches.push(add);
  }
  const targetPatch = assignmentSetPatch(view.assignmentsOf(toTaskId), toTaskId, resourceId, source.units);
  if (targetPatch !== undefined) patches.push(targetPatch);
  patches.push({
    op: "assignment/remove",
    assignment: { taskId: fromTaskId as TaskId, resourceId: source.resourceId as ResourceId, units: source.units },
  });
  return patches;
}

/** Dispatches one raw patch as the equivalent public command, stamped with `origin` — the head of
 * a batched transaction, or a lone command when the patch list has exactly one entry. */
function dispatchAssignPatch(ctx: PluginContext, patch: AssignPatch, origin: string): void {
  switch (patch.op) {
    case "resource/add":
      ctx.dispatch("resource/add", { resource: patch.resource, origin });
      return;
    case "assignment/add":
      ctx.dispatch("assignment/set", {
        taskId: patch.assignment.taskId,
        resourceId: patch.assignment.resourceId,
        units: patch.assignment.units,
        origin,
      });
      return;
    case "assignment/update":
      ctx.dispatch("assignment/set", {
        taskId: patch.taskId,
        resourceId: patch.resourceId,
        units: patch.after.units,
        origin,
      });
      return;
    case "assignment/remove":
      ctx.dispatch("assignment/remove", {
        taskId: patch.assignment.taskId,
        resourceId: patch.assignment.resourceId,
        origin,
      });
      return;
    default: {
      // Exhaustiveness check: a fifth `AssignPatch` member added later without a case here fails
      // typecheck instead of silently dropping the patch at runtime.
      const exhaustive: never = patch;
      return exhaustive;
    }
  }
}

/**
 * Runs one patch list as a single user-undoable transaction: the first patch dispatches as an
 * ordinary command (the batcher's head), every remaining patch rides into that same transaction as
 * a raw tail patch. An empty list dispatches nothing — exactly the "commit dispatches nothing"
 * no-op path Cancel, an unchanged diff, and a no-op drag drop all share.
 */
export function runAssignPatches(ctx: PluginContext, batch: TransactionBatch<Patch>, patches: readonly AssignPatch[]): void {
  const [head, ...tail] = patches;
  if (head === undefined) return;
  batch((origin) => dispatchAssignPatch(ctx, head, origin), tail);
}
