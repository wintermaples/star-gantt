// docs/specs/plugins/interaction.md §6.10 / §8 (the `panel*` renamed message keys).
/**
 * The detail pane's editing machinery: what a typed-in value means (accepted, unchanged, rejected),
 * how a rejected edit is marked and announced, and when that marking is cleared again.
 *
 * The panel never echoes an edit locally — an accepted one is a command dispatch and the store's
 * `tasks` store publish renders the result — so everything here is decision-making plus the
 * rejected-edit feedback below, and none of it needs a plugin context.
 *
 * Date parsing goes through the SDK's `parseIsoDateStrict` instead of a hand-rolled `Date.parse`
 * wrapper (rejects a calendar-invalid date like `"2024-02-30"` instead of letting it roll over) —
 * the same choice the edit dialog makes.
 */
import { parseIsoDateStrict } from "@stargantt/sdk";
import type { Task, TaskId } from "@stargantt/plugin-data-store";
import type { InteractionMessages } from "../../messages";
import type { Field, PanelFields } from "./fields";
import type { FieldKey } from "./types";

/** Parses a `YYYY-MM-DD` field value as UTC midnight; anything else is invalid. */
export function parseDateUtc(value: string): number | undefined {
  return parseIsoDateStrict(value);
}

/* ------------------------------------------------------------------ *
 * What a typed-in value means
 * ------------------------------------------------------------------ */

/**
 * The outcome of reading one field: nothing to do, a rejected value, or the command an accepted
 * value turns into.
 */
export type EditDecision =
  /** The value equals what the store already holds — no dispatch, no marking. */
  | { readonly kind: "unchanged" }
  /** The value is unusable (unparsable date, end ≤ start, progress outside 0..1). */
  | { readonly kind: "reject" }
  | { readonly kind: "update"; readonly name: string }
  | { readonly kind: "move"; readonly start: number; readonly end: number }
  | { readonly kind: "progress"; readonly progress: number };

/** Why a value was rejected — the key the cause text is looked up by. */
export type RejectReason = "invalidDate" | "dateOrder" | "progressRange";

/** `EditDecision`, with each rejection carrying why the value was unusable. */
export type EditDecisionDetailed =
  | Exclude<EditDecision, { readonly kind: "reject" }>
  | { readonly kind: "reject"; readonly reason: RejectReason };

const UNCHANGED: EditDecisionDetailed = { kind: "unchanged" };

// One decider per built-in field. Table-driven and `satisfies`-checked, so a new field key cannot
// be added without a decider for it.
const DECIDERS = {
  name: (task, raw) => (raw === task.name ? UNCHANGED : { kind: "update", name: raw }),
  start: (task, raw) => {
    const start = parseDateUtc(raw);
    if (start === undefined) return { kind: "reject", reason: "invalidDate" };
    if (task.end <= start) return { kind: "reject", reason: "dateOrder" };
    return start === task.start ? UNCHANGED : { kind: "move", start, end: task.end };
  },
  end: (task, raw) => {
    const end = parseDateUtc(raw);
    if (end === undefined) return { kind: "reject", reason: "invalidDate" };
    if (end <= task.start) return { kind: "reject", reason: "dateOrder" };
    return end === task.end ? UNCHANGED : { kind: "move", start: task.start, end };
  },
  progress: (task, raw) => {
    const progress = raw.trim() === "" ? Number.NaN : Number(raw);
    if (!Number.isFinite(progress) || progress < 0 || progress > 1) {
      return { kind: "reject", reason: "progressRange" };
    }
    return progress === (task.progress ?? 0) ? UNCHANGED : { kind: "progress", progress };
  },
} satisfies Record<FieldKey, (task: Readonly<Task>, raw: string) => EditDecisionDetailed>;

/**
 * Decides what the raw text of one field means for the task the form shows.
 *
 * `end` is compared against the stored `start` and vice versa, so an edit that would leave the task
 * empty or inverted is rejected while the other end is preserved untouched.
 */
export function decideEditWithReason(
  key: FieldKey,
  task: Readonly<Task>,
  raw: string,
): EditDecisionDetailed {
  return DECIDERS[key](task, raw);
}

