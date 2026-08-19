/**
 * The feature's config type. The value types it operates on — `TaskFieldValues`,
 * `TaskFieldsPatch`, `TaskStatus`, `TaskPriority`, `TaskTemplate`, `DurationUnit`,
 * `TaskFieldsColumnId` — are declared on the plugin's public surface and imported from there.
 */
import type {
  DurationUnit,
  TaskFieldsColumnId,
  TaskTemplate,
} from "../../types";

// docs/specs/plugins/tree-grid.md § Config — the `taskFields` nest.
/**
 * Options of the standard field columns, bar decorations and side-panel section. Every field is
 * optional; omitting the whole nest disables the feature entirely, while an empty object enables
 * it with these defaults.
 */
export interface TaskFieldsConfig {
  /**
   * Which grid columns to contribute, in order. Defaults to
   * `["status", "priority", "deadline"]`; an empty array contributes none. Entries that are not
   * known column ids are dropped.
   */
  columns?: readonly TaskFieldsColumnId[];
  /** Draw a status glyph inside each bar's left end. Default `true`. */
  showStatusOnBars?: boolean;
  /** Draw a warning triangle at the right end of an overdue task's bar. Default `true`. */
  showDeadlineWarnings?: boolean;
  /** Draw up to three assignee initials after each bar. Default `true`. */
  showAssigneeAvatars?: boolean;
  /** Contribute the field-editing section to the side panel. Default `true`. */
  detailFields?: boolean;
  /** Unit for the duration column and the duration-related internal helpers. Default `"days"`. */
  durationUnit?: DurationUnit;
  /**
   * Shape of the automatic sequence ID: `prefix + zero-padded(start + position)`. Defaults to
   * no prefix, starting at 1, without padding.
   */
  idNumbering?: { prefix?: string; start?: number; minDigits?: number };
  /**
   * When `true` (the default), changing a task's status to `done` records the current time as
   * its actual end date inside the same transaction, unless the task already has one.
   */
  autoRecordCompletion?: boolean;
  /** Named templates that can be applied to existing tasks or used to create new tasks. */
  templates?: Readonly<Record<string, TaskTemplate>>;
}
