import type { Patch, Transaction } from "@stargantt/plugin-data-store";
import { isNetZero } from "./internal/net-zero";
import { HISTORY_SNAPSHOT_VERSION, isHistorySnapshot } from "./internal/snapshot-validation";

// docs/specs/plugins/undo-redo.md — Config
/** Number of undo entries kept when no limit is configured. */
export const DEFAULT_LIMIT = 200;

// docs/specs/plugins/data-store.md "Apply flow" — will handlers may append to `Transaction.patches`.
/**
 * One entry of the undo stack: a transaction that the store actually applied.
 *
 * `patches` is a **copy** of the transaction's list. `Transaction.patches` is mutable by design —
 * handlers of the pre-apply event may append to it — so keeping the live array would let a later
 * handler rewrite recorded history.
 */
export interface HistoryEntry {
  readonly id: string;
  readonly label: string;
  readonly patches: readonly Patch[];
  readonly coalesceKey?: string;
}

function entryOf(tx: Transaction): HistoryEntry {
  return tx.coalesceKey === undefined
    ? { id: tx.id, label: tx.label, patches: [...tx.patches] }
    : { id: tx.id, label: tx.label, patches: [...tx.patches], coalesceKey: tx.coalesceKey };
}

/** A shallow copy of an already-validated entry: the entry object and its `patches` array are
 * fresh, so neither side of a `serialize()`/`restore()` round trip can grow or reorder the other's
 * list. The patch objects themselves are still shared — deep aliasing is not defended against. */
function cloneEntry(entry: HistoryEntry): HistoryEntry {
  return entry.coalesceKey === undefined
    ? { id: entry.id, label: entry.label, patches: [...entry.patches] }
    : { id: entry.id, label: entry.label, patches: [...entry.patches], coalesceKey: entry.coalesceKey };
}

// docs/specs/plugins/undo-redo.md "Snapshot serialize/restore"
/**
 * The undo and redo stacks as a plain JSON value, produced by `HistoryService.serialize()` and
 * accepted back by `HistoryService.restore()`.
 *
 * Treat this shape as opaque: a caller should read nothing out of it and write nothing into it
 * beyond carrying it verbatim between the two calls — for example through `JSON.stringify()` /
 * `JSON.parse()` and `localStorage`, when a host has to tear down and recreate the chart and wants
 * its undo history to survive that.
 */
export interface HistorySnapshot {
  /** Format marker of this snapshot. A value `restore()` does not recognise — including one
   * written by an incompatible future version — is rejected in full. */
  readonly version: number;
  /** The undo stack, oldest entry first. */
  readonly undo: readonly HistoryEntry[];
  /** The redo stack, oldest entry first. */
  readonly redo: readonly HistoryEntry[];
}

// docs/specs/plugins/undo-redo.md "Recording" / "Coalescing and net-zero compression"
/**
 * The transaction history itself: an undo stack and a redo stack of applied transactions.
 *
 * Pure bookkeeping — it never touches the store, which is what keeps it unit-testable without a
 * Gantt instance.
 */
export class History {
  private readonly _limit: number;
  private readonly _undo: HistoryEntry[] = [];
  private readonly _redo: HistoryEntry[] = [];
  // Invoked after every stack mutation (push, merge, undo, redo, clear, limit-eviction) so the
  // plugin can publish a fresh `HistoryState` onto `stargantt.history`'s store. `History` stays
  // free of any core dependency — the callback is the only coupling to the host.
  private readonly _onChange: () => void;

  constructor(limit: number = DEFAULT_LIMIT, onChange: () => void = () => {}) {
    // A limit below 1 would make the stack unable to hold the entry it was just given; the minimum
    // meaningful history is one entry.
    this._limit = Math.max(1, Math.floor(limit));
    this._onChange = onChange;
  }

  get limit(): number {
    return this._limit;
  }

  canUndo(): boolean {
    return this._undo.length > 0;
  }

  canRedo(): boolean {
    return this._redo.length > 0;
  }

  /** Read-only views, for tests and for `clear()`'s postcondition. */
  undoEntries(): readonly HistoryEntry[] {
    return this._undo;
  }

  redoEntries(): readonly HistoryEntry[] {
    return this._redo;
  }

  /** The label of the transaction the next `undo()` would revert, or `undefined` when the undo stack is empty. */
  peekUndo(): string | undefined {
    return this._undo[this._undo.length - 1]?.label;
  }

  /** The label of the transaction the next `redo()` would re-apply, or `undefined` when the redo stack is empty. */
  peekRedo(): string | undefined {
    return this._redo[this._redo.length - 1]?.label;
  }

