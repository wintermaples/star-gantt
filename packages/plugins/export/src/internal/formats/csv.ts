// docs/specs/plugins/export.md §1.4 — CSV parsing / serialization and header→field inference.
/** Hostless: pure functions over strings and task snapshots, unit-testable without a plugin host. */
import type { Task } from "@stargantt/plugin-data-store";
import type { CsvExportOptions, CsvMapping, ImportIssue, TaskCsvField } from "../../types";

export const CSV_FIELDS: readonly TaskCsvField[] = [
  "id",
  "parentId",
  "name",
  "start",
  "end",
  "progress",
  "type",
];

const FIELD_SET: ReadonlySet<string> = new Set(CSV_FIELDS);

/** Header aliases (§1.4 table), all compared after lowercasing and stripping non-alphanumerics. */
const ALIASES: Readonly<Record<string, TaskCsvField>> = {
  id: "id",
  taskid: "id",
  uid: "id",
  key: "id",
  parent: "parentId",
  parentid: "parentId",
  parenttask: "parentId",
  name: "name",
  title: "name",
  task: "name",
  taskname: "name",
  text: "name",
  summary: "name",
  start: "start",
  startdate: "start",
  begin: "start",
  begindate: "start",
  from: "start",
  end: "end",
  enddate: "end",
  finish: "end",
  finishdate: "end",
  due: "end",
  duedate: "end",
  to: "end",
  progress: "progress",
  percentcomplete: "progress",
  complete: "progress",
  done: "progress",
  type: "type",
  tasktype: "type",
  kind: "type",
};

function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Guesses one mapping entry per header; a header no alias matches maps to `null` (ignored). */
export function inferMapping(headers: readonly string[]): (TaskCsvField | null)[] {
  const used = new Set<TaskCsvField>();
  return headers.map((header) => {
    const field = ALIASES[normalizeHeader(String(header))];
    if (field === undefined || used.has(field)) return null;
    used.add(field);
    return field;
  });
}

/** RFC 4180-style tokenizer: quoted fields, doubled quotes, CR/LF/CRLF row breaks. */
export function parseCsvRows(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let sawAny = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      sawAny = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
      sawAny = true;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (sawAny || row.some((c) => c !== "")) rows.push(row);
      row = [];
      cell = "";
      sawAny = false;
    } else {
      cell += ch;
      sawAny = true;
    }
  }
  row.push(cell);
  if (sawAny || row.some((c) => c !== "")) rows.push(row);
  return rows;
}

// §1.4 — a bare-integer cell is a raw epoch-ms value, taken to mean literally
// "1970-01-01T00:00:00.000Z (ms 0) through 2200-12-31T23:59:59.999Z inclusive," with one
// deliberate carve-out: any *positive* value smaller than one day's worth of milliseconds is
// exactly the magnitude a spreadsheet's date **serial** number (a small integer day-count since
// ~1900, typically 4-6 digits) lands in when misread as milliseconds — it resolves to a nonsense
// instant a few seconds or minutes into 1970-01-01 rather than the modern date it actually
// encodes. `0` itself stays valid (a legitimate "epoch marker" start date, and the literal
// `1970-01-01` boundary), as does anything from one full day past it onward.
const ONE_DAY_MS = 86_400_000;
const MAX_BARE_INTEGER_DATE_MS = Date.UTC(2200, 11, 31, 23, 59, 59, 999);

/** Parses a date cell: epoch ms number, ISO-like calendar date (UTC midnight), or `Date.parse` text. */
export function parseDateCell(value: string): number | undefined {
  const text = value.trim();
  if (text === "") return undefined;
  if (/^-?\d+$/.test(text)) {
    const n = Number(text);
    if (!Number.isFinite(n)) return undefined;
    // §1.4 — out of the plausible epoch-ms window: reject rather than silently produce a task
    // dated in (or near) 1970, which is what an unvalidated spreadsheet date serial produces
    // when misread as milliseconds. `0` is the one exception in the implausible band (see above).
    if (n !== 0 && n < ONE_DAY_MS) return undefined;
    if (n > MAX_BARE_INTEGER_DATE_MS) return undefined;
    return n;
  }
  // 4-digit year, 1-2 digit month/day, joined by `-` or `/`.
  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(text);
  if (iso !== null) {
    const t = Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return Number.isFinite(t) ? t : undefined;
  }
  const t = Date.parse(text);
  return Number.isFinite(t) ? t : undefined;
}

