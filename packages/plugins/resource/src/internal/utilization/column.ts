// docs/specs/plugins/resource.md §3.5 — the Overallocation grid column.
/**
 * One read-only `grid/columns` contribution: `resource.overallocation`. Reads the same cached
 * warned-task index the warning glyph does (`./warnings.ts`) — no per-cell aggregation.
 */
import type { ColumnDef } from "@stargantt/plugin-tree-grid";
import type { Task } from "@stargantt/plugin-data-store";
import type { ResourceAreaDeps } from "../areas";
import type { WarningIndex } from "./warnings";

const COLUMN_WIDTH = 140;

/** Wires the `resource.overallocation` grid column; a no-op while `column` is off. */
export function wireColumn(deps: ResourceAreaDeps, index: WarningIndex): void {
  if (deps.config.utilization?.column !== true) return;
  const { ctx, messages } = deps;

  const cellText = (task: Readonly<Task>): string => {
    const names = index.overResourceNamesFor(task.id);
    return names.length === 0 ? "" : messages.overallocatedCell({ resources: names });
  };

  const column: ColumnDef = {
    id: "resource.overallocation",
    header: messages.utilizationColumnHeader,
    width: COLUMN_WIDTH,
    getValue: (task) => cellText(task),
    render(el, task) {
      const text = cellText(task);
      el.textContent = text;
      if (text === "") {
        el.removeAttribute("title");
        el.style.color = "";
      } else {
        el.title = text;
        el.style.color = "var(--sg-ru-warning, #c62828)";
        el.style.fontWeight = "normal";
      }
    },
  };
  ctx.contribute("grid/columns", column);
}
