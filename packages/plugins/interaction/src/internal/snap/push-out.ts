// docs/specs/plugins/interaction.md §2.2 — successor push-out on dependency violation.
/**
 * Computing the forward pushes a transaction's edits force on dependent tasks.
 *
 * Pure over a read-only view and a patch list; unit-testable without a host. The returned patches,
 * appended to the same transaction, restore every dependency link's lower bound by moving each
 * violated successor forward by exactly its deficit, duration preserved, cascading down the link
 * graph.
 *
 * The projection uses the data store's public `mergeTaskUpdate` so update semantics can never drift
 * from the store's own.
 */
import { mergeTaskUpdate } from "@stargantt/plugin-data-store";
import type {
  Link,
  LinkId,
  LinkType,
  Patch,
  ReadonlyDataView,
  Task,
  TaskId,
} from "@stargantt/plugin-data-store";

/** How often one task may be re-pushed before the walk gives up — bounds cyclic link graphs. */
export const PUSH_CAP_PER_TASK = 1000;

/** A task's dates as the relaxation tracks them. */
interface Dates {
  start: number;
  end: number;
}

/** The earliest instant a link permits for its target's bound side. */
function lowerBound(type: LinkType, source: Dates, lag: number): { onEnd: boolean; min: number } {
  // Closed union — the `satisfies` table keeps a future variant from becoming a silent no-op.
  const table = {
    FS: { onEnd: false, min: source.end + lag },
    SS: { onEnd: false, min: source.start + lag },
    FF: { onEnd: true, min: source.end + lag },
    SF: { onEnd: true, min: source.start + lag },
  } satisfies Record<LinkType, { onEnd: boolean; min: number }>;
  return table[type];
}

/** The transaction projected onto the current view — read-only, nothing is applied yet. */
interface Projection {
  /** The task as the transaction leaves it, or `undefined` when the transaction removes it. */
  taskOf(id: TaskId): Readonly<Task> | undefined;
  /** The outgoing links the transaction leaves on a task, retypes and re-lags folded in. */
  outLinksOf(id: TaskId): Link[];
  /** The tasks the transaction touched — where the relaxation starts. */
  seeds: Set<TaskId>;
}

function projectTransaction(view: ReadonlyDataView, patches: readonly Patch[]): Projection {
  const overlay = new Map<TaskId, Readonly<Task>>();
  const removedTasks = new Set<TaskId>();
  const addedLinks: Link[] = [];
  const removedLinks = new Set<LinkId>();
  /** Links the transaction retypes or re-lags, by id — read in place of the stored version. */
  const replacedLinks = new Map<LinkId, Link>();
  const seeds = new Set<TaskId>();

  const taskOf = (id: TaskId): Readonly<Task> | undefined =>
    removedTasks.has(id) ? undefined : (overlay.get(id) ?? view.byId.get(id));

  for (const patch of patches) {
    switch (patch.op) {
      case "task/add":
        overlay.set(patch.task.id, patch.task);
        removedTasks.delete(patch.task.id);
        seeds.add(patch.task.id);
        break;
      case "task/remove":
        overlay.delete(patch.task.id);
        removedTasks.add(patch.task.id);
        seeds.delete(patch.task.id);
        break;
      case "task/update": {
        const current = taskOf(patch.id);
        if (current === undefined) break;
        overlay.set(patch.id, mergeTaskUpdate(current, patch));
        seeds.add(patch.id);
        break;
      }
      case "link/add":
        addedLinks.push(patch.link);
        seeds.add(patch.link.sourceId);
        break;
      case "link/update":
        // A retype / re-lag changes the bound the edge imposes. The edge keeps its identity and its
        // endpoints, so it is projected as a replacement of the stored link rather than as a second
        // edge, and its source is seeded exactly as a freshly added edge's would be.
        replacedLinks.set(patch.after.id, patch.after);
        seeds.add(patch.after.sourceId);
        break;
      case "link/remove":
        removedLinks.add(patch.link.id);
        break;
      default:
        break;
    }
  }

  /** The stored link as the transaction leaves it — its replacement when it was retyped/re-lagged. */
  const projectedLink = (l: Link): Link => replacedLinks.get(l.id) ?? l;

  const outLinksOf = (id: TaskId): Link[] => {
    const base = view.linksByTask.get(id)?.out ?? [];
    const out: Link[] = [];
    // A transaction may add a link under an id the stored view already carries (or add it twice);
    // deduplicating by id keeps each edge relaxed once instead of double-counted.
    const seen = new Set<LinkId>();
    for (const l of base) {
      if (removedLinks.has(l.id) || seen.has(l.id)) continue;
      seen.add(l.id);
      out.push(projectedLink(l));
    }
    for (const l of addedLinks) {
      if (l.sourceId !== id || removedLinks.has(l.id) || seen.has(l.id)) continue;
      seen.add(l.id);
      out.push(projectedLink(l));
    }
    return out;
  };

  return { taskOf, outLinksOf, seeds };
}

