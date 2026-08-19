// docs/specs/plugins/scheduling.md §2.6 (`engine/reschedule.ts`)
/**
 * Status-date rescheduling: repositions the **incomplete part** of the work at or after a status
 * date, based on each task's recorded progress. Pure and headless like the rest of the engine — it
 * reads a `ReadonlyDataView` and returns patches, mutating nothing.
 *
 * Per task, with `p` its progress clamped to `[0, 1]` (an absent or unusable `progress` counts as
 * `0`):
 *
 *  - **Summaries** (tasks with children) are skipped — their dates roll up from their children.
 *  - **Manually scheduled** tasks (`meta.scheduleMode === "manual"`) are skipped.
 *  - **Complete** tasks (`p >= 1`) are skipped — done work is history and never moves.
 *  - **Unstarted** tasks (`p === 0`) that start before the status date move bodily so they start at
 *    the first working instant at or after the status date, keeping their working duration.
 *  - **In-progress** tasks (`0 < p < 1`) keep their start — the completed portion has happened and
 *    stays where it happened — and their end is pushed out so the *remaining* working duration,
 *    `(1 − p) × total working duration`, fits at or after the status date. A task whose end already
 *    leaves room for the remaining work after the status date is untouched.
 *
 * Dependencies stay honored: a candidate that is downstream of another candidate is **not** moved
 * directly. Instead it is left to the ordinary propagation pass, augmented with a status-date floor
 * (`withStatusDateFloor`) so it lands at its dependency-derived position or the status date,
 * whichever is later. Only the *root* candidates (and every in-progress candidate, whose new end is
 * not derivable from links) become patches, and each patched task is a propagation seed. When the
 * caller will run no propagation at all, it asks for a flat plan instead and every candidate is
 * patched directly.
 */
import type { Patch, ReadonlyDataView, Task, TaskId } from "@stargantt/plugin-data-store";
import { addWorkingMs, hasWorkingHours, workingMsBetween } from "@stargantt/sdk";
import { calendarOf, modelFor, nextWorkingTime } from "./engine";
import { outLinks } from "./graph";
import { isManualTask } from "./modes";
import type { ReschedulePlan, SchedulerHooks } from "./types";

const NO_HOOKS: SchedulerHooks = {};

/** The task's progress as a fraction in `[0, 1]`; unusable values count as `0`. */
export function progressOf(task: Readonly<Task>): number {
  const p = task.progress;
  if (typeof p !== "number" || !Number.isFinite(p)) return 0;
  return Math.min(1, Math.max(0, p));
}

/**
 * Plans a reschedule against `statusDate`. Never mutates the view; returns an empty plan when
 * nothing needs to move.
 *
 * With `propagate` true (the normal case) an unstarted candidate reachable through links from
 * another candidate is planned as a floored propagation target rather than a direct patch, so its
 * dependencies keep deciding its exact position. With `propagate` false every candidate becomes a
 * direct patch — the caller will run no follow-on pass that could place the rest.
 */
export function planReschedule(
  view: ReadonlyDataView,
  statusDate: number,
  propagate: boolean,
  hooks: SchedulerHooks = NO_HOOKS,
): ReschedulePlan {
  const candidates = new Map<TaskId, { start: number; end: number; inProgress: boolean }>();
  for (const task of view.byId.values()) {
    const times = rescheduledTimes(view, task, statusDate, hooks);
    if (times === undefined) continue;
    candidates.set(task.id, { ...times, inProgress: progressOf(task) > 0 });
  }

  // A candidate strictly reachable (through link edges) from another candidate follows its
  // dependencies; the walk below marks everything at least one link edge away from any candidate.
  const downstream = new Set<TaskId>();
  if (propagate) {
    const queue: TaskId[] = [...candidates.keys()];
    const seen = new Set<TaskId>(queue);
    for (let head = 0; head < queue.length; head++) {
      for (const link of outLinks(view, queue[head] as TaskId)) {
        downstream.add(link.targetId);
        if (seen.has(link.targetId)) continue;
        seen.add(link.targetId);
        queue.push(link.targetId);
      }
    }
  }

  const plan: ReschedulePlan = { patches: [], floorIds: new Set(), floor: statusDate };
  for (const [id, candidate] of candidates) {
    // In-progress candidates always patch directly: their start-preserving end extension is not
    // derivable from links. Unstarted downstream candidates go to the floored propagation.
    if (!candidate.inProgress && downstream.has(id)) {
      plan.floorIds.add(id);
      continue;
    }
    const task = view.byId.get(id);
    if (task === undefined) continue;
    plan.patches.push({
      op: "task/update",
      id,
      before: { start: task.start, end: task.end },
      after: { start: candidate.start, end: candidate.end },
    });
  }
  return plan;
}

