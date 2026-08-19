/**
 * The inline-edit session: one explicit state machine for "a cell is being edited".
 *
 * At most one session is open at a time and it has exactly four exits — `commit`, `cancel`, being
 * replaced by a newer session, or being **evicted** because a repaint no longer paints its cell (the
 * row was deleted, collapsed, scrolled out of the window, or the slot pool was rebuilt; element
 * removal fires no `blur`). The repaint loop asks the session whether a cell is its own instead of
 * cooperating with it through a flag.
 */
// docs/specs/plugins/tree-grid.md § Internal modules — accessor-based per-column editing, the
// shared plain-text editor, the `task/update` commit path, `readOnly`, and editor teardown
// restoring focus.
import type { Task, TaskId } from "@stargantt/plugin-data-store";
import type { ColumnDef } from "../types";
import type { ColumnTrack } from "./column-track";
import { el } from "./dom";
import type { RowModel } from "./row-model";
import { sameValue } from "./value-diff";

/** The `commit`/`cancel` pair handed to an editor; exactly one of the two must be called. */
export interface EditDone {
  commit(value: unknown): void;
  cancel(): void;
}

// docs/specs/plugins/tree-grid.md § Internal modules
/**
 * Whether a column is currently editable: `setValue` present, `editable` not explicitly `false`,
 * and the grid not configured `readOnly: true`, which overrides every column uniformly.
 */
export function isEditable(column: ColumnDef, readOnly: boolean): boolean {
  return !readOnly && typeof column.setValue === "function" && column.editable !== false;
}

export interface EditSessionDeps {
  doc: Document;
  track: ColumnTrack;
  model: RowModel;
  // docs/specs/plugins/tree-grid.md § Config — `readOnly` is already validated by the plugin
  // entry.
  /** Whether every column behaves as `editable: false`, whatever its `setValue`. */
  readOnly: boolean;
  /** The materialized cells of a row, or `undefined` when that row is not materialized. */
  cellsOf(row: number): readonly HTMLElement[] | undefined;
  /** Dispatches `task/update` with the changed fields only — the undoable commit path. */
  update(id: TaskId, after: Partial<Task>): void;
  /** Reports a fault raised by a contributed `getValue` / `setValue` / `editor`. */
  fault(error: unknown): void;
  /**
   * Returns DOM focus out of a closing editor's host. Called before the host is detached, so the
   * implementation can check whether the editor still holds focus at all.
   */
  restoreFocus(host: HTMLElement): void;
  /** Queues a repaint on the next frame. */
  schedule(): void;
}

/** One open edit: which cell it covers, and how it finishes. */
interface OpenEdit {
  id: TaskId;
  cell: HTMLElement;
  /** The host element the editor (shared or custom) renders into; created and disposed here. */
  host: HTMLElement;
  /**
   * Guards against a duplicate `done.commit` / `done.cancel` call from a custom editor: only the
   * first of the two takes effect.
   *
   * Being **replaced** by a newer session does not set it. A custom editor is opaque — the grid
   * cannot tell it "you are gone" — so a `done.commit` arriving after its cell was superseded is
   * still honoured: the user's typed value reaches `setValue` rather than being dropped, which is
   * the same reasoning the shared editor's eviction commit follows. The cost is that such a late
   * commit also tears down whichever session is current at that moment (`detach` disposes
   * `current`, not this one) without giving it a `commit` or `cancel`. That is a deliberately
   * preserved edge case, pinned by a regression test; it is reachable only from a custom editor
   * that keeps calling `done` after the grid has moved on.
   */
  finished: boolean;
  /** True while the shared text input is the one mounted, for the repaint-eviction fallback. */
  shared: boolean;
  done: EditDone;
}

export interface EditSession {
  /**
   * The shared plain-text editor, reused across every edit of a column that supplies no `editor` of
   * its own, so its listeners are registered exactly once by the caller.
   */
  readonly input: HTMLInputElement;
  /**
   * The open session's `commit`/`cancel` pair when the shared editor is the one mounted, else `null`
   * — what the shared input's own keydown/blur listeners act through.
   */
  sharedDone(): EditDone | null;
  /**
   * Opens an edit of one cell of `row`, returning whether an edit was actually opened. `columnId`
   * omitted targets the first editable column in composed order; a `columnId` that matches no
   * column, or one that is not editable, is a no-op — as is a row with no materialized cell, or no
   * editable column existing at all.
   */
  open(row: number, columnId?: string): boolean;
  /**
   * Whether `node` sits inside the open edit's editor host — used by pane-level key bindings to
   * stay off an open inline editor (shared or custom) whose keystrokes bubble up to the pane.
   */
  within(node: EventTarget | null): boolean;
  /** Starts a repaint pass: the open session has not yet seen its cell painted. */
  beginPaintPass(): void;
  /**
   * Whether `cell` is the open session's editor cell for `id` — in which case the repaint must leave
   * it untouched, and the session records that this pass retained it.
   */
  retains(id: TaskId | undefined, cell: HTMLElement): boolean;
  /**
   * Ends a repaint pass. An open session whose cell the pass did not retain is evicted: the shared
   * editor's typed value is still recoverable so it is committed, while a custom editor's
   * in-progress value is not observable from outside it, so its edit is cancelled instead of
   * guessing at a value to commit.
   */
  endPaintPass(): void;
}

