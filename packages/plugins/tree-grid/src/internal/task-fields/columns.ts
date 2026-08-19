// docs/specs/plugins/tree-grid.md § Config — the field-column contributions. Editable columns
// write through `ColumnDef.setValue` draft mutation (docs/specs/plugins/tree-grid.md § Internal
// modules): the draft's `meta` is replaced with a whole new object and the grid's ordinary diff
// produces the `task/update` transaction.
import { isoDay, parseIsoDateStrict } from "@stargantt/sdk";
import type { Task } from "@stargantt/plugin-data-store";
import type {
  ColumnDef,
  DurationUnit,
  TaskFieldsColumnId,
  TaskFieldsPatch,
  TaskPriority,
  TaskStatus,
  TreeGridMessages,
} from "../../types";
import {
  PRIORITY_VALUES,
  STATUS_VALUES,
  fieldsOfTask,
  isOverdueValues,
  mergeFieldValues,
  metaWith,
  normalizeTags,
  priorityLabel,
  statusLabel,
} from "./fields";
import { formatDuration, parseDurationInput } from "./duration";

/** Text glyph paired with each status label so meaning is never carried by color alone. */
const STATUS_GLYPH: Record<TaskStatus, string> = {
  "not-started": "○",
  "in-progress": "▶",
  done: "✓",
  "on-hold": "‖",
};

/** What the column builders need from the feature instance. */
export interface ColumnDeps {
  messages: TreeGridMessages;
  unit: DurationUnit;
  /** `customId` or the automatic sequence ID of the given task. */
  displayIdOf(task: Readonly<Task>): string;
  /** Comma-joined names of the task's assigned resources. */
  assigneeTextOf(task: Readonly<Task>): string;
  now(): number;
}

const ALL_COLUMN_IDS: readonly TaskFieldsColumnId[] = [
  "id",
  "status",
  "priority",
  "tags",
  "assignees",
  "deadline",
  "actualStart",
  "actualEnd",
  "duration",
];

/** Default contribution list when `TaskFieldsConfig.columns` is omitted. */
export const DEFAULT_COLUMNS: readonly TaskFieldsColumnId[] = ["status", "priority", "deadline"];

/** Narrows a raw `columns` config value: unusable/duplicate entries dropped; `[]` stays `[]`. */
export function resolveColumns(raw: unknown): readonly TaskFieldsColumnId[] {
  if (!Array.isArray(raw)) return DEFAULT_COLUMNS;
  const seen = new Set<TaskFieldsColumnId>();
  for (const entry of raw) {
    if ((ALL_COLUMN_IDS as readonly unknown[]).includes(entry)) {
      seen.add(entry as TaskFieldsColumnId);
    }
  }
  return [...seen];
}

/** Writes a merged fields bag back into a draft task (the grid's mutable-draft convention). */
function writeFields(task: Readonly<Task>, patch: Readonly<TaskFieldsPatch>): void {
  const merged = mergeFieldValues(fieldsOfTask(task), patch);
  const meta = metaWith(task.meta, merged);
  const draft = task as Task;
  // Never `delete draft.meta`: the grid's diff walks `Object.keys(draft)`, so a deleted key
  // produces no diff entry and the clear would silently dispatch nothing. An empty object still
  // drops the `taskFields` key while remaining visible to the diff; when `meta` was already
  // absent the draft is left untouched so a no-op clear dispatches nothing.
  if (meta !== undefined) draft.meta = meta;
  else if (draft.meta !== undefined) draft.meta = {};
}

/** Case-insensitive match of a committed cell text against a value key or its catalog label. */
function matchOption<T extends string>(
  raw: unknown,
  values: readonly T[],
  labelOf: (v: T) => string,
): T | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.trim().toLowerCase();
  if (text === "") return undefined;
  return values.find((v) => v.toLowerCase() === text || labelOf(v).toLowerCase() === text);
}

/**
 * Parses a committed `YYYY-MM-DD` cell text to epoch ms UTC; `""` = clear; else `undefined`.
 * The strict shared parse: a calendar-invalid date (`2024-02-30`) is rejected, not rolled over
 * onto a neighboring date.
 */
function parseDateInput(raw: unknown): number | "clear" | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  if (text === "") return "clear";
  return parseIsoDateStrict(text);
}

function orderIndex<T>(value: T | undefined, values: readonly T[]): number {
  if (value === undefined) return values.length;
  const i = values.indexOf(value);
  return i === -1 ? values.length : i;
}

