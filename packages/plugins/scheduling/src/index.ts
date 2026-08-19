// docs/specs/plugins/scheduling.md
/**
 * `@stargantt/plugin-scheduling` — plugin id `stargantt.scheduling`, Layer 6.
 *
 * Five feature areas in one package: the headless auto-scheduling engine, dependency links, working
 * calendars, critical-path analysis and the schedule-diagnostics panel. The boundary between them
 * is strict — `engine/` is a headless scheduling engine that never touches the DOM or any UI
 * service (vitest targets it directly in plain Node), and the four `internal/` areas carry the UI.
 *
 * The engine half provides `stargantt.scheduler` with its seven members, the
 * `data/willApplyTransaction` propagation that appends follow-on patches into the *same*
 * transaction, unconditional cycle rejection, the status-date reschedule with its settle-based
 * drop reporting, the two commands, the two extension points, and the two contributions this
 * plugin makes into interaction's `snap/*` points. The four UI areas are cut as `wire*` entry
 * points behind their configuration gates.
 *
 * `setup()` below is wiring only.
 */
import { definePlugin, first } from "@stargantt/core";
import type { Plugin, PluginContext } from "@stargantt/core";
import type { Patch, ReadonlyDataView, Task, TaskId } from "@stargantt/plugin-data-store";
// Type-only: they load the sibling packages' `declare module "@stargantt/core"` augmentations, so
// the `grid/columns` and `snap/*` contributions below are checked against the real key spaces.
// Erased at emit — no runtime dependency is added (both are strictly lower layers in any case).
import type {} from "@stargantt/plugin-tree-grid";
import type {} from "@stargantt/plugin-interaction";
import type {} from "@stargantt/plugin-view";
import type {} from "@stargantt/plugin-task-bars";
import type {} from "@stargantt/plugin-a11y";
import { resolveConfig } from "./config";
import type { SchedulingConfig } from "./config";
import { schedule } from "./engine/engine";
import { detectCycle } from "./engine/graph";
import { SCHEDULE_MODE_META_KEY, scheduleModeOf } from "./engine/modes";
import { EFFORT_MODE_META_KEY, WORK_META_KEY } from "./engine/effort";
import { Projection } from "./engine/projection";
import { planReschedule, withStatusDateFloor } from "./engine/reschedule";
import { walkTransactionPatches } from "./engine/seeds";
import { createSchedulerEngine } from "./engine/service";
import type {
  ConstraintBounds,
  ConstraintRef,
  PlacementAnchor,
  SchedulerHooks,
} from "./engine/types";
import type { SchedulingAreaDeps } from "./internal/areas";
import { createCalendarRegistry, effectiveCalendarResolver } from "./internal/calendars/registry";
import { createWorkingTimeProvider } from "./internal/calendars/working-time-provider";
import { wireCalendars } from "./internal/calendars/wire";
import { wireCriticalPath } from "./internal/critical-path/wire";
import { wireDiagnostics } from "./internal/diagnostics/wire";
import { wireLinks } from "./internal/links/wire";
import { resolveMessages } from "./internal/messages";
import { buildModeColumn } from "./internal/mode-column";

/* ------------------------------------------------------------------ *
 * Public surface
 * ------------------------------------------------------------------ */

export type {
  AutoScheduleConfig,
  CalendarEditorSection,
  CalendarInit,
  CalendarsConfig,
  CriticalPathConfig,
  DependenciesConfig,
  DiagnosticsConfig,
  LinkStyleConfig,
  ResolvedAutoSchedule,
  ResolvedCalendars,
  ResolvedCriticalPath,
  ResolvedDependencies,
  ResolvedDiagnostics,
  ResolvedSchedulingConfig,
  SchedulingConfig,
} from "./config";
export type {
  AssignedParts,
  LinkLineParts,
  PeriodAppliedParts,
  SchedulingMessages,
  WindowParts,
} from "./internal/messages";
export type { CalendarsState } from "./internal/calendars/registry";
export type {
  CalendarExceptionRange,
  CalendarsService,
  RegionCalendarInit,
} from "./internal/calendars/service";
export { regionCalendar } from "./internal/calendars/service";
export type { CriticalPathService } from "./internal/critical-path/service";
export type { SchedulerService } from "./engine/service";
export type { TaskScheduleMode } from "./engine/modes";
export type { EffortMode } from "./engine/effort";
export type {
  CalendarResolver,
  ConstraintBounds,
  ConstraintBoundsContribution,
  DurationModel,
  LatestTimes,
  PlacementAnchor,
  PropagationRuleContribution,
  ReschedulePlan,
  SchedulerHooks,
  Times,
} from "./engine/types";
// §1.2 — the working-time range shape the calendar queries answer with; re-exported so a consumer
// of `CalendarsService` need not also depend on the SDK for the type alone.
export type { TimeRange } from "@stargantt/sdk";
// The plugin's own declaration-merging site (`stargantt.scheduler` / `stargantt.calendars` /
// `stargantt.critical-path`, §1 / §1.2 / §1.3). An `export type {}` rather than `import type {}`:
// with nothing else in this file referencing a named export of `./types`, a plain side-effect
// import is dropped by declaration emission and the augmentation would not reach a downstream
// package that only imports from `@stargantt/plugin-scheduling`'s public entry (verified against
// `dist/index.d.ts`); the re-export form is retained.
export type {} from "./types";

