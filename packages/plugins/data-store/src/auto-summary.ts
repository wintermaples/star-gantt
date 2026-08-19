// docs/specs/plugins/data-store.md — Apply flow: the store keeps one shape invariant — a task that
// has children has `type: "summary"`. A task that gains children inside a transaction is promoted
// by an extra patch appended to that same transaction; the bulk paths, which carry no transaction,
// restore the same invariant by writing the type directly.
/**
 * Derives the summary-promotion patches a transaction implies, and restores the same invariant on
 * the bulk paths.
 *
 * Pure and hostless: reads the store and the (final) patch list, simulates the parent/child and
 * `type` effects of the listed patches without applying anything, and returns the `task/update`
 * patches that promote every non-summary task that ends the transaction with at least one gained
 * child. The caller appends them to the same transaction, so undoing it demotes the parent again —
 * the inverse of a promotion whose `before` lacked `type` carries `clears: ["type"]`, restoring the
 * field to absent.
 */
import type { Store } from "./store";
import type { Patch, Task, TaskId } from "./types";

/** What the patch list does to the tree shape and to task types, without applying anything. */
interface Simulated {
  /** Net child-count change per parent id. */
  childDelta: Map<TaskId, number>;
  /** Parents that gained at least one child (a net-zero shuffle does not promote). */
  gained: Set<TaskId>;
  removed: Set<TaskId>;
  added: Map<TaskId, Task>;
  /** Effective `type` after the listed updates; an entry holding `undefined` means "cleared". */
  typeOverride: Map<TaskId, Task["type"]>;
}

function simulate(store: Store, patches: readonly Patch[]): Simulated {
  const state: Simulated = {
    childDelta: new Map(),
    gained: new Set(),
    removed: new Set(),
    added: new Map(),
    typeOverride: new Map(),
  };
  const parentOverride = new Map<TaskId, TaskId | null>();

  const bump = (parentId: TaskId | null | undefined, delta: number): void => {
    if (parentId === null || parentId === undefined) return;
    state.childDelta.set(parentId, (state.childDelta.get(parentId) ?? 0) + delta);
    if (delta > 0) state.gained.add(parentId);
  };

  const effectiveParent = (id: TaskId): TaskId | null | undefined => {
    if (parentOverride.has(id)) return parentOverride.get(id) ?? null;
    return (state.added.get(id) ?? store.byId.get(id))?.parentId;
  };

  for (const patch of patches) {
    switch (patch.op) {
      case "task/add":
        state.added.set(patch.task.id, patch.task);
        state.removed.delete(patch.task.id);
        bump(patch.task.parentId, +1);
        break;
      case "task/remove":
        state.removed.add(patch.task.id);
        bump(effectiveParent(patch.task.id) ?? patch.task.parentId, -1);
        break;
      case "task/update": {
        if ("type" in patch.after) state.typeOverride.set(patch.id, patch.after.type);
        else if (patch.clears?.includes("type")) state.typeOverride.set(patch.id, undefined);
        if ("parentId" in patch.after) {
          const from = effectiveParent(patch.id) ?? null;
          const to = patch.after.parentId ?? null;
          if (from !== to) {
            bump(from, -1);
            bump(to, +1);
            parentOverride.set(patch.id, to);
          }
        }
        break;
      }
      default:
        // Link / resource / assignment patches never change the tree shape or a task's type.
        break;
    }
  }
  return state;
}

export function deriveSummaryPromotions(store: Store, patches: readonly Patch[]): Patch[] {
  const state = simulate(store, patches);
  const out: Patch[] = [];
  for (const parentId of state.gained) {
    if (state.removed.has(parentId)) continue;
    const task = state.added.get(parentId) ?? store.byId.get(parentId);
    if (task === undefined) continue;
    const type = state.typeOverride.has(parentId) ? state.typeOverride.get(parentId) : task.type;
    // Everything but an existing summary is promoted, milestones included: a diamond that hides a
    // subtree is a shape no consumer can paint, and every reader decides "is this a project?" from
    // `type` alone.
    if (type === "summary") continue;
    const net = (store.children.get(parentId)?.length ?? 0) + (state.childDelta.get(parentId) ?? 0);
    if (net <= 0) continue;
    out.push(
      type === undefined
        ? { op: "task/update", id: parentId, before: {}, after: { type: "summary" } }
        : { op: "task/update", id: parentId, before: { type }, after: { type: "summary" } },
    );
  }
  return out;
}

// docs/specs/plugins/data-store.md — Bulk paths: `load()` and deferred materialization carry no
// transaction and no undo entry, so the invariant is restored by writing the type directly rather
// than by emitting patches nobody would ever invert.
/** Promotes every task in `ids` that has children and is not already a summary. */
export function normalizeSummaryTypes(store: Store, ids: Iterable<TaskId>): void {
  for (const id of ids) {
    const task = store.byId.get(id);
    if (task === undefined || task.type === "summary") continue;
    if ((store.children.get(id)?.length ?? 0) === 0) continue;
    store.applyPatch({
      op: "task/update",
      id,
      before: task.type === undefined ? {} : { type: task.type },
      after: { type: "summary" },
    });
  }
}
