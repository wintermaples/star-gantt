// docs/specs/plugins/interaction.md §2 / §3
/**
 * Public types of `@stargantt/plugin-interaction`, plus the plugin's single
 * `declare module "@stargantt/core"` block (architecture.md chapter 1.4: one declaration site per
 * plugin).
 *
 * They live here rather than in `index.ts` so the internal modules can import them without a cycle
 * through the package entry.
 */
import type { ExtensionPointDecl, Store } from "@stargantt/core";
import type { CalendarId, LinkType, ResourceId, Task, TaskId } from "@stargantt/plugin-data-store";
import type { HitResult } from "@stargantt/plugin-view";
import type { InteractionMessages } from "./messages";

/* ------------------------------------------------------------------ *
 * Selection (§2.1)
 * ------------------------------------------------------------------ */

// docs/specs/plugins/interaction.md §2.1
/** The whole of the selection's observable state. */
export interface SelectionState {
  /** Snapshot set of the selected task ids. */
  readonly taskIds: ReadonlySet<TaskId>;
  /**
   * The anchor row of Shift-range extension: the task of the most recent non-Shift press or
   * Ctrl/Cmd toggle. Programmatic `select()` / `toggle()` / `clear()` leave it unchanged — only
   * the press paths move the anchor.
   */
  readonly anchor?: TaskId;
}

// docs/specs/plugins/interaction.md §2.1
/**
 * Reads and changes the set of selected tasks.
 *
 * Obtained with `gantt.service("stargantt.selection")` from application code, or
 * `ctx.use("stargantt.selection")` from a plugin that declares this plugin as a dependency.
 */
export interface SelectionService {
  /** The selection itself. Subscribe for every effective change; the value is a snapshot. */
  readonly state: Store<SelectionState>;
  /**
   * Replaces the selection with exactly the given ids. Duplicates are ignored and an empty list is
   * equivalent to `clear()`. With `selection.revealSelected` on, the first id's bar is revealed.
   */
  select(ids: readonly TaskId[]): void;
  /**
   * Toggles one task's membership, leaving the rest untouched — the programmatic twin of
   * Ctrl-click.
   */
  toggle(id: TaskId): void;
  /** Deselects everything. */
  clear(): void;
  /**
   * Scrolls the chart horizontally by the minimum amount that brings the task's bar on screen.
   * A bar already fully visible never moves the chart; a bar too wide to fit shows its start; the
   * vertical position is untouched.
   *
   * Works regardless of `selection.revealSelected`, which governs only the automatic reveals.
   */
  reveal(id: TaskId): void;
  /** The configured selection mode; it never changes over the instance's lifetime. */
  mode(): "single" | "multi" | "none";
  /**
   * Confirmation-gated bulk delete of the current selection: the built-in dialog, or the
   * `confirmDelete` hook when one was configured. One `task/remove` transaction for the whole set,
   * so a single undo restores them all. A no-op while the selection is empty and while a
   * confirmation is already in flight.
   */
  deleteSelected(): void;
}

/* ------------------------------------------------------------------ *
 * Snap (§2.2)
 * ------------------------------------------------------------------ */

// docs/specs/plugins/interaction.md §6.3
/**
 * The calendar units an edited date can be rounded to — the same units the timeline header marks,
 * so rounding to one of them lands a date exactly on a header boundary.
 */
export type SnapUnit = "year" | "month" | "week" | "day" | "hour";

// docs/specs/plugins/interaction.md §2.2
/** What the chart rounds edited dates with. Both members work in epoch milliseconds UTC. */
export interface SnapService {
  /**
   * Rounds an instant to the nearest boundary of the unit in effect. An instant exactly halfway
   * between two boundaries rounds to the later one. Returns the instant unchanged when nothing is
   * being rounded (a zoom level with no header rows) and for a non-finite instant.
   */
  snap(t: number): number;
  /**
   * How far one keyboard step from `t` moves, in milliseconds, signed. Forwards: the length of the
   * unit containing `t`; backwards: minus the length of the unit before it, so stepping forward
   * and back returns to the boundary. Months and years are measured against `t`. Falls back to one
   * UTC day when nothing is being rounded.
   */
  step(t: number, direction: 1 | -1): number;
}

