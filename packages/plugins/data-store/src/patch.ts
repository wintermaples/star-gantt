/**
 * List-level operations over patches. The per-op knowledge they rest on lives in one table —
 * `ops.ts` — so that a new `Patch` member cannot be handled here and forgotten there.
 */
import { collectChangedIds, invertPatch } from "./ops";
import type { Patch, TaskId } from "./types";

export { invertPatch } from "./ops";

/** The inverse of a patch list: every patch inverted, in reverse order. */
export function invertPatches(patches: readonly Patch[]): Patch[] {
  const out: Patch[] = [];
  for (let i = patches.length - 1; i >= 0; i--) out.push(invertPatch(patches[i] as Patch));
  return out;
}

/**
 * The set of task ids a patch list touches. A link patch marks **both** endpoints, because the
 * dependency line drawn between their rows changes; a resource-only change marks nothing at all.
 */
export function changedTaskIds(patches: readonly Patch[]): Set<TaskId> {
  const ids = new Set<TaskId>();
  for (const patch of patches) collectChangedIds(patch, ids);
  return ids;
}
