// docs/specs/plugins/resource.md §3.3 "Editor" — the assignment editor: one dialog at a time,
// opened at a cell, committing a diff or cancelling with nothing written. Modeled as one session
// object with explicit open/commit/cancel transitions. A hand-rolled dialog (not `sdk/dialog`):
// this editor is cell-anchored via `placement.ts`'s own clamped/flip-aware math, a fundamentally
// different positioning model than `sdk/dialog`'s host-centered one.
import type { AssignmentLike, ChoiceLike, Id } from "./model";
import { percentToUnits, toUnitsPercent, unitsOf } from "./model";
import { placeEditor } from "./placement";
import {
  styleApplyCancel,
  styleButtons,
  styleEditor,
  styleName,
  styleRow,
  styleRows,
  styleUnitsInput,
} from "./style";

/** What the editor session needs from the plugin instance. */
export interface EditorDeps {
  /** The gantt root element the dialog is appended to and positioned within. */
  root: HTMLElement;
  /** Dialog accessible name. */
  title: string;
  /** Text shown when `choices()` is empty. */
  emptyChoices: string;
  applyLabel: string;
  cancelLabel: string;
  /** Guarded `messages.assignToggleLabel`. */
  toggleLabel(name: string): string;
  /** Guarded `messages.unitsInputLabel`. */
  unitsLabel(name: string): string;
  choices(): readonly ChoiceLike[];
  assignmentsOf(taskId: Id): readonly AssignmentLike[];
  /** Dispatches the diff of `desired` against the task's current assignments, as one transaction. */
  commit(taskId: Id, desired: Map<Id, number>): void;
}

export interface EditorSession {
  /** Opens the dialog for a task at an anchor cell; an already-open dialog is cancelled first. */
  open(anchor: HTMLElement, taskId: Id): void;
  /** Closes without writing anything. No-op when closed. */
  cancel(): void;
  isOpen(): boolean;
  /** The dialog element, `null` when closed (exposed for tests). */
  element(): HTMLElement | null;
}

interface Row {
  readonly id: Id;
  readonly check: HTMLInputElement;
  readonly units: HTMLInputElement;
  /** The percent text this plugin itself last wrote into `units.value` (at open, or at the last
   * write-back). If `units.value` still equals this, the user never touched the field since, so
   * its *display* text (a whole percent) must not be treated as the authority on the value — the
   * stored units, which may not be a whole percent, are. Kept in sync by `writeBackRow`. */
  writtenValue: string;
}

