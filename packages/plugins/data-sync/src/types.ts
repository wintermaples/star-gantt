// docs/specs/plugins/data-sync.md §1 / Events / Extension points / Config
/**
 * `@stargantt/plugin-data-sync` — public types.
 *
 * The plugin's single declaration-merging site: `Services` (`stargantt.data-sync`), the ten
 * `sync/*` events and the `storage/snapshot` extension point (§4.3) are declared
 * HERE and nowhere else. Every other file imports its public shapes from this module.
 */
import type { ExtensionPointDecl, Store } from "@stargantt/core";
import type { FieldMapping, Task, TaskId } from "@stargantt/plugin-data-store";

/* ==================================================================== *
 * Source area
 * ==================================================================== */

export interface DataSourceFilter {
  query?: string;
  criteria?: unknown;
}

export interface FetchRequest {
  filter?: DataSourceFilter | undefined;
  /** Aborts the request when the plugin is disposed while it is in flight. */
  signal?: AbortSignal;
}

export interface FetchResult {
  tasks: unknown[];
  links?: unknown[];
  resources?: unknown[];
  assignments?: unknown[];
  mapping?: FieldMapping;
  syncToken?: string;
}

export type DeltaChange = { type: "upsert"; task: Task } | { type: "remove"; id: TaskId };

export interface DeltaRequest {
  syncToken: string;
  filter?: DataSourceFilter | undefined;
  /** Aborts the request when the plugin is disposed while it is in flight. */
  signal?: AbortSignal;
}

export interface DeltaResult {
  changes: DeltaChange[];
  syncToken: string;
}

export interface ChangeBatch {
  creates: Task[];
  updates: { id: TaskId; after: Partial<Task>; clears?: readonly (keyof Task)[] }[];
  removes: TaskId[];
}

export interface PushResult {
  syncToken?: string;
}

export interface DataSourceAdapter {
  fetch(request: FetchRequest): Promise<FetchResult>;
  fetchDelta?(request: DeltaRequest): Promise<DeltaResult>;
  push?(batch: ChangeBatch, request?: { signal?: AbortSignal }): Promise<PushResult | void>;
}

export interface AppliedCounts {
  added: number;
  updated: number;
  removed: number;
}

export interface LoadResult {
  ok: boolean;
  tasks?: number;
  error?: unknown;
}

export interface SyncResult {
  ok: boolean;
  mode?: "delta" | "full";
  applied?: AppliedCounts;
  error?: unknown;
}

export interface FlushResult {
  ok: boolean;
  sent?: { creates: number; updates: number; removes: number };
  rolledBack?: boolean;
  error?: unknown;
}

export interface RollbackResult {
  ok: boolean;
  tasks: number;
}

/* ==================================================================== *
 * Lazy area
 * ==================================================================== */

export type StreamChange = DeltaChange;

/**
 * Not `AppliedCounts` — same field names, distinct type: §3.2's minimal merge makes
 * the two "updated" counts non-interchangeable.
 */
export interface LazyLoadAppliedCounts {
  added: number;
  updated: number;
  removed: number;
}

export interface RangeRequest {
  offset: number;
  limit: number;
  cursor?: string;
  /** Aborted when the plugin is disposed while this page's request is in flight. */
  signal?: AbortSignal;
}

export interface RangeResult {
  tasks: unknown[];
  total?: number;
  cursor?: string;
}

export interface LazyLoadAdapter {
  fetchRange(request: RangeRequest): Promise<RangeResult>;
}

export interface EnsureResult {
  ok: boolean;
  pages?: number;
  error?: unknown;
}

/* ==================================================================== *
 * Offline area
 * ==================================================================== */

export interface OfflineStorageResult {
  ok: boolean;
  tasks?: number;
  error?: unknown;
  restored?: readonly string[];
}

export interface SnapshotContribution {
  id: string;
  capture(): unknown;
  apply(state: unknown): void;
}

export interface PersistedDocument {
  tasks: unknown[];
  links: unknown[];
  resources: unknown[];
  assignments: unknown[];
  calendars: unknown[];
  savedAt: number;
  plugins?: Record<string, unknown>;
}

