// docs/specs/plugins/interaction.md §6.7 (encoding) and §4 `clipboard/paste` (parsing).
/**
 * The tab-separated cell encoding: what a copy writes for spreadsheets and what a paste reads back
 * from them. Pure module — no host, no DOM.
 */
import { isoDay } from "@stargantt/sdk";

/** A grid field the TSV encoding covers. */
export type ClipboardColumnId = "name" | "start" | "end" | "progress";

// docs/specs/plugins/interaction.md §6.7 — the default column order.
export const DEFAULT_COLUMNS: readonly ClipboardColumnId[] = ["name", "start", "end", "progress"];

const KNOWN_COLUMNS = new Set<string>(DEFAULT_COLUMNS);

/**
 * The configured column list with unusable entries dropped, or the default when the result is
 * empty — a zero-column encoding cannot round-trip anything (§6.7: "empty/unusable list restores
 * the default").
 */
export function resolveColumns(configured: unknown): readonly ClipboardColumnId[] {
  if (!Array.isArray(configured)) return DEFAULT_COLUMNS;
  const usable = configured.filter(
    (c): c is ClipboardColumnId => typeof c === "string" && KNOWN_COLUMNS.has(c),
  );
  return usable.length > 0 ? usable : DEFAULT_COLUMNS;
}

/** The fields of one row the encoding covers; a subset of the store's `Task`. */
export interface CellFields {
  name?: string;
  /** Epoch ms, UTC-fixed. */
  start?: number;
  /** Epoch ms, UTC-fixed, exclusive. */
  end?: number;
  /** 0..1 */
  progress?: number;
}

function formatCell(fields: CellFields, column: ClipboardColumnId): string {
  switch (column) {
    case "name":
      return fields.name ?? "";
    case "start":
    case "end": {
      const value = fields[column];
      return value === undefined ? "" : (isoDay(value) ?? "");
    }
    case "progress":
      return fields.progress === undefined ? "" : String(fields.progress);
    default: {
      const exhaustive: never = column;
      return exhaustive;
    }
  }
}

/** One TSV line per row, cells in `columns` order, rows joined by `\n`. */
export function serializeRows(
  rows: readonly CellFields[],
  columns: readonly ClipboardColumnId[],
): string {
  return rows.map((row) => columns.map((c) => formatCell(row, c)).join("\t")).join("\n");
}

/** Splits pasted text into rows and cells; one trailing empty row (a final newline) is dropped. */
export function splitTsv(text: string): string[][] {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => line.split("\t"));
}

// §4 `clipboard/paste` — a date cell accepts a UTC ISO day or anything `Date.parse` accepts; an
// unusable cell leaves its field alone.
function parseDate(cell: string): number | undefined {
  const t = Date.parse(cell);
  return Number.isFinite(t) ? t : undefined;
}

// A progress cell accepts `0..1`, a `%`-suffixed number, or a bare number in `(1..100]` read as a
// percentage.
function parseProgress(cell: string): number | undefined {
  const percent = cell.endsWith("%");
  const n = Number(percent ? cell.slice(0, -1) : cell);
  if (!Number.isFinite(n)) return undefined;
  const value = percent || (n > 1 && n <= 100) ? n / 100 : n;
  return value >= 0 && value <= 1 ? value : undefined;
}

/**
 * Reads one TSV row's cells (in `columns` order) into the fields they usably express. Empty and
 * unusable cells contribute nothing.
 */
export function parseRow(cells: readonly string[], columns: readonly ClipboardColumnId[]): CellFields {
  const fields: CellFields = {};
  columns.forEach((column, i) => {
    const cell = (cells[i] ?? "").trim();
    if (cell === "") return;
    switch (column) {
      case "name":
        fields.name = cell;
        break;
      case "start":
      case "end": {
        const t = parseDate(cell);
        if (t !== undefined) fields[column] = t;
        break;
      }
      case "progress": {
        const p = parseProgress(cell);
        if (p !== undefined) fields.progress = p;
        break;
      }
      default: {
        const exhaustive: never = column;
        void exhaustive;
      }
    }
  });
  return fields;
}
