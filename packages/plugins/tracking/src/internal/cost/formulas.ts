// docs/specs/plugins/tracking.md §2.12 — custom cost formulas.
//
// Setup-time resolution: an omitted `id` becomes `formula-<n>` (n counted over USABLE inits), an
// omitted `label` becomes `messages.formulaName(n)`, a colliding id REPLACES its holder in place,
// and an init without a function `evaluate` is dropped.
//
// Evaluation is per table-panel open, in configuration order, over the LEAF rows, and is CONTAINED
// PER CALL and UNLATCHED (unlike the §2.13 `renderPanel` seam): a throw from `filter` / `evaluate` /
// `format` reports once through `onError` — the wiring maps that to `core/pluginError` with
// `where: "formulas.<id>"` — and drops the row FOR THAT RENDER ONLY, so a formula that keeps
// throwing keeps reporting. A non-finite `evaluate` result drops silently, with no report.
import type { Task } from "@stargantt/plugin-data-store";
import type {
  CostFormulaInit,
  CostFormulaInput,
  CostFormulaValue,
  CostValues,
} from "../../types";

/** One resolved custom formula: the `CostFormulaInit` with its id/label defaulted. */
export interface CostFormulaEntry {
  id: string;
  label: string;
  filter: ((task: Readonly<Task>, values: Readonly<CostValues>) => boolean) | undefined;
  evaluate: (input: Readonly<CostFormulaInput>) => number;
  format: ((value: number) => string) | undefined;
}

/** One row the formulas run over: a leaf task plus its stored manual values. */
export interface CostFormulaRow {
  task: Readonly<Task>;
  values: Readonly<CostValues>;
}

/** Resolves the configured inits into entries (§2.12's id/label/collision/drop rules). */
export function resolveCostFormulas(
  inits: readonly CostFormulaInit[],
  nameOf: (ordinal: number) => string,
): CostFormulaEntry[] {
  const entries = new Map<string, CostFormulaEntry>();
  let seq = 0;
  for (const init of inits) {
    if (init === null || typeof init !== "object" || typeof init.evaluate !== "function") continue;
    seq += 1;
    const id = typeof init.id === "string" && init.id !== "" ? init.id : `formula-${String(seq)}`;
    entries.set(id, {
      id,
      label: typeof init.label === "string" && init.label !== "" ? init.label : nameOf(seq),
      filter: typeof init.filter === "function" ? init.filter : undefined,
      evaluate: init.evaluate,
      format: typeof init.format === "function" ? init.format : undefined,
    });
  }
  return [...entries.values()];
}

/** Sums the numeric manual-cost fields over a row set; `costCode`/`items` are never aggregated. */
export function sumCostValues(
  rows: readonly { values: Readonly<CostValues> }[],
): Pick<CostValues, "fixedCost" | "materialCost" | "actualCost"> {
  let fixedCost = 0;
  let materialCost = 0;
  let actualCost = 0;
  for (const { values } of rows) {
    fixedCost += values.fixedCost ?? 0;
    materialCost += values.materialCost ?? 0;
    actualCost += values.actualCost ?? 0;
  }
  return { fixedCost, materialCost, actualCost };
}

/** {@link sumCostValues}, grouped by trimmed cost code; uncoded rows aggregate under `""`. */
export function groupCostValuesByCode(
  rows: readonly { values: Readonly<CostValues> }[],
): Map<string, Pick<CostValues, "fixedCost" | "materialCost" | "actualCost">> {
  const buckets = new Map<string, { values: Readonly<CostValues> }[]>();
  for (const row of rows) {
    const code = row.values.costCode ?? "";
    const list = buckets.get(code);
    if (list === undefined) buckets.set(code, [row]);
    else list.push(row);
  }
  const out = new Map<string, Pick<CostValues, "fixedCost" | "materialCost" | "actualCost">>();
  for (const [code, list] of buckets) out.set(code, sumCostValues(list));
  return out;
}

/**
 * Evaluates every custom formula over the row set. `filter`, `evaluate` and `format` are each
 * contained: a throw from any of them is reported once through `onError` and the formula is left
 * out of the result — UNLATCHED, so a formula that keeps throwing is reported again on every call
 * (§2.12), unlike the latched `renderPanel` seam (§2.13).
 */
export function evaluateCostFormulas(
  entries: readonly CostFormulaEntry[],
  rows: readonly CostFormulaRow[],
  statusDate: number | undefined,
  defaultFormat: (value: number) => string,
  onError: (formulaId: string, cause: unknown) => void,
): CostFormulaValue[] {
  const out: CostFormulaValue[] = [];
  for (const entry of entries) {
    let kept = rows;
    if (entry.filter !== undefined) {
      try {
        const filter = entry.filter;
        kept = rows.filter((r) => filter(r.task, r.values) === true);
      } catch (cause) {
        onError(entry.id, cause);
        continue;
      }
    }
    const input: CostFormulaInput = {
      rows: kept,
      totals: sumCostValues(kept),
      byCode: groupCostValuesByCode(kept),
      statusDate,
    };
    let value: number;
    try {
      const raw = entry.evaluate(input);
      // A non-finite result is dropped SILENTLY — it is a modelling outcome, not a fault.
      if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
      value = raw;
    } catch (cause) {
      onError(entry.id, cause);
      continue;
    }
    let text = defaultFormat(value);
    if (entry.format !== undefined) {
      try {
        const formatted = entry.format(value);
        if (typeof formatted === "string") text = formatted;
      } catch (cause) {
        onError(entry.id, cause);
        continue;
      }
    }
    out.push({ id: entry.id, label: entry.label, value, text });
  }
  return out;
}
