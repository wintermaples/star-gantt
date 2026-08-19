// docs/specs/plugins/resource.md §2.3 / §2.6 item 8 — the utilization query surfaces' own roster
// and demand projection (caller policy, outside the engine).
/**
 * Builds the union roster (pool entries in pool order, then store-only resources in store order,
 * keyed by string id, names store-first) and the demand map the utilization query surfaces feed
 * `computeUtilization` with. Headless: no DOM.
 */
import type { DataService, Resource, ResourceId } from "@stargantt/plugin-data-store";
import type { TimeRange } from "@stargantt/sdk";
import type { DemandInterval, EngineResource } from "../engine/compute";
import type { WorkingIntervalCache } from "../engine/working-time";
import type { ResourcePoolEntry, ResourcePoolService } from "../pool/service";

export type UtilizationResourceSource = ResourcePoolEntry | Resource;

/** `capacity ?? 1`, guarded: a non-finite or non-positive stored capacity reads as 1 (§2.1). */
export function guardedCapacityRate(capacity: number | undefined): number {
  return typeof capacity === "number" && Number.isFinite(capacity) && capacity > 0 ? capacity : 1;
}

/**
 * The union roster (§2.3): pool entries in pool (registration) order, then store-only resources in
 * store order, keyed by string id — a store resource the pool also knows is represented once, by
 * its pool entry.
 */
export function buildUnionRoster(
  pool: ResourcePoolService,
  data: DataService,
  intervals: WorkingIntervalCache,
): EngineResource<UtilizationResourceSource>[] {
  const out: EngineResource<UtilizationResourceSource>[] = [];
  const seen = new Set<string>();
  const storeResources = data.query().resources;
  // Names resolve STORE-FIRST: a pool entry the data store ALSO knows displays the store's own
  // name, falling back to the pool entry's name only when the store has never heard of that id.
  // Position/order is unaffected —
  // the row still sits at its POOL rank; only the displayed `name` field can differ from
  // `entry.name`.
  for (const entry of pool.entries()) {
    seen.add(String(entry.id));
    const name = storeResources.get(entry.id)?.name ?? entry.name;
    out.push(toEngineResource(entry.id, name, entry.capacity, entry, intervals));
  }
  for (const resource of storeResources.values()) {
    const key = String(resource.id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(toEngineResource(resource.id, resource.name, resource.capacity, resource, intervals));
  }
  return out;
}

function toEngineResource(
  id: ResourceId,
  name: string,
  capacity: number | undefined,
  source: UtilizationResourceSource,
  intervals: WorkingIntervalCache,
): EngineResource<UtilizationResourceSource> {
  return {
    id,
    name,
    capacityRate: guardedCapacityRate(capacity),
    source,
    workingIntervals: (from: number, to: number, out?: TimeRange[]) =>
      intervals.intervalsFor(id, from, to, out),
  };
}

/**
 * The utilization-side demand projection (§2.6 item 8): one interval per assignment on its task's
 * span, keyed by `String(resourceId)`. Skips non-finite or inverted (non-positive) task spans and
 * exactly-zero `units`; negative and non-finite `units` pass into the accrual unfiltered (no
 * pinned test exercises that path).
 */
export function buildUtilizationDemands(data: DataService): Map<string, DemandInterval[]> {
  const view = data.query();
  const map = new Map<string, DemandInterval[]>();
  for (const [taskId, assignments] of view.assignmentsByTask) {
    const task = view.byId.get(taskId);
    if (task === undefined) continue;
    if (!(Number.isFinite(task.start) && Number.isFinite(task.end) && task.end > task.start)) continue;
    for (const a of assignments) {
      if (a.units === 0) continue;
      const key = String(a.resourceId);
      const list = map.get(key);
      const demand: DemandInterval = { start: task.start, end: task.end, units: a.units };
      if (list === undefined) map.set(key, [demand]);
      else list.push(demand);
    }
  }
  return map;
}
