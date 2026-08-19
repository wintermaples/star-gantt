// docs/specs/plugins/interaction.md §6.9 / §8 (the `dialog*` renamed message keys).
/**
 * The dialog's field catalog: the DOM of one labeled field, the date arithmetic its two date
 * inputs need, and the invalid marking a rejected Save applies.
 *
 * Nothing here reaches for a plugin context — a document, a few strings and a `Field` are the whole
 * input — so every piece is unit-testable without booting a host.
 *
 * `styled` comes from `@stargantt/sdk`, and date parsing goes through the SDK's
 * `parseIsoDateStrict` instead of a hand-rolled `Date.parse` wrapper — a deliberate choice: it
 * rejects a calendar-invalid date such as `"2024-02-30"` instead of letting `Date.parse` roll it
 * over onto a neighboring date.
 */
import { parseIsoDateStrict, styled } from "@stargantt/sdk";
import type { InteractionMessages } from "../../messages";
import type { EditDialogField } from "./types";

/** Creates an element carrying one class name and, when given, its text. */
export function el(doc: Document, tag: string, className: string, text?: string): HTMLElement {
  const node = doc.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Formats an epoch-ms instant as the `YYYY-MM-DD` (UTC) a date input expects. */
export function formatDateUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Parses a `YYYY-MM-DD` field value as UTC midnight; anything else (including a calendar-invalid
 *  date like `"2024-02-30"`) is invalid. */
export function parseDateUtc(value: string): number | undefined {
  return parseIsoDateStrict(value);
}

/** The four fields in the order the built-in form shows and validates them. */
export const FIELD_KEYS: readonly EditDialogField[] = ["name", "start", "end", "progress"];

/** The label message key each field's name and rejection announcement is taken from — the
 *  `dialog*` renamed keys of §8 (they collide with side-panel's `panel*` keys otherwise). */
export const LABEL_KEYS = {
  name: "dialogNameLabel",
  start: "dialogStartLabel",
  end: "dialogEndLabel",
  progress: "dialogProgressLabel",
} satisfies Record<EditDialogField, keyof InteractionMessages>;

/** Why a value was rejected — the key its cause text is looked up by. */
export type RejectReason = "invalidDate" | "dateOrder" | "progressRange";

// Table-driven and `satisfies`-checked, so a new reason cannot be added without its message.
/** The message key holding the cause text a rejection reason resolves to. */
export const REASON_MESSAGE_KEYS = {
  invalidDate: "dialogErrorInvalidDate",
  dateOrder: "dialogErrorDateOrder",
  progressRange: "dialogErrorProgressRange",
} satisfies Record<RejectReason, keyof InteractionMessages>;

/**
 * The one thing a rejection announcement needs from the optional announcement service. Narrow on
 * purpose, so the dialog can be tested without that plugin — and resolved per call, so a
 * composition where the service appears later still announces.
 */
export interface Announcer {
  announce(message: string): void;
}

/** One built-in field: its wrapper, its input, and the cause-text element it shows when rejected. */
export interface Field {
  wrap: HTMLElement;
  input: HTMLInputElement;
  /**
   * Cause-text element a rejected value appends under the input and references through
   * `aria-errormessage`. Created detached, so an untouched form carries no empty node.
   */
  error: HTMLElement;
}

/** The input border color token (with its fallback), shared by its resting and cleared states. */
const BORDER_COLOR = "var(--sg-border, #d6d3d1)";
/** The invalid-marking stroke color token (with its fallback), shared by border and outline. */
const INVALID_STROKE = "var(--sg-invalid-stroke, #c0392b)";

/** What one labeled field needs to be built. */
export interface FieldBuildOptions {
  readonly label: string;
  /** The input's `type` attribute (`"text"`, `"date"`, `"number"`). */
  readonly type: string;
  /** The input's `id`, unique per dialog instance, addressed by the label's `for`. */
  readonly inputId: string;
}

// The dialog is styled inline: it floats over the chart and must look right with or without the
// bundled stylesheet, so every colour is a `--sg-*` custom property read with a built-in fallback
// rather than a class the stylesheet has to define.
/**
 * Builds one labeled field: wrapper, associated label, input, and a detached cause-text element
 * whose id is `<inputId>-error`, appended to the wrapper only while the field is marked invalid.
 */
export function buildField(doc: Document, options: FieldBuildOptions): Field {
  const wrap = el(doc, "div", "sg-edit-dialog-field");
  styled(wrap, { margin: "0 0 10px" });
  const labelEl = el(doc, "label", "sg-edit-dialog-label", options.label);
  labelEl.setAttribute("for", options.inputId);
  // 11px on the muted foreground, which clears 4.5:1 against the dialog background in both schemes.
  styled(labelEl, {
    display: "block",
    marginBottom: "2px",
    color: "var(--sg-muted-fg, #57534e)",
    fontSize: "11px",
  });
  wrap.appendChild(labelEl);
  const input = doc.createElement("input") as HTMLInputElement;
  input.setAttribute("id", options.inputId);
  input.className = "sg-edit-dialog-input";
  input.setAttribute("type", options.type);
  // 28px minimum height keeps the pointer target above the 24x24px floor of WCAG 2.5.8.
  styled(input as unknown as HTMLElement, {
    boxSizing: "border-box",
    width: "100%",
    minHeight: "28px",
    padding: "4px 6px",
    border: `1px solid ${BORDER_COLOR}`,
    borderRadius: "3px",
    background: "var(--sg-dialog-bg, #ffffff)",
    color: "inherit",
    font: "inherit",
  });
  wrap.appendChild(input);
  const error = el(doc, "div", "sg-edit-dialog-error");
  error.setAttribute("id", `${options.inputId}-error`);
  // The cause text carries the destructive palette's red — above the 4.5:1 text minimum against
  // the dialog background — and the *text*, not the colour, names the cause.
  styled(error, {
    color: "var(--sg-dialog-danger, #b3261e)",
    fontSize: "12px",
    marginTop: "2px",
  });
  return { wrap, input, error };
}

// The same marking the side panel applies, so a rejected field looks and reads the same in both:
// `aria-invalid`, the modifier class, an outline that does not rely on colour alone to be noticed,
// and the cause text attached under the input and referenced through `aria-errormessage`.
/**
 * Marks one field invalid and shows its cause text: the error element receives the text, is
 * appended under the input, and is referenced by the input's `aria-errormessage`, so an assistive
 * technology reads the cause along with the invalid state.
 */
export function setInvalid(field: Field, causeText: string): void {
  field.input.setAttribute("aria-invalid", "true");
  field.input.classList.add("sg-edit-dialog-input--invalid");
  styled(field.input as unknown as HTMLElement, {
    borderColor: INVALID_STROKE,
    outline: `1px solid ${INVALID_STROKE}`,
    outlineOffset: "-1px",
  });
  field.error.textContent = causeText;
  const errorId = field.error.getAttribute("id");
  if (errorId !== null) field.input.setAttribute("aria-errormessage", errorId);
  if (field.error.parentNode !== field.wrap) field.wrap.appendChild(field.error);
}

/**
 * Clears one field's invalid marking: attributes, modifier class, outline, and the attached cause
 * text — the error element is detached again, so a corrected field leaves no stale node behind.
 */
export function clearInvalid(field: Field): void {
  field.input.removeAttribute("aria-invalid");
  field.input.removeAttribute("aria-errormessage");
  field.input.classList.remove("sg-edit-dialog-input--invalid");
  // The outline declarations are *removed*, not set to `none`: `outline: none` would also take the
  // user agent's focus ring away from the input, which is the one indicator that must never go.
  styled(field.input as unknown as HTMLElement, {
    borderColor: BORDER_COLOR,
    outline: "",
    outlineOffset: "",
  });
  if (field.error.parentNode !== null) {
    field.error.textContent = "";
    field.error.remove();
  }
}
