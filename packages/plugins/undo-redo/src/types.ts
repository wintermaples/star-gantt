// docs/specs/plugins/undo-redo.md
/**
 * `@stargantt/plugin-undo-redo` — public types.
 */
import type { Store } from "@stargantt/core";
import type { HistorySnapshot } from "./history";

export type { HistoryEntry, HistorySnapshot } from "./history";

// docs/specs/plugins/undo-redo.md "Service"
/**
 * The state this plugin publishes on `HistoryService.state`: every stack mutation (record, merge,
 * undo, redo, clear, limit eviction, restore) sets this store exactly once.
 */
export interface HistoryState {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** Depth of the undo stack (0 when nothing is undoable). */
  readonly depth: number;
}

/**
 * The service this plugin publishes as `stargantt.history`.
 *
 * Undo and redo work by inverting and re-applying the recorded transaction history: every patch is
 * reversible, so no state snapshots are kept.
 */
export interface HistoryService {
  readonly state: Store<HistoryState>;

  /**
   * Pops the newest undo entry, dispatches its patches inverted in reverse order as ONE
   * `history/apply` transaction with origin `"history"`, moves the entry to the redo stack, and
   * announces `undone`. No-op when empty.
   */
  undo(): void;
  /**
   * Pops the newest redo entry, re-dispatches its patches verbatim as ONE `history/apply`
   * transaction with origin `"history"`, moves it back to the undo stack, and announces `redone`.
   * No-op when empty.
   */
  redo(): void;
  /** Empties both stacks. */
  clear(): void;

  /** The label of the transaction the next `undo()` call would revert, or `undefined` when there
   * is nothing to undo. */
  peekUndo(): string | undefined;
  /** The label of the transaction the next `redo()` call would re-apply, or `undefined` when there
   * is nothing to redo. */
  peekRedo(): string | undefined;
  /** Every undoable label, next-to-revert first. */
  undoLabels(): readonly string[];
  /** Every redoable label, next-to-re-apply first. */
  redoLabels(): readonly string[];

  /** Both stacks as a plain JSON-serializable value (see `HistorySnapshot`'s own documentation).
   *
   * The history kept here is ordinary in-memory plugin state: it does not survive disposing this
   * chart instance and composing a new one. Call this before disposing, keep the returned value
   * (`JSON.stringify()` it into `localStorage`, say), and hand it to `restore()` once the new
   * instance's history service is ready. */
  serialize(): HistorySnapshot;
  /**
   * Replaces both stacks with a `serialize()`d value. All-or-nothing: an unrecognised or malformed
   * snapshot changes nothing and returns `false`; a match replaces both stacks in one step
   * (re-applying the configured limit to the restored undo stack), sets the store once, returns
   * `true`.
   */
  restore(snapshot: unknown): boolean;
}

// docs/specs/plugins/undo-redo.md "Messages"
/**
 * What the plugin speaks through `stargantt.focus`'s aria-live region (when that service is
 * composed) after a step that actually replayed something.
 */
export interface UndoRedoMessages {
  /** Announced after a completed undo. Defaults to `"Undone"`. */
  undone: string;
  /** Announced after a completed redo. Defaults to `"Redone"`. */
  redone: string;
}

// docs/specs/plugins/undo-redo.md "Config"
export interface UndoRedoConfig {
  /**
   * Replacement announcements, one key at a time.
   *
   * A key left out keeps its English default, and a key whose value is not a string is ignored.
   * Setting a key to the empty string suppresses that announcement entirely: the live region is
   * left untouched for that step rather than being blanked.
   */
  messages?: Partial<UndoRedoMessages>;

  /**
   * How many transactions the history keeps before the oldest one is dropped.
   *
   * Defaults to 200. A value that is not a positive finite integer is ignored.
   */
  limit?: number;

  /**
   * The keyboard chords that trigger undo and redo.
   *
   * Each chord is written as `Modifier+…+Key` (`"Ctrl+Z"`, `"Meta+Shift+Z"`, recognized modifiers
   * `Ctrl` / `Alt` / `Shift` / `Meta`), matched case- and order-insensitively. Undo defaults to
   * `["Ctrl+Z", "Meta+Z"]` and redo to `["Ctrl+Shift+Z", "Meta+Shift+Z", "Ctrl+Y"]`, which covers
   * the Windows/Linux and macOS conventions out of the box. An array given here **replaces** its
   * default entirely rather than adding to it, and an empty array leaves that operation with no
   * keyboard chord at all — the commands stay available either way.
   */
  keys?: {
    undo?: string[];
    redo?: string[];
  };
}
