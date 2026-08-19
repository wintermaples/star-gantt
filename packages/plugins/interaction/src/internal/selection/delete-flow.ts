// docs/specs/plugins/interaction.md §2.1 — the confirm-then-delete flow behind `deleteSelected()`.
/**
 * Bulk delete of the selected tasks behind a confirmation: the built-in dialog, or the host's
 * `confirmDelete` hook when the configuration supplied one.
 *
 * One state object holds the confirmation in flight, and every path out of it (button, Escape,
 * backdrop, resolved promise, disposal) returns through the same two transitions. Hostless — the
 * command dispatch, the selection reads/writes and the error report all arrive as callbacks — so
 * the whole flow is unit-testable without booting a plugin host.
 */
import type { TaskId } from "@stargantt/plugin-data-store";
import type { DeleteConfirmRequest } from "../../config";
import { openConfirmDialog } from "./confirm";
import type { ConfirmDialogHandle } from "./confirm";

export interface DeleteFlowOptions {
  /** The element the built-in dialog mounts under — the chart root. */
  host: HTMLElement;
  /** The dialog's question, built from the number of tasks; never throws (the catalog guards it). */
  title(count: number): string;
  /** Label of the confirming button. */
  confirmLabel: string;
  /** Label of the dismissing button. */
  cancelLabel: string;
  /** The host's own confirmation, when the configuration supplied a usable one. */
  confirmHook: ((request: DeleteConfirmRequest) => boolean | Promise<boolean>) | undefined;
  /** The current selection, read when a request starts and again when it is confirmed. */
  selected(): ReadonlySet<TaskId>;
  /** Removes the tasks in one transaction. May throw; the flow contains it. */
  remove(ids: readonly TaskId[]): void;
  /** Adopts a new selection (the one `apply` choke point). */
  applySelection(next: ReadonlySet<TaskId>): void;
  /** Reports a failure in host-supplied or command code without breaking anything else. */
  reportError(error: unknown): void;
}

export interface DeleteFlow {
  /** Starts the confirm-then-delete flow for the current selection; a no-op when not applicable. */
  request(): void;
  /** Whether a confirmation (dialog or host hook) is in flight — the dialog owns the keyboard. */
  inFlight(): boolean;
  /** Closes the dialog in flight, if any. Registered once with `ctx.own()` by the caller. */
  dispose(): void;
}

export function createDeleteFlow(options: DeleteFlowOptions): DeleteFlow {
  const { host, confirmHook, selected, remove, applySelection, reportError } = options;

  // The confirmation in flight — the open dialog, or the pending host hook — modeled as one state
  // object; `undefined` means none. Only one confirmation runs at a time.
  let confirm: { kind: "dialog"; handle: ConfirmDialogHandle } | { kind: "hook" } | undefined;

  /** Deletes the given tasks in one `task/remove` transaction and drops them from the selection. */
  function performDelete(ids: readonly TaskId[]): void {
    try {
      remove(ids);
    } catch (error) {
      // The tasks are still there, so the selection must still name them: a failed dispatch leaves
      // the chart exactly as the user left it, and the failure is reported instead.
      reportError(error);
      return;
    }
    // The selection may have changed while the confirmation was up: subtract exactly the deleted
    // ids instead of clearing wholesale.
    const next = new Set(selected());
    for (const id of ids) next.delete(id);
    applySelection(next);
  }

  // The ids are snapshotted when the confirmation is requested, so what the dialog names is exactly
  // what a confirmation deletes.
  function request(): void {
    if (confirm !== undefined) return;
    const ids = [...selected()];
    if (ids.length === 0) return;

    if (confirmHook !== undefined) {
      // A host-supplied confirmation. Foreign code: contained, never allowed to break the plugin,
      // and a failure cancels the (destructive) deletion rather than performing it.
      confirm = { kind: "hook" };
      let result: boolean | Promise<boolean>;
      try {
        result = confirmHook({ ids: new Set(ids), count: ids.length });
      } catch (error) {
        confirm = undefined;
        reportError(error);
        return;
      }
      if (result === true) {
        confirm = undefined;
        performDelete(ids);
        return;
      }
      if (result !== null && typeof result === "object" && typeof result.then === "function") {
        result.then(
          (ok) => {
            confirm = undefined;
            if (ok === true) performDelete(ids);
          },
          (error: unknown) => {
            confirm = undefined;
            reportError(error);
          },
        );
        return;
      }
      confirm = undefined;
      return;
    }

    const handle = openConfirmDialog({
      host,
      title: options.title(ids.length),
      confirmLabel: options.confirmLabel,
      cancelLabel: options.cancelLabel,
      onClose: (confirmed) => {
        confirm = undefined;
        if (confirmed) performDelete(ids);
      },
    });
    confirm = { kind: "dialog", handle };
  }

  return {
    request,
    inFlight: () => confirm !== undefined,
    dispose(): void {
      if (confirm?.kind === "dialog") confirm.handle.close(false);
      confirm = undefined;
    },
  };
}
