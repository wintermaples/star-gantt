/**
 * The plugin-wide message catalog: the English defaults of all 40 keys and the per-key shallow
 * override the configured catalog is resolved through.
 */
import type { TreeGridMessages } from "../types";

// docs/specs/plugins/tree-grid.md § Messages — the normative default table, 40 keys.
export const DEFAULT_MESSAGES: TreeGridMessages = {
  nameColumn: "Name",
  startColumn: "Start",
  endColumn: "End",
  progressColumn: "Progress",
  wbsColumn: "WBS",
  newTaskName: "New task",
  paneResizeLabel: "Resize pane",
  idColumn: "ID",
  statusColumn: "Status",
  priorityColumn: "Priority",
  tagsColumn: "Tags",
  assigneesColumn: "Assignees",
  deadlineColumn: "Deadline",
  actualStartColumn: "Actual start",
  actualEndColumn: "Actual end",
  durationColumn: "Duration",
  statusNotStarted: "Not started",
  statusInProgress: "In progress",
  statusDone: "Done",
  statusOnHold: "On hold",
  priorityHigh: "High",
  priorityMedium: "Medium",
  priorityLow: "Low",
  fieldsSection: "Task fields",
  statusLabel: "Status",
  priorityLabel: "Priority",
  tagsLabel: "Tags",
  tagsPlaceholder: "tag1, tag2",
  deadlineLabel: "Deadline",
  actualStartLabel: "Actual start",
  actualEndLabel: "Actual end",
  notesLabel: "Notes",
  notesPlaceholder: "Add a note",
  noneOption: "—",
  templateTaskName: "New task",
  legendOverdue: "Overdue",
  legendPriority: ({ priority }) => `Priority ${priority}`,
  legendProgressBehind: "Behind schedule",
  legendProgressOnTrack: "On track",
  legendProgressComplete: "Complete",
};

// A tabbable divider's accessible name must never be missing, so an empty or blank override falls
// back to the built-in default instead of suppressing the name the way the plain
// empty-string-verbatim behavior does for every other key.
const DIVIDER_LABEL_KEYS = new Set<keyof TreeGridMessages>(["paneResizeLabel"]);

// docs/specs/plugins/tree-grid.md § Messages — per-key shallow override; a member of the wrong type
// (including `undefined`) is ignored and `""` is taken verbatim, except for the divider-label key.
export function resolveMessages(overrides: Partial<TreeGridMessages> | undefined): TreeGridMessages {
  const resolved = { ...DEFAULT_MESSAGES };
  if (overrides === null || typeof overrides !== "object") return resolved;
  for (const key of Object.keys(DEFAULT_MESSAGES) as (keyof TreeGridMessages)[]) {
    const value = overrides[key];
    if (key === "legendPriority") {
      if (typeof value === "function") resolved.legendPriority = value;
      continue;
    }
    if (typeof value !== "string") continue;
    if (DIVIDER_LABEL_KEYS.has(key) && value.trim() === "") continue;
    resolved[key] = value as never;
  }
  return resolved;
}
