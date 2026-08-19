/**
 * Shared fixtures for the load-chart area's suites (docs/specs/plugins/resource.md §3.6).
 *
 * The area's modules are pure and hostless, so every suite drives them off a plain
 * `ReadonlyDataView` built here rather than off a booted chart.
 */
import type {
  Assignment,
  CalendarDef,
  CalendarId,
  Link,
  ReadonlyDataView,
  Resource,
  ResourceId,
  Task,
  TaskId,
} from "@stargantt/plugin-data-store";

export const MS_DAY = 86_400_000;

/** Monday 2024-01-01 00:00 UTC. */
export const MONDAY = Date.UTC(2024, 0, 1);

export interface StoreSeed {
  tasks?: readonly Partial<Task>[];
  resources?: readonly Resource[];
  assignments?: readonly Assignment[];
}

/** Builds a minimal `ReadonlyDataView` over the seed — only the members the area reads are real. */
export function dataView(seed: StoreSeed): ReadonlyDataView {
  const byId = new Map<TaskId, Readonly<Task>>();
  for (const [index, partial] of (seed.tasks ?? []).entries()) {
    const task: Task = {
      id: partial.id ?? `t${String(index + 1)}`,
      parentId: partial.parentId ?? null,
      name: partial.name ?? `Task ${String(index + 1)}`,
      start: partial.start ?? 0,
      end: partial.end ?? 0,
      ...(partial.type === undefined ? {} : { type: partial.type }),
    };
    byId.set(task.id, task);
  }

  const resources = new Map<ResourceId, Readonly<Resource>>();
  for (const resource of seed.resources ?? []) resources.set(resource.id, resource);

  const assignmentsByTask = new Map<TaskId, readonly Assignment[]>();
  for (const assignment of seed.assignments ?? []) {
    const list = assignmentsByTask.get(assignment.taskId);
    if (list === undefined) assignmentsByTask.set(assignment.taskId, [assignment]);
    else assignmentsByTask.set(assignment.taskId, [...list, assignment]);
  }

  return {
    byId,
    children: new Map<TaskId | null, readonly TaskId[]>(),
    linksByTask: new Map<TaskId, { readonly in: readonly Link[]; readonly out: readonly Link[] }>(),
    calendars: new Map<CalendarId, Readonly<CalendarDef>>(),
    resources,
    assignmentsByTask,
  };
}

/** A fixed-width text measurer, so label-fit assertions do not depend on a real canvas. */
export function measureAt(pxPerChar: number): (text: string) => number {
  return (text) => text.length * pxPerChar;
}
