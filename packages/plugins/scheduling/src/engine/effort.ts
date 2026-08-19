// docs/specs/plugins/scheduling.md §2.5 (`engine/effort.ts`)
/**
 * The effort tri-state (fixed duration / fixed work / fixed units) — MS-Project-style
 * recomputation when a task's duration or its resource assignments change.
 *
 * Everything lives in existing data: the mode is `task.meta.effortMode` (one of the `EffortMode`
 * strings; anything else means no effort accounting for the task) and the task's work is
 * `task.meta.work`, in milliseconds of working time. Units are the sum of the task's assignment
 * `units`. The invariant maintained is `work = duration × units`, with duration measured as
 * working time against a working-hours calendar and elapsed time otherwise:
 *
 *  - **`"fixed-work"`** — an assignment change re-derives the duration (`duration = work / units`)
 *    and moves the task's end accordingly; the work value never changes.
 *  - **`"fixed-duration"`** — an assignment change re-derives the work (`work = duration × units`);
 *    the dates never move.
 *  - **`"fixed-units"`** — a duration change re-derives the work; assignments never change as a
 *    consequence (the engine never edits assignments).
 *
 * A `"fixed-duration"` task whose duration is edited anyway also re-derives its work (the user
 * overrode the fixed side; the invariant is restored through work, never through assignments).
 *
 * Each rule yields at most one follow-on `task/update` patch, appended into the same transaction as
 * the change that triggered it, so one undo reverts both together. A task without a usable mode,
 * without `meta`, with non-positive units (for the division) or with an unusable work value
 * produces nothing — absent data turns the feature off per task.
 */
import type { Patch, ReadonlyDataView, Task, TaskId } from "@stargantt/plugin-data-store";
import { addWorkingMs, hasWorkingHours, workingMsBetween } from "@stargantt/sdk";
import { calendarOf } from "./engine";
import type { SchedulerHooks } from "./types";

/** The three effort-accounting modes a task can declare under `meta.effortMode`. */
export type EffortMode = "fixed-duration" | "fixed-work" | "fixed-units";

/** The `task.meta` key naming the mode. */
export const EFFORT_MODE_META_KEY = "effortMode";
/** The `task.meta` key holding the task's work, in milliseconds of working time. */
export const WORK_META_KEY = "work";

const NO_HOOKS: SchedulerHooks = {};

/** The task's effort mode, or `undefined` when it declares none (or an unusable value). */
export function effortModeOf(task: Readonly<Task> | undefined): EffortMode | undefined {
  const raw = task?.meta?.[EFFORT_MODE_META_KEY];
  return raw === "fixed-duration" || raw === "fixed-work" || raw === "fixed-units"
    ? raw
    : undefined;
}

/** The task's stored work in ms, or `undefined` when absent or unusable. */
export function workOf(task: Readonly<Task> | undefined): number | undefined {
  const raw = task?.meta?.[WORK_META_KEY];
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
}

/** The sum of the task's assignment units, `0` when it has none. */
export function unitsOf(view: ReadonlyDataView, id: TaskId): number {
  let units = 0;
  for (const a of view.assignmentsByTask.get(id) ?? []) units += a.units;
  return units;
}

/**
 * Per-transaction accumulator of assignment unit deltas, keyed by task. One instance is created per
 * transaction walk and threaded through every `effortFollowOn` call in it, so a second assignment
 * patch for the same task computes from the sum the first one already shifted rather than from the
 * stale stored sum.
 */
export type UnitDeltas = Map<TaskId, number>;

/**
 * The unit sum the task will have once the patches walked so far apply. The projection deliberately
 * does not overlay the assignment indexes (the propagation engine never reads them), so the view
 * still shows pre-transaction assignments here; the accumulated deltas of this transaction's
 * assignment patches — the current one included — restore the post-change sum.
 */
