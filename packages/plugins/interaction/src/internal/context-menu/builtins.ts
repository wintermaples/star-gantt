// docs/specs/plugins/interaction.md §6.5 — the built-in entries: what they are named, when each
// appears or is disabled, and the single command each dispatches.
/**
 * The built-in row actions: insert, duplicate, delete, and the two-step link-creation pair.
 *
 * Pure with respect to the host: everything it needs — the store service, the command dispatcher,
 * the pending-link-source cell — is injected, so the module is testable without a plugin host.
 */
import type { Commands } from "@stargantt/core";
import type { DataService, Task, TaskId } from "@stargantt/plugin-data-store";
import { MS_DAY } from "@stargantt/sdk";
import type { GridCell, TimelineService, Viewport } from "@stargantt/plugin-view";
import type { RowsService } from "@stargantt/plugin-tree-grid";
import type { InteractionMessages } from "../../messages";
import type { ContextMenuItem, ContextMenuTarget } from "./menu";

/** The plugin-local "start link from here" state, shared with the freshness check. */
export interface LinkSourceCell {
  get(): TaskId | undefined;
  set(id: TaskId | undefined): void;
}

export interface BuiltinDeps {
  /** The store service, resolved once at setup; `undefined` disables every built-in entry. */
  data: DataService | undefined;
  messages: InteractionMessages;
  dispatch<K extends keyof Commands>(key: K, payload: Commands[K]): void;
  linkSource: LinkSourceCell;
  // §6.5.1 / what an insert on empty chart space needs to place the new task: which row the press
  // was in, and which date its x stands for. Each is optional, and a missing one only makes the
  // placement coarser.
  /** Row geometry, when `stargantt.tree-grid` is composed. */
  rows?: RowsService | undefined;
  /** The time axis, when `stargantt.view` is composed. */
  scale?: Pick<TimelineService, "xToT" | "gridCellAt"> | undefined;
  /** The chart viewport at menu-open time; the press coordinates are relative to it. */
  viewport?: (() => Readonly<Viewport>) | undefined;
  /** Where an insert puts the new task relative to the task the press identified. */
  insertMode: "child" | "sibling";
}

// §6.5.1 — every insert is one grid cell long, so the new bar lines up with the chart's own grid
// instead of being a one-day sliver at a coarse zoom.
/** The grid cell holding `t`, or `undefined` when `t` or the axis cannot place one. */
function cellAt(deps: BuiltinDeps, t: number): GridCell | undefined {
  if (!Number.isFinite(t)) return undefined;
  return deps.scale?.gridCellAt(t);
}

/** How long an inserted task is when it starts at `t`: one grid cell, or a day without an axis. */
function durationAt(deps: BuiltinDeps, t: number): number {
  const cell = cellAt(deps, t);
  return cell === undefined ? MS_DAY : cell.end - cell.start;
}

// §6.5.1 — the leaf exception to the one-grid-cell rule.
/** Whether the task already has children, i.e. whether an insert under it promotes it. */
function hasChildren(deps: BuiltinDeps, id: TaskId): boolean {
  const children = deps.data?.query().children.get(id);
  return children !== undefined && children.length > 0;
}

/**
 * The span an insert-as-child takes when its new parent is a **leaf**: the parent's own.
 *
 * A leaf becomes a summary the moment it has a child, and a summary's dates roll up from its
 * children, so any other span silently redefines what the parent covers — a one-grid-cell child
 * shrinks a month-long task to a day, and with propagation on drags every successor back with it.
 * A child copying the parent rolls up to exactly the parent's old span, so the insert moves nothing.
 *
 * Returns `undefined` when the rule does not apply — a sibling insert, or a parent that is already
 * a summary and whose span the new child therefore cannot define on its own.
 */
function leafParentSpan(
  deps: BuiltinDeps,
  parent: Readonly<Task>,
): { start: number; end: number } | undefined {
  if (deps.insertMode !== "child") return undefined;
  if (hasChildren(deps, parent.id)) return undefined;
  return { start: parent.start, end: parent.end };
}

