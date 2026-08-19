// docs/specs/plugins/portfolio.md §3.4
/**
 * The formula-card registry: user-defined metric hooks, contained per evaluation (unlatched —
 * evaluation is data-driven, never per-frame).
 */
import type { Task } from "@stargantt/plugin-data-store";
import type { DashboardFormulaInit, FormulaValue } from "../../types";

export interface FormulaEntry {
  id: string;
  label: string;
  filter: ((task: Readonly<Task>) => boolean) | undefined;
  evaluate: (tasks: readonly Task[]) => number;
  format: ((value: number) => string) | undefined;
}

export interface FormulaRegistry {
  /** Adds or replaces a formula. Returns its id, or `undefined` for an unusable init. */
  define(init: DashboardFormulaInit): string | undefined;
  /** Removes a formula. Returns whether the id existed. */
  remove(id: string): boolean;
  list(): readonly FormulaEntry[];
}

export function createFormulaRegistry(nameOf: (ordinal: number) => string): FormulaRegistry {
  const entries = new Map<string, FormulaEntry>();
  let seq = 0;
  return {
    define(init: DashboardFormulaInit): string | undefined {
      if (init === null || typeof init !== "object" || typeof init.evaluate !== "function") {
        return undefined;
      }
      seq += 1;
      const id = typeof init.id === "string" && init.id !== "" ? init.id : `formula-${seq}`;
      entries.set(id, {
        id,
        label: typeof init.label === "string" && init.label !== "" ? init.label : nameOf(seq),
        filter: typeof init.filter === "function" ? init.filter : undefined,
        evaluate: init.evaluate,
        format: typeof init.format === "function" ? init.format : undefined,
      });
      return id;
    },
    remove: (id) => entries.delete(id),
    list: () => [...entries.values()],
  };
}

const defaultFormat = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(2);

/**
 * Evaluates every formula over the task set. Each host hook call is contained: a throwing
 * `filter` counts as matching nothing, a throwing/non-finite `evaluate` yields an error card,
 * a throwing `format` falls back to the default format. `onError` reports each containment.
 */
export function evaluateFormulas(
  registry: FormulaRegistry,
  tasks: readonly Task[],
  errorText: string,
  onError: (formulaId: string, cause: unknown) => void,
): FormulaValue[] {
  return registry.list().map((entry) => {
    let scope: readonly Task[] = tasks;
    if (entry.filter !== undefined) {
      try {
        const filter = entry.filter;
        scope = tasks.filter((t) => filter(t) === true);
      } catch (cause) {
        onError(entry.id, cause);
        scope = [];
      }
    }
    let value: number | undefined;
    try {
      const raw = entry.evaluate(scope);
      value = typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
    } catch (cause) {
      onError(entry.id, cause);
      value = undefined;
    }
    let text = errorText;
    if (value !== undefined) {
      text = defaultFormat(value);
      if (entry.format !== undefined) {
        try {
          const formatted = entry.format(value);
          if (typeof formatted === "string") text = formatted;
        } catch (cause) {
          onError(entry.id, cause);
        }
      }
    }
    return { id: entry.id, label: entry.label, value, text };
  });
}