/**
 * Wraps the composed hooks so the follow-on propagation of a reschedule floors the plan's deferred
 * candidates at the status date: each such task lands at its derived position or at the first
 * working instant at or after the floor, whichever is later, shifted bodily so its span is
 * preserved. Tasks outside `ids`, and contributions' own claims that already sit at or after the
 * floor, pass through unchanged.
 */
export function withStatusDateFloor(
  hooks: SchedulerHooks,
  ids: ReadonlySet<TaskId>,
  floor: number,
): SchedulerHooks {
  const wrapped: SchedulerHooks = {
    propagationRule: (task, ruleCtx) => {
      const claimed = hooks.propagationRule?.(task, ruleCtx);
      if (!ids.has(task.id)) return claimed;
      const chosen = claimed ?? ruleCtx.proposed;
      if (chosen.start >= floor) return claimed;
      const shift = floor - chosen.start;
      return { start: chosen.start + shift, end: chosen.end + shift };
    },
  };
  if (hooks.constraintBounds !== undefined) wrapped.constraintBounds = hooks.constraintBounds;
  // The calendar seam is not a contribution and must survive the wrapping unchanged, or the floored
  // run would resolve calendars differently from the pass it augments.
  if (hooks.calendarOf !== undefined) wrapped.calendarOf = hooks.calendarOf;
  return wrapped;
}

/** The ids a reschedule plan's patches touch — the seed set for the follow-on propagation. */
export function rescheduledIds(patches: readonly Patch[]): Set<TaskId> {
  const ids = new Set<TaskId>();
  for (const patch of patches) {
    if (patch.op === "task/update") ids.add(patch.id);
  }
  return ids;
}

function rescheduledTimes(
  view: ReadonlyDataView,
  task: Readonly<Task>,
  statusDate: number,
  hooks: SchedulerHooks,
): { start: number; end: number } | undefined {
  const children = view.children.get(task.id);
  if (children !== undefined && children.length > 0) return undefined;
  if (isManualTask(task)) return undefined;

  const p = progressOf(task);
  if (p >= 1) return undefined;

  const cal = calendarOf(hooks, view, task);

  if (p === 0) {
    // Unstarted work cannot lie in the past: move the whole task to the status date.
    if (task.start >= statusDate) return undefined;
    const start = nextWorkingTime(cal, statusDate);
    const end = modelFor(view, task, hooks).endFor(start);
    if (start === task.start && end === task.end) return undefined;
    return { start, end };
  }

  // In progress: the completed part stays; the remaining part must fit after the status date.
  const remainingStart = nextWorkingTime(cal, statusDate);
  let requiredEnd: number;
  if (cal !== undefined && hasWorkingHours(cal)) {
    const total = workingMsBetween(cal, task.start, task.end);
    requiredEnd = addWorkingMs(cal, remainingStart, total * (1 - p));
  } else {
    requiredEnd = remainingStart + (task.end - task.start) * (1 - p);
  }
  if (requiredEnd <= task.end) return undefined;
  return { start: task.start, end: requiredEnd };
}
