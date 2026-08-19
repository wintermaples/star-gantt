/**
 * What each apply's store publication is driven by, and the two ways of arriving at it.
 *
 * Every change to the store ends in one synchronous burst of store `set()` calls: the domains that
 * changed, then `tasks` last, always (docs/specs/plugins/data-store.md — Notification order per
 * apply). Both routes into that burst live here — a transaction classifies its own patch list
 * through the `ops.ts` table, while the bulk paths (`load()`, materialization) have no patches and
 * are classified by comparing the store against a snapshot of what it replaced.
 */
import { assignmentKey } from "./fields";
import { classifyPatch } from "./ops";
import type { ChangeKind, ChangeSink } from "./ops";
import type { DataStores, Store } from "./store";
import { snapshotAssignments, snapshotLinks, snapshotResources, snapshotTasks } from "./store";
import type { Assignment, Link, LinkId, Patch, Resource, ResourceId, TaskId } from "./types";

/** One kind's worth of entities, keyed so that the same entity reported twice counts once. */
type Bucket<TId, TEntity> = Map<TId, TEntity>;

interface EntityChanges<TId, TEntity> {
  added: Bucket<TId, TEntity>;
  removed: Bucket<TId, TEntity>;
  updated: Bucket<TId, TEntity>;
}

function emptyEntityChanges<TId, TEntity>(): EntityChanges<TId, TEntity> {
  return { added: new Map(), removed: new Map(), updated: new Map() };
}

function entityCount<TId, TEntity>(changes: EntityChanges<TId, TEntity>): number {
  return changes.added.size + changes.removed.size + changes.updated.size;
}

/**
 * The accumulated classification of one apply.
 *
 * It is a `ChangeSink`, so a patch list fills it by reporting through the op table; the bulk paths
 * fill the same structure by hand from a snapshot diff. Either way, `publishChanges` below is the
 * only reader — it asks each domain only whether it changed at all, since a store snapshot carries
 * no per-entity added/removed/updated shape (a subscriber that needs that diffs `next` against
 * `prev` itself).
 */
export class Changes implements ChangeSink {
  readonly tasks: Record<ChangeKind, Set<TaskId>> = {
    added: new Set(),
    removed: new Set(),
    updated: new Set(),
  };
  readonly links = emptyEntityChanges<LinkId, Link>();
  readonly resources = emptyEntityChanges<ResourceId, Resource>();
  /** Keyed by the (taskId, resourceId) pair an assignment is identified by — it has no id of its own. */
  readonly assignments = emptyEntityChanges<string, Assignment>();

  task(kind: ChangeKind, id: TaskId): void {
    this.tasks[kind].add(id);
  }

  link(kind: ChangeKind, link: Link): void {
    this.links[kind].set(link.id, link);
  }

  /**
   * An `undefined` entity is dropped whole rather than reported as a bare id: it can only mean the
   * resource is not in the store after the apply, and a change reported against something the
   * reader cannot look up says less than nothing.
   */
  resource(kind: ChangeKind, id: ResourceId, entity: Resource | undefined): void {
    if (entity === undefined) return;
    this.resources[kind].set(id, entity);
  }

  assignment(kind: ChangeKind, assignment: Assignment): void {
    this.assignments[kind].set(assignmentKey(assignment.taskId, assignment.resourceId), assignment);
  }

  hasLinks(): boolean {
    return entityCount(this.links) > 0;
  }

  hasResources(): boolean {
    return entityCount(this.resources) > 0;
  }

  hasAssignments(): boolean {
    return entityCount(this.assignments) > 0;
  }
}

/** Classifies an applied patch list. Call after `store` has the patches in it. */
export function classifyPatches(patches: readonly Patch[], store: Store): Changes {
  const changes = new Changes();
  for (const patch of patches) classifyPatch(patch, changes, store);
  return changes;
}

/**
 * What the store held before a bulk path replaced its contents.
 *
 * Entities, not just ids: a row the load dropped is unreachable afterwards, and the diff below has
 * to say what went away.
 */
export interface StoreSnapshot {
  tasks: Set<TaskId>;
  links: Map<LinkId, Link>;
  resources: Map<ResourceId, Resource>;
  assignments: Map<string, Assignment>;
}

/** Snapshots `store` — taken immediately before `clear()`, so a `load()` can be diffed against it. */
export function snapshotStore(store: Store): StoreSnapshot {
  const links = new Map<LinkId, Link>();
  for (const link of store.links()) links.set(link.id, link);
  const assignments = new Map<string, Assignment>();
  for (const assignment of store.assignments()) {
    assignments.set(assignmentKey(assignment.taskId, assignment.resourceId), assignment);
  }
  return {
    tasks: new Set(store.byId.keys()),
    links,
    resources: new Map(store.resources),
    assignments,
  };
}

/**
 * Classifies a bulk path: present only afterwards is `added`, present only before is `removed`,
 * present on both sides is `updated`.
 *
 * A load replaces everything it touches, so "updated" here means "an id that survived the load",
 * not "an entity whose fields differ" — comparing field by field would call a byte-identical
 * reload a no-change classification, which is not what `hasLinks`/`hasResources`/`hasAssignments`
 * are for.
 */
export function diffAgainstSnapshot(before: StoreSnapshot, store: Store): Changes {
  const changes = new Changes();

  for (const id of store.byId.keys()) changes.task(before.tasks.has(id) ? "updated" : "added", id);
  for (const id of before.tasks) if (!store.byId.has(id)) changes.task("removed", id);

  for (const link of store.links()) changes.link(before.links.has(link.id) ? "updated" : "added", link);
  for (const [id, link] of before.links) if (!store.hasLink(id)) changes.link("removed", link);

  for (const resource of store.resources.values()) {
    changes.resource(
      before.resources.has(resource.id) ? "updated" : "added",
      resource.id,
      resource,
    );
  }
  for (const [id, resource] of before.resources) {
    if (!store.hasResource(id)) changes.resource("removed", id, resource);
  }

  const now = new Set<string>();
  for (const assignment of store.assignments()) {
    const key = assignmentKey(assignment.taskId, assignment.resourceId);
    now.add(key);
    changes.assignment(before.assignments.has(key) ? "updated" : "added", assignment);
  }
  for (const [key, assignment] of before.assignments) {
    if (!now.has(key)) changes.assignment("removed", assignment);
  }

  return changes;
}

// docs/specs/plugins/data-store.md — Notification order per apply (normative).
/**
 * Publishes one apply's worth of store snapshots: the domains that changed, in
 * links → resources → assignments order, then `tasks` last — always, whether or not any task
 * entry itself changed, so that a subscriber repainting from `tasks` sees every domain settled.
 */
export function publishChanges(stores: DataStores, changes: Changes, store: Store): void {
  if (changes.hasLinks()) stores.links.set(snapshotLinks(store));
  if (changes.hasResources()) stores.resources.set(snapshotResources(store));
  if (changes.hasAssignments()) stores.assignments.set(snapshotAssignments(store));
  stores.tasks.set(snapshotTasks(store));
}