/**
 * The task whose row a background press at viewport-local `y` landed in, or `undefined` for a
 * press below the last row (or in a composition with no row model).
 */
function rowTaskAt(deps: BuiltinDeps, y: number): Readonly<Task> | undefined {
  const { rows, data, viewport } = deps;
  if (rows === undefined || data === undefined) return undefined;
  const vp = viewport?.();
  if (vp === undefined) return undefined;
  if (rows.rowCount() === 0) return undefined;
  const contentY = vp.scrollTop + y;
  // `rowAtY` clamps to the last row, so the empty space below the rows has to be excluded here.
  if (!(contentY >= 0) || contentY >= rows.totalHeight()) return undefined;
  const id = rows.taskIdAt(rows.rowAtY(contentY));
  return id === undefined ? undefined : data.getTask(id);
}

// §6.5.1 — an insert on empty chart space is placed where it was asked for: in the row it landed
// in and at the date its x stands for, rather than at the root with the epoch for a start date.
/** The task an insert on empty chart space creates. */
export function backgroundInsertTask(
  deps: BuiltinDeps,
  target: Readonly<ContextMenuTarget>,
): Partial<Task> & { name: string } {
  const { messages, scale, viewport, insertMode } = deps;
  const task: Partial<Task> & { name: string } = { name: messages.newTaskName };

  const vp = viewport?.();
  const cell =
    scale !== undefined && vp !== undefined
      ? cellAt(deps, scale.xToT(vp.scrollLeft + target.x))
      : undefined;
  if (cell !== undefined) {
    // One grid cell, and the new task fills it.
    task.start = cell.start;
    task.end = cell.end;
  }

  const row = rowTaskAt(deps, target.y);
  if (row === undefined) return task;
  // A press inside a task's row belongs to that task: it becomes the new task's parent, or its
  // sibling when the composition asked for `"sibling"`.
  task.parentId = insertMode === "child" ? row.id : row.parentId;
  // The leaf exception outranks the pressed date, and has to: making a leaf a parent hands its
  // dates to its children, so honouring the press here would *move* the row's task to the pressed
  // day rather than add a task inside it. The press still chooses the parent; it cannot choose a
  // span that redefines one.
  const leaf = leafParentSpan(deps, row);
  if (leaf !== undefined) {
    task.start = leaf.start;
    task.end = leaf.end;
    return task;
  }
  // Without a time axis there is no x→time mapping, so the row's own start is the best anchor.
  if (cell === undefined) {
    task.start = row.start;
    task.end = row.start + MS_DAY;
  }
  return task;
}

// §6.5.1 — an insert on a task goes under it by default, and is one grid cell long starting where
// that task starts.
/** The task an insert on a bar, a handle or a grid row creates. */
export function hitInsertTask(
  deps: BuiltinDeps,
  hit: Readonly<Task>,
): Partial<Task> & { name: string } {
  const span = leafParentSpan(deps, hit) ?? {
    start: hit.start,
    end: hit.start + durationAt(deps, hit.start),
  };
  return {
    name: deps.messages.newTaskName,
    parentId: deps.insertMode === "child" ? hit.id : hit.parentId,
    ...span,
  };
}

// §6.5.1 — a child added under a collapsed task would be created where nobody can see it, so the
// insert reveals its parent. `view/rowToggle` is display state: no transaction, no second undo step.
/** Expands the new task's parent when it is a collapsed row, so the insert is visible. */
function revealParent(deps: BuiltinDeps, task: Partial<Task>): void {
  const parentId = task.parentId;
  if (parentId === undefined || parentId === null) return;
  if (deps.rows?.isExpanded(parentId) !== false) return;
  deps.dispatch("view/rowToggle", { id: parentId, expanded: true });
}

/** Dispatches an insert: `task/add`, plus the reveal its parent may need. */
function runInsert(deps: BuiltinDeps, task: Partial<Task> & { name: string }): void {
  deps.dispatch("task/add", { task });
  revealParent(deps, task);
}