function unitsAfter(view: ReadonlyDataView, patch: Patch, deltas: UnitDeltas): number {
  let taskId: TaskId;
  let delta: number;
  switch (patch.op) {
    case "assignment/add":
      taskId = patch.assignment.taskId;
      delta = patch.assignment.units;
      break;
    case "assignment/remove":
      taskId = patch.assignment.taskId;
      delta = -patch.assignment.units;
      break;
    case "assignment/update":
      taskId = patch.taskId;
      delta = patch.after.units - patch.before.units;
      break;
    default:
      return 0;
  }
  const total = (deltas.get(taskId) ?? 0) + delta;
  deltas.set(taskId, total);
  return unitsOf(view, taskId) + total;
}

/** The task's duration in the mode's measure: working time with working hours, elapsed otherwise. */
function durationMeasure(
  view: ReadonlyDataView,
  task: Readonly<Task>,
  hooks: SchedulerHooks,
): number {
  const cal = calendarOf(hooks, view, task);
  if (cal !== undefined && hasWorkingHours(cal)) {
    return workingMsBetween(cal, task.start, task.end);
  }
  return task.end - task.start;
}

/**
 * The follow-on patch one applied patch demands, or `undefined` when it demands none.
 *
 * `view` must already reflect `patch` (the caller projects each patch before classifying it), so
 * the tasks read here carry their post-change values.
 */
export function effortFollowOn(
  view: ReadonlyDataView,
  patch: Patch,
  // One map per transaction walk; the default serves single-patch callers (unit tests).
  deltas: UnitDeltas = new Map(),
  hooks: SchedulerHooks = NO_HOOKS,
): Patch | undefined {
  switch (patch.op) {
    case "assignment/add":
    case "assignment/remove":
      return assignmentsChanged(
        view,
        patch.assignment.taskId,
        unitsAfter(view, patch, deltas),
        hooks,
      );
    case "assignment/update":
      return assignmentsChanged(view, patch.taskId, unitsAfter(view, patch, deltas), hooks);
    case "task/update": {
      // Only a date change is a duration change; meta-only updates (including the ones this module
      // itself produces) trigger nothing, which is what makes the follow-ons terminate.
      if (patch.after.start === undefined && patch.after.end === undefined) return undefined;
      const task = view.byId.get(patch.id);
      if (task === undefined) return undefined;
      const mode = effortModeOf(task);
      if (mode !== "fixed-units" && mode !== "fixed-duration") return undefined;
      return workPatch(view, task, unitsOf(view, task.id), hooks);
    }
    default:
      return undefined;
  }
}

function assignmentsChanged(
  view: ReadonlyDataView,
  id: TaskId,
  units: number,
  hooks: SchedulerHooks,
): Patch | undefined {
  const task = view.byId.get(id);
  if (task === undefined) return undefined;
  switch (effortModeOf(task)) {
    case "fixed-work":
      return durationPatch(view, task, units, hooks);
    case "fixed-duration":
      return workPatch(view, task, units, hooks);
    default:
      return undefined;
  }
}

/** `work = duration × units`, written back to `meta.work` when it differs. */
function workPatch(
  view: ReadonlyDataView,
  task: Readonly<Task>,
  units: number,
  hooks: SchedulerHooks,
): Patch | undefined {
  const meta = task.meta;
  if (meta === undefined) return undefined;
  if (units <= 0) return undefined;
  const work = durationMeasure(view, task, hooks) * units;
  if (meta[WORK_META_KEY] === work) return undefined;
  return {
    op: "task/update",
    id: task.id,
    before: { meta },
    after: { meta: { ...meta, [WORK_META_KEY]: work } },
  };
}

/** `duration = work / units`, expressed by moving the task's end when it differs. */
function durationPatch(
  view: ReadonlyDataView,
  task: Readonly<Task>,
  units: number,
  hooks: SchedulerHooks,
): Patch | undefined {
  const work = workOf(task);
  if (work === undefined) return undefined;
  if (units <= 0) return undefined;
  const duration = work / units;

  const cal = calendarOf(hooks, view, task);
  const end =
    cal !== undefined && hasWorkingHours(cal)
      ? addWorkingMs(cal, task.start, duration)
      : task.start + duration;
  if (end === task.end) return undefined;
  return {
    op: "task/update",
    id: task.id,
    before: { end: task.end },
    after: { end },
  };
}
