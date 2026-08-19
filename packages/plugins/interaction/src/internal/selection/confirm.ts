// docs/specs/plugins/interaction.md §2.1 — the built-in bulk-delete confirmation dialog.
/**
 * The confirmation shown before a bulk delete, built on the SDK's dialog foundation
 * (`sdk/dialog`) rather than on a second hand-rolled modal: the backdrop, the `aria-modal` marking,
 * the Tab focus trap, the Escape and outside-press dismissals and the focus restore all come from
 * there. This module adds only what a confirmation needs — the question, the two buttons, and the
 * "cancel is focused first" rule a destructive action requires.
 *
 * Hostless apart from the host element: everything else (strings, close callback) arrives as
 * arguments, so it is exercisable against a fake DOM. The caller owns disposal — one re-armed
 * disposable, per the `ctx.own()` discipline.
 */
import { createDialog, styled } from "@stargantt/sdk";

export interface ConfirmDialogOptions {
  /** The element the dialog mounts under — the chart root. */
  host: HTMLElement;
  /** The dialog's question, e.g. `"Delete 3 tasks?"`. */
  title: string;
  /** Label of the confirming (destructive) button. */
  confirmLabel: string;
  /** Label of the dismissing button. */
  cancelLabel: string;
  /** Called exactly once, when the dialog closes; `confirmed` says which button won. */
  onClose(confirmed: boolean): void;
}

export interface ConfirmDialogHandle {
  /** The dialog box element, for tests and for callers that need to inspect it. */
  readonly element: HTMLElement;
  /** Closes the dialog programmatically (detaches it and fires `onClose` if still pending). */
  close(confirmed: boolean): void;
}

/** The class name of the confirmation box, the hook a host stylesheet restyles it by. */
export const CONFIRM_CLASS = "sg-selection-confirm";

/**
 * Opens a modal confirmation over the chart.
 *
 * Keyboard: focus starts on the cancel button — the safe default for a destructive action, and the
 * reason the buttons are appended cancel-first — Tab cycles inside the box, and Escape cancels.
 * Pointer: either button decides, and a press on the dimmed backdrop cancels. Both buttons are at
 * least 32px tall, comfortably above the 24x24 CSS px minimum target size.
 */
export function openConfirmDialog(options: ConfirmDialogOptions): ConfirmDialogHandle {
  const doc = options.host.ownerDocument;
  let pending = true;

  function close(confirmed: boolean): void {
    if (!pending) return;
    pending = false;
    dialog.dispose();
    options.onClose(confirmed);
  }

  const dialog = createDialog({
    host: options.host,
    className: CONFIRM_CLASS,
    label: options.title,
    modal: true,
    // A confirmation is a decision, not a workspace: there is nothing behind it worth uncovering,
    // and a draggable question box invites a drag that the chart would rather have as an edit.
    draggable: false,
    onClose: () => close(false),
  });
  // A question, not a passive dialog: assistive technology should interrupt for it.
  dialog.root.setAttribute("role", "alertdialog");

  const question = doc.createElement("div");
  question.className = `${CONFIRM_CLASS}__title`;
  question.textContent = options.title;
  dialog.body.appendChild(question);

  const button = (className: string, label: string, danger: boolean): HTMLElement => {
    const el = doc.createElement("button");
    el.className = className;
    el.setAttribute("type", "button");
    el.textContent = label;
    styled(el, {
      minHeight: "32px",
      padding: "4px 16px",
      borderRadius: "4px",
      cursor: "pointer",
      font: "inherit",
      border: danger
        ? "1px solid var(--sg-dialog-danger, #b3261e)"
        : "1px solid var(--sg-dialog-fg, #1c1917)",
      background: danger ? "var(--sg-dialog-danger, #b3261e)" : "var(--sg-dialog-bg, #ffffff)",
      color: danger ? "var(--sg-dialog-danger-fg, #ffffff)" : "var(--sg-dialog-fg, #1c1917)",
    });
    return el;
  };

  // Cancel first, so the dialog's own "focus the first focusable element" rule lands on the safe
  // choice: Enter must never delete by default.
  const cancelBtn = button(`${CONFIRM_CLASS}__cancel`, options.cancelLabel, false);
  const confirmBtn = button(`${CONFIRM_CLASS}__delete`, options.confirmLabel, true);
  cancelBtn.addEventListener("click", () => close(false));
  confirmBtn.addEventListener("click", () => close(true));
  dialog.footer.appendChild(cancelBtn);
  dialog.footer.appendChild(confirmBtn);

  // A modal owns the keyboard while it is up: a key pressed inside it must not also reach the
  // chart's own document-level bindings (Delete, Ctrl+A, the arrow navigation) behind the dimmed
  // backdrop. The dialog foundation stops only Escape, so everything else is stopped here — except
  // the two keys the dialog itself answers, which have to keep bubbling to its own handler on the
  // backdrop.
  dialog.root.addEventListener("keydown", (e) => {
    const key = (e as KeyboardEvent).key;
    if (key === "Escape" || key === "Tab") return;
    e.stopPropagation?.();
  });

  dialog.focus();

  return { element: dialog.root, close };
}
