// docs/specs/plugins/data-sync.md
/**
 * `@stargantt/plugin-data-sync` — plugin id `stargantt.data-sync`, Layer 8.
 *
 * The complete external-data connectivity set, as a single facade:
 * REST/GraphQL full-snapshot adapters with token-based delta sync and optimistic write-back
 * (§2), lazy paged loading with viewport following and prefetch (§3), IndexedDB offline snapshots
 * (§4), and WebSocket/SSE realtime application with resync delegation (§5). Everything is
 * service-driven and default-off: with no configured or registered source, transport, or offline
 * nest the plugin performs no requests, opens no database, dispatches nothing.
 *
 * This file does the one plugin-wide `AbortController` (§1), the one shared bulk-replacement
 * detector (§6.1, `internal/transactions.ts`), the plain wiring of the four areas, and the facade
 * assembly — the `sources`/`lazy`/`offline`/`realtime` internal calls between areas are plain
 * function references, never a `*Service` type import or a `ctx.use()` lookup between areas
 * (mirroring the tracking plugin's §2.14 fan-in precedent). Every other behavior lives in
 * `internal/{adapters,tracker,lazy,offline,realtime}/`.
 */
import { definePlugin } from "@stargantt/core";
import type { Plugin, PluginContext } from "@stargantt/core";
import type { DataService } from "@stargantt/plugin-data-store";
// Type-only: brings the sibling packages' `declare module "@stargantt/core"` augmentations into
// this program so the optional-service lookups in `internal/adapters/wire.ts` and
// `internal/lazy/wire.ts` are checked against the real declarations. Erased at emit — no runtime
// dependency is added (all three are `devDependencies`, the type-only exemption).
import type {} from "@stargantt/plugin-interaction";
import type {} from "@stargantt/plugin-tree-grid";
import type {} from "@stargantt/plugin-view";
import { graphqlAdapter } from "./internal/adapters/graphql";
import { localAdapter } from "./internal/adapters/local";
import { restAdapter } from "./internal/adapters/rest";
import { wireSource } from "./internal/adapters/wire";
import { wireLazy } from "./internal/lazy/wire";
import { wireOffline } from "./internal/offline/wire";
import { sseTransport } from "./internal/realtime/sse";
import { webSocketTransport } from "./internal/realtime/websocket";
import { wireRealtime } from "./internal/realtime/wire";
import { createBulkDetector, PLUGIN_ID } from "./internal/transactions";
import type { DataSyncConfig, DataSyncService } from "./types";

export { restAdapter, localAdapter, graphqlAdapter, webSocketTransport, sseTransport };
export type {
  AppliedCounts,
  ChangeBatch,
  DataSourceAdapter,
  DataSourceFilter,
  DataSyncConfig,
  DataSyncService,
  DeltaChange,
  DeltaRequest,
  DeltaResult,
  EnsureResult,
  EventSourceLike,
  FetchRequest,
  FetchResult,
  FlushResult,
  GraphqlAdapterConfig,
  GraphqlOperations,
  GraphqlSelect,
  GraphqlSourceConfig,
  LazyArea,
  LazyLoadAdapter,
  LazyLoadAppliedCounts,
  LazySourceRegistry,
  LoadResult,
  LocalDocument,
  OfflineArea,
  OfflineStorageResult,
  PersistedDocument,
  PushResult,
  RangeRequest,
  RangeResult,
  RealtimeApplyResult,
  RealtimeArea,
  RealtimeChange,
  RealtimeConnection,
  RealtimeMessage,
  RealtimeStatus,
  RealtimeStatusCause,
  RealtimeTransport,
  RealtimeTransportHandlers,
  RestAdapterConfig,
  RollbackResult,
  SnapshotContribution,
  SourceRegistry,
  SseTransportConfig,
  StreamChange,
  SyncActivity,
  SyncResult,
  TransportRegistry,
  WebSocketLike,
  WebSocketTransportConfig,
} from "./types";

