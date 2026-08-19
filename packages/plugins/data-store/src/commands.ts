import type { Commands } from "@stargantt/core";
import { REQUIRED_TASK_FIELDS, asRecord, splitUpdate } from "./fields";
import type { IdGen } from "./ids";
import { clamp01 } from "./mapping";
import { midKey } from "./order-key";
import type { Store } from "./store";
import type { Assignment, Link, LinkId, Patch, Resource, ResourceId, Task, TaskId } from "./types";

/**
 * Walks `ids`, deduplicating and dropping ids that name nothing per `lookup`, yielding the
 * distinct existing entities in first-seen order.
 *
 * The dedupe-then-skip-unknown shape shows up identically in every builder that removes several
 * entities by id (`buildResourceRemove`, `buildLinkRemove`); this is the one place it is written.
 */
function distinctExisting<TId, TEntity>(
  ids: readonly TId[],
  lookup: (id: TId) => TEntity | undefined,
): TEntity[] {
  const seen = new Set<TId>();
  const found: TEntity[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    const entity = lookup(id);
    if (entity === undefined) continue;
    seen.add(id);
    found.push(entity);
  }
  return found;
}

// docs/specs/plugins/data-store.md — Apply flow: "the command runner reads the current state and
// builds the patch list (not yet applied)".
/**
 * Patch-list builders for the `task/*` and `link/*` commands.
 *
 * Each builder reads the current store state and returns the patches the command implies — that
 * step and nothing else: pure, no store mutation, no events.
 *
 * A builder returns an empty list when the command has nothing to change (e.g. an unknown task id);
 * the caller then produces no transaction at all.
 */

export function buildTaskMove(store: Store, p: Commands["task/move"]): Patch[] {
  const task = store.byId.get(p.id);
  if (!task) return [];
  return [
    {
      op: "task/update",
      id: p.id,
      before: { start: task.start, end: task.end },
      after: { start: p.start, end: p.end },
    },
  ];
}

export function buildTaskSetProgress(store: Store, p: Commands["task/setProgress"]): Patch[] {
  const task = store.byId.get(p.id);
  if (!task) return [];
  // `progress` is optional: when the task has none, `before` omits the key so that undoing the
  // change removes the field again (see `Store#updateTask` and `fields.ts#mergeUpdate`).
  const before: Partial<Task> = task.progress === undefined ? {} : { progress: task.progress };
  return [{ op: "task/update", id: p.id, before, after: { progress: clamp01(p.progress) } }];
}

// docs/specs/plugins/data-store.md — Commands (`task/add`): an explicit id already in the store is
// a silent no-op, uniform with `link/add` and `resource/add`'s treatment of the same unusable
// argument.
export function buildTaskAdd(store: Store, p: Commands["task/add"], ids: IdGen): Patch[] {
  if (p.task.id !== undefined && store.byId.has(p.task.id)) return [];
  const parentId = p.task.parentId ?? null;
  const siblings = store.children.get(parentId) ?? [];
  const at = Math.min(Math.max(p.index ?? siblings.length, 0), siblings.length);

  const prevId = at > 0 ? siblings[at - 1] : undefined;
  const nextId = at < siblings.length ? siblings[at] : undefined;
  const prevKey = prevId === undefined ? "" : (store.byId.get(prevId)?.orderKey ?? "");
  const nextKey = nextId === undefined ? undefined : store.byId.get(nextId)?.orderKey;

  const start = p.task.start ?? 0;
  const task: Task = {
    ...p.task,
    id: p.task.id ?? ids.nextTaskId(store),
    parentId,
    name: p.task.name,
    start,
    end: p.task.end ?? start,
    orderKey: p.task.orderKey ?? midKey(prevKey, nextKey),
  };
  return [{ op: "task/add", task }];
}

/**
 * Removing a task also removes its whole subtree and every link touching a removed task — both are
 * needed to keep the store's indexes consistent, and both are emitted as their own patches so that
 * one undo restores the subtree *and* its links.
 */
export function buildTaskRemove(store: Store, p: Commands["task/remove"]): Patch[] {
  const patches: Patch[] = [];
  const seenTasks = new Set<TaskId>();
  const seenLinks = new Set<LinkId>();

  const visit = (id: TaskId): void => {
    if (seenTasks.has(id)) return;
    const task = store.byId.get(id);
    if (!task) return;
    seenTasks.add(id);

    for (const child of [...(store.children.get(id) ?? [])]) visit(child);

    const bucket = store.linksByTask.get(id);
    if (bucket) {
      for (const link of [...bucket.in, ...bucket.out]) {
        if (seenLinks.has(link.id)) continue;
        seenLinks.add(link.id);
        patches.push({ op: "link/remove", link });
      }
    }
    // Cascade: removing a task removes its assignments too, as their own patches, so one undo
    // restores the task and its assignments together.
    for (const assignment of store.assignmentsByTask.get(id) ?? []) {
      patches.push({ op: "assignment/remove", assignment });
    }
    patches.push({ op: "task/remove", task });
  };

  for (const id of p.ids) visit(id);
  return patches;
}

