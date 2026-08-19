/**
 * Public types of `@stargantt/plugin-tree-grid`, plus the plugin's single declaration-merging
 * surface.
 *
 * They live in their own module so the internal modules can import them without a cycle through
 * the package entry.
 */
import type { ExtensionPointDecl, Store } from "@stargantt/core";
import type { Task, TaskId } from "@stargantt/plugin-data-store";

/** Where `view/rowInsert` files the new task relative to the reference row. */
export type InsertPosition = "above" | "below" | "child";

/* ------------------------------------------------------------------ *
 * Grid columns
 * ------------------------------------------------------------------ */

/**
 * Hosts a column's inline editor inside the cell being edited.
 *
 * `el` is an empty element placed over the cell; the editor renders its input UI into it,
 * pre-filled from `initialValue` (the column's `getValue` result), and finishes by calling exactly
 * one of `done.commit(value)` — which hands `value` to the column's `setValue` inside the ordinary
 * update transaction — or `done.cancel()`. Listeners inside `el` are the editor's own; the element
 * itself is created and disposed by the grid.
 */
export type ColumnEditor = (
  el: HTMLElement,
  initialValue: unknown,
  done: { commit(value: unknown): void; cancel(): void },
) => void;

/**
 * A column of the tree-grid pane. Cells are painted by `render(el, task)`, which writes into the
 * cell element it is given. The plugin contributes name / start / end / progress columns by
 * default; further columns arrive through the `grid/columns` extension point.
 */
export interface ColumnDef {
  id: string;
  header: string;
  width?: number;
  render(el: HTMLElement, task: Readonly<Task>): void;
  /** Reads the value this column presents for a task — the read accessor editing and editors start from. */
  getValue(task: Readonly<Task>): unknown;
  /**
   * Writes an edited value back to the task. Its presence is what makes the column editable
   * (unless `editable: false` turns that off); a column without it is read-only.
   */
  setValue?(task: Readonly<Task>, value: unknown): void;
  /**
   * Overrides the editability `setValue` implies: `false` keeps a column with `setValue`
   * read-only. `true` without `setValue` has no effect — there is nothing to write with.
   * Omitted = editable exactly when `setValue` is present.
   */
  editable?: boolean;
  /**
   * The input UI used when this column is edited. Omitted = the shared plain-text input, whose
   * committed string is handed to `setValue` as-is.
   */
  editor?: ColumnEditor;
  /**
   * Orders two tasks for this column's sort (negative = `a` first, ascending). Its presence is
   * what makes the column's header click sort; a column without it does not sort.
   */
  compare?(a: Readonly<Task>, b: Readonly<Task>): number;
  /**
   * Display-order weight. The collected column list is stably sorted by ascending weight (ties
   * keep contribution order); this plugin contributes its built-in columns at weight 0, and an
   * omitted weight is 100 — so contributed columns land to the right of the built-ins whatever
   * the plugins' start-up order, and a contributor wanting a specific slot sets one explicitly.
   */
  weight?: number;
}

/* ------------------------------------------------------------------ *
 * Row heights
 * ------------------------------------------------------------------ */

/**
 * A contribution to the row-height reduction. It receives the task and the height resolved so far
 * and may return a replacement; returning `undefined` declines, keeping the incoming height.
 */
export type RowHeightContribution = (
  task: Readonly<Task>,
  defaultHeight: number,
) => number | undefined;

/** The composed row-height resolution: the height one task's row is laid out at. */
export type ResolvedRowHeight = (task: Readonly<Task>, defaultHeight: number) => number;

/* ------------------------------------------------------------------ *
 * Services
 * ------------------------------------------------------------------ */

// docs/specs/plugins/tree-grid.md § Services — the snapshot the `rows` store carries. The
// abolished payload-less change event is replaced by a value subscribers can diff.
/** Snapshot of the visible row set. */
export interface RowsSnapshot {
  /** The visible rows' task ids, in row order (collapsed subtrees omitted, zero-height rows included). */
  readonly taskIds: readonly TaskId[];
  /** Total content height in CSS px — the value the vertical content-extent contribution measures. */
  readonly totalHeight: number;
}

