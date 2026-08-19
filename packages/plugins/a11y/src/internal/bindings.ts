// docs/specs/plugins/a11y.md § Default bindings.
/**
 * The plugin's own default `keys/bindings` contributions: row navigation, expand / collapse with
 * their announcements, the APG treegrid aliases, `Enter` to edit, and the multi-selection chords.
 *
 * They are contributed through the extension point like anybody else's bindings, so a later
 * contribution can replace any of them. The list is built from callbacks only, which makes every
 * binding's behavior reachable from a unit test without booting a chart.
 */
import type { TaskId } from "@stargantt/plugin-data-store";
import type { A11yMessages, KeyBinding } from "../types";

export interface DefaultBindingsDeps {
  /** The slice of the row model the bindings read. */
  rows: {
    rowCount(): number;
    rowOf(id: TaskId): number | undefined;
    isExpanded(id: TaskId): boolean;
  };
  messages: A11yMessages;
  /** The task's name, or `undefined` when the store does not know it. */
  taskName(id: TaskId): string | undefined;
  /** The task's parent, or `null` at the root level (and for a task the store does not know). */
  parentOf(id: TaskId): TaskId | null;
  /** Whether the task has children, i.e. whether expanding or collapsing it changes anything. */
  hasChildren(id: TaskId): boolean;
  /** The task the roving focus sits on, or `undefined` while nothing is focused. */
  focusedTask(): TaskId | undefined;
  /** Moves the roving focus by `delta` rows (a plain keyboard move). */
  moveFocus(delta: number): void;
  /** Places the roving focus on a task (a plain keyboard move to a known row). */
  focusTask(id: TaskId): void;
  /** Speaks through the polite live region. */
  announce(message: string): void;
  /** Dispatches the tree-grid's public `view/rowToggle` command. */
  toggleRow(id: TaskId, expanded: boolean): void;
  /** Arms the keyboard edit-commit announcement and dispatches `view/editStart`. */
  startEdit(id: TaskId): void;
  /** Whether the composed selection reports multi-selection mode; unresolved service → `false`. */
  multiSelection(): boolean;
  /** `Shift`+arrow: focus move plus range selection. */
  shiftMove(delta: number): void;
  /** `Ctrl`+`Space`: toggle the focused row's membership in the selection. */
  toggleFocusedSelection(): void;
}

export function defaultBindings(deps: DefaultBindingsDeps): KeyBinding[] {
  const { rows } = deps;

  // Expanding or collapsing a summary row adds or removes rows, which a sighted user sees at once
  // and a screen-reader user would otherwise have to discover by re-reading the grid. The result is
  // therefore spoken through the polite region. Only a row that really changed state is announced,
  // so pressing `-` on a leaf stays silent.
  const toggle = (expanded: boolean): void => {
    const id = deps.focusedTask();
    if (id === undefined) return;
    const before = rows.isExpanded(id);
    deps.toggleRow(id, expanded);
    if (!deps.hasChildren(id) || rows.isExpanded(id) === before) return;
    // The wording is a catalog member; the name of a task the store does not know is handed over as
    // `undefined` rather than as a substitute string, so the host decides what a nameless toggle
    // sounds like.
    const build = expanded ? deps.messages.rowExpanded : deps.messages.rowCollapsed;
    deps.announce(build(deps.taskName(id)));
  };

  // The APG treegrid keys, each an alias of behavior that already exists: ArrowRight expands (or
  // enters the first child of an expanded row), ArrowLeft collapses (or moves to the parent),
  // Home/End jump to the ends of the list.
  const arrowRight = (): void => {
    const id = deps.focusedTask();
    if (id === undefined) return;
    if (!deps.hasChildren(id)) return;
    if (!rows.isExpanded(id)) toggle(true);
    else deps.moveFocus(1); // the first child is the next visible row of an expanded parent
  };
  const arrowLeft = (): void => {
    const id = deps.focusedTask();
    if (id === undefined) return;
    if (deps.hasChildren(id) && rows.isExpanded(id)) {
      toggle(false);
      return;
    }
    const parent = deps.parentOf(id);
    if (parent !== null && rows.rowOf(parent) !== undefined) deps.focusTask(parent);
  };

  // Arrows move the row focus, `+` / `-` expand and collapse, Enter edits. The `description`
  // strings surface in the opt-in shortcut-help dialog; the APG aliases carry none, keeping the
  // list short (≤ 9 rows).
  return [
    { key: "ArrowDown", description: "Move focus down", run: () => deps.moveFocus(1) },
    { key: "ArrowUp", description: "Move focus up", run: () => deps.moveFocus(-1) },
    { key: "+", description: "Expand the focused row", run: () => toggle(true) },
    { key: "-", description: "Collapse the focused row", run: () => toggle(false) },
    { key: "Home", description: "Focus the first row", run: () => deps.moveFocus(-rows.rowCount()) },
    { key: "End", description: "Focus the last row", run: () => deps.moveFocus(rows.rowCount()) },
    { key: "ArrowRight", run: arrowRight },
    { key: "ArrowLeft", run: arrowLeft },
    {
      // "Enter edits": starts inline editing of the focused row through the public
      // `view/editStart` command the tree-grid plugin registers. With no focused row, or when the
      // grid pane cannot edit that row, the dispatch is a no-op on the tree-grid side.
      key: "Enter",
      description: "Edit the focused row",
      run: () => {
        const id = deps.focusedTask();
        if (id === undefined) return;
        deps.startEdit(id);
      },
    },
    // Active only while the composed `stargantt.selection` reports multi-selection mode; inert (and
    // the keystroke falls through) in `"single"`, `"none"`, and with no service composed at all.
    { key: "Shift+ArrowDown", when: deps.multiSelection, run: () => deps.shiftMove(1) },
    { key: "Shift+ArrowUp", when: deps.multiSelection, run: () => deps.shiftMove(-1) },
    { key: "Ctrl+Space", when: deps.multiSelection, run: () => deps.toggleFocusedSelection() },
  ];
}
