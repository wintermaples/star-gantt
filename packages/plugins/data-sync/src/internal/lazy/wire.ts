// docs/specs/plugins/data-sync.md §3
/**
 * The lazy area: named `LazyLoadAdapter`s behind one registry, `ensureRange` orchestration with
 * dedup/cursor/total bookkeeping (§3.1), stream-change application (§3.2), and viewport following
 * with directional prefetch (§3.3). Every area enters through this `wire.ts`.
 */
import type { PluginContext } from "@stargantt/core";
import type { DataService } from "@stargantt/plugin-data-store";
// Type-only: brings `stargantt.view` / `stargantt.rows`' Services augmentations into this program
// so the `ctx.useOptional(...)` calls below are checked against the real declarations.
import type {} from "@stargantt/plugin-tree-grid";
import type { RowsService } from "@stargantt/plugin-tree-grid";
import type {} from "@stargantt/plugin-view";
import type { ViewService } from "@stargantt/plugin-view";
import type {
  DataSyncConfig,
  EnsureResult,
  LazyArea,
  LazyLoadAdapter,
  LazyLoadAppliedCounts,
  LazySourceRegistry,
  RangeRequest,
  RangeResult,
  StreamChange,
} from "../../types";
import { createPendingCounter, makeFault, onBulkReplacement, ORIGIN_LAZY } from "../transactions";
import type { BulkDetector } from "../transactions";
import { isTaskLike, planChanges, toTask } from "./apply";
import { Pager } from "./pager";
import { prefetchRange, ScrollPredictor } from "./prefetch";

const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_PREFETCH_PAGES = 1;

function isAdapter(value: unknown): value is LazyLoadAdapter {
  return value !== null && typeof value === "object" && typeof (value as LazyLoadAdapter).fetchRange === "function";
}

export interface LazyAreaDeps {
  ctx: PluginContext;
  data: DataService;
  config: NonNullable<DataSyncConfig["lazyLoad"]>;
  /** The plugin-wide (§1) AbortController's signal, shared with the source area. */
  signal: AbortSignal;
  /** The plugin-wide (§1) disposed flag, shared with the source area. */
  isDisposed(): boolean;
  bulk: BulkDetector;
}