/**
 * The flat list of currently visible rows (collapsed subtrees omitted), the row-index ⇔ task-id
 * cross-lookup, and the vertical geometry of those rows.
 *
 * Row heights are owned here. Offset ↔ index conversions are O(log n) via a Fenwick tree, which is
 * built only when heights actually vary; while every row uses the default height the geometry is
 * plain arithmetic and the tree is skipped entirely.
 */
export interface RowsService {
  rowCount(): number;
  taskIdAt(row: number): TaskId | undefined;
  rowOf(id: TaskId): number | undefined;
  rowHeight(row: number): number;
  /**
   * The row height the `rows/height` reduction resolves for one task, in CSS pixels, whether or
   * not that task currently occupies a visible row — a task inside a collapsed branch has no row
   * index, yet still resolves a height here. Answers `undefined` only for an id the store does not
   * know.
   *
   * A resolved `0` is the "this row is hidden" signal (the shape a filter produces): a task that
   * resolves to 0 is not laid out, not painted and has no geometry anywhere, including where it
   * would otherwise be drawn inside another task's row.
   */
  resolvedHeightOf(id: TaskId): number | undefined;
  /** Row index → content-space y of the row's top edge. */
  yOf(row: number): number;
  /** Content-space y → row index; out-of-range queries clamp to the nearest row. */
  rowAtY(y: number): number;
  totalHeight(): number;
  isExpanded(id: TaskId): boolean;
  /**
   * The visible row set, set once per change — expand/collapse, a sort reorder, a data-driven
   * reflow, `view/rowsInvalidate` and `view/expandToLevel`. An invalidation that changed nothing
   * still notifies once, over an unchanged snapshot.
   */
  readonly rows: Store<RowsSnapshot>;
}

/** The active sort of the grid header. */
export interface GridSortState {
  columnId: string;
  /** The column's visible header label, ready for a live-region announcement. */
  header: string;
  direction: "ascending" | "descending";
}

/**
 * Lets a selection-owning or focus-owning plugin reflect its state into the grid pane, and
 * publishes the grid's own display state — the laid-out column widths and the active sort.
 *
 * `setSelected` replaces the set of task ids whose grid rows are shown as selected; the grid marks
 * (and unmarks) the corresponding rows with the `sg-grid-row--selected` class as they materialize.
 * The set is display state only — it never writes to the store and survives scrolling, expand /
 * collapse and sorting. Passing an empty set clears every mark.
 *
 * `setFocused` names the single task whose grid row is shown as focused, marked with the
 * `sg-grid-row--focused` class, and scrolls that row into the grid pane's own viewport by the
 * minimum amount when it is not fully visible. Passing `undefined` clears the mark and scrolls
 * nothing. Like the selection, it is display state only.
 */
export interface GridService {
  setSelected(ids: ReadonlySet<TaskId>): void;
  setFocused(id: TaskId | undefined): void;
  /**
   * Composed column id → current width in CSS px.
   *
   * Before the first header layout only columns with a declared `ColumnDef.width` have an entry
   * (their declared value); a width-less column has no entry at all until the first header
   * measurement, after which every displayed column has an entry with its laid-out width. During a
   * resize drag the map is replaced at most once per animation frame.
   */
  readonly columnWidths: Store<ReadonlyMap<string, number>>;
  /** The active sort, or `null` when no column is sorted. */
  readonly sort: Store<GridSortState | null>;
}

/* ------------------------------------------------------------------ *
 * Standard field values (stored under `task.meta.taskFields`)
 * ------------------------------------------------------------------ */

/** One of the four built-in task status values. */
export type TaskStatus = "not-started" | "in-progress" | "done" | "on-hold";

/** One of the three built-in task priority values. */
export type TaskPriority = "high" | "medium" | "low";

/**
 * The standard extra attributes of one task.
 *
 * They are stored under `task.meta.taskFields` as plain JSON-compatible data, so they survive
 * `toJSON()` round-trips and travel through the ordinary transaction pipeline. Every member is
 * optional; an absent member means the task has no value for that field.
 */
export interface TaskFieldValues {
  /** The task's workflow state. */
  status?: TaskStatus;
  /** The task's priority. */
  priority?: TaskPriority;
  /** Free-form labels; order is preserved, duplicates are collapsed. */
  tags?: readonly string[];
  /** Deadline as epoch milliseconds (UTC) — independent of the planned end date. */
  deadline?: number;
  /** Long-form description, plain text. */
  notes?: string;
  /** When work actually started, epoch milliseconds (UTC). */
  actualStart?: number;
  /** When work actually finished, epoch milliseconds (UTC). */
  actualEnd?: number;
  /** External/custom display ID; when present it wins over the automatic sequence number. */
  customId?: string;
}

