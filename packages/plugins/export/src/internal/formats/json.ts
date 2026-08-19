// docs/specs/plugins/export.md §1.5 — StarGantt project JSON serialization and tolerant JSON
// import (own schema, bare task arrays, and common foreign task-list key spellings). Hostless.
import type { Assignment, DataService, Link, Resource, Task } from "@stargantt/plugin-data-store";
import type { ImportDocument, ImportIssue } from "../../types";
import { parseDateCell, parseProgressCell } from "./csv";

/** The schema tag `exportJson` writes and `parseJsonDocument` recognizes. */
export const JSON_SCHEMA = "stargantt/v1";

export function serializeProject(data: Pick<DataService, "toJSON">): string {
  return JSON.stringify({ schema: JSON_SCHEMA, ...data.toJSON() }, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pick(raw: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (raw[key] !== undefined) return raw[key];
  }
  return undefined;
}

function asId(value: unknown): string | number | undefined {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function asDate(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return parseDateCell(value);
  return undefined;
}

/** Normalizes one task-like object; returns an issue instead when it is unusable. */
function normalizeTask(raw: unknown, index: number): { task?: Task; issue?: ImportIssue } {
  if (!isRecord(raw)) return { issue: { code: "invalid-row", row: index + 1, reason: "not an object" } };
  const name = pick(raw, ["name", "title", "text", "summary"]);
  if (typeof name !== "string" || name.trim() === "") {
    return { issue: { code: "missing-field", field: "name", row: index + 1 } };
  }
  const start = asDate(pick(raw, ["start", "startDate", "start_date", "begin"]));
  if (start === undefined) return { issue: { code: "missing-field", field: "start", row: index + 1 } };
  const end = asDate(pick(raw, ["end", "endDate", "end_date", "finish", "due"]));
  if (end === undefined) return { issue: { code: "missing-field", field: "end", row: index + 1 } };
  if (end < start) return { issue: { code: "invalid-row", row: index + 1, reason: "end before start" } };

  const id = asId(pick(raw, ["id", "uid", "key"])) ?? `import-${index + 1}`;
  const task: Task = { id, parentId: null, name: name.trim(), start, end };
  const parent = asId(pick(raw, ["parentId", "parent", "parent_id"]));
  if (parent !== undefined) task.parentId = parent;
  const progressRaw = pick(raw, ["progress", "percentComplete", "percent_complete"]);
  const progress =
    typeof progressRaw === "number"
      ? parseProgressCell(String(progressRaw))
      : typeof progressRaw === "string"
        ? parseProgressCell(progressRaw)
        : undefined;
  if (progress !== undefined) task.progress = progress;
  const type = pick(raw, ["type"]);
  if (type === "task" || type === "summary" || type === "milestone") task.type = type;
  if (isRecord(raw["meta"])) task.meta = raw["meta"];
  return { task };
}

function normalizeLink(raw: unknown, index: number): Link | undefined {
  if (!isRecord(raw)) return undefined;
  const sourceId = asId(pick(raw, ["sourceId", "source", "from"]));
  const targetId = asId(pick(raw, ["targetId", "target", "to"]));
  if (sourceId === undefined || targetId === undefined) return undefined;
  const typeRaw = raw["type"];
  const type = typeRaw === "FS" || typeRaw === "SS" || typeRaw === "FF" || typeRaw === "SF" ? typeRaw : "FS";
  const link: Link = { id: asId(raw["id"]) ?? `import-link-${index + 1}`, sourceId, targetId, type };
  if (typeof raw["lag"] === "number" && Number.isFinite(raw["lag"])) link.lag = raw["lag"];
  return link;
}

function normalizeResource(raw: unknown): Resource | undefined {
  if (!isRecord(raw)) return undefined;
  const id = asId(raw["id"]);
  const name = raw["name"];
  if (id === undefined || typeof name !== "string" || name === "") return undefined;
  const resource: Resource = { id, name };
  if (typeof raw["capacity"] === "number" && Number.isFinite(raw["capacity"])) {
    resource.capacity = raw["capacity"];
  }
  return resource;
}

function normalizeAssignment(raw: unknown): Assignment | undefined {
  if (!isRecord(raw)) return undefined;
  const taskId = asId(raw["taskId"]);
  const resourceId = asId(raw["resourceId"]);
  const units = raw["units"];
  if (taskId === undefined || resourceId === undefined) return undefined;
  return {
    taskId,
    resourceId,
    units: typeof units === "number" && Number.isFinite(units) && units > 0 ? units : 1,
  };
}

/**
 * The task array: the parsed value itself, its `tasks` property, or `data.tasks`. `undefined`
 * means no task array was found — including an empty `data.tasks`, which is too weak a signal to
 * read the value as a document (an empty top-level array or an empty `tasks` property is not).
 */
function findTaskArray(parsed: unknown): unknown[] | undefined {
  if (Array.isArray(parsed)) return parsed;
  if (!isRecord(parsed)) return undefined;
  const tasks = parsed["tasks"];
  if (Array.isArray(tasks)) return tasks;
  const data = parsed["data"];
  if (isRecord(data) && Array.isArray(data["tasks"]) && data["tasks"].length > 0) return data["tasks"];
  return undefined;
}

/** Normalizes every task row into the document, dropping duplicates with an issue. */
function collectTasks(rawTasks: readonly unknown[], doc: ImportDocument): void {
  const seen = new Set<string>();
  rawTasks.forEach((raw, index) => {
    const { task, issue } = normalizeTask(raw, index);
    if (issue !== undefined) {
      doc.issues.push(issue);
      return;
    }
    if (task === undefined) return;
    const key = String(task.id);
    if (seen.has(key)) {
      doc.issues.push({ code: "duplicate-id", taskId: task.id, row: index + 1 });
      return;
    }
    seen.add(key);
    doc.tasks.push(task);
  });
}

/** The document's optional `links` / `resources` / `assignments` arrays; unusable rows are dropped. */
function collectRelated(parsed: Record<string, unknown>, doc: ImportDocument): void {
  const links = parsed["links"];
  if (Array.isArray(links)) {
    links.forEach((raw, i) => {
      const link = normalizeLink(raw, i);
      if (link !== undefined) doc.links.push(link);
    });
  }
  const resources = parsed["resources"];
  if (Array.isArray(resources)) {
    for (const raw of resources) {
      const resource = normalizeResource(raw);
      if (resource !== undefined) doc.resources.push(resource);
    }
  }
  const assignments = parsed["assignments"];
  if (Array.isArray(assignments)) {
    for (const raw of assignments) {
      const assignment = normalizeAssignment(raw);
      if (assignment !== undefined) doc.assignments.push(assignment);
    }
  }
}

/** Parses JSON text into a normalized document; a syntax error yields one `invalid-json` issue. */
export function parseJsonDocument(text: string): ImportDocument {
  const doc: ImportDocument = {
    format: "json",
    tasks: [],
    links: [],
    resources: [],
    assignments: [],
    issues: [],
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    doc.issues.push({ code: "invalid-json", reason: error instanceof Error ? error.message : String(error) });
    return doc;
  }
  const rawTasks = findTaskArray(parsed);
  if (rawTasks === undefined) {
    doc.issues.push({ code: "invalid-json", reason: "no task array found" });
    return doc;
  }
  collectTasks(rawTasks, doc);
  if (isRecord(parsed)) collectRelated(parsed, doc);
  return doc;
}