/* ==================================================================== *
 * Realtime area
 * ==================================================================== */

export type RealtimeChange = DeltaChange;
export type RealtimeMessage = { type: "changes"; changes: RealtimeChange[] } | { type: "resync" };

export interface RealtimeTransportHandlers {
  onOpen(): void;
  onMessage(message: unknown): void;
  onClose(reason?: unknown): void;
  onError(error: unknown): void;
}

export interface RealtimeTransport {
  connect(handlers: RealtimeTransportHandlers): void;
  disconnect(): void;
}

export type RealtimeStatus = "disconnected" | "connecting" | "connected";
export type RealtimeStatusCause = "connect" | "open" | "reconnect" | "close" | "disconnect";

export interface RealtimeApplyResult {
  applied: AppliedCounts;
  resync: boolean;
}

/**
 * The realtime connection state (the store value replacing `status()`/`connectedTransport()`
 * and the abolished `realtime/statusChanged` event).
 */
export interface RealtimeConnection {
  status: RealtimeStatus;
  /**
   * The live (or reconnecting) transport's name; for close/disconnect transitions, the name of
   * the transport that just dropped; absent while durably disconnected.
   */
  transport?: string;
  /** What produced this state (the statusChanged cause); absent only in the initial value. */
  cause?: RealtimeStatusCause;
}

/** Minimal structural view of a WebSocket, so a test double can stand in for the platform global. */
export interface WebSocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  close(): void;
}

/** Minimal structural view of an EventSource, so a test double can stand in for the platform global. */
export interface EventSourceLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  close(): void;
}

/* ==================================================================== *
 * The facade
 * ==================================================================== */

export interface SourceRegistry {
  register(name: string, adapter: DataSourceAdapter): void;
  names(): string[];
  activate(name: string): boolean;
  active(): string | undefined;
}

export interface LazySourceRegistry {
  register(name: string, adapter: LazyLoadAdapter): void;
  names(): string[];
  activate(name: string): boolean;
  active(): string | undefined;
}

export interface TransportRegistry {
  register(name: string, transport: RealtimeTransport): void;
  names(): string[];
}

export interface LazyArea {
  readonly sources: LazySourceRegistry;
  total(): number | undefined;
  loadedPages(): number;
  isRangeLoaded(offset: number, limit: number): boolean;
  ensureRange(offset: number, limit: number): Promise<EnsureResult>;
  applyChanges(changes: readonly StreamChange[]): LazyLoadAppliedCounts;
  reset(): void;
}

export interface OfflineArea {
  save(): Promise<OfflineStorageResult>;
  restore(): Promise<OfflineStorageResult>;
  clear(): Promise<OfflineStorageResult>;
  persisted(): Promise<boolean>;
  available(): boolean;
}

export interface RealtimeArea {
  readonly transports: TransportRegistry;
  connect(name: string): boolean;
  disconnect(): void;
  readonly status: Store<Readonly<RealtimeConnection>>;
  applyMessage(message: unknown): RealtimeApplyResult;
}

export interface DataSyncService {
  // source area
  readonly sources: SourceRegistry;
  setFilter(filter: DataSourceFilter | null): void;
  filter(): DataSourceFilter | null;
  load(): Promise<LoadResult>;
  sync(): Promise<SyncResult>;
  pending(): { creates: number; updates: number; removes: number };
  flush(): Promise<FlushResult>;
  rollback(): RollbackResult;
  // the other three areas
  readonly lazy: LazyArea;
  readonly offline: OfflineArea;
  readonly realtime: RealtimeArea;
}

/* ==================================================================== *
 * Shipped adapter/transport factory configs (hostless)
 * ==================================================================== */

