import { Gantt } from "@stargantt/core";
import type { AnyPlugin, GanttInstance } from "@stargantt/core";
import { dataStore } from "@stargantt/plugin-data-store";
import type {
  CalendarDef,
  DataService,
  Link,
  LinkType,
  Patch,
  ReadonlyDataView,
  Task,
  TaskId,
  Transaction,
} from "@stargantt/plugin-data-store";
import { scheduling } from "../src/index";
import type { SchedulingConfig } from "../src/index";

export const DAY = 86_400_000;

/** The core references `HTMLElement` as a type only, so a plain object is enough under node. */
export const fakeRoot = (): HTMLElement => ({}) as unknown as HTMLElement;

/**
 * Boots a store + scheduler pair.
 *
 * **The harness opts propagation in.** Almost every test in this package is *about* propagation,
 * and the library's own default is off (spec §11.2), so omitting `config` here means
 * `{ autoSchedule: { enabled: true } }` rather than the library default. A test that wants the real
 * default passes `{}` explicitly — `propagationEnabled()`'s own tests do, and they are what pin the
 * default.
 */
export function createGantt(
  extra: readonly AnyPlugin[] = [],
  config: SchedulingConfig = { autoSchedule: { enabled: true } },
): GanttInstance {
  return Gantt.create({
    element: fakeRoot(),
    plugins: [dataStore(), scheduling(config), ...extra],
  });
}

export function dataOf(gantt: GanttInstance): DataService {
  return gantt.service("stargantt.data");
}

export function task(id: TaskId, start: number, end: number, over: Partial<Task> = {}): Task {
  return { id, parentId: null, name: `task ${String(id)}`, start, end, ...over };
}

export function link(
  id: string,
  sourceId: TaskId,
  targetId: TaskId,
  type: LinkType = "FS",
  lag?: number,
): Link {
  const l: Link = { id, sourceId, targetId, type };
  if (lag !== undefined) l.lag = lag;
  return l;
}

/**
 * A hand-built `ReadonlyDataView` — the engine's only input (§2), so the engine unit tests never
 * need the store, the core or a DOM.
 */
export function view(
  tasks: readonly Task[],
  links: readonly Link[] = [],
  calendars: readonly CalendarDef[] = [],
): ReadonlyDataView {
  const byId = new Map<TaskId, Task>();
  const children = new Map<TaskId | null, TaskId[]>();
  const linksByTask = new Map<TaskId, { in: Link[]; out: Link[] }>();

  const bucket = (id: TaskId): { in: Link[]; out: Link[] } => {
    let b = linksByTask.get(id);
    if (b === undefined) {
      b = { in: [], out: [] };
      linksByTask.set(id, b);
    }
    return b;
  };

  for (const t of tasks) {
    byId.set(t.id, t);
    const siblings = children.get(t.parentId) ?? [];
    siblings.push(t.id);
    children.set(t.parentId, siblings);
  }
  for (const l of links) {
    bucket(l.sourceId).out.push(l);
    bucket(l.targetId).in.push(l);
  }

  return {
    byId,
    children,
    linksByTask,
    calendars: new Map(calendars.map((c) => [c.id, c] as const)),
    // The engine reads none of the resource model; empty indexes satisfy the view shape.
    resources: new Map(),
    assignmentsByTask: new Map(),
  };
}

/** `{ id: [start, end] }` for every `task/update` patch the engine produced. */
export function moves(patches: readonly Patch[]): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  for (const p of patches) {
    if (p.op !== "task/update") continue;
    out[String(p.id)] = [p.after.start as number, p.after.end as number];
  }
  return out;
}

/** `{ id: [start, end] }` for every task currently in the store. */
export function times(data: DataService): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  for (const t of data.toJSON().tasks) out[String(t.id)] = [t.start, t.end];
  return out;
}

/** Every link currently stored, as an array. */
export function links(data: DataService): readonly Link[] {
  return [...data.links.get().values()];
}

/**
 * Records every settled transaction. The settle signal fires exactly once per APPLIED
 * transaction, carrying its final patch list.
 */
export function recordTransactions(gantt: GanttInstance): Transaction[] {
  const seen: Transaction[] = [];
  gantt.on("data/didApplyTransaction", (e) => seen.push(e.transaction));
  return seen;
}
