// docs/specs/plugins/interaction.md §4 (capture, paste planning, single-transaction patch lists).
// Pure module — no host, no DOM.
import {
  midKey,
  type Link,
  type LinkType,
  type Patch,
  type ReadonlyDataView,
  type Task,
  type TaskId,
} from "@stargantt/plugin-data-store";
import type { CellFields } from "./tsv";

// §4 — sibling order keys for transaction-appended tasks are minted from the data store's own
// `midKey`, so pasted siblings are value-compatible with the store's `orderKey` reading by
// construction (one implementation, no plugin-side re-derivation of the fraction arithmetic).
/**
 * `count` keys, each strictly between its predecessor and `next`, starting after `prev` — the
 * order keys a multi-task paste hands its consecutive new siblings.
 */
export function keysBetween(prev: string, next: string | undefined, count: number): string[] {
  const keys: string[] = [];
  let lo = prev;
  for (let i = 0; i < count; i++) {
    const key = midKey(lo, next);
    keys.push(key);
    lo = key;
  }
  return keys;
}

/** The copied fields of one captured task (identity and order stripped — both are re-minted). */
export interface CapturedFields
  extends CellFields,
    Pick<Task, "type" | "constraint" | "calendarId" | "meta"> {
  name: string;
  start: number;
  end: number;
}

/** One captured task; `parent` is a pre-order index into the same list, `null` = top level. */
export interface CapturedTask {
  parent: number | null;
  fields: CapturedFields;
}

/** A captured link; both endpoints are pre-order indexes into `tasks`. */
export interface CapturedLink {
  source: number;
  target: number;
  type: LinkType;
  lag?: number;
}

/** The structured clipboard payload — plugin-local, never serialized. */
export interface ClipboardPayload {
  tasks: CapturedTask[];
  links: CapturedLink[];
  /**
   * The **source** ids of the captured top-level tasks, in capture order. Only meaningful against
   * the store the capture was taken from — `duplicate()` uses the last of them as its paste anchor;
   * a paste never reuses them.
   */
  rootIds: TaskId[];
}

function capturedFields(task: Readonly<Task>): CapturedFields {
  const fields: CapturedFields = { name: task.name, start: task.start, end: task.end };
  if (task.progress !== undefined) fields.progress = task.progress;
  if (task.type !== undefined) fields.type = task.type;
  if (task.constraint !== undefined) fields.constraint = { ...task.constraint };
  if (task.calendarId !== undefined) fields.calendarId = task.calendarId;
  if (task.meta !== undefined) fields.meta = { ...task.meta };
  return fields;
}

/**
 * Captures `ids` (deduplicated; a selected descendant of a selected ancestor is captured once)
 * with their whole subtrees, in pre-order, plus every link both of whose endpoints are captured.
 * Returns `undefined` when nothing usable was named.
 */
export function capture(ids: readonly TaskId[], view: ReadonlyDataView): ClipboardPayload | undefined {
  const wanted = new Set<TaskId>();
  for (const id of ids) if (view.byId.has(id)) wanted.add(id);

  // Top-level roots: wanted ids with no wanted ancestor.
  const roots: TaskId[] = [];
  for (const id of wanted) {
    let ancestor = view.byId.get(id)?.parentId ?? null;
    let covered = false;
    while (ancestor !== null) {
      if (wanted.has(ancestor)) {
        covered = true;
        break;
      }
      ancestor = view.byId.get(ancestor)?.parentId ?? null;
    }
    if (!covered) roots.push(id);
  }
  if (roots.length === 0) return undefined;

  const tasks: CapturedTask[] = [];
  const indexOf = new Map<TaskId, number>();
  const walk = (id: TaskId, parent: number | null): void => {
    const task = view.byId.get(id);
    if (task === undefined) return;
    const index = tasks.length;
    indexOf.set(id, index);
    tasks.push({ parent, fields: capturedFields(task) });
    for (const child of view.children.get(id) ?? []) walk(child, index);
  };
  for (const root of roots) walk(root, null);

  // Links wholly inside the captured set, each collected once from its source's outgoing bucket.
  const links: CapturedLink[] = [];
  for (const [taskId, bucket] of view.linksByTask) {
    const source = indexOf.get(taskId);
    if (source === undefined) continue;
    for (const link of bucket.out) {
      const target = indexOf.get(link.targetId);
      if (target === undefined) continue;
      const captured: CapturedLink = { source, target, type: link.type };
      if (link.lag !== undefined) captured.lag = link.lag;
      links.push(captured);
    }
  }
  return { tasks, links, rootIds: roots };
}

