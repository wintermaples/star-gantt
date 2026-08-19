// docs/specs/plugins/undo-redo.md "Snapshot serialize/restore"
/**
 * Structural validation for `HistorySnapshot`, used by `History.restore()`.
 *
 * A snapshot handed to `restore()` is untrusted: it may have round-tripped through
 * `JSON.stringify()` / `JSON.parse()` and `localStorage`, or come from an incompatible version of
 * this plugin, or simply be garbage. Every entry of both stacks is checked before any of it is
 * applied, so a value that fails partway through changes nothing at all (the wholesale-rejection
 * rule `History.restore()` documents).
 */
import type { Patch } from "@stargantt/plugin-data-store";
// Type-only: erased at emit, so this does not create a runtime import cycle with `../history`,
// which imports the value exports of this module.
import type { HistoryEntry, HistorySnapshot } from "../history";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isTaskLike(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return (
    isId(value.id) &&
    (value.parentId === null || isId(value.parentId)) &&
    typeof value.name === "string" &&
    typeof value.start === "number" &&
    typeof value.end === "number"
  );
}

function isLinkLike(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return isId(value.id) && isId(value.sourceId) && isId(value.targetId) && typeof value.type === "string";
}

function isResourceLike(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return isId(value.id) && typeof value.name === "string";
}

function isAssignmentLike(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return isId(value.taskId) && isId(value.resourceId) && typeof value.units === "number";
}

function isUnitsHolder(value: unknown): boolean {
  return isPlainObject(value) && typeof value.units === "number";
}

/**
 * One row per member of the `Patch` union, mirroring the store's own patch-op table:
 * every op must be listed here, or a patch of that kind would be silently accepted without its
 * required fields ever being checked.
 */
const PATCH_VALIDATORS: { readonly [K in Patch["op"]]: (value: Record<string, unknown>) => boolean } = {
  "task/add": (v) => isTaskLike(v.task),
  "task/remove": (v) => isTaskLike(v.task),
  "task/update": (v) =>
    isId(v.id) &&
    isPlainObject(v.before) &&
    isPlainObject(v.after) &&
    (v.clears === undefined || isStringArray(v.clears)),
  "link/add": (v) => isLinkLike(v.link),
  "link/remove": (v) => isLinkLike(v.link),
  "link/update": (v) => isLinkLike(v.before) && isLinkLike(v.after),
  "resource/add": (v) => isResourceLike(v.resource),
  "resource/remove": (v) => isResourceLike(v.resource),
  "resource/update": (v) => isId(v.id) && isPlainObject(v.before) && isPlainObject(v.after),
  "assignment/add": (v) => isAssignmentLike(v.assignment),
  "assignment/remove": (v) => isAssignmentLike(v.assignment),
  "assignment/update": (v) =>
    isId(v.taskId) && isId(v.resourceId) && isUnitsHolder(v.before) && isUnitsHolder(v.after),
};

/** Whether `value` structurally matches one member of the `Patch` union. */
function isPatch(value: unknown): value is Patch {
  if (!isPlainObject(value)) return false;
  const validator = typeof value.op === "string" ? PATCH_VALIDATORS[value.op as Patch["op"]] : undefined;
  return validator !== undefined && validator(value);
}

/** Whether `value` structurally matches `HistoryEntry`, patches included. */
function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (!isPlainObject(value)) return false;
  if (typeof value.id !== "string" || typeof value.label !== "string") return false;
  if (!Array.isArray(value.patches) || !value.patches.every(isPatch)) return false;
  if (value.coalesceKey !== undefined && typeof value.coalesceKey !== "string") return false;
  return true;
}

// docs/specs/plugins/undo-redo.md "Snapshot serialize/restore" — a snapshot this constant does not
// match is rejected wholesale, including one written by a future, incompatible version.
export const HISTORY_SNAPSHOT_VERSION = 1;

/** Whether `value` structurally matches `HistorySnapshot` at the version this build produces. */
export function isHistorySnapshot(value: unknown): value is HistorySnapshot {
  if (!isPlainObject(value)) return false;
  if (value.version !== HISTORY_SNAPSHOT_VERSION) return false;
  if (!Array.isArray(value.undo) || !value.undo.every(isHistoryEntry)) return false;
  if (!Array.isArray(value.redo) || !value.redo.every(isHistoryEntry)) return false;
  return true;
}
