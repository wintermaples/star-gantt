// docs/specs/plugins/undo-redo.md "Coalescing and net-zero compression" — a coalesced entry whose
// merged patches have net-zero effect is dropped from the history: a liveUpdate drag that returns
// to its origin leaves no undo step, because undoing it would visibly change nothing.
import type { Patch } from "@stargantt/plugin-data-store";

/** Marks a field that was unset before the patch sequence touched it. */
const UNSET: unique symbol = Symbol("unset");

/** The update-shaped patch variants; anything else (an add or a remove) is never net-zero here. */
type UpdatePatch = Extract<
  Patch,
  { op: "task/update" | "link/update" | "resource/update" | "assignment/update" }
>;

/** A stable per-entity key, or `undefined` when the patch cannot be keyed safely. */
function entityKey(patch: UpdatePatch): string | undefined {
  switch (patch.op) {
    case "task/update":
      return `t:${String(patch.id)}`;
    case "link/update":
      // A link update that renames the link is out of scope for the conservative check.
      return patch.before.id === patch.after.id ? `l:${String(patch.after.id)}` : undefined;
    case "resource/update":
      return `r:${String(patch.id)}`;
    case "assignment/update":
      return `a:${String(patch.taskId)}|${String(patch.resourceId)}`;
    default:
      return undefined;
  }
}

/** Whether two field values are interchangeably equal for the net-zero test. Only primitives (and
 * `null`) compare equal; a structured value is conservatively "not equal", keeping the entry. */
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  return false;
}

/**
 * Whether applying `patches` in order changes nothing observable — every touched field of every
 * touched entity ends at the value it started from.
 *
 * Deliberately conservative: only update-shaped patches without `clears` are analysed, field
 * values compare by `Object.is`, and anything the analysis cannot vouch for answers `false`, so a
 * doubtful entry is kept rather than dropped. That covers the case the rule exists for — a
 * return-to-origin drag, whose merged patch chain is a sequence of primitive-valued updates.
 */
export function isNetZero(patches: readonly Patch[]): boolean {
  if (patches.length === 0) return true;
  /** Per entity: each touched field's original value and its current value. */
  const state = new Map<string, Map<string, { original: unknown; current: unknown }>>();
  for (const patch of patches) {
    if (
      patch.op !== "task/update" &&
      patch.op !== "link/update" &&
      patch.op !== "resource/update" &&
      patch.op !== "assignment/update"
    ) {
      return false;
    }
    // `clears` deletes fields outright; composing deletions is out of the conservative scope.
    if ("clears" in patch && patch.clears !== undefined) return false;
    const key = entityKey(patch);
    if (key === undefined) return false;
    const fields = state.get(key) ?? new Map<string, { original: unknown; current: unknown }>();
    state.set(key, fields);
    const before = patch.before as Record<string, unknown>;
    const after = patch.after as Record<string, unknown>;
    for (const field of Object.keys(after)) {
      const entry = fields.get(field) ?? {
        original: field in before ? before[field] : UNSET,
        current: field in before ? before[field] : UNSET,
      };
      entry.current = after[field];
      fields.set(field, entry);
    }
  }
  for (const fields of state.values()) {
    for (const { original, current } of fields.values()) {
      if (!same(original, current)) return false;
    }
  }
  return true;
}
