// docs/specs/plugins/export.md §1.5 — the import batch's plan/count arithmetic and its
// harvest-and-cancel dispatch, riding the single guard `internal/embed/guard.ts` installs.
/**
 * Turning a change list into the command calls one `importCsv`/`importJson` apply will dispatch,
 * counting what those calls actually landed, and running the whole batch as **one** transaction
 * through the harvest-and-cancel mechanism (§1.5): every call is first dispatched with
 * `preventDefault()` called immediately by the guard, its runner-built patch list harvested against
 * the still-untouched pre-import state; the first call with a non-empty harvest is then re-dispatched
 * as the driver, with every other harvested patch list appended to its transaction.
 */
import { midKey } from "@stargantt/plugin-data-store";
import type { Patch, ReadonlyDataView, Task, TaskId } from "@stargantt/plugin-data-store";
import type { ImportApplyResult, ImportChange } from "../../types";
import type { DataGuard } from "../embed/guard";
import { IMPORT_ORIGIN } from "../embed/guard";
import type { ExportWiring } from "../wiring";

export { IMPORT_ORIGIN };

/** One command call the batch will make, in the order `apply` should run it. */
export type Call =
  | { command: "task/add"; payload: { task: Task; origin: typeof IMPORT_ORIGIN } }
  | { command: "task/update"; payload: { id: TaskId; after: Partial<Task>; origin: typeof IMPORT_ORIGIN } }
  | { command: "task/remove"; payload: { ids: TaskId[]; origin: typeof IMPORT_ORIGIN } };

export type AddCall = Extract<Call, { command: "task/add" }>;

/** A planned apply batch: what to dispatch, plus what counting it later needs. */
export interface ApplyBatch {
  calls: Call[];
  /** Updates merged into a pending add, counted only if that add lands. */
  mergedInto: Map<AddCall, number>;
  /** The ids the change list asked to remove — cascade removals are not among them. */
  removedIds: TaskId[];
}

/** The mutable working set `collectChanges` fills. */
interface Draft {
  adds: AddCall[];
  addById: Map<TaskId, AddCall>;
  mergedInto: Map<AddCall, number>;
  updates: Call[];
  removedIds: TaskId[];
  droppedAdds: Set<AddCall>;
}

/** Drops a batch-added task and every batch add transitively parented under it. */
function dropAddedSubtree(draft: Draft, rootId: TaskId): void {
  const stack: TaskId[] = [rootId];
  while (stack.length > 0) {
    const id = stack.pop() as TaskId;
    const call = draft.addById.get(id);
    if (call !== undefined) {
      draft.droppedAdds.add(call);
      draft.addById.delete(id);
    }
    for (const other of draft.adds) {
      if (!draft.droppedAdds.has(other) && other.payload.task.parentId === id) {
        const childId = other.payload.task.id;
        if (childId !== undefined) stack.push(childId);
        else draft.droppedAdds.add(other);
      }
    }
  }
}

/**
 * Folds an update naming a task added earlier in the same batch into that add.
 *
 * §1.5 counting rule: an update changing nothing is counted in no bucket. A merged update counts
 * only when at least one stated field differs from the pending add's current value; a
 * no-difference merge is dropped outright, matching the standalone path where an unchanged update
 * harvests an empty patch list and is skipped.
 */
function mergeUpdateIntoAdd(draft: Draft, host: AddCall, after: Partial<Task>): void {
  let differs = false;
  for (const key of Object.keys(after) as (keyof Task)[]) {
    if (host.payload.task[key] !== after[key]) {
      differs = true;
      break;
    }
  }
  if (!differs) return;
  host.payload.task = { ...host.payload.task, ...after };
  draft.mergedInto.set(host, (draft.mergedInto.get(host) ?? 0) + 1);
}

/**
 * Classifies every change into pending adds, standalone updates and removals, resolving the
 * intra-batch dependencies on the way (see `planApplyBatch`).
 */
