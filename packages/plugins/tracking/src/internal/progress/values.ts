// docs/specs/plugins/tracking.md §2.1/§2.5 — the `task.meta.progressTracking` bag (defensive
// read, sibling-preserving write) and the pure `task/update` piece computation behind every
// progress write path: `setProgressFields`, `setProgressFieldsBatch`, the bulk panel's Apply and
// `setRemainingDuration`. Fully hostless — no `PluginContext`, no dispatch — so `service.ts` and
// `report.ts` can turn a piece into either a single `ctx.dispatch("task/update", …)` call or one
// tail entry of a batched transaction (`pieceToPatch`).
//
// Built on the shared `internal/shared/meta-bag.ts` (`readBag`/`buildBagWrite`) and
// `internal/shared/numbers.ts` validators instead of restating them.
import type { Patch, Task, TaskId } from "@stargantt/plugin-data-store";
import type { ProgressPatch, ProgressValues, RagStatus } from "../../types";
import { buildBagWrite, readBag } from "../shared/meta-bag";
import { clamp, finiteNonNegative, finitePositive, isFiniteNumber } from "../shared/numbers";

/** The `task.meta` key this area claims (§2.1). Claimed once, at the root — see `index.ts`. */
export const META_KEY = "progressTracking";

const RAG_VALUES: readonly RagStatus[] = ["red", "amber", "green"];

/** `true` for one of the three RAG literals. */
export function isRag(value: unknown): value is RagStatus {
  return (RAG_VALUES as readonly unknown[]).includes(value);
}

/** Validates a raw bag object into well-shaped `ProgressValues`, dropping every unusable member
 *  (an unusable value is treated as absent, never as an error). */
function validateValues(raw: Readonly<Record<string, unknown>>): ProgressValues {
  const out: ProgressValues = {};
  if (isRag(raw["rag"])) out.rag = raw["rag"];
  const remainingWork = finiteNonNegative(raw["remainingWork"]);
  if (remainingWork !== undefined) out.remainingWork = remainingWork;
  const totalWork = finitePositive(raw["totalWork"]);
  if (totalWork !== undefined) out.totalWork = totalWork;
  if (isFiniteNumber(raw["physicalPercent"])) out.physicalPercent = clamp(raw["physicalPercent"], 0, 100);
  return out;
}

/** A task's stored progress-tracking values, `{}` when it has none (§2.1 defensive read). */
export function progressValuesOf(task: Readonly<Task> | undefined): Readonly<ProgressValues> {
  return validateValues(readBag(task, META_KEY));
}

/**
 * Merges a partial update into current values: a key present with `undefined` removes the
 * attribute, an absent key is untouched, and every kept member is re-validated so an unusable
 * patched value is dropped (§1.2's `ProgressPatch` contract).
 */
export function mergeProgressValues(
  current: Readonly<ProgressValues>,
  patch: Readonly<ProgressPatch>,
): ProgressValues {
  const raw: Record<string, unknown> = { ...current };
  for (const key of Object.keys(patch) as (keyof ProgressValues)[]) {
    const value = patch[key];
    if (value === undefined) delete raw[key];
    else raw[key] = value;
  }
  return validateValues(raw);
}

/** A pre-computed `task/update` write, ready to dispatch (`after`/`clears`) or batch (`before`
 *  included, for the raw `Patch` shape a transaction tail entry needs). */
export interface UpdatePiece {
  id: TaskId;
  before: Partial<Task>;
  after: Partial<Task>;
  clears?: readonly (keyof Task)[];
}

/** Structural JSON-value equality, key-order-blind — the "byte-identical merged meta" no-op test. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => jsonEqual(v, b[i]));
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Whether applying `after`/`clears` would change nothing on `task` — the no-op dispatch guard
 *  (no undo entry for a write that restates the stored values). */
export function isPieceNoop(
  task: Readonly<Task>,
  after: Partial<Task>,
  clears?: readonly (keyof Task)[],
): boolean {
  for (const key of Object.keys(after) as (keyof Task)[]) {
    if (!jsonEqual(after[key], task[key])) return false;
  }
  for (const key of clears ?? []) {
    if (!(key in after) && task[key] !== undefined) return false;
  }
  return true;
}

