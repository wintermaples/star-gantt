// docs/specs/plugins/tracking.md §2.3, §2.1 — the baseline set (registration order, id
// generation, active pointer) and the actual-dates read/write path (§2.1's `actualStart` /
// `actualEnd` PLAIN top-level `meta` keys — not an object bag):
//   - the store-shaped `BaselinesState` (folds the `baselines/changed` + `baselines/activeChanged`
//     events into one store, per §1.1's doc comment on `BaselinesService.state`);
//   - an injected clock (`deps.now()` rather than `Date.now()`, per `TrackingAreaDeps`);
//   - `buildScalarMetaWrite` (`internal/shared/meta-bag.ts`) for the `setActual` write, since
//     `actualStart`/`actualEnd` are scalar keys, not a bag.
import { createStore } from "@stargantt/core";
import type { PluginContext, Store, WritableStore } from "@stargantt/core";
import type { DataService, Task, TaskId } from "@stargantt/plugin-data-store";
import type {
  ActualDates,
  Baseline,
  BaselineId,
  BaselineInfo,
  BaselineInit,
  BaselineLinkSnapshot,
  BaselinesState,
  BaselineTaskSnapshot,
} from "../../types";
import type { TrackingMessages } from "../messages";
import { buildScalarMetaWrite } from "../shared/meta-bag";

const LINK_TYPES = new Set(["FS", "SS", "FF", "SF"]);

function isBaselineId(v: unknown): v is BaselineId {
  return typeof v === "string" || typeof v === "number";
}

function isTaskId(v: unknown): v is TaskId {
  return typeof v === "string" || typeof v === "number";
}

/** A usable task snapshot, or `undefined` for one that must be dropped (§1.1's `BaselineInit` doc). */
function normalizeTaskSnapshot(raw: unknown): BaselineTaskSnapshot | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const t = raw as Partial<BaselineTaskSnapshot>;
  if (!isTaskId(t.id) || !Number.isFinite(t.start) || !Number.isFinite(t.end)) return undefined;
  const snap: BaselineTaskSnapshot = { id: t.id, start: t.start as number, end: t.end as number };
  if (t.type === "task" || t.type === "summary" || t.type === "milestone") snap.type = t.type;
  return snap;
}

/** A usable link snapshot, or `undefined` for one that must be dropped. */
function normalizeLinkSnapshot(raw: unknown): BaselineLinkSnapshot | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const l = raw as Partial<BaselineLinkSnapshot>;
  if (!isTaskId(l.sourceId) || !isTaskId(l.targetId)) return undefined;
  if (typeof l.type !== "string" || !LINK_TYPES.has(l.type)) return undefined;
  const snap: BaselineLinkSnapshot = {
    sourceId: l.sourceId,
    targetId: l.targetId,
    type: l.type as BaselineLinkSnapshot["type"],
  };
  if (Number.isFinite(l.lag)) snap.lag = l.lag as number;
  return snap;
}

/** Snapshots the current store contents into the shape a baseline keeps. */
export function snapshotProject(
  tasks: Iterable<Readonly<Task>>,
  links: Iterable<{ sourceId: TaskId; targetId: TaskId; type: string; lag?: number }>,
): { tasks: BaselineTaskSnapshot[]; links: BaselineLinkSnapshot[] } {
  const taskSnaps: BaselineTaskSnapshot[] = [];
  for (const task of tasks) {
    const snap = normalizeTaskSnapshot(task);
    if (snap !== undefined) taskSnaps.push(snap);
  }
  const linkSnaps: BaselineLinkSnapshot[] = [];
  for (const link of links) {
    const snap = normalizeLinkSnapshot(link);
    if (snap !== undefined) linkSnaps.push(snap);
  }
  return { tasks: taskSnaps, links: linkSnaps };
}

/**
 * The baseline set of one plugin instance — a hostless registry, unaware of
 * the store/service wrapping constructed around it below.
 */
class BaselineRegistry {
  private readonly byId = new Map<BaselineId, Baseline>();
  private active: BaselineId | undefined;
  private counter = 0;
  /** Monotonic id mint — never derived from `byId.size`, so a removed baseline's id is not reused. */
  private nextId = 0;