/** Parses a progress cell: 0..1 fraction, `40%`, or 0..100 percent number. */
export function parseProgressCell(value: string): number | undefined {
  const trimmed = value.trim();
  // A `%` suffix is an explicit unit: the number is always a percentage, even at or below 1.
  const percent = trimmed.endsWith("%");
  const text = percent ? trimmed.slice(0, -1) : trimmed;
  if (text === "") return undefined;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) return undefined;
  const fraction = percent || n > 1 ? n / 100 : n;
  return fraction > 1 ? undefined : fraction;
}

export interface CsvParseResult {
  tasks: Task[];
  headers: string[];
  mapping: (TaskCsvField | null)[];
  issues: ImportIssue[];
}

function usableMapping(
  mapping: CsvMapping | undefined,
  width: number,
): (TaskCsvField | null)[] | undefined {
  if (!Array.isArray(mapping)) return undefined;
  const out: (TaskCsvField | null)[] = [];
  for (let i = 0; i < width; i++) {
    const entry: unknown = mapping[i];
    out.push(typeof entry === "string" && FIELD_SET.has(entry) ? (entry as TaskCsvField) : null);
  }
  return out;
}

/** One data row's mapped cells, keyed by the field each column carries. */
type RawRow = Partial<Record<TaskCsvField, string>>;

function readCells(cells: readonly string[], used: readonly (TaskCsvField | null)[]): RawRow {
  const raw: RawRow = {};
  for (let c = 0; c < used.length; c++) {
    const field = used[c];
    const cell = cells[c];
    if (field !== null && field !== undefined && cell !== undefined) raw[field] = cell;
  }
  return raw;
}

/** An empty cell is a missing field; a non-empty one that would not parse is a bad date. */
function dateIssue(field: "start" | "end", value: string | undefined, row: number): ImportIssue {
  if (value === undefined || value.trim() === "") return { code: "missing-field", field, row };
  return { code: "bad-date", field, value, row };
}

/** Copies the optional columns (parent, progress, type) onto a task, ignoring unusable values. */
function applyOptionalFields(task: Task, raw: RawRow): void {
  const parent = raw.parentId?.trim() ?? "";
  if (parent !== "") task.parentId = parent;
  const progress = raw.progress === undefined ? undefined : parseProgressCell(raw.progress);
  if (progress !== undefined) task.progress = progress;
  const type = raw.type?.trim();
  if (type === "task" || type === "summary" || type === "milestone") task.type = type;
}

/**
 * Turns one data row into a task, or records why it was skipped. `seen` holds the ids already
 * taken by earlier rows; an accepted row's id joins it.
 */
function readRow(
  raw: RawRow,
  rowNo: number,
  seen: Set<string>,
  issues: ImportIssue[],
): Task | undefined {
  const name = raw.name?.trim() ?? "";
  if (name === "") {
    issues.push({ code: "missing-field", field: "name", row: rowNo });
    return undefined;
  }
  const start = parseDateCell(raw.start ?? "");
  if (start === undefined) {
    issues.push(dateIssue("start", raw.start, rowNo));
    return undefined;
  }
  const end = parseDateCell(raw.end ?? "");
  if (end === undefined) {
    issues.push(dateIssue("end", raw.end, rowNo));
    return undefined;
  }
  if (end < start) {
    issues.push({ code: "invalid-row", row: rowNo, reason: "end before start" });
    return undefined;
  }
  const trimmedId = raw.id?.trim() ?? "";
  const id = trimmedId !== "" ? trimmedId : `import-${rowNo}`;
  if (seen.has(id)) {
    issues.push({ code: "duplicate-id", taskId: id, row: rowNo });
    return undefined;
  }
  seen.add(id);

  const task: Task = { id, parentId: null, name, start, end };
  applyOptionalFields(task, raw);
  return task;
}

