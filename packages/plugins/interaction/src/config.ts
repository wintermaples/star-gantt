// docs/specs/plugins/interaction.md §6
/**
 * The plugin's configuration surface and its one resolution pass.
 *
 * Presence semantics (§6): the four preset-bundled groups — `selection`, `dragEdit`, `snap`,
 * `tooltip` — are ENABLED with their defaults when the nest is omitted; the six opt-in groups —
 * `contextMenu`, `zoomControls`, `clipboard`, `filterSearch`, `editDialog`, `sidePanel` — are
 * DISABLED when omitted, and passing the nest (even `{}`) enables the feature. An unusable field
 * value silently falls back to its default.
 */
import type { CalendarId, TaskId } from "@stargantt/plugin-data-store";
import type { InteractionMessages } from "./messages";
import type {
  ContextMenuItemProvider,
  EditDialogRenderContext,
  FilterFieldDef,
  FilterView,
  SidePanelRenderContext,
  SnapRule,
  SnapRuleContext,
  SnapUnit,
  TooltipContentProvider,
} from "./types";

/* ------------------------------------------------------------------ *
 * §6.1 selection
 * ------------------------------------------------------------------ */

/** Opt-in selection shortcuts, each off unless set to `true`. */
export interface SelectionShortcutsConfig {
  /** Ctrl/Cmd+A selects every task (`"multi"` mode, focus inside the chart). Default `false`. */
  selectAll?: boolean;
  /** Escape clears a non-empty selection. Default `false`. */
  clearOnEscape?: boolean;
  /** Delete opens the bulk-delete confirmation (focus inside the chart). Default `false`. */
  deleteSelected?: boolean;
}

/** The request a `confirmDelete` hook is asked to answer. */
export interface DeleteConfirmRequest {
  ids: ReadonlySet<TaskId>;
  count: number;
}

// docs/specs/plugins/interaction.md §6.1
/** Selection options. Enabled with these defaults when the nest is omitted. */
export interface SelectionConfig {
  /**
   * How the pointer selects. `"single"` replaces on every press; `"multi"` adds Ctrl/Cmd toggle,
   * Shift range, rubber band and the deferred collapse; `"none"` turns pointer selection off while
   * the service stays live. Default `"single"`.
   */
  mode?: "single" | "multi" | "none";
  /** Opt-in keyboard shortcuts, all `false` by default. */
  shortcuts?: SelectionShortcutsConfig;
  /**
   * Replaces the built-in bulk-delete confirmation. Return `true` (or a promise resolving to
   * `true`) to delete. A pending promise blocks further requests; a throw or rejection cancels the
   * deletion and is reported as a plugin error.
   */
  confirmDelete?: (request: DeleteConfirmRequest) => boolean | Promise<boolean>;
  /**
   * Whether selecting scrolls the bar into view — the grid-row press and the service `select()`
   * paths only. Default `true`. It never governs `SelectionService.reveal()`, which is an explicit
   * request.
   */
  revealSelected?: boolean;
}

/* ------------------------------------------------------------------ *
 * §6.2 dragEdit
 * ------------------------------------------------------------------ */

// docs/specs/plugins/interaction.md §6.2
/** Drag-editing options. Enabled with these defaults when the nest is omitted. */
export interface DragEditConfig {
  /** Whether the plugin edits at all. `false` is the read-only-composition switch. Default `true`. */
  enabled?: boolean;
  /** Dispatch the snapped proposal on every move (one undo step). Default `false`. */
  liveUpdate?: boolean;
  /** A tooltip follows a date drag with the dates a release would commit. Default `false`. */
  dragTooltip?: boolean;
  /**
   * Shortest duration a resize may leave, in milliseconds; never wider than the task's own current
   * duration. Non-positive / non-finite is ignored. Default none (0).
   */
  minDuration?: number;
  /** Vertical-dominant body drags become row drags (reorder + re-parent). Default `false`. */
  rowDrag?: boolean;
  /** Two-click move: a body click picks up, a background click places. Default `false`. */
  clickMove?: boolean;
  /** A move drag inside the multi-selection carries the peers along. Default `false`. */
  multiDrag?: boolean;
  /** A drag near the pane edge scrolls the view. Default `false`. */
  autoScroll?: boolean;
  /** Direct successors are outlined, displaced by the drag delta. Default `false`. */
  dependencyPreview?: boolean;
  /**
   * Vertical-dominant body drags become lane drags when a `drag/lanes` provider is composed.
   * Without a provider this behaves exactly as off. Default `false`.
   */
  resourceDrag?: boolean;
  /** Moves are coalesced to one per animation frame. Default `false`. */
  frameSync?: boolean;
}

/* ------------------------------------------------------------------ *
 * §6.3 snap
 * ------------------------------------------------------------------ */