/** Builds the `before` half of a piece: only the keys `after`/`clears` actually touch, mirroring
 *  the store's own inverse-patch rule (a field is only present in `before` when the task currently
 *  carries it, so undo removes an added field instead of writing an explicit stored value). */
function beforeOf(task: Readonly<Task>, after: Partial<Task>, clears?: readonly (keyof Task)[]): Partial<Task> {
  const before: Partial<Task> = {};
  for (const key of Object.keys(after) as (keyof Task)[]) {
    const current = task[key];
    if (current !== undefined) (before as Record<string, unknown>)[key] = current;
  }
  for (const key of clears ?? []) {
    if (!(key in after) && task[key] !== undefined) (before as Record<string, unknown>)[key] = task[key];
  }
  return before;
}

/** Resolves a task by id — the only store access the piece builders need. */
export type GetTask = (id: TaskId) => Readonly<Task> | undefined;

/** §2.5 — the remaining-work recompute: a patch that states `remainingWork` over a positive
 *  merged `totalWork` also rewrites `task.progress` as `1 − remaining/total`, clamped. */
function remainingWorkRecomputeExtra(
  merged: Readonly<ProgressValues>,
  patchedRemaining: boolean,
): Partial<Task> {
  return patchedRemaining &&
    merged.remainingWork !== undefined &&
    merged.totalWork !== undefined &&
    merged.totalWork > 0
    ? { progress: clamp(1 - merged.remainingWork / merged.totalWork, 0, 1) }
    : {};
}

/**
 * Turns one task's already-merged progress patch into an `UpdatePiece` (§2.5) — the single
 * computation behind `setProgressFields` and `setProgressFieldsBatch`. `undefined` for an unknown
 * task, a non-object patch, or a patch whose merged result is byte-identical to the stored state
 * (the no-op guard — no dispatch, no undo entry).
 */
export function progressFieldsPiece(
  getTask: GetTask,
  id: TaskId,
  patch: Readonly<ProgressPatch>,
): UpdatePiece | undefined {
  const task = getTask(id);
  if (task === undefined || typeof patch !== "object" || patch === null) return undefined;
  const merged = mergeProgressValues(progressValuesOf(task), patch);
  const patchedRemaining =
    Object.prototype.hasOwnProperty.call(patch, "remainingWork") && merged.remainingWork !== undefined;
  const extra = remainingWorkRecomputeExtra(merged, patchedRemaining);
  const bagWrite = buildBagWrite(task, META_KEY, merged as unknown as Record<string, unknown>);
  const after: Partial<Task> = { ...extra, ...bagWrite.after };
  const clears = bagWrite.clears;
  if (isPieceNoop(task, after, clears)) return undefined;
  const before = beforeOf(task, after, clears);
  return clears !== undefined ? { id: task.id, before, after, clears } : { id: task.id, before, after };
}

/**
 * §2.5 — `setRemainingDuration`'s piece: `end = max(statusDate, start) + ms`, `progress` = the
 * elapsed fraction of the new span, and (when the task carries a stored `remainingWork`) the
 * three-tier recompute of the stored effort so the meta never goes stale against the progress just
 * written: from a positive `totalWork` as `(1 − progress) × totalWork` (the exact inverse of the
 * remaining-work recompute), else proportionally from the stored pair
 * (`remainingWork × (1 − progress) / (1 − oldProgress)`); with no basis to recompute from (old
 * progress already 1), the stored value is left untouched. No no-op guard — always dispatches for
 * a usable `ms`.
 */
