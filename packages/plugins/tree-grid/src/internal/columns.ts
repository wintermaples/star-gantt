/**
 * The name / start / end / progress columns the tree-grid contributes to `grid/columns` by default.
 *
 * They are contributed through the ordinary public `ctx.contribute` path — no back door — so a
 * third party can drop or shadow them exactly like any other contribution.
 */
import type { Task } from "@stargantt/plugin-data-store";
import { BUILT_IN_COLUMN_WEIGHT } from "./column-order";
import type { TreeGridMessages } from "../types";
import type { ColumnDef } from "../types";

/**
 * Renders a task timestamp as an ISO calendar date.
 *
 * Tasks store `start` / `end` as epoch milliseconds in UTC, and cell contents are formatting rather
 * than wording, so the built-in columns stay locale-neutral. A host that wants `Intl` output
 * supplies `TreeGridConfig.formatDate`.
 */
export function defaultDateText(t: number): string {
  // docs/specs/plugins/tree-grid.md § Config — the normative default table.
  return new Date(t).toISOString().slice(0, 10);
}

/** Renders a task's stored progress as a whole percentage. The value is not clamped. */
export function defaultProgressText(p: number): string {
  return `${Math.round(p * 100)}%`;
}

// docs/specs/plugins/tree-grid.md § Config
/**
 * The cell formatters the built-in columns use, already resolved and fault-guarded by the caller.
 */
export interface CellFormatters {
  /** Called only with a finite epoch-ms instant. */
  date(t: number): string;
  /** Called only with a finite number, the raw stored progress. */
  progress(p: number): string;
}

/** The formatters a composition that supplies neither hook gets. */
export const DEFAULT_FORMATTERS: CellFormatters = {
  date: defaultDateText,
  progress: defaultProgressText,
};

// docs/specs/plugins/tree-grid.md § Config — the finiteness guards live here, outside
// the hook: a cell whose value is absent or not a finite number renders the empty string *without*
// calling the hook, so a hook never has to re-implement the guard and today's empty-cell behavior is
// preserved for free.
function finite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** The four built-in column contributions, in header order, headed by the resolved catalog. */
export function defaultColumns(
  messages: TreeGridMessages,
  formatters: CellFormatters = DEFAULT_FORMATTERS,
): ColumnDef[] {
  return [
    {
      id: "name",
      weight: BUILT_IN_COLUMN_WEIGHT,
      header: messages.nameColumn,
      width: 220,
      render(el, task) {
        el.textContent = task.name;
      },
      getValue: (task) => task.name,
      // docs/specs/plugins/tree-grid.md § Extension points — the only built-in column that carries
      // `setValue`, so it is the only one editable by default. The grid hands `setValue` a private,
      // genuinely mutable draft object typed `Readonly<Task>` only for the API's benefit; the cast
      // below is how a writer honors that guarantee.
      setValue: (task, value) => {
        (task as Task).name = String(value);
      },
    },
    {
      id: "start",
      weight: BUILT_IN_COLUMN_WEIGHT,
      header: messages.startColumn,
      width: 110,
      render(el, task) {
        el.textContent = finite(task.start) ? formatters.date(task.start) : "";
      },
      getValue: (task) => task.start,
    },
    {
      id: "end",
      weight: BUILT_IN_COLUMN_WEIGHT,
      header: messages.endColumn,
      width: 110,
      render(el, task) {
        el.textContent = finite(task.end) ? formatters.date(task.end) : "";
      },
      getValue: (task) => task.end,
    },
    {
      id: "progress",
      weight: BUILT_IN_COLUMN_WEIGHT,
      header: messages.progressColumn,
      width: 90,
      render(el, task) {
        el.textContent = finite(task.progress) ? formatters.progress(task.progress) : "";
      },
      getValue: (task) => task.progress,
    },
  ];
}
