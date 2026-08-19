// docs/specs/plugins/scheduling.md §2.1 (`engine/seeds.ts`)
/**
 * Which task ids each patch op makes a **propagation seed** — the headless half of the plugin's
 * `data/willApplyTransaction` handling, kept out of the plugin module so the classification is one
 * table that can be read and tested on its own.
 */
import type { Link, Patch, ReadonlyDataView, Task, TaskId } from "@stargantt/plugin-data-store";
import { effortFollowOn } from "./effort";
import type { UnitDeltas } from "./effort";
import { inLinks } from "./graph";
import { SCHEDULE_MODE_META_KEY } from "./modes";
import type { Projection } from "./projection";
import type { SchedulerHooks } from "./types";

const NO_HOOKS: SchedulerHooks = {};

/**
 * The task ids a patch makes a **propagation seed**.
 *
 * A seed keeps its own times and everything downstream of it is recomputed, so the rule is "the ids
 * whose new times are already decided by this patch":
 *  - task patches seed the task itself and its parent, because a parent's roll-up changes whenever
 *    a child is added, removed or moved;
 *  - link patches seed only `sourceId`. The **target** must stay un-seeded: it is precisely the task
 *    the new/removed/retyped edge has to reposition, and for `link/add` and `link/update` the
 *    forward closure reaches it from the source. For `link/remove` that route is gone once the
 *    patch is projected, so the caller additionally seeds the target's *remaining* predecessors —
 *    see `seedFreedTarget`.
 */
export function collectSeeds(patch: Patch, into: Set<TaskId>): void {
  // The row is looked up by the patch's own `op`, so for a well-typed patch its handler is by
  // construction the one for that exact variant; the cast only restates that to the compiler. An op
  // the table does not know (only reachable from untyped code, `Patch` being a closed union) fails
  // fast with an explicit diagnostic instead of contributing no seeds, which would silently disable
  // propagation for the edit carrying it.
  const seed = SEED_OPS[patch.op] as SeedOp<Patch> | undefined;
  if (seed === undefined) {
    throw new Error(`stargantt: unknown patch op "${String((patch as { op: unknown }).op)}"`);
  }
  seed(patch, into);
}

/**
 * Re-open the forward closure onto the target of a **removed** link.
 *
 * `projection.apply` has already deleted the edge, so `forwardClosure` can no longer reach
 * `link.targetId` from `link.sourceId`; without this the target would keep an earliest start
 * dictated by a link that no longer exists, which contradicts forward propagation from the points
 * that changed. Seeding every *remaining* predecessor puts the target back inside the closure as a
 * **non-seed**, so `schedule()` recomputes it from the links that survive.
 *
 * A target left with **zero** incoming links gets no seed and therefore keeps its current times on
 * purpose: that is the same rule the derivation applies (no incoming link → nothing to propagate
 * from → `undefined`).
 *
 * @param view the **projected** view, i.e. after `projection.apply(patch)`.
 */
export function seedFreedTarget(view: ReadonlyDataView, link: Link, into: Set<TaskId>): void {
  for (const remaining of inLinks(view, link.targetId)) into.add(remaining.sourceId);
}

/**
 * The shared transaction walk of the will-hook and `previewReschedule`: every patch in `patches` —
 * entries appended during the walk included, since `for..of` over an array visits appended entries
 * — is seeded, applied to `projection`, and classified for the §2.5 effort follow-on it demands; a
 * demanded follow-on is appended to `patches` and visited in its own turn. Seeding and effort
 * classification run only with `propagate` (the `enabled` gate); the projection is always advanced,
 * so a later patch is always evaluated against the transaction's own earlier effects.
 *
 * `guardLinkAdd` is the will-hook's cycle rejection, called against the projected view *before* the
 * edge is applied; returning `false` aborts the walk (the caller cancels the transaction). The
 * preview passes none, and the `link/remove` freed-target seeding below never fires there, for the
 * same reason: a reschedule plan holds only `task/update` date patches, and every patch this walk
 * itself appends is a `task/update` too, so no link patch can appear on that path.
 */
export function walkTransactionPatches(
  patches: Patch[],
  projection: Projection,
  seeds: Set<TaskId>,
  propagate: boolean,
  guardLinkAdd?: (view: ReadonlyDataView, link: Link) => boolean,
  hooks: SchedulerHooks = NO_HOOKS,
): boolean {
  /** One accumulator per transaction, so stacked assignment patches compound correctly. */
  const deltas: UnitDeltas = new Map();
  for (const patch of patches) {
    if (patch.op === "link/add" && guardLinkAdd !== undefined) {
      if (!guardLinkAdd(projection.view, patch.link)) return false;
    }
    if (propagate) collectSeeds(patch, seeds);
    // Applied whether or not propagation is on: a later `link/add` in the same transaction is
    // cycle-checked against the edges the earlier patches already added.
    projection.apply(patch);
    // Must run on the *projected* view: the edge has to be gone before the surviving predecessors
    // are read. Also covers a `task/remove` whose runner emits the dangling `link/remove` patches
    // alongside it.
    if (propagate && patch.op === "link/remove") {
      seedFreedTarget(projection.view, patch.link, seeds);
    }
    // §2.5 — effort tri-state follow-ons, classified against the projected (post-patch) view. At
    // most one patch per trigger, and a follow-on never triggers another of the same kind, so the
    // appended tail terminates.
    if (propagate) {
      const follow = effortFollowOn(projection.view, patch, deltas, hooks);
      if (follow !== undefined) patches.push(follow);
    }
  }
  return true;
}