/**
 * Parses CSV text (header row first) into normalized tasks (§1.4). Rows with an unusable name,
 * start or end are skipped with an issue; a missing id column mints `import-<row>` ids; duplicate
 * ids within the file keep the first row and flag the rest.
 */
export function parseCsvTasks(text: string, mapping?: CsvMapping, delimiter = ","): CsvParseResult {
  const rows = parseCsvRows(text, delimiter);
  const issues: ImportIssue[] = [];
  const tasks: Task[] = [];
  const headers = (rows[0] ?? []).map(String);
  const used = usableMapping(mapping, headers.length) ?? inferMapping(headers);
  const seen = new Set<string>();

  for (let r = 1; r < rows.length; r++) {
    // `r` doubles as the 1-based data row number (the header row is not counted).
    const task = readRow(readCells(rows[r] as string[], used), r, seen, issues);
    if (task !== undefined) tasks.push(task);
  }
  return { tasks, headers, mapping: used, issues };
}

function needsQuoting(cell: string, delimiter: string): boolean {
  return cell.includes(delimiter) || cell.includes('"') || cell.includes("\n") || cell.includes("\r");
}

function encodeCell(cell: string, delimiter: string): string {
  return needsQuoting(cell, delimiter) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

// The extreme epoch value `Date` can still represent (±100,000,000 days in ms).
const MAX_DATE_MS = 8.64e15;

/**
 * An ISO date-time for a task date, or the raw number as text when the value falls outside the
 * range `Date` can represent — export must return a string, never throw (§1.4). Shared with
 * `internal/excel/`'s cell-text bridge (§9's csv-wins merge ruling).
 */
export function isoOrRaw(epochMs: number): string {
  return Number.isFinite(epochMs) && Math.abs(epochMs) <= MAX_DATE_MS
    ? new Date(epochMs).toISOString()
    : String(epochMs);
}

/** One task's text for `field`, in the shared cell-text convention CSV and xlsx both use (§1.4/§1.8). */
export function cellOf(task: Readonly<Task>, field: TaskCsvField): string {
  switch (field) {
    case "id":
      return String(task.id);
    case "parentId":
      return task.parentId === null ? "" : String(task.parentId);
    case "name":
      return task.name;
    case "start":
      return isoOrRaw(task.start);
    case "end":
      return isoOrRaw(task.end);
    case "progress":
      return typeof task.progress === "number" && Number.isFinite(task.progress)
        ? String(task.progress)
        : "";
    case "type":
      return task.type ?? "";
  }
}

/** A requested column list narrowed to usable fields; empty result → all seven. */
export function usableColumns(columns: unknown): readonly TaskCsvField[] {
  const requested = Array.isArray(columns)
    ? columns.filter((c): c is TaskCsvField => typeof c === "string" && FIELD_SET.has(c))
    : [];
  return requested.length > 0 ? requested : CSV_FIELDS;
}

/** Serializes tasks to CSV: one header row of field names, then one row per task, CRLF-joined. */
export function serializeCsv(tasks: Iterable<Readonly<Task>>, options?: CsvExportOptions): string {
  const delimiter =
    typeof options?.delimiter === "string" && options.delimiter.length === 1 ? options.delimiter : ",";
  const columns = usableColumns(options?.columns);
  const lines: string[] = [columns.map((c) => encodeCell(c, delimiter)).join(delimiter)];
  for (const task of tasks) {
    lines.push(columns.map((c) => encodeCell(cellOf(task, c), delimiter)).join(delimiter));
  }
  return (options?.bom === true ? "﻿" : "") + lines.join("\r\n") + "\r\n";
}
