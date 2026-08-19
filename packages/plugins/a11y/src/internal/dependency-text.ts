// docs/specs/plugins/a11y.md § Mirror generation rules — "Dependency read-out".
/**
 * The data half of the dependency read-out: which task names a row's `aria-describedby`
 * description speaks, straight from the data store's per-task link index.
 */
import type { ReadonlyDataView, TaskId } from "@stargantt/plugin-data-store";

/** The named ends of a task's links, for the `rowDependencies` catalog member. */
export interface DependencyParts {
  /** Names of the tasks this task depends on (its in-links' sources), link order. */
  predecessors: string[];
  /** Names of the tasks depending on this task (its out-links' targets), link order. */
  successors: string[];
}

/**
 * The predecessor and successor names of a task, or `undefined` when it has none — including when
 * every linked task is unknown to the store, so a description is never built from nothing.
 */
export function dependencyParts(view: ReadonlyDataView, id: TaskId): DependencyParts | undefined {
  const links = view.linksByTask.get(id);
  if (links === undefined) return undefined;
  const nameOf = (taskId: TaskId): string | undefined => view.byId.get(taskId)?.name;
  const predecessors: string[] = [];
  for (const link of links.in) {
    const name = nameOf(link.sourceId);
    if (name !== undefined) predecessors.push(name);
  }
  const successors: string[] = [];
  for (const link of links.out) {
    const name = nameOf(link.targetId);
    if (name !== undefined) successors.push(name);
  }
  if (predecessors.length === 0 && successors.length === 0) return undefined;
  return { predecessors, successors };
}
