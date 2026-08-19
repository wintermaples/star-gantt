import { Gantt } from "@stargantt/core";
import type { AnyPlugin, GanttInstance } from "@stargantt/core";
import { dataStore } from "../src/index";
import { Store } from "../src/store";
import type { DataService, Link, Task, TaskId } from "../src/types";

/**
 * A detached root element for `Gantt.create()`.
 *
 * The data store touches no DOM, so this is only ever a handle the core holds — a plain object
 * stands in under vitest's default `node` environment, the same convention `@stargantt/core`'s
 * own tests use.
 */
export const fakeRoot = (): HTMLElement => ({}) as unknown as HTMLElement;

export function createGantt(extra: readonly AnyPlugin[] = []): GanttInstance {
  return Gantt.create({ element: fakeRoot(), plugins: [dataStore(), ...extra] });
}

export function dataOf(gantt: GanttInstance): DataService {
  return gantt.service("stargantt.data");
}

export function makeTask(id: TaskId, over: Partial<Task> = {}): Task {
  return { id, parentId: null, name: `task ${String(id)}`, start: 0, end: 10, ...over };
}

export function makeLink(id: string, sourceId: TaskId, targetId: TaskId): Link {
  return { id, sourceId, targetId, type: "FS" };
}

/**
 * Every index the store maintains, as one comparable string: tasks, links, sibling arrays,
 * resources, assignments (including the *keys* of `assignmentsByTask`, so a bucket left behind
 * empty by a faulty rollback shows up) and calendars.
 *
 * Order-insensitive over the by-id maps, order-**sensitive** over the sibling arrays — sibling order
 * is the one ordering a patch is required to restore exactly (`orderKey`), while insertion order of
 * resources and assignments is not a documented invariant.
 */
export function snapshot(store: Store): string {
  const byName = (a: { id: unknown }, b: { id: unknown }): number =>
    String(a.id) < String(b.id) ? -1 : 1;
  const byKey = (a: readonly [string, unknown], b: readonly [string, unknown]): number =>
    a[0] < b[0] ? -1 : 1;
  return JSON.stringify({
    tasks: [...store.byId.values()].sort(byName),
    links: [...store.links()].sort(byName),
    children: [...store.children.entries()]
      .map(([k, v]) => [String(k), v.map(String)] as const)
      .sort(byKey),
    resources: [...store.resources.values()].sort(byName),
    assignments: [...store.assignmentsByTask.entries()]
      .map(
        ([taskId, list]) =>
          [
            String(taskId),
            [...list].sort((a, b) => (String(a.resourceId) < String(b.resourceId) ? -1 : 1)),
          ] as const,
      )
      .sort(byKey),
    calendars: [...store.calendars.values()].sort(byName),
  });
}

export function newStore(tasks: readonly Task[] = [], links: readonly Link[] = []): Store {
  const store = new Store();
  for (const task of tasks) store.applyPatch({ op: "task/add", task });
  for (const link of links) store.applyPatch({ op: "link/add", link });
  return store;
}

/**
 * The ids present in `next` but not in `prev` — the "added" half of the diff a store subscriber
 * does itself (docs/specs/plugins/data-store.md — Change classification: the store carries no
 * added/removed/updated shape of its own).
 */
export function addedIds<K>(next: ReadonlyMap<K, unknown>, prev: ReadonlyMap<K, unknown>): K[] {
  return [...next.keys()].filter((k) => !prev.has(k));
}

/** The ids present in `prev` but not in `next` — the "removed" half of the diff. */
export function removedIds<K>(next: ReadonlyMap<K, unknown>, prev: ReadonlyMap<K, unknown>): K[] {
  return [...prev.keys()].filter((k) => !next.has(k));
}
