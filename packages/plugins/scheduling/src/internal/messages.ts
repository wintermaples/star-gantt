// docs/specs/plugins/scheduling.md §12
/**
 * `SchedulingMessages` — the plugin's single merged message catalog.
 *
 * 62 keys, merged from the separate catalogs of auto-schedule (3), dependencies (10), calendars (43) and
 * schedule-diagnostics (6). Zero key names collide across the four, so the "prefixed only on
 * collision" rule fires nowhere: every key keeps its original name and nothing is renamed. Defaults
 * are byte-for-byte the original ones.
 *
 * Resolution is `sdk/dom`'s `resolveCatalog`: per-key shallow override, a key of the wrong kind is
 * ignored, the empty string is usable and taken verbatim, and a throwing builder is reported
 * (`core/pluginError`) and answered by the built-in default for that call. Every builder here is
 * gesture-driven, so none is latched at setup.
 *
 * critical-path contributes no keys (there was no catalog for it): its warning glyph is iconography, not
 * text.
 */
import { resolveCatalog } from "@stargantt/sdk";
import type { LinkType } from "@stargantt/plugin-data-store";

/** Arguments of the two dependency-inspector line builders. */
export interface LinkLineParts {
  /** The other endpoint's task name. */
  name: string;
  /** The dependency kind. */
  type: LinkType;
  /** The link's lag, in days. */
  lagDays: number;
}

/** One working window, as the calendar editor's remove-button label names it. */
export interface WindowParts {
  /** Window start, formatted `"HH:MM"`. */
  from: string;
  /** Window end, formatted `"HH:MM"`. */
  to: string;
}

/** Arguments of the "period applied" status line. */
export interface PeriodAppliedParts {
  /** How many UTC days the period covered. */
  days: number;
  /** The period's first day, `"YYYY-MM-DD"`. */
  from: string;
  /** Whether those days were made working. */
  working: boolean;
}

/** Arguments of the "tasks assigned" status line. */
export interface AssignedParts {
  /** How many tasks were put on the calendar. */
  count: number;
  /** The calendar's display name. */
  calendar: string;
}

/** Every user-visible string this plugin can show. */
export interface SchedulingMessages {
  /* --- auto-schedule (3) --------------------------------------------- */
  /** Header of the opt-in schedule-mode grid column. */
  modeColumnHeader: string;
  /** Cell text for an automatically scheduled task. */
  modeAuto: string;
  /** Cell text for a manually scheduled task. */
  modeManual: string;

  /* --- dependencies (10) --------------------------------------------- */
  /** Legend of the side-panel dependency inspector. */
  inspectorLabel: string;
  /** Shown when the selected task has no link at all. */
  noLinks: string;
  /** Label of the inspector's link picker. */
  linkPickerLabel: string;
  /** Label of the inspector's type selector. */
  typeLabel: string;
  /** Label of the inspector's lag field. */
  lagLabel: string;
  /** Label of the inspector's remove button. */
  removeLink: string;
  /** One predecessor line of the inspector list. */
  incomingLink(parts: LinkLineParts): string;
  /** One successor line of the inspector list. */
  outgoingLink(parts: LinkLineParts): string;
  /** Announced after a link was removed. */
  linkRemoved: string;
  /** Announced after a link was retyped or re-lagged. */
  linkUpdated: string;

