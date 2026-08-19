// docs/specs/plugins/export.md §1.6 — the import dialog: CSV column-mapping selects, the issue
// list, and the change preview with per-change checkboxes.
/**
 * Rebased onto the SDK dialog foundation (`sdk/dialog`), which supplies `role="dialog"` /
 * `aria-modal`, Tab cycling confined to the overlay, Escape/close/disposal teardown, and focus
 * return to the previously focused element (chart-pane fallback, applied here the same way the
 * print-preview dialog applies it). What stays this module's own is the body content and the
 * public `sg-ie-*` class surface §1.6 names.
 *
 * Hostless in the sense that matters here: everything below is built off a host element and
 * callbacks, unit-testable without a plugin host (`createDialog` itself only touches the DOM it is
 * handed).
 *
 * Review ruling (aligned with the print preview, `internal/print/preview.ts`): every color on
 * content *inside* the dialog panel reads from the `--sg-dialog-*` token family, never the chart's
 * own `--sg-*` tokens. No theme in this program defines `--sg-dialog-*`, so the panel itself always
 * renders on the light `--sg-dialog-bg` fallback regardless of the chart's active color scheme —
 * text pulled from a *chart* token (e.g. `--sg-muted-fg`, which a dark scheme repoints to a light
 * color meant to sit on a *dark* chart background) would go low-contrast on that always-light
 * panel. `--sg-dialog-muted-fg` carries the same light-appropriate fallback as the chart token, so
 * the rendered color is unchanged in the (today, only) unthemed case; the fix is the token family,
 * not the value.
 */
import { createDialog } from "@stargantt/sdk";
import type { Dialog } from "@stargantt/sdk";
import { DEFAULT_MESSAGES, defaultIssueText } from "../messages";
import type { ExportMessages } from "../messages";
import type { CsvMapping, ImportChange, ImportDocument, ImportIssue, TaskCsvField } from "../../types";
import { CSV_FIELDS } from "./csv";

const DIALOG_CLASS = "sg-ie-dialog";

export interface DialogState {
  doc: ImportDocument;
  issues: ImportIssue[];
  changes: ImportChange[];
}

export interface DialogCallbacks {
  /** Re-parses the CSV source under a new mapping and returns the fresh issues + diff. */
  remap(mapping: CsvMapping): DialogState;
  /** Applies the checked changes. */
  apply(changes: readonly ImportChange[]): void;
  /** Closes and disposes the dialog (Escape / backdrop / Cancel / after apply). */
  close(): void;
  /** Reports a throwing host-supplied message builder (§1 option-resolution rule). */
  fault(where: string, error: unknown): void;
}

export interface ImportDialog {
  root: HTMLElement;
  dispose(): void;
}

function changeLabel(change: ImportChange, messages: ExportMessages): { tag: string; text: string } {
  switch (change.kind) {
    case "add":
      return { tag: messages.changeAdd, text: change.task.name };
    case "update":
      return { tag: messages.changeUpdate, text: String(change.after.name ?? change.before.name ?? change.id) };
    case "remove":
      return { tag: messages.changeRemove, text: String(change.id) };
  }
}

function button(doc: Document, className: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = doc.createElement("button");
  b.type = "button";
  b.className = className;
  b.textContent = label;
  b.style.cssText =
    "min-width:64px;min-height:24px;padding:4px 12px;font:inherit;cursor:pointer;" +
    "color:var(--sg-dialog-fg, #1c1917);background:var(--sg-dialog-bg, #ffffff);" +
    "border:1px solid var(--sg-dialog-border, #d6d3d1);border-radius:4px;";
  b.addEventListener("click", onClick);
  return b;
}

