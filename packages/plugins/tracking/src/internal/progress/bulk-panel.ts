// docs/specs/plugins/tracking.md §2.5/§2.16 — the weekly bulk-update panel: an `sdk/dialog` over
// the gantt root listing every task in store order (parents included — an editing surface, not an
// aggregate), one row = name + progress-% input + remaining-work input. Hostless: built off a host
// element and callbacks, so the whole panel is unit-testable without booting a chart.
//
// Modal by design: this panel MUTATES task data (Apply dispatches one
// transaction writing every changed row) — `aria-modal="true"` plus the Tab focus trap `sdk/dialog`
// provides under `modal: true` keep the interaction contained until the edit is committed or
// cancelled, matching the cost table panel's own `modal: true` (both are data-mutating apply
// panels). Read-only panels (the trend panel here, both EVM panels, the cost curve/breakdown
// panels) stay non-modal.
//
// Built on `sdk/dialog`'s `createDialog` and the shared `internal/shared/duration-grammar.ts` parser.
import { createDialog } from "@stargantt/sdk";
import type { TaskId } from "@stargantt/plugin-data-store";
import type { TrackingMessages } from "../messages";
import { parseDurationInput } from "../shared/duration-grammar";

/** One listed task and its current values. */
export interface BulkRow {
  /** The store's task id, passed through verbatim so Apply can resolve it back. */
  id: TaskId;
  name: string;
  /** Current progress, percent 0–100, `undefined` when unset. */
  progressPct: number | undefined;
  /** Current remaining work, in resource-milliseconds, `undefined` when unset. */
  remainingWork: number | undefined;
}

/** One edited row, as gathered by Apply. Absent members were left unchanged or unparsable. */
export interface BulkEdit {
  id: TaskId;
  progressPct?: number;
  /** Resource-milliseconds, parsed from the duration-entry field. */
  remainingWork?: number;
}

export interface BulkCallbacks {
  /** Commits the edits (one transaction) — called before `close`. */
  apply(edits: readonly BulkEdit[]): void;
  /** Closes and disposes the panel (Escape / Cancel / after apply). */
  close(): void;
}

export interface BulkPanel {
  root: HTMLElement;
  /** Moves focus into the panel (the dialog's own first-focusable rule). */
  focus(): void;
  /** Removes the panel DOM and with it every listener it attached. Idempotent. */
  dispose(): void;
}

const BUTTON_STYLE =
  "min-height:24px;min-width:64px;padding:4px 12px;margin-left:8px;cursor:pointer;font:inherit;";
const INPUT_STYLE = "width:88px;min-height:24px;box-sizing:border-box;font:inherit;";

function parseCell(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Builds and mounts the bulk-update panel over `host` (the gantt root, per §2.16).
 *
 * All controls are native form elements, keyboard operable, and labelled with an accessible name
 * combining the row's task name and the column (`"<task> — Progress %"`). Escape (via the shared
 * dialog) and Cancel close with no change; Apply gathers only genuinely changed, parsable, in-range
 * values and commits them as one transaction (`cb.apply`), then closes.
 */