  /* --- calendars (43) ------------------------------------------------- */
  /** Title of the working-calendar editor dialog. */
  editorTitle: string;
  /** Label of the editor's calendar picker. */
  calendarLabel: string;
  /** Label of the single-date exception field. */
  dateLabel: string;
  /** Label of the exception's working checkbox. */
  workingLabel: string;
  /** Label of the add-exception button. */
  addException: string;
  /** Accessible name of one exception row's remove button. */
  removeException(date: string): string;
  /** Legend of the weekly working-days section. */
  workingDaysLegend: string;
  /** Label of the editor's close button. */
  close: string;
  /** Shown when the registry holds no calendar. */
  empty: string;
  /** Legend of the intra-day windows section. */
  hoursLegend: string;
  /** Shown when the picked calendar declares no window. */
  noWindows: string;
  /** Label of the add-window button. */
  addWindow: string;
  /** Label of the clear-windows button. */
  clearWindows: string;
  /** Accessible name of one window row's remove button. */
  removeWindow(window: WindowParts): string;
  /** Label of a window row's start field. */
  windowStartLabel: string;
  /** Label of a window row's end field. */
  windowEndLabel: string;
  /** Text of a generic remove button. */
  removeButton: string;
  /** Legend of the special-period section. */
  periodsLegend: string;
  /** Label of the period's first-day field. */
  fromLabel: string;
  /** Label of the period's last-day field. */
  toLabel: string;
  /** Label of the period's working/non-working selector. */
  periodKindLabel: string;
  /** The period selector's "working" choice. */
  periodWorking: string;
  /** The period selector's "non-working" choice. */
  periodNonWorking: string;
  /** Label of the period's optional hours field. */
  periodHoursLabel: string;
  /** Label of the apply-period button. */
  applyPeriod: string;
  /** Label of the remove-period button. */
  removePeriod: string;
  /** How a non-working exception day states its designation. */
  exceptionNonWorking: string;
  /** How a working exception day without its own hours states its designation. */
  exceptionWorkingDefault: string;
  /** How a working exception day with its own hours states its designation. */
  exceptionWorkingHours(windows: string): string;
  /** Legend of the task-assignment section. */
  assignLegend: string;
  /** Label of the assign-selected button. */
  assignSelected: string;
  /** Label of the unassign-selected button. */
  unassignSelected: string;
  /** Status line after the weekly pattern changed. */
  statusWorkingDays(days: readonly string[]): string;
  /** Status line after the intra-day windows changed. */
  statusWorkingHours(count: number): string;
  /** Status line after a special period was applied. */
  statusPeriodApplied(parts: PeriodAppliedParts): string;
  /** Status line after a special period was removed. */
  statusPeriodRemoved(count: number): string;
  /** Status line refusing an unusable period. */
  statusPeriodInvalid: string;
  /** Status line refusing an unusable working window. */
  statusWindowInvalid: string;
  /** Status line after one exception day was added. */
  statusExceptionAdded(date: string): string;
  /** Status line after one exception day was removed. */
  statusExceptionRemoved(date: string): string;
  /** Status line after tasks were put on a calendar. */
  statusAssigned(parts: AssignedParts): string;
  /** Status line after tasks were put back on the default calendar. */
  statusUnassigned(count: number): string;
  /** Status line refusing an assignment with nothing selected. */
  statusNoSelection: string;

  /* --- schedule-diagnostics (6) --------------------------------------- */
  /** Text of the diagnostics panel's toggle button. */
  button(issueCount: number): string;
  /** Accessible name of the diagnostics dropdown. */
  panelLabel: string;
  /** Heading of the unlinked-tasks category. */
  orphanHeading(count: number): string;
  /** Heading of the negative-lag category. */
  leadHeading(count: number): string;
  /** Shown when the audit found nothing. */
  noIssues: string;
  /** One lead item of the diagnostics list. */
  leadItem(sourceName: string, targetName: string, lagDays: number): string;
}

/** The plain English `s` suffix the calendar status builders use (`n === 1` → none). */
function plural(n: number): string {
  return n === 1 ? "" : "s";
}

/** `", +2d"` / `", -1d"` for a non-zero lag, the empty string for zero — the sign only when positive. */
function lagSuffix(lagDays: number): string {
  if (lagDays === 0) return "";
  return lagDays > 0 ? `, +${String(lagDays)}d` : `, ${String(lagDays)}d`;
}