export function createImportDialog(
  host: HTMLElement,
  initial: DialogState,
  messages: ExportMessages,
  cb: DialogCallbacks,
): ImportDialog {
  const doc = host.ownerDocument;

  /** Per-call containment for host-supplied builders: report the throw, use the default text. */
  function safeCount(key: "issuesHeading" | "applyButton", count: number): string {
    try {
      return messages[key](count);
    } catch (error) {
      cb.fault(`messages.${key}`, error);
      return DEFAULT_MESSAGES[key](count);
    }
  }
  function safeIssueText(issue: ImportIssue): string {
    try {
      return messages.issueText(issue);
    } catch (error) {
      cb.fault("messages.issueText", error);
      return defaultIssueText(issue);
    }
  }
  const fieldLabel = (field: TaskCsvField): string => {
    try {
      return messages.fieldLabel(field);
    } catch (error) {
      cb.fault("messages.fieldLabel", error);
      return field;
    }
  };

  const dialog: Dialog = createDialog({
    host,
    className: DIALOG_CLASS,
    label: messages.dialogTitle,
    modal: true,
    draggable: false,
    width: "440px",
    maxWidth: "92%",
    maxHeight: "calc(100% - 48px)",
    onClose: cb.close,
  });

  let state = initial;
  const selected = new Set<number>();

  /* --- CSV column mapping (§1.6) ----------------------------------------- */
  if (state.doc.format === "csv" && state.doc.headers !== undefined && state.doc.headers.length > 0) {
    const legend = doc.createElement("div");
    legend.className = "sg-ie-mapping-legend";
    legend.textContent = messages.mappingLegend;
    legend.style.fontWeight = "600";
    legend.style.margin = "0 0 4px";
    dialog.body.appendChild(legend);

    const mapping: (TaskCsvField | null)[] = [...(state.doc.mapping ?? state.doc.headers.map(() => null))];
    const section = doc.createElement("div");
    section.className = "sg-ie-mapping";
    state.doc.headers.forEach((header, index) => {
      const line = doc.createElement("label");
      line.className = "sg-ie-mapping-row";
      Object.assign(line.style, { display: "flex", gap: "8px", alignItems: "center", padding: "2px 0" });
      const name = doc.createElement("span");
      name.textContent = header;
      name.style.flex = "1";
      const select = doc.createElement("select") as HTMLSelectElement;
      select.className = "sg-ie-mapping-select";
      select.setAttribute("aria-label", header);
      select.style.minHeight = "24px"; // WCAG 2.5.8 pointer-target floor
      const none = doc.createElement("option") as HTMLOptionElement;
      none.value = "";
      none.textContent = messages.ignoreColumn;
      select.appendChild(none);
      for (const field of CSV_FIELDS) {
        const option = doc.createElement("option") as HTMLOptionElement;
        option.value = field;
        option.textContent = fieldLabel(field);
        select.appendChild(option);
      }
      select.value = mapping[index] ?? "";
      select.addEventListener("change", () => {
        const value = select.value;
        mapping[index] = value === "" ? null : (value as TaskCsvField);
        state = cb.remap(mapping);
        selected.clear();
        renderResults();
      });
      line.appendChild(name);
      line.appendChild(select);
      section.appendChild(line);
    });
    dialog.body.appendChild(section);
  }

  /* --- issues + preview (rebuilt on every remap) -------------------------- */
  const results = doc.createElement("div");
  results.className = "sg-ie-results";
  dialog.body.appendChild(results);

  const footer = dialog.footer;
  const cancel = button(doc, "sg-ie-cancel", messages.cancelButton, () => cb.close());
  const apply = button(doc, "sg-ie-apply", "", () => {
    const chosen = state.changes.filter((_, i) => selected.has(i));
    if (chosen.length > 0) cb.apply(chosen);
    cb.close();
  });
  footer.appendChild(cancel);
  footer.appendChild(apply);

  function refreshApply(): void {
    apply.textContent = safeCount("applyButton", selected.size);
    if (selected.size === 0) apply.setAttribute("disabled", "");
    else apply.removeAttribute("disabled");
  }

  function renderResults(): void {
    results.textContent = "";
    const allIssues = [...state.doc.issues, ...state.issues];
    if (allIssues.length > 0) {
      const heading = doc.createElement("div");
      heading.className = "sg-ie-issues-heading";
      heading.textContent = safeCount("issuesHeading", allIssues.length);
      heading.style.fontWeight = "600";
      heading.style.margin = "8px 0 2px";
      results.appendChild(heading);
      const list = doc.createElement("ul");
      list.className = "sg-ie-issues";
      Object.assign(list.style, { margin: "0", paddingLeft: "16px", color: "var(--sg-dialog-muted-fg, #78716c)" });
      for (const issue of allIssues) {
        const item = doc.createElement("li");
        item.className = "sg-ie-issue";
        item.textContent = safeIssueText(issue);
        list.appendChild(item);
      }
      results.appendChild(list);
    }

    const heading = doc.createElement("div");
    heading.className = "sg-ie-preview-heading";
    heading.textContent = messages.previewHeading;
    heading.style.fontWeight = "600";
    heading.style.margin = "8px 0 2px";
    results.appendChild(heading);

    if (state.changes.length === 0) {
      const empty = doc.createElement("div");
      empty.className = "sg-ie-no-changes";
      empty.textContent = messages.noChanges;
      empty.style.color = "var(--sg-dialog-muted-fg, #78716c)";
      results.appendChild(empty);
    } else {
      /** The checkbox of every change line, by change index — read by the add-dependency sync. */
      const boxes: HTMLInputElement[] = [];
      /** The change index adding each task id, so a child add can find its parent's line. */
      const addIndexByTaskId = new Map<unknown, number>();
      state.changes.forEach((change, index) => {
        if (change.kind === "add") addIndexByTaskId.set(change.task.id, index);
      });
      /** Whether this add's parent chain holds an unchecked add — applying it would `task/add`
       * under a parent id that will not exist, so the child is unchecked and disabled with it. */
      function blockedByParent(index: number): boolean {
        for (let i = index, hops = 0; hops < state.changes.length; hops += 1) {
          const change = state.changes[i];
          if (change === undefined || change.kind !== "add" || change.task.parentId === null) return false;
          const parent = addIndexByTaskId.get(change.task.parentId);
          if (parent === undefined || parent === i) return false;
          if (!selected.has(parent)) return true;
          i = parent;
        }
        return false; // cycle guard: a cyclic add chain cannot block itself forever
      }
      /** Cascades parent-add unchecks: dependent adds are unchecked and disabled until the
       * parent is checked again — and re-checking the parent restores exactly the lines the
       * cascade itself cleared (a user's own deliberate unchecks are left alone). */
      const cascaded = new Set<number>();
      function syncAddDependencies(): void {
        // Restoring an intermediate add can unblock a descendant listed at an earlier index, so
        // the pass repeats until it reaches a fixed point (bounded by the chain depth).
        let changedInPass = true;
        while (changedInPass) {
          changedInPass = false;
          syncAddDependenciesPass(() => {
            changedInPass = true;
          });
        }
      }
      function syncAddDependenciesPass(onChange: () => void): void {
        state.changes.forEach((change, index) => {
          if (change.kind !== "add") return;
          const box = boxes[index];
          if (box === undefined) return;
          if (blockedByParent(index)) {
            if (selected.has(index)) {
              cascaded.add(index);
              onChange();
            }
            selected.delete(index);
            box.checked = false;
            box.setAttribute("disabled", "");
          } else {
            box.removeAttribute("disabled");
            if (cascaded.delete(index)) {
              selected.add(index);
              box.checked = true;
              onChange();
            }
          }
        });
      }
      state.changes.forEach((change, index) => {
        // Adds and updates are pre-checked; removes are opt-in — deleting must be a deliberate choice.
        if (change.kind !== "remove") selected.add(index);
        const line = doc.createElement("label");
        line.className = "sg-ie-change";
        line.setAttribute("data-kind", change.kind);
        Object.assign(line.style, { display: "flex", gap: "6px", alignItems: "center", padding: "2px 0", minHeight: "24px" });
        const box = doc.createElement("input") as HTMLInputElement;
        boxes[index] = box;
        box.setAttribute("type", "checkbox");
        box.checked = change.kind !== "remove";
        box.addEventListener("change", () => {
          if (box.checked) selected.add(index);
          else selected.delete(index);
          syncAddDependencies();
          refreshApply();
        });
        const { tag, text } = changeLabel(change, messages);
        const tagEl = doc.createElement("span");
        tagEl.className = "sg-ie-change-tag";
        tagEl.textContent = tag;
        tagEl.style.fontWeight = "600";
        const textEl = doc.createElement("span");
        textEl.className = "sg-ie-change-text";
        textEl.textContent = text;
        line.appendChild(box);
        line.appendChild(tagEl);
        line.appendChild(textEl);
        results.appendChild(line);
      });
      syncAddDependencies();
    }
    refreshApply();
  }

  renderResults();
  dialog.focus();

  return {
    root: dialog.root,
    dispose: () => {
      dialog.dispose();
      // §1.6 — focus returns to the element that held it before the dialog opened; the foundation
      // does exactly that, but leaves focus where the browser put it when that element is gone (or
      // was never focusable). The chart pane is this plugin's documented fallback for that case.
      const active = doc.activeElement;
      if (active === null || active === doc.body) host.focus?.();
    },
  };
}
