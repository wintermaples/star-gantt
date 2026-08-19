// docs/specs/plugins/resource.md §3.1 — the one-way `pool.syncToStore` mirror.
/**
 * Diffs the pool against the data store's resource list and produces a mirror plan: id/name/
 * capacity only, one-way. Hostless — computes the plan as data; the wiring dispatches it.
 *
 * **Removal undo granularity.** The `resource/remove` command takes an id ARRAY, so this plan
 * groups every removal from one reconcile pass into a SINGLE `{ op: "remove", ids }` step — one
 * dispatch, one undo step, whatever N is. `add`/`update` are unaffected (still one step per
 * changed entry). A host that undoes a mirror transaction gets back the store copy as it was
 * before the WHOLE reconcile; the undo-divergence window from reconciling on the very next
 * mutation is unaffected either way (resource.md §3.1's stated limitation).
 */
import type { Resource, ResourceId } from "@stargantt/plugin-data-store";
import type { ResourcePoolEntry } from "../../config";

export type SyncStep =
  | { op: "add"; resource: { id: ResourceId; name: string; capacity?: number } }
  | { op: "update"; id: ResourceId; after: { name?: string; capacity?: number } }
  | { op: "remove"; ids: ResourceId[] };

/**
 * Diffs the pool against the store's resource list and returns the mirror plan plus the id set the
 * mirror now owns. Only ids in `owned` (previously mirrored) may be removed; a pool id that already
 * exists in the store is adopted and updated rather than duplicated.
 */
export function planSync(
  pool: readonly ResourcePoolEntry[],
  storeResources: Iterable<Resource>,
  owned: ReadonlySet<ResourceId>,
): { steps: SyncStep[]; owned: Set<ResourceId> } {
  const inStore = new Map<ResourceId, Resource>();
  for (const resource of storeResources) inStore.set(resource.id, resource);

  const steps: SyncStep[] = [];
  const nextOwned = new Set<ResourceId>();
  for (const entry of pool) {
    nextOwned.add(entry.id);
    const existing = inStore.get(entry.id);
    if (existing === undefined) {
      steps.push({
        op: "add",
        resource: {
          id: entry.id,
          name: entry.name,
          ...(entry.capacity !== undefined ? { capacity: entry.capacity } : {}),
        },
      });
    } else {
      const after: { name?: string; capacity?: number } = {};
      if (existing.name !== entry.name) after.name = entry.name;
      if (entry.capacity !== undefined && existing.capacity !== entry.capacity) {
        after.capacity = entry.capacity;
      }
      if (Object.keys(after).length > 0) steps.push({ op: "update", id: entry.id, after });
    }
  }
  const removed: ResourceId[] = [];
  for (const id of owned) {
    if (!nextOwned.has(id) && inStore.has(id)) removed.push(id);
  }
  if (removed.length > 0) steps.push({ op: "remove", ids: removed });
  return { steps, owned: nextOwned };
}
