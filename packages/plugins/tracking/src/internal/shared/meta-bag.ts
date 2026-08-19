// docs/specs/plugins/tracking.md §2.1 — the defensive bag read / sibling-preserving write / `clears`
// cleanup shared by the three `task.meta` object bags (`progressTracking`, `costTracking`, `evm`),
// plus the scalar-key write used by the two top-level `actualStart` / `actualEnd` keys
// (baselines' `setActual`).
//
// Bag reads are defensive everywhere: a non-object bag yields `{}`. Bag writes produce a NEW `meta`
// object preserving sibling keys; an emptied bag drops its key, and an emptied `meta` is cleared via
// the `clears` path rather than left behind as `{}`.
import type { Task } from "@stargantt/plugin-data-store";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The task's `meta[key]` bag, or `{}` when absent or not an object. */
export function readBag(task: Readonly<Task> | undefined, key: string): Record<string, unknown> {
  const meta = task?.meta;
  if (!isPlainObject(meta)) return {};
  const bag = meta[key];
  return isPlainObject(bag) ? bag : {};
}

/** The `task/update` patch fields a `ctx.dispatch("task/update", { id, ...patch })` call needs. */
export interface MetaWritePatch {
  after: Partial<Task>;
  clears?: readonly (keyof Task)[];
}

/**
 * Builds the patch that replaces `meta[key]` with `nextBag`, preserving every sibling key.
 *
 * `nextBag` empty (no own keys) or `undefined` drops `key` from `meta` entirely rather than storing
 * `{}`. When that leaves `meta` itself with no keys, the patch clears `meta` outright via `clears`
 * (so a subsequent read sees `task.meta === undefined`, not `{}`) instead of `after: { meta: {} }`.
 */
export function buildBagWrite(
  task: Readonly<Task>,
  key: string,
  nextBag: Record<string, unknown> | undefined,
): MetaWritePatch {
  const meta: Record<string, unknown> = { ...(isPlainObject(task.meta) ? task.meta : {}) };
  if (nextBag === undefined || Object.keys(nextBag).length === 0) delete meta[key];
  else meta[key] = nextBag;
  if (Object.keys(meta).length === 0) return { after: {}, clears: ["meta"] };
  return { after: { meta } };
}

/**
 * Builds the patch that writes several scalar `meta` keys at once (baselines' `actualStart` /
 * `actualEnd`): a key mapped to a finite number sets it, to `null` clears it, and an omitted /
 * `undefined` key is left untouched. Non-finite non-null values are ignored per key (silent no-op
 * for that key, matching the setter's own defensive-read contract).
 */
export function buildScalarMetaWrite(
  task: Readonly<Task>,
  updates: Readonly<Record<string, number | null | undefined>>,
): MetaWritePatch {
  const meta: Record<string, unknown> = { ...(isPlainObject(task.meta) ? task.meta : {}) };
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    if (value === null) {
      delete meta[key];
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) meta[key] = value;
  }
  if (Object.keys(meta).length === 0) return { after: {}, clears: ["meta"] };
  return { after: { meta } };
}
