/**
 * Scaffolding for the hostless internal-module tests.
 *
 * The modules under `src/internal/` are deliberately free of `PluginContext`: each takes a small
 * dependency record, so a test wires plain functions and the package's fake DOM instead of booting
 * a `Gantt` instance with several plugins.
 */
import type { Task, TaskId } from "@stargantt/plugin-data-store";
import type { ColumnDef } from "../src/types";
import { RowModel, defaultRowHeightResolver } from "../src/internal/row-model";
import { fakeData, task } from "./_data";

/**
 * A real `RowModel` over a `DataService` double — no host, no extension points.
 *
 * `hiddenIds` stands in for a `rows/height` contribution that reduces a row to 0, which is how a
 * filter hides non-matches.
 */
export function unitModel(tasks: readonly Task[], hiddenIds: readonly TaskId[] = []): RowModel {
  if (hiddenIds.length === 0) return new RowModel(fakeData(tasks), () => defaultRowHeightResolver);
  const hidden = new Set<TaskId>(hiddenIds);
  return new RowModel(fakeData(tasks), () => (t, defaultHeight) =>
    hidden.has(t.id) ? 0 : defaultHeight,
  );
}

/** `n` flat root tasks with ids `t0`… — the row set most virtualization assertions need. */
export function flatRows(n: number): Task[] {
  return Array.from({ length: n }, (_, i) => task(`t${i}` as TaskId, null));
}

/**
 * A minimal column: `render` writes the task name, `getValue` reads it. Pass `setValue` to make it
 * editable and `compare` to make it sortable.
 */
export function unitColumn(id: string, extra: Partial<ColumnDef> = {}): ColumnDef {
  return {
    id,
    header: id.toUpperCase(),
    render: (el, t) => {
      el.textContent = t.name;
    },
    getValue: (t) => t.name,
    ...extra,
  };
}