  constructor(private readonly defaultName: (ordinal: number) => string) {}

  /**
   * Adds (or, on an id collision, replaces) a baseline. Returns the stored baseline, or
   * `undefined` when the init is unusable (`tasks` not an array).
   */
  define(init: BaselineInit, now: number): Baseline | undefined {
    if (typeof init !== "object" || init === null || !Array.isArray(init.tasks)) return undefined;
    const id = isBaselineId(init.id) ? init.id : this.generateId();
    const tasks = new Map<TaskId, BaselineTaskSnapshot>();
    for (const raw of init.tasks) {
      const snap = normalizeTaskSnapshot(raw);
      if (snap !== undefined) tasks.set(snap.id, snap);
    }
    const links: BaselineLinkSnapshot[] = [];
    if (Array.isArray(init.links)) {
      for (const raw of init.links) {
        const snap = normalizeLinkSnapshot(raw);
        if (snap !== undefined) links.push(snap);
      }
    }
    // The ordinal counter advances only when a default name is actually minted, so generated
    // names stay dense ("Baseline 1", "Baseline 2", …) across explicitly named saves.
    let name: string;
    if (typeof init.name === "string" && init.name !== "") name = init.name;
    else {
      this.counter += 1;
      name = this.defaultName(this.counter);
    }
    const baseline: Baseline = {
      id,
      name,
      capturedAt: Number.isFinite(init.capturedAt) ? (init.capturedAt as number) : now,
      taskCount: tasks.size,
      tasks,
      links,
    };
    // Re-insert so a replacement keeps one entry; ordering moves to the end, which is the
    // registration-order contract for a replacement.
    this.byId.delete(id);
    this.byId.set(id, baseline);
    return baseline;
  }

  private generateId(): BaselineId {
    let id: BaselineId;
    do {
      this.nextId += 1;
      id = `baseline-${this.nextId}`;
    } while (this.byId.has(id));
    return id;
  }

  get(id: BaselineId | undefined): Baseline | undefined {
    return id === undefined ? undefined : this.byId.get(id);
  }

  list(): BaselineInfo[] {
    return [...this.byId.values()].map(({ id, name, capturedAt, taskCount }) => ({
      id,
      name,
      capturedAt,
      taskCount,
    }));
  }

  /** Removes a baseline; returns whether anything changed. Clears the active pointer if needed. */
  remove(id: BaselineId): boolean {
    const removed = this.byId.delete(id);
    if (removed && this.active === id) this.active = undefined;
    return removed;
  }

  activeId(): BaselineId | undefined {
    return this.active;
  }

  /**
   * Activates a baseline (`undefined` deactivates). Unknown ids are a no-op. Returns whether the
   * active pointer changed.
   */
  setActive(id: BaselineId | undefined): boolean {
    if (id !== undefined && !this.byId.has(id)) return false;
    if (this.active === id) return false;
    this.active = id;
    return true;
  }
}

/** The task's `actualStart` / `actualEnd` PLAIN scalar meta keys (§2.1), defensively read. */
export function actualDatesOf(task: Readonly<Task> | undefined): Readonly<ActualDates> | undefined {
  const meta = task?.meta;
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return undefined;
  const bag = meta as Record<string, unknown>;
  const start = bag["actualStart"];
  const end = bag["actualEnd"];
  const result: ActualDates = {};
  if (typeof start === "number" && Number.isFinite(start)) result.start = start;
  if (typeof end === "number" && Number.isFinite(end)) result.end = end;
  return result.start === undefined && result.end === undefined ? undefined : result;
}

/**
 * Whether `updates` (interpreted as `buildScalarMetaWrite` interprets it) actually changes
 * `task.meta` — mirrors the earlier implementation's `touched` tracking so `setActual` never dispatches a no-op
 * `task/update` (a real edit is undoable "one call ⇒ one undo step"; a no-op call must not consume
 * one).
 */
function hasScalarChange(
  task: Readonly<Task>,
  updates: Readonly<Record<string, number | null | undefined>>,
): boolean {
  const meta =
    typeof task.meta === "object" && task.meta !== null && !Array.isArray(task.meta)
      ? (task.meta as Record<string, unknown>)
      : {};
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    if (value === null) {
      if (key in meta) return true;
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value) && meta[key] !== value) return true;
  }
  return false;
}

