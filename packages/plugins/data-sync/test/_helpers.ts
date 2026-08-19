/**
 * Shared test fixtures: task/adapter builders, an in-memory IndexedDB stand-in, and small
 * `stargantt.filter`/`stargantt.view`/`stargantt.rows` service stubs for the optional-service-driven
 * features (§2.6, §3.3).
 */
import { createStore } from "@stargantt/core";
import type { PluginContext } from "@stargantt/core";
import { createTestHost } from "@stargantt/sdk";
import type { TestHost } from "@stargantt/sdk";
import { dataStore } from "@stargantt/plugin-data-store";
import type { Task } from "@stargantt/plugin-data-store";
import type { FilterCriteria, FilterService, FilterState } from "@stargantt/plugin-interaction";
import type { RowsService } from "@stargantt/plugin-tree-grid";
import type { Viewport, ViewService } from "@stargantt/plugin-view";
import { dataSync } from "../src/index";
import type {
  ChangeBatch,
  DataSourceAdapter,
  DataSyncConfig,
  DataSyncService,
  DeltaRequest,
  DeltaResult,
  FetchRequest,
  FetchResult,
  LazyLoadAdapter,
  PushResult,
  RangeRequest,
  RealtimeTransport,
  RealtimeTransportHandlers,
  RangeResult,
} from "../src/index";

export const DAY = 86_400_000;

export function task(id: string, day: number, days: number, extra: Partial<Task> = {}): Task {
  return { id, parentId: null, name: `Task ${id}`, start: day * DAY, end: (day + days) * DAY, ...extra };
}

/* ------------------------------------------------------------------------- *
 * Scripted source/lazy adapters
 * ------------------------------------------------------------------------- */

export interface ScriptedAdapter extends DataSourceAdapter {
  fetchCalls: FetchRequest[];
  deltaCalls: DeltaRequest[];
  pushCalls: ChangeBatch[];
  nextFetch: FetchResult;
  nextDelta: DeltaResult;
  pushError?: unknown;
  nextPush: PushResult;
}

export function scriptedAdapter(options: { delta?: boolean; push?: boolean } = {}): ScriptedAdapter {
  const adapter: ScriptedAdapter = {
    fetchCalls: [],
    deltaCalls: [],
    pushCalls: [],
    nextFetch: { tasks: [] },
    nextDelta: { changes: [], syncToken: "t1" },
    nextPush: {},
    fetch(request) {
      adapter.fetchCalls.push(request);
      return Promise.resolve(adapter.nextFetch);
    },
  };
  if (options.delta !== false) {
    adapter.fetchDelta = (request) => {
      adapter.deltaCalls.push(request);
      return Promise.resolve(adapter.nextDelta);
    };
  }
  if (options.push !== false) {
    adapter.push = (batch) => {
      adapter.pushCalls.push(batch);
      return adapter.pushError !== undefined ? Promise.reject(adapter.pushError) : Promise.resolve(adapter.nextPush);
    };
  }
  return adapter;
}

export interface ScriptedLazyAdapter extends LazyLoadAdapter {
  calls: RangeRequest[];
  /** Keyed by page offset (a multiple of the configured page size). */
  replies: Map<number, RangeResult>;
  errorOnOffset?: number;
}

export function scriptedLazyAdapter(): ScriptedLazyAdapter {
  const adapter: ScriptedLazyAdapter = {
    calls: [],
    replies: new Map(),
    fetchRange(request) {
      adapter.calls.push(request);
      if (adapter.errorOnOffset === request.offset) return Promise.reject(new Error("scripted failure"));
      const reply = adapter.replies.get(request.offset) ?? { tasks: [] };
      return Promise.resolve(reply);
    },
  };
  return adapter;
}

/* ------------------------------------------------------------------------- *
 * Scripted realtime transport
 * ------------------------------------------------------------------------- */

export interface ScriptedTransport extends RealtimeTransport {
  connectCalls: number;
  disconnectCalls: number;
  /** The handlers of the most recent `connect()` (undefined before the first). */
  handlers: RealtimeTransportHandlers | undefined;
  /** When set, `connect` throws this error. */
  connectError?: unknown;
  open(): void;
  push(message: unknown): void;
  close(reason?: unknown): void;
}

export function scriptedTransport(): ScriptedTransport {
  const transport: ScriptedTransport = {
    connectCalls: 0,
    disconnectCalls: 0,
    handlers: undefined,
    connect(handlers) {
      transport.connectCalls += 1;
      if (transport.connectError !== undefined) throw transport.connectError;
      transport.handlers = handlers;
    },
    disconnect() {
      transport.disconnectCalls += 1;
    },
    open: () => transport.handlers?.onOpen(),
    push: (message) => transport.handlers?.onMessage(message),
    close: (reason) => transport.handlers?.onClose(reason),
  };
  return transport;
}

