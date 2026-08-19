// docs/specs/plugins/data-store.md — Config (`customFields.fields`): definition resolution — the
// `fields` config array is narrowed once at setup(); unusable entries are silently dropped.
import type { CustomFieldType, ResolvedCustomField } from "../../types";
import type { FormulaNode } from "./formula";
import { parseFormula } from "./formula";

const FIELD_TYPES: readonly CustomFieldType[] = ["text", "number", "date", "select", "formula"];

export const DEFAULT_WIDTH = 110;

/** A resolved definition plus, for formula fields, its parsed expression. */
export interface FieldEntry extends ResolvedCustomField {
  /** Present exactly on `formula` fields. */
  readonly ast?: FormulaNode;
}

/** Normalizes a raw option list: non-empty strings, order kept, duplicates collapsed. */
function normalizeOptions(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry === "string" && entry.trim() !== "") seen.add(entry);
  }
  return [...seen];
}

/** The declared field type; a missing one means `text`, an unknown one drops the entry. */
function readType(raw: unknown): CustomFieldType | undefined {
  if (raw === undefined) return "text";
  return (FIELD_TYPES as readonly unknown[]).includes(raw) ? (raw as CustomFieldType) : undefined;
}

/** The select options; `undefined` drops the entry (a `select` with no usable option). */
function readOptions(type: CustomFieldType, raw: unknown): readonly string[] | undefined {
  if (type !== "select") return [];
  const options = normalizeOptions(raw);
  return options.length === 0 ? undefined : options;
}

/** The declared column width in CSS px; anything unusable falls back to the default. */
function readWidth(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_WIDTH;
}

/** Narrows one raw definition entry; `undefined` = drop it. */
function resolveOne(raw: unknown, taken: Set<string>): FieldEntry | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const key = r["key"];
  if (typeof key !== "string" || key.trim() === "" || taken.has(key)) return undefined;
  const type = readType(r["type"]);
  if (type === undefined) return undefined;
  const options = readOptions(type, r["options"]);
  if (options === undefined) return undefined;
  const source = r["formula"];
  let ast: FormulaNode | undefined;
  if (type === "formula") {
    ast = parseFormula(source);
    if (ast === undefined) return undefined;
  }
  return {
    key,
    type,
    label: typeof r["label"] === "string" && r["label"] !== "" ? r["label"] : key,
    width: readWidth(r["width"]),
    options,
    formula: ast !== undefined && typeof source === "string" ? source : "",
    column: r["column"] !== false,
    ...(ast !== undefined ? { ast } : {}),
  };
}

/** Resolves the whole `fields` config value, in order; a non-array yields no fields. */
export function resolveFields(raw: unknown): readonly FieldEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: FieldEntry[] = [];
  const taken = new Set<string>();
  for (const entry of raw) {
    const resolved = resolveOne(entry, taken);
    if (resolved !== undefined) {
      taken.add(resolved.key);
      out.push(resolved);
    }
  }
  return out;
}