// docs/specs/plugins/interaction.md §6.3
/**
 * A replacement rounding rule. Only `snap` is required: with `step` omitted, keyboard steps keep
 * the built-in calendar stepping of the unit in effect.
 */
export interface SnapRule {
  snap(t: number): number;
  step?(t: number, direction: 1 | -1): number;
}

// docs/specs/plugins/interaction.md §6.3
/**
 * The built-in behaviour handed to a custom rule so it can defer to it or refine it. All three
 * members are evaluated when called, so a rule written against them follows zoom changes exactly
 * as the built-in rule does.
 */
export interface SnapRuleContext {
  /**
   * The unit currently in effect: a calendar unit, a plain millisecond grid size, or `undefined`
   * when nothing is being rounded.
   */
  unit(): SnapUnit | number | undefined;
  /** The built-in rounding for the unit currently in effect. */
  snap(t: number): number;
  /** The built-in signed step for the unit currently in effect. */
  step(t: number, direction: 1 | -1): number;
}

/* ------------------------------------------------------------------ *
 * Extension-point contribution types (§3)
 * ------------------------------------------------------------------ */

// docs/specs/plugins/interaction.md §3 — `snap/workingTime`
/**
 * The working-time probes for one calendar, as the `snap.workingDays` adjustment asks them.
 *
 * Every member has the shared working-time engine's semantics. The two boundary walks are bounded
 * on the provider's side and return their own argument when they give up, so a calendar with no
 * reachable working time terminates instead of looping.
 */
export interface WorkingBoundaries {
  /**
   * Whether `t` is working time: a working day, and inside one of that day's working windows. A
   * working day whose calendar declares no window is working for its whole length.
   */
  isWorkingInstant(t: number): boolean;
  /** The first working instant at or after `t` — `t` itself when it is already acceptable. */
  nextWorkingStart(t: number): number;
  /** The last instant at or before `t` that can close working time. */
  previousWorkingEnd(t: number): number;
}

// docs/specs/plugins/interaction.md §3 — `snap/workingTime` (first)
/**
 * The working-time authority behind `snap.workingDays` — an inverted dependency edge: rather
 * than interaction reaching up into `stargantt.calendars` directly, the scheduling plugin
 * optionally contributes this shape. With no contribution the option is inert and dates pass
 * through unchanged.
 */
export interface WorkingTimeProvider {
  /**
   * The probes for one calendar reference: `calendar` names a specific calendar, omitted means the
   * provider's default calendar. Returns `undefined` when the reference does not resolve (an
   * unknown configured id, no default) — dates then pass through unchanged.
   *
   * Freshness contract: interaction calls this on EVERY working-time adjustment, and the returned
   * object is used for that one adjustment and never cached across adjustments or gestures.
   * Providers may cache internally and own their invalidation.
   */
  boundaries(calendar?: CalendarId): WorkingBoundaries | undefined;
}

// docs/specs/plugins/interaction.md §3 — `snap/pushGuards` (collect)
/**
 * A stand-down predicate for the `snap.pushSuccessors` pass. Guards are OR-combined: the pass
 * stands down while ANY guard returns `true`, which makes the outcome order-independent. A guard
 * that throws is reported and read as `true` — the conservative answer, so the pass never races a
 * reconciler it failed to interrogate.
 */
export type PushGuard = () => boolean;

// docs/specs/plugins/interaction.md §3 — `drag/lanes`
/** One resource lane, as the lane drag's arithmetic needs it. */
export interface LaneBox {
  /** The resource whose lane this is. */
  resourceId: string;
  /** Top of the lane, relative to the gantt root's inner top edge. */
  y: number;
  /** Height of the lane. */
  height: number;
}

// docs/specs/plugins/interaction.md §3 — `drag/lanes` (first)
/**
 * The lane-drag resolution seam — an inverted dependency edge: rather than interaction reaching
 * up into resource directly, the resource plugin optionally contributes this shape. With no
 * contribution `dragEdit.resourceDrag` behaves exactly as off.
 */