export function createEditSession(deps: EditSessionDeps): EditSession {
  const { doc, track, model } = deps;

  const input = doc.createElement("input");
  input.className = "sg-grid-editor";

  let current: OpenEdit | null = null;
  /** Whether the repaint pass in progress painted the edited row without disturbing its editor. */
  let retained = false;

  /** Tears down the open session's host element, without invoking `commit`/`cancel`. */
  function detach(): void {
    if (current === null) return;
    current.host.remove();
    current = null;
  }

  // docs/specs/plugins/tree-grid.md § Internal modules
  /**
   * Writes an edited value back through the column's `setValue`, then dispatches `task/update` with
   * only the fields that actually changed, so the write is undoable. `setValue` is handed a private
   * mutable draft typed `Readonly<Task>` only at the API surface; the grid, not the column, owns
   * building the diff.
   *
   * The diff is a *value* comparison (`sameValue`), not a reference comparison: a `setValue` that
   * rebuilds an object/array-valued field (e.g. `task.meta = { ...task.meta, priority: n }`) always
   * produces a fresh reference, and comparing references would dispatch a no-op `task/update` —
   * and with it a phantom undo entry — for a commit that changed nothing.
   */
  function applyEdit(id: TaskId, task: Readonly<Task>, column: ColumnDef, value: unknown): void {
    if (typeof column.setValue !== "function") return;
    const draft: Task = { ...task };
    try {
      column.setValue(draft, value);
    } catch (error) {
      deps.fault(error);
      return;
    }
    const after: Partial<Task> = {};
    let changed = false;
    for (const key of Object.keys(draft) as (keyof Task)[]) {
      if (!sameValue(draft[key], task[key])) {
        // A `Partial<Task>` cannot be indexed by a computed `keyof Task` without widening the
        // target; the key and the value both come from the same `draft`, so the write is sound.
        (after as Record<string, unknown>)[key] = draft[key];
        changed = true;
      }
    }
    if (changed) deps.update(id, after);
  }

  /** The editability rule resolved to a column index, or `-1`. */
  function editableColumnIndex(columnId: string | undefined): number {
    const columns = track.list();
    if (columnId !== undefined) {
      return columns.findIndex((c) => c.id === columnId && isEditable(c, deps.readOnly));
    }
    return columns.findIndex((c) => isEditable(c, deps.readOnly));
  }

  function open(row: number, columnId?: string): boolean {
    const colIndex = editableColumnIndex(columnId);
    if (colIndex < 0) return false;
    const column = track.list()[colIndex];
    if (column === undefined) return false;
    const id = model.taskIdAt(row);
    if (id === undefined) return false;
    const task = model.task(id);
    if (task === undefined) return false;
    const cell = deps.cellsOf(row)?.[colIndex];
    if (cell === undefined) return false;

    detach();

    const host = el(doc, "div", "sg-grid-editor-host");
    cell.textContent = "";
    cell.appendChild(host);

    const session: OpenEdit = {
      id,
      cell,
      host,
      finished: false,
      shared: typeof column.editor !== "function",
      done: { commit: () => {}, cancel: () => {} },
    };
    session.done = {
      commit: (value: unknown) => {
        if (session.finished) return;
        session.finished = true;
        applyEdit(id, task, column, value);
        // docs/specs/plugins/tree-grid.md § Internal modules — editor teardown restores focus, so
        // every root-scoped binding (arrows, chords, undo) keeps working afterwards.
        deps.restoreFocus(host);
        detach();
        deps.schedule();
      },
      cancel: () => {
        if (session.finished) return;
        session.finished = true;
        deps.restoreFocus(host);
        detach();
        deps.schedule();
      },
    };
    current = session;

    let initialValue: unknown;
    try {
      initialValue = column.getValue(task);
    } catch (error) {
      deps.fault(error);
      initialValue = undefined;
    }

    if (typeof column.editor === "function") {
      try {
        column.editor(host, initialValue, session.done);
      } catch (error) {
        deps.fault(error);
        // Custom editor construction failed after `cell.textContent` was already cleared above;
        // without `finished = true` + `schedule()` here, the cell stays blank until an unrelated
        // repaint happens, and a half-constructed editor could still call `done.commit` later.
        session.finished = true;
        detach();
        deps.schedule();
      }
      return true;
    }

    // The shared plain-text input: its committed string is handed to `setValue` as-is.
    host.appendChild(input);
    input.value = initialValue === undefined || initialValue === null ? "" : String(initialValue);
    input.focus();
    return true;
  }

  return {
    input,
    sharedDone: () => (current !== null && current.shared ? current.done : null),
    open,
    within: (node) => current !== null && node !== null && current.host.contains(node as Node),
    beginPaintPass(): void {
      retained = false;
    },
    retains(id, cell): boolean {
      if (current === null || current.id !== id || cell !== current.cell) return false;
      retained = true;
      return true;
    },
    endPaintPass(): void {
      if (current === null || retained) return;
      if (current.shared) current.done.commit(input.value);
      else current.done.cancel();
    },
  };
}
