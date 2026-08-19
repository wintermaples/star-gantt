// docs/specs/plugins/export.md §8 — the single merged 26-key catalog.
/**
 * `ExportMessages`: a single 26-key catalog merging 13 print/export keys with 13 import/export
 * keys. The two groups share no key name, so the merge is a union with no collision and no
 * rename.
 *
 * Resolution goes through the SDK's `resolveCatalog`, which supplies the latched fault containment
 * the spec asks for: a host builder that throws or returns a non-string is reported once via
 * `core/pluginError` and the built-in default answers that call and every later one.
 *
 * Internal: not part of the published surface (the type is re-exported from `../index.ts`).
 */
import { resolveCatalog } from "@stargantt/sdk";
import type { ImportIssue, PrintPageInfo, TaskCsvField } from "../types";

/** The two count builders' shared plural rule (§8). */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The user-visible text of the export plugin, per-key replaceable through `ExportConfig.messages`. */
export interface ExportMessages {
  /* --- print (§1.2–§1.3) --- */
  /** Builds the footer page-number text. Default produces text like `"Page 3 of 7"`. */
  pageNumber: (info: PrintPageInfo) => string;
  /** Title of the legend band. Default `"Legend"`. */
  legendTitle: string;
  /** Label of the auto-generated task legend entry. Default `"Task"`. */
  legendTask: string;
  /** Label of the auto-generated summary legend entry. Default `"Summary"`. */
  legendSummary: string;
  /** Label of the auto-generated milestone legend entry. Default `"Milestone"`. */
  legendMilestone: string;
  /** Label of the critical-path legend entry. Default `"Critical path"`. */
  legendCritical: string;
  /** Accessible name and header text of the print-preview dialog. Default `"Print preview"`. */
  previewTitle: string;
  /** Print button label of the preview toolbar. Default `"Print"`. */
  printButton: string;
  /** Close button label of the preview toolbar. Default `"Close"`. */
  closeButton: string;
  /** Printed header of the name column. Default `"Name"`. */
  columnName: string;
  /** Printed header of the start-date column. Default `"Start"`. */
  columnStart: string;
  /** Printed header of the end-date column. Default `"End"`. */
  columnEnd: string;
  /** Printed header of the progress column. Default `"Progress"`. */
  columnProgress: string;

  /* --- import dialog (§1.6) --- */
  /** Accessible name and header text of the import dialog. Default `"Import data"`. */
  dialogTitle: string;
  /** Legend of the column-mapping block. Default `"Column mapping"`. */
  mappingLegend: string;
  /** The "map this column to nothing" mapping entry. Default `"Ignore"`. */
  ignoreColumn: string;
  /** Label of one mapping-select entry. Default: the field name verbatim. */
  fieldLabel: (field: TaskCsvField) => string;
  /** Heading over the issue list. Default `"1 issue"` / `"3 issues"`. */
  issuesHeading: (count: number) => string;
  /** One issue line. Default: an English sentence per issue code. */
  issueText: (issue: ImportIssue) => string;
  /** Heading over the change preview. Default `"Preview"`. */
  previewHeading: string;
  /** Change-kind tag. Default `"Add"`. */
  changeAdd: string;
  /** Change-kind tag. Default `"Update"`. */
  changeUpdate: string;
  /** Change-kind tag. Default `"Remove"`. */
  changeRemove: string;
  /** Shown instead of an empty preview. Default `"No changes to import"`. */
  noChanges: string;
  /** Apply button label. Default `"Import 1 change"` / `"Import 3 changes"`. */
  applyButton: (count: number) => string;
  /** Cancel button label. Default `"Cancel"`. */
  cancelButton: string;
}

/** The default `issueText` builder, exported so the dialog's tests can pin it directly. */
export function defaultIssueText(issue: ImportIssue): string {
  const at = "row" in issue && issue.row !== undefined ? ` (row ${issue.row})` : "";
  switch (issue.code) {
    case "invalid-json":
      return `The JSON could not be read: ${issue.reason}`;
    case "invalid-row":
      return `Row ${issue.row} was skipped: ${issue.reason}`;
    case "bad-date":
      return `Unreadable ${issue.field} date "${String(issue.value)}"${at}`;
    case "missing-field":
      return `Missing required field "${issue.field}"${at}`;
    case "duplicate-id":
      return `Duplicate task id "${String(issue.taskId)}"${at}`;
    case "unknown-parent":
      return `Task "${String(issue.taskId)}" names unknown parent "${String(issue.parentId)}"`;
    case "parent-cycle":
      return `Task "${String(issue.taskId)}" is part of a parent cycle`;
    case "unknown-link-end":
      return `Link "${String(issue.linkId)}" names unknown task "${String(issue.taskId)}"`;
    case "dependency-cycle":
      return `Dependency cycle: ${issue.taskIds.map(String).join(" → ")}`;
  }
}

export const DEFAULT_MESSAGES: ExportMessages = {
  pageNumber: (info) => `Page ${info.page} of ${info.pages}`,
  legendTitle: "Legend",
  legendTask: "Task",
  legendSummary: "Summary",
  legendMilestone: "Milestone",
  legendCritical: "Critical path",
  previewTitle: "Print preview",
  printButton: "Print",
  closeButton: "Close",
  columnName: "Name",
  columnStart: "Start",
  columnEnd: "End",
  columnProgress: "Progress",
  dialogTitle: "Import data",
  mappingLegend: "Column mapping",
  ignoreColumn: "Ignore",
  fieldLabel: (field) => field,
  issuesHeading: (count) => plural(count, "issue"),
  issueText: defaultIssueText,
  previewHeading: "Preview",
  changeAdd: "Add",
  changeUpdate: "Update",
  changeRemove: "Remove",
  noChanges: "No changes to import",
  applyButton: (count) => `Import ${plural(count, "change")}`,
  cancelButton: "Cancel",
};

/**
 * Per-key shallow override of the defaults, resolved once at `setup()`.
 *
 * `onFault` is called with the offending key when a host-supplied builder throws or returns a
 * non-string — once per key, the latch being `resolveCatalog`'s own.
 */
export function resolveMessages(
  overrides: Partial<ExportMessages> | undefined,
  onFault: (key: keyof ExportMessages & string, error: unknown) => void,
): ExportMessages {
  return resolveCatalog(DEFAULT_MESSAGES, overrides, onFault);
}
