// docs/specs/plugins/resource.md §3.4 — the resource-view row model.
/**
 * The resource-axis row model: pure computation, no DOM, no host, no plugin context.
 *
 * Rebuilds the chart's data along the resource axis — one row per resource, each row holding the
 * time segments of the tasks assigned to that resource — and derives, per row, the peak concurrent
 * allocation and the overallocation windows (where the sum of concurrent assignment units exceeds
 * the row's capacity), and, per team, the aggregate capacity / peak / free numbers the strip's
 * team bands show.
 *
 * Adapted from the earlier implementation's resource-view row model, with two adjustments:
 *
 * - team normalization is gone: `config.ts`'s `resourceViewTeams` already dropped unusable
 *   entries and normalized `members` to an array, so this module only has to key the member ids
 *   (`String(id)`, the plugin-wide cross-store id rule) and drop within-team duplicates;
 * - the task and assignment inputs are the data store's own indexes (`query().byId` /
 *   `query().assignmentsByTask`) rather than flat arrays, so a repaint never materializes two
 *   copies of the store at 10k rows.
 */
import type { Assignment, ResourceId, Task, TaskId } from "@stargantt/plugin-data-store";
import type { ResourceViewTeam } from "../../config";

/** One task assignment placed on a resource row: a horizontal segment in time. */
export interface RvSegment {
  taskId: TaskId;
  taskName: string;
  /** Epoch ms UTC, inclusive. */
  start: number;
  /** Epoch ms UTC, exclusive. */
  end: number;
  /** Allocation rate; 1 = full-time. */
  units: number;
  /** Project attribution, or `null` when the task carries none. */
  project: string | null;
  /** Whether the segment intersects one of its row's overallocation windows. */
  over: boolean;
}

/** A half-open time window during which a row's concurrent load exceeds its capacity. */
export interface RvWindow {
  start: number;
  end: number;
}

/** One resource row of the strip. */
export interface RvRow {
  resourceId: ResourceId;
  name: string;
  capacity: number;
  /** Largest concurrent sum of assignment units anywhere on the row. */
  peak: number;
  /** `peak > capacity` (within the sweep's float tolerance). */
  over: boolean;
  segments: RvSegment[];
  overWindows: RvWindow[];
}

/** One group of rows: a configured team, or the single anonymous group of an ungrouped strip. */
export interface RvGroup {
  /** Team name; `null` for the single anonymous group (no team band is painted for it). */
  name: string | null;
  rows: RvRow[];
  /** Sum of member capacities. */
  capacity: number;
  /** Largest concurrent sum of member assignment units. */
  peak: number;
  /** `capacity - peak` (negative when the team as a whole is overbooked). */
  free: number;
  /** Number of member rows whose own peak exceeds their own capacity. */
  overloadedMembers: number;
}

/** One entry of the resource universe the rows are built over. */
export interface RvResourceInput {
  id: ResourceId;
  name: string;
  capacity: number;
}

/** Everything one model build reads. */
export interface RvModelInput {
  /** The store's task index (`query().byId`). */
  tasks: ReadonlyMap<TaskId, Readonly<Task>>;
  /** The store's assignment index (`query().assignmentsByTask`). */
  assignmentsByTask: ReadonlyMap<TaskId, readonly Assignment[]>;
  /** The rows' resource universe, in display order (see {@link buildUniverse}). */
  resources: readonly RvResourceInput[];
  /** The resolved `view.teams`; empty = one anonymous group. */
  teams: readonly ResourceViewTeam[];
  /** Label of the trailing group collecting resources no team claims (used only with teams). */
  ungroupedName: string;
  /** Project attribution of a task — already barrier-wrapped by the caller. */
  projectOf(task: Readonly<Task>): string | null;
}

/**
 * A capacity is usable only when it is a **finite** positive number: `Infinity` would make a
 * team's `free` `-Infinity`, and 0 or a negative rate is not an availability.
 */
