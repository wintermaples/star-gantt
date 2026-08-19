// docs/specs/plugins/scheduling.md §2.1 / §2.2 / §2.3 (`engine/engine.ts`)
/**
 * The headless scheduling algorithm: fully independent of UI and unit-testable in plain Node.
 * Nothing in this module imports the DOM, the core, or any rendering plugin; it is a pure function
 * of a `ReadonlyDataView`.
 *
 * Forward pass (`schedule`)
 * -------------------------
 * A differential recomputation that propagates forward through the dependency graph from the
 * points that changed. It walks the link graph in topological order, evaluating constraints, the
 * working calendar and lag/lead to determine each task's placement, and a summary task rolls up
 * `min(start)` / `max(end)` over its children. It never recomputes every task.
 *
 * Concretely the pass:
 *  1. takes the changed ids as **fixed** — they carry the user's edit and are not moved;
 *  2. walks only the forward closure of those ids (link edges + child→parent edges) in topological
 *     order, so nothing outside the affected sub-graph is even visited;
 *  3. places each visited non-seed leaf at its earliest position, and each visited task that *has*
 *     children at `min(child.start)` / `max(child.end)`;
 *  4. runs the back-clamp pass below;
 *  5. returns the differences as `task/update` patches, for the caller to append to the transaction
 *     that caused them.
 *
 * Back-clamp pass
 * ---------------
 * `ALAP` and `FNLT` (and the late side of `SNLT` / `MSO` / `MFO`) are late-side constraints, which
 * a purely forward pass cannot honour. Rather than introduce a backward-pass architecture, a second
 * step walks the same closure in reverse topological order and pulls each late-constrained task
 * **late-ward** to its upper bound. The landing walks *backward* onto working time so the pulled
 * task never finishes past its bound, and a pull that cannot honour the bound is declined. Where an
 * early-side bound conflicts with a late-side one, the early side wins. Any task actually pulled is
 * then treated as fixed and the forward pass is re-run once, so the pull carries through that
 * task's successors and their constraints.
 *
 * Working time
 * ------------
 * A task's duration is **working** time. Against a calendar that declares working hours, moving a
 * task converts between working duration and elapsed time, so a task pushed across a non-working
 * stretch keeps its working duration and grows in elapsed terms. A calendar without working hours
 * keeps day granularity: the duration is elapsed and a non-working day is skipped whole. Every
 * conversion is `sdk/time`'s (§2.2) — this plugin re-implements no calendar arithmetic.
 *
 * Backward pass (`latestTimes`)
 * -----------------------------
 * Exposed so a critical-path consumer can read it. It is a whole-graph pass over link edges only,
 * seeded at the project finish (`max(end)`). Constraints play no part, and the back-clamp pass
 * above is deliberately not coupled to it.
 */
import type {
  CalendarDef,
  Patch,
  ReadonlyDataView,
  Task,
  TaskId,
} from "@stargantt/plugin-data-store";
import {
  MAX_SKIPPED_DAYS,
  MS_DAY,
  addWorkingMs,
  hasWorkingHours,
  isWorkingDay,
  landWorkingEnd,
  nextWorkingStart,
  previousWorkingEnd,
  subtractWorkingMs,
  workingMsBetween,
} from "@stargantt/sdk";
import { applyRule, applyRuleOrUndefined, boundsOf } from "./constraints";
import type { EngineEnv } from "./constraints";
import { forwardClosure, inLinks, outLinks, topoOrder } from "./graph";
import { boundFor, durationOf, elapsedModel, latestEndFor, latestFinishFor } from "./links";
import { isManualTask } from "./modes";
import type { TopoCache } from "./topo-cache";
import type {
  CalendarResolver,
  DurationModel,
  LatestTimes,
  SchedulerHooks,
  Times,
} from "./types";

const NO_HOOKS: SchedulerHooks = {};

/* ------------------------------------------------------------------ *
 * Calendar resolution and the two boundary policies (§2.2)
 * ------------------------------------------------------------------ */