/** The rows the cell text serializes: the captured tasks in pre-order. */
export function payloadRows(payload: ClipboardPayload): readonly CellFields[] {
  return payload.tasks.map((t) => t.fields);
}

/** Mints ids of the form `<prefix><n>` skipped past everything in `used`. */
export function idMinter(prefix: string, used: ReadonlySet<TaskId>): () => string {
  let n = 0;
  return () => {
    for (;;) {
      const id = `${prefix}${++n}`;
      if (!used.has(id)) return id;
    }
  };
}

/** Every link id currently in the store — the collision set for minting fresh link ids. */
export function existingLinkIds(view: ReadonlyDataView): Set<TaskId> {
  const ids = new Set<TaskId>();
  for (const bucket of view.linksByTask.values()) {
    for (const link of bucket.out) ids.add(link.id);
  }
  return ids;
}

/** What a paste or cell paste hands back to the wiring layer. */
export interface PastePlan {
  /**
   * The one public command that opens the transaction: a `task/add` payload for the plan's first
   * created task, or a `task/update` payload for the first changed row of a cell paste.
   */
  first:
    | { command: "task/add"; task: Partial<Task> & { name: string }; index: number }
    | { command: "task/update"; id: TaskId; after: Partial<Task> };
  /** Appended to the same transaction by the `data/willApplyTransaction` handler. */
  rest: Patch[];
  /** Fresh ids of the created top-level tasks, in paste order (selection follows them). */
  newTopIds: TaskId[];
  /** How many tasks the plan creates or updates — the announcement count. */
  count: number;
}

/** Where a structured paste inserts: a sibling list and a position inside it. */
export interface PasteTarget {
  parentId: TaskId | null;
  index: number;
}

/**
 * Plans a structured paste of `payload` at `target`: fresh task ids, rewritten parent references,
 * order keys strictly between the target's neighbouring siblings, and links re-created under fresh
 * ids with both endpoints remapped.
 */
export function planStructuredPaste(
  payload: ClipboardPayload,
  view: ReadonlyDataView,
  target: PasteTarget,
): PastePlan | undefined {
  if (payload.tasks.length === 0) return undefined;
  const mintTask = idMinter("c", new Set(view.byId.keys()));
  const mintLink = idMinter("cl", existingLinkIds(view));

  const siblings = view.children.get(target.parentId) ?? [];
  const at = Math.min(Math.max(target.index, 0), siblings.length);
  const prevId = at > 0 ? siblings[at - 1] : undefined;
  const nextId = at < siblings.length ? siblings[at] : undefined;
  const prevKey = prevId === undefined ? "" : (view.byId.get(prevId)?.orderKey ?? "");
  const nextKey = nextId === undefined ? undefined : view.byId.get(nextId)?.orderKey;

  const topCount = payload.tasks.filter((t) => t.parent === null).length;
  const topKeys = keysBetween(prevKey, nextKey, topCount);

  // Children of a freshly created parent have only each other as siblings; a plain increasing run
  // of keys under that parent is enough.
  const childCounter = new Map<number, number>();
  const childKeys = new Map<number, string[]>();
  payload.tasks.forEach((t) => {
    if (t.parent !== null) childCounter.set(t.parent, (childCounter.get(t.parent) ?? 0) + 1);
  });
  for (const [parent, count] of childCounter) childKeys.set(parent, keysBetween("", undefined, count));

  const newIds: TaskId[] = [];
  const newTopIds: TaskId[] = [];
  const tasks: Task[] = [];
  let topSeen = 0;
  const childSeen = new Map<number, number>();
  payload.tasks.forEach((captured) => {
    const id = mintTask();
    newIds.push(id);
    let parentId: TaskId | null;
    let orderKey: string;
    if (captured.parent === null) {
      parentId = target.parentId;
      orderKey = topKeys[topSeen++] ?? "";
      newTopIds.push(id);
    } else {
      parentId = newIds[captured.parent] ?? null;
      const seen = childSeen.get(captured.parent) ?? 0;
      childSeen.set(captured.parent, seen + 1);
      orderKey = childKeys.get(captured.parent)?.[seen] ?? "";
    }
    tasks.push({ ...captured.fields, id, parentId, orderKey });
  });

  const rest: Patch[] = tasks.slice(1).map((task) => ({ op: "task/add", task }));
  for (const link of payload.links) {
    const sourceId = newIds[link.source];
    const targetId = newIds[link.target];
    if (sourceId === undefined || targetId === undefined) continue;
    const created: Link = { id: mintLink(), sourceId, targetId, type: link.type };
    if (link.lag !== undefined) created.lag = link.lag;
    rest.push({ op: "link/add", link: created });
  }

  const firstTask = tasks[0];
  if (firstTask === undefined) return undefined;
  return {
    first: { command: "task/add", task: firstTask, index: at },
    rest,
    newTopIds,
    count: tasks.length,
  };
}