function collectChanges(draft: Draft, changes: readonly ImportChange[]): void {
  for (const change of changes) {
    if (change === null || typeof change !== "object") continue;
    if (change.kind === "add") {
      const call: AddCall = {
        command: "task/add",
        payload: { task: { ...change.task }, origin: IMPORT_ORIGIN },
      };
      draft.adds.push(call);
      const id = call.payload.task.id;
      if (id !== undefined) draft.addById.set(id, call);
    } else if (change.kind === "update") {
      const host = draft.addById.get(change.id);
      if (host !== undefined) mergeUpdateIntoAdd(draft, host, change.after);
      else {
        draft.updates.push({
          command: "task/update",
          payload: { id: change.id, after: { ...change.after }, origin: IMPORT_ORIGIN },
        });
      }
    } else if (change.kind === "remove") {
      if (draft.addById.has(change.id)) dropAddedSubtree(draft, change.id);
      else draft.removedIds.push(change.id);
    }
  }
}

/**
 * §1.5 — pre-assigns strictly increasing sibling `orderKey`s. Every add is harvested against the
 * same pre-import sibling list, so leaving the keys to `task/add`'s runner would mint the same key
 * for every new sibling; chaining `midKey` here from each parent's current last sibling reproduces
 * exactly the keys sequential dispatches would have produced.
 */
function assignOrderKeys(keptAdds: readonly AddCall[], view: ReadonlyDataView): void {
  const lastKeyByParent = new Map<TaskId | null, string>();
  for (const call of keptAdds) {
    const task = call.payload.task;
    const parentId = task.parentId ?? null;
    let prev = lastKeyByParent.get(parentId);
    if (prev === undefined) {
      const siblings = view.children.get(parentId) ?? [];
      const lastId = siblings[siblings.length - 1];
      prev = lastId === undefined ? "" : (view.byId.get(lastId)?.orderKey ?? "");
    }
    if (task.orderKey === undefined) task.orderKey = midKey(prev, undefined);
    lastKeyByParent.set(parentId, task.orderKey);
  }
}

/**
 * Plans one apply batch against the pre-import store state.
 *
 * §1.5 — every command is harvested against the store state from *before* the apply, so a later
 * call can never observe an earlier call's effect. Intra-batch dependencies are therefore resolved
 * here, before anything is dispatched: an `update` naming a task added earlier in the same batch is
 * merged into that add's task, and a `remove` naming one drops the add (and every batch add
 * parented under it) instead of dispatching a removal of a task the store never saw.
 */
export function planApplyBatch(changes: readonly ImportChange[], view: ReadonlyDataView): ApplyBatch {
  const draft: Draft = {
    adds: [],
    addById: new Map(),
    mergedInto: new Map(),
    updates: [],
    removedIds: [],
    droppedAdds: new Set(),
  };
  if (!Array.isArray(changes)) return { calls: [], mergedInto: draft.mergedInto, removedIds: [] };

  collectChanges(draft, changes);
  const keptAdds = draft.adds.filter((call) => !draft.droppedAdds.has(call));
  assignOrderKeys(keptAdds, view);

  const calls: Call[] = [...keptAdds, ...draft.updates];
  if (draft.removedIds.length > 0) {
    // One command for all removals: the store cascades links/assignments per removed task.
    calls.push({ command: "task/remove", payload: { ids: draft.removedIds, origin: IMPORT_ORIGIN } });
  }
  return { calls, mergedInto: draft.mergedInto, removedIds: draft.removedIds };
}

/**
 * §1.5 — the result counts changes that actually landed: a call whose harvest is empty (an update
 * or remove naming an unknown id, an update changing nothing, or a call vetoed by read-only mode)
 * applied nothing and is not counted. For the batched remove, only requested ids that produced a
 * `task/remove` patch count — cascade removals never do.
 */