/**
 * The data-store-only resolution: the task's own `calendarId`, looked up in the store's calendar
 * index. This is the engine's default; the root wiring substitutes the registry-aware
 * resolver of §2.2 when the `calendars` nest reflects into scheduling.
 */
export const storeCalendarOf: CalendarResolver = (view, task) => {
  const id = task.calendarId;
  if (id === undefined) return undefined;
  return view.calendars.get(id);
};

/** The resolver a pass runs with: the seam when one is bundled, the store rule otherwise. */
export function calendarOf(
  hooks: SchedulerHooks,
  view: ReadonlyDataView,
  task: Readonly<Task>,
): Readonly<CalendarDef> | undefined {
  return (hooks.calendarOf ?? storeCalendarOf)(view, task);
}

/**
 * The first instant at or after `t` that the task's calendar calls working.
 *
 * A task **without** a calendar is unconstrained, so the instant is returned untouched — the one
 * decision the shared engine deliberately leaves to its callers. Otherwise this is the engine's
 * forward boundary. A calendar that declares no working time at all has nothing to walk to, and the
 * engine's bounded walk returns `t` unmodified rather than looping — a data error made visible in
 * the schedule rather than a scheduling failure.
 */
export function nextWorkingTime(cal: Readonly<CalendarDef> | undefined, t: number): number {
  if (cal === undefined) return t;
  return nextWorkingStart(cal, t);
}

/**
 * The last instant at or before `t` that falls on a working day, the time of day carried along.
 *
 * The back-clamp's day-granularity landing: unlike `sdk/time`'s backward boundary, which lands on
 * the close of a working interval, this keeps `t`'s time of day and only moves it across whole
 * days, which is what a calendar without working windows means by "the day before". Without a
 * calendar the instant is returned untouched, and a calendar whose every day is non-working has
 * nothing to walk to, so the instant is returned unmodified once the shared walk bound is hit.
 */
export function previousWorkingDayTime(
  cal: Readonly<CalendarDef> | undefined,
  t: number,
): number {
  if (cal === undefined) return t;

  let cur = t;
  for (let i = 0; i < MAX_SKIPPED_DAYS; i++) {
    if (isWorkingDay(cal, cur)) return cur;
    cur -= MS_DAY;
  }
  return t;
}

/**
 * How the task's start and end move together: working time against a calendar that declares usable
 * working hours, elapsed time otherwise.
 */
export function modelFor(
  view: ReadonlyDataView,
  task: Readonly<Task>,
  hooks: SchedulerHooks = NO_HOOKS,
): DurationModel {
  const cal = calendarOf(hooks, view, task);
  if (!hasWorkingHours(cal)) return elapsedModel(durationOf(task));

  const calendar = cal as Readonly<CalendarDef>;
  // The task's *working* duration, measured over the span it currently occupies. Placing it
  // elsewhere then spends exactly that much working time again, which is what makes a task pushed
  // across non-working hours grow in elapsed terms without gaining or losing work.
  const working = workingMsBetween(calendar, task.start, task.end);
  return {
    endFor: (start) => addWorkingMs(calendar, start, working),
    startFor: (end) => subtractWorkingMs(calendar, end, working),
  };
}

/* ------------------------------------------------------------------ *
 * Public passes
 * ------------------------------------------------------------------ */

/**
 * Differential forward propagation. `changed` is the set of task ids the caller already changed;
 * their own times are taken as given and everything downstream of them is recomputed.
 *
 * `hooks` carries the composed extension-point contributions and the calendar seam; omitting it
 * schedules with the built-in rules over the store's own calendars, which is what the plain engine
 * tests and any direct caller get.
 */