/**
 * A partial update of a task's field values: an absent key is untouched, and a key present with
 * an explicit `undefined` removes that field from the task.
 */
export type TaskFieldsPatch = { [K in keyof TaskFieldValues]?: TaskFieldValues[K] | undefined };

/** A reusable bundle of attribute values applied to a task in one step. */
export interface TaskTemplate {
  /** Field values the template applies. */
  fields?: TaskFieldValues;
  /** Name given to a task created from this template (create path only). */
  name?: string;
  /** Planned duration in milliseconds of a task created from this template (create path only). */
  durationMs?: number;
}

/** Unit in which the duration column expresses time. */
export type DurationUnit = "days" | "hours" | "weeks";

/** Identifiers of the standard field columns this plugin can contribute. */
export type TaskFieldsColumnId =
  | "id"
  | "status"
  | "priority"
  | "tags"
  | "assignees"
  | "deadline"
  | "actualStart"
  | "actualEnd"
  | "duration";

/* ------------------------------------------------------------------ *
 * Conditional formatting
 * ------------------------------------------------------------------ */

/** Comparison operators usable in a leaf condition of a conditional-format rule. */
export type ConditionOperator = "eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "in" | "exists";

/**
 * Leaf condition: compares one task field against a value.
 *
 * `field` is a dotted path. A path starting with `meta` reads from the task's `meta` bag; a path
 * whose first segment is a direct task property (`progress`, `end`, `type`, ...) reads from the
 * task; any other first segment also reads from `meta`, so `"priority"` and `"meta.priority"`
 * name the same value. `lt`/`lte`/`gt`/`gte` compare only when both sides are numbers or both are
 * strings (no coercion); `in` expects `value` to be an array; `exists` ignores `value` and is true
 * when the field is neither `undefined` nor `null`.
 */
export interface FieldCondition {
  field: string;
  op: ConditionOperator;
  value?: unknown;
}

/** True when every inner condition is true (logical AND; an empty list is true). */
export interface AllCondition {
  all: Condition[];
}

/** True when at least one inner condition is true (logical OR; an empty list is false). */
export interface AnyCondition {
  any: Condition[];
}

/** True when the inner condition is false. */
export interface NotCondition {
  not: Condition;
}

/**
 * A condition over one task: a field comparison, or an `all` / `any` / `not` combination of
 * further conditions. Conditions are plain data — no functions — and evaluation never throws:
 * a malformed condition simply never matches.
 */
export type Condition = FieldCondition | AllCondition | AnyCondition | NotCondition;

/** The style a matched conditional-format rule applies to a task's bar. */
export interface ConditionalFormatStyle {
  /**
   * Bar fill color. Any CSS color string, or a reference to one of the chart's CSS custom
   * properties — either bare (`"--sg-critical-bar"`) or wrapped, with an optional fallback
   * (`"var(--sg-critical-bar, #c00)"`). A reference is looked up every time the bar is painted, so a
   * theme switch recolors the bar without the rule being touched.
   *
   * An empty or non-string value applies nothing. A reference whose custom property has no value
   * and no usable fallback also applies nothing — the bar keeps the color it would otherwise
   * have — and is reported once through the chart's plugin-error event.
   */
  color?: string;
}

/** One conditional-format rule: when the condition matches a task, the style applies to its bar. */
export interface ConditionalFormatRule {
  when: Condition;
  style: ConditionalFormatStyle;
  /**
   * Label for this rule's legend entry. A rule without a label produces no legend entry even
   * when the legend is enabled.
   */
  legend?: string;
}

/** Options of the overdue-task warning. */
export interface OverdueOptions {
  /**
   * Bar color applied to overdue tasks — tasks whose end has passed while progress is below 1.
   * Defaults to a warning red (`"#c53030"`). Accepts a theme-token reference in either spelling,
   * exactly like {@link ConditionalFormatStyle.color}.
   */
  color?: string;
  /**
   * Whether the warning triangle icon is drawn on overdue bars, so the warning is conveyed by
   * more than color alone. Defaults to `true`.
   */
  icon?: boolean;
}