export interface LaneDragProvider {
  /**
   * The lane at a root-relative y, or `undefined` when none is there — in particular always
   * `undefined` while no lane layout is showing.
   */
  laneAt(y: number): LaneBox | undefined;
  /**
   * Reassigns the task from one resource to another through the provider's own write path: the
   * provider owns how the change is recorded and undone.
   */
  reassign(taskId: TaskId, fromResourceId: string, toResourceId: string): void;
  /**
   * Marks the lane a drop would land in, or clears the mark with `null`. Optional: a provider
   * without it drives the drag unmarked.
   */
  highlightLane?(resourceId: string | null): void;
  /**
   * The lane the task is currently on, or `undefined` when it is on none / on more than one.
   * Optional: without it, interaction falls back to asking `laneAt` about the bar's own centre.
   */
  laneOfTask?(taskId: TaskId): LaneBox | undefined;
}

/* ------------------------------------------------------------------ *
 * Tooltip (§6.4, §3 — `tooltip/content`, first)
 * ------------------------------------------------------------------ */

/** What a tooltip can display: plain text, or an `HTMLElement` mounted into the tooltip. */
export type TooltipContent = string | HTMLElement;

// docs/specs/plugins/interaction.md §3 — `tooltip/content` (first)
/**
 * Produces the tooltip content for a hit-tested pointer target. Returning `undefined` declines,
 * letting the next registered provider (or the built-in fallback) answer instead.
 */
export type TooltipContentProvider = (hit: Readonly<HitResult>) => TooltipContent | undefined;

/* ------------------------------------------------------------------ *
 * Context menu (§6.5, §3 — `contextmenu/items`, collect)
 * ------------------------------------------------------------------ */

// docs/specs/plugins/interaction.md §3 — `contextmenu/items`
/** What the menu was opened on. */
export type ContextMenuTarget =
  | {
      /** A right-press on a shape the renderer's hit test recognized, or on a grid row. */
      kind: "hit";
      /**
       * The hit's shape kind — `"bar"`, `"handle"`, `"link"`, or a third-party kind, plus `"row"`
       * for a right-press on a row of the grid pane, which carries that row's task id.
       */
      hitKind: string;
      /** The hit shape's subject id (a task id for bars, handles and grid rows, a link id for links). */
      id: string | number;
      /**
       * X coordinate of the press within the pane the menu is placed in: the chart viewport for a
       * press on the canvas, the grid pane for a `"row"` press.
       */
      x: number;
      /** Y coordinate of the press, in the same space as `x`. */
      y: number;
    }
  | {
      /** A right-press on empty chart space. */
      kind: "background";
      x: number;
      y: number;
    }
  | {
      /** A context-menu request on the tree grid's blank body area below the last row. */
      kind: "gridBackground";
      x: number;
      y: number;
    };

/** One entry of an open context menu. */
export interface ContextMenuItem {
  /** Stable identifier, used for DOM bookkeeping and diagnostics; not rendered. */
  id: string;
  label: string;
  /** A disabled entry is rendered and announced, but never activates. */
  disabled?: boolean;
  /** Draws a separator line above this entry. */
  separatorBefore?: boolean;
  /** Invoked when the entry is activated (click, Enter, Space). The menu closes first. */
  run(target: Readonly<ContextMenuTarget>): void;
}

/**
 * Produces menu entries for a right-press target. Returning `undefined` or an empty array
 * contributes nothing for that target.
 */
export type ContextMenuItemProvider = (
  target: Readonly<ContextMenuTarget>,
) => readonly ContextMenuItem[] | undefined;

/* ------------------------------------------------------------------ *
 * Clipboard (§4, §6.7)
 * ------------------------------------------------------------------ */

