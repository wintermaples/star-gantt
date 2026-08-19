// docs/specs/plugins/scheduling.md §1.1 / §2.6 / §2.8 (`engine/service.ts`)
/**
 * `SchedulerService` — the seven-member surface of §1.1 — and the assembly that produces it.
 *
 * The assembly is still headless: it takes the live view, the composed hooks and the propagation
 * flag as plain callbacks, so nothing here reaches for a `PluginContext`, a DOM node or a rendering
 * service. The root `index.ts` supplies the callbacks and owns the returned `dispose()` through
 * `ctx.own()`.
 */
import type {
  Link,
  LinkId,
  Patch,
  ReadonlyDataView,
  Task,
  TaskId,
} from "@stargantt/plugin-data-store";
import { latestTimes as latestTimesPass, schedule as schedulePass } from "./engine";
import { detectCycle } from "./graph";
import { scheduleModeOf } from "./modes";
import type { TaskScheduleMode } from "./modes";
import { Projection } from "./projection";
import { planReschedule, withStatusDateFloor } from "./reschedule";
import { walkTransactionPatches } from "./seeds";
import { TopoCache } from "./topo-cache";
import type { SchedulerHooks } from "./types";

/** The service published as `stargantt.scheduler` (§1.1). */
export interface SchedulerService {
  /** Differential forward propagation from the changed set; never a full recompute (§2.1). */
  schedule(view: ReadonlyDataView, changed: ReadonlySet<TaskId>): Patch[];
  /**
   * As `schedule`, deferred off the current frame; identical result over the same inputs. The view
   * stays unchanged until the promise settles. After dispose every still-pending call resolves with
   * `[]`. The deferral timer is owned via `ctx.own()`.
   */
  scheduleAsync(view: ReadonlyDataView, changed: ReadonlySet<TaskId>): Promise<Patch[]>;
  /**
   * Backward pass (latest start/finish per task). Engine-own semantics: cycle members keep their
   * stored dates, unlike `sdk/cpm`'s `latestTimes`, which omits them — the critical-path analysis
   * reads `sdk/cpm`, not this member.
   */
  latestTimes(
    view: ReadonlyDataView,
  ): ReadonlyMap<TaskId, { latestStart: number; latestFinish: number }>;
  /**
   * Cycle detection used in the will phase of `link/add` (§2.7): the link-id chain the candidate
   * would close into a cycle, or `undefined` when it closes none.
   */
  detectCycle(view: ReadonlyDataView, candidate: Link): readonly LinkId[] | undefined;
  /**
   * Dry run of `schedule/reschedule` — the exact patches the command would apply (§2.6). Nothing is
   * applied, dispatched or emitted; unusable status dates return `[]`.
   */
  previewReschedule(statusDate: number): Patch[];
  /** The task's scheduling mode; unknown ids read as `"auto"` (§2.4). */
  taskScheduleMode(id: TaskId): TaskScheduleMode;
  /**
   * Whether this scheduler propagates automatically: exactly the resolved `autoSchedule.enabled`
   * value, constant for the instance lifetime, side-effect-free. Published so other reconcilers can
   * stand down (§4.2).
   */
  propagationEnabled(): boolean;
}

/** What the assembly needs from the composition around it. */
export interface SchedulerEngineDeps {
  /** The store's own (stable) view object — `data.query()`. */
  liveView(): ReadonlyDataView;
  /** Task lookup for `taskScheduleMode` — `data.getTask`. */
  getTask(id: TaskId): Readonly<Task> | undefined;
  /**
   * The composed extension-point contributions plus the calendar seam. Read through on every call,
   * so a contribution registered later takes effect without the engine holding a stale composite.
   */
  hooks: SchedulerHooks;
  /** The resolved `autoSchedule.enabled` value. */
  enabled: boolean;
}

/** The assembled engine: the service plus the two lifecycle handles the root wiring owns. */
export interface SchedulerEngine {
  readonly service: SchedulerService;
  /** Drops the topological memo (§2.8) — called from the `data.tasks` store subscription. */
  invalidateTopo(): void;
  /** Resolves every still-pending `scheduleAsync` call with `[]` and clears its timer. */
  dispose(): void;
}

/** Builds the `stargantt.scheduler` implementation over the supplied composition callbacks. */
export function createSchedulerEngine(deps: SchedulerEngineDeps): SchedulerEngine {
  // §2.8 — the topological-order memo. It is only consulted for passes over the store's own
  // (stable) view object: a caller-supplied foreign view or a per-transaction projection bypasses
  // it, so a hit can never cross two different graphs.
  const topoCache = new TopoCache();
  const cacheFor = (view: ReadonlyDataView): TopoCache | undefined =>
    view === deps.liveView() ? topoCache : undefined;

  const scheduleWithHooks = (view: ReadonlyDataView, changed: ReadonlySet<TaskId>): Patch[] =>
    schedulePass(view, changed, deps.hooks, cacheFor(view));

  // §1.1 — `scheduleAsync` defers off the current frame through one timer per call; `dispose()`
  // resolves every still-pending call with an empty list at teardown.
  const pendingAsync = new Map<ReturnType<typeof setTimeout>, (patches: Patch[]) => void>();

  const service: SchedulerService = {
    schedule: scheduleWithHooks,
    latestTimes: (view) => latestTimesPass(view, cacheFor(view)),
    detectCycle,
    scheduleAsync: (view, changed) =>
      new Promise<Patch[]>((resolve) => {
        const timer = setTimeout(() => {
          pendingAsync.delete(timer);
          resolve(scheduleWithHooks(view, changed));
        }, 0);
        pendingAsync.set(timer, resolve);
      }),
    previewReschedule(statusDate: number): Patch[] {
      // §2.6 — the dry run mirrors the command exactly, against the live view, mutating nothing.
      // `schedule()` itself is already side-effect-free, so the whole preview is.
      if (typeof statusDate !== "number" || !Number.isFinite(statusDate)) return [];
      const plan = planReschedule(deps.liveView(), statusDate, deps.enabled, deps.hooks);
      if (plan.patches.length === 0 || !deps.enabled) return plan.patches;
      // The will-hook's own transaction walk, §2.5 effort follow-ons included — otherwise the
      // preview would miss the meta.work / end follow-on patches the real dispatch appends and stop
      // being the exact patch list §2.6 promises. No link guard: a reschedule plan carries no link
      // patches (see `walkTransactionPatches`).
      const patches = [...plan.patches];
      const projection = new Projection(deps.liveView());
      const seeds = new Set<TaskId>();
      walkTransactionPatches(patches, projection, seeds, true, undefined, deps.hooks);
      const follow = schedulePass(
        projection.view,
        seeds,
        withStatusDateFloor(deps.hooks, plan.floorIds, plan.floor),
      );
      return [...patches, ...follow];
    },
    taskScheduleMode: (id) => scheduleModeOf(deps.getTask(id)),
    // §4.2 — the read-only propagation predicate a co-composed reconciler (interaction's
    // `pushSuccessors` pass, through `snap/pushGuards`) consults to decide whether to stand down.
    // `enabled` is resolved once at setup, so this is a constant for the instance.
    propagationEnabled: () => deps.enabled,
  };

  return {
    service,
    invalidateTopo: () => topoCache.invalidate(),
    dispose(): void {
      for (const [timer, resolve] of pendingAsync) {
        clearTimeout(timer);
        resolve([]);
      }
      pendingAsync.clear();
    },
  };
}
