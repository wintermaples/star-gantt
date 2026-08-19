/**
 * Shared fixtures for the bridged engine suites (docs/specs/plugins/resource.md §2).
 *
 * load-chart's matrix and resource-utilization's engine are the same `computeUtilization`
 * underneath, so each bridged suite drives that one entry point with ITS OWN `edges` / hooks /
 * roster (§2.5, §2.6). The projections the two sides apply upstream of their engines (row rosters
 * and demand filters) are CALLER policy and therefore live here, in the suites' own fixtures,
 * rather than in `internal/engine/`.
 */
import { DEFAULT_WORKWEEK, MS_DAY, MS_HOUR, MS_MINUTE, workingIntervals } from "@stargantt/sdk";
import type { TimeRange, WorkingCalendar } from "@stargantt/sdk";
import type { DemandInterval, EngineResource } from "../src/internal/engine/compute";

export { MS_DAY, MS_HOUR, MS_MINUTE };
export const MS_WEEK = 7 * MS_DAY;

/** Monday 2024-01-01 00:00 UTC — the anchor both suites use. */
export const MONDAY = Date.UTC(2024, 0, 1);

/** The load-chart 09:00–17:00 Monday–Friday shift calendar. */
export const SHIFT: WorkingCalendar = {
  workingDays: [1, 2, 3, 4, 5],
  workingHours: [[9 * MS_HOUR, 17 * MS_HOUR]],
};

/** A working-interval listing over one calendar — the shape `EngineResource.workingIntervals` has. */
export function calendarListing(
  calendar: Readonly<WorkingCalendar>,
): (from: number, to: number, out?: TimeRange[]) => TimeRange[] {
  return (from, to, out) => workingIntervals(calendar, from, to, out ?? []);
}

/** The shared default week (UTC Monday–Friday, whole days) — §2.3's fallback listing. */
export const DEFAULT_LISTING = calendarListing(DEFAULT_WORKWEEK);

/** Every millisecond of the span is working time. */
export function alwaysWorking(from: number, to: number, out?: TimeRange[]): TimeRange[] {
  const list = out ?? [];
  if (to > from) list.push({ start: from, end: to });
  return list;
}

/** One roster row, defaulting to a full-time resource on the shared default week. */
export function engineResource<R = unknown>(
  over: Partial<EngineResource<R>> = {},
): EngineResource<R> {
  return {
    id: "r1",
    name: "R1",
    capacityRate: 1,
    workingIntervals: DEFAULT_LISTING,
    source: undefined as unknown as R,
    ...over,
  };
}

/** The `demands` map keyed by `String(id)`, the shape `BucketInput.demands` takes. */
export function demandsOf(
  entries: Readonly<Record<string, readonly DemandInterval[]>>,
): Map<string, readonly DemandInterval[]> {
  return new Map(Object.entries(entries));
}

/** One resource's demands — the common single-row case. */
export function demandsFor(
  id: string | number,
  demands: readonly DemandInterval[],
): Map<string, readonly DemandInterval[]> {
  return new Map([[String(id), demands]]);
}

/* ------------------------------------------------------------------ *
 * The two caller-side projections (§2.3 / §2.6 item 8)
 * ------------------------------------------------------------------ */

/** The store shapes the projections read — the members of `ReadonlyDataView` they touched. */
export interface StoreTask {
  id: string;
  start: number;
  end: number;
}
export interface StoreResource {
  id: string | number;
  name: string;
  capacity?: number;
}
export interface StoreAssignment {
  taskId: string;
  resourceId: string | number;
  units: number;
}
export interface Store {
  tasks: readonly StoreTask[];
  resources: readonly StoreResource[];
  assignments: readonly StoreAssignment[];
}

/**
 * The load-chart roster: the `resources` allowlist in allowlist order, unknown and duplicate ids
 * dropped; store order when there is no allowlist (`buckets.ts`'s `allowedResources`).
 */
export function loadChartRoster(
  store: Store,
  allowlist: readonly (string | number)[] | undefined,
  listing = DEFAULT_LISTING,
): EngineResource<StoreResource>[] {
  const byId = new Map(store.resources.map((r) => [r.id, r]));
  const picked: StoreResource[] = [];
  if (allowlist === undefined) picked.push(...store.resources);
  else {
    const seen = new Set<string | number>();
    for (const id of allowlist) {
      if (seen.has(id)) continue;
      seen.add(id);
      const resource = byId.get(id);
      if (resource !== undefined) picked.push(resource);
    }
  }
  return picked.map((r) => ({
    id: r.id,
    name: r.name,
    // §2.1 — a non-finite or non-positive stored capacity reads as 1, never as itself.
    capacityRate: usableRate(r.capacity),
    workingIntervals: listing,
    source: r,
  }));
}

/** The usability guard on a stored capacity (§2.1). */
export function usableRate(capacity: number | undefined): number {
  return typeof capacity === "number" && Number.isFinite(capacity) && capacity > 0 ? capacity : 1;
}

/**
 * The load-chart demand projection: one interval per assignment over its task's span, clipped to
 * nothing here (the engine clips), admitting only `units > 0` (`matrix.ts`'s `!(a.units > 0)`
 * guard) and excluding milestones / non-positive spans.
 */
export function loadChartDemands(
  store: Store,
  roster: readonly EngineResource<StoreResource>[],
): Map<string, readonly DemandInterval[]> {
  const rows = new Set(roster.map((r) => String(r.id)));
  const tasks = new Map(store.tasks.map((t) => [t.id, t]));
  const out = new Map<string, DemandInterval[]>();
  for (const a of store.assignments) {
    const key = String(a.resourceId);
    if (!rows.has(key)) continue;
    if (!(a.units > 0)) continue;
    const task = tasks.get(a.taskId);
    if (task === undefined || !(task.end > task.start)) continue;
    const list = out.get(key);
    const entry = { start: task.start, end: task.end, units: a.units };
    if (list === undefined) out.set(key, [entry]);
    else list.push(entry);
  }
  return out;
}

/**
 * The utilization demand projection: non-finite or inverted spans and exactly-zero units are
 * skipped, while negative and non-finite units pass into the accrual (`engine.ts`'s
 * `d.units === 0` guard).
 */
export function utilizationDemands(
  store: Store,
): Map<string, readonly DemandInterval[]> {
  const tasks = new Map(store.tasks.map((t) => [t.id, t]));
  const out = new Map<string, DemandInterval[]>();
  for (const a of store.assignments) {
    if (a.units === 0) continue;
    const task = tasks.get(a.taskId);
    if (task === undefined) continue;
    if (!Number.isFinite(task.start) || !Number.isFinite(task.end) || task.start >= task.end) {
      continue;
    }
    const key = String(a.resourceId);
    const list = out.get(key);
    const entry = { start: task.start, end: task.end, units: a.units };
    if (list === undefined) out.set(key, [entry]);
    else list.push(entry);
  }
  return out;
}
