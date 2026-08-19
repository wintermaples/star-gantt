// docs/specs/plugins/tree-grid.md § Extension points — the `taskbars/style` resolution order:
// rules (array order, first match) → overdue preset → priority preset. Every color the resolver
// answers with goes through the color resolver first, so a theme token becomes a paintable value.
/**
 * The bar-color resolver behind the single bar-style contribution, and the rule state it reads.
 */
import type { Task } from "@stargantt/plugin-data-store";
import type { ConditionalFormatRule } from "../../types";
import type { BarStyle } from "../upward";
import type { ColorResolver } from "./color";
import { evaluate } from "./conditions";
import type { ResolvedConfig } from "./config";
import { normalizePriorityColors, normalizeRules } from "./config";

/**
 * True when the task's end has passed while its progress is below 1. Summaries are excluded —
 * their dates are rollups, and warning every summary of one late leaf is noise.
 */
export function isOverdue(task: Readonly<Task>, now: number): boolean {
  if (task.type === "summary") return false;
  return task.end <= now && (task.progress ?? 0) < 1;
}

/** The style provider plus the rule state it reads. */
export interface StyleResolver {
  /** The bar-style provider: the bar style for one task, or `undefined` to decline. */
  style(task: Readonly<Task>): BarStyle | undefined;
  /** The rules currently in effect, in evaluation order. Never mutated in place. */
  rules(): readonly ConditionalFormatRule[];
  /** The priority → color pairs currently in effect, in lookup order. */
  priorityColors(): readonly (readonly [string, string])[];
  /** Replaces the rule list; unusable entries are dropped. */
  setRules(rules: unknown): void;
  /** Replaces the priority → color map; unusable entries are dropped. */
  setPriorityColors(colors: unknown): void;
}

/**
 * Builds the style resolver: per task, the first hit of rules → overdue → priorityColors wins;
 * tasks matching nothing, and tasks whose winning color cannot be resolved, yield `undefined` so
 * downstream bar-style providers may answer.
 */
export function createStyleResolver(
  resolved: Pick<ResolvedConfig, "rules" | "priorityColors" | "overdue" | "now">,
  color: ColorResolver,
): StyleResolver {
  let rules: readonly ConditionalFormatRule[] = resolved.rules;
  let priorityPairs: readonly (readonly [string, string])[] = resolved.priorityColors;
  let priorityMap = new Map(resolved.priorityColors);

  /** Wraps a winning color, or declines when it resolves to nothing (the color is reported). */
  const styleOf = (raw: string): BarStyle | undefined => {
    const value = color(raw);
    return value === "" ? undefined : { color: value };
  };

  return {
    style: (task) => {
      for (const rule of rules) {
        if (rule.style.color !== undefined && evaluate(rule.when, task)) {
          return styleOf(rule.style.color);
        }
      }
      if (resolved.overdue !== null && isOverdue(task, resolved.now())) {
        return styleOf(resolved.overdue.color);
      }
      if (priorityMap.size > 0) {
        const priority = task.meta?.["priority"];
        if (priority !== undefined && priority !== null) {
          const raw = priorityMap.get(String(priority));
          if (raw !== undefined) return styleOf(raw);
        }
      }
      return undefined;
    },
    rules: () => rules,
    priorityColors: () => priorityPairs,
    setRules: (next) => {
      rules = normalizeRules(next);
    },
    setPriorityColors: (next) => {
      priorityPairs = normalizePriorityColors(next);
      priorityMap = new Map(priorityPairs);
    },
  };
}
