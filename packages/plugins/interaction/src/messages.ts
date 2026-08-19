// docs/specs/plugins/interaction.md §8
/**
 * The plugin's single message catalog: 58 keys merged from the ten source catalogs, their
 * built-in English defaults, and the one resolution pass a running instance uses.
 *
 * Resolution follows the uniform convention: per-key shallow override, a member of the wrong kind
 * (not a string where a string is expected, not a function where a builder is expected) is ignored,
 * the empty string is usable and taken verbatim, and a supplied builder is foreign code — every
 * call is guarded, a throw is reported through `onFault` and the built-in default answers that one
 * call.
 *
 * Hostless: the fault channel arrives as a callback, so the whole catalog is unit-testable without
 * booting a plugin host.
 */
import { isoDay } from "@stargantt/sdk";
import type { LinkType } from "@stargantt/plugin-data-store";

/* ------------------------------------------------------------------ *
 * Builder argument shapes
 * ------------------------------------------------------------------ */

/** The period an edit committed, as the announcement builder receives it. */
export interface EditedParts {
  /** Name of the edited task. */
  name: string;
  /** Committed start, epoch ms. */
  start: number;
  /** Committed end (exclusive), epoch ms. */
  end: number;
}

/** The completion a progress edit committed, as the announcement builder receives it. */
export interface ProgressEditedParts {
  /** Name of the edited task. */
  name: string;
  /** Committed completion fraction, 0..1. */
  progress: number;
}

/** The period a drag currently proposes, as the drag tooltip's builder receives it. */
export interface DragTooltipParts {
  /** Proposed start, epoch ms — what a release right now would commit. */
  start: number;
  /** Proposed end (exclusive), epoch ms. */
  end: number;
}

/** One dependency line: the task at the other end of the link, and the link's type. */
export interface LinkLineParts {
  /** Name of the counterpart task, or its id rendered as a string when the task is unknown. */
  name: string;
  type: LinkType;
}

/** One assignment line: the assigned resource and its allocation. */
export interface AssignmentLineParts {
  /** Name of the resource, or its id rendered as a string when the resource is unknown. */
  name: string;
  /** Allocation rate; 1 = full-time. */
  units: number;
}

/** One rejected edit: the label of the field whose input was not applied. */
export interface EditRejectedParts {
  /** The field's resolved label text, as shown in the form. */
  label: string;
}

/* ------------------------------------------------------------------ *
 * The catalog
 * ------------------------------------------------------------------ */

// docs/specs/plugins/interaction.md §8 — the 58-key merged catalog.
/** Every user-visible string this plugin produces. */
export interface InteractionMessages {
  /* selection */
  /** The bulk-delete dialog's question. */
  deleteConfirmTitle: (count: number) => string;
  /** Label of the button that confirms the deletion. */
  deleteConfirmButton: string;
  /** Label of the button that dismisses the dialog without deleting. */
  deleteCancelButton: string;

  /* drag edit */
  /** Announced after a keyboard date edit commits. */
  edited: (parts: EditedParts) => string;
  /** Announced after a keyboard progress edit commits. */
  progressEdited: (parts: ProgressEditedParts) => string;
  /** The drag tooltip's readout, rebuilt on every move of a date drag. */
  dragTooltip: (parts: DragTooltipParts) => string;

  /* clipboard */
  copied: (count: number) => string;
  pasted: (count: number) => string;
  duplicated: (count: number) => string;

  /* context menu */
  menuLabel: string;
  insertTask: string;
  duplicateTask: string;
  deleteTask: string;
  linkFrom: string;
  linkTo: string;
  cancelLink: string;
  newTaskName: string;

  /* zoom controls */
  toolbar: string;
  zoomIn: string;
  zoomOut: string;
  zoomSlider: string;
  fit: string;
  today: string;
  selection: string;

  /* filter / search */
  searchPlaceholder: string;
  searchLabel: string;
  filterButton: string;
  filterPanelLabel: string;
  clearFilters: string;
  matchCount: (count: number) => string;

  /* edit dialog */
  dialogTitle: string;
  dialogSave: string;
  dialogCancel: string;
  dialogNameLabel: string;
  dialogStartLabel: string;
  dialogEndLabel: string;
  dialogProgressLabel: string;
  dialogEditRejected: (parts: EditRejectedParts) => string;
  dialogErrorInvalidDate: string;
  dialogErrorDateOrder: string;
  dialogErrorProgressRange: string;

  /* side panel */
  panelNameLabel: string;
  panelStartLabel: string;
  panelEndLabel: string;
  panelProgressLabel: string;
  dependenciesLabel: string;
  resourcesLabel: string;
  noSelection: string;
  noDependencies: string;
  multiSelection: (count: number) => string;
  incomingLink: (parts: LinkLineParts) => string;
  outgoingLink: (parts: LinkLineParts) => string;
  assignment: (parts: AssignmentLineParts) => string;
  panelEditRejected: (parts: EditRejectedParts) => string;
  panelErrorInvalidDate: string;
  panelErrorDateOrder: string;
  panelErrorProgressRange: string;
  panelPaneResizeLabel: string;
}

