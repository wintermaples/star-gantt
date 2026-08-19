/** A `DataService` double: only the members the row model reads are backed by real data. */
import { mockStore } from "@stargantt/sdk";
import type {
  Assignment,
  CalendarDef,
  CalendarId,
  DataService,
  Link,
  LinkId,
  ReadonlyDataView,
  Resource,
  ResourceId,
  Task,
  TaskId,
} from "@stargantt/plugin-data-store";

export function task(id: TaskId, parentId: TaskId | null, name = String(id)): Task {
  return { id, parentId, name, start: 0, end: 86400000 };
}

export function fakeData(tasks: readonly Task[]): DataService {
  const byId = new Map<TaskId, Task>();
  const children = new Map<TaskId | null, TaskId[]>();
  for (const t of tasks) {
    byId.set(t.id, t);
    const bucket = children.get(t.parentId);
    if (bucket === undefined) children.set(t.parentId, [t.id]);
    else bucket.push(t.id);
  }
  const view: ReadonlyDataView = {
    byId,
    children,
    linksByTask: new Map<TaskId, { in: readonly Link[]; out: readonly Link[] }>(),
    calendars: new Map<CalendarId, CalendarDef>(),
    resources: new Map<ResourceId, Resource>(),
    assignmentsByTask: new Map<TaskId, Assignment[]>(),
  };
  return {
    getTask: (id) => byId.get(id),
    taskIds: () => byId.keys(),
    query: () => view,
    load: () => {
      throw new Error("not used by the row model");
    },
    hasDeferredChildren: () => false,
    materializeChildren: () => {},
    toJSON: () => ({
      tasks: [...byId.values()],
      links: [],
      calendars: [],
      resources: [],
      assignments: [],
    }),
    tasks: mockStore<ReadonlyMap<TaskId, Readonly<Task>>>(byId),
    links: mockStore<ReadonlyMap<LinkId, Readonly<Link>>>(new Map()),
    resources: mockStore<ReadonlyMap<ResourceId, Readonly<Resource>>>(new Map()),
    assignments: mockStore<ReadonlyMap<TaskId, readonly Assignment[]>>(new Map()),
  };
}