// docs/specs/plugins/data-store.md — Field deletion (`clears`).
/**
 * Builds the `task/update` patch, forwarding `p.clears` into it. A key named in `p.clears` that is
 * also named in `p.after` is treated as an `after` assignment (an unusable, contradictory `clears`
 * entry is ignored, the same treatment every other builder gives an unusable argument); otherwise
 * its current value — if it has one — is captured into `before`, so that inverting this patch
 * (undo) restores it by plain assignment rather than needing `clears` of its own. A key naming a
 * required field (`REQUIRED_TASK_FIELDS`) is likewise dropped from `p.clears` — required fields are
 * never deletable, the same invariant `fields.ts#mergeUpdate` enforces on both of its deletion rules.
 */
export function buildTaskUpdate(store: Store, p: Commands["task/update"]): Patch[] {
  const task = store.byId.get(p.id);
  if (!task) return [];

  const { after, before } = splitUpdate(task, p.after);
  const current = asRecord(task);

  const clears: (keyof Task)[] = [];
  const seenClears = new Set<string>();
  for (const key of p.clears ?? []) {
    const keyStr = key as string;
    if (REQUIRED_TASK_FIELDS.has(key) || keyStr in after || seenClears.has(keyStr)) continue;
    seenClears.add(keyStr);
    const value = current[keyStr];
    if (value !== undefined) before[keyStr] = value;
    clears.push(key);
  }

  if (Object.keys(after).length === 0 && clears.length === 0) return [];

  return [
    clears.length === 0
      ? {
          op: "task/update",
          id: p.id,
          before: before as Partial<Task>,
          after: after as Partial<Task>,
        }
      : {
          op: "task/update",
          id: p.id,
          before: before as Partial<Task>,
          after: after as Partial<Task>,
          clears,
        },
  ];
}

export function buildLinkAdd(store: Store, p: Commands["link/add"], ids: IdGen): Patch[] {
  // Both endpoints must exist, or the link would dangle and leave a `linksByTask` bucket for a task
  // that is not in `byId`. Like every other builder, an unknown id yields no patch at all.
  if (!store.byId.has(p.sourceId) || !store.byId.has(p.targetId)) return [];
  // A requested id that is already taken is the same class of no-op: applying the patch would
  // throw on the duplicate, and silently renaming the link would defeat the point of asking for
  // that identity (restoring a removed link under the id its patches still name).
  if (p.id !== undefined && store.hasLink(p.id)) return [];
  // docs/specs/plugins/data-store.md — Commands (`link/add`, "Duplicate links"): one dependency
  // per ordered pair. The check covers an explicitly requested id too: a restore path re-creates a
  // link that was removed, and one that is not missing is not being restored.
  if (store.hasLinkBetween(p.sourceId, p.targetId)) return [];

  const link: Link = {
    id: p.id ?? ids.nextLinkId(store),
    sourceId: p.sourceId,
    targetId: p.targetId,
    type: p.type,
  };
  // A zero lag and an absent one describe the same dependency, so `lag: 0` is normalized to an
  // absent field here as it is in `buildLinkUpdate` and in `load()` — a stored link never carries
  // `lag: 0`, which keeps the `link/update` no-op check and undo replay exact. A non-finite lag
  // (`NaN` / `Infinity`) is unusable and dropped, the same treatment `buildLinkUpdate` gives it —
  // a stored link's lag is always a finite number.
  if (p.lag !== undefined && Number.isFinite(p.lag) && p.lag !== 0) link.lag = p.lag;
  return [{ op: "link/add", link }];
}

// docs/specs/plugins/data-store.md — Commands (`link/update`, "Link retype / re-lag"): one
// transaction, therefore one undo step, for a link edit that used to need a `link/remove` +
// `link/add` pair.
/**
 * Builds the single `link/update` patch that retypes and/or re-lags a link.
 *
 * An id naming no link, a `lag` that is not a finite number, and a payload that would change
 * nothing all yield no patch — the uniform unusable-argument treatment. `lag: 0` is usable and
 * means "no lag": the resulting link carries no `lag` field at all, since a zero lag and an absent
 * one describe the same dependency.
 */