export function schedule(
  view: ReadonlyDataView,
  changed: ReadonlySet<TaskId>,
  hooks: SchedulerHooks = NO_HOOKS,
  cache?: TopoCache,
): Patch[] {
  const seeds = new Set<TaskId>();
  for (const id of changed) {
    if (view.byId.has(id)) seeds.add(id);
  }
  if (seeds.size === 0) return [];

  /** Recomputed times, by id. Absent = unchanged, so the map doubles as the patch source. */
  const scheduled = new Map<TaskId, Times>();

  const timesOf = (id: TaskId): Times | undefined => {
    const already = scheduled.get(id);
    if (already !== undefined) return already;
    const task = view.byId.get(id);
    return task === undefined ? undefined : { start: task.start, end: task.end };
  };

  const env: EngineEnv = { view, hooks, bounds: new Map() };
  const nodes = forwardClosure(view, seeds);
  const order = cache !== undefined ? cache.order(view, nodes, true) : topoOrder(view, nodes, true);

  forwardPass(env, order, seeds, scheduled, timesOf);

  // The late-side second step. Any task it pulls becomes fixed for a single re-run of the forward
  // pass, which carries the pull through the successors and their own constraints.
  const clamped = backClamp(env, order, seeds, scheduled, timesOf);
  if (clamped.size > 0) {
    const fixed = new Set<TaskId>(seeds);
    for (const id of clamped) fixed.add(id);
    forwardPass(env, order, fixed, scheduled, timesOf);
  }

  const patches: Patch[] = [];
  for (const [id, times] of scheduled) {
    const task = view.byId.get(id);
    if (task === undefined) continue;
    if (task.start === times.start && task.end === times.end) continue;
    patches.push({
      op: "task/update",
      id,
      before: { start: task.start, end: task.end },
      after: { start: times.start, end: times.end },
    });
  }
  return patches;
}

/**
 * Backward pass: the latest start and finish of every task. Sinks are pinned to the project finish,
 * i.e. `max(end)` over all tasks. Cycle members keep their stored dates rather than being omitted
 * (§1.1 — this differs from `sdk/cpm`'s `latestTimes`, which the critical-path analysis reads).
 */
