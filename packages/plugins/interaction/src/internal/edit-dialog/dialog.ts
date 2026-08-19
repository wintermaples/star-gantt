// docs/specs/plugins/interaction.md §6.9 — the modal task-edit dialog: a form over four fields,
// validated as a whole on Save and committed as ONE `task/update` dispatch (one undo step), or
// dismissed without any dispatch by Cancel, Escape or a backdrop press.
/**
 * Hostless: a host element, the message catalog and a few callbacks are the whole input, so
 * everything here is unit-testable without booting a plugin host.
 *
 * Built on `@stargantt/sdk`'s `createDialog` / `styled` / `latchedSeam` — the SDK's `sdk/dialog`
 * module: same class-name scheme, same containment/Escape/focus-trap/drag behavior.
 */
import { createDialog, latchedSeam, styled } from "@stargantt/sdk";
import type { Dialog } from "@stargantt/sdk";
import type { Task, TaskId } from "@stargantt/plugin-data-store";
import type { InteractionMessages } from "../../messages";
import type { EditDialogDraft, EditDialogField, EditDialogRenderContext } from "./types";
import {
  FIELD_KEYS,
  LABEL_KEYS,
  REASON_MESSAGE_KEYS,
  buildField,
  clearInvalid,
  el,
  formatDateUtc,
  parseDateUtc,
  setInvalid,
} from "./fields";
import type { Announcer, Field, RejectReason } from "./fields";

/** Class name of the dialog box; the shared chrome derives its parts' names from it. */
export const DIALOG_CLASS = "sg-edit-dialog";

/** What the edit dialog is wired to. */
export interface EditDialogDeps {
  /** The element the dialog's backdrop is appended to while open — the widget root. */
  readonly host: HTMLElement;
  readonly messages: InteractionMessages;
  /** Prefix for the dialog's input ids, unique per plugin instance. */
  readonly idPrefix: string;
  /** The task to edit, read from the store at open and again at commit — never cached. */
  getTask(id: TaskId): Readonly<Task> | undefined;
  /** Commits every changed field as one `task/update` dispatch — one undo step. */
  apply(id: TaskId, after: Partial<Task>): void;
  /** The optional announcement sink, resolved at call time (may not resolve — then silent). */
  announcer(): Announcer | undefined;
  /** The host's body renderer, already narrowed to a function, or `undefined`. */
  readonly renderBody?: ((host: HTMLElement, ctx: EditDialogRenderContext) => void) | undefined;
  /** Reports a fault raised by host-supplied code, under this plugin's id. */
  fault(error: unknown): void;
}

/** The task-edit dialog: open it for a task, close it, dispose it with the plugin. */
export interface EditDialog {
  /**
   * Opens the dialog for one task, replacing an already open one. Returns whether it opened: a
   * task the store does not know is a silent no-op.
   */
  open(id: TaskId): boolean;
  /** Closes the dialog without dispatching, restoring focus to where it was. */
  close(): void;
  /** Whether the dialog is currently open. */
  readonly isOpen: boolean;
  /** Closes the dialog if open; registered with `ctx.own()` by the caller. */
  dispose(): void;
}

/** The outcome of validating the whole form. */
export interface Validated {
  /** The fields that differ from the stored task; empty when nothing changed or nothing is valid. */
  readonly after: Partial<Task>;
  /** Per-field rejection reasons, in field order; empty when the form is valid. */
  readonly invalid: readonly { key: EditDialogField; reason: RejectReason }[];
}

/**
 * Validates the dialog's raw field texts against each other (not against the stored task): the two
 * dates must parse and the end must be after the start, and progress must be a number in 0..1.
 * Returns the partial update of the fields that differ from the task, or the per-field reasons.
 */
export function validateDialog(task: Readonly<Task>, raw: Readonly<EditDialogDraft>): Validated {
  const invalid: { key: EditDialogField; reason: RejectReason }[] = [];
  const start = parseDateUtc(raw.start);
  const end = parseDateUtc(raw.end);
  if (start === undefined) invalid.push({ key: "start", reason: "invalidDate" });
  if (end === undefined) invalid.push({ key: "end", reason: "invalidDate" });
  // The dates are compared against *each other*, so correcting both at once is possible — the
  // side panel's one-field-at-a-time rule does not apply inside the dialog.
  if (start !== undefined && end !== undefined && end <= start) {
    invalid.push({ key: "end", reason: "dateOrder" });
  }
  const progress = raw.progress.trim() === "" ? Number.NaN : Number(raw.progress);
  if (!Number.isFinite(progress) || progress < 0 || progress > 1) {
    invalid.push({ key: "progress", reason: "progressRange" });
  }
  if (invalid.length > 0) return { after: {}, invalid };

  const after: Partial<Task> = {};
  if (raw.name !== task.name) after.name = raw.name;
  if (start !== undefined && start !== task.start) after.start = start;
  if (end !== undefined && end !== task.end) after.end = end;
  if (progress !== (task.progress ?? 0)) after.progress = progress;
  return { after, invalid };
}