export function wireLazy(deps: LazyAreaDeps): LazyArea {
  const { ctx, data, config } = deps;
  const fault = makeFault(ctx);
  const pageSize =
    typeof config.pageSize === "number" && Number.isInteger(config.pageSize) && config.pageSize >= 1
      ? config.pageSize
      : DEFAULT_PAGE_SIZE;

  const registry = new Map<string, LazyLoadAdapter>();
  let activeName: string | undefined;
  const pager = new Pager(pageSize);

  // §1 — the lazy-area async generation counter: bumped on every bookkeeping reset (activate to a
  // different source, reset(), a bulk store replacement). Captured synchronously at `ensureRange`
  // entry, rechecked after every await.
  let generation = 0;
  function bumpGeneration(): void {
    generation += 1;
  }
  function superseded(gen: number): boolean {
    return deps.isDisposed() || gen !== generation;
  }

  function resetBookkeeping(): void {
    pager.clear();
    bumpGeneration();
  }

  // §6.1 — a bulk store replacement resets the paging bookkeeping (the loaded-page map no longer
  // describes the store).
  onBulkReplacement(ctx, data, deps.bulk, resetBookkeeping);

  // §6.2 — the lazy-area slice of the merged `sync/activity` counter: one pending count per
  // `ensureRange` call that actually fetches at least one page.
  const counter = createPendingCounter<"fetchRange">();
  function activity(delta: 1 | -1, source: string): void {
    const pending = delta === 1 ? counter.inc("fetchRange") : counter.dec("fetchRange");
    ctx.emit("sync/activity", { area: "lazy", op: "fetchRange", source, pending });
  }

  function activeAdapter(): { name: string; adapter: LazyLoadAdapter } | undefined {
    if (activeName === undefined) return undefined;
    const adapter = registry.get(activeName);
    return adapter === undefined ? undefined : { name: activeName, adapter };
  }

  /** Applies one usable page reply: adds unknown rows, skips rows the store already holds (§3.1). */
  function applyPage(source: string, page: number, reply: RangeResult): void {
    pager.markLoaded(page, reply);
    let added = 0;
    for (const row of reply.tasks) {
      if (!isTaskLike(row)) continue;
      if (data.getTask(row.id) !== undefined) continue;
      ctx.dispatch("task/add", { task: toTask(row), origin: ORIGIN_LAZY });
      added += 1;
    }
    const total = pager.total();
    ctx.emit("sync/lazyRangeLoaded", {
      source,
      offset: page * pageSize,
      count: added,
      ...(total !== undefined ? { total } : {}),
    });
  }

  async function ensureRange(offset: number, limit: number): Promise<EnsureResult> {
    const active = activeAdapter();
    if (active === undefined) return { ok: false };
    if (deps.isDisposed()) return { ok: false };
    const gen = generation;
    const pages = pager.missing(pager.pagesFor(offset, limit));
    if (pages.length === 0) return { ok: true, pages: 0 };
    activity(1, active.name);
    try {
      let fetched = 0;
      for (const page of pages) {
        if (superseded(gen)) return { ok: false, pages: fetched };
        if (pager.isLoaded(page)) continue;
        pager.markInflight(page);
        const request: RangeRequest = { offset: page * pageSize, limit: pageSize, signal: deps.signal };
        const cursor = pager.cursorFor(page);
        if (cursor !== undefined) request.cursor = cursor;
        let reply: RangeResult;
        try {
          reply = await active.adapter.fetchRange(request);
        } catch (error) {
          if (superseded(gen)) return { ok: false, pages: fetched };
          pager.markFailed(page);
          fault("fetchRange", error);
          return { ok: false, pages: fetched, error };
        }
        if (superseded(gen)) return { ok: false, pages: fetched };
        if (reply === null || typeof reply !== "object" || !Array.isArray(reply.tasks)) {
          pager.markFailed(page);
          const error = new Error("stargantt: data-sync lazy adapter returned no task list");
          fault("fetchRange", error);
          return { ok: false, pages: fetched, error };
        }
        // `reply.tasks` rows are foreign data straight off the wire — a poisoned getter (isTaskLike's
        // field probes, toTask's object spread) can throw; guarded so this facade method still
        // resolves, never rejects (§1 "Error discipline"), which matters doubly here since several
        // call sites (autoLoad, viewport following, prefetch) fire `ensureRange` as `void ensureRange(...)`.
        try {
          applyPage(active.name, page, reply);
        } catch (error) {
          // `applyPage` already called `pager.markLoaded(page, reply)` before the row loop that
          // just threw, so without this the page would stay marked loaded — `isRangeLoaded()`
          // would report `true` for rows that were never added, and a retry would skip it
          // entirely. Un-mark it (consistent with the malformed-reply branch above); a retry is
          // idempotent since page application is add-only.
          pager.markFailed(page);
          fault("fetchRange", error);
          return { ok: false, pages: fetched, error };
        }
        fetched += 1;
      }
      return { ok: true, pages: fetched };
    } finally {
      activity(-1, active.name);
    }
  }

  function applyChanges(changes: readonly StreamChange[]): LazyLoadAppliedCounts {
    const plan = planChanges(changes, (id) => data.getTask(id) !== undefined);
    const applied: LazyLoadAppliedCounts = {
      added: plan.adds.length,
      updated: plan.updates.length,
      removed: plan.removes.length,
    };
    for (const task of plan.adds) ctx.dispatch("task/add", { task, origin: ORIGIN_LAZY });
    for (const update of plan.updates) {
      ctx.dispatch("task/update", { id: update.id, after: update.after, origin: ORIGIN_LAZY });
    }
    if (plan.removes.length > 0) ctx.dispatch("task/remove", { ids: plan.removes, origin: ORIGIN_LAZY });
    if (applied.added + applied.updated + applied.removed > 0) {
      ctx.emit("sync/lazyChangesApplied", { applied });
    }
    return applied;
  }

  function register(name: string, adapter: LazyLoadAdapter): void {
    if (typeof name !== "string" || name === "" || !isAdapter(adapter)) return;
    registry.set(name, adapter);
  }

  function activate(name: string): boolean {
    if (!registry.has(name)) return false;
    if (name !== activeName) {
      activeName = name;
      resetBookkeeping();
    }
    return true;
  }

  const sources: LazySourceRegistry = {
    register,
    names: () => [...registry.keys()],
    activate,
    active: () => activeName,
  };

  const area: LazyArea = {
    sources,
    total: () => pager.total(),
    loadedPages: () => pager.loadedCount(),
    isRangeLoaded: (offset, limit) => pager.isRangeLoaded(offset, limit),
    ensureRange,
    applyChanges,
    reset: resetBookkeeping,
  };

  /* --- config: seed sources + startup activation (unusable values silently ignored) ----------- */
  const configuredSources = config.sources;
  if (configuredSources !== null && typeof configuredSources === "object") {
    for (const [name, adapter] of Object.entries(configuredSources)) register(name, adapter);
  }
  if (typeof config.active === "string") activate(config.active);

  /* --- autoLoad (deferred to lifecycle/ready — Config table recorded resolution) -------------- */
  if (config.autoLoad === true) {
    ctx.on("lifecycle/ready", () => {
      if (activeAdapter() !== undefined) void ensureRange(0, pageSize);
    });
  }

  /* --- §3.3 viewport following + prefetch (opt-in, both optional services resolved late) ------ */
  if (config.followViewport === true) {
    ctx.on("lifecycle/ready", () => {
      const view: ViewService | undefined = ctx.useOptional("stargantt.view");
      const rows: RowsService | undefined = ctx.useOptional("stargantt.rows");
      if (view === undefined || rows === undefined) return;
      const prefetchPages =
        typeof config.prefetchPages === "number" && Number.isFinite(config.prefetchPages) && config.prefetchPages >= 0
          ? Math.trunc(config.prefetchPages)
          : DEFAULT_PREFETCH_PAGES;
      const predictor = new ScrollPredictor();
      ctx.own(
        ctx.on("view/scrolled", (e) => {
          if (activeAdapter() === undefined) return;
          const first = rows.rowAtY(e.scrollTop);
          const last = rows.rowAtY(e.scrollTop + view.viewport.get().height);
          const pastEdge = last >= rows.rowCount() - 1 ? pageSize : 0;
          void ensureRange(first, last - first + 1 + pastEdge);
          const predictedTop = predictor.sample({ timeMs: Date.now(), scrollTop: e.scrollTop });
          if (predictedTop === undefined) return;
          const height = view.viewport.get().height;
          const rowsPerPx = height > 0 ? (last - first + 1) / height : 0;
          const deltaRows = Math.round((predictedTop - e.scrollTop) * rowsPerPx);
          const predictedRow = deltaRows > 0 ? last + deltaRows : first + deltaRows;
          const ahead = prefetchRange(first, last, predictedRow, prefetchPages, pageSize);
          if (ahead !== undefined) void ensureRange(ahead.offset, ahead.limit);
        }),
      );
    });
  }

  return area;
}