export function latestTimes(
  view: ReadonlyDataView,
  cache?: TopoCache,
): ReadonlyMap<TaskId, LatestTimes> {
  const result = new Map<TaskId, LatestTimes>();
  if (view.byId.size === 0) return result;

  let projectFinish = Number.NEGATIVE_INFINITY;
  for (const task of view.byId.values()) {
    if (task.end > projectFinish) projectFinish = task.end;
  }

  const all = new Set<TaskId>(view.byId.keys());
  const order = cache !== undefined ? cache.order(view, all, false) : topoOrder(view, all, false);

  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i] as TaskId;
    const task = view.byId.get(id);
    if (task === undefined) continue;
    const duration = durationOf(task);

    let latestFinish = Number.POSITIVE_INFINITY;
    for (const link of outLinks(view, id)) {
      const successor = result.get(link.targetId);
      // A successor missing from `result` sits in a link cycle and was dropped by the topo sort;
      // it can impose no bound.
      if (successor === undefined) continue;
      const bound = latestFinishFor(link, duration, successor);
      if (bound < latestFinish) latestFinish = bound;
    }
    if (!Number.isFinite(latestFinish)) latestFinish = projectFinish;
    result.set(id, { latestStart: latestFinish - duration, latestFinish });
  }

  // Cycle members keep their own times rather than being omitted from the map.
  for (const task of view.byId.values()) {
    if (result.has(task.id)) continue;
    result.set(task.id, { latestStart: task.start, latestFinish: task.end });
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Passes
 * ------------------------------------------------------------------ */

type TimesOf = (id: TaskId) => Times | undefined;

/** One forward sweep over `order`, writing into `scheduled`. Ids in `fixed` keep their times. */
function forwardPass(
  env: EngineEnv,
  order: readonly TaskId[],
  fixed: ReadonlySet<TaskId>,
  scheduled: Map<TaskId, Times>,
  timesOf: TimesOf,
): void {
  for (const id of order) {
    const task = env.view.byId.get(id);
    if (task === undefined) continue;
    // §2.4 — a manually scheduled task is never moved by the engine; it keeps its dates and acts
    // purely as a fixed predecessor (and, for a manual summary, keeps its own dates instead of
    // rolling up).
    if (isManualTask(task)) continue;

    const rolled = rollUp(env.view, id, timesOf);
    if (rolled !== undefined) {
      // A summary's times are derived from its children even when it is itself a seed.
      scheduled.set(id, applyRule(env, task, rolled));
      continue;
    }
    if (fixed.has(id)) continue;

    const placed = derive(env, task, timesOf);
    if (placed === undefined) continue;
    scheduled.set(id, placed);
  }
}

/**
 * The late-side second step. Returns the ids it actually pulled later, which the caller re-runs the
 * forward pass over.
 */
function backClamp(
  env: EngineEnv,
  order: readonly TaskId[],
  seeds: ReadonlySet<TaskId>,
  scheduled: Map<TaskId, Times>,
  timesOf: TimesOf,
): Set<TaskId> {
  const view = env.view;
  const clamped = new Set<TaskId>();

  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i] as TaskId;
    const task = view.byId.get(id);
    if (task === undefined) continue;
    // A seed carries the user's own edit and is never moved, in this pass as in the forward one; a
    // summary's times come from its children, so pulling it would contradict the roll-up.
    if (seeds.has(id)) continue;
    // §2.4 — manual tasks are never pulled by the back-clamp either.
    if (isManualTask(task)) continue;
    const children = view.children.get(id);
    if (children !== undefined && children.length > 0) continue;

    const current = timesOf(id);
    if (current === undefined) continue;

    const model = modelFor(view, task, env.hooks);
    const upper = upperBound(env, task, model, timesOf);
    if (upper === undefined) continue;
    // Only a late-ward pull: an upper bound at or before where the forward pass placed the task is
    // in conflict with the early side, and the early side wins.
    if (upper <= current.end) continue;

    const cal = calendarOf(env.hooks, view, task);
    // The pull may only land the task's *end* at or before the bound, so the landing walks backward
    // onto working time: at working-hours granularity to the close of the preceding working
    // interval, at day granularity to the nearest earlier working day. Walking forward instead
    // would push the end past the bound the pull exists to honour.
    const landingEnd =
      cal !== undefined && hasWorkingHours(cal) ? previousWorkingEnd(cal, upper) : upper;
    const start =
      cal !== undefined && hasWorkingHours(cal)
        ? model.startFor(landingEnd)
        : previousWorkingDayTime(cal, model.startFor(landingEnd));
    const end = model.endFor(start);
    // A landing that would still finish past the bound, or earlier than the forward pass placed the
    // task, is declined outright and the forward-pass placement stands.
    if (end > upper) continue;
    if (start < current.start) continue;
    if (start === current.start && end === current.end) continue;

    scheduled.set(id, { start, end });
    clamped.add(id);
  }
  return clamped;
}

/** `min(start)` / `max(end)` of the children, or `undefined` when the task has none. */
function rollUp(view: ReadonlyDataView, id: TaskId, timesOf: TimesOf): Times | undefined {
  const children = view.children.get(id);
  if (children === undefined || children.length === 0) return undefined;

  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const child of children) {
    const times = timesOf(child);
    if (times === undefined) continue;
    if (times.start < start) start = times.start;
    if (times.end > end) end = times.end;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  return { start, end };
}

/**
 * Where the task lands, given its incoming links, its early-side constraint bound and its calendar,
 * or `undefined` when it has no incoming link and so nothing to propagate from.
 *
 * The two anchors are kept apart. A start-side bound — `FS` / `SS` predecessors and any
 * `earliestStart` constraint — says the task may not *begin* before an instant; an end-side bound —
 * `FF` / `SF` predecessors — says it may not *finish* before one. The end-anchored placement is
 * taken whenever it begins no earlier than the start-side bound, and the start-anchored one
 * otherwise; because a later start yields a later end, that fallback still finishes after the
 * end-side bound, so it is the "early side wins" rule restated for two anchors.
 */