export interface BaselinesStateDeps {
  ctx: Pick<PluginContext, "dispatch">;
  data: Pick<DataService, "query" | "getTask" | "links">;
  messages: Pick<TrackingMessages, "baselineName">;
  now(): number;
  /** The §5.1 `baselines.baselines` config seed — empty when the nest is dormant. */
  seed: readonly BaselineInit[];
  /** The §5.1 `baselines.active` config seed — `undefined` when the nest is dormant or unset. */
  active: BaselineId | undefined;
  /** Invalidates the chart's main layer — a no-op while no visual is registered. */
  repaint(): void;
}

export interface BaselinesStateApi {
  readonly state: Store<BaselinesState>;
  save(name?: string): BaselineId;
  get(id: BaselineId): Readonly<Baseline> | undefined;
  remove(id: BaselineId): void;
  setActive(id: BaselineId | undefined): void;
  snapshotOf(taskId: TaskId, baselineId?: BaselineId): Readonly<BaselineTaskSnapshot> | undefined;
  actualOf(taskId: TaskId): Readonly<ActualDates> | undefined;
  setActual(taskId: TaskId, actual: { start?: number | null; end?: number | null }): void;
  /** Resolves a baseline by id, defaulting to the active one — shared by variance.ts/cpm.ts/paint.ts. */
  resolveBaseline(baselineId?: BaselineId): Readonly<Baseline> | undefined;
}

/** Builds the baseline set + actuals piece of `BaselinesService`. */
export function createBaselinesState(deps: BaselinesStateDeps): BaselinesStateApi {
  const registry = new BaselineRegistry(deps.messages.baselineName);
  for (const init of deps.seed) registry.define(init, deps.now());
  if (deps.active !== undefined) registry.setActive(deps.active);

  function computeState(): BaselinesState {
    return { baselines: registry.list(), activeId: registry.activeId() };
  }

  const stateStore: WritableStore<BaselinesState> = createStore(computeState());

  function publish(): void {
    stateStore.set(computeState());
  }

  function resolveBaseline(baselineId?: BaselineId): Readonly<Baseline> | undefined {
    return registry.get(baselineId ?? registry.activeId());
  }

  return {
    state: stateStore,
    save(name?: string): BaselineId {
      const view = deps.data.query();
      const links = [...deps.data.links.get().values()];
      const project = snapshotProject(view.byId.values(), links);
      const init: BaselineInit = { tasks: project.tasks, links: project.links };
      if (typeof name === "string" && name !== "") init.name = name;
      // `define` with a usable init (an array `tasks`, guaranteed by construction above) never
      // returns `undefined`.
      const baseline = registry.define(init, deps.now()) as Baseline;
      // `save()` always activates the new baseline (§2.3): a freshly minted id is never already
      // active, so this always moves the pointer.
      registry.setActive(baseline.id);
      publish();
      deps.repaint();
      return baseline.id;
    },
    get(id: BaselineId): Readonly<Baseline> | undefined {
      return isBaselineId(id) ? registry.get(id) : undefined;
    },
    remove(id: BaselineId): void {
      if (!isBaselineId(id)) return;
      if (!registry.remove(id)) return;
      publish();
      deps.repaint();
    },
    setActive(id: BaselineId | undefined): void {
      if (id !== undefined && !isBaselineId(id)) return;
      if (!registry.setActive(id)) return;
      publish();
      deps.repaint();
    },
    snapshotOf(taskId, baselineId) {
      return resolveBaseline(baselineId)?.tasks.get(taskId);
    },
    actualOf(taskId) {
      return actualDatesOf(deps.data.getTask(taskId));
    },
    setActual(taskId, actual): void {
      if (typeof actual !== "object" || actual === null) return;
      const task = deps.data.getTask(taskId);
      if (task === undefined) return;
      const updates = { actualStart: actual.start, actualEnd: actual.end };
      if (!hasScalarChange(task, updates)) return;
      const patch = buildScalarMetaWrite(task, updates);
      deps.ctx.dispatch("task/update", { id: taskId, ...patch });
    },
    resolveBaseline,
  };
}
