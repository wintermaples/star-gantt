// docs/specs/plugins/tracking.md §2.1 / §1.4 — the EVM area's slice of the storage model: the
// per-task attributes stored under the claimed `task.meta.evm` bag, built on
// `internal/shared/meta-bag.ts`.
//
// Reads are defensive everywhere: a non-object bag yields `{}` and every member
// that does not have its documented shape is treated as absent. Writes go through one
// `task/update` — undoable — and a patch that resolves to byte-identical `meta` skips the dispatch
// entirely, so "clear fields that were never set" costs neither an undo entry nor a store event.
import type { Task, TaskId } from "@stargantt/plugin-data-store";
import type { EarnedValueMethod, EvmMilestone, EvmPatch, EvmValues } from "../../types";
import type { TrackingAreaDeps } from "../areas";
import { buildBagWrite, readBag } from "../shared/meta-bag";
import { finiteNonNegative } from "../shared/numbers";

/** The claimed `task.meta` key this area owns (§2.1). */
export const EVM_META_KEY = "evm";

/** The accrual methods in declaration order (§1.4). */
export const EVM_METHODS: readonly EarnedValueMethod[] = [
  "percentComplete",
  "zeroHundred",
  "fiftyFifty",
  "milestoneWeighted",
];

/** Whether `value` is one of the four built-in accrual method names. */
export function isEarnedValueMethod(value: unknown): value is EarnedValueMethod {
  return (EVM_METHODS as readonly unknown[]).includes(value);
}

/** Whether `value` is a finite, non-negative number — the shape every EVM amount must have. */
export function usableAmount(value: unknown): value is number {
  return finiteNonNegative(value) !== undefined;
}

/** Reads a milestone list defensively; unusable entries are dropped (§1.4's `EvmMilestone`). */
function readMilestones(raw: unknown): EvmMilestone[] {
  if (!Array.isArray(raw)) return [];
  const out: EvmMilestone[] = [];
  for (const entry of raw as readonly unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const r = entry as Record<string, unknown>;
    const weight = r["weight"];
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0) continue;
    const complete = r["complete"];
    if (typeof complete !== "boolean") continue;
    const milestone: EvmMilestone = { weight, complete };
    const label = r["label"];
    if (typeof label === "string") milestone.label = label;
    out.push(milestone);
  }
  return out;
}

/** The validated `EvmValues` carried by an already-read bag. */
function readValues(bag: Record<string, unknown>): EvmValues {
  const out: EvmValues = {};
  if (usableAmount(bag["bac"])) out.bac = bag["bac"];
  if (usableAmount(bag["actualCost"])) out.actualCost = bag["actualCost"];
  if (isEarnedValueMethod(bag["method"])) out.method = bag["method"];
  const milestones = readMilestones(bag["milestones"]);
  if (milestones.length > 0) out.milestones = milestones;
  return out;
}

/**
 * Reads a task's stored EVM values, dropping every member that does not have its documented shape
 * — an unusable value is treated as absent (§2.1). `{}` for an unknown task.
 */
export function evmValuesOf(task: Readonly<Task> | undefined): Readonly<EvmValues> {
  return readValues(readBag(task, EVM_META_KEY));
}

/**
 * Merges a partial update into current values: a key present with `undefined` removes the
 * attribute, an absent key is untouched, and every kept member is re-validated so an unusable
 * patched value is dropped (§1.4's `EvmPatch`).
 */
export function mergeEvmValues(
  current: Readonly<EvmValues>,
  patch: Readonly<EvmPatch>,
): EvmValues {
  const raw: Record<string, unknown> = { ...current } as unknown as Record<string, unknown>;
  for (const key of ["bac", "actualCost", "method", "milestones"] as const) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value === undefined) delete raw[key];
    else raw[key] = value;
  }
  return readValues(raw);
}

/**
 * Whether two `meta` objects carry the same data — `undefined` on both sides counts as equal, so a
 * resolved patch that changes nothing (including the "nothing was ever stored" case) is recognized
 * as a true no-op by {@link createSetFields}, which then skips the dispatch instead of writing an
 * empty `clears: ["meta"]` step.
 */
export function metaEqual(
  a: Readonly<Record<string, unknown>> | undefined,
  b: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * `EvmService.setFields` — merges EVM fields into one task through a single `task/update`
 * (undoable), preserving sibling `meta` keys and clearing an emptied `meta` via the `clears` path.
 * Unknown tasks and non-object patches are no-ops, and so is a patch that resolves to the `meta`
 * the task already carries.
 */
export function createSetFields(
  deps: TrackingAreaDeps,
): (id: TaskId, patch: Readonly<EvmPatch>) => void {
  return (id, patch) => {
    const task = deps.data.getTask(id);
    if (task === undefined || typeof patch !== "object" || patch === null) return;
    const values = mergeEvmValues(evmValuesOf(task), patch);
    const write = buildBagWrite(task, EVM_META_KEY, values as unknown as Record<string, unknown>);
    const nextMeta = write.after.meta as Record<string, unknown> | undefined;
    if (metaEqual(nextMeta, task.meta)) return;
    deps.ctx.dispatch("task/update", { id: task.id, ...write });
  };
}