/** The seeds one patch op contributes. */
type SeedOp<P extends Patch> = (patch: P, into: Set<TaskId>) => void;

/**
 * The task fields propagation reads: the times themselves, the parent whose roll-up spans them, the
 * constraint that bounds them, and the calendar the durations are measured against. A patch
 * touching none of these cannot change any task's dates, so it starts no propagation.
 */
const SCHEDULE_FIELDS = ["start", "end", "parentId", "constraint", "calendarId"] as const;

/**
 * Whether a `task/update` changes a scheduling input.
 *
 * A field counts as changed when the patch clears it, or when `after` carries a value different
 * from the one `before` records for it (the store builds `before` from the task's current value for
 * every key `after` names, so an absent `before` entry means the field was absent). `meta` is read
 * through the schedule-mode key alone: every other meta key — progress-tracking's, cost-tracking's,
 * this plugin's own `meta.work` follow-ons — is invisible to the engine.
 */
function changesSchedule(patch: Extract<Patch, { op: "task/update" }>): boolean {
  const clears = patch.clears;
  if (clears !== undefined) {
    for (const key of clears) {
      if (key === "meta" || (SCHEDULE_FIELDS as readonly string[]).includes(key)) return true;
    }
  }
  for (const field of SCHEDULE_FIELDS) {
    if (!(field in patch.after)) continue;
    if (field === "constraint") {
      if (!sameConstraint(patch.before.constraint, patch.after.constraint)) return true;
      continue;
    }
    if (patch.after[field] !== patch.before[field]) return true;
  }
  return "meta" in patch.after && scheduleModeIn(patch.before) !== scheduleModeIn(patch.after);
}

/** Two constraints are the same scheduling input when their type and date agree. */
function sameConstraint(a: Task["constraint"], b: Task["constraint"]): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.type === b.type && a.date === b.date;
}

/** The raw `meta.scheduleMode` value a patch side carries, `undefined` when it carries none. */
function scheduleModeIn(side: Partial<Task>): unknown {
  return side.meta?.[SCHEDULE_MODE_META_KEY];
}

/** One row per member of the `Patch` union — no member may be left out. */
type SeedOpTable = { readonly [K in Patch["op"]]: SeedOp<Extract<Patch, { op: K }>> };

/**
 * Which ids each patch op seeds. A patch op added to the union has to be classified here, so a
 * future variant cannot silently contribute no seeds and quietly disable propagation for the edits
 * that carry it.
 *
 * The resource and assignment ops seed nothing: they change no task's times, and the engine reads
 * none of the resource model.
 */
export const SEED_OPS = {
  // The summary roll-up is why a task patch also seeds its parent.
  "task/add": (patch, into) => {
    into.add(patch.task.id);
    if (patch.task.parentId !== null) into.add(patch.task.parentId);
  },
  "task/remove": (patch, into) => {
    into.add(patch.task.id);
    if (patch.task.parentId !== null) into.add(patch.task.parentId);
  },
  // An update seeds only when it changes something the engine reads. A progress drag, a rename or a
  // `meta` write from another plugin carries no scheduling information, and re-deriving the whole
  // downstream closure for it is what made the chart look as though it moved bars of its own
  // accord.
  "task/update": (patch, into) => {
    if (!changesSchedule(patch)) return;
    into.add(patch.id);
    const before = patch.before.parentId;
    const after = patch.after.parentId;
    if (before !== undefined && before !== null) into.add(before);
    if (after !== undefined && after !== null) into.add(after);
  },
  "link/add": (patch, into) => void into.add(patch.link.sourceId),
  // A retype / re-lag changes the constraint the edge imposes, so the edge has to be re-evaluated
  // exactly as a fresh one would be: seed the source, leave the target to the forward closure that
  // reaches it along the surviving edge. Both sides are read because only the endpoints of the link
  // as it will stand matter, and a `before` naming a different source would otherwise be lost.
  "link/update": (patch, into) => {
    into.add(patch.before.sourceId);
    into.add(patch.after.sourceId);
  },
  "link/remove": (patch, into) => void into.add(patch.link.sourceId),
  "resource/add": () => {},
  "resource/remove": () => {},
  "resource/update": () => {},
  "assignment/add": () => {},
  "assignment/remove": () => {},
  "assignment/update": () => {},
} satisfies SeedOpTable;