/* ------------------------------------------------------------------ *
 * Rejected-edit marking
 * ------------------------------------------------------------------ */

// The one marking both the pane's form and the edit dialog apply, so a rejected field looks and
// reads the same everywhere: `aria-invalid`, the modifier class, and — when a cause text is given —
// the field's error element filled, attached under the input, and referenced through
// `aria-errormessage`.
/**
 * Marks one field invalid. With a cause text, the field's error element (when it has one) receives
 * the text, is appended to the field's wrapper, and is referenced by the input's
 * `aria-errormessage`, so an assistive technology reads the cause along with the invalid state.
 */
export function setInvalid(field: Field, causeText?: string): void {
  field.input.setAttribute("aria-invalid", "true");
  field.input.classList.add("sg-side-panel-input--invalid");
  if (causeText === undefined || field.error === undefined) return;
  field.error.textContent = causeText;
  const errorId = field.error.getAttribute("id");
  if (errorId !== null) field.input.setAttribute("aria-errormessage", errorId);
  if (field.error.parentNode !== field.wrap) field.wrap.appendChild(field.error);
}

/**
 * Clears one field's invalid marking: attributes, modifier class, and the attached cause text —
 * the error element is detached again, so a corrected field leaves no stale node behind.
 */
export function clearInvalid(field: Field): void {
  field.input.removeAttribute("aria-invalid");
  field.input.removeAttribute("aria-errormessage");
  field.input.classList.remove("sg-side-panel-input--invalid");
  if (field.error !== undefined && field.error.parentNode !== null) {
    field.error.textContent = "";
    field.error.remove();
  }
}

/** The `aria-invalid` / modifier-class marking of rejected fields, and when it is cleared. */
export interface InvalidMarks {
  /**
   * Marks one field invalid and disarms any pending clear, so the marking survives to be seen.
   * With a cause text, the field additionally shows it and references it via `aria-errormessage`.
   */
  mark(field: Field, causeText?: string): void;
  /** Arms the clear a store-driven refresh performs — one per selection change or task-store publish. */
  arm(): void;
  /** Clears every field's marking if a clear is armed; called at the start of each render. */
  applyPending(): void;
  /** Whether a clear is currently armed. Exposed for tests. */
  readonly armed: boolean;
  /**
   * The cause text of a field's last rejected edit, or `undefined` — the same state the DOM
   * marking carries. Cleared on the same schedule as the DOM marking. Exposed for
   * `SidePanelRenderContext.invalid`.
   */
  causeOf(field: Field): string | undefined;
}

/**
 * The rejected-edit marking of the built-in fields.
 *
 * The not-dispatched rule stands; a rejected edit additionally marks its field, and both the
 * `aria-invalid` attribute and the modifier class are cleared from **every** field at the start of
 * the next *store-driven* refresh — the one triggered by a selection change or a `tasks` store
 * publish. Never by the cosmetic reset render an invalid edit itself schedules, or the marking
 * would never survive to be seen: refreshes are batched to at most one per frame, so a clear armed
 * earlier in the same frame — the store publish of a valid edit made moments ago — would otherwise
 * land on a brand-new marking and wipe it. `mark()` therefore disarms it, and the next store-driven
 * event arms a fresh clear. The marking carries no timer of its own.
 */
export function createInvalidMarks(fields: readonly Field[]): InvalidMarks {
  let clearOnRefresh = false;
  // Keyed by the `Field` object itself, not by `FieldKey`: this module has no notion of field keys
  // (it is shared by anything that builds a `PanelDom`), and a `Field` is stable for the panel's
  // lifetime, so the reference makes a fine key.
  const causes = new Map<Field, string>();
  return {
    get armed(): boolean {
      return clearOnRefresh;
    },
    mark(field: Field, causeText?: string): void {
      setInvalid(field, causeText);
      clearOnRefresh = false;
      if (causeText === undefined) causes.delete(field);
      else causes.set(field, causeText);
    },
    arm(): void {
      clearOnRefresh = true;
    },
    applyPending(): void {
      if (!clearOnRefresh) return;
      for (const f of fields) {
        clearInvalid(f);
        causes.delete(f);
      }
      clearOnRefresh = false;
    },
    causeOf(field: Field): string | undefined {
      return causes.get(field);
    },
  };
}

