// docs/specs/plugins/tracking.md §2.15 (custom KPI tiles) — the dashboard's
// formula registry: normalized once at setup, evaluated per panel open, every host call contained
// per call and UNLATCHED (evaluation is data-driven, never per-frame).
//
// §2.15's explicit note: an omitted `label` falls back to the RESOLVED id — deliberately NOT the
// `formulaName` builder, which is the cost area's alone.
import type { EvmFormulaInit, EvmFormulaInput, EvmKpiTile } from "../../types";

/** One usable formula, after the defensive read of its init. */
export interface EvmFormulaEntry {
  id: string;
  label: string;
  evaluate: (input: Readonly<EvmFormulaInput>) => number;
  format: ((value: number) => string) | undefined;
}

/**
 * Reads the configured formulas defensively: an init that is not an object, or carries no
 * `evaluate` function, is dropped; a missing id is generated as `formula-<n>` with `n` counted over
 * the USABLE inits; a missing label falls back to the resolved id; a colliding id replaces its
 * holder in place, keeping the original position.
 */
export function normalizeFormulas(
  inits: readonly EvmFormulaInit[] | undefined,
): EvmFormulaEntry[] {
  if (!Array.isArray(inits)) return [];
  const entries = new Map<string, EvmFormulaEntry>();
  let seq = 0;
  for (const init of inits as readonly (EvmFormulaInit | undefined)[]) {
    if (typeof init !== "object" || init === null) continue;
    if (typeof init.evaluate !== "function") continue;
    seq += 1;
    const id = typeof init.id === "string" && init.id !== "" ? init.id : `formula-${String(seq)}`;
    entries.set(id, {
      id,
      label: typeof init.label === "string" && init.label !== "" ? init.label : id,
      evaluate: init.evaluate,
      format: typeof init.format === "function" ? init.format : undefined,
    });
  }
  return [...entries.values()];
}

/**
 * Evaluates every formula into a tile, in configuration order. A throwing `evaluate` is reported
 * (`where: "formulas.<id>.evaluate"`) and drops its tile; a non-finite result drops it silently (an
 * unusable value); a throwing `format` is reported
 * (`where: "formulas.<id>.format"`) and the default formatting answers that call.
 *
 * Formula tiles deliberately carry no gloss (§2.15) — the plugin has no plain-language text for a
 * figure only the host knows the meaning of.
 */
export function formulaTiles(
  entries: readonly EvmFormulaEntry[],
  input: Readonly<EvmFormulaInput>,
  defaultFormat: (value: number) => string,
  onError: (where: string, cause: unknown) => void,
): EvmKpiTile[] {
  const tiles: EvmKpiTile[] = [];
  for (const entry of entries) {
    let value: number;
    try {
      value = entry.evaluate(input);
    } catch (cause) {
      onError(`formulas.${entry.id}.evaluate`, cause);
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    let text = defaultFormat(value);
    if (entry.format !== undefined) {
      try {
        const formatted = entry.format(value);
        if (typeof formatted === "string") text = formatted;
      } catch (cause) {
        onError(`formulas.${entry.id}.format`, cause);
      }
    }
    tiles.push({ label: entry.label, value: text });
  }
  return tiles;
}
