// docs/specs/plugins/data-sync.md §1 (source area) / §2
/**
 * The source area: named `DataSourceAdapter`s behind one registry, full snapshots (§2.1), delta
 * sync (§2.2), the pending-change tracker (§2.3), optimistic write-back with rollback (§2.4/§2.5),
 * server-side filter forwarding (§2.6), and the `graphql` config-nest gate (§2.7). Every area
 * enters through this `wire.ts`.
 */
import type { PluginContext } from "@stargantt/core";
import type { DataService, LoadInput } from "@stargantt/plugin-data-store";
// Type-only: brings `stargantt.filter`'s Services augmentation into this program so the
// `ctx.useOptional("stargantt.filter")` call below is checked against the real declaration.
import type {} from "@stargantt/plugin-interaction";
import type { FilterService } from "@stargantt/plugin-interaction";
import type {
  AppliedCounts,
  DataSourceAdapter,
  DataSourceFilter,
  DataSyncConfig,
  DeltaResult,
  FetchResult,
  FlushResult,
  LoadResult,
  PushResult,
  RollbackResult,
  SourceRegistry,
  SyncResult,
} from "../../types";
import {
  createPendingCounter,
  isMachineOrigin,
  makeFault,
  onBulkReplacement,
  ORIGIN_ROLLBACK,
  ORIGIN_SYNC,
} from "../transactions";
import type { BulkDetector } from "../transactions";
import { planDelta } from "../tracker/delta";
import { ChangeTracker } from "../tracker/tracker";
import type { RollbackPlan } from "../tracker/tracker";
import { graphqlAdapter } from "./graphql";

const DEFAULT_FOLLOW_FILTER_DEBOUNCE_MS = 200;

export interface SourceAreaDeps {
  ctx: PluginContext;
  data: DataService;
  config: DataSyncConfig;
  /** The plugin-wide (§1) AbortController's signal, shared with the lazy area. */
  signal: AbortSignal;
  /** The plugin-wide (§1) disposed flag, shared with the lazy area. */
  isDisposed(): boolean;
  bulk: BulkDetector;
}

export interface SourceArea {
  sources: SourceRegistry;
  setFilter(next: DataSourceFilter | null): void;
  filter(): DataSourceFilter | null;
  load(): Promise<LoadResult>;
  sync(): Promise<SyncResult>;
  pending(): { creates: number; updates: number; removes: number };
  flush(): Promise<FlushResult>;
  rollback(): RollbackResult;
}

function isAdapter(value: unknown): value is DataSourceAdapter {
  return value !== null && typeof value === "object" && typeof (value as DataSourceAdapter).fetch === "function";
}

