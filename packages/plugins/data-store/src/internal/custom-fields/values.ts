// docs/specs/plugins/data-store.md — Services (`stargantt.fields`): the storage model (values at
// `task.meta.customFields`, read defensively, written as a whole new `meta` object preserving
// sibling and unknown keys) and formula evaluation over a task with a cycle guard.
import { MS_DAY, isoDay } from "@stargantt/sdk";
import type { CustomFieldValue, Task } from "../../types";
import type { FieldEntry } from "./definitions";
import { evaluateFormula, formatNumber } from "./formula";
import type { FormulaValue } from "./formula";

/** The key under `task.meta` where this plugin stores its values. */
export const META_KEY = "customFields";

/** The raw stored bag read out of a `meta` object, `{}` when absent or not a plain object. */
function bagOfMeta(meta: Readonly<Task>["meta"]): Record<string, unknown> {
  const raw = meta?.[META_KEY];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

/** The raw stored bag of a task, `{}` when absent or not a plain object. */
function bagOf(task: Readonly<Task> | undefined): Record<string, unknown> {
  return bagOfMeta(task?.meta);
}

/**
 * Whether a raw value has the documented shape for its field's declared type. Unusable values
 * are treated as absent on read and rejected on write.
 */
export function isUsableValue(field: FieldEntry, value: unknown): value is CustomFieldValue {
  switch (field.type) {
    case "text":
      return typeof value === "string" && value !== "";
    case "select":
      return typeof value === "string" && field.options.includes(value);
    case "number":
    case "date":
      return typeof value === "number" && Number.isFinite(value);
    case "formula":
      return false; // formula results are never stored
    default: {
      const exhaustive: never = field.type;
      return exhaustive;
    }
  }
}

/** A stored field's value for a task, `undefined` when absent or unusable. */
export function storedValueOf(
  field: FieldEntry,
  task: Readonly<Task> | undefined,
): CustomFieldValue | undefined {
  const raw = bagOf(task)[field.key];
  return isUsableValue(field, raw) ? raw : undefined;
}

/**
 * Builds the new `meta` object storing `value` under the field's key (or removing the key when
 * `value` is `undefined`). Sibling `meta` keys and unknown field keys are preserved; removing
 * the last entry removes the `customFields` key, and an empty `meta` yields `undefined` so the
 * caller can clear it (task round-trips through `toJSON()` without residue).
 */
function metaWithValueOf(
  meta: Readonly<Task>["meta"],
  key: string,
  value: CustomFieldValue | undefined,
): Record<string, unknown> | undefined {
  const bag: Record<string, unknown> = { ...bagOfMeta(meta) };
  if (value === undefined) delete bag[key];
  else bag[key] = value;
  const next: Record<string, unknown> = { ...meta };
  if (Object.keys(bag).length === 0) delete next[META_KEY];
  else next[META_KEY] = bag;
  return Object.keys(next).length === 0 ? undefined : next;
}

export function metaWithValue(
  task: Readonly<Task>,
  key: string,
  value: CustomFieldValue | undefined,
): Record<string, unknown> | undefined {
  return metaWithValueOf(task.meta, key, value);
}

/**
 * Folds several `(key, value)` writes onto a task's stored `meta`, applying them in list order —
 * a later entry for the same key overrides an earlier one. This is `metaWithValueOf` run
 * repeatedly against the running `meta` value itself, which is what lets several
 * `setValue`-shaped writes for one task collapse into the single `meta` object one transaction
 * needs (`setValues`) without rebuilding a synthetic `Task` on every entry.
 */
export function metaAfterEntries(
  task: Readonly<Task>,
  entries: readonly { key: string; value: CustomFieldValue | undefined }[],
): Record<string, unknown> | undefined {
  let meta = task.meta;
  for (const entry of entries) {
    meta = metaWithValueOf(meta, entry.key, entry.value);
  }
  return meta;
}

/**
 * Evaluates one formula field for a task. Identifiers resolve to a declared field by key first
 * (formula fields recurse, guarded against reference cycles), then to the built-ins `name`,
 * `start`, `end`, `duration` (calendar days) and `progress`. Every failure — including a cycle —
 * yields `undefined` for this task only.
 */
export function computeFormula(
  field: FieldEntry,
  task: Readonly<Task>,
  fieldsByKey: ReadonlyMap<string, FieldEntry>,
  evaluating: Set<string> = new Set(),
): FormulaValue | undefined {
  if (field.ast === undefined || evaluating.has(field.key)) return undefined;
  evaluating.add(field.key);
  const result = evaluateFormula(field.ast, (name) => {
    const ref = fieldsByKey.get(name);
    if (ref !== undefined) {
      if (ref.type === "formula") {
        const v = computeFormula(ref, task, fieldsByKey, evaluating);
        // Booleans exist only inside an expression; a boolean reference result is a failure.
        return typeof v === "boolean" ? undefined : v;
      }
      return storedValueOf(ref, task);
    }
    switch (name) {
      case "name":
        return task.name;
      case "start":
        return task.start;
      case "end":
        return task.end;
      case "duration":
        return (task.end - task.start) / MS_DAY;
      case "progress":
        return typeof task.progress === "number" && Number.isFinite(task.progress)
          ? task.progress
          : 0;
      default:
        return undefined;
    }
  });
  evaluating.delete(field.key);
  return result;
}

/**
 * The value of any field for a task: stored fields read the bag, formula fields compute. A
 * top-level boolean result is a failure — the public value type is `string | number`.
 */
export function valueOfField(
  field: FieldEntry,
  task: Readonly<Task> | undefined,
  fieldsByKey: ReadonlyMap<string, FieldEntry>,
): CustomFieldValue | undefined {
  if (task === undefined) return undefined;
  if (field.type !== "formula") return storedValueOf(field, task);
  const result = computeFormula(field, task, fieldsByKey);
  return typeof result === "boolean" ? undefined : result;
}

/** The value formatted exactly as its grid cell shows it; `""` when there is none. */
export function displayValueOf(
  field: FieldEntry,
  task: Readonly<Task> | undefined,
  fieldsByKey: ReadonlyMap<string, FieldEntry>,
): string {
  const value = valueOfField(field, task, fieldsByKey);
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  return field.type === "date" ? (isoDay(value) ?? "") : formatNumber(value);
}
