/**
 * Reading task-id sets that arrive from a service this plugin does not own, without assuming more
 * than the contract states.
 *
 * `SelectionState.taskIds` is declared a `ReadonlySet` (interaction.md §2.1) and the official
 * provider publishes exactly that. `stargantt.selection` is a same-layer, optionally resolved
 * service, though — any plugin may provide it — and an array-shaped `taskIds` would make a bare
 * `ids.has(...)` throw out of the subscription that keeps the ARIA mirror in step. The `Set`
 * assumption is therefore checked here, in one place, instead of being spread implicitly over the
 * call sites (`references/code-quality.md` §4: payload shapes are contracts; don't assume `Set` vs
 * array beyond what the contract states).
 */
import type { TaskId } from "@stargantt/plugin-data-store";

/** Any shape an id-set member can plausibly arrive in. */
export type IdSetLike = ReadonlySet<TaskId> | Iterable<TaskId> | undefined;

/** Whether `ids` holds `id`, for a value that may not be the `Set` its declaration states. */
export function idSetHas(ids: IdSetLike, id: TaskId): boolean {
  if (ids === undefined) return false;
  if (typeof (ids as ReadonlySet<TaskId>).has === "function") {
    return (ids as ReadonlySet<TaskId>).has(id);
  }
  if (typeof (ids as Iterable<TaskId>)[Symbol.iterator] !== "function") return false;
  for (const candidate of ids as Iterable<TaskId>) if (candidate === id) return true;
  return false;
}

/**
 * The value as a real set: itself when it already is one, a copy when it is some other iterable,
 * and `undefined` when it is neither (including `undefined` itself, which the mirror reads as "no
 * selection information available").
 */
export function asIdSet(ids: IdSetLike): ReadonlySet<TaskId> | undefined {
  if (ids === undefined) return undefined;
  // A string is iterable but would explode into its characters — reject it as malformed.
  if (typeof ids === "string") return undefined;
  if (typeof (ids as ReadonlySet<TaskId>).has === "function") return ids as ReadonlySet<TaskId>;
  if (typeof (ids as Iterable<TaskId>)[Symbol.iterator] !== "function") return undefined;
  return new Set(ids as Iterable<TaskId>);
}