function dateColumn(
  id: TaskFieldsColumnId,
  header: string,
  key: "deadline" | "actualStart" | "actualEnd",
  deps: ColumnDeps,
): ColumnDef {
  return {
    id: `taskfields-${id}`,
    header,
    width: 110,
    render(el, task) {
      const fields = fieldsOfTask(task);
      const t = fields[key];
      let text = t === undefined ? "" : (isoDay(t) ?? "");
      // The overdue mark is the " !" suffix, so the state is never conveyed by color alone.
      if (key === "deadline" && text !== "" && isOverdueValues(fields, deps.now())) text += " !";
      el.textContent = text;
    },
    getValue: (task) => {
      const t = fieldsOfTask(task)[key];
      return t === undefined ? "" : (isoDay(t) ?? "");
    },
    setValue(task, value) {
      const parsed = parseDateInput(value);
      if (parsed === undefined) return;
      writeFields(task, { [key]: parsed === "clear" ? undefined : parsed });
    },
  };
}

/** Builds the `ColumnDef` for one column id. */
function buildColumn(id: TaskFieldsColumnId, deps: ColumnDeps): ColumnDef {
  const { messages, unit } = deps;
  switch (id) {
    case "id":
      return {
        id: "taskfields-id",
        header: messages.idColumn,
        width: 70,
        render(el, task) {
          el.textContent = deps.displayIdOf(task);
        },
        getValue: (task) => deps.displayIdOf(task),
      };
    case "status":
      return {
        id: "taskfields-status",
        header: messages.statusColumn,
        width: 110,
        render(el, task) {
          const status = fieldsOfTask(task).status;
          el.textContent =
            status === undefined ? "" : `${STATUS_GLYPH[status]} ${statusLabel(messages, status)}`;
        },
        getValue: (task) => {
          const status = fieldsOfTask(task).status;
          return status === undefined ? "" : statusLabel(messages, status);
        },
        setValue(task, value) {
          const status = matchOption<TaskStatus>(value, STATUS_VALUES, (s) =>
            statusLabel(messages, s),
          );
          if (status !== undefined) writeFields(task, { status });
        },
        compare: (a, b) =>
          orderIndex(fieldsOfTask(a).status, STATUS_VALUES) -
          orderIndex(fieldsOfTask(b).status, STATUS_VALUES),
      };
    case "priority":
      return {
        id: "taskfields-priority",
        header: messages.priorityColumn,
        width: 90,
        render(el, task) {
          const p = fieldsOfTask(task).priority;
          el.textContent = p === undefined ? "" : priorityLabel(messages, p);
        },
        getValue: (task) => {
          const p = fieldsOfTask(task).priority;
          return p === undefined ? "" : priorityLabel(messages, p);
        },
        setValue(task, value) {
          const priority = matchOption<TaskPriority>(value, PRIORITY_VALUES, (p) =>
            priorityLabel(messages, p),
          );
          if (priority !== undefined) writeFields(task, { priority });
        },
        compare: (a, b) =>
          orderIndex(fieldsOfTask(a).priority, PRIORITY_VALUES) -
          orderIndex(fieldsOfTask(b).priority, PRIORITY_VALUES),
      };
    case "tags":
      return {
        id: "taskfields-tags",
        header: messages.tagsColumn,
        width: 140,
        render(el, task) {
          el.textContent = (fieldsOfTask(task).tags ?? []).join(", ");
        },
        getValue: (task) => (fieldsOfTask(task).tags ?? []).join(", "),
        setValue(task, value) {
          if (typeof value !== "string") return;
          const tags = normalizeTags(value.split(","));
          writeFields(task, { tags });
        },
      };
    case "assignees":
      return {
        id: "taskfields-assignees",
        header: messages.assigneesColumn,
        width: 140,
        render(el, task) {
          el.textContent = deps.assigneeTextOf(task);
        },
        getValue: (task) => deps.assigneeTextOf(task),
      };
    case "deadline":
      return dateColumn(id, messages.deadlineColumn, "deadline", deps);
    case "actualStart":
      return dateColumn(id, messages.actualStartColumn, "actualStart", deps);
    case "actualEnd":
      return dateColumn(id, messages.actualEndColumn, "actualEnd", deps);
    case "duration":
      return {
        id: "taskfields-duration",
        header: messages.durationColumn,
        width: 90,
        render(el, task) {
          el.textContent = formatDuration(unit, task.start, task.end);
        },
        getValue: (task) => formatDuration(unit, task.start, task.end),
        setValue(task, value) {
          const ms = parseDurationInput(unit, value);
          if (ms === undefined) return;
          // The committed value moves `end` only ("Duration units"). Unlike every other editable
          // column here, this one skips `writeFields`'s meta-replacement convention: `end` is a
          // first-class `Task` field, not one of the `meta.taskFields` custom values `writeFields`
          // merges and rewrites as a whole object, so it is mutated on the draft directly — the
          // grid's diff walks `Object.keys(draft)` and picks up `end` like any other own property.
          (task as Task).end = task.start + ms;
        },
      };
    default: {
      const exhaustive: never = id;
      return exhaustive;
    }
  }
}

/** The column contributions for the resolved id list, in list order. */
export function buildColumns(
  ids: readonly TaskFieldsColumnId[],
  deps: ColumnDeps,
): ColumnDef[] {
  return ids.map((id) => buildColumn(id, deps));
}
