// docs/specs/plugins/resource.md §3.3 — hostless assignment arithmetic: percent <-> units
// conversion, editor-commit diffing, choice merging (§1.2, §2.2, §2.3).

/** Task/resource identity as the data store types it. */
export type Id = string | number;

/** The store-facing slice of an assignment this plugin computes with. */
export interface AssignmentLike {
  readonly resourceId: Id;
  readonly units: number;
}

/** One entry of the editor's choice list. */
export interface ChoiceLike {
  readonly id: Id;
  readonly name: string;
}

/** The commands an editor commit (or a programmatic replace) must dispatch. */
export interface AssignmentDiff {
  /** Pairs to `assignment/set`: new assignments and assignments whose units changed. */
  readonly set: readonly AssignmentLike[];
  /** Resource ids to `assignment/remove`. */
  readonly remove: readonly Id[];
}

/**
 * The canonical comparison key of a task/resource id — its string form.
 *
 * This is the plugin's one id-equality rule: a pool choice carrying numeric `5` and a stored
 * record carrying `"5"` name the same resource. Every lookup that crosses the pool/store seam
 * (`unitsOf`, `diffAssignments`, `mergeChoices`, and `wire.ts`'s own store matching) compares
 * through this key, never through `===` or a `Map`'s own key equality.
 */
export function idKey(id: Id): string {
  return String(id);
}

/** Whether two ids name the same resource under the plugin's string-form id-equality rule. */
export function sameId(a: Id, b: Id): boolean {
  return idKey(a) === idKey(b);
}

/** A store `units` value (1 = full-time) as the whole percent the UI shows. */
export function toUnitsPercent(units: number): number {
  return Math.round(units * 100);
}

/**
 * Parses a UI percent (string or number) into a store `units` fraction.
 *
 * Returns `undefined` for anything that is not a finite number greater than zero; values above
 * 1000% clamp to 1000% (§3.3 — beyond ten FTE is treated as input error).
 */
export function percentToUnits(raw: unknown): number | undefined {
  const n = typeof raw === "string" ? Number(raw.trim() === "" ? Number.NaN : raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(n, 1000) / 100;
}

/**
 * Diffs a task's current assignments against the editor's desired state.
 *
 * `desired` maps resource id -> units. Untouched pairs (same units) produce nothing, so a commit
 * with no change dispatches nothing.
 */
export function diffAssignments(
  current: readonly AssignmentLike[],
  desired: ReadonlyMap<Id, number>,
): AssignmentDiff {
  const set: AssignmentLike[] = [];
  const remove: Id[] = [];
  // Ids are compared in string form throughout, matching the plugin's store-resource matching
  // rule: a pool choice carrying numeric 5 and a stored assignment carrying "5" name the same
  // resource, and must diff as an update, never as an add+leftover duplicate.
  const desiredByKey = new Map<string, number>();
  for (const [resourceId, units] of desired) desiredByKey.set(idKey(resourceId), units);
  const seen = new Set<string>();
  for (const a of current) {
    const key = idKey(a.resourceId);
    seen.add(key);
    const units = desiredByKey.get(key);
    if (units === undefined) remove.push(a.resourceId);
    else if (units !== a.units) set.push({ resourceId: a.resourceId, units });
  }
  for (const [resourceId, units] of desired) {
    if (!seen.has(idKey(resourceId))) set.push({ resourceId, units });
  }
  return { set, remove };
}

/** The units of one assignment in a list, `undefined` when the pair is absent (string-form ids). */
export function unitsOf(assignments: readonly AssignmentLike[], resourceId: Id): number | undefined {
  const key = idKey(resourceId);
  for (const a of assignments) if (idKey(a.resourceId) === key) return a.units;
  return undefined;
}

/**
 * Merges the editor's choice list: every pool entry (pool order) followed by every store resource
 * whose id the pool does not carry (store order).
 */
export function mergeChoices(pool: readonly ChoiceLike[], store: readonly ChoiceLike[]): ChoiceLike[] {
  const out: ChoiceLike[] = [...pool];
  // Deduped by the string-form id key, so a pool entry with numeric 1 hides a store resource
  // whose loader typed the same id as "1" — one choice per resource, matching `diffAssignments`.
  const known = new Set(pool.map((c) => idKey(c.id)));
  for (const r of store) if (!known.has(idKey(r.id))) out.push(r);
  return out;
}