/** The empty per-field cause-text map handed to a custom body before anything is rejected. */
function noInvalid(): Record<EditDialogField, string | undefined> {
  return { name: undefined, start: undefined, end: undefined, progress: undefined };
}

/** The draft a freshly opened dialog starts from: the stored task, as the inputs would show it. */
function draftOf(task: Readonly<Task>): EditDialogDraft {
  return {
    name: task.name,
    start: formatDateUtc(task.start),
    end: formatDateUtc(task.end),
    progress: String(task.progress ?? 0),
  };
}

/** The type attribute of each built-in input. */
const FIELD_TYPES: Record<EditDialogField, string> = {
  name: "text",
  start: "date",
  end: "date",
  progress: "number",
};

/**
 * Creates the task-edit dialog.
 *
 * The chrome — box, header, backdrop, focus trap, Escape, the header drag — comes from the shared
 * `@stargantt/sdk` facility and is built fresh on each open and removed on close, so a closed
 * dialog leaves nothing behind and no listener outlives it.
 */
export function createEditDialog(deps: EditDialogDeps): EditDialog {
  const { host, messages, idPrefix } = deps;
  const doc = host.ownerDocument;
  // The latch is per plugin instance, not per open: a body renderer that threw once is done for
  // good, however many times the dialog is opened afterwards.
  const seam = deps.renderBody === undefined ? undefined : latchedSeam(deps.renderBody, deps.fault);

  let chrome: Dialog | null = null;
  /** The built-in form's fields, or `null` while a custom body owns the body element. */
  let fields: Record<EditDialogField, Field> | null = null;
  let editing: TaskId | null = null;
  /** The task as it was read at open — the render context's `task`. */
  let opened: Readonly<Task> | null = null;
  let draft: EditDialogDraft = { name: "", start: "", end: "", progress: "" };
  let invalid = noInvalid();

  function close(): void {
    if (chrome === null) return;
    // The chrome's own dispose() restores focus to wherever it was before the dialog opened, so
    // this plugin does not duplicate that bookkeeping.
    chrome.dispose();
    chrome = null;
    fields = null;
    editing = null;
    opened = null;
  }

  /** Copies the built-in inputs into the draft, so `commit` always reads one source of truth. */
  function syncDraftFromInputs(): void {
    if (fields === null) return;
    const built = fields;
    for (const key of FIELD_KEYS) draft[key] = built[key].input.value;
  }

  function setField(field: EditDialogField, value: string): void {
    if (!FIELD_KEYS.includes(field)) return;
    draft[field] = String(value);
    // With the built-in form on screen the input is the visible copy of the draft, so it follows.
    if (fields !== null) fields[field].input.value = draft[field];
  }

  function renderContext(task: Readonly<Task>): EditDialogRenderContext {
    // Copies, not the live objects: a body renderer must go through `setField` to change anything.
    return {
      task,
      draft: { ...draft },
      invalid: { ...invalid },
      setField,
      commit,
      cancel: close,
    };
  }

  /** Builds the four built-in fields into the body, prefilled from the draft. */
  function buildForm(body: HTMLElement): Record<EditDialogField, Field> {
    const built = {} as Record<EditDialogField, Field>;
    for (const key of FIELD_KEYS) {
      const field = buildField(doc, {
        label: messages[LABEL_KEYS[key]],
        type: FIELD_TYPES[key],
        inputId: `${idPrefix}-${key}`,
      });
      field.input.value = draft[key];
      body.appendChild(field.wrap);
      built[key] = field;
    }
    built.progress.input.setAttribute("min", "0");
    built.progress.input.setAttribute("max", "1");
    built.progress.input.setAttribute("step", "0.05");
    // A rejected Save that re-rendered the form keeps its marking visible.
    for (const key of FIELD_KEYS) {
      const cause = invalid[key];
      if (cause !== undefined) setInvalid(built[key], cause);
    }
    return built;
  }

  /**
   * Fills the dialog's body: the host's renderer when it has one and has not thrown, else the
   * built-in form. Per the uniform seam rules the body is emptied first, and emptied again after a
   * throw before the built-in rendering runs into it.
   */
  function renderBodyInto(): void {
    if (chrome === null || opened === null) return;
    const body = chrome.body;
    body.textContent = "";
    fields = null;
    if (seam !== undefined && seam(body, renderContext(opened))) return;
    body.textContent = "";
    fields = buildForm(body);
  }

  /** Builds the per-field cause-text map for a rejected Save, in field order. */
  function invalidMapOf(result: Validated): Record<EditDialogField, string | undefined> {
    const map = noInvalid();
    for (const entry of result.invalid) {
      map[entry.key] = messages[REASON_MESSAGE_KEYS[entry.reason]];
    }
    return map;
  }

  /**
   * Marks a rejected Save's fields with their causes: the built-in form is marked in place; a
   * custom body is re-rendered through the seam, and because that re-render discards and replaces
   * the body's DOM, focus is handed back into the dialog afterwards so it never lands on the
   * removed node.
   */
  function applyRejection(result: Validated): void {
    invalid = invalidMapOf(result);
    if (fields === null) {
      // A custom body learns about a rejection the only way it can: another render, now carrying
      // the cause text in `ctx.invalid`.
      renderBodyInto();
      chrome?.focus();
    } else {
      const built = fields;
      for (const key of FIELD_KEYS) clearInvalid(built[key]);
      for (const entry of result.invalid) {
        setInvalid(built[entry.key], messages[REASON_MESSAGE_KEYS[entry.reason]]);
      }
    }
  }

  function commit(): void {
    if (chrome === null || editing === null) return;
    const id = editing;
    syncDraftFromInputs();
    // Re-read at commit time: the store may have changed (or dropped the task) while the dialog
    // was open, and the diff below must be against what an undo would restore.
    const current = deps.getTask(id);
    if (current === undefined) {
      close();
      return;
    }
    const result = validateDialog(current, draft);
    if (result.invalid.length === 0) {
      invalid = noInvalid();
      if (Object.keys(result.after).length > 0) deps.apply(id, result.after);
      close();
      return;
    }

    // The dialog stays open: every unusable field is marked with its cause, and the first is
    // announced and focused.
    applyRejection(result);
    const first = result.invalid[0];
    if (first === undefined) return;
    // An empty announcement text is an explicit "say nothing" from the host, not a message to speak.
    const announcement = messages.dialogEditRejected({ label: messages[LABEL_KEYS[first.key]] });
    if (announcement !== "") deps.announcer()?.announce(announcement);
    fields?.[first.key].input.focus?.();
  }

  /** The Save / Cancel bar. Reading `chrome.footer` is what creates it. */
  function buildFooter(box: Dialog): void {
    // Both buttons are at least 32px tall with generous padding, comfortably above the 24x24px
    // minimum target size, and every text/background pair meets the 4.5:1 contrast minimum.
    const base: Record<string, string> = {
      minHeight: "32px",
      padding: "4px 16px",
      borderRadius: "4px",
      cursor: "pointer",
      font: "inherit",
    };
    const save = el(doc, "button", "sg-edit-dialog-save", messages.dialogSave);
    save.setAttribute("type", "button");
    styled(save, {
      ...base,
      border: "1px solid var(--sg-dialog-fg, #1c1917)",
      background: "var(--sg-dialog-fg, #1c1917)",
      color: "var(--sg-dialog-bg, #ffffff)",
    });
    const cancel = el(doc, "button", "sg-edit-dialog-cancel", messages.dialogCancel);
    cancel.setAttribute("type", "button");
    styled(cancel, {
      ...base,
      border: "1px solid var(--sg-dialog-fg, #1c1917)",
      background: "var(--sg-dialog-bg, #ffffff)",
      color: "var(--sg-dialog-fg, #1c1917)",
    });
    // These listeners live on elements the dialog removes on close, so they go with the DOM; the
    // plugin owns one disposer that closes the dialog.
    save.addEventListener("click", () => commit());
    cancel.addEventListener("click", () => close());
    box.footer.appendChild(save);
    box.footer.appendChild(cancel);
  }

  function open(id: TaskId): boolean {
    const task = deps.getTask(id);
    if (task === undefined) return false;
    close();
    editing = id;
    opened = task;
    draft = draftOf(task);
    invalid = noInvalid();

    // The chrome — backdrop, box, header, focus trap, Escape, containment and the header drag —
    // belongs to `@stargantt/sdk`. No `listen` is supplied on purpose: the dialog is built per
    // open, so it must own and drop its own listeners rather than pile them into `ctx.own()`.
    chrome = createDialog({
      host,
      className: DIALOG_CLASS,
      label: messages.dialogTitle,
      modal: true,
      draggable: true,
      minWidth: "360px",
      maxWidth: "480px",
      onClose: () => close(),
    });
    buildFooter(chrome);
    renderBodyInto();
    // The first focusable inside the box: the built-in form's name input, a custom body's first
    // control, or — for a body with none — the Save button.
    chrome.focus();
    return true;
  }

  return {
    open,
    close,
    get isOpen(): boolean {
      return chrome !== null;
    },
    dispose(): void {
      close();
    },
  };
}
