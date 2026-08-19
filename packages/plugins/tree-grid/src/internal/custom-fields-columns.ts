// docs/specs/plugins/tree-grid.md § Internal modules — one grid column per user-defined field.
// The supply direction is inverted: the field definitions and values are read from the fields
// service, and an edited cell is written back through `FieldsService.setValue`, which raises the
// `task/update` transaction itself — one undo step per committed cell edit. The column's own
// `setValue` therefore leaves the grid's draft untouched, so the grid's diff finds no change and
// adds no second transaction.
import type {
  CustomFieldValue,
  FieldsService,
  ResolvedCustomField,
  Task,
} from "@stargantt/plugin-data-store";
import { parseIsoDateStrict } from "@stargantt/sdk";
import type { ColumnDef, TreeGridMessages } from "../types";

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

/** Parses a committed decimal cell text; `""` = clear; unparsable = `undefined`. */
function parseNumberInput(raw: unknown): number | "clear" | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  if (text === "") return "clear";
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Orders two values for a column sort: numbers before strings, ascending within each type,
 * absent last.
 */
export function compareValues(
  a: CustomFieldValue | undefined,
  b: CustomFieldValue | undefined,
): number {
  if (a === undefined) return b === undefined ? 0 : 1;
  if (b === undefined) return -1;
  if (typeof a === "number") {
    return typeof b === "number" ? a - b : -1;
  }
  return typeof b === "number" ? 1 : a < b ? -1 : a > b ? 1 : 0;
}

/** The stored-value setter of one editable column, per field type. */
function makeSetValue(
  field: Readonly<ResolvedCustomField>,
  fields: FieldsService,
): ((task: Readonly<Task>, value: unknown) => void) | undefined {
  const write = (task: Readonly<Task>, value: CustomFieldValue | undefined): void => {
    fields.setValue(task.id, field.key, value);
  };
  switch (field.type) {
    case "text":
      return (task, value) => {
        if (typeof value !== "string") return;
        write(task, value === "" ? undefined : value);
      };
    case "number":
      return (task, value) => {
        const parsed = parseNumberInput(value);
        if (parsed === undefined) return;
        write(task, parsed === "clear" ? undefined : parsed);
      };
    case "date":
      return (task, value) => {
        const parsed = parseDateInput(value);
        if (parsed === undefined) return;
        write(task, parsed === "clear" ? undefined : parsed);
      };
    case "select":
      return (task, value) => {
        if (typeof value !== "string") return;
        if (value === "") write(task, undefined);
        else if (field.options.includes(value)) write(task, value);
      };
    case "formula":
      return undefined; // computed columns are read-only
    default: {
      const exhaustive: never = field.type;
      return exhaustive;
    }
  }
}

/**
 * The `<select>` editor of a select field: one empty "no value" entry plus the options. Commits
 * on change, cancels on Escape — matching the grid's shared editor conventions. Listeners live
 * on the editor-created element, which the grid removes when the session ends.
 */
function makeSelectEditor(
  field: Readonly<ResolvedCustomField>,
  messages: TreeGridMessages,
): NonNullable<ColumnDef["editor"]> {
  return (el, initialValue, done) => {
    const doc = el.ownerDocument;
    const select = doc.createElement("select") as HTMLSelectElement;
    select.className = "sg-customfields-select";
    const none = doc.createElement("option") as HTMLOptionElement;
    none.value = "";
    none.textContent = messages.noneOption;
    select.appendChild(none);
    for (const option of field.options) {
      const opt = doc.createElement("option") as HTMLOptionElement;
      opt.value = option;
      opt.textContent = option;
      select.appendChild(opt);
    }
    select.value = typeof initialValue === "string" ? initialValue : "";
    select.addEventListener("change", () => done.commit(select.value));
    select.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Escape") done.cancel();
    });
    el.appendChild(select);
    select.focus();
  };
}

function indexOfOption(
  field: Readonly<ResolvedCustomField>,
  value: CustomFieldValue | undefined,
): number {
  if (typeof value !== "string") return field.options.length;
  const i = field.options.indexOf(value);
  return i === -1 ? field.options.length : i;
}

/** Builds the `ColumnDef` for one resolved field. */
function buildColumn(
  field: Readonly<ResolvedCustomField>,
  fields: FieldsService,
  messages: TreeGridMessages,
): ColumnDef {
  const setValue = makeSetValue(field, fields);
  const def: ColumnDef = {
    id: `customfields-${field.key}`,
    header: field.label,
    width: field.width,
    render(el, task) {
      el.textContent = fields.displayValue(task.id, field.key);
    },
    getValue: (task) => {
      // Editing starts from the stored value, not the display formatting: select editors receive
      // the raw option, and number cells the full-precision decimal — the cell display rounds to
      // two fraction digits, and pre-filling that rounded text would let an unchanged commit
      // silently overwrite the stored value with the rounded one.
      if (field.type === "select") return fields.valueOf(task.id, field.key) ?? "";
      if (field.type === "number") {
        const stored = fields.valueOf(task.id, field.key);
        return stored === undefined ? "" : String(stored);
      }
      return fields.displayValue(task.id, field.key);
    },
    compare(a, b) {
      if (field.type === "select") {
        // Select sorts in option order, absent last.
        const ia = indexOfOption(field, fields.valueOf(a.id, field.key));
        const ib = indexOfOption(field, fields.valueOf(b.id, field.key));
        return ia - ib;
      }
      return compareValues(fields.valueOf(a.id, field.key), fields.valueOf(b.id, field.key));
    },
  };
  if (setValue !== undefined) def.setValue = setValue;
  if (field.type === "select") {
    def.editor = makeSelectEditor(field, messages);
  }
  return def;
}

/** The columns of the resolved fields with `column` enabled, in definition order. */
export function buildCustomFieldColumns(
  fields: FieldsService,
  messages: TreeGridMessages,
): ColumnDef[] {
  return fields
    .definitions()
    .filter((f) => f.column)
    .map((f) => buildColumn(f, fields, messages));
}