// docs/specs/plugins/interaction.md §4 — `clipboard/paste`'s optional payload: an
// explicit transfer to paste instead of the held one.
/** Where a `clipboard/paste` dispatch places what it creates; every field optional. */
export interface ClipboardPasteOptions {
  /**
   * Foreign tab-separated text to paste instead of the internal clipboard — the path a spreadsheet
   * paste takes. Text byte-equal (modulo line-ending / trailing-whitespace normalization) to what
   * the last copy produced is recognized as this chart's own clipboard and pasted structurally
   * instead.
   */
  text?: string;
  /** Parent to paste under; `null` = the root level. Omitted: derived from the anchor row. */
  parentId?: TaskId | null;
  /** Sibling position under `parentId`. Omitted: directly after the anchor, else appended. */
  index?: number;
}

/* ------------------------------------------------------------------ *
 * Edit dialog (§6.9)
 * ------------------------------------------------------------------ */

/** The four fields the dialog edits. */
export type EditDialogField = "name" | "start" | "end" | "progress";

/**
 * The dialog's working values, as raw text: dates are "YYYY-MM-DD" (UTC, the native date-input
 * form), progress is the decimal 0..1 fraction spelled out.
 */
export type EditDialogDraft = Record<EditDialogField, string>;

// docs/specs/plugins/interaction.md §6.9
/** What a custom dialog body (`editDialog.renderBody`) is handed on every render. */
export interface EditDialogRenderContext {
  /** The task being edited, re-read from the store at open. */
  readonly task: Readonly<Task>;
  /** The current draft values, including edits not yet committed. */
  readonly draft: Readonly<EditDialogDraft>;
  /** Per-field rejection cause text from the last rejected Save; every member is undefined while
   *  nothing has been rejected. */
  readonly invalid: Readonly<Record<EditDialogField, string | undefined>>;
  /** Writes one draft field. Re-validates nothing; validation runs on commit. */
  setField(field: EditDialogField, value: string): void;
  /** Validates and commits, closing on success. Same single-dispatch path as Save. */
  commit(): void;
  /** Closes without dispatching. */
  cancel(): void;
}

/* ------------------------------------------------------------------ *
 * Side panel (§6.10, §3 — `sidepanel/fields`, collect)
 * ------------------------------------------------------------------ */

/** The four built-in editable fields, by key. */
export type SidePanelFieldKey = "name" | "start" | "end" | "progress";

// docs/specs/plugins/interaction.md §3 — `sidepanel/fields` (collect)
/** A section a `sidepanel/fields` contribution keeps up to date inside the detail pane. */
export interface SidePanelFieldHandle {
  /**
   * Called on every panel refresh with the tasks currently selected, in selection order, and with
   * an empty array when nothing is selected. Update the section's DOM from it; do not dispatch
   * commands from here.
   */
  update(selectedTasks: readonly Readonly<Task>[]): void;
}

/**
 * A custom section added below the detail pane's built-in fields.
 *
 * The section is never hidden by the panel: it stays in the DOM for every selection state, so a
 * section that should disappear when nothing is selected hides itself.
 */
export interface SidePanelFieldContribution {
  /** Stable identifier, reflected on the section element as its `data-field-id` attribute. */
  id: string;
  /**
   * Called once with an empty section element owned by the side panel, when the pane mounts.
   * Append the section's DOM here and return a handle to receive selection updates, or return
   * nothing for a static section. Do not detach or restyle the element itself.
   *
   * Anything created outside the element — a document-level listener, a timer, an observer, a
   * subscription — stays the contributing plugin's own resource and belongs in its own `ctx.own()`.
   */
  mount(host: HTMLElement): SidePanelFieldHandle | void;
}