/**
 * Colors of the progress-status coloring, one per status. Each accepts a theme-token reference in
 * either spelling, exactly like {@link ConditionalFormatStyle.color}.
 */
export interface ProgressStatusColors {
  /**
   * Progress fill when actual progress trails the schedule. Defaults to
   * `"rgba(197, 48, 48, 0.35)"` — translucent, so a label drawn inside the bar stays readable
   * through the status wash. Configure an opaque color for a solid fill.
   */
  behind?: string;
  /**
   * Progress fill when the task is on track. Defaults to `"var(--sg-bar-fill, #0f766e)"` — the
   * same token task bars are painted from — so an on-track task looks unchanged unless this is
   * overridden, in either colour scheme and under any theme preset.
   */
  onTrack?: string;
  /**
   * Progress fill when progress has reached 1. Defaults to `"rgba(47, 133, 90, 0.35)"` —
   * translucent for the same label-readability reason as `behind`.
   */
  complete?: string;
}

/* ------------------------------------------------------------------ *
 * Message catalog
 * ------------------------------------------------------------------ */

// docs/specs/plugins/tree-grid.md § Messages — one merged catalog of 40 keys: the grid's own
// column headers and pane label, the standard field columns / panel labels, and the conditional
// formatting legend.
/**
 * Every piece of English text this plugin can put on screen, overridable per key.
 *
 * Rule labels, field labels and options supplied by the host, and cell contents (ISO dates,
 * percentages) are data or formatting, not catalog members.
 */
export interface TreeGridMessages {
  /** Header of the built-in `name` column. Default `"Name"`. */
  nameColumn: string;
  /** Header of the built-in `start` column. Default `"Start"`. */
  startColumn: string;
  /** Header of the built-in `end` column. Default `"End"`. */
  endColumn: string;
  /** Header of the built-in `progress` column. Default `"Progress"`. */
  progressColumn: string;
  /** Header of the WBS column `wbs` adds. Default `"WBS"`. Inert while `wbs` is off. */
  wbsColumn: string;
  /** Name given to a task `view/rowInsert` creates when the command names none. Default `"New task"`. */
  newTaskName: string;
  /**
   * Accessible name of the divider that resizes the grid pane. Default `"Resize pane"`; an empty
   * or blank override falls back to it, since a focusable divider must always carry a name.
   */
  paneResizeLabel: string;
  /** Header of the sequence-ID field column. Default `"ID"`. */
  idColumn: string;
  /** Header of the status field column. Default `"Status"`. */
  statusColumn: string;
  /** Header of the priority field column. Default `"Priority"`. */
  priorityColumn: string;
  /** Header of the tags field column. Default `"Tags"`. */
  tagsColumn: string;
  /** Header of the assignees field column. Default `"Assignees"`. */
  assigneesColumn: string;
  /** Header of the deadline field column. Default `"Deadline"`. */
  deadlineColumn: string;
  /** Header of the actual-start field column. Default `"Actual start"`. */
  actualStartColumn: string;
  /** Header of the actual-end field column. Default `"Actual end"`. */
  actualEndColumn: string;
  /** Header of the duration field column. Default `"Duration"`. */
  durationColumn: string;
  /** Label of the `not-started` status. Default `"Not started"`. */
  statusNotStarted: string;
  /** Label of the `in-progress` status. Default `"In progress"`. */
  statusInProgress: string;
  /** Label of the `done` status. Default `"Done"`. */
  statusDone: string;
  /** Label of the `on-hold` status. Default `"On hold"`. */
  statusOnHold: string;
  /** Label of the `high` priority. Default `"High"`. */
  priorityHigh: string;
  /** Label of the `medium` priority. Default `"Medium"`. */
  priorityMedium: string;
  /** Label of the `low` priority. Default `"Low"`. */
  priorityLow: string;
  /** Heading of the side-panel section. Default `"Task fields"`. */
  fieldsSection: string;
  /** Side-panel label of the status field. Default `"Status"`. */
  statusLabel: string;
  /** Side-panel label of the priority field. Default `"Priority"`. */
  priorityLabel: string;
  /** Side-panel label of the tags field. Default `"Tags"`. */
  tagsLabel: string;
  /** Side-panel placeholder of the tags input. Default `"tag1, tag2"`. */
  tagsPlaceholder: string;
  /** Side-panel label of the deadline field. Default `"Deadline"`. */
  deadlineLabel: string;
  /** Side-panel label of the actual-start field. Default `"Actual start"`. */
  actualStartLabel: string;
  /** Side-panel label of the actual-end field. Default `"Actual end"`. */
  actualEndLabel: string;
  /** Side-panel label of the notes field. Default `"Notes"`. */
  notesLabel: string;
  /** Side-panel placeholder of the notes input. Default `"Add a note"`. */
  notesPlaceholder: string;
  /** The "no value" entry of the side-panel selects and of the select-column editor. Default `"—"`. */
  noneOption: string;
  /** Name given to a task created from a template that names none. Default `"New task"`. */
  templateTaskName: string;
  /** Legend label of the overdue warning entry. Default `"Overdue"`. */
  legendOverdue: string;
  /**
   * Builds the legend label of one priority-color entry from the priority value's string form.
   * Default: `` ({ priority }) => `Priority ${priority}` ``.
   */
  legendPriority: (arg: { priority: string }) => string;
  /** Legend label of the behind-schedule progress entry. Default `"Behind schedule"`. */
  legendProgressBehind: string;
  /** Legend label of the on-track progress entry. Default `"On track"`. */
  legendProgressOnTrack: string;
  /** Legend label of the completed progress entry. Default `"Complete"`. */
  legendProgressComplete: string;
}