export interface RestAdapterConfig {
  baseUrl?: string;
  endpoints?: { load?: string; delta?: string | null; batch?: string | null };
  headers?: Record<string, string> | (() => Record<string, string>);
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

export type LocalDocument = Partial<Omit<FetchResult, "syncToken">>;

export interface GraphqlOperations {
  load?: string;
  delta?: string;
  push?: string;
}

export interface GraphqlSelect {
  load?: string;
  delta?: string;
  push?: string;
}

export interface GraphqlAdapterConfig {
  url?: string;
  operations?: GraphqlOperations;
  select?: GraphqlSelect;
  headers?: Record<string, string> | (() => Record<string, string>);
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

export interface WebSocketTransportConfig {
  url?: string;
  protocols?: string | string[];
  webSocket?: new (url: string, protocols?: string | string[]) => WebSocketLike;
}

export interface SseTransportConfig {
  url?: string;
  /** Default `"message"`. */
  eventName?: string;
  /** Default `false`. */
  withCredentials?: boolean;
  eventSource?: new (url: string, init?: { withCredentials?: boolean }) => EventSourceLike;
}

/* ==================================================================== *
 * §6.2 — the merged in-flight activity counter
 * ==================================================================== */

export type SyncActivity =
  | { area: "source"; op: "load" | "sync" | "flush"; source: string; pending: number }
  | { area: "lazy"; op: "fetchRange"; source: string; pending: number }
  | { area: "offline"; op: "save" | "restore" | "clear"; cause: "manual" | "auto"; pending: number };

/* ==================================================================== *
 * Config
 * ==================================================================== */

export interface GraphqlSourceConfig extends GraphqlAdapterConfig {
  /** Default `"graphql"`. */
  name?: string;
  /** Default `false`. */
  activate?: boolean;
}

export interface DataSyncConfig {
  sources?: Record<string, DataSourceAdapter>;
  active?: string;
  autoLoad?: boolean;
  rollbackOnError?: boolean;
  followFilter?: boolean;
  followFilterDebounceMs?: number;
  graphql?: GraphqlSourceConfig;
  lazyLoad?: {
    sources?: Record<string, LazyLoadAdapter>;
    active?: string;
    pageSize?: number;
    autoLoad?: boolean;
    followViewport?: boolean;
    prefetchPages?: number;
  };
  offline?: {
    databaseName?: string;
    documentKey?: string;
    autoRestore?: boolean;
    autoSave?: boolean;
    autoSaveDebounceMs?: number;
    registerSource?: boolean;
    sourceName?: string;
    indexedDB?: IDBFactory;
  };
  realtime?: {
    transports?: Record<string, RealtimeTransport>;
    connect?: string;
    autoReconnect?: boolean;
    reconnectDelayMs?: number;
    maxReconnectAttempts?: number;
    resyncViaDataSource?: boolean;
  };
}

/* ==================================================================== *
 * Declaration merging
 * ==================================================================== */

declare module "@stargantt/core" {
  interface Services {
    "stargantt.data-sync": DataSyncService;
  }
  interface Events {
    // §2.1 — after every successful full load(), or a sync() that fell back to one.
    "sync/sourceSynced": { source: string; mode: "full" | "delta"; applied: AppliedCounts };
    // §2.4 — after every successful non-empty flush().
    "sync/sourceFlushed": { source: string; sent: { creates: number; updates: number; removes: number } };
    // §2.4 / §2.5 — after a flush-failure rollback, or a non-empty explicit rollback().
    "sync/sourceRolledBack": { source?: string; tasks: number; cause: "flush" | "api" };
    // §3.1 — once per applied lazy page.
    "sync/lazyRangeLoaded": { source: string; offset: number; count: number; total?: number };
    // §3.2 — after an applyChanges() with any non-zero count.
    "sync/lazyChangesApplied": { applied: LazyLoadAppliedCounts };
    // §4.1 — after every successful save().
    "sync/offlineSaved": { key: string; tasks: number };
    // §4.2 — after every successful restore().
    "sync/offlineRestored": { key: string; tasks: number };
    // §4.1 — after every clear() (no-op deletes included).
    "sync/offlineCleared": { key: string };
    // §5.1 — after every applied changes message (echo messages report zeros).
    "sync/realtimeApplied": { applied: AppliedCounts; transport?: string };
    // §6.2 — the merged in-flight counter, on every pending-count change.
    "sync/activity": SyncActivity;
  }
  interface ExtensionPoints {
    // §4.3 (collect) — a plugin's own state to fold into (and read back out of) offline snapshots.
    "storage/snapshot": ExtensionPointDecl<SnapshotContribution, SnapshotContribution[]>;
  }
}