  /** Every undoable label, ordered from the one `undo()` would revert first to the oldest. */
  undoLabels(): readonly string[] {
    const labels: string[] = [];
    for (let i = this._undo.length - 1; i >= 0; i--) {
      const entry = this._undo[i];
      if (entry !== undefined) labels.push(entry.label);
    }
    return labels;
  }

  /** Every redoable label, ordered from the one `redo()` would re-apply first onward. */
  redoLabels(): readonly string[] {
    const labels: string[] = [];
    for (let i = this._redo.length - 1; i >= 0; i--) {
      const entry = this._redo[i];
      if (entry !== undefined) labels.push(entry.label);
    }
    return labels;
  }

  /**
   * Pushes an applied transaction onto the undo stack. When its `coalesceKey` matches the previous
   * entry's, the two are merged into a single undo step. A new user action invalidates the redo
   * stack.
   */
  record(tx: Transaction): void {
    // docs/specs/plugins/undo-redo.md "Recording": "pushed onto the undo stack (`coalesceKey`
    // matching the previous entry merges them)".
    const entry = entryOf(tx);
    this._redo.length = 0;

    const key = entry.coalesceKey;
    const previous = this._undo[this._undo.length - 1];
    if (key !== undefined && previous !== undefined && previous.coalesceKey === key) {
      // Merged entries stay one undo step: the patch lists are concatenated in application order,
      // and the label of the *first* entry is kept because that is the action the user started.
      const patches = [...previous.patches, ...entry.patches];
      // docs/specs/plugins/undo-redo.md "Coalescing and net-zero compression" — a
      // coalesced entry whose merged patches have net-zero effect is dropped: a return-to-origin
      // liveUpdate drag leaves no undo step, because undoing it would visibly change nothing.
      if (isNetZero(patches)) {
        this._undo.pop();
        this._onChange();
        return;
      }
      this._undo[this._undo.length - 1] = {
        id: previous.id,
        label: previous.label,
        patches,
        coalesceKey: key,
      };
      this._onChange();
      return;
    }

    this._undo.push(entry);
    while (this._undo.length > this._limit) this._undo.shift();
    this._onChange();
  }

  /** Moves the newest entry to the redo stack and returns it. */
  popUndo(): HistoryEntry | undefined {
    const entry = this._undo.pop();
    if (entry === undefined) return undefined;
    this._redo.push(entry);
    this._onChange();
    return entry;
  }

  /** Moves the newest redo entry back onto the undo stack and returns it. */
  popRedo(): HistoryEntry | undefined {
    const entry = this._redo.pop();
    if (entry === undefined) return undefined;
    this._undo.push(entry);
    while (this._undo.length > this._limit) this._undo.shift();
    this._onChange();
    return entry;
  }

  // docs/specs/plugins/undo-redo.md "Snapshot serialize/restore"
  /** Both stacks as a plain JSON value; see `HistorySnapshot`'s own documentation. */
  serialize(): HistorySnapshot {
    return {
      version: HISTORY_SNAPSHOT_VERSION,
      undo: this._undo.map(cloneEntry),
      redo: this._redo.map(cloneEntry),
    };
  }

  // docs/specs/plugins/undo-redo.md "Snapshot serialize/restore"
  /**
   * Replaces both stacks with a previously `serialize()`d value. Validates the whole value before
   * touching anything: an unrecognised or malformed `snapshot` leaves the current stacks exactly
   * as they were and returns `false`; a match replaces both stacks in one step, re-applies the
   * configured `limit` to the restored undo stack exactly as `record()` would, fires the change
   * callback once, and returns `true`.
   */
  restore(snapshot: unknown): boolean {
    if (!isHistorySnapshot(snapshot)) return false;

    this._undo.length = 0;
    for (const entry of snapshot.undo) this._undo.push(cloneEntry(entry));
    while (this._undo.length > this._limit) this._undo.shift();

    this._redo.length = 0;
    for (const entry of snapshot.redo) this._redo.push(cloneEntry(entry));

    this._onChange();
    return true;
  }

  clear(): void {
    // Every stack mutation fires the change callback, including one on an already-empty history —
    // "this method changes the stacks" stays a simple rule rather than a conditional one on
    // whether anything was actually removed.
    this._undo.length = 0;
    this._redo.length = 0;
    this._onChange();
  }

  // Resource teardown (plugin disposal), not a history operation: the composition is
  // half-torn-down by the time this runs, so no store notification must escape. Distinct from
  // `clear()`, which is the public, notifying command.
  /** Resets both stacks without invoking the change callback. For use during plugin teardown only. */
  reset(): void {
    this._undo.length = 0;
    this._redo.length = 0;
  }
}