function derive(env: EngineEnv, task: Readonly<Task>, timesOf: TimesOf): Times | undefined {
  const view = env.view;
  const incoming = inLinks(view, task.id);
  if (incoming.length === 0) return undefined;

  let startBound = Number.NEGATIVE_INFINITY;
  let endBound = Number.NEGATIVE_INFINITY;
  for (const link of incoming) {
    const source = timesOf(link.sourceId);
    if (source === undefined) continue;
    const bound = boundFor(link, source);
    if (bound.anchor === "end") {
      if (bound.time > endBound) endBound = bound.time;
    } else if (bound.time > startBound) startBound = bound.time;
  }

  const model = modelFor(view, task, env.hooks);
  const earliestStart = boundsOf(env, task, model).earliestStart;
  if (earliestStart !== undefined && earliestStart > startBound) startBound = earliestStart;

  const cal = calendarOf(env.hooks, view, task);

  if (Number.isFinite(endBound)) {
    const placed = placeFromEnd(env, task, model, cal, endBound);
    if (!Number.isFinite(startBound) || placed.start >= startBound) return placed;
  }
  if (!Number.isFinite(startBound)) return undefined;
  return placeFromStart(env, task, model, cal, startBound);
}

/** The task placed so it begins at `startBound`, honouring the calendar and any claiming rule. */
function placeFromStart(
  env: EngineEnv,
  task: Readonly<Task>,
  model: DurationModel,
  cal: Readonly<CalendarDef> | undefined,
  startBound: number,
): Times {
  const claimed = applyRuleOrUndefined(
    env,
    task,
    { start: startBound, end: model.endFor(startBound) },
    "start",
  );
  if (claimed !== undefined) {
    // A claimed task keeps the span the rule returned; the early-side clamp and the non-working
    // skip shift it bodily rather than re-deriving its end, so the rule stays authoritative.
    const start = nextWorkingTime(cal, Math.max(claimed.start, startBound));
    return { start, end: claimed.end + (start - claimed.start) };
  }
  const start = nextWorkingTime(cal, startBound);
  return { start, end: model.endFor(start) };
}

/** The task placed so it finishes at `endBound` — the `FF` / `SF` case. */
function placeFromEnd(
  env: EngineEnv,
  task: Readonly<Task>,
  model: DurationModel,
  cal: Readonly<CalendarDef> | undefined,
  endBound: number,
): Times {
  const claimed = applyRuleOrUndefined(
    env,
    task,
    { start: model.startFor(endBound), end: endBound },
    "end",
  );
  if (claimed !== undefined) return claimed;

  if (cal !== undefined && hasWorkingHours(cal)) {
    // The end is landed forward onto working time and the start walked back from it, so the span
    // the next pass measures is the span this one wrote — the placement is its own fixed point.
    const end = landWorkingEnd(cal, endBound);
    return { start: model.startFor(end), end };
  }
  // Day-granular and calendar-less tasks keep an elapsed duration, which does not vary with
  // position: the forward skip off a non-working day is already reproducible.
  const start = nextWorkingTime(cal, model.startFor(endBound));
  return { start, end: model.endFor(start) };
}

/**
 * The latest end the task may take: its own late-side bound, and for `ALAP` the latest its already
 * placed successors permit. `undefined` when nothing bounds it late-ward.
 */
function upperBound(
  env: EngineEnv,
  task: Readonly<Task>,
  model: DurationModel,
  timesOf: TimesOf,
): number | undefined {
  let upper: number | undefined = boundsOf(env, task, model).latestEnd;

  if (task.constraint?.type === "ALAP") {
    // "As late as its successors' constraints permit". With no successor at all nothing bounds the
    // task late-ward, so it keeps the forward pass's placement rather than running off to infinity.
    for (const link of outLinks(env.view, task.id)) {
      const successor = timesOf(link.targetId);
      if (successor === undefined) continue;
      const bound = latestEndFor(link, model, successor);
      if (upper === undefined || bound < upper) upper = bound;
    }
  }
  return upper;
}