/* ------------------------------------------------------------------ *
 * Declaration merging
 * ------------------------------------------------------------------ */

declare module "@stargantt/core" {
  interface Services {
    // docs/specs/plugins/tree-grid.md § Services
    "stargantt.rows": RowsService;
    "stargantt.grid": GridService;
  }
  interface ExtensionPoints {
    // docs/specs/plugins/tree-grid.md § Extension points
    "grid/columns": ExtensionPointDecl<ColumnDef, ColumnDef[]>; // collect
    "rows/height": ExtensionPointDecl<RowHeightContribution, ResolvedRowHeight>; // reduce
  }
  interface Commands {
    // docs/specs/plugins/tree-grid.md § Commands
    /** Expands or collapses one branch; with `expanded` omitted the current state is toggled. */
    "view/rowToggle": { id: TaskId; expanded?: boolean };
    /**
     * Rebuilds the visible row set from the store and re-resolves every row height, then publishes
     * the result once. It carries no payload and changes no expand/collapse state: it is the
     * public way for a plugin whose `rows/height` contribution now answers differently — a filter
     * being applied, say — to make the grid pick that answer up. Dispatching it when nothing
     * actually changed is harmless; the rebuild itself is deferred to the next query of the row
     * model.
     */
    "view/rowsInvalidate": void;
    /**
     * Starts inline editing of a cell in the grid pane, exactly as F2 or a double-click on the
     * cell would. `columnId` names which column to edit; omitted, it targets the first editable
     * column in the grid's composed column order. Ignored (no error) when the task is not
     * currently a visible row (unknown id, inside a collapsed branch, or scrolled outside the pane
     * viewport), when `columnId` names no column or a column that is not editable, or when no
     * editable column exists at all.
     */
    "view/editStart": { id: TaskId; columnId?: string };
    /**
     * Makes the task a child of its immediately preceding sibling — one outline level deeper — via
     * an ordinary undoable update. Ignored (no error) when the task is unknown or has no preceding
     * sibling. The task keeps its `orderKey`, so its place among its new siblings follows that key.
     */
    "view/rowIndent": { id: TaskId };
    /**
     * Moves the task up one outline level, making it a sibling of its current parent (a root when
     * the parent is a root) via an ordinary undoable update. Ignored (no error) when the task is
     * unknown or already at the root level. The task keeps its `orderKey`, so its place among its
     * new siblings follows that key.
     */
    "view/rowOutdent": { id: TaskId };
    /**
     * Creates a new task relative to an existing one: directly `"above"` or `"below"` it among its
     * siblings, or appended as its last `"child"`. With `id` omitted the task is appended at the
     * end of the root level; `position` omitted (or unusable) means `"child"`, since an insert
     * asked for from a row means "something under this task". A collapsed parent is expanded so
     * the new row is never created out of sight — expansion is display state, not a second undo
     * step.
     *
     * The new task takes `name` (default: the `newTaskName` catalog message), starts where the
     * reference task starts, and lasts one grid cell of the chart's current zoom level (one day
     * when no time axis is composed). With no reference task it carries no dates. Ignored (no
     * error) when `id` names no task. Undoable as one step.
     */
    "view/rowInsert": { id?: TaskId; position?: InsertPosition; name?: string };
    /**
     * Expands and collapses whole outline levels at once so that exactly the rows of depth ≤
     * `level` are visible: `0` shows only the roots, `1` the roots and their children, and so on.
     * Display state only — nothing is written to the store and it is not undoable. A `level` that
     * is not a finite number ≥ 0 is ignored (no error); a fractional one is floored.
     */
    "view/expandToLevel": { level: number };
    /**
     * Draws — or, with a `null` payload, hides — the grid pane's drop-indicator line: a 2px
     * insertion line across the body at the viewport-local `y`, inset by `depth` indent steps so it
     * shows which outline level a drop would file a task at.
     *
     * Display state only: nothing is written to the store, nothing is undoable and nothing is
     * announced. It is owned and cleared by whichever plugin is dragging. A non-finite `y` or
     * `depth` hides the line rather than erroring.
     */
    "view/dropIndicator": { y: number; depth: number } | null;
  }
  interface Events {
    // docs/specs/plugins/tree-grid.md § Events
    /**
     * A pointerdown landed on a grid row — any cell, or the row's own padding — other than the
     * expand toggle (which dispatches `view/rowToggle` instead and emits no event here). `row` is
     * the visible-row index at press time; the modifier flags and the pressed `button` are copied
     * off the originating pointer event, which is itself never put on the bus. Emitted for every
     * button and for information only — the grid takes no selection action of its own, and a
     * subscriber that cares which button was pressed filters on `button`.
     */
    "grid/rowPointerDown": {
      id: TaskId;
      row: number;
      ctrlKey: boolean;
      metaKey: boolean;
      shiftKey: boolean;
      button: number;
      /** The pointer that pressed; the move and up events of this press carry the same id. */
      pointerId: number;
      /** The press position relative to the grid body's top-left corner. */
      x: number;
      /** As `x`, vertically — the same space the row model's geometry uses once scrolled. */
      y: number;
      clientX: number;
      clientY: number;
    };
    /**
     * A move of the pointer that pressed a grid row, delivered for as long as that press is
     * tracked. `x` / `y` are relative to the grid body's top-left corner, so `y` shares the row
     * model's viewport-local space; the originating pointer event is never put on the bus. The grid
     * takes no action of its own — the event is information, like the press it follows.
     */
    "grid/rowPointerMove": {
      pointerId: number;
      x: number;
      y: number;
      clientX: number;
      clientY: number;
      altKey: boolean;
      ctrlKey: boolean;
      metaKey: boolean;
      shiftKey: boolean;
    };
    /**
     * The end of a tracked grid-row press: exactly one per `grid/rowPointerDown`, in the same
     * coordinate space as the move. `cancelled` is `true` when the press was cancelled rather
     * than released, which a consumer treats as an abandoned gesture.
     */
    "grid/rowPointerUp": {
      pointerId: number;
      x: number;
      y: number;
      clientX: number;
      clientY: number;
      cancelled: boolean;
    };
    /**
     * A context-menu request (right-press, or the keyboard's menu key) landed on a grid row other
     * than the expand toggle. `row` is the visible-row index at request time, and `x` / `y` are
     * the request's position relative to the top-left corner of the grid pane — the coordinates a
     * menu mounted in that pane is positioned with. The originating event is not put on the bus,
     * and the grid neither opens a menu nor suppresses the browser's own: a plugin that answers
     * this event does both.
     */
    "grid/rowContextMenu": {
      id: TaskId;
      row: number;
      x: number;
      y: number;
    };
    /**
     * A context-menu request landed on the grid body's blank area — inside the body element but
     * below the last row, resolving no row. `x` / `y` are the request's position relative to the
     * top-left corner of the grid pane, the same coordinate space `grid/rowContextMenu` uses. The
     * originating event is not put on the bus; the header emits nothing here, and the grid neither
     * opens a menu nor suppresses the browser's own — a plugin that answers this event does both.
     */
    "grid/backgroundContextMenu": {
      x: number;
      y: number;
    };
  }
}