export function createBulkPanel(
  host: HTMLElement,
  rows: readonly BulkRow[],
  messages: TrackingMessages,
  cb: BulkCallbacks,
): BulkPanel {
  const dialog = createDialog({
    host,
    className: "sg-progress-bulk",
    label: messages.bulkTitle,
    modal: true,
    minWidth: "420px",
    maxWidth: "640px",
    top: 24,
    maxHeight: "80%",
    resizable: true,
    onClose: () => cb.close(),
  });
  const doc = dialog.root.ownerDocument;

  const table = doc.createElement("div");
  table.setAttribute("role", "grid");
  table.setAttribute("style", "overflow-y:auto;flex:1;");
  const header = doc.createElement("div");
  header.setAttribute("role", "row");
  header.setAttribute("style", "display:flex;gap:8px;font-weight:600;padding:2px 0;");
  for (const [text, style] of [
    [messages.bulkTaskHeader, "flex:1;"],
    [messages.bulkProgressHeader, "width:88px;"],
    [messages.bulkRemainingHeader, "width:88px;"],
  ] as const) {
    const cell = doc.createElement("span");
    cell.setAttribute("role", "columnheader");
    cell.textContent = text;
    cell.setAttribute("style", style);
    header.appendChild(cell);
  }
  table.appendChild(header);

  interface RowInputs {
    id: TaskId;
    progress: HTMLInputElement;
    remaining: HTMLInputElement;
    /** The text the remaining-work field was pre-filled with, to recognize an untouched field
     *  (the display rounds — comparing the re-parsed number alone would report a phantom edit). */
    remainingText: string;
    initial: BulkRow;
  }
  const inputs: RowInputs[] = [];

  for (const row of rows) {
    const line = doc.createElement("div");
    line.setAttribute("role", "row");
    line.setAttribute("style", "display:flex;gap:8px;align-items:center;padding:2px 0;");
    const name = doc.createElement("span");
    name.setAttribute("role", "gridcell");
    name.textContent = row.name;
    name.setAttribute("style", "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;");
    line.appendChild(name);

    const cellInput = (type: string, value: string, label: string): HTMLInputElement => {
      const input = doc.createElement("input") as HTMLInputElement;
      input.setAttribute("type", type);
      input.setAttribute("style", INPUT_STYLE);
      input.setAttribute("aria-label", `${row.name} — ${label}`);
      input.value = value;
      const cell = doc.createElement("span");
      cell.setAttribute("role", "gridcell");
      cell.appendChild(input);
      line.appendChild(cell);
      return input;
    };
    const progress = cellInput(
      "number",
      row.progressPct === undefined ? "" : String(row.progressPct),
      messages.bulkProgressHeader,
    );
    // Free text (not `type="number"`, which cannot hold "1.5d"), pre-filled through the resolved
    // `duration` catalog member so what the field shows is what it holds.
    const remainingText = row.remainingWork === undefined ? "" : messages.duration(row.remainingWork);
    const remaining = cellInput("text", remainingText, messages.bulkRemainingHeader);
    inputs.push({ id: row.id, progress, remaining, remainingText, initial: row });
    table.appendChild(line);
  }
  dialog.body.appendChild(table);

  const cancel = doc.createElement("button");
  cancel.textContent = messages.bulkCancel;
  cancel.setAttribute("type", "button");
  cancel.setAttribute("style", BUTTON_STYLE);
  const apply = doc.createElement("button");
  apply.textContent = messages.bulkApply;
  apply.setAttribute("type", "button");
  apply.setAttribute("style", BUTTON_STYLE);
  dialog.footer.appendChild(cancel);
  dialog.footer.appendChild(apply);

  /** Gathers the changed, parsable values of every row (§2.5). */
  function gatherEdits(): BulkEdit[] {
    const edits: BulkEdit[] = [];
    for (const row of inputs) {
      const edit: BulkEdit = { id: row.id };
      const pct = parseCell(row.progress.value);
      if (pct !== undefined && pct !== row.initial.progressPct && pct >= 0 && pct <= 100) {
        edit.progressPct = pct;
      }
      if (row.remaining.value !== row.remainingText) {
        const rem = parseDurationInput(row.remaining.value);
        if (rem !== undefined && rem !== row.initial.remainingWork && rem >= 0) {
          edit.remainingWork = rem;
        }
      }
      if (edit.progressPct !== undefined || edit.remainingWork !== undefined) edits.push(edit);
    }
    return edits;
  }

  // The Cancel/Apply buttons live inside the dialog's own subtree, so `dialog.dispose()` (which
  // unmounts that whole subtree) releases these listeners too — nothing accumulates in the plugin
  // context per open/close cycle (§2.16).
  cancel.addEventListener("click", () => cb.close());
  apply.addEventListener("click", () => {
    cb.apply(gatherEdits());
    cb.close();
  });

  return {
    root: dialog.root,
    focus: () => dialog.focus(),
    dispose: () => dialog.dispose(),
  };
}