/** Options of the working-time avoidance. */
export interface SnapWorkingDaysConfig {
  /**
   * The calendar whose working time is honored. Omitted, the provider's default calendar is used;
   * an id the provider cannot resolve means no adjustment at all.
   */
  calendar?: CalendarId;
}

/** Options of the task-edge alignment. */
export interface SnapAlignConfig {
  /**
   * How close, in CSS pixels at the current zoom, an edited date must come to another task's edge
   * before it sticks to it. Default 8; an unusable number falls back to it.
   */
  tolerancePx?: number;
}

// docs/specs/plugins/interaction.md §6.3
/** Snapping options. Enabled with these defaults when the nest is omitted. */
export interface SnapConfig {
  /**
   * Whether dates are rounded at all. Default `true`.
   *
   * `false` reproduces a composition without any rounding rule: drags commit the instant the
   * pointer describes, keyboard steps fall back to one UTC day, and the working-time, task-edge
   * alignment and successor push-out passes are all inert.
   */
  enabled?: boolean;
  /**
   * What edited dates are rounded to. `"scale"` follows the finest timeline header row, a unit
   * name fixes it, and a positive number is a plain millisecond grid measured from the epoch.
   * Default `"scale"`.
   */
  unit?: "scale" | SnapUnit | number;
  /**
   * Replaces the rounding rule entirely. Called once during setup with the built-in behaviour it
   * may fall back to.
   */
  rule?: (base: SnapRuleContext) => SnapRule;
  /**
   * Keeps edited dates inside working time. Off by default. `true` uses the provider's default
   * calendar; the object form names one. Inert without a `snap/workingTime` contribution.
   */
  workingDays?: boolean | SnapWorkingDaysConfig;
  /**
   * Sticks edited dates to other tasks' start/end instants when they come within tolerance. Off by
   * default; `true` uses the default 8-pixel tolerance.
   */
  alignToTasks?: boolean | SnapAlignConfig;
  /**
   * Pushes violated successors forward by appending patches to the same user-origin transaction.
   * Off by default. Stands down while any `snap/pushGuards` contribution suppresses it.
   */
  pushSuccessors?: boolean;
}

/* ------------------------------------------------------------------ *
 * §6.4 – §6.10 — the seven peripheral features
 * ------------------------------------------------------------------ */

// docs/specs/plugins/interaction.md §6.4
/** Tooltip options. Enabled with these defaults when the nest is omitted. */
export interface TooltipConfig {
  /**
   * A function replaces the built-in fallback (task name + start/end dates); `null` removes it.
   * `tooltip/content` contributions always take precedence. Default: the built-in provider.
   */
  content?: TooltipContentProvider | null;
  /**
   * `"click"` shows on bar pointer-down; `"hover"` shows on rest and hides on leave, per the
   * delays; `"both"` does both. Default `"click"`.
   */
  trigger?: "click" | "hover" | "both";
  /** Hover dwell before show, in ms. Non-negative finite only. Default `300`. */
  showDelay?: number;
  /** Linger after the pointer leaves, in ms. Non-negative finite only. Default `100`. */
  hideDelay?: number;
}

// docs/specs/plugins/interaction.md §6.5
/** Context-menu options. Disabled when the nest is omitted. */
export interface ContextMenuConfig {
  /**
   * A function replaces the built-in entries (insert / duplicate / delete / link-from / link-to /
   * cancel-link); `null` removes them (point contributions still show, always after). Default:
   * the built-in entries.
   */
  items?: ContextMenuItemProvider | null;
  /** Where "Insert task" files the new task relative to the pressed one. Default `"child"`. */
  insertMode?: "child" | "sibling";
}

// docs/specs/plugins/interaction.md §6.6
/** Zoom-toolbar options. Disabled when the nest is omitted. */
export interface ZoomControlsConfig {
  /** The ladder the slider and +/- buttons step. Default: the six built-in levels. */
  levels?: readonly string[];
  /** Whether the zoom slider is shown. Default `true`. */
  slider?: boolean;
  /** Whether the +/- buttons are shown. Default `true`. */
  zoomButtons?: boolean;
  /** Whether the fit-to-project button is shown. Default `true`. */
  fitButton?: boolean;
  /** Whether the jump-to-today button is shown. Default `true`. */
  todayButton?: boolean;
  /** Whether the jump-to-selection button is shown. Default `true`. */
  selectionButton?: boolean;
  /** The claimed corner slot. Default `"bottom-right"`. */
  position?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
}

// docs/specs/plugins/interaction.md §6.7
/** Clipboard options. Disabled when the nest is omitted. */
export interface ClipboardConfig {
  /** TSV column order. Default `["name", "start", "end", "progress"]`. */
  fields?: readonly ("name" | "start" | "end" | "progress")[];
  /** Wires native `copy`/`paste` and mirrors programmatic copies where the browser allows. Default `true`. */
  systemClipboard?: boolean;
}