/** The `Task` fields a parsed TSV row usably expresses (shared by updates and creations). */
function asTaskFields(fields: CellFields): Partial<Task> {
  const out: Partial<Task> = {};
  if (fields.name !== undefined) out.name = fields.name;
  if (fields.start !== undefined) out.start = fields.start;
  if (fields.end !== undefined) out.end = fields.end;
  if (fields.progress !== undefined) out.progress = fields.progress;
  return out;
}

/** The subset of `fields` that differs from `task`'s current values, with its `before` image. */
function diffFields(
  task: Readonly<Task>,
  fields: CellFields,
): { before: Partial<Task>; after: Partial<Task> } | undefined {
  const after: Partial<Task> = {};
  const before: Partial<Task> = {};
  const consider = <K extends "name" | "start" | "end" | "progress">(key: K): void => {
    const next = fields[key];
    if (next === undefined || next === task[key]) return;
    after[key] = next as Task[K];
    const current = task[key];
    if (current !== undefined) before[key] = current;
  };
  consider("name");
  consider("start");
  consider("end");
  consider("progress");
  return Object.keys(after).length > 0 ? { before, after } : undefined;
}

/**
 * Plans a cell paste: `rows` are applied to `targets` (the visible rows from the anchor downward)
 * one to one; rows that outrun the targets create new root tasks appended at the end. Returns
 * `undefined` when nothing would change.
 */
export function planCellPaste(
  rows: readonly CellFields[],
  targets: readonly Readonly<Task>[],
  view: ReadonlyDataView,
): PastePlan | undefined {
  const updates: Patch[] = [];
  const firstAfter: { id: TaskId; after: Partial<Task> }[] = [];
  rows.slice(0, targets.length).forEach((fields, i) => {
    const task = targets[i];
    if (task === undefined) return;
    const diff = diffFields(task, fields);
    if (diff === undefined) return;
    firstAfter.push({ id: task.id, after: diff.after });
    updates.push({ op: "task/update", id: task.id, before: diff.before, after: diff.after });
  });

  // Rows past the targets create new tasks — except field-less rows (blank spreadsheet lines),
  // which express nothing and must not become empty root tasks.
  const overflow = rows.slice(targets.length).filter((fields) => Object.keys(fields).length > 0);
  const mintTask = idMinter("c", new Set(view.byId.keys()));
  const rootIds = view.children.get(null) ?? [];
  const lastRoot = rootIds.length > 0 ? rootIds[rootIds.length - 1] : undefined;
  const lastKey = lastRoot === undefined ? "" : (view.byId.get(lastRoot)?.orderKey ?? "");
  const keys = keysBetween(lastKey, undefined, overflow.length);
  const created: Task[] = overflow.map((fields, i) => {
    const start = fields.start ?? 0;
    return {
      ...asTaskFields(fields),
      id: mintTask(),
      parentId: null,
      name: fields.name ?? "",
      start,
      end: fields.end ?? start,
      orderKey: keys[i] ?? "",
    };
  });

  const count = updates.length + created.length;
  if (count === 0) return undefined;

  const newTopIds = created.map((t) => t.id);
  if (updates.length > 0) {
    const carrier = firstAfter[0];
    const rest = [...updates.slice(1), ...created.map((task): Patch => ({ op: "task/add", task }))];
    if (carrier === undefined) return undefined;
    return { first: { command: "task/update", id: carrier.id, after: carrier.after }, rest, newTopIds, count };
  }
  const firstTask = created[0];
  if (firstTask === undefined) return undefined;
  return {
    first: { command: "task/add", task: firstTask, index: rootIds.length },
    rest: created.slice(1).map((task): Patch => ({ op: "task/add", task })),
    newTopIds,
    count,
  };
}