/** `2024-01-31` from an epoch-ms instant, or the empty string when it does not format. */
function day(t: number): string {
  return isoDay(t) ?? "";
}

/** `"s"` unless `n` is exactly one — the default English plural of the clipboard announcements. */
function plural(n: number): string {
  return n === 1 ? "" : "s";
}

// docs/specs/plugins/interaction.md §8 — these defaults are normative, byte for byte. The arrows
// are U+2190 / U+2192, the assignment separator is U+00D7 and the period dash is U+2013.
/** The built-in English catalog. */
export const DEFAULT_MESSAGES: InteractionMessages = {
  deleteConfirmTitle: (count) => (count === 1 ? "Delete 1 task?" : `Delete ${count} tasks?`),
  deleteConfirmButton: "Delete",
  deleteCancelButton: "Cancel",

  edited: (parts) => `${parts.name}, ${day(parts.start)} – ${day(parts.end)}`,
  progressEdited: (parts) => `${parts.name}, ${Math.round(parts.progress * 100)}%`,
  dragTooltip: (parts) => `${day(parts.start)} – ${day(parts.end)}`,

  copied: (n) => `Copied ${n} task${plural(n)}`,
  pasted: (n) => `Pasted ${n} task${plural(n)}`,
  duplicated: (n) => `Duplicated ${n} task${plural(n)}`,

  menuLabel: "Context menu",
  insertTask: "Insert task",
  duplicateTask: "Duplicate task",
  deleteTask: "Delete task",
  linkFrom: "Start link from here",
  linkTo: "Link here from source",
  cancelLink: "Cancel link",
  newTaskName: "New task",

  toolbar: "Zoom controls",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  zoomSlider: "Zoom level",
  fit: "Fit",
  today: "Today",
  selection: "Selected task",

  searchPlaceholder: "Search tasks",
  searchLabel: "Search tasks",
  filterButton: "Filter",
  filterPanelLabel: "Filters",
  clearFilters: "Clear filters",
  matchCount: (count) => `${count} matches`,

  dialogTitle: "Edit task",
  dialogSave: "Save",
  dialogCancel: "Cancel",
  dialogNameLabel: "Name",
  dialogStartLabel: "Start",
  dialogEndLabel: "End",
  dialogProgressLabel: "Progress",
  dialogEditRejected: (parts) => `${parts.label}: invalid value, edit not applied`,
  dialogErrorInvalidDate: "Enter a valid date (YYYY-MM-DD)",
  dialogErrorDateOrder: "End date must be after the start date",
  dialogErrorProgressRange: "Progress must be a number between 0 and 1",

  panelNameLabel: "Name",
  panelStartLabel: "Start",
  panelEndLabel: "End",
  panelProgressLabel: "Progress",
  dependenciesLabel: "Dependencies",
  resourcesLabel: "Resources",
  noSelection: "No task selected",
  noDependencies: "None",
  multiSelection: (count) => `${count} tasks selected`,
  incomingLink: (parts) => `← ${parts.name} (${parts.type})`,
  outgoingLink: (parts) => `→ ${parts.name} (${parts.type})`,
  assignment: (parts) => `${parts.name} × ${parts.units}`,
  panelEditRejected: (parts) => `${parts.label}: invalid value, edit not applied`,
  panelErrorInvalidDate: "Enter a valid date (YYYY-MM-DD)",
  panelErrorDateOrder: "End date must be after the start date",
  panelErrorProgressRange: "Progress must be a number between 0 and 1",
  panelPaneResizeLabel: "Resize pane",
};

/** How a resolution reports a throwing host builder. */
export type MessageFault = (key: keyof InteractionMessages, error: unknown) => void;

/**
 * The catalog this instance speaks: the defaults with every usable host-supplied member merged
 * over them, one key at a time.
 *
 * A supplied builder is wrapped rather than latched: every call is guarded on its own, so one bad
 * argument does not cost the catalog its wording for the rest of the session (§8).
 */
export function resolveMessages(
  overrides: Partial<InteractionMessages> | undefined,
  onFault: MessageFault,
): InteractionMessages {
  const resolved = { ...DEFAULT_MESSAGES };
  if (overrides === null || typeof overrides !== "object") return resolved;

  for (const key of Object.keys(DEFAULT_MESSAGES) as (keyof InteractionMessages)[]) {
    const fallback = DEFAULT_MESSAGES[key];
    const supplied = overrides[key];
    if (supplied === undefined || typeof supplied !== typeof fallback) continue;
    if (typeof fallback !== "function") {
      resolved[key] = supplied as never;
      continue;
    }
    const build = supplied as (arg: never) => string;
    const builtIn = fallback as (arg: never) => string;
    resolved[key] = ((arg: never): string => {
      try {
        return build(arg);
      } catch (error) {
        onFault(key, error);
        return builtIn(arg);
      }
    }) as never;
  }
  return resolved;
}
