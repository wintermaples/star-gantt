/**
 * Hostless doubles for the filter feature's own tests (`test/filter*.test.ts`).
 *
 * Companion to `test/_fakes.ts` (read-only, shared across the package): these are filter-specific
 * and live here instead, matching the filter feature's file scope.
 */
import type { Assignment, ReadonlyDataView, Resource, Task, TaskId } from "@stargantt/plugin-data-store";

/** One task, with the two required dates defaulted so a test states only what it cares about. */
export function filterTask(over: Partial<Task> & { id: TaskId }): Task {
  return {
    parentId: null,
    name: `task-${String(over.id)}`,
    start: 0,
    end: 86_400_000,
    ...over,
  };
}

export interface FilterViewInput {
  tasks: readonly Task[];
  resources?: readonly Resource[];
  assignments?: readonly Assignment[];
}

/** A minimal `ReadonlyDataView` double: only the members `FilterModel` / `SearchIndex` read. */
export function filterDataView(input: FilterViewInput): ReadonlyDataView {
  const byId = new Map<TaskId, Readonly<Task>>(input.tasks.map((t) => [t.id, t]));
  const assignmentsByTask = new Map<TaskId, Assignment[]>();
  for (const a of input.assignments ?? []) {
    const list = assignmentsByTask.get(a.taskId) ?? [];
    list.push(a);
    assignmentsByTask.set(a.taskId, list);
  }
  return {
    byId,
    children: new Map(),
    linksByTask: new Map(),
    calendars: new Map(),
    resources: new Map((input.resources ?? []).map((r) => [r.id, r])),
    assignmentsByTask,
  };
}

const DAY = 86_400_000;

/**
 * Six tasks over two roots: a small tree with resources and tags to search over.
 */
export function filterSampleData(): FilterViewInput {
  const t = (
    id: string,
    parentId: string | null,
    name: string,
    day: number,
    days: number,
    extra: Partial<Task> = {},
  ): Task => ({ id, parentId, name, start: day * DAY, end: (day + days) * DAY, ...extra });
  return {
    tasks: [
      t("a", null, "Design phase", 0, 10, { type: "summary" }),
      t("a1", "a", "Wireframes", 0, 3, { progress: 1, meta: { tags: ["ux"] } }),
      t("a2", "a", "Visual design", 3, 5, { progress: 0.4 }),
      t("b", null, "Build phase", 10, 20, { type: "summary" }),
      t("b1", "b", "API server", 10, 8, { progress: 0.1 }),
      t("b2", "b", "Web client", 14, 10, { meta: { tags: ["ux", "frontend"] } }),
    ],
    resources: [
      { id: "r1", name: "Alice" },
      { id: "r2", name: "Bob" },
    ],
    assignments: [
      { taskId: "a1", resourceId: "r1", units: 1 },
      { taskId: "b1", resourceId: "r2", units: 1 },
      { taskId: "b2", resourceId: "r1", units: 0.5 },
    ],
  };
}