/* ------------------------------------------------------------------ *
 * Plugin
 * ------------------------------------------------------------------ */

const PLUGIN_ID = "stargantt.scheduling";

/** The bag every `task.meta` claim of §15 names. */
const TASK_META_BAG = "task.meta";

function setup(ctx: PluginContext, raw: SchedulingConfig): void {
  const config = resolveConfig(raw);
  const enabled = config.autoSchedule.enabled;

  const data = ctx.use("stargantt.data");

  const reportError = (error: unknown): void => {
    // Function-shaped contributions are invoked by the point-owning plugin, which must guard them
    // and report through `core/pluginError`. The contributor's own id is not observable through
    // the public API, so this plugin is named.
    ctx.emit("core/pluginError", { pluginId: PLUGIN_ID, error });
  };
  const messages = resolveMessages(raw.messages, (messageKey, cause) => {
    ctx.emit("core/pluginError", { pluginId: PLUGIN_ID, error: { messageKey, cause } });
  });

  /* --- claimed `task.meta` keys (§2.4 / §2.5 / §15) --------------------- */

  ctx.claimKey(TASK_META_BAG, SCHEDULE_MODE_META_KEY);
  ctx.claimKey(TASK_META_BAG, EFFORT_MODE_META_KEY);
  ctx.claimKey(TASK_META_BAG, WORK_META_KEY);

  /* --- extension points this plugin owns (§3.1) ------------------------- */

  /** Wraps one contribution so a throw declines the call instead of failing the transaction. */
  function guard<A extends readonly unknown[], R>(
    fn: (...args: A) => R | undefined,
  ): (...args: A) => R | undefined {
    return (...args) => {
      try {
        return fn(...args);
      } catch (error) {
        reportError(error);
        return undefined;
      }
    };
  }

  const boundsPoint = ctx.defineExtensionPoint("schedule/constraintBounds", (inputs) =>
    first<[Readonly<Task>, { view: ReadonlyDataView; constraint: ConstraintRef }], ConstraintBounds>()(
      inputs.map(guard),
    ),
  );
  const rulePoint = ctx.defineExtensionPoint("schedule/propagationRule", (inputs) =>
    first<
      [
        Readonly<Task>,
        {
          view: ReadonlyDataView;
          proposed: { start: number; end: number };
          anchor: PlacementAnchor;
        },
      ],
      { start: number; end: number }
    >()(inputs.map(guard)),
  );

  /* --- the calendar registry and the §2.2 resolution seam --------------- */

  // Seeded from `calendars.calendars` when the nest is present; empty otherwise, which is exactly
  // the no-calendars composition. `wireCalendars` fills the same store when the nest is present.
  const calendars = createCalendarRegistry(config.calendars?.calendars ?? []);

  // Read through `get()` on every call: a contribution registered later must take effect without
  // the engine holding a stale composite.
  const hooks: SchedulerHooks = {
    constraintBounds: (task, boundsCtx) => boundsPoint.get()(task, boundsCtx),
    propagationRule: (task, ruleCtx) => rulePoint.get()(task, ruleCtx),
    calendarOf: effectiveCalendarResolver(calendars, config.calendars?.scheduling ?? true),
  };

  /* --- the engine service (§1.1) ---------------------------------------- */

  const engine = createSchedulerEngine({
    liveView: () => data.query(),
    getTask: (id) => data.getTask(id),
    hooks,
    enabled,
  });
  // One owned disposable resolves every still-pending `scheduleAsync` call with an empty list.
  ctx.own({ dispose: () => engine.dispose() });
  // The engine is published whether or not propagation is enabled, so a host that turned
  // propagation off can still call `schedule()` / `latestTimes()` / `detectCycle()` itself.
  ctx.provide("stargantt.scheduler", engine.service);

  // §2.8 — the topological-order memo is dropped on every data change.
  ctx.own(data.tasks.subscribe(() => engine.invalidateTopo()));

  /* --- the reschedule hand-off and its settle detection (§2.6) ---------- */

  // The command computes the whole patch list, dispatches the first patch as an ordinary
  // `task/update` (which is what creates the transaction) and parks the rest here; the will-hook
  // drains them into that same transaction. Set and cleared synchronously around one dispatch, so
  // no other transaction can ever observe it — a data hand-off, not a re-entrancy flag.
  let pendingReschedule:
    | { patches: Patch[]; floorIds: ReadonlySet<TaskId>; floor: number }
    | undefined;

  // While a `schedule/reschedule` dispatch is in flight, records whether its transaction actually
  // committed. Commitment is observed through the settle signal, which fires exactly once per
  // APPLIED transaction and never for a cancelled or failed one — a strictly sounder edge than
  // a plain change-event flag. Another will-handler cancelling the transaction drops the whole plan;
  // that drop is reported through `core/pluginError` below, never swallowed silently.
  let rescheduleInFlight: { applied: boolean } | undefined;
  ctx.on("data/didApplyTransaction", () => {
    if (rescheduleInFlight !== undefined) rescheduleInFlight.applied = true;
  });

  /* --- the one data hook (§2.1 / §2.5 / §2.6 / §2.7) -------------------- */

  // Kept even when propagation is off, because cycle rejection is a validity guard on the data
  // rather than a schedule derivation and must stay in force either way.
  ctx.on("data/willApplyTransaction", (event) => {
    const { transaction } = event;
    // `origin` decides auto-recalc chaining, and only a direct user edit starts a chain. Scheduler
    // output already carries its derived patches, and a replayed history entry carries the exact
    // patches that were applied when the action first ran — re-deriving over either would
    // overwrite the very state being reproduced.
    if (transaction.origin !== "user") return;

    // A reschedule dispatch parked the rest of its plan; fold the remaining patches into this (its
    // own) transaction before the walk below, so they are cycle-checked, projected and seeded
    // exactly like the dispatched first patch, and floor this run's propagation at the plan's
    // status date for the plan's deferred candidates.
    let floored = hooks;
    if (pendingReschedule !== undefined) {
      for (const patch of pendingReschedule.patches) transaction.patches.push(patch);
      floored = withStatusDateFloor(hooks, pendingReschedule.floorIds, pendingReschedule.floor);
      pendingReschedule = undefined;
    }

    // The store has applied nothing yet, so propagate against the projected result.
    const projection = new Projection(data.query());
    const seeds = new Set<TaskId>();

    // The shared transaction walk: seed, project and classify each patch — appended effort
    // follow-ons included — with the cycle guard rejecting a `link/add` that would close a cycle in
    // the will phase of the add command.
    const completed = walkTransactionPatches(
      transaction.patches,
      projection,
      seeds,
      enabled,
      (view, link) => {
        const chain = detectCycle(view, link);
        if (chain === undefined) return true;
        event.preventDefault();
        ctx.emit("schedule/cycleRejected", { chain });
        return false;
      },
      hooks,
    );
    if (!completed || seeds.size === 0) return;

    // The follow-on patches join the *same* transaction, so one undo reverts the user action and
    // its automatic knock-on together.
    for (const patch of schedule(projection.view, seeds, floored)) {
      transaction.patches.push(patch);
    }
  });

  /* --- commands (§9) ---------------------------------------------------- */

  ctx.registerCommand("schedule/reschedule", (payload) => {
    const statusDate = payload?.statusDate;
    if (typeof statusDate !== "number" || !Number.isFinite(statusDate)) return;
    const plan = planReschedule(data.query(), statusDate, enabled, hooks);
    const head = plan.patches[0];
    if (head === undefined || head.op !== "task/update") return;
    // One dispatch creates the transaction; the will-hook folds the rest of the plan into it, so
    // the whole reschedule (and its propagation) is a single undo step.
    pendingReschedule = {
      patches: plan.patches.slice(1),
      floorIds: plan.floorIds,
      floor: plan.floor,
    };
    const inFlight = { applied: false };
    rescheduleInFlight = inFlight;
    try {
      ctx.dispatch("task/update", { id: head.id, after: head.after });
    } finally {
      // Normally drained by the hook; cleared here too so a transaction cancelled by another
      // handler cannot leak the tail into an unrelated later edit.
      pendingReschedule = undefined;
      rescheduleInFlight = undefined;
    }
    // The dispatch ran to completion but no transaction settled: another will-handler cancelled
    // it, dropping the whole reschedule plan. Report the drop.
    if (!inFlight.applied) {
      ctx.emit("core/pluginError", {
        pluginId: PLUGIN_ID,
        error: new Error(
          `schedule/reschedule: transaction cancelled by another will-handler; ` +
            `the planned ${String(plan.patches.length)} patch(es) were dropped`,
        ),
      });
    }
  });

  ctx.registerCommand("schedule/setTaskMode", (payload) => {
    const mode = payload?.mode;
    if (mode !== "auto" && mode !== "manual") return;
    const task = data.getTask(payload.id);
    if (task === undefined || scheduleModeOf(task) === mode) return;
    const meta: Record<string, unknown> = { ...task.meta };
    if (mode === "manual") meta[SCHEDULE_MODE_META_KEY] = "manual";
    else delete meta[SCHEDULE_MODE_META_KEY];
    // An emptied `meta` is removed via `clears` rather than left as `{}`.
    if (Object.keys(meta).length === 0) {
      ctx.dispatch("task/update", { id: task.id, after: {}, clears: ["meta"] });
    } else {
      ctx.dispatch("task/update", { id: task.id, after: { meta } });
    }
  });

  /* --- the opt-in mode column (§2.4) ------------------------------------ */

  if (config.autoSchedule.modeColumn) ctx.contribute("grid/columns", buildModeColumn(messages));

  /* --- contributions into interaction's points (§4) --------------------- */

  // Both are registered unconditionally at setup; the core buffers them when the interaction
  // plugin is absent or starts later.
  ctx.contribute("snap/workingTime", createWorkingTimeProvider(calendars));
  // §4.2 — a captured constant, so the guard reads no state and cannot throw. Interaction's
  // `pushSuccessors` pass stands down while any guard answers `true`, which is exactly what makes
  // it yield to this engine while propagation is on.
  ctx.contribute("snap/pushGuards", () => enabled);

  /* --- the four internal UI areas ---------------------------------------- */

  const deps: SchedulingAreaDeps = {
    ctx,
    config,
    messages,
    data,
    scheduler: engine.service,
    calendars,
    reportError,
  };
  // §11 presence semantics: the dependencies nest is on by default; the other three areas'
  // SERVICES are provided unconditionally (§1.2 / §1.3) while their nests gate only the visuals /
  // editor / panel each one adds on top — the nest guards live inside each `wire*` function, not
  // here.
  wireLinks(deps);
  wireCalendars(deps);
  wireCriticalPath(deps);
  wireDiagnostics(deps);
}

