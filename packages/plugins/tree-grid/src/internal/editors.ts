/**
 * Ready-made `ColumnEditor`s: a dropdown (`selectEditor`) and a calendar date picker
 * (`dateEditor`). Both are ordinary editors a `ColumnDef.editor` can name — the grid mounts them
 * inside the cell, and committing goes through the column's `setValue` inside the usual undoable
 * `task/update` transaction. Listeners are attached to elements the grid creates and disposes with
 * the editor host, so no `ctx.own()` is involved (the host element's disposal is the grid's).
 */
// docs/specs/plugins/tree-grid.md § Third-party surface — bundled editors.
import type { ColumnEditor } from "../types";

/** One choice of a `selectEditor` dropdown. */
export interface SelectOption {
  /** The value handed to the column's `setValue` when this choice is committed. */
  value: unknown;
  /** The text shown for this choice. */
  label: string;
}

function usableOptions(options: unknown): SelectOption[] {
  if (!Array.isArray(options)) return [];
  const out: SelectOption[] = [];
  for (const entry of options) {
    if (typeof entry === "string") out.push({ value: entry, label: entry });
    else if (
      entry !== null &&
      typeof entry === "object" &&
      typeof (entry as SelectOption).label === "string"
    )
      out.push({ value: (entry as SelectOption).value, label: (entry as SelectOption).label });
  }
  return out;
}

/**
 * A dropdown editor over a fixed list of choices — the classic assignee / status column editor.
 *
 * Each choice is either a string (used as both value and label) or a `{ value, label }` pair;
 * entries of any other shape are skipped. Picking a choice commits its `value` immediately;
 * `Escape` cancels; leaving the dropdown without picking (blur) cancels too, so a stray click
 * elsewhere never writes. The initially selected choice is the one whose `value` equals the
 * cell's current value, when there is one.
 *
 * With no usable choice at all the returned editor cancels immediately on open, leaving the cell
 * unchanged.
 */
export function selectEditor(options: readonly (SelectOption | string)[]): ColumnEditor {
  const choices = usableOptions(options);
  return (el, initialValue, done) => {
    if (choices.length === 0) {
      done.cancel();
      return;
    }
    const doc = el.ownerDocument;
    const select = doc.createElement("select");
    select.className = "sg-grid-select";
    for (const choice of choices) {
      const option = doc.createElement("option");
      option.textContent = choice.label;
      select.appendChild(option);
    }
    const initial = choices.findIndex((c) => c.value === initialValue);
    if (initial >= 0) select.selectedIndex = initial;
    let settled = false;
    const finish = (commit: boolean): void => {
      if (settled) return;
      settled = true;
      const picked = choices[select.selectedIndex];
      if (commit && picked !== undefined) done.commit(picked.value);
      else done.cancel();
    };
    select.addEventListener("change", () => finish(true));
    select.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    });
    select.addEventListener("blur", () => finish(false));
    el.appendChild(select);
    select.focus();
  };
}

/** Formats an epoch-ms instant as the `YYYY-MM-DD` value a date input takes (UTC calendar date). */
function isoDateOf(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  return new Date(value).toISOString().slice(0, 10);
}

/**
 * A calendar date-picker editor: the browser's native date input, so clicking the cell opens the
 * platform calendar UI.
 *
 * The initial value is the cell's current value read as an epoch-ms instant (anything else starts
 * blank). Picking a date, or pressing `Enter` on a complete one, commits the chosen day as an
 * epoch-ms instant at UTC midnight — the unit tasks store dates in; `Escape` cancels, and so do
 * blur and an incomplete or cleared date, so nothing is ever written without an actual pick.
 */
export function dateEditor(): ColumnEditor {
  return (el, initialValue, done) => {
    const doc = el.ownerDocument;
    const input = doc.createElement("input") as HTMLInputElement;
    input.type = "date";
    input.className = "sg-grid-date";
    input.value = isoDateOf(initialValue);
    let settled = false;
    const finish = (commit: boolean): void => {
      if (settled) return;
      settled = true;
      const parsed = Date.parse(`${input.value}T00:00:00Z`);
      if (commit && Number.isFinite(parsed)) done.commit(parsed);
      else done.cancel();
    };
    input.addEventListener("change", () => finish(true));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(false));
    el.appendChild(input);
    input.focus();
  };
}