export function countApplied(batch: ApplyBatch, harvested: readonly Patch[][]): ImportApplyResult {
  const result: ImportApplyResult = { added: 0, updated: 0, removed: 0 };
  const removedSet = new Set(batch.removedIds);
  for (let i = 0; i < batch.calls.length; i++) {
    const patches = harvested[i] as Patch[];
    if (patches.length === 0) continue;
    const call = batch.calls[i] as Call;
    if (call.command === "task/add") {
      result.added += 1;
      result.updated += batch.mergedInto.get(call as AddCall) ?? 0;
    } else if (call.command === "task/update") {
      result.updated += 1;
    } else {
      for (const patch of patches) {
        if (patch.op === "task/remove" && removedSet.has(patch.task.id)) result.removed += 1;
      }
    }
  }
  return result;
}

function dispatchCall(w: ExportWiring, call: Call): void {
  if (call.command === "task/add") w.ctx.dispatch("task/add", call.payload);
  else if (call.command === "task/update") w.ctx.dispatch("task/update", call.payload);
  else w.ctx.dispatch("task/remove", call.payload);
}

/**
 * Runs every call in `batch.calls` as a canceled harvest dispatch (via `guard.harvestOne`) and
 * returns the patches each one built — empty for a call that was vetoed (read-only, §2.1's
 * interplay) or produced nothing.
 *
 * Harvesting every call first is safe because none of them touches the store yet — a canceled
 * dispatch never applies — so dispatch order among them doesn't matter here. It also protects
 * against a caller-supplied change list whose first entry happens to be a no-op: the driver picked
 * below is the first call that actually produced patches, not unconditionally `calls[0]`.
 */
function harvestCalls(w: ExportWiring, guard: DataGuard, calls: readonly Call[]): Patch[][] {
  const harvested: Patch[][] = [];
  for (const call of calls) {
    const patches = guard.harvestOne(() => dispatchCall(w, call));
    // §1.5 — keep every runner in the batch deterministic: an add that carried no `id` had one
    // minted by the store during this (canceled) harvest dispatch. Copy it back onto the payload
    // so a later re-dispatch of the same call (as the driver) reuses it instead of minting a fresh
    // id, keeping the driver's recomputed patches identical to the harvested ones.
    if (call.command === "task/add" && call.payload.task.id === undefined) {
      const minted = patches.find((patch) => patch.op === "task/add");
      if (minted !== undefined) call.payload.task.id = minted.task.id;
    }
    harvested.push(patches);
  }
  return harvested;
}

/**
 * Re-dispatches the first call that produced patches — for real this time (its own runner is pure
 * and reads the same still-untouched store state, so it recomputes the identical patches) — with
 * everything harvested from the other calls appended to its transaction.
 */
function dispatchDriver(
  w: ExportWiring,
  guard: DataGuard,
  calls: readonly Call[],
  harvested: readonly Patch[][],
): void {
  const driverIndex = harvested.findIndex((patches) => patches.length > 0);
  if (driverIndex === -1) return;
  const rest: Patch[] = [];
  for (let i = 0; i < calls.length; i++) {
    if (i === driverIndex) continue;
    for (const patch of harvested[i] as Patch[]) rest.push(patch);
  }
  guard.dispatchDriverWith(() => dispatchCall(w, calls[driverIndex] as Call), rest);
}

/**
 * Runs one `apply()` batch: plans it against the current store, harvests every call, counts what
 * would land, then dispatches the driver for real — one transaction, one history entry. Emits
 * `importexport/applied` once when at least one change actually applied.
 */
export function applyChanges(
  w: ExportWiring,
  guard: DataGuard,
  changes: readonly ImportChange[],
  cause: "api" | "dialog",
): ImportApplyResult {
  const batch = planApplyBatch(changes, w.data.query());
  let result: ImportApplyResult = { added: 0, updated: 0, removed: 0 };
  if (batch.calls.length > 0) {
    const harvested = harvestCalls(w, guard, batch.calls);
    result = countApplied(batch, harvested);
    dispatchDriver(w, guard, batch.calls, harvested);
  }
  if (result.added + result.updated + result.removed > 0) {
    w.ctx.emit("importexport/applied", { result, cause });
  }
  return result;
}
