// docs/specs/plugins/a11y.md § Summary table.
/**
 * The opt-in screen-reader summary table: on demand — never eagerly — the whole task list is
 * rendered as one plain, visually hidden `<table>` (name / start / end / progress in tree order,
 * collapsed branches included), so a screen-reader user can read the chart with the reader's own
 * table commands instead of row by row through the virtualized mirror.
 *
 * The table exists only while it is open; toggling it off removes the DOM again and restores the
 * focus to wherever it sat before.
 */
import { focusRestorer, isoDay } from "@stargantt/sdk";
import type { DataService, TaskId } from "@stargantt/plugin-data-store";
import type { A11yMessages } from "../types";
import { hideVisually } from "./mirror";

const CONTAINER_CLASS = "sg-a11y-summary";

// A 100k-task chart cannot sensibly become 100k DOM rows in one shot; the cap keeps the on-demand
// build bounded, and the caption states the truncation.
export const SUMMARY_ROW_CAP = 1000;

/**
 * Every task id in tree order (depth-first, children under their parent), collapsed branches
 * included — the summary covers the whole store, not just the visible rows.
 */
export function allTaskIdsInTreeOrder(
  children: ReadonlyMap<TaskId | null, readonly TaskId[]>,
): TaskId[] {
  const out: TaskId[] = [];
  const stack: TaskId[] = [...(children.get(null) ?? [])].reverse();
  while (stack.length > 0) {
    const id = stack.pop();
    if (id === undefined) continue;
    out.push(id);
    const kids = children.get(id);
    if (kids !== undefined) {
      for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i] as TaskId);
    }
  }
  return out;
}

export interface SummaryTableDeps {
  doc: Document;
  /** The chart root the table mounts into. */
  root: HTMLElement;
  data: DataService;
  messages: Pick<A11yMessages, "summaryTitle" | "summaryHeader">;
}

export interface SummaryTable {
  isOpen(): boolean;
  /** Builds and focuses the table, or removes an open one. */
  toggle(): void;
  close(): void;
}

export function createSummaryTable(deps: SummaryTableDeps): SummaryTable {
  let container: HTMLElement | null = null;
  /** Where the DOM focus sat before the table took it, restored on close. */
  const restorer = focusRestorer(deps.doc);

  function close(): void {
    if (container === null) return;
    container.remove();
    container = null;
    restorer.restore();
  }

  function open(): void {
    if (container !== null) return;
    const { doc, data, messages } = deps;
    restorer.save();

    const ids = allTaskIdsInTreeOrder(data.query().children);
    const shown = Math.min(ids.length, SUMMARY_ROW_CAP);

    const wrap = doc.createElement("div");
    wrap.className = CONTAINER_CLASS;
    wrap.setAttribute("tabindex", "-1");
    hideVisually(wrap);

    const table = doc.createElement("table");
    const caption = doc.createElement("caption");
    caption.textContent = messages.summaryTitle({ total: ids.length, shown });
    table.appendChild(caption);

    const thead = doc.createElement("thead");
    const headRow = doc.createElement("tr");
    for (const column of ["name", "start", "end", "progress"] as const) {
      const th = doc.createElement("th");
      th.setAttribute("scope", "col");
      th.textContent = messages.summaryHeader(column);
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = doc.createElement("tbody");
    for (let i = 0; i < shown; i += 1) {
      const id = ids[i];
      const task = id === undefined ? undefined : data.getTask(id);
      if (task === undefined) continue;
      const tr = doc.createElement("tr");
      const cells = [
        task.name,
        isoDay(task.start) ?? "",
        isoDay(task.end) ?? "",
        task.progress === undefined ? "" : `${Math.round(task.progress * 100)}%`,
      ];
      for (const text of cells) {
        const td = doc.createElement("td");
        td.textContent = text;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);

    deps.root.appendChild(wrap);
    container = wrap;
    if (typeof wrap.focus === "function") wrap.focus();
  }

  return {
    isOpen: () => container !== null,
    toggle: () => (container === null ? open() : close()),
    close,
  };
}