// docs/specs/plugins/interaction.md §6.10
/** What a custom pane body (`sidePanel.renderBody`) is handed on every render. */
export interface SidePanelRenderContext {
  /** Selected tasks in selection order; empty when nothing is selected. */
  readonly selected: readonly Readonly<Task>[];
  /** The single selected task, or `undefined` for the empty/multi states. */
  readonly task: Readonly<Task> | undefined;
  /** Incoming/outgoing links of `task`, resolved with counterpart names. */
  readonly links: readonly {
    readonly direction: "in" | "out";
    readonly name: string;
    readonly type: LinkType;
  }[];
  /** Resource assignments of `task`, resolved with resource names. */
  readonly assignments: readonly { readonly name: string; readonly units: number }[];
  /** The resolved (whole-plugin) message catalog, so a custom body reuses the host's own labels. */
  readonly messages: InteractionMessages;
  /**
   * Cause text of the last rejected edit per field, keyed by field, with no entry for a field that
   * has not been rejected since it was last shown.
   */
  readonly invalid: Readonly<Partial<Record<SidePanelFieldKey, string>>>;
  /**
   * Runs exactly the built-in edit path for one field: validation, dispatch, rejection marking and
   * announcement. Call it from the custom body's own DOM listeners, never synchronously from
   * inside `renderBody` itself — the seam runs inside the render pass, and dispatching there would
   * mutate the store mid-render.
   */
  commit(field: SidePanelFieldKey, value: string): void;
}

/* ------------------------------------------------------------------ *
 * Filter (§2.3, §6.8)
 * ------------------------------------------------------------------ */

/**
 * Declarative row-filter conditions. Every member is optional; the members present are combined
 * with AND — a task matches when it satisfies all of them.
 */
export interface FilterCriteria {
  /**
   * Free-text terms matched against the task's indexed text (its name, the names of its assigned
   * resources, and its `meta.tags` strings), case-insensitive, every whitespace-separated term as
   * a substring.
   */
  text?: string;
  /** The task matches when it is assigned to at least one of these resources. */
  resources?: readonly ResourceId[];
  /**
   * The task matches when its type is one of these. A task without an explicit type counts as
   * `"task"`.
   */
  types?: readonly string[];
  /** Minimum progress, inclusive. Tasks without a finite progress count as 0. */
  progressMin?: number;
  /** Maximum progress, inclusive. Tasks without a finite progress count as 0. */
  progressMax?: number;
  /** The task matches when its start is at or after this epoch-ms instant. */
  startFrom?: number;
  /** The task matches when its start is before this epoch-ms instant. */
  startTo?: number;
  /** The task matches when its end is after this epoch-ms instant. */
  endFrom?: number;
  /** The task matches when its end is at or before this epoch-ms instant. */
  endTo?: number;
  /**
   * Per-field value selections, keyed by a filter field's id (the built-in `resource` / `type`
   * fields, or the fields configured through `FilterSearchConfig.fields`). The task matches a key
   * when one of the field's values for that task is in the listed set; an empty list for a key
   * means "no restriction from this key". This is the member the filter panel UI writes.
   */
  fields?: Readonly<Record<string, readonly string[]>>;
  /** An arbitrary extra condition, ANDed with the rest. */
  predicate?: (task: Readonly<Task>) => boolean;
}

/** A saved filter state: the incremental-search query plus the declarative criteria. */
export interface FilterView {
  /** The incremental-search query text. Omitted = empty. */
  query?: string;
  /** The declarative criteria. Omitted or `null` = none. */
  criteria?: FilterCriteria | null;
}

/** One filterable field the filter panel offers as a checkbox value list. */
export interface FilterFieldDef {
  /** Stable identifier — the key `FilterCriteria.fields` selections are stored under. */
  id: string;
  /** The heading shown above this field's value list in the filter panel. */
  label: string;
  /**
   * Reads the field's value(s) for one task: a string, several strings, or `undefined` when the
   * task has no value for this field (such a task never matches a non-empty selection).
   */
  value(task: Readonly<Task>): string | readonly string[] | undefined;
}

// docs/specs/plugins/interaction.md §2.3
/** The whole of the filter feature's observable state. */
export interface FilterState {
  /** The incremental search text ("" when none). */
  readonly query: string;
  /** The structured criteria, or null when none. */
  readonly criteria: Readonly<FilterCriteria> | null;
  /** Whether any filtering is in effect. */
  readonly active: boolean;
  /** Number of matching tasks. */
  readonly matchCount: number;
}

// docs/specs/plugins/interaction.md §2.3
/**
 * Row filtering and task search, published as `stargantt.filter`.
 */