export function createEditorSession(deps: EditorDeps): EditorSession {
  let popup: HTMLElement | null = null;
  let rows: Row[] = [];
  let openTaskId: Id | null = null;
  let opener: HTMLElement | null = null;

  /** Removes the dialog DOM and clears the session state; returns what focus restore needs. */
  function teardown(): { taskId: Id; back: HTMLElement | null } | null {
    if (popup === null || openTaskId === null) return null;
    popup.parentNode?.removeChild(popup);
    popup = null;
    rows = [];
    const taskId = openTaskId;
    openTaskId = null;
    const back = opener;
    opener = null;
    return { taskId, back };
  }

  // Focus restore (§3.3): the grid virtualizes its cells, so the element the dialog was opened
  // from may have been replaced by a repaint while the dialog was up. Re-resolve the task's
  // current open-editor button first (a stable data attribute, not a captured DOM reference) and
  // fall back to the captured anchor only when the cell is no longer rendered.
  function restoreFocus(taskId: Id, back: HTMLElement | null): void {
    const live = deps.root.querySelector<HTMLElement>(
      `[data-sg-ra-open="${String(taskId).replace(/"/g, '\\"')}"]`,
    );
    (live ?? back)?.focus?.();
  }

  function close(): void {
    const session = teardown();
    if (session !== null) restoreFocus(session.taskId, session.back);
  }

  /** The units a row's percent text resolves to (§3.3): unusable text falls back to the pair's
   * existing units, or 1 for a pair with none yet.
   *
   * When the field still shows exactly what this plugin last wrote into it (the user hasn't
   * touched it since open or the last blur), the pair's *stored* units win over re-parsing the
   * displayed whole percent — a stored value like 0.335 (33.5%) round-trips through the display as
   * "34", and re-parsing that back would silently rewrite an untouched assignment's units on every
   * Apply. Only an actual edit should ever change a pair's units. */
  function effectiveUnits(row: Row, current: readonly AssignmentLike[]): number {
    const stored = unitsOf(current, row.id);
    if (row.units.value === row.writtenValue && stored !== undefined) return stored;
    return percentToUnits(row.units.value) ?? stored ?? 1;
  }

  /** Rewrites a row's percent input to the value it would actually commit, so the number
   * a user last sees is always the number that would be committed — never a typed value silently
   * discarded without visible feedback. Also re-baselines `writtenValue`, so the next
   * `effectiveUnits` call still recognizes an untouched field as untouched. */
  function writeBackRow(row: Row, current: readonly AssignmentLike[]): void {
    row.units.value = String(toUnitsPercent(effectiveUnits(row, current)));
    row.writtenValue = row.units.value;
  }

  function commitNow(): void {
    if (popup === null || openTaskId === null) return;
    const current = deps.assignmentsOf(openTaskId);
    const desired = new Map<Id, number>();
    for (const row of rows) {
      if (!row.check.checked) continue;
      const units = effectiveUnits(row, current);
      // Write back before the dialog closes: the value about to be dispatched is the
      // last one on screen, even though the row is torn down immediately after.
      writeBackRow(row, current);
      desired.set(row.id, units);
    }
    const session = teardown();
    if (session === null) return;
    // Dispatch first, restore focus last: the commit re-renders the cell and replaces its open
    // button, so focusing before dispatch would leave focus on a detached element.
    deps.commit(session.taskId, desired);
    restoreFocus(session.taskId, session.back);
  }

  function open(anchor: HTMLElement, taskId: Id): void {
    close();
    const doc = deps.root.ownerDocument;
    const current = deps.assignmentsOf(taskId);
    const dialog = doc.createElement("div");
    dialog.className = "sg-ra-editor";
    dialog.setAttribute("data-sg-ra-editor", String(taskId));
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-label", deps.title);
    // A modal dialog: assistive tech must treat everything behind it as inert.
    dialog.setAttribute("aria-modal", "true");
    styleEditor(dialog);
    // The dialog is parked at a fixed, layout-neutral spot first and only repositioned once its
    // content (below) and its final box (appended further down) exist to measure.
    dialog.style.left = "0px";
    dialog.style.top = "0px";

    const rowsWrap = doc.createElement("div");
    rowsWrap.className = "sg-ra-rows";
    styleRows(rowsWrap);
    dialog.appendChild(rowsWrap);

    const choices = deps.choices();
    if (choices.length === 0) {
      const empty = doc.createElement("div");
      empty.className = "sg-ra-empty";
      empty.textContent = deps.emptyChoices;
      rowsWrap.appendChild(empty);
    }
    for (const choice of choices) {
      const row = doc.createElement("div");
      row.className = "sg-ra-row";
      styleRow(row);

      const check = doc.createElement("input") as HTMLInputElement;
      check.setAttribute("type", "checkbox");
      check.setAttribute("aria-label", deps.toggleLabel(choice.name));
      const units = unitsOf(current, choice.id);
      check.checked = units !== undefined;

      const name = doc.createElement("span");
      name.className = "sg-ra-name";
      styleName(name);
      name.textContent = choice.name;

      const percent = doc.createElement("input") as HTMLInputElement;
      percent.className = "sg-ra-units";
      percent.setAttribute("type", "number");
      percent.setAttribute("min", "1");
      percent.setAttribute("max", "1000");
      percent.setAttribute("step", "1");
      percent.setAttribute("aria-label", deps.unitsLabel(choice.name));
      percent.value = String(units === undefined ? 100 : toUnitsPercent(units));
      styleUnitsInput(percent);

      row.appendChild(check);
      row.appendChild(name);
      row.appendChild(percent);
      rowsWrap.appendChild(row);
      // `writtenValue` starts equal to what was just written into `percent.value` above, so
      // `effectiveUnits` treats the row as untouched (and reuses the pair's exact stored units,
      // not the possibly-rounded display text) until the user actually edits it.
      const rowEntry: Row = { id: choice.id, check, units: percent, writtenValue: percent.value };
      rows.push(rowEntry);
      // Leaving the field (Tab, click elsewhere) writes back its effective value immediately,
      // so an unusable or over-1000 value never sits on screen looking accepted.
      // Assignments are re-read at blur time (not captured from open time) so that a data-layer
      // change while the dialog is up resolves to the same live units the commit path would use.
      percent.addEventListener("blur", () => writeBackRow(rowEntry, deps.assignmentsOf(taskId)));
    }

    const buttons = doc.createElement("div");
    buttons.className = "sg-ra-buttons";
    styleButtons(buttons);

    const apply = doc.createElement("button");
    apply.className = "sg-ra-apply";
    apply.setAttribute("type", "button");
    apply.textContent = deps.applyLabel;
    styleApplyCancel(apply);
    apply.addEventListener("click", () => commitNow());

    const cancel = doc.createElement("button");
    cancel.className = "sg-ra-cancel";
    cancel.setAttribute("type", "button");
    cancel.textContent = deps.cancelLabel;
    styleApplyCancel(cancel);
    cancel.addEventListener("click", () => close());

    buttons.appendChild(apply);
    buttons.appendChild(cancel);
    dialog.appendChild(buttons);

    // Focus-trap tab order: every row's checkbox and percent input, in DOM order, then Apply and
    // Cancel — the same order a sighted user tabs through visually. Read live (not captured once)
    // so a choice list with zero rows still traps between Apply and Cancel.
    const focusables = (): HTMLElement[] => {
      const list: HTMLElement[] = [];
      for (const row of rows) list.push(row.check, row.units);
      list.push(apply, cancel);
      return list;
    };

    // Escape cancels with full revert; Enter commits unless a button already handles it; Tab is
    // trapped inside the dialog (wrapping last -> first / Shift+Tab first -> last) so keyboard
    // focus can never escape into the grid behind it. Outside-pointerdown dismissal is `wire.ts`'s
    // document listener, which calls this session's `cancel` — the same no-write path as Escape.
    dialog.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      } else if (
        e.key === "Enter" &&
        (e.target as { tagName?: string } | null)?.tagName?.toLowerCase() !== "button"
      ) {
        e.preventDefault();
        commitNow();
      } else if (e.key === "Tab") {
        const items = focusables();
        const first = items[0];
        const last = items[items.length - 1];
        if (first === undefined || last === undefined) return;
        const active = dialog.ownerDocument.activeElement as HTMLElement | null;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus?.();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus?.();
        }
      }
    });

    deps.root.appendChild(dialog);

    // Measured only now that the dialog is mounted with its final content, so its own box
    // reflects the real footprint the placement math clamps and flips against. Once
    // `maxHeight` caps the dialog's own box, the flex idiom above (`overflow: hidden` box,
    // `rowsWrap` as the only `flex: 1 1 auto` / `overflow-y: auto` child) forces any overflow into
    // `rowsWrap`'s scrollbar instead of the buttons row.
    const rootRect = deps.root.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const dialogRect = dialog.getBoundingClientRect();
    // The root may be scrolled internally and/or bordered; both shift where the editor's
    // `left`/`top` need to land relative to the box `getBoundingClientRect()` alone reports (see
    // `placeEditor`'s doc comment).
    const placement = placeEditor(
      anchorRect,
      {
        left: rootRect.left,
        top: rootRect.top,
        width: rootRect.width,
        height: rootRect.height,
        // `DOMRect`'s own fields are accessor getters, not own enumerable properties, so a spread
        // (`{ ...rootRect }`) would silently drop them in a real browser — every field is read out
        // explicitly instead.
        scrollLeft: deps.root.scrollLeft,
        scrollTop: deps.root.scrollTop,
        clientLeft: deps.root.clientLeft,
        clientTop: deps.root.clientTop,
      },
      { width: dialogRect.width, height: dialogRect.height },
    );
    dialog.style.left = `${String(placement.left)}px`;
    dialog.style.top = `${String(placement.top)}px`;
    dialog.style.maxHeight = `${String(placement.maxHeight)}px`;

    popup = dialog;
    openTaskId = taskId;
    opener = anchor;
    (rows[0]?.check ?? apply).focus?.();
  }

  return {
    open,
    cancel: close,
    isOpen: () => popup !== null,
    element: () => popup,
  };
}
