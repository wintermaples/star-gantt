// docs/specs/plugins/tracking.md §2.1 / §1.3 — the `costTracking` meta bag: the defensive read, the
// scalar-field merge, cost-item normalization, and the four service members that write it (each one
// `task/update`, so undo integration is inherited).
import type { PluginContext } from "@stargantt/core";
import type { DataService, Task, TaskId } from "@stargantt/plugin-data-store";
import type { CostItem, CostItemInit, CostPatch, CostType, CostValues } from "../../types";
import { buildBagWrite, readBag } from "../shared/meta-bag";

/** The key under `task.meta` where the cost area stores its values (§2.1). */
export const COST_META_KEY = "costTracking";

/** The four cost types in declaration order. */
export const COST_TYPES: readonly CostType[] = ["labor", "fixed", "variable", "material"];

export function isCostType(v: unknown): v is CostType {
  return (COST_TYPES as readonly unknown[]).includes(v);
}

/** Whether `v` is a finite, non-negative number — the shape every cost amount must have. */
export function usableAmount(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/** Trims a cost code; `undefined` when it is not a non-empty string. */
export function usableCode(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed === "" ? undefined : trimmed;
}

function readItems(raw: unknown): CostItem[] {
  if (!Array.isArray(raw)) return [];
  const out: CostItem[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const r = entry as Record<string, unknown>;
    if (!usableAmount(r["amount"]) || !isCostType(r["type"])) continue;
    const id = typeof r["id"] === "string" && r["id"] !== "" ? r["id"] : undefined;
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      label: typeof r["label"] === "string" ? r["label"] : "",
      amount: r["amount"],
      type: r["type"],
    });
  }
  return out;
}

/**
 * Reads a task's stored cost values, dropping every member that does not have its documented shape
 * — an unusable value is treated as absent (§2.1). A non-object bag yields `{}`,
 * as does an absent task.
 */
export function readCostValues(task: Readonly<Task> | undefined): Readonly<CostValues> {
  const raw = readBag(task, COST_META_KEY);
  const out: CostValues = {};
  if (usableAmount(raw["fixedCost"])) out.fixedCost = raw["fixedCost"];
  if (usableAmount(raw["materialCost"])) out.materialCost = raw["materialCost"];
  if (usableAmount(raw["actualCost"])) out.actualCost = raw["actualCost"];
  const code = usableCode(raw["costCode"]);
  if (code !== undefined) out.costCode = code;
  const items = readItems(raw["items"]);
  if (items.length > 0) out.items = items;
  return out;
}

/**
 * Merges a partial update of the scalar fields into current values: a key present with `undefined`
 * removes the attribute, an absent key is untouched, and every kept member is re-validated, so an
 * unusable patched value is dropped. `items` pass through unchanged.
 */
export function mergeCostValues(
  current: Readonly<CostValues>,
  patch: Readonly<CostPatch>,
): CostValues {
  const raw: Record<string, unknown> = { ...current };
  for (const key of ["fixedCost", "materialCost", "actualCost", "costCode"] as const) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value === undefined) delete raw[key];
    else raw[key] = value;
  }
  return readCostValues({ meta: { [COST_META_KEY]: raw } } as unknown as Task);
}

/**
 * Normalizes a cost-item init against a task's current items: returns the resolved item, or
 * `undefined` when the init is unusable (bad amount/type, or a supplied id already in use).
 */
export function resolveItemInit(
  current: readonly CostItem[],
  init: CostItemInit,
  generateId: () => string,
): CostItem | undefined {
  if (typeof init !== "object" || init === null) return undefined;
  if (!usableAmount(init.amount)) return undefined;
  const type = isCostType(init.type) ? init.type : undefined;
  if (type === undefined) return undefined;
  let id: string;
  if (init.id !== undefined) {
    if (typeof init.id !== "string" || init.id === "" || current.some((i) => i.id === init.id)) {
      return undefined;
    }
    id = init.id;
  } else {
    do id = generateId();
    while (current.some((i) => i.id === id));
  }
  return { id, label: typeof init.label === "string" ? init.label : "", amount: init.amount, type };
}

/* ------------------------------------------------------------------ *
 * The four write members (§1.3)
 * ------------------------------------------------------------------ */

/** The `CostService` members this module owns. */
export interface CostValueMembers {
  costValuesOf(id: TaskId): Readonly<CostValues>;
  setCostFields(id: TaskId, patch: Readonly<CostPatch>): void;
  addCostItem(id: TaskId, init: CostItemInit): string | undefined;
  removeCostItem(id: TaskId, itemId: string): void;
}

/** Builds the meta-bag write members over one `task/update` dispatch each (undoable). */
export function createCostValueMembers(
  ctx: Pick<PluginContext, "dispatch">,
  data: Pick<DataService, "getTask">,
): CostValueMembers {
  function writeValues(task: Readonly<Task>, values: Readonly<CostValues>): void {
    // §2.1: a NEW `meta` preserving sibling keys; an emptied bag drops `costTracking`; an emptied
    // `meta` goes out through the `clears` path rather than as `{}`.
    const patch = buildBagWrite(task, COST_META_KEY, values as unknown as Record<string, unknown>);
    ctx.dispatch("task/update", { id: task.id, ...patch });
  }

  function setCostFields(id: TaskId, patch: Readonly<CostPatch>): void {
    const task = data.getTask(id);
    if (task === undefined || typeof patch !== "object" || patch === null) return;
    const current = readCostValues(task);
    const merged = mergeCostValues(current, patch);
    // Skip the dispatch — and so the undo entry — when the patch resolves to exactly what is
    // already stored (e.g. the table panel's Apply re-sending an unedited cell). Both sides come
    // out of `readCostValues`'s fixed key order, so a structural comparison is exact.
    if (JSON.stringify(merged) === JSON.stringify(current)) return;
    writeValues(task, merged);
  }

  let nextItemId = 1;

  return {
    costValuesOf: (id) => readCostValues(data.getTask(id)),
    setCostFields,
    addCostItem(id, init) {
      const task = data.getTask(id);
      if (task === undefined) return undefined;
      const values = readCostValues(task);
      const item = resolveItemInit(values.items ?? [], init, () => `cost-item-${String(nextItemId++)}`);
      if (item === undefined) return undefined;
      writeValues(task, { ...values, items: [...(values.items ?? []), item] });
      return item.id;
    },
    removeCostItem(id, itemId) {
      const task = data.getTask(id);
      if (task === undefined) return;
      const values = readCostValues(task);
      const items = values.items ?? [];
      const kept = items.filter((i) => i.id !== itemId);
      if (kept.length === items.length) return;
      const next: CostValues = { ...values };
      if (kept.length === 0) delete next.items;
      else next.items = kept;
      writeValues(task, next);
    },
  };
}
