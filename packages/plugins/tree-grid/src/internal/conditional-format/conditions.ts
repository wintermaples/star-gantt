// docs/specs/plugins/tree-grid.md § Internal modules — condition evaluation.
/**
 * The pure condition-expression engine: field resolution and AND/OR/NOT evaluation over one task.
 * Evaluation is total — a malformed condition evaluates to `false`, never throws by itself.
 * (Hostile getters on `meta` can still throw; the caller's latched barrier owns that case.)
 */
import type { Task } from "@stargantt/plugin-data-store";
import type { Condition, ConditionOperator } from "../../types";

const OPERATORS: ReadonlySet<string> = new Set([
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "exists",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Resolves a dotted field path against a task.
 *
 * A path starting with `"meta"` walks `task.meta`; a path whose first segment is a direct
 * property of the task walks the task; any other first segment walks `task.meta` — so
 * `"priority"` and `"meta.priority"` read the same value. A missing or non-object step resolves
 * to `undefined`.
 */
export function resolveField(task: Readonly<Task>, path: string): unknown {
  const segments = path.split(".");
  let current: unknown;
  let start = 0;
  const first = segments[0];
  if (first === "meta") {
    current = task.meta;
    start = 1;
  } else if (first !== undefined && Object.hasOwn(task, first)) {
    // `in` walks the prototype chain, so a field path named e.g. `"constructor"` or `"toString"`
    // would resolve against `Object.prototype` instead of falling through to `task.meta`, which
    // is a task property in name only and never what a host-authored rule meant.
    current = task;
  } else {
    current = task.meta;
  }
  for (let i = start; i < segments.length; i++) {
    if (!isRecord(current)) return undefined;
    current = current[segments[i] as string];
  }
  return current;
}

function compare(actual: unknown, op: ConditionOperator, expected: unknown): boolean {
  switch (op) {
    case "eq":
      return actual === expected;
    case "neq":
      return actual !== expected;
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      const bothNumbers = typeof actual === "number" && typeof expected === "number";
      const bothStrings = typeof actual === "string" && typeof expected === "string";
      if (!bothNumbers && !bothStrings) return false;
      const a = actual as number | string;
      const b = expected as number | string;
      if (op === "lt") return a < b;
      if (op === "lte") return a <= b;
      if (op === "gt") return a > b;
      return a >= b;
    }
    case "in":
      return Array.isArray(expected) && expected.includes(actual);
    case "exists":
      return actual !== undefined && actual !== null;
    default: {
      // Exhaustiveness: a new operator must be handled above.
      const never: never = op;
      return never;
    }
  }
}

/**
 * Evaluates one condition against one task. Malformed nodes (non-objects, unknown operators,
 * non-array `all`/`any` lists) evaluate to `false`.
 */
export function evaluate(condition: Condition | unknown, task: Readonly<Task>): boolean {
  if (!isRecord(condition)) return false;
  if ("all" in condition) {
    const list = condition["all"];
    if (!Array.isArray(list)) return false;
    return list.every((c) => evaluate(c, task));
  }
  if ("any" in condition) {
    const list = condition["any"];
    if (!Array.isArray(list)) return false;
    return list.some((c) => evaluate(c, task));
  }
  if ("not" in condition) {
    return !evaluate(condition["not"], task);
  }
  const field = condition["field"];
  const op = condition["op"];
  if (typeof field !== "string" || typeof op !== "string" || !OPERATORS.has(op)) return false;
  return compare(resolveField(task, field), op as ConditionOperator, condition["value"]);
}
