// docs/specs/plugins/tree-grid.md § Internal modules — the storage model: field values live at
// `task.meta.taskFields`, read defensively, written as a whole new `meta` object.
import type { Task } from "@stargantt/plugin-data-store";
import type { TaskFieldValues, TaskFieldsPatch, TaskPriority, TaskStatus, TreeGridMessages } from "../../types";

/** The key under `task.meta` where this feature stores its values. */
export const META_KEY = "taskFields";

/** Status values in declaration order — also the sort order of the status column. */
export const STATUS_VALUES: readonly TaskStatus[] = [
  "not-started",
  "in-progress",
  "done",
  "on-hold",
];

/** Priority values, high first — also the sort order of the priority column. */
export const PRIORITY_VALUES: readonly TaskPriority[] = ["high", "medium", "low"];

function isStatus(v: unknown): v is TaskStatus {
  return (STATUS_VALUES as readonly unknown[]).includes(v);
}

function isPriority(v: unknown): v is TaskPriority {
  return (PRIORITY_VALUES as readonly unknown[]).includes(v);
}

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Normalizes a raw tag list: entries that are non-empty strings are kept in order, duplicates
 * collapsed. Returns `undefined` when nothing survives.
 */
export function normalizeTags(raw: unknown): readonly string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const tag = entry.trim();
    if (tag !== "") seen.add(tag);
  }
  return seen.size > 0 ? [...seen] : undefined;
}

/**
 * Reads a task's stored field values, dropping every member that does not have its documented
 * shape — an unusable value is treated as absent.
 */
export function fieldsOfTask(task: Readonly<Task> | undefined): Readonly<TaskFieldValues> {
  const raw = task?.meta?.[META_KEY];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: TaskFieldValues = {};
  if (isStatus(r["status"])) out.status = r["status"];
  if (isPriority(r["priority"])) out.priority = r["priority"];
  const tags = normalizeTags(r["tags"]);
  if (tags !== undefined) out.tags = tags;
  if (finite(r["deadline"])) out.deadline = r["deadline"];
  if (typeof r["notes"] === "string" && r["notes"] !== "") out.notes = r["notes"];
  if (finite(r["actualStart"])) out.actualStart = r["actualStart"];
  if (finite(r["actualEnd"])) out.actualEnd = r["actualEnd"];
  if (typeof r["customId"] === "string" && r["customId"] !== "") out.customId = r["customId"];
  return out;
}

/**
 * Merges a partial update into current values: a key present with `undefined` removes the field,
 * an absent key is untouched, and every kept member is re-validated through the same defensive
 * read as `fieldsOfTask`. Returns the merged bag (possibly empty).
 */
export function mergeFieldValues(
  current: Readonly<TaskFieldValues>,
  patch: Readonly<TaskFieldsPatch>,
): TaskFieldValues {
  const raw: Record<string, unknown> = { ...current };
  for (const key of Object.keys(patch) as (keyof TaskFieldValues)[]) {
    const value = patch[key];
    if (value === undefined) delete raw[key];
    else raw[key] = value;
  }
  // Re-validate through the same defensive reader so an unusable patched value is dropped.
  return { ...fieldsOfTask({ meta: { [META_KEY]: raw } } as unknown as Task) };
}

/**
 * Builds the new `meta` object that stores `fields`, preserving sibling `meta` keys. An empty
 * bag removes the `taskFields` key (and yields `undefined` when `meta` becomes empty), so a task
 * that loses its last field value round-trips through `toJSON()` without residue.
 */
export function metaWith(
  meta: Readonly<Record<string, unknown>> | undefined,
  fields: Readonly<TaskFieldValues>,
): Record<string, unknown> | undefined {
  const next: Record<string, unknown> = { ...meta };
  if (Object.keys(fields).length === 0) delete next[META_KEY];
  else next[META_KEY] = fields;
  return Object.keys(next).length === 0 ? undefined : next;
}

/**
 * Whether a task with the given field values is overdue: it has a deadline earlier than `now`
 * and its status is not `done`.
 */
export function isOverdueValues(fields: Readonly<TaskFieldValues>, now: number): boolean {
  return fields.deadline !== undefined && fields.deadline < now && fields.status !== "done";
}

/** The user-visible label of a status value, from the resolved catalog. */
export function statusLabel(messages: TreeGridMessages, status: TaskStatus): string {
  switch (status) {
    case "not-started":
      return messages.statusNotStarted;
    case "in-progress":
      return messages.statusInProgress;
    case "done":
      return messages.statusDone;
    case "on-hold":
      return messages.statusOnHold;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

/** The user-visible label of a priority value, from the resolved catalog. */
export function priorityLabel(messages: TreeGridMessages, priority: TaskPriority): string {
  switch (priority) {
    case "high":
      return messages.priorityHigh;
    case "medium":
      return messages.priorityMedium;
    case "low":
      return messages.priorityLow;
    default: {
      const exhaustive: never = priority;
      return exhaustive;
    }
  }
}