// docs/specs/plugins/interaction.md §6.8
/** Filter / search options. Disabled when the nest is omitted. */
export interface FilterSearchConfig {
  /** Incremental search box with match counter, in the claimed top-right corner. Default `false`. */
  searchBox?: boolean;
  /** Filter button + checkbox value-list panel per filterable field. Default `false`. */
  filterPanel?: boolean;
  /** Replaces the built-in filterable fields; an empty array means none. Default: assigned resource, task type. */
  fields?: readonly FilterFieldDef[];
  /** Named filter views available from the start; in-memory only. Default `{}`. */
  views?: Record<string, FilterView>;
}

// docs/specs/plugins/interaction.md §6.9
/** Edit-dialog options. Disabled when the nest is omitted. */
export interface EditDialogConfig {
  /**
   * Two presses of the same task within 400ms (no selection modifier) open the dialog; `false`
   * leaves `edit-dialog/open` the only way in. Default `true`.
   */
  openOnDoubleClick?: boolean;
  /** Custom body, called with an empty body element on every render. Default: the built-in form. */
  renderBody?: (host: HTMLElement, ctx: EditDialogRenderContext) => void;
}

// docs/specs/plugins/interaction.md §6.10
/** Side-panel options. Disabled when the nest is omitted. */
export interface SidePanelConfig {
  /** Adds a read-only formatted line per date field; called only with finite instants. Default: none. */
  formatDate?: (t: number) => string;
  /** Whole-body seam; pane chrome, divider, selection-following and dispatch stay built in. Default: the built-in body. */
  renderBody?: (host: HTMLElement, ctx: SidePanelRenderContext) => void;
}

/* ------------------------------------------------------------------ *
 * The plugin's own config
 * ------------------------------------------------------------------ */

// docs/specs/plugins/interaction.md §6
/** Options for the interaction plugin. */
export interface InteractionConfig {
  selection?: SelectionConfig;
  dragEdit?: DragEditConfig;
  snap?: SnapConfig;
  tooltip?: TooltipConfig;
  contextMenu?: ContextMenuConfig;
  zoomControls?: ZoomControlsConfig;
  clipboard?: ClipboardConfig;
  filterSearch?: FilterSearchConfig;
  editDialog?: EditDialogConfig;
  sidePanel?: SidePanelConfig;
  /**
   * Replacement wording, one key at a time (§8). A key left out keeps its English default, a key
   * of the wrong kind is ignored, and a builder that throws is reported and answered by the
   * built-in default for that call.
   */
  messages?: Partial<InteractionMessages>;
}

/* ------------------------------------------------------------------ *
 * Resolution
 * ------------------------------------------------------------------ */

/** The resolved selection options: every member present, every value usable. */
export interface ResolvedSelection {
  mode: "single" | "multi" | "none";
  shortcuts: { selectAll: boolean; clearOnEscape: boolean; deleteSelected: boolean };
  confirmDelete: ((request: DeleteConfirmRequest) => boolean | Promise<boolean>) | undefined;
  revealSelected: boolean;
}

/** The resolved drag-edit options: every member present, every value usable. */
export interface ResolvedDragEdit {
  enabled: boolean;
  liveUpdate: boolean;
  dragTooltip: boolean;
  minDuration: number;
  rowDrag: boolean;
  clickMove: boolean;
  multiDrag: boolean;
  autoScroll: boolean;
  dependencyPreview: boolean;
  resourceDrag: boolean;
  frameSync: boolean;
}

/**
 * The resolved snap options; `unit` is either a fixed unit or the zoom-following default.
 *
 * With `enabled: false` every other member resolves to its off value — no custom rule, no
 * extensions — so "the whole feature is inert" is decided once here instead of at each of the four
 * gates that would otherwise have to agree.
 */
export interface ResolvedSnap {
  enabled: boolean;
  unit: SnapUnit | number | "scale";
  rule: ((base: SnapRuleContext) => SnapRule) | undefined;
  /** `undefined` when the working-time adjustment is off. */
  working: { calendar: CalendarId | undefined } | undefined;
  /** `undefined` when task-edge alignment is off. */
  align: { tolerancePx: number } | undefined;
  pushSuccessors: boolean;
}

/** Everything `setup()` reads, resolved once from the factory's config object. */
export interface ResolvedConfig {
  selection: ResolvedSelection;
  dragEdit: ResolvedDragEdit;
  snap: ResolvedSnap;
  /** Which of the ten feature nests are enabled in this composition. */
  enabled: {
    tooltip: boolean;
    contextMenu: boolean;
    zoomControls: boolean;
    clipboard: boolean;
    filterSearch: boolean;
    editDialog: boolean;
    sidePanel: boolean;
  };
}

