// docs/specs/plugins/interaction.md §6.1 — the selection shortcuts, all default-off. Pure decision
// logic, hostless and unit-testable without a plugin host.

/** The resolved (validated) shortcut switches — every one `false` unless explicitly enabled. */
export interface ShortcutFlags {
  /** Ctrl/Cmd+A selects every task (`"multi"` mode only). */
  selectAll: boolean;
  /** Escape clears a non-empty selection when no rubber-band drag is in flight. */
  clearOnEscape: boolean;
  /** Delete opens the bulk-delete confirmation for a non-empty selection. */
  deleteSelected: boolean;
}

/** The subset of a keydown event the decision reads — a flat shape, never a live DOM event. */
export interface KeyPress {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  /** Whether the event target is an editable element (input, textarea, contenteditable). */
  editableTarget: boolean;
}

/** The plugin state the decision reads at the moment of the key press. */
export interface ShortcutState {
  mode: "single" | "multi" | "none";
  /** Whether a rubber-band drag is in flight (Escape then belongs to the drag-cancel path). */
  rubberBandActive: boolean;
  /** Whether the current selection is non-empty. */
  hasSelection: boolean;
  /** Whether the keyboard focus currently sits inside the chart root. */
  focusInRoot: boolean;
  /** Whether the bulk-delete confirmation (dialog or host hook) is already in flight. */
  confirmInFlight: boolean;
}

export type ShortcutAction = "select-all" | "clear" | "delete";

/**
 * Decides what a document-level key press means for the selection, or `undefined` when the key is
 * left for other consumers.
 *
 * - Editable targets never trigger shortcuts (typing must win).
 * - While a confirmation is in flight, all shortcuts are inert (the dialog owns the keyboard).
 * - `"none"` mode keeps every shortcut inert — shortcuts are user input, and `"none"` turns user
 *   input off (the service remains the only mutation path).
 * - Ctrl/Cmd+A and Delete act only while the focus is inside the chart root, so an opted-in chart
 *   never hijacks the hosting page's select-all or deletes tasks while the user works elsewhere.
 * - Escape-clear is not focus-scoped (matching the globally listening rubber-band cancel) but
 *   yields to an active rubber-band drag and only fires on a non-empty selection.
 */
export function shortcutFor(
  press: KeyPress,
  flags: ShortcutFlags,
  state: ShortcutState,
): ShortcutAction | undefined {
  if (press.editableTarget) return undefined;
  if (state.confirmInFlight) return undefined;
  if (state.mode === "none") return undefined;

  if (press.key === "Escape") {
    if (state.rubberBandActive) return undefined; // the drag-cancel path owns it
    if (flags.clearOnEscape && state.hasSelection) return "clear";
    return undefined;
  }

  if ((press.key === "a" || press.key === "A") && (press.ctrlKey || press.metaKey)) {
    if (flags.selectAll && state.mode === "multi" && state.focusInRoot) return "select-all";
    return undefined;
  }

  if (press.key === "Delete") {
    if (flags.deleteSelected && state.hasSelection && state.focusInRoot) return "delete";
    return undefined;
  }

  return undefined;
}