export function wireSource(deps: SourceAreaDeps): SourceArea {
  const { ctx, data, config } = deps;
  const fault = makeFault(ctx);
  const rollbackOnError = config.rollbackOnError !== false;

  const registry = new Map<string, DataSourceAdapter>();
  let activeName: string | undefined;
  let syncToken: string | undefined;
  let filter: DataSourceFilter | null = null;
  const tracker = new ChangeTracker();

  // §1 — the source-area async generation counter: bumped at the entry of every load()/sync()/
  // flush() and on activate() to a *different* source. Captured per call, rechecked after every
  // await; a stale (superseded) resolution bails without touching the store, the sync token, the
  // pending set, or the active-source name.
  let generation = 0;
  function bumpGeneration(): number {
    generation += 1;
    return generation;
  }
  function superseded(gen: number): boolean {
    return deps.isDisposed() || gen !== generation;
  }

  // §2.3 — the tracker records every non-machine-origin transaction's task-domain patches.
  ctx.own(
    ctx.on("data/didApplyTransaction", (e) => {
      if (isMachineOrigin(e.transaction.origin)) return;
      tracker.record(e.transaction.patches);
    }),
  );
  // §6.1 / §2.3 — a bulk replacement (any no-transaction `data.tasks` notification) clears the
  // pending set: the shared detector, not an ad hoc call from each load path, is the one source of
  // this rule (also feeds the lazy area's bookkeeping reset — see `internal/lazy/wire.ts`).
  onBulkReplacement(ctx, data, deps.bulk, () => tracker.clear());

  // §6.2 — the source-area slice of the merged `sync/activity` counter.
  const counter = createPendingCounter<"load" | "sync" | "flush">();
  function activity(op: "load" | "sync" | "flush", delta: 1 | -1, source: string): void {
    const pending = delta === 1 ? counter.inc(op) : counter.dec(op);
    ctx.emit("sync/activity", { area: "source", op, source, pending });
  }

  function activeAdapter(): { name: string; adapter: DataSourceAdapter } | undefined {
    if (activeName === undefined) return undefined;
    const adapter = registry.get(activeName);
    return adapter === undefined ? undefined : { name: activeName, adapter };
  }

  // §2.4 — mid-flight edits are never reverted: an id already re-tracked by the time the
  // reversion runs keeps its new pending state instead of being rolled back over it.
  function applyRollback(plan: RollbackPlan): number {
    let count = 0;
    for (const task of plan.adds) {
      if (tracker.has(task.id)) continue;
      ctx.dispatch("task/add", { task, origin: ORIGIN_ROLLBACK });
      count += 1;
    }
    for (const update of plan.updates) {
      if (tracker.has(update.id)) continue;
      ctx.dispatch("task/update", { id: update.id, after: update.after, clears: update.clears, origin: ORIGIN_ROLLBACK });
      count += 1;
    }
    const removeIds = plan.removes.filter((id) => !tracker.has(id));
    if (removeIds.length > 0) {
      ctx.dispatch("task/remove", { ids: removeIds, origin: ORIGIN_ROLLBACK });
      count += removeIds.length;
    }
    return count;
  }

  // §2.1 — shared by `load()` and `sync()`'s no-token/no-delta fallback: `op` names the invoked
  // service operation, not this internal path, so a fallback still counts against "sync".
  async function loadInternal(op: "load" | "sync", gen: number): Promise<LoadResult> {
    const active = activeAdapter();
    if (active === undefined) return { ok: false };
    activity(op, 1, active.name);
    try {
      let result: FetchResult;
      try {
        result = await active.adapter.fetch({ filter: filter ?? undefined, signal: deps.signal });
      } catch (error) {
        if (superseded(gen)) return { ok: false };
        fault("fetch", error);
        return { ok: false, error };
      }
      if (superseded(gen)) return { ok: false };
      if (result === null || typeof result !== "object" || !Array.isArray(result.tasks)) {
        const error = new Error("stargantt: data-sync adapter returned no task list");
        fault("fetch", error);
        return { ok: false, error };
      }
      const input: LoadInput = { tasks: result.tasks };
      if (Array.isArray(result.links)) input.links = result.links;
      if (Array.isArray(result.resources)) input.resources = result.resources;
      if (Array.isArray(result.assignments)) input.assignments = result.assignments;
      // A bulk replacement (§6.1): the tracker/lazy bookkeeping resets synchronously inside this
      // call, through the shared subscription above — not an explicit `tracker.clear()` here.
      // `result.mapping` may carry host-supplied accessor FUNCTIONS (foreign code — data-store
      // `FieldMapping`) that run inside `DataService.load()` and can throw; guarded so this facade
      // method still resolves, never rejects (§1 "Error discipline").
      let loaded: number;
      try {
        data.load(input, result.mapping);
        // The replacement is wholesale, so the resulting size is the number of rows the store
        // actually kept — not `result.tasks.length`, which can overcount unusable rows.
        loaded = data.query().byId.size;
      } catch (error) {
        fault("fetch", error);
        return { ok: false, error };
      }
      syncToken = typeof result.syncToken === "string" ? result.syncToken : undefined;
      ctx.emit("sync/sourceSynced", {
        source: active.name,
        mode: "full",
        applied: { added: loaded, updated: 0, removed: 0 },
      });
      return { ok: true, tasks: loaded };
    } finally {
      activity(op, -1, active.name);
    }
  }

  const load = (): Promise<LoadResult> => loadInternal("load", bumpGeneration());

  async function sync(): Promise<SyncResult> {
    const gen = bumpGeneration();
    const active = activeAdapter();
    if (active === undefined) return { ok: false };
    if (typeof active.adapter.fetchDelta !== "function" || syncToken === undefined) {
      const full = await loadInternal("sync", gen);
      return full.ok
        ? { ok: true, mode: "full" }
        : { ok: false, mode: "full", ...(full.error !== undefined ? { error: full.error } : {}) };
    }
    activity("sync", 1, active.name);
    try {
      let delta: DeltaResult;
      try {
        delta = await active.adapter.fetchDelta({ syncToken, filter: filter ?? undefined, signal: deps.signal });
      } catch (error) {
        if (superseded(gen)) return { ok: false, mode: "delta" };
        fault("fetchDelta", error);
        return { ok: false, mode: "delta", error };
      }
      if (superseded(gen)) return { ok: false, mode: "delta" };
      // `delta.changes[i].task` rows are foreign data straight off the wire — a poisoned getter
      // (planDelta's `isTaskLike` field probes, its per-key property reads) can throw; guarded so
      // this facade method still resolves, never rejects (§1 "Error discipline"). `ctx.dispatch`
      // itself is already fault-barriered by the core (`CommandBusImpl.dispatch`) and cannot
      // propagate, but `planDelta` runs directly over the foreign rows before any dispatch.
      let applied: AppliedCounts;
      try {
        const plan = planDelta(delta?.changes ?? [], data.query());
        applied = {
          added: plan.adds.length,
          updated: plan.updates.length,
          removed: plan.removes.length,
        };
        for (const task of plan.adds) ctx.dispatch("task/add", { task, origin: ORIGIN_SYNC });
        for (const update of plan.updates) {
          ctx.dispatch("task/update", { id: update.id, after: update.after, clears: update.clears, origin: ORIGIN_SYNC });
        }
        if (plan.removes.length > 0) ctx.dispatch("task/remove", { ids: plan.removes, origin: ORIGIN_SYNC });
      } catch (error) {
        fault("fetchDelta", error);
        return { ok: false, mode: "delta", error };
      }
      if (typeof delta?.syncToken === "string") syncToken = delta.syncToken;
      ctx.emit("sync/sourceSynced", { source: active.name, mode: "delta", applied });
      return { ok: true, mode: "delta", applied };
    } finally {
      activity("sync", -1, active.name);
    }
  }

  async function flush(): Promise<FlushResult> {
    const gen = bumpGeneration();
    const active = activeAdapter();
    if (active === undefined || typeof active.adapter.push !== "function") return { ok: false };
    if (tracker.size === 0) return { ok: true, sent: { creates: 0, updates: 0, removes: 0 } };
    const { batch, rollback: plan } = tracker.take();
    const sent = { creates: batch.creates.length, updates: batch.updates.length, removes: batch.removes.length };
    activity("flush", 1, active.name);
    try {
      let result: PushResult | void;
      try {
        result = await active.adapter.push(batch, { signal: deps.signal });
      } catch (error) {
        // A superseded flush (dispose, activate() elsewhere, another flush) drops the taken batch
        // WITHOUT rollback: the superseding operation already established its own baseline (§1).
        if (superseded(gen)) return { ok: false, sent };
        fault("push", error);
        if (!rollbackOnError) return { ok: false, sent, error };
        const tasks = applyRollback(plan);
        ctx.emit("sync/sourceRolledBack", { source: active.name, tasks, cause: "flush" });
        return { ok: false, sent, rolledBack: true, error };
      }
      if (superseded(gen)) return { ok: false, sent };
      if (result !== undefined && result !== null && typeof result.syncToken === "string") {
        syncToken = result.syncToken;
      }
      ctx.emit("sync/sourceFlushed", { source: active.name, sent });
      return { ok: true, sent };
    } finally {
      activity("flush", -1, active.name);
    }
  }

  // §2.5 — the explicit revert. Synchronous, no I/O, no supersede window: `take()` and the
  // reversion run back-to-back on one stack, so `applyRollback`'s mid-flight-skip check can never
  // find a race here — it exists for `flush()`'s async path, and is simply always-false here.
  function rollback(): RollbackResult {
    if (tracker.size === 0) return { ok: true, tasks: 0 };
    const { rollback: plan } = tracker.take();
    const tasks = applyRollback(plan);
    if (tasks > 0) {
      ctx.emit("sync/sourceRolledBack", {
        tasks,
        cause: "api",
        ...(activeName !== undefined ? { source: activeName } : {}),
      });
    }
    return { ok: true, tasks };
  }

  function register(name: string, adapter: DataSourceAdapter): void {
    if (typeof name !== "string" || name === "" || !isAdapter(adapter)) return;
    registry.set(name, adapter);
  }

  function activate(name: string): boolean {
    if (!registry.has(name)) return false;
    if (name !== activeName) {
      bumpGeneration();
      activeName = name;
      syncToken = undefined;
      tracker.clear();
    }
    return true;
  }

  const sources: SourceRegistry = {
    register,
    names: () => [...registry.keys()],
    activate,
    active: () => activeName,
  };

  function setFilter(next: DataSourceFilter | null): void {
    filter = next !== null && typeof next === "object" ? next : null;
  }

  const area: SourceArea = {
    sources,
    setFilter,
    filter: () => filter,
    load,
    sync,
    pending: () => tracker.counts(),
    flush,
    rollback,
  };

  /* --- config: seed sources + startup activation (unusable values silently ignored) ----------- */
  const configuredSources = config.sources;
  if (configuredSources !== null && typeof configuredSources === "object") {
    for (const [name, adapter] of Object.entries(configuredSources)) register(name, adapter);
  }
  if (typeof config.active === "string") activate(config.active);

  /* --- §2.7 — the graphql config-nest gate ------------------------------------------------------ */
  const graphqlConfig = config.graphql;
  if (graphqlConfig !== null && typeof graphqlConfig === "object") {
    const url = typeof graphqlConfig.url === "string" && graphqlConfig.url.trim() !== "" ? graphqlConfig.url : undefined;
    const loadDoc = graphqlConfig.operations?.load;
    if (url !== undefined && typeof loadDoc === "string" && loadDoc.trim() !== "") {
      const name = typeof graphqlConfig.name === "string" && graphqlConfig.name !== "" ? graphqlConfig.name : "graphql";
      register(name, graphqlAdapter(graphqlConfig));
      if (graphqlConfig.activate === true) activate(name);
    }
  }

  /* --- autoLoad (deferred to lifecycle/ready — Config table recorded resolution) -------------- */
  if (config.autoLoad === true) {
    ctx.on("lifecycle/ready", () => {
      if (activeAdapter() !== undefined) void load();
    });
  }

  /* --- §2.6 — server-side filter forwarding (opt-in, deferred to lifecycle/ready) ------------- */
  if (config.followFilter === true) {
    const debounceMs =
      typeof config.followFilterDebounceMs === "number" &&
      Number.isFinite(config.followFilterDebounceMs) &&
      config.followFilterDebounceMs >= 0
        ? config.followFilterDebounceMs
        : DEFAULT_FOLLOW_FILTER_DEBOUNCE_MS;
    // §2.6 — "the single debounce timer is owned once at setup() via ctx.own()": the disposal
    // registration itself happens HERE, synchronously, even though the filter SERVICE is resolved
    // later at `lifecycle/ready` (optional-service timing, never latched at setup — the
    // Dependencies section). Re-arming swaps the timer variable; only the variable's OWNER changes
    // scope, not the disposal registration's timing.
    let timer: ReturnType<typeof setTimeout> | undefined;
    ctx.own({
      dispose: () => {
        if (timer !== undefined) clearTimeout(timer);
      },
    });
    ctx.on("lifecycle/ready", () => {
      const filterService: FilterService | undefined = ctx.useOptional("stargantt.filter");
      if (filterService === undefined) return;
      const reload = (): void => {
        timer = undefined;
        const state = filterService.state.get();
        const query = state.query;
        const criteria = state.criteria;
        setFilter(
          query === "" && criteria === null
            ? null
            : { ...(query === "" ? {} : { query }), ...(criteria === null ? {} : { criteria }) },
        );
        void load();
      };
      // Recorded deviation (§2.6): the trigger is a STORE notification, so this only ever
      // schedules — even at `debounceMs: 0` the reload runs on a later stack via a zero-delay
      // timer, never synchronously off the store's own dispatching stack.
      ctx.own(
        filterService.state.subscribe(() => {
          if (activeAdapter() === undefined) return;
          if (timer !== undefined) clearTimeout(timer);
          timer = setTimeout(reload, debounceMs);
        }),
      );
    });
  }

  return area;
}