/** The default alignment tolerance, in CSS pixels at the current zoom. */
export const DEFAULT_ALIGN_TOLERANCE_PX = 8;

/** Whether `value` is a plain object usable as a config nest. */
function isNest(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Whether `value` is one of the five calendar units. */
export function isSnapUnit(value: unknown): value is SnapUnit {
  return (
    value === "year" || value === "month" || value === "week" || value === "day" || value === "hour"
  );
}

/** A positive finite number, or `fallback` for anything else. */
function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function resolveSelection(raw: SelectionConfig | undefined): ResolvedSelection {
  const nest = isNest(raw) ? raw : {};
  const mode = nest["mode"];
  const shortcuts = isNest(nest["shortcuts"]) ? (nest["shortcuts"] as Record<string, unknown>) : {};
  const confirm = nest["confirmDelete"];
  return {
    mode: mode === "multi" || mode === "none" ? mode : "single",
    shortcuts: {
      selectAll: shortcuts["selectAll"] === true,
      clearOnEscape: shortcuts["clearOnEscape"] === true,
      deleteSelected: shortcuts["deleteSelected"] === true,
    },
    confirmDelete:
      typeof confirm === "function"
        ? (confirm as ResolvedSelection["confirmDelete"])
        : undefined,
    revealSelected: nest["revealSelected"] !== false,
  };
}

function resolveDragEdit(raw: DragEditConfig | undefined): ResolvedDragEdit {
  const nest = isNest(raw) ? raw : {};
  return {
    enabled: nest["enabled"] !== false,
    liveUpdate: nest["liveUpdate"] === true,
    dragTooltip: nest["dragTooltip"] === true,
    minDuration: positive(nest["minDuration"], 0),
    rowDrag: nest["rowDrag"] === true,
    clickMove: nest["clickMove"] === true,
    multiDrag: nest["multiDrag"] === true,
    autoScroll: nest["autoScroll"] === true,
    dependencyPreview: nest["dependencyPreview"] === true,
    resourceDrag: nest["resourceDrag"] === true,
    frameSync: nest["frameSync"] === true,
  };
}

/** Folds `snap.workingDays` into its settings, or `undefined` when the feature is off. */
function resolveWorking(value: unknown): { calendar: CalendarId | undefined } | undefined {
  if (value === true) return { calendar: undefined };
  if (isNest(value)) {
    const calendar = value["calendar"];
    return {
      calendar:
        typeof calendar === "string" || typeof calendar === "number" ? calendar : undefined,
    };
  }
  return undefined;
}

/** Folds `snap.alignToTasks` into a tolerance, or `undefined` when the feature is off. */
function resolveAlign(value: unknown): { tolerancePx: number } | undefined {
  if (value === true) return { tolerancePx: DEFAULT_ALIGN_TOLERANCE_PX };
  if (isNest(value)) {
    return { tolerancePx: positive(value["tolerancePx"], DEFAULT_ALIGN_TOLERANCE_PX) };
  }
  return undefined;
}

function resolveSnap(raw: SnapConfig | undefined): ResolvedSnap {
  const nest = isNest(raw) ? raw : {};
  if (nest["enabled"] === false) {
    return {
      enabled: false,
      unit: "scale",
      rule: undefined,
      working: undefined,
      align: undefined,
      pushSuccessors: false,
    };
  }
  const unit = nest["unit"];
  const rule = nest["rule"];
  return {
    enabled: true,
    unit:
      typeof unit === "number"
        ? positive(unit, 0) || "scale"
        : isSnapUnit(unit)
          ? unit
          : "scale",
    rule: typeof rule === "function" ? (rule as ResolvedSnap["rule"]) : undefined,
    working: resolveWorking(nest["workingDays"]),
    align: resolveAlign(nest["alignToTasks"]),
    pushSuccessors: nest["pushSuccessors"] === true,
  };
}

/**
 * Resolves the whole configuration once, at construction.
 *
 * The four preset-bundled nests resolve to their defaults when omitted; the six opt-in nests are
 * enabled by the mere presence of a usable nest object.
 */
export function resolveConfig(raw: InteractionConfig | undefined): ResolvedConfig {
  const config = isNest(raw) ? (raw as InteractionConfig) : {};
  return {
    selection: resolveSelection(config.selection),
    dragEdit: resolveDragEdit(config.dragEdit),
    snap: resolveSnap(config.snap),
    enabled: {
      // §6.4 is one of the four preset-bundled groups and carries no off switch of its own: the
      // nest tunes the feature, it never disables it.
      tooltip: true,
      contextMenu: isNest(config.contextMenu),
      zoomControls: isNest(config.zoomControls),
      clipboard: isNest(config.clipboard),
      filterSearch: isNest(config.filterSearch),
      editDialog: isNest(config.editDialog),
      sidePanel: isNest(config.sidePanel),
    },
  };
}