const DEFAULT_MESSAGES: SchedulingMessages = {
  modeColumnHeader: "Mode",
  modeAuto: "Auto",
  modeManual: "Manual",

  inspectorLabel: "Dependencies",
  noLinks: "None",
  linkPickerLabel: "Link",
  typeLabel: "Type",
  lagLabel: "Lag (days)",
  removeLink: "Remove",
  incomingLink: ({ name, type, lagDays }) => `← ${name} (${type}${lagSuffix(lagDays)})`,
  outgoingLink: ({ name, type, lagDays }) => `→ ${name} (${type}${lagSuffix(lagDays)})`,
  linkRemoved: "Link removed",
  linkUpdated: "Link updated",

  editorTitle: "Working calendar",
  calendarLabel: "Calendar",
  dateLabel: "Date",
  workingLabel: "Working",
  addException: "Add exception",
  removeException: (date) => `Remove exception ${date}`,
  workingDaysLegend: "Working days",
  close: "Close",
  empty: "No calendars defined",
  hoursLegend: "Working hours",
  noWindows: "No windows — a working day counts in full.",
  addWindow: "Add window",
  clearWindows: "Clear windows",
  removeWindow: ({ from, to }) => `Remove working window ${from} to ${to}`,
  windowStartLabel: "Working window start",
  windowEndLabel: "Working window end",
  removeButton: "Remove",
  periodsLegend: "Special period",
  fromLabel: "From",
  toLabel: "To",
  periodKindLabel: "These days are",
  periodWorking: "Working",
  periodNonWorking: "Non-working",
  periodHoursLabel: "Only these hours",
  applyPeriod: "Apply period",
  removePeriod: "Remove period",
  exceptionNonWorking: "Non-working",
  exceptionWorkingDefault: "Working (calendar hours)",
  exceptionWorkingHours: (windows) => `Working ${windows}`,
  assignLegend: "Task calendar",
  assignSelected: "Put selected tasks on it",
  unassignSelected: "Back to the default",
  statusWorkingDays: (days) =>
    days.length === 0
      ? "No working day left — every day of this calendar is non-working."
      : `Working days: ${days.join(", ")}.`,
  statusWorkingHours: (count) =>
    count === 0
      ? "Working hours cleared — every working day counts in full."
      : `${String(count)} working window${plural(count)} applied.`,
  statusPeriodApplied: ({ days, from, working }) =>
    `${String(days)} day${plural(days)} from ${from} set ${working ? "working" : "non-working"}.`,
  statusPeriodRemoved: (count) =>
    count === 0
      ? "No exception day falls in that period."
      : `${String(count)} exception day${plural(count)} removed.`,
  statusPeriodInvalid: "Pick both dates first; the period cannot end before it starts.",
  statusWindowInvalid: "Those hours end before they start.",
  statusExceptionAdded: (date) => `Exception on ${date} added.`,
  statusExceptionRemoved: (date) => `Exception on ${date} removed.`,
  statusAssigned: ({ count, calendar }) =>
    `${String(count)} task${plural(count)} now on ${calendar}.`,
  statusUnassigned: (count) =>
    `${String(count)} task${plural(count)} back on the default calendar.`,
  statusNoSelection: "Select one or more tasks first.",

  button: (issueCount) => `Diagnostics (${String(issueCount)})`,
  panelLabel: "Schedule diagnostics",
  orphanHeading: (count) => `Unlinked tasks (${String(count)})`,
  leadHeading: (count) => `Leads — negative lag (${String(count)})`,
  noIssues: "No issues found",
  leadItem: (sourceName, targetName, lagDays) =>
    `${sourceName} → ${targetName} (lag ${String(lagDays)}d)`,
};

/** The key set of the catalog, in declaration order — the count the spec pins at 62. */
export const SCHEDULING_MESSAGE_KEYS = Object.keys(
  DEFAULT_MESSAGES,
) as readonly (keyof SchedulingMessages)[];

/** Resolves the host's per-key overrides against the built-in defaults (§12). */
export function resolveMessages(
  overrides: Partial<SchedulingMessages> | undefined,
  onFault: (key: keyof SchedulingMessages & string, error: unknown) => void,
): SchedulingMessages {
  return resolveCatalog(DEFAULT_MESSAGES, overrides, onFault);
}