// §6.5 — the built-in provider.
/**
 * The built-in menu-entry provider. Answers for a `"bar"`/`"handle"` hit that resolves to a
 * task, for the chart background, and for the grid's blank area; contributes nothing without a
 * store or for any other target.
 */
export function builtinItems(
  deps: BuiltinDeps,
  target: Readonly<ContextMenuTarget>,
): readonly ContextMenuItem[] | undefined {
  const { data, messages, dispatch, linkSource } = deps;
  if (data === undefined) return undefined;

  // While a link source is pending, every menu invocation offers a way to abandon it explicitly;
  // the entry is present only while armed, never merely disabled.
  const armedSource = linkSource.get();
  const cancelLinkItem: ContextMenuItem | undefined =
    armedSource === undefined
      ? undefined
      : {
          id: "cancel-link",
          label: messages.cancelLink,
          separatorBefore: true,
          // Plugin-local state only; no command, no undo step.
          run: () => linkSource.set(undefined),
        };

  // Both background targets answer with a single insert entry (plus the cancel-link entry while
  // one is armed); only what the insert dispatches differs.
  if (target.kind === "background" || target.kind === "gridBackground") {
    const run: ContextMenuItem["run"] =
      target.kind === "background"
        ? // Placed in the row and at the date the press landed on. One command, so one undo step.
          (at) => runInsert(deps, backgroundInsertTask(deps, at))
        : // A grid-pane press carries no time coordinate, so this deliberately skips the placement
          // rules above and dispatches the grid's own insert command instead. The command is
          // guaranteed registered: `grid/backgroundContextMenu` only exists when
          // `stargantt.tree-grid` is composed.
          () => dispatch("view/rowInsert", { name: messages.newTaskName });
    const items: ContextMenuItem[] = [{ id: "insert", label: messages.insertTask, run }];
    if (cancelLinkItem !== undefined) items.push(cancelLinkItem);
    return items;
  }

  // A grid row answers with the same entries its bar does.
  if (target.hitKind !== "bar" && target.hitKind !== "handle" && target.hitKind !== "row") {
    return undefined;
  }
  const task = data.getTask(target.id);
  if (task === undefined) return undefined;

  const sourceUsable =
    armedSource !== undefined && armedSource !== task.id && data.getTask(armedSource) !== undefined;

  const items: ContextMenuItem[] = [
    {
      id: "insert",
      label: messages.insertTask,
      // A child of the hit task by default (a sibling under `insertMode: "sibling"`), starting
      // where that task starts and lasting one grid cell.
      run: () => runInsert(deps, hitInsertTask(deps, task)),
    },
    {
      id: "duplicate",
      label: messages.duplicateTask,
      run: () => dispatch("task/add", { task: copyForDuplicate(task) }),
    },
    {
      id: "delete",
      label: messages.deleteTask,
      run: () => dispatch("task/remove", { ids: [task.id] }),
    },
    {
      id: "link-from",
      label: messages.linkFrom,
      separatorBefore: true,
      // Plugin-local state only; no command, no undo step.
      run: () => linkSource.set(task.id),
    },
    {
      id: "link-to",
      label: messages.linkTo,
      disabled: !sourceUsable,
      run: () => {
        const from = linkSource.get();
        if (from === undefined || from === task.id) return;
        dispatch("link/add", { sourceId: from, targetId: task.id, type: "FS" });
        linkSource.set(undefined);
      },
    },
  ];
  if (cancelLinkItem !== undefined) items.push(cancelLinkItem);
  return items;
}

// §6.5 — the duplicated field set.
/** The fields a duplicate copies: name, parent, dates, progress and type — never id or orderKey. */
function copyForDuplicate(task: Task): Partial<Task> & { name: string } {
  const copy: Partial<Task> & { name: string } = {
    name: task.name,
    parentId: task.parentId,
    start: task.start,
    end: task.end,
  };
  if (task.progress !== undefined) copy.progress = task.progress;
  if (task.type !== undefined) copy.type = task.type;
  return copy;
}
