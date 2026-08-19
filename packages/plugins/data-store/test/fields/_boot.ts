/** Shared boot helper for the `stargantt.fields` (custom-fields) test files. */
import { Gantt } from "@stargantt/core";
import type { AnyPlugin, GanttInstance } from "@stargantt/core";
import { dataStore } from "../../src/index";
import type { CustomFieldDef, DataService, FieldsService, Task } from "../../src/index";

export interface Booted {
  gantt: GanttInstance;
  data: DataService;
  service: FieldsService;
}

/** Boots the data-store plugin (with its `customFields` config nest) and loads `tasks`. */
export function boot(
  fields: readonly CustomFieldDef[] = [],
  tasks: Task[] = [],
  extra: AnyPlugin[] = [],
): Booted {
  const gantt = Gantt.create({
    element: {} as unknown as HTMLElement,
    plugins: [dataStore({ customFields: { fields } }), ...extra],
  });
  const data = gantt.service("stargantt.data");
  if (tasks.length > 0) data.load(tasks);
  return { gantt, data, service: gantt.service("stargantt.fields") };
}

/** One plain one-day task at the epoch. */
export function task(id: string, overrides: Partial<Task> = {}): Task {
  return { id, parentId: null, name: id, start: 0, end: 86_400_000, ...overrides };
}

/** Counts every transaction applied so far (one `data/willApplyTransaction` firing each). */
export function countTransactions(gantt: GanttInstance): { count(): number } {
  let n = 0;
  gantt.on("data/willApplyTransaction", () => void n++);
  return { count: () => n };
}
