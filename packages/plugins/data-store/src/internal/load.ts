/**
 * Bulk load (`DataService.load`), one step per list.
 *
 * Each step normalizes its rows and applies them to an already-cleared store, so the steps read
 * in the order the data depends on: tasks, then links, then resources, then assignments, then
 * calendars, then deferred-children buckets.
 */
import { assignmentKey } from "../fields";
import type { DeferredChildren } from "../deferred";
import type { IdGen } from "../ids";
import {
  isLinkRaw,
  normalizeAssignment,
  normalizeLink,
  normalizeResource,
  normalizeTask,
} from "../mapping";
import { sequenceKey } from "../order-key";
import type { Store } from "../store";
import type { Assignment, CalendarDef, FieldMapping, Link } from "../types";

/** A raw row as `load()` receives it, before a mapping has been applied. */
type RawRow = unknown;

/**
 * Step 1 — tasks. The flat array may carry links inline, which are normalized here (so that ids are
 * minted in the order the rows appear) and returned for step 2 to apply once every task exists.
 */
export function loadTasks(
  store: Store,
  ids: IdGen,
  rows: readonly RawRow[],
  mapping: FieldMapping<unknown> | undefined,
): Link[] {
  const inlineLinks: Link[] = [];
  rows.forEach((item, i) => {
    if (isLinkRaw(item, mapping)) {
      const link = normalizeLink(item, mapping, ids.nextLinkId(store));
      if (link !== undefined) inlineLinks.push(link);
      return;
    }
    const task = normalizeTask(item, mapping, ids.nextTaskId(store), sequenceKey(i));
    // A raw row whose (mapped or generated) id collides with one already loaded is skipped —
    // first row wins, matching `DeferredChildren.materialize`'s treatment: without this guard,
    // `Store#addTask` throws mid-load (after `store.clear()`), leaving the store half-loaded with
    // no way to recover (a duplicate *assignment* row, by contrast, has the last one win — see
    // `loadAssignments`).
    if (store.byId.has(task.id)) return;
    store.applyPatch({ op: "task/add", task });
  });
  return inlineLinks;
}

/**
 * Step 2 — links, the ones found inline among the tasks first and then the dedicated list.
 */
export function loadLinks(
  store: Store,
  ids: IdGen,
  rows: readonly RawRow[],
  mapping: FieldMapping<unknown> | undefined,
  inlineLinks: readonly Link[],
): void {
  const links = [...inlineLinks];
  for (const item of rows) {
    const link = normalizeLink(item, mapping, ids.nextLinkId(store));
    if (link !== undefined) links.push(link);
  }
  for (const link of links) {
    // The load path enforces the same one-link-per-pair invariant `link/add` does, so raw data
    // carrying the same dependency twice (a common export artifact) lands as the one link it
    // describes; the first row of a pair wins.
    if (store.hasLinkBetween(link.sourceId, link.targetId)) continue;
    store.applyPatch({ op: "link/add", link });
  }
}

/** Step 3 — resources. */
export function loadResources(
  store: Store,
  ids: IdGen,
  rows: readonly RawRow[],
  mapping: FieldMapping<unknown> | undefined,
): void {
  for (const item of rows) {
    const resource = normalizeResource(item, mapping, ids.nextResourceId(store));
    // Same duplicate-id guard as `loadTasks` — skip rather than let `Store#addResource` throw
    // mid-load.
    if (store.resources.has(resource.id)) continue;
    store.applyPatch({ op: "resource/add", resource });
  }
}

/**
 * Step 4 — assignments. Duplicate task×resource rows collapse to the last one, and a row whose
 * task or resource was not loaded is dropped, which is what keeps the store's "at most one
 * assignment per pair, both endpoints present" invariant true at the boundary.
 */
export function loadAssignments(
  store: Store,
  rows: readonly RawRow[],
  mapping: FieldMapping<unknown> | undefined,
): void {
  const byPair = new Map<string, Assignment>();
  for (const item of rows) {
    const assignment = normalizeAssignment(item, mapping);
    if (assignment === undefined) continue;
    if (!store.byId.has(assignment.taskId) || !store.hasResource(assignment.resourceId)) continue;
    byPair.set(assignmentKey(assignment.taskId, assignment.resourceId), assignment);
  }
  for (const assignment of byPair.values()) {
    store.applyPatch({ op: "assignment/add", assignment });
  }
}

/** Step 5 — calendars. They are not part of the patch model, so they go straight into the index. */
export function loadCalendars(store: Store, rows: readonly RawRow[]): void {
  for (const item of rows) {
    if (item === null || typeof item !== "object") continue;
    const calendar = item as CalendarDef;
    if (typeof calendar.id !== "string" && typeof calendar.id !== "number") continue;
    store.calendars.set(calendar.id, calendar);
  }
}

/**
 * Step 6 — deferred-children buckets. Nothing is normalized or applied here: the raw rows are
 * parked per parent id for `materializeChildren()` to build later. An entry whose `parentId` is
 * not a string or number, or whose `rows` is not an array, is ignored (the uniform
 * unusable-argument treatment).
 */
export function parkDeferred(deferred: DeferredChildren, entries: readonly unknown[]): void {
  for (const item of entries) {
    if (item === null || typeof item !== "object") continue;
    const { parentId, rows } = item as { parentId?: unknown; rows?: unknown };
    if (typeof parentId !== "string" && typeof parentId !== "number") continue;
    if (!Array.isArray(rows)) continue;
    deferred.add(parentId, rows);
  }
}