export interface FilterService {
  readonly state: Store<FilterState>;
  /** Sets the incremental-search query. Whitespace-only text counts as empty. */
  setQuery(text: string): void;
  /** Replaces the declarative criteria; `null` removes them. */
  setCriteria(criteria: FilterCriteria | null): void;
  /** Clears the query and the criteria in one step. */
  clear(): void;
  /** Whether the task passes the current filter (`true` while inactive). */
  isTaskVisible(id: TaskId): boolean;
  /** Saves the current query + criteria under the name, replacing a same-named view. */
  saveView(name: string): void;
  /** Applies the named view; returns whether it existed. */
  applyView(name: string): boolean;
  /** Deletes the named view; returns whether it existed. */
  deleteView(name: string): boolean;
  /** The saved view names, in insertion order. */
  viewNames(): string[];
}

/* ------------------------------------------------------------------ *
 * Declaration merging
 * ------------------------------------------------------------------ */

declare module "@stargantt/core" {
  interface Services {
    // docs/specs/plugins/interaction.md §2.1
    "stargantt.selection": SelectionService;
    // docs/specs/plugins/interaction.md §2.2
    "stargantt.snap": SnapService;
    // docs/specs/plugins/interaction.md §2.3
    "stargantt.filter": FilterService;
  }

  interface ExtensionPoints {
    /**
     * The working-time authority for `snap.workingDays` (first: the first usable contribution
     * wins). A contribution without a `boundaries` member is treated as absent.
     */
    "snap/workingTime": ExtensionPointDecl<WorkingTimeProvider, WorkingTimeProvider | undefined>;
    /**
     * Stand-down predicates for the successor push-out pass (collect, OR-combined). No
     * contributions means the pass runs.
     */
    "snap/pushGuards": ExtensionPointDecl<PushGuard, PushGuard[]>;
    /**
     * The resource-lane drag seam (first: the first usable contribution wins). A contribution
     * missing `laneAt` or `reassign` is treated as absent.
     */
    "drag/lanes": ExtensionPointDecl<LaneDragProvider, LaneDragProvider | undefined>;
    // docs/specs/plugins/interaction.md §3 — `tooltip/content` (first)
    /** First non-`undefined` answer wins; the config `tooltip.content` fallback is consulted only
     *  when the composed point declines. */
    "tooltip/content": ExtensionPointDecl<TooltipContentProvider, TooltipContentProvider>;
    // docs/specs/plugins/interaction.md §3 — `contextmenu/items` (collect)
    /** Contributed entries appear after the built-in (or config-replaced) entries. */
    "contextmenu/items": ExtensionPointDecl<ContextMenuItemProvider, ContextMenuItemProvider[]>;
    // docs/specs/plugins/interaction.md §3 — `sidepanel/fields` (collect)
    /**
     * Custom sections appended below the side panel's built-in content, in collect (registration)
     * order. Purely additive: built-in fields are neither removable nor reorderable through it.
     * Read exactly once, when the pane mounts; a contribution registered later is never mounted.
     */
    "sidepanel/fields": ExtensionPointDecl<SidePanelFieldContribution, SidePanelFieldContribution[]>;
  }

  interface Commands {
    // docs/specs/plugins/interaction.md §4
    /** Captures the selected tasks into the internal clipboard, mirroring to the system clipboard
     *  where allowed; announces `copied(count)`. */
    "clipboard/copy": void;
    // docs/specs/plugins/interaction.md §4
    /** Creates tasks from the held (or given) transfer, one transaction; announces `pasted(count)`. */
    "clipboard/paste": ClipboardPasteOptions | undefined;
    // docs/specs/plugins/interaction.md §4
    /** Copy + paste of the selection in one step, one transaction; announces `duplicated(count)`. */
    "clipboard/duplicate": void;
    // docs/specs/plugins/interaction.md §4
    /**
     * Opens the task-edit dialog for one task, replacing an already open one. A task the store
     * does not know is a silent no-op.
     */
    "edit-dialog/open": { id: TaskId };
  }
}