/**
 * Pushes each violated successor forward by its deficit, cascading from the seeds. Returns the
 * final dates of every task that moved; a task is pushed at most `PUSH_CAP_PER_TASK` times so a
 * cyclic link graph terminates.
 */
function relaxForward(projection: Projection): Map<TaskId, Dates> {
  const shifted = new Map<TaskId, Dates>();
  const datesOf = (id: TaskId): Dates | undefined => {
    const moved = shifted.get(id);
    if (moved !== undefined) return moved;
    const task = projection.taskOf(id);
    return task === undefined ? undefined : { start: task.start, end: task.end };
  };

  const pushes = new Map<TaskId, number>();
  const queue: TaskId[] = Array.from(projection.seeds);
  for (let qi = 0; qi < queue.length; qi++) {
    const sourceId = queue[qi] as TaskId;
    const source = datesOf(sourceId);
    if (source === undefined) continue;
    for (const link of projection.outLinksOf(sourceId)) {
      const targetId = link.targetId;
      if (targetId === sourceId) continue;
      const target = datesOf(targetId);
      if (target === undefined) continue;
      const lag = typeof link.lag === "number" && Number.isFinite(link.lag) ? link.lag : 0;
      const bound = lowerBound(link.type, source, lag);
      const actual = bound.onEnd ? target.end : target.start;
      const deficit = bound.min - actual;
      // A NaN deficit (non-finite dates) fails this comparison, so bad data never pushes.
      if (!(deficit > 0)) continue;
      const count = (pushes.get(targetId) ?? 0) + 1;
      if (count > PUSH_CAP_PER_TASK) continue;
      pushes.set(targetId, count);
      shifted.set(targetId, { start: target.start + deficit, end: target.end + deficit });
      queue.push(targetId);
    }
  }
  return shifted;
}

/** One patch per pushed task: its projected pre-push dates to its final dates. */
function emitPushPatches(projection: Projection, shifted: ReadonlyMap<TaskId, Dates>): Patch[] {
  const out: Patch[] = [];
  for (const [id, final] of shifted) {
    const base = projection.taskOf(id);
    if (base === undefined) continue;
    if (final.start === base.start && final.end === base.end) continue;
    out.push({
      op: "task/update",
      id,
      before: { start: base.start, end: base.end },
      after: { start: final.start, end: final.end },
    });
  }
  return out;
}

/**
 * The `task/update` patches that push violated successors forward, computed against the projected
 * post-transaction state. Empty when the transaction touches no task dates or violates nothing.
 */
export function pushOutPatches(view: ReadonlyDataView, patches: readonly Patch[]): Patch[] {
  const projection = projectTransaction(view, patches);
  if (projection.seeds.size === 0) return [];
  return emitPushPatches(projection, relaxForward(projection));
}

/**
 * Whether the push-out pass stands down: any guard answering `true` suppresses it, and a guard that
 * throws is reported and read as `true` — the conservative answer, so the pass never races a
 * reconciler it failed to interrogate.
 *
 * Every guard is called (the OR is not short-circuited) so one guard's fault cannot hide another's
 * answer; the result is order-independent either way.
 */
export function standsDown(
  guards: readonly (() => boolean)[],
  onFault: (error: unknown) => void,
): boolean {
  let down = false;
  for (const guard of guards) {
    try {
      if (guard() === true) down = true;
    } catch (error) {
      onFault(error);
      down = true;
    }
  }
  return down;
}