export function buildLinkUpdate(store: Store, p: Commands["link/update"]): Patch[] {
  const before = store.getLink(p.id);
  if (before === undefined) return [];

  const type = p.type ?? before.type;
  const lag =
    p.lag === undefined || !Number.isFinite(p.lag) ? before.lag : p.lag === 0 ? undefined : p.lag;
  if (type === before.type && lag === before.lag) return [];

  // `exactOptionalPropertyTypes` — the key is omitted rather than set to `undefined`.
  const after: Link = {
    id: before.id,
    sourceId: before.sourceId,
    targetId: before.targetId,
    type,
  };
  if (lag !== undefined) after.lag = lag;
  return [{ op: "link/update", before, after }];
}

// docs/specs/plugins/data-store.md — Commands: resource/assignment commands run the same pipeline
// as task/link.
export function buildResourceAdd(store: Store, p: Commands["resource/add"], ids: IdGen): Patch[] {
  // An explicitly requested id that is already taken creates nothing, same as `link/add`.
  if (p.resource.id !== undefined && store.hasResource(p.resource.id)) return [];
  const resource: Resource = {
    ...p.resource,
    id: p.resource.id ?? ids.nextResourceId(store),
    name: p.resource.name,
  };
  return [{ op: "resource/add", resource }];
}

export function buildResourceUpdate(store: Store, p: Commands["resource/update"]): Patch[] {
  const resource = store.resources.get(p.id);
  if (!resource) return [];

  const { after, before } = splitUpdate(resource, p.after);
  if (Object.keys(after).length === 0) return [];

  return [
    {
      op: "resource/update",
      id: p.id,
      before: before as Partial<Resource>,
      after: after as Partial<Resource>,
    },
  ];
}

/**
 * Removing a resource also removes every assignment of that resource — as its own patches, so one
 * undo restores the resource and its assignments together.
 */
export function buildResourceRemove(store: Store, p: Commands["resource/remove"]): Patch[] {
  // The assignment list is grouped by resource once, up front, rather than walking every
  // assignment in the store once per requested id (which is quadratic when `p.ids` names many
  // resources).
  const byResource = new Map<ResourceId, Assignment[]>();
  for (const assignment of store.assignments()) {
    let list = byResource.get(assignment.resourceId);
    if (!list) {
      list = [];
      byResource.set(assignment.resourceId, list);
    }
    list.push(assignment);
  }

  const patches: Patch[] = [];
  for (const resource of distinctExisting(p.ids, (id) => store.resources.get(id))) {
    for (const assignment of byResource.get(resource.id) ?? []) {
      patches.push({ op: "assignment/remove", assignment });
    }
    patches.push({ op: "resource/remove", resource });
  }
  return patches;
}

/**
 * Upsert: creates the (taskId, resourceId) assignment or updates its `units`. A `units` that is
 * non-finite or not greater than zero, or an endpoint that does not exist, yields no patch —
 * matching every other builder's treatment of an unusable argument.
 */
export function buildAssignmentSet(store: Store, p: Commands["assignment/set"]): Patch[] {
  if (!Number.isFinite(p.units) || p.units <= 0) return [];
  if (!store.byId.has(p.taskId) || !store.hasResource(p.resourceId)) return [];

  const existing = store.getAssignment(p.taskId, p.resourceId);
  if (existing === undefined) {
    return [
      {
        op: "assignment/add",
        assignment: { taskId: p.taskId, resourceId: p.resourceId, units: p.units },
      },
    ];
  }
  if (existing.units === p.units) return [];
  return [
    {
      op: "assignment/update",
      taskId: p.taskId,
      resourceId: p.resourceId,
      before: { units: existing.units },
      after: { units: p.units },
    },
  ];
}

/** Deleting one assignment by its composite key. A pair that names no assignment yields no patch. */
export function buildAssignmentRemove(store: Store, p: Commands["assignment/remove"]): Patch[] {
  const assignment = store.getAssignment(p.taskId, p.resourceId);
  if (assignment === undefined) return [];
  return [{ op: "assignment/remove", assignment }];
}

/**
 * Deleting links by id. An id that names no link contributes no patch, so a command naming only
 * unknown ids changes nothing at all.
 */
export function buildLinkRemove(store: Store, p: Commands["link/remove"]): Patch[] {
  // The dual of `link/add`, without which a `link/add` patch has no inverse reachable through the
  // command bus and link changes cannot be undone.
  return distinctExisting(p.ids, (id) => store.getLink(id)).map(
    (link): Patch => ({ op: "link/remove", link }),
  );
}