export function usableCapacity(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * The row universe: pool entries first, in pool order, then the resources only the data store
 * knows (§3.4, "the internalized choice universe") — the earlier `resource-assign` `choices()`
 * order, internalized here now that the two former plugins are one.
 *
 * Deduped by the string form of the id, so a pool entry with the numeric id `1` and a store
 * resource whose loader typed the same id as `"1"` are one row, not two.
 *
 * Capacity resolves store-entry → pool-entry → 1: a resource the store holds takes the store's
 * rate (or 1 when it carries none), and only a pool-only resource falls back to the pool's.
 */
export function buildUniverse(
  poolEntries: readonly { id: ResourceId; name: string; capacity?: number }[],
  storeResources: ReadonlyMap<ResourceId, Readonly<{ id: ResourceId; name: string; capacity?: number }>>,
): Map<string, RvResourceInput> {
  // The store's own rates, keyed by string form so a differently typed id still matches.
  const stored = new Map<string, number>();
  for (const resource of storeResources.values()) {
    stored.set(String(resource.id), usableCapacity(resource.capacity) ?? 1);
  }
  const universe = new Map<string, RvResourceInput>();
  for (const entry of poolEntries) {
    const key = String(entry.id);
    if (universe.has(key)) continue;
    universe.set(key, {
      id: entry.id,
      name: entry.name,
      capacity: stored.get(key) ?? usableCapacity(entry.capacity) ?? 1,
    });
  }
  for (const resource of storeResources.values()) {
    const key = String(resource.id);
    if (universe.has(key)) continue;
    universe.set(key, { id: resource.id, name: resource.name, capacity: stored.get(key) ?? 1 });
  }
  return universe;
}

interface SweepEvent {
  t: number;
  delta: number;
}

/**
 * Sweeps segment boundaries and returns the peak concurrent units plus the over-capacity windows.
 *
 * Events sort by `(t, delta)`, so at an instant where one task ends and another starts the ending
 * `-units` is applied first: a hand-off is not an overallocation.
 */
export function sweep(
  segments: readonly { start: number; end: number; units: number }[],
  capacity: number,
): { peak: number; overWindows: RvWindow[] } {
  const events: SweepEvent[] = [];
  for (const s of segments) {
    events.push({ t: s.start, delta: s.units });
    events.push({ t: s.end, delta: -s.units });
  }
  events.sort((a, b) => a.t - b.t || a.delta - b.delta);
  let sum = 0;
  let peak = 0;
  const overWindows: RvWindow[] = [];
  let overStart: number | null = null;
  let i = 0;
  while (i < events.length) {
    const t = (events[i] as SweepEvent).t;
    while (i < events.length && (events[i] as SweepEvent).t === t) {
      sum += (events[i] as SweepEvent).delta;
      i += 1;
    }
    if (sum > peak) peak = sum;
    // Tolerance guards float drift from summed fractional units (0.3 + 0.3 + 0.4 > 1).
    const over = sum > capacity + OVER_EPSILON;
    if (over && overStart === null) overStart = t;
    if (!over && overStart !== null) {
      overWindows.push({ start: overStart, end: t });
      overStart = null;
    }
  }
  return { peak, overWindows };
}

/** The float tolerance every over-capacity comparison in this model uses. */
export const OVER_EPSILON = 1e-9;

function intersects(s: { start: number; end: number }, windows: readonly RvWindow[]): boolean {
  for (const w of windows) if (s.start < w.end && s.end > w.start) return true;
  return false;
}

/**
 * The member ids of one configured team, as string keys, in order and without duplicates. The
 * team's own name is trimmed (`config.ts` keeps the raw string; the earlier implementation
 * displayed the trimmed one).
 */
function teamKeys(team: ResourceViewTeam): string[] {
  const out: string[] = [];
  for (const member of team.members ?? []) {
    if (typeof member !== "string" && typeof member !== "number") continue;
    const key = String(member);
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/** Builds the grouped row model. Pure: same input, same output. */
export function buildModel(input: RvModelInput): RvGroup[] {
  /* --- segments, per resource ---------------------------------------- */
  const segmentsByResource = new Map<string, RvSegment[]>();
  for (const [taskId, assignments] of input.assignmentsByTask) {
    const task = input.tasks.get(taskId);
    if (task === undefined) continue;
    // A milestone (or any non-positive-duration task) has no horizontal extent on a resource row.
    if (!(task.end > task.start)) continue;
    const project = input.projectOf(task);
    for (const assignment of assignments) {
      const key = String(assignment.resourceId);
      let list = segmentsByResource.get(key);
      if (list === undefined) {
        list = [];
        segmentsByResource.set(key, list);
      }
      list.push({
        taskId: task.id,
        taskName: task.name,
        start: task.start,
        end: task.end,
        units: assignment.units,
        project,
        over: false,
      });
    }
  }

  /* --- rows ------------------------------------------------------------ */
  const rowByKey = new Map<string, RvRow>();
  const orderedKeys: string[] = [];
  for (const resource of input.resources) {
    const key = String(resource.id);
    if (rowByKey.has(key)) continue;
    const segments = segmentsByResource.get(key) ?? [];
    // Start-sorted, which is what the panel's horizontal cull binary-searches over.
    segments.sort((a, b) => a.start - b.start || a.end - b.end);
    const { peak, overWindows } = sweep(segments, resource.capacity);
    for (const segment of segments) segment.over = intersects(segment, overWindows);
    rowByKey.set(key, {
      resourceId: resource.id,
      name: resource.name,
      capacity: resource.capacity,
      peak,
      over: peak > resource.capacity + OVER_EPSILON,
      segments,
      overWindows,
    });
    orderedKeys.push(key);
  }

  /* --- groups ---------------------------------------------------------- */
  function finishGroup(name: string | null, rows: RvRow[]): RvGroup {
    let capacity = 0;
    let overloadedMembers = 0;
    const allSegments: RvSegment[] = [];
    for (const row of rows) {
      capacity += row.capacity;
      if (row.over) overloadedMembers += 1;
      // A plain loop, never `push(...row.segments)`: spreading passes every segment as a call
      // argument, and a row with ~100k segments overflows the engine's argument limit
      // (RangeError) long before the model itself is too big to build.
      for (const segment of row.segments) allSegments.push(segment);
    }
    // Capacity `Infinity`: a team band reports the peak, never an over/under window of its own.
    const { peak } = sweep(allSegments, Number.POSITIVE_INFINITY);
    return { name, rows, capacity, peak, free: capacity - peak, overloadedMembers };
  }

  if (input.teams.length === 0) {
    // No teams configured: one anonymous group and no team band at all (the established rule —
    // the `ungroupedTeam` label names the leftovers *beside* configured teams, not a whole strip
    // nobody grouped).
    return [finishGroup(null, orderedKeys.map((key) => rowByKey.get(key) as RvRow))];
  }

  const claimed = new Set<string>();
  const groups: RvGroup[] = [];
  for (const team of input.teams) {
    const rows: RvRow[] = [];
    for (const key of teamKeys(team)) {
      // The first-listed team claims a resource two teams both name.
      if (claimed.has(key)) continue;
      const row = rowByKey.get(key);
      if (row === undefined) continue;
      claimed.add(key);
      rows.push(row);
    }
    // A usable name with no (or no known) members renders an empty group, aggregates all zero.
    groups.push(finishGroup(typeof team.name === "string" ? team.name.trim() : "", rows));
  }
  const rest: RvRow[] = [];
  for (const key of orderedKeys) if (!claimed.has(key)) rest.push(rowByKey.get(key) as RvRow);
  if (rest.length > 0) groups.push(finishGroup(input.ungroupedName, rest));
  return groups;
}

/**
 * The single row a task's segments all sit on, as a string key, or `undefined` when the task is on
 * none or on more than one (the `laneOfTask` rule of §3.4).
 *
 * O(segments) over the whole model: a per-drag lookup, never a per-pointermove one — that is
 * `laneAt`'s job.
 */
export function rowKeyOfTask(groups: readonly RvGroup[], taskId: TaskId): string | undefined {
  const wanted = String(taskId);
  let found: string | undefined;
  for (const group of groups) {
    for (const row of group.rows) {
      if (!row.segments.some((segment) => String(segment.taskId) === wanted)) continue;
      if (found !== undefined) return undefined;
      found = String(row.resourceId);
    }
  }
  return found;
}