/* ------------------------------------------------------------------ *
 * The edit controller
 * ------------------------------------------------------------------ */

/** The commands an accepted edit turns into; the caller routes each to the command bus. */
export interface EditCommands {
  update(id: TaskId, name: string): void;
  move(id: TaskId, start: number, end: number): void;
  setProgress(id: TaskId, progress: number): void;
}

/**
 * The one thing the announcement needs from `stargantt.focus`. Narrow on purpose, so the controller
 * can be tested without that plugin — and resolved per call, so a composition where the service
 * appears later still announces.
 */
export interface Announcer {
  announce(message: string): void;
}

/** What the edit controller is wired to. */
export interface EditDeps {
  readonly messages: InteractionMessages;
  readonly fields: PanelFields;
  readonly marks: InvalidMarks;
  /** The task the detail form currently shows, read from the store at edit time. */
  currentTask(): Readonly<Task> | undefined;
  readonly commands: EditCommands;
  /**
   * The optional announcement sink, resolved at call time: in a composition where it does not
   * resolve, nothing is announced and the visual/ARIA marking still applies.
   */
  announcer(): Announcer | undefined;
  /** Schedules the panel's refresh — for a rejection, the render that snaps the field back. */
  schedule(): void;
}

/** Handles the `change` event of the built-in fields, and `SidePanelRenderContext.commit`. */
export interface EditController {
  /**
   * Decides what one field's value means and either dispatches its command or rejects it.
   *
   * With `raw` omitted, the value is read from the built-in field's current input (the `change`
   * listener's case). With `raw` given, that value is used instead and the built-in input is left
   * untouched — the path `SidePanelRenderContext.commit` takes, which has no input of its own to
   * read.
   */
  change(key: FieldKey, raw?: string): void;
}

/** The label message key a rejection announcement names the field with — the `panel*` renamed keys. */
const LABEL_KEYS = {
  name: "panelNameLabel",
  start: "panelStartLabel",
  end: "panelEndLabel",
  progress: "panelProgressLabel",
} satisfies Record<FieldKey, keyof InteractionMessages>;

// The cause text each rejection reason resolves to. Table-driven and `satisfies`-checked, so a new
// reason cannot be added without its message.
/** The message key holding the cause text a rejection reason is shown with. */
export const REASON_MESSAGE_KEYS = {
  invalidDate: "panelErrorInvalidDate",
  dateOrder: "panelErrorDateOrder",
  progressRange: "panelErrorProgressRange",
} satisfies Record<RejectReason, keyof InteractionMessages>;

/**
 * Turns a `change` on a built-in field into a command dispatch, or into the rejected-edit
 * feedback when the typed value is unusable.
 *
 * Nothing is echoed into the form here: an accepted edit is rendered from the store through the
 * `tasks` store publish it causes, and a rejected one schedules the refresh that resets the field
 * to the stored value.
 */
export function createEditController(deps: EditDeps): EditController {
  function reject(field: Field, label: string, causeText: string): void {
    // The marking carries the cause: `aria-invalid` plus the error element the input's
    // `aria-errormessage` references.
    deps.marks.mark(field, causeText);
    // Resolved at call time, and the message is built only when there is somewhere to announce it.
    deps.announcer()?.announce(deps.messages.panelEditRejected({ label }));
    deps.schedule();
  }

  return {
    change(key: FieldKey, raw?: string): void {
      const task = deps.currentTask();
      if (task === undefined) return;
      const field = deps.fields[key];
      const value = raw ?? field.input.value;
      const decision = decideEditWithReason(key, task, value);
      switch (decision.kind) {
        case "unchanged":
          return;
        case "reject":
          reject(
            field,
            deps.messages[LABEL_KEYS[key]],
            deps.messages[REASON_MESSAGE_KEYS[decision.reason]],
          );
          return;
        case "update":
          deps.commands.update(task.id, decision.name);
          return;
        case "move":
          deps.commands.move(task.id, decision.start, decision.end);
          return;
        case "progress":
          deps.commands.setProgress(task.id, decision.progress);
          return;
        default: {
          // A new decision kind must be handled above, not silently ignored here.
          const never: never = decision;
          return never;
        }
      }
    },
  };
}