export function remainingDurationPiece(task: Readonly<Task>, ms: number, statusDate: number): UpdatePiece {
  const anchor = Math.max(statusDate, task.start);
  const end = anchor + ms;
  const span = end - task.start;
  const progress = span <= 0 ? 1 : clamp((statusDate - task.start) / span, 0, 1);
  const values = progressValuesOf(task);
  let after: Partial<Task> = { end, progress };
  if (values.remainingWork !== undefined) {
    const oldProgress = clamp(task.progress ?? 0, 0, 1);
    const remaining =
      values.totalWork !== undefined && values.totalWork > 0
        ? (1 - progress) * values.totalWork
        : oldProgress < 1
          ? (values.remainingWork * (1 - progress)) / (1 - oldProgress)
          : undefined;
    if (remaining !== undefined) {
      const merged = mergeProgressValues(values, { remainingWork: Math.max(0, remaining) });
      const bagWrite = buildBagWrite(task, META_KEY, merged as unknown as Record<string, unknown>);
      after = { ...after, ...bagWrite.after };
    }
  }
  const before = beforeOf(task, after);
  return { id: task.id, before, after };
}

/**
 * Turns one gathered bulk-panel edit into a piece; `undefined` when it is a no-op (§2.5's bulk
 * panel Apply — the same no-op guard as `progressFieldsPiece`, so an Apply-all that restates the
 * stored values dispatches nothing and adds no undo entry). An explicitly edited `progressPct`
 * always wins over the `remainingWork`/`totalWork` recompute.
 */
export function bulkEditPiece(
  getTask: GetTask,
  edit: { id: TaskId; progressPct?: number; remainingWork?: number },
): UpdatePiece | undefined {
  const task = getTask(edit.id);
  if (task === undefined) return undefined;
  const before: Partial<Task> = {};
  const after: Partial<Task> = {};
  if (edit.progressPct !== undefined) {
    if (task.progress !== undefined) before.progress = task.progress;
    after.progress = clamp(edit.progressPct, 0, 100) / 100;
  }
  if (edit.remainingWork !== undefined) {
    const merged = mergeProgressValues(progressValuesOf(task), { remainingWork: edit.remainingWork });
    const bagWrite = buildBagWrite(task, META_KEY, merged as unknown as Record<string, unknown>);
    if (task.meta !== undefined) before.meta = task.meta;
    if (bagWrite.after.meta !== undefined) after.meta = bagWrite.after.meta;
    // §2.5 — the remaining-work recompute is a property of the patch, not of the setRemainingWork
    // entry point: a bulk row that states remainingWork over a positive totalWork recomputes
    // task.progress in the same transaction. An explicitly edited Progress % column still wins.
    if (
      edit.progressPct === undefined &&
      merged.remainingWork !== undefined &&
      merged.totalWork !== undefined &&
      merged.totalWork > 0
    ) {
      if (task.progress !== undefined) before.progress = task.progress;
      after.progress = clamp(1 - merged.remainingWork / merged.totalWork, 0, 1);
    }
  }
  if (Object.keys(after).length === 0 || isPieceNoop(task, after)) return undefined;
  return { id: task.id, before, after };
}

/** Turns a piece into the raw store `Patch` a transaction-batch tail entry needs (`before`
 *  required there, unlike the `ctx.dispatch("task/update", …)` payload). */
export function pieceToPatch(piece: UpdatePiece): Patch {
  return {
    op: "task/update",
    id: piece.id,
    before: piece.before,
    after: piece.after,
    ...(piece.clears !== undefined ? { clears: piece.clears } : {}),
  } as Patch;
}

/**
 * Merges batch entries naming the same task into one `ProgressPatch`, later entries winning field
 * by field (including an explicit `undefined`, which still wins and clears the field). An entry
 * that is not a plain `{ id, patch }` object, or whose `patch` is not a usable object, contributes
 * nothing (§1.2's per-entry "unusable value" skip).
 */
export function mergeBatchEntries(
  entries: readonly { id: TaskId; patch: Readonly<ProgressPatch> }[],
): Map<TaskId, ProgressPatch> {
  const merged = new Map<TaskId, Record<string, unknown>>();
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") continue;
    const { id, patch } = entry;
    if (typeof patch !== "object" || patch === null) continue;
    const bag = merged.get(id) ?? {};
    for (const key of Object.keys(patch)) bag[key] = (patch as Record<string, unknown>)[key];
    merged.set(id, bag);
  }
  return merged as Map<TaskId, ProgressPatch>;
}