/* ------------------------------------------------------------------------- *
 * In-memory IndexedDB stand-in: just enough of the IDB surface for the plugin's document store
 * (open/upgrade, one object store, get/put/delete).
 * Requests settle on a microtask, mirroring real IDB's async contract.
 * ------------------------------------------------------------------------- */

export interface FakeIdb {
  factory: IDBFactory;
  databases: Map<string, Map<string, Map<string, unknown>>>;
  failWrites: boolean;
  failReads: boolean;
  abortTransactions: boolean;
  blockOpen: boolean;
}

interface FakeRequest {
  result: unknown;
  error: Error | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onupgradeneeded: (() => void) | null;
  onblocked: (() => void) | null;
}

interface FakeTransaction {
  error: Error | null;
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  objectStore(name: string): unknown;
}

function newRequest(): FakeRequest {
  return { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
}

export function fakeIndexedDb(): FakeIdb {
  const idb: FakeIdb = {
    databases: new Map(),
    failWrites: false,
    failReads: false,
    abortTransactions: false,
    blockOpen: false,
    factory: undefined as never,
  };

  const makeDb = (stores: Map<string, Map<string, unknown>>): unknown => ({
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore(name: string) {
      stores.set(name, new Map());
    },
    onversionchange: null as (() => void) | null,
    transaction(name: string) {
      const tx: FakeTransaction = {
        error: null,
        oncomplete: null,
        onerror: null,
        onabort: null,
        objectStore() {
          const rows = stores.get(name);
          if (rows === undefined) throw new Error(`fake-idb: no object store ${name}`);
          const finishTransaction = (requestFailed: boolean, requestError?: Error): void => {
            queueMicrotask(() => {
              if (requestFailed) {
                tx.error = requestError ?? new Error("fake-idb: request failed");
                tx.onerror?.();
                return;
              }
              if (idb.abortTransactions) {
                tx.error = new Error("fake-idb: scripted transaction abort (quota exceeded)");
                tx.onabort?.();
              } else {
                tx.oncomplete?.();
              }
            });
          };
          const runRequest = (run: () => unknown): FakeRequest => {
            const request = newRequest();
            queueMicrotask(() => {
              try {
                request.result = run();
                request.onsuccess?.();
                finishTransaction(false);
              } catch (error) {
                request.error = error instanceof Error ? error : new Error(String(error));
                request.onerror?.();
                finishTransaction(true, request.error);
              }
            });
            return request;
          };
          return {
            get(key: string) {
              return runRequest(() => {
                if (idb.failReads) throw new Error("fake-idb: scripted read failure");
                return rows.get(key);
              });
            },
            put(value: unknown, key: string) {
              return runRequest(() => {
                if (idb.failWrites) throw new Error("fake-idb: scripted write failure");
                rows.set(key, value);
                return key;
              });
            },
            delete(key: string) {
              return runRequest(() => void rows.delete(key));
            },
          };
        },
      };
      return tx;
    },
    close() {},
  });

  idb.factory = {
    open(name: string) {
      const request = newRequest();
      queueMicrotask(() => {
        if (idb.blockOpen) {
          request.onblocked?.();
          return;
        }
        let stores = idb.databases.get(name);
        const isNew = stores === undefined;
        if (stores === undefined) {
          stores = new Map();
          idb.databases.set(name, stores);
        }
        request.result = makeDb(stores);
        if (isNew) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
  return idb;
}

/* ------------------------------------------------------------------------- *
 * `stargantt.filter` stub (§2.6)
 * ------------------------------------------------------------------------- */

export interface FilterStub {
  service: FilterService;
  set(next: { query?: string; criteria?: FilterCriteria | null }): void;
}

export function filterStub(): FilterStub {
  const store = createStore<FilterState>({ query: "", criteria: null, active: false, matchCount: 0 });
  const service: FilterService = {
    state: store,
    setQuery: (text) => store.update((s) => ({ ...s, query: text })),
    setCriteria: (criteria) => store.update((s) => ({ ...s, criteria })),
    clear: () => store.set({ query: "", criteria: null, active: false, matchCount: 0 }),
    isTaskVisible: () => true,
    saveView: () => {},
    applyView: () => false,
    deleteView: () => false,
    viewNames: () => [],
  };
  return {
    service,
    set(next) {
      store.update((s) => ({
        ...s,
        ...(next.query !== undefined ? { query: next.query } : {}),
        ...(next.criteria !== undefined ? { criteria: next.criteria } : {}),
      }));
    },
  };
}

/* ------------------------------------------------------------------------- *
 * `stargantt.view` / `stargantt.rows` stubs (§3.3)
 * ------------------------------------------------------------------------- */

export function viewStub(initial: Viewport): { service: ViewService; setViewport(v: Viewport): void } {
  const store = createStore<Readonly<Viewport>>(initial);
  const service = { viewport: store } as unknown as ViewService;
  return { service, setViewport: (v) => store.set(v) };
}

export function rowsStub(count: number): RowsService {
  return {
    rowCount: () => count,
    taskIdAt: () => undefined,
    rowOf: () => undefined,
    rowHeight: () => 24,
    resolvedHeightOf: () => 24,
    yOf: (row: number) => row * 24,
    // Simple linear mapping: row = floor(y / rowHeight), clamped to [0, count-1].
    rowAtY: (y: number) => Math.min(Math.max(Math.floor(y / 24), 0), Math.max(count - 1, 0)),
    totalHeight: () => count * 24,
  } as unknown as RowsService;
}

/* ------------------------------------------------------------------------- *
 * Boot harness
 * ------------------------------------------------------------------------- */

export interface Collected {
  errors: { pluginId: string; error: unknown }[];
  synced: unknown[];
  flushed: unknown[];
  rolledBack: unknown[];
  lazyRangeLoaded: unknown[];
  lazyChangesApplied: unknown[];
  offlineSaved: unknown[];
  offlineRestored: unknown[];
  offlineCleared: unknown[];
  realtimeApplied: unknown[];
  activity: { area: string; op: string; pending: number }[];
  /**
   * Every collected event's name, in FIRING order, across every event kind — for asserting
   * relative ordering (e.g. "the terminal event precedes the decremented activity event", §6.2).
   */
  sequence: string[];
}

export interface Booted {
  host: TestHost;
  ds: DataSyncService;
  collected: Collected;
  /** Emits an arbitrary event through a harmless driver plugin's real context (for `view/scrolled`). */
  emit<T>(event: string, payload: T): void;
}

export function boot(
  config: DataSyncConfig = {},
  options: {
    services?: Record<string, unknown>;
    /**
     * Extra plugins composed BEFORE `dataSync()` (real provider plugins, e.g. a minimal stand-in
     * for `stargantt.interaction` — use this, not `services`, when a test needs the REAL
     * declared-optional-dependency path: `services` mock injection forcibly hard-`dependsOn`s a
     * synthetic provider for every plugin, which bypasses (and would mask) `meta.optional` bugs).
     */
    extraPlugins?: import("@stargantt/core").AnyPlugin[];
  } = {},
): Booted {
  const collected: Collected = {
    errors: [],
    synced: [],
    flushed: [],
    rolledBack: [],
    lazyRangeLoaded: [],
    lazyChangesApplied: [],
    offlineSaved: [],
    offlineRestored: [],
    offlineCleared: [],
    realtimeApplied: [],
    activity: [],
    sequence: [],
  };
  const DRIVER_ID = "test.driver";
  const driver = {
    meta: { id: DRIVER_ID },
    setup(ctx: PluginContext): void {
      const collect =
        (name: string, list: unknown[]) =>
        (e: unknown): void => {
          list.push(e);
          collected.sequence.push(name);
        };
      ctx.on("core/pluginError", collect("core/pluginError", collected.errors) as never);
      ctx.on("sync/sourceSynced", collect("sync/sourceSynced", collected.synced) as never);
      ctx.on("sync/sourceFlushed", collect("sync/sourceFlushed", collected.flushed) as never);
      ctx.on("sync/sourceRolledBack", collect("sync/sourceRolledBack", collected.rolledBack) as never);
      ctx.on("sync/lazyRangeLoaded", collect("sync/lazyRangeLoaded", collected.lazyRangeLoaded) as never);
      ctx.on("sync/lazyChangesApplied", collect("sync/lazyChangesApplied", collected.lazyChangesApplied) as never);
      ctx.on("sync/offlineSaved", collect("sync/offlineSaved", collected.offlineSaved) as never);
      ctx.on("sync/offlineRestored", collect("sync/offlineRestored", collected.offlineRestored) as never);
      ctx.on("sync/offlineCleared", collect("sync/offlineCleared", collected.offlineCleared) as never);
      ctx.on("sync/realtimeApplied", collect("sync/realtimeApplied", collected.realtimeApplied) as never);
      ctx.on("sync/activity", collect("sync/activity", collected.activity as unknown[]) as never);
    },
  };

  const host = createTestHost({
    plugins: [driver as never, dataStore(), ...(options.extraPlugins ?? []), dataSync(config)],
    ...(options.services !== undefined ? { services: options.services } : {}),
  });

  return {
    host,
    ds: host.host.service("stargantt.data-sync"),
    collected,
    emit(event, payload) {
      (host.ctxOf(DRIVER_ID).emit as (k: string, p: unknown) => void)(event, payload);
    },
  };
}

/** Resolves after the current microtask queue drains (fetch/IDB chains settle on microtasks). */
export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(() => queueMicrotask(() => resolve())));
}