/**
 * Creates the scheduling plugin: the headless scheduling engine, dependency links, working
 * calendars, critical-path analysis and the diagnostics panel.
 *
 * Configurable plugins are exported as factories because the host passes no per-plugin config to
 * `setup()`: the configuration is closed over here and the produced plugin itself takes `void`.
 */
export function scheduling(config: SchedulingConfig = {}): Plugin<void> {
  // A snapshot, so a later mutation of the caller's object cannot change a running chart.
  const options: SchedulingConfig = { ...config };
  return definePlugin<void>({
    meta: {
      id: PLUGIN_ID,
      // §14 (amended) — `data` (L1) is the only edge this plugin cannot function
      // without; the engine, the commands and every recording path ride it. Every chart-surface
      // edge is OPTIONAL with inert degradation: `view`, `task-bars`, `tree-grid`, `interaction`
      // and `a11y` are resolved via `ctx.useOptional` (some latched at setup, some late/never
      // latched — see each area's own wiring), and each UI area (calendar shading, links,
      // critical-path visuals, the diagnostics panel) stays inert while the engine, the services,
      // the commands and the snap-point contributions keep working. This is what keeps the headless
      // composition (§13: `dataStore() + scheduling()`, no DOM, no chart plugin) valid.
      dependsOn: ["stargantt.data-store"],
      optional: [
        "stargantt.view",
        "stargantt.task-bars",
        "stargantt.tree-grid",
        "stargantt.interaction",
        "stargantt.a11y",
      ],
    },
    setup: (ctx) => setup(ctx, options),
  });
}
