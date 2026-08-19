// docs/specs/plugins/resource.md §3.4 — the `drag/lanes` write path, decided as plain data.
/**
 * What one lane drop writes, worked out without a host so it is exercised in plain Node.
 *
 * A drop is ONE user-visible commit, so it lands as one transaction and one undo step: a head
 * command that certainly produces a patch, plus the rest appended to that same transaction by
 * `sdk/aggregate`'s batcher. Which command is the head is the whole decision this module makes —
 * a head that changes nothing raises no transaction, and the appended tail would then be dropped
 * silently.
 *
 * Three heads, in the order the spec names them (§3.4):
 *
 * - `resource/add`, when the target is known to the pool but not to the store (the mirror);
 * - `assignment/remove` on the source, when the target-side change would produce no patch at all
 *   (it already carries exactly the moved rate) — dropping the source is then the whole move;
 * - `assignment/set` on the target otherwise, with the source removal as the tail patch. The
 *   target is always set BEFORE the source is removed, so no intermediate state exists in which
 *   the task is assigned to nobody.
 *
 * Same/unknown/unassigned cases are a silent no-op — a drag that resolves to nothing writes
 * nothing rather than reporting an error.
 */
import type { Assignment, Patch, Resource, ResourceId, TaskId } from "@stargantt/plugin-data-store";

/** A pool entry as this module needs it — the three fields the store mirror carries. */
export interface MirrorSource {
  id: ResourceId;
  name: string;
  capacity?: number;
}

/** What one `reassign` call writes. */
export type ReassignPlan =
  /** Nothing at all: same resource, unknown resource, or no assignment to move. */
  | { readonly kind: "none" }
  /** Head `resource/add` (the pool mirror), tail: the target set (when any) and the source removal. */
  | { readonly kind: "mirror"; readonly resource: Resource; readonly tail: readonly Patch[] }
  /** Head `assignment/remove` on the source; no tail — the target already carries the rate. */
  | { readonly kind: "removeSource"; readonly taskId: TaskId; readonly resourceId: ResourceId }
  /** Head `assignment/set` on the target, tail: the source removal. */
  | {
      readonly kind: "set";
      readonly taskId: TaskId;
      readonly resourceId: ResourceId;
      readonly units: number;
      readonly tail: readonly Patch[];
    };

/** Everything the decision reads. */
export interface ReassignInput {
  taskId: TaskId;
  /** The source resource id, already resolved through the row universe. */
  from: ResourceId;
  /** The target resource id, already resolved through the row universe. */
  to: ResourceId;
  /** The task's current assignments (`query().assignmentsByTask`). */
  assignments: readonly Assignment[];
  /** The store's resource index (`query().resources`). */
  storeResources: ReadonlyMap<ResourceId, Readonly<Resource>>;
  /** The pool entry behind an id, when there is one. */
  poolEntry(id: ResourceId): MirrorSource | undefined;
}

/** Nothing to do — the shared instance, so a declined drag allocates nothing. */
const NO_PLAN: ReassignPlan = { kind: "none" };

/**
 * Whether the store already carries this resource id — matched by `String(id)` rather than the
 * `Map`'s own key equality, because the id may come back typed differently than the store's own
 * key (a pool id typed as a `number` against a store id the loader typed as the string `"1"`).
 */
function storeHasResource(
  storeResources: ReadonlyMap<ResourceId, Readonly<Resource>>,
  id: ResourceId,
): boolean {
  if (storeResources.has(id)) return true;
  const wanted = String(id);
  for (const key of storeResources.keys()) if (String(key) === wanted) return true;
  return false;
}

/**
 * The patch that puts `units` on the target — an add when the pair does not exist yet, an update
 * when it does, and `undefined` when the target already carries exactly that rate and nothing
 * about it would change.
 */
function targetAssignmentPatch(
  taskId: TaskId,
  resourceId: ResourceId,
  units: number,
  assignments: readonly Assignment[],
): Patch | undefined {
  const wanted = String(resourceId);
  const existing = assignments.find((a) => String(a.resourceId) === wanted);
  if (existing === undefined) {
    return { op: "assignment/add", assignment: { taskId, resourceId, units } };
  }
  if (existing.units === units) return undefined;
  return {
    op: "assignment/update",
    taskId,
    resourceId: existing.resourceId,
    before: { units: existing.units },
    after: { units },
  };
}

/** Decides what a `reassign(taskId, from, to)` call writes. */
export function planReassign(input: ReassignInput): ReassignPlan {
  if (String(input.from) === String(input.to)) return NO_PLAN;
  const wantedSource = String(input.from);
  const source = input.assignments.find((a) => String(a.resourceId) === wantedSource);
  if (source === undefined) return NO_PLAN;
  // The rate rides along with the assignment. A stored rate is always finite and positive, but a
  // hand-built store is not the store's problem to trust.
  const units =
    typeof source.units === "number" && Number.isFinite(source.units) && source.units > 0
      ? source.units
      : 1;

  const removal: Patch = { op: "assignment/remove", assignment: source };
  const targetPatch = targetAssignmentPatch(input.taskId, input.to, units, input.assignments);

  if (!storeHasResource(input.storeResources, input.to)) {
    const entry = input.poolEntry(input.to);
    // Known to neither the store nor the pool: nothing is written at all.
    if (entry === undefined) return NO_PLAN;
    const resource: Resource =
      entry.capacity === undefined
        ? { id: entry.id, name: entry.name }
        : { id: entry.id, name: entry.name, capacity: entry.capacity };
    return {
      kind: "mirror",
      resource,
      tail: targetPatch === undefined ? [removal] : [targetPatch, removal],
    };
  }

  if (targetPatch === undefined) {
    return { kind: "removeSource", taskId: input.taskId, resourceId: source.resourceId };
  }
  return { kind: "set", taskId: input.taskId, resourceId: input.to, units, tail: [removal] };
}