function setup(ctx: PluginContext, config: DataSyncConfig): void {
  const data: DataService = ctx.use("stargantt.data");

  // §1 — the one plugin-wide `AbortController`: shared by the source and lazy areas, riding on
  // every adapter call each makes. Disposal aborts it, so a request in flight at teardown is
  // signaled and a stale response never reaches the store.
  const abortController = new AbortController();
  let disposed = false;
  ctx.own({
    dispose: () => {
      disposed = true;
      abortController.abort();
    },
  });
  const isDisposed = (): boolean => disposed;

  // §6.1 — the shared bulk-replacement detector: one instance, consumed by the source area's
  // tracker and the lazy area's pager bookkeeping.
  const bulk = createBulkDetector(ctx);

  const sourceArea = wireSource({
    ctx,
    data,
    config,
    signal: abortController.signal,
    isDisposed,
    bulk,
  });

  const lazyArea = wireLazy({
    ctx,
    data,
    config: config.lazyLoad ?? {},
    signal: abortController.signal,
    isDisposed,
    bulk,
  });

  const offlineArea = wireOffline({
    ctx,
    data,
    config: config.offline,
    // §4.4 — the read-only source adapter is registered into the SOURCE area's own registry, a
    // plain internal call between the two already-built areas.
    sources: sourceArea.sources,
  });

  const realtimeArea = wireRealtime({
    ctx,
    data,
    config: config.realtime,
    // §5.4 — resync delegation is a direct internal call into the source area's own `sync()`,
    // never a `ctx.use()` lookup between areas.
    source: { active: sourceArea.sources.active, sync: sourceArea.sync },
  });

  const service: DataSyncService = {
    sources: sourceArea.sources,
    setFilter: sourceArea.setFilter,
    filter: sourceArea.filter,
    load: sourceArea.load,
    sync: sourceArea.sync,
    pending: sourceArea.pending,
    flush: sourceArea.flush,
    rollback: sourceArea.rollback,
    lazy: lazyArea,
    offline: offlineArea,
    realtime: realtimeArea,
  };
  ctx.provide("stargantt.data-sync", service);
}

/**
 * Creates the data-sync plugin: REST/GraphQL/local source adapters with delta sync and
 * write-back, lazy paged loading, IndexedDB offline snapshots, and WebSocket/SSE realtime
 * application — one facade, `stargantt.data-sync`. With no configured or registered source,
 * transport, or offline nest the plugin performs no requests, opens no database, and dispatches
 * nothing.
 */
export function dataSync(config?: DataSyncConfig): Plugin<void> {
  // A snapshot, so a later mutation of the caller's object cannot change a running chart.
  const resolved: DataSyncConfig = config === null || typeof config !== "object" ? {} : { ...config };
  return definePlugin<void>({
    meta: {
      id: PLUGIN_ID,
      // §"Dependencies" — the only edge this plugin cannot function without.
      dependsOn: ["stargantt.data-store"],
      // Soft dependencies (scheduling.md §14 optional-inert pattern): `followFilter` / viewport
      // following activate only when composed, silently inert otherwise. `meta.optional` names
      // PROVIDING PLUGIN ids, not service ids (core's `_declared()` checks `e.provider`, the
      // plugin id `ctx.provide()` was called under — @stargantt/core/src/internal/services.ts) —
      // `stargantt.filter`/`stargantt.rows` are service ids provided by the `stargantt.interaction`
      // / `stargantt.tree-grid` plugins respectively; `stargantt.view`'s plugin id and service id
      // happen to coincide. A service-id entry here would silently never resolve via
      // `ctx.useOptional`, exactly the failure class this distinction guards against.
      optional: ["stargantt.interaction", "stargantt.view", "stargantt.tree-grid"],
    },
    setup: (ctx) => setup(ctx, resolved),
  });
}
