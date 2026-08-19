# Plugin: data-sync (`stargantt.data-sync`)

Package: `@stargantt/plugin-data-sync` — Layer 8.
Status: normative.

## Purpose

The complete external-data connectivity set: REST/GraphQL full-snapshot adapters with token-based delta sync, optimistic write-back with a coalescing change tracker and rollback, lazy loading (fixed-size paging, viewport following, prefetch), IndexedDB offline snapshots with a plugin-state collect point, and WebSocket/SSE realtime application with resync delegation. The five former services are consolidated into one facade, `stargantt.data-sync`. Everything is service-driven and default-off: with no configured or registered source, transport, or offline nest the plugin performs no requests, opens no database, dispatches nothing, and the chart renders byte-identically to a composition without it. The plugin paints nothing, contributes no layer, and emits no user-visible text.

## The `sync/*` event set and the origin vocabulary

The plugin's activity-notification events live in one flat **`sync/`** namespace, one area-prefixed verb per name; the three per-area in-flight counters are one discriminated `sync/activity` event. The full event list is in the Events table below. Realtime connection state is the `realtime.status` store (§5), not an event.

The transaction **origins** follow the custom-origin convention (`"stargantt.<plugin>/<op>"`). Every transaction this plugin dispatches carries one of exactly four origin strings, and the **machine-origin predicate** used throughout the corpus is a prefix test — the origin is a string beginning with `"stargantt.data-sync/"`:

| Flow | Origin |
|---|---|
| Delta application — `sync()` (§2.2) | `"stargantt.data-sync/sync"` |
| Rollback — flush failure or explicit `rollback()` (§2.4, §2.5) | `"stargantt.data-sync/rollback"` |
| Lazy page application and `lazy.applyChanges` (§3) | `"stargantt.data-sync/lazy"` |
| Realtime message application (§5.1) | `"stargantt.data-sync/realtime"` |

Cross-reference (export.md §2.1, the one export surface this vocabulary touches): the read-only veto's built-in exempt set is exactly the prefix rule — *transactions whose `origin` is a string beginning with `stargantt.data-sync/` are exempt*.

The data-store batch-write origin `"stargantt.data-store/setValues"` does **not** match the machine prefix: custom-field batch writes are user-authored edits and are tracked as pending local changes (§2.3) and vetoed by export's read-only mode, both deliberately. Likewise `"import"`, `"msproject"`, `"history"`, `"user"`, and the `"stargantt.portfolio/duplicate#<n>"` family are user-authored for this plugin's purposes.

## 1. Public API

```ts
// packages/plugins/data-sync/src/index.ts (types in src/types.ts)
import type { Plugin, Store } from "@stargantt/core";
import type { FieldMapping, Task, TaskId } from "@stargantt/plugin-data-store";

// --- source area ---
export interface DataSourceFilter { query?: string; criteria?: unknown }
export interface FetchRequest {
  filter?: DataSourceFilter | undefined;
  /** Aborts the request when the plugin is disposed while it is in flight. */
  signal?: AbortSignal;
}
export interface FetchResult {
  tasks: unknown[];
  links?: unknown[]; resources?: unknown[]; assignments?: unknown[];
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
export interface DeltaResult { changes: DeltaChange[]; syncToken: string }
export interface ChangeBatch {
  creates: Task[];
  updates: { id: TaskId; after: Partial<Task>; clears?: readonly (keyof Task)[] }[];
  removes: TaskId[];
}
export interface PushResult { syncToken?: string }
export interface DataSourceAdapter {
  fetch(request: FetchRequest): Promise<FetchResult>;
  fetchDelta?(request: DeltaRequest): Promise<DeltaResult>;
  push?(batch: ChangeBatch, request?: { signal?: AbortSignal }): Promise<PushResult | void>;
}
export interface AppliedCounts { added: number; updated: number; removed: number }
export interface LoadResult { ok: boolean; tasks?: number; error?: unknown }
export interface SyncResult { ok: boolean; mode?: "delta" | "full"; applied?: AppliedCounts; error?: unknown }
export interface FlushResult {
  ok: boolean;
  sent?: { creates: number; updates: number; removes: number };
  rolledBack?: boolean;
  error?: unknown;
}
export interface RollbackResult { ok: boolean; tasks: number }

// --- lazy area ---
export type StreamChange = DeltaChange;
/** Not AppliedCounts — same field names, distinct type: §3.2's minimal merge
 *  makes the two "updated" counts non-interchangeable. */
export interface LazyLoadAppliedCounts { added: number; updated: number; removed: number }
export interface RangeRequest {
  offset: number;
  limit: number;
  cursor?: string;
  /** Aborted when the plugin is disposed while this page's request is in flight. */
  signal?: AbortSignal;
}
export interface RangeResult { tasks: unknown[]; total?: number; cursor?: string }
export interface LazyLoadAdapter { fetchRange(request: RangeRequest): Promise<RangeResult> }
export interface EnsureResult { ok: boolean; pages?: number; error?: unknown }

// --- offline area ---
export interface OfflineStorageResult { ok: boolean; tasks?: number; error?: unknown; restored?: readonly string[] }
export interface SnapshotContribution { id: string; capture(): unknown; apply(state: unknown): void }
export interface PersistedDocument {
  tasks: unknown[]; links: unknown[]; resources: unknown[];
  assignments: unknown[]; calendars: unknown[];
  savedAt: number;
  plugins?: Record<string, unknown>;
}

// --- realtime area ---
export type RealtimeChange = DeltaChange;
export type RealtimeMessage = { type: "changes"; changes: RealtimeChange[] } | { type: "resync" };
export interface RealtimeTransportHandlers {
  onOpen(): void; onMessage(message: unknown): void;
  onClose(reason?: unknown): void; onError(error: unknown): void;
}
export interface RealtimeTransport {
  connect(handlers: RealtimeTransportHandlers): void;
  disconnect(): void;
}
export type RealtimeStatus = "disconnected" | "connecting" | "connected";
export type RealtimeStatusCause = "connect" | "open" | "reconnect" | "close" | "disconnect";
export interface RealtimeApplyResult { applied: AppliedCounts; resync: boolean }
/** The realtime connection state (the `realtime.status` store value). */
export interface RealtimeConnection {
  status: RealtimeStatus;
  /** The live (or reconnecting) transport's name; for close/disconnect transitions, the name of
   *  the transport that just dropped; absent while durably disconnected. */
  transport?: string;
  /** What produced this state; absent only in the initial value. */
  cause?: RealtimeStatusCause;
}

// --- the facade ---
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

export declare function dataSync(config?: DataSyncConfig): Plugin<void>;
```

Facade member count: 11 top-level members (the `sources` registry, 6 source-area methods, `rollback`, and the 3 area objects); `lazy` 7 members, `offline` 5, `realtime` 5.

**Design notes.**

- Registries: sources, lazy sources, and transports are managed through the nested registry objects (`register` / `names` / `activate` / `active`). Unusable arguments are silently ignored (non-string or empty name, adapter without `fetch` / `fetchRange`, transport without `connect` or `disconnect`); a same-named registration replaces the previous entry; registration order is `names()` order.
- `rollback()` exposes the flush-failure reversion path explicitly (§2.5). It performs no I/O — only synchronous store commands — and therefore returns its result directly rather than a promise.
- Realtime connection state is read from the `realtime.status` store; there is deliberately no status method pair and no status event.

**Shipped adapter/transport factories** (hostless, exported from the package, usable in `config.sources` / `config.realtime.transports` or registered at runtime):

```ts
export interface RestAdapterConfig {
  baseUrl?: string;
  endpoints?: { load?: string; delta?: string | null; batch?: string | null };
  headers?: Record<string, string> | (() => Record<string, string>);
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}
export declare function restAdapter(config?: RestAdapterConfig): DataSourceAdapter;

export type LocalDocument = Partial<Omit<FetchResult, "syncToken">>;
export declare function localAdapter(document?: LocalDocument): DataSourceAdapter;

export interface GraphqlOperations { load?: string; delta?: string; push?: string }
export interface GraphqlSelect { load?: string; delta?: string; push?: string }
export interface GraphqlAdapterConfig {
  url?: string;
  operations?: GraphqlOperations;
  select?: GraphqlSelect;
  headers?: Record<string, string> | (() => Record<string, string>);
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}
export declare function graphqlAdapter(config?: GraphqlAdapterConfig): DataSourceAdapter;

export interface WebSocketTransportConfig {
  url?: string;
  protocols?: string | string[];
  webSocket?: new (url: string, protocols?: string | string[]) => WebSocketLike;
}
export declare function webSocketTransport(config?: WebSocketTransportConfig): RealtimeTransport;

export interface SseTransportConfig {
  url?: string;
  eventName?: string;               // default "message"
  withCredentials?: boolean;        // default false
  eventSource?: new (url: string, init?: { withCredentials?: boolean }) => EventSourceLike;
}
export declare function sseTransport(config?: SseTransportConfig): RealtimeTransport;
```

`WebSocketLike` / `EventSourceLike` are the exported minimal structural interfaces over the browser globals, so the constructors are injectable in tests and the package assumes nothing beyond the platform globals.

**Error discipline (uniform, all areas).** Every async facade method resolves — never rejects — with `ok: false` (or `false` for `persisted()`) on failure; an attempted operation that failed additionally carries `error` and is reported through `core/pluginError` with `pluginId: "stargantt.data-sync"`. Adapters, transports, and `storage/snapshot` contributors are foreign code: each call is individually wrapped in an **unlatched** per-call fault barrier (they run per service call or per connection event, not per frame).

**Disposal and cross-call races (normative).** The plugin owns one `AbortController` via `ctx.own()`; disposal aborts it, so requests in flight at teardown are signaled and a stale response never reaches the store. Its signal rides on every source-area adapter call — `fetch` (`FetchRequest.signal`), `fetchDelta` (`DeltaRequest.signal`), `push` (the `request` argument) — and on every lazy page request (`RangeRequest.signal`). An adapter that ignores the signal is still harmless: a `disposed` flag plus per-area async **generation counters** make any stale resolution bail without touching the store, the sync token, the pending set, the paging bookkeeping, or the active-source name. Source area: the generation is bumped at the entry of every `load()` / `sync()` / `flush()` and on `sources.activate` to a *different* source (superseding any load/sync still in flight against the old source), captured per call and rechecked after every `await`. Lazy area: the generation is bumped on every bookkeeping reset (`lazy.sources.activate` to a different source, `reset()`, the §6.1 bulk detection), captured synchronously at `ensureRange` entry and rechecked after every `await`, so a superseded page fetch can never mark pages loaded against bookkeeping a newer load owns. Offline area: IndexedDB operations are not signal-driven; the `disposed` guard keeps a still-settling `restore()` from calling `DataService.load()` after teardown, and every post-disposal operation resolves `{ ok: false, error }` (§4.1). Realtime needs no counter — the session state machine's superseded-session rule (§5.2) is its equivalent.

## 2. Source area — full snapshots, delta sync, write-back

### 2.1 `load()` — full snapshot

`load()` calls the active adapter's `fetch({ filter })` and replaces the store's contents with the result via `DataService.load()`, passing `links` / `resources` / `assignments` when present and `mapping` through as the store's mapping argument. A result without a `tasks` array resolves `ok: false` and leaves the store untouched. On success the held sync token becomes the result's `syncToken` (or none), the pending-change set is cleared (the snapshot is the new baseline), and `sync/sourceSynced` is emitted with `mode: "full"` and the loaded task count as `applied.added`. Like every `DataService.load()`, the replacement carries no transaction and is not undoable.

### 2.2 `sync()` — delta sync

`sync()` applies only the changes since the last snapshot when it can: the active adapter has `fetchDelta` **and** a sync token is held; otherwise it falls back to a full `load()` and resolves `{ ok, mode: "full" }`. In delta mode the adapter is called with the held token and the current filter; each `upsert` whose row carries the required task fields (`id`, `name`, numeric `start` and `end`) becomes `task/add` (unknown id) or `task/update` (known id) — the update assigns every incoming field and **clears** every optional field the current task carries that the server row lacks, so the store row converges to the server row exactly (the converge-exactly rule, shared with §5.1). Each `remove` of a known id is batched into one `task/remove`. Unusable entries are skipped silently. All dispatches carry `origin: "stargantt.data-sync/sync"`, so delta application is ordinary undoable history but is never re-queued as a pending local change (§2.3 skips machine origins). The held token then advances to the reply's `syncToken`, and `sync/sourceSynced` is emitted with `mode: "delta"` and the per-kind counts.

### 2.3 The change tracker — pending local changes

Local edits apply to the store immediately through the ordinary command pipeline — the optimistic UI *is* the existing pipeline. The tracker consumes **`data/didApplyTransaction`** (the settle signal; it carries the applied transaction with its final patch list) and records the task-domain patches (`task/add` / `task/update` / `task/remove`) of every transaction whose `origin` is **not** a machine origin (the `"stargantt.data-sync/"` prefix test above). Machine-origin transactions are data the store already learned from a backend; re-queuing them would echo the same write back to the server on the next `flush()`, a round trip that can ping-pong indefinitely against a server that re-broadcasts accepted writes.

Records are coalesced per task id: repeated updates merge (latest value per key wins; a cleared key leaves `after`), an update folds into a pending creation, create-then-remove cancels out, remove-then-add becomes an update relative to the backend, update-then-remove collapses to the removal. `pending()` reports the per-kind counts of the coalesced set.

A **bulk replacement** of the store — any path without a transaction: `DataService.load()` (the host's, export's `applySnapshot`, this plugin's own §2.1/§4.2 loads) and `materializeChildren()` — clears the pending set. Detection is the shared bulk detector of §6.1.

### 2.4 `flush()` — optimistic write-back and rollback

`flush()` resolves `{ ok: false }` when no source is active or the active adapter has no `push`; with an empty pending set it resolves `ok: true` with zero counts and calls nothing. Otherwise it **takes** the pending set (edits made while the push is in flight accumulate separately toward the next flush) and calls `push` once with the coalesced `ChangeBatch`. On success the pushed changes are the backend's state: `sync/sourceFlushed` is emitted and a `syncToken` in the reply replaces the held token. On rejection the plugin emits `core/pluginError` and — unless `rollbackOnError: false` — rolls the taken batch back through ordinary store commands with `origin: "stargantt.data-sync/rollback"`: locally created tasks are removed, locally removed tasks re-added under their old ids with their old fields, and updates reversed to the **first-seen** prior values, using `clears` to restore a never-set field to fully absent. `sync/sourceRolledBack` reports how many tasks were touched (`cause: "flush"`), and `flush()` resolves `{ ok: false, rolledBack: true, … }`. A flush that was **superseded** while in flight (a generation bump — §1 Disposal and cross-call races) never rolls back regardless of `rollbackOnError`: the taken batch is dropped without reversion, because the superseding operation has already established its own baseline. The rollback restores tasks only; links or assignments cascade-removed with a rolled-back task removal are not resurrected (a documented limitation). With `rollbackOnError: false` the local changes simply remain and are no longer pending — the host owns retry policy via the returned `error`.

Mid-flight edits are never reverted: rollback skips any task id that already has a new pending change by the time the push settles (that edit is user-authored work made after the rejected batch was taken); only ids with no pending entry revert to their pre-batch state, and the reported `tasks` count reflects the ids actually touched — a batch where every id was re-edited mid-flight can report zero.

### 2.5 `rollback()` — explicit revert

`rollback()` runs the §2.4 reversion over the **current** pending set without pushing anything: the coalesced set is taken and reverted through the same machine-origin commands (`"stargantt.data-sync/rollback"`), the set is cleared, and — when at least one task was touched — one `sync/sourceRolledBack` is emitted with `cause: "api"` and `source` naming the active source when one is set (absent otherwise; the flush path always has one). Returns `{ ok: true, tasks }`; an empty pending set returns `{ ok: true, tasks: 0 }` and emits nothing. It touches no sync token and no backend.

### 2.6 Server-side filtering and `followFilter`

The stored `DataSourceFilter` rides on every `fetch` and `fetchDelta` request (`undefined` when none is set). Its two members are opaque to the plugin: `query` is free-text search input, `criteria` an adapter-defined condition value. `setFilter` stores the filter and triggers no request itself; a non-object argument counts as `null`.

Off by default, `followFilter: true` binds the filter slot to the interaction plugin's `stargantt.filter` service (optional, resolved per the Dependencies section): every `filter.state` store notification while a source is active schedules a reload, debounced by `followFilterDebounceMs` (default 200 ms; `0` = a zero-delay timer). (Design note: the trigger is a store notification, and the corpus rule is that store subscribers only schedule — the reload, which ends in `DataService.load()`, never runs on the filter store's dispatching stack; hence always a timer, never a synchronous reload.) The handler reads `state.query` and `state.criteria`, stores them as the server-side filter (`null` when the query is empty and the criteria are `null`; the criteria object passes through as `DataSourceFilter.criteria`), and runs `load()`. The single debounce timer is owned once at `setup()` via `ctx.own()`; re-arming swaps the timer variable. While `followFilter` is enabled it **owns** the filter slot: every filter-state change overwrites it wholesale, so a host that also calls `setFilter()` directly is overwritten on the next change — no merge, no precedence flag; a host needing both a standing base filter and the interactive one composes them itself. Without the `stargantt.filter` service the feature is silently inert.

### 2.7 The REST, local, and GraphQL adapters

`restAdapter(config?)` maps the interface onto three conventional JSON endpoints under `baseUrl` (default paths `/tasks`, `/tasks/delta`, `/tasks/batch`; setting `delta` / `batch` to `null` removes that capability from the returned adapter; unusable config values fall back to defaults). `headers` (an object, or a function called per request — the shape for short-lived auth tokens) ride on every request; the injectable `fetch` (default: the global) makes the adapter testable and proxy-friendly. A non-2xx status rejects with an `Error` carrying the status code. **fetch**: `GET {load}` with the filter as query parameters — `q` for `query`, `filter` for `JSON.stringify(criteria)` (non-serializable criteria dropped); accepts a bare task array or a `{ tasks, links?, resources?, assignments?, syncToken? }` object. **fetchDelta**: `GET {delta}?since={syncToken}` plus the filter parameters, expecting `{ changes, syncToken }`; a reply without a token keeps the request's. **push**: `POST {batch}` with the JSON `ChangeBatch` body and `Content-Type: application/json`, accepting an optional `{ syncToken }` reply. `restAdapter` and `graphqlAdapter` forward the request's `signal` onto the `fetch` `RequestInit` on every operation (the §1 abort machinery reaches the network); `localAdapter` performs no I/O and needs none.

`localAdapter(document?)` serves an in-memory document through the same interface (every `fetch` resolves the document's current lists, read at fetch time; no delta, no push), making a static backend switch-compatible with a remote one.

`graphqlAdapter(config?)` maps the interface onto host-supplied GraphQL documents sent to one endpoint as GraphQL-over-HTTP: every operation is one `POST {url}` with body `{ "query": <document>, "variables": <object> }`, the configured `headers`, and the injectable `fetch`; a non-2xx status rejects with the status code, and a reply whose `errors` array is non-empty rejects with the first error's `message`. There are **no default documents** — each capability exists only when its document is a non-empty string. Result selection: the corresponding `select` dot-path into `data` when configured (a missing segment yields `undefined`, normalizing like an empty reply); without a path, a `data` object with exactly one root field yields that field's value, otherwise `data` itself. Variables per operation: `load` → `{ query, criteria }` (each `null` when unset), `delta` → `{ since, query, criteria }`, `push` → `{ batch }`. Replies normalize like the REST adapter's, with one deliberate divergence: a selected `load` result that is an object without a `tasks` array normalizes to `{ tasks: [] }` (consistent with the "missing `select` segment ⇒ empty reply" rule above — the subsequent `DataService.load()` applies it as an empty store), where `restAdapter` rejects in the same situation. A GraphQL selection that resolves to "nothing there" is an answer; a REST body of the wrong shape is a protocol error. An adapter built without a usable `url` or `operations.load` still satisfies the shape but its `fetch` rejects with a configuration `Error`; the `graphql` config nest never registers such an adapter (Config table).

## 3. Lazy area — paged loading

### 3.1 `ensureRange` — pages, dedup, cursors

The dataset is modeled as an ordered list split into fixed `pageSize` pages; the adapter's `offset` is always a page boundary. `lazy.ensureRange(offset, limit)` computes the pages overlapping the row range, skips pages already loaded or currently in flight (the dedup that makes scroll-driven calls cheap), and fetches the missing ones sequentially in ascending order, so cursor-based backends always receive the cursor their previous page returned (`RangeRequest.cursor` is set exactly when the plugin holds the cursor of the page immediately before; offset-based backends ignore it).

`ensureRange` resolves, never rejects. Non-finite or negative arguments, a zero/negative `limit`, or a range entirely beyond a known `total` resolve `{ ok: true, pages: 0 }` without a request; no active source resolves `{ ok: false }`. A call whose every missing page is already in flight from an earlier call also resolves `{ ok: true, pages: 0 }` immediately — `pages: 0` means "already covered, one way or another", never "the data is present". `isRangeLoaded(offset, limit)` is the completion signal (`true` only once the covering pages are applied to the store); it agrees with `ensureRange` about every **usable** range — a range at/beyond a known `total` reports `true` — keeping the driving pattern `while (!isRangeLoaded(o, n)) await ensureRange(o, n)` free of livelock at the dataset tail. Unusable arguments (a non-finite or negative `offset`, a non-positive `limit`) are the one exception to the agreement: `isRangeLoaded` reports `false` while `ensureRange` no-ops `{ ok: true, pages: 0 }`, so the driving pattern stalls visibly on a caller bug instead of silently fetching a clamped page (deliberate; the livelock-freedom claim is scoped to usable arguments).

Reply rows must already be task-shaped (`id` string or number, string `name`, finite numeric `start`/`end`; `parentId` defaults to `null`); there is no `FieldMapping` support — mapping is a full-snapshot concern. Page application is strictly **add-only**: each usable unknown-id row becomes one `task/add` carrying `origin: "stargantt.data-sync/lazy"`; a row whose id already exists is skipped — a re-fetch never clobbers local or streamed state, and refreshing an existing row's fields is `applyChanges`'s job (or `reset()` + re-fetch). Unusable rows are skipped silently. A reply that is not an object with a `tasks` array fails the whole call (`ok: false`); pages already applied stay applied. A numeric `total` in any reply is recorded and clamps later page computation; a string `cursor` is recorded as the next page's continuation. Every applied page emits `sync/lazyRangeLoaded` with the page's row offset, the number of tasks actually added, and the currently known `total`.

`lazy.sources.activate` to a *different* source resets the paging bookkeeping (loaded pages, total, cursors — they belong to the previous backend), as does `reset()`; store contents are untouched. A bulk store replacement (§6.1) also resets the bookkeeping — the loaded-page map no longer describes the store.

### 3.2 `applyChanges` — streamed increments, minimal merge

`lazy.applyChanges(changes)` reflects backend-pushed increments without rebuilding the store; it is synchronous and safe to call from any host push channel; unusable input counts as an empty batch. Each `upsert` carrying the required task fields becomes `task/add` (unknown id) or `task/update` (known id) with the **minimal merge**: only the fields the incoming row carries are assigned; fields the row lacks are left untouched — deliberately weaker than §2.2's converge-exactly rule, because lazily streamed rows commonly come from partial-window/partial-field channels where "not mentioned" does not mean "clear" (this divergence is also why the return type is `LazyLoadAppliedCounts`, not `AppliedCounts` — no alias). Each `remove` of a known id is batched into one `task/remove`. All dispatches carry `origin: "stargantt.data-sync/lazy"`. The per-kind counts are returned and, when any is non-zero, emitted as `sync/lazyChangesApplied`. `StreamChange` is the source area's `DeltaChange`, so a delta endpoint can feed this method directly — and the same change will leave the store in a different state depending on which path applied it; that is expected, not a bug.

### 3.3 Viewport following and prefetch

Off by default. With `lazyLoad.followViewport: true` and both `stargantt.view` and `stargantt.rows` resolving (optional services, resolved per the Dependencies section), every `view/scrolled` event (the retained input-stream event; the view plugin is its sole emitter) while a lazy source is active computes the visible row range — `rows.rowAtY(scrollTop)` through `rows.rowAtY(scrollTop + viewport.height)`, the viewport read from the `view.viewport` store value — and calls `ensureRange` over it. Row indices are used as dataset offsets, exact for the intended shape of a lazily loaded dataset (flat, backend-ordered, unfiltered); a host presenting a collapsed/filtered tree over a lazy backend calls `ensureRange` itself with real offsets. When the visible range reaches the end of the loaded rows and `total` is not exhausted, the range extends to the next page boundary so scrolling past the loaded edge keeps pulling data. Per-event work before the deduplicated fetch check is O(log n); no throttle is needed because a fully loaded visible range performs no further work. (Both `stargantt.view` and `stargantt.rows` are declared optional and resolved late; the feature is inert unless both resolve.)

With viewport following active and `prefetchPages ≥ 1`, consecutive `view/scrolled` events feed the plugin's own velocity estimate (Δ`scrollTop` / Δtime over the most recent sample pair). The predicted position 200 ms ahead — converted to a row index by extrapolating the visible rows-per-pixel density past the loaded edge — extends the ensured range by up to `prefetchPages` extra pages in the scroll direction only; at rest nothing is prefetched. Prefetch rides the same `ensureRange` path (dedup, `total` clamp, error barrier); a failed prefetch surfaces through `core/pluginError` only. (Design note: the estimator is deliberately the plugin's own, not `ViewService.predictedViewport()` — that member is gated on the view plugin's `prefetch` config, and lazy prefetch must not change behavior with a foreign config knob.)

## 4. Offline area — IndexedDB snapshots

### 4.1 The persisted document and `save()` / `clear()` / `persisted()` / `available()`

One IndexedDB database (`databaseName`) holds one object store `"documents"` (schema version 1) keyed by `documentKey`; several charts or projects share a database via distinct keys. The stored value is the `PersistedDocument`: the data store's `toJSON()` rows verbatim (structured-clone-safe), the epoch-ms `savedAt` stamp (informational), and — when any contributor captured anything — `plugins`, keyed by `SnapshotContribution.id`. On read, a record not carrying all five array lists is treated exactly like an absent record; the `plugins` field plays no part in that test.

`offline.save()` snapshots `DataService.toJSON()`, captures every `storage/snapshot` contributor's state (§4.3), and writes one document under `documentKey`, overwriting any previous snapshot whole — a contributor whose `capture()` returns `undefined` has no entry in the new document even if an earlier save stored one. `sync/offlineSaved` is emitted with the task count. `clear()` deletes the snapshot (a no-op delete still resolves `ok: true` and emits `sync/offlineCleared`). `persisted()` reports whether a usable snapshot exists, resolving `false` (never rejecting) when IndexedDB is unavailable or the read fails. `available()` is the synchronous capability predicate: `true` when a usable `IDBFactory` resolved at `setup()` (`offline.indexedDB` or the global), constant for the instance's life; it does not probe the connection, so a first-use quota or permission failure still surfaces through `{ ok: false, error }` and `core/pluginError`. When no IndexedDB implementation exists at all, every offline method quietly resolves `{ ok: false }` / `false` with **no** `core/pluginError` — an absent capability is degradation, not a fault — and no `sync/activity` fires. The database connection opens lazily on first use and is reused (a failed open is not cached — a later call retries); it is closed on plugin disposal via one `ctx.own()` disposable, terminally — a call after disposal resolves `{ ok: false, error }` rather than reopening an unowned connection.

### 4.2 `restore()` and `autoSave` / `autoRestore`

`restore()` reads the snapshot and, when a usable one exists, replaces the store contents via `DataService.load()` (all five lists, no field mapping — the round trip is store-native), then applies every currently registered `storage/snapshot` contributor's stored state (§4.3). No snapshot, a record missing any of the five lists, or an unavailable IndexedDB resolves `{ ok: false }` without touching the store. A restore is a bootstrap load: no transaction, not undoable — and, being a bulk replacement, it clears the pending set and the lazy bookkeeping (§6.1). `sync/offlineRestored` is emitted on success; the result carries `restored: [...]` — the ids of contributors whose `apply()` ran without throwing — whenever that list is non-empty, and omits the field otherwise.

With `autoSave: true` (and IndexedDB available), every `data.tasks` store notification — the always-fired, always-last member of the store burst, and the bulk-path signal too, so every kind of data change is covered — schedules a `save()`, debounced by `autoSaveDebounceMs` (default 500 ms; `0` starts the `save()` immediately, on the same stack — safe because `save()` only reads (`toJSON()` plus an asynchronous IndexedDB write) and dispatches nothing, so the store re-entrancy rule is untouched, and a host setting `0` before unload expects the write already started), so an edit burst persists once; a `restore()` then rewriting an identical document is an accepted idempotent write. The single debounce timer is owned once at `setup()` via `ctx.own()`. `autoRestore: true` starts one `restore()` on `lifecycle/ready`; its result surfaces only through the events / `core/pluginError`.

### 4.3 The `storage/snapshot` extension point (collect)

`SnapshotContribution` is a plugin's own hook into the persisted document: state it owns outside the store's five entity lists that would otherwise be silently absent after a reload. Declared in this plugin's `types.ts`:

```ts
declare module "@stargantt/core" {
  interface ExtensionPoints {
    "storage/snapshot": ExtensionPointDecl<SnapshotContribution, SnapshotContribution[]>;
  }
}
```

- `id` is the key the state is stored under inside `plugins` and the match key on restore; the convention is the contributing plugin's id. Two contributions sharing an `id`: the first, in registration order, is kept; the rest are dropped and reported via `core/pluginError`.
- `capture()` runs at save time, in registration order, for every currently registered contribution — read immediately before writing, after the store's `toJSON()` snapshot is taken, as part of the same `save()`. A return of `undefined` means "nothing to store this time".
- `apply(state)` runs at restore time, in registration order, **after** `DataService.load()` has replaced the five lists — so a contribution resolving store ids sees them present. It is called only for contributions whose `id` has an entry in the document; a contribution with no matching entry is skipped, not called with `undefined`, and an entry with no matching contribution is silently left unapplied (recomposition between save and restore is legal).
- Fault isolation: a throwing `capture()` leaves that `id` absent and the write proceeds; a throwing `apply()` leaves that `id` out of `restored` and the walk continues; neither ever turns a successful `save()`/`restore()` into `{ ok: false }`. Both are foreign code under the unlatched per-call barrier.
- No official plugin contributes to `storage/snapshot`; it exists for third parties (and hosts). The export plugin's embed snapshot machinery is unrelated (export.md §2.3).

### 4.4 The offline source adapter

When the `offline` config nest is supplied and `registerSource` is not `false`, `setup()` registers a **read-only** `DataSourceAdapter` into the facade's own source registry under `sourceName` (default `"offline"`): its `fetch` reads the current persisted snapshot and returns its tasks / links / resources / assignments (an empty task list when nothing is persisted); it offers no `fetchDelta` and no `push` — writing back happens through `save()`/auto-save, not `flush()`. Registration alone changes nothing; the source acts only if activated. Two limitations: `FetchResult` has no calendar list, so calendars ride only on `restore()`; and a read failure inside `fetch` is reported via `core/pluginError` and served as an absent snapshot. (The gate is the `offline` nest's presence, preserving the default-off composition: with no `offline` nest, `sources.names()` contains no `"offline"` entry.)

## 5. Realtime area — transports, application, reconnection

### 5.1 The message pipeline

Every value a transport delivers through `onMessage` (and every `applyMessage` argument) is narrowed to the `RealtimeMessage` union; anything else — a non-object, an unknown `type`, a non-array `changes` — is silently ignored, so a server may multiplex other message kinds on the same channel. A `changes` message is applied with the §2.2 converge-exactly delta semantics, with one exception: the store-managed `orderKey` is **never cleared** by a row that lacks it, so a server that does not round-trip ordering cannot scramble row order (a row that carries `orderKey` applies it like any field). `remove` entries of known ids are batched into one `task/remove`. All dispatches carry `origin: "stargantt.data-sync/realtime"` — machine-origin, so the tracker never queues them (§2.3) — and the application is ordinary undoable history. After application `sync/realtimeApplied` is emitted with the per-kind counts and the live transport's name.

**Echo suppression.** An `upsert` whose row is shallow-equal to the current task (every incoming field `Object.is`-equal, no field to clear) produces no store command — no transaction, no undo entry, no repaint; a `remove` of an unknown id is likewise a no-op. The `sync/realtimeApplied` counts include only operations actually dispatched, so a pure echo reports all zeros. This is a value-level filter, not an id-level one: a genuinely concurrent foreign edit to a task this client also edited still applies (last-writer-wins at field level).

### 5.2 Connection lifecycle — the `status` store

The connection is a single-owner state machine: one live session at a time; callbacks of a superseded session are ignored, so a slow transport cannot resurrect a closed connection. Every transition **sets the `realtime.status` store** with the new `RealtimeConnection` — `status`, the `cause` (`connect` — a `connect()` call opened a session; `open` — the transport reported open; `reconnect` — an automatic retry was scheduled or started; `close` — the connection ended without a retry; `disconnect` — the host closed it), and `transport`. For `close` and `disconnect` — the two causes whose transition ends the live session — `transport` names the transport that just dropped, captured before the state is cleared; these two causes never omit it, and the durable disconnected value that follows carries no `transport`. The initial store value is `{ status: "disconnected" }` (no `cause`). Subscriptions ride `ctx.own()` as everywhere.

`realtime.connect(name)` opens the named transport and makes it live; it returns `false` and changes nothing for an unregistered name; called while another connection is live it first closes that connection (a `disconnect`-cause store set), and reconnect attempts reset. `disconnect()` closes the live connection or cancels a pending reconnect and suppresses automatic reconnection until the next `connect()`; idempotent. Replacing the currently connected transport in the registry does not affect the live connection; the replacement is used from the next `connect()`.

A transport is foreign code: `connect` / `disconnect` calls are wrapped (unlatched barrier), a throw is reported and treated as a close; a throw inside message application is likewise contained and the connection stays up.

### 5.3 Reconnection

With `autoReconnect` (default true), an unexpected close schedules a retry with capped exponential backoff and full jitter: the nominal delay is `reconnectDelayMs × 2^(n−1)` for the n-th consecutive attempt, capped at 30× `reconnectDelayMs`, with the actual delay drawn uniformly from `[0, nominal]` (`reconnectDelayMs: 0` always retries on the next macrotask). Retries continue up to `maxReconnectAttempts` (default 5) consecutive failures. The attempts counter resets only after a connection has stayed open for a ~30-second stability window (its own timer, armed on open, cancelled on close) — a flapping connection keeps accumulating attempts and still exhausts the budget. On exhaustion — or with `autoReconnect: false` immediately — the status becomes `disconnected` with cause `close`. `disconnect()` and disposal cancel any pending retry and the stability timer; both timers are owned once at `setup()` via `ctx.own()` (re-arming swaps variables).

### 5.4 `resync` — internal source-area delegation

A `resync` message means "more changed than I will push inline; pull the rest". With `resyncViaDataSource` (default true) **and** a source active in the source area, the plugin calls its own `sync()` (§2.2) — delta when a token is held, full reload otherwise — and the outcome surfaces through the source area's own events. Without an active source or with `resyncViaDataSource: false` the message is ignored. `applyMessage` reports `resync: true` for a recognized resync message regardless of whether a sync was started. (The delegation is an internal call within the facade.)

### 5.5 The WebSocket and SSE transports

`webSocketTransport(config?)` opens `new WebSocket(url, protocols?)` on `connect` and maps socket events onto the handler interface; each string `message` payload is `JSON.parse`d (unparsable data dropped silently) and handed to `onMessage`. `disconnect` closes the socket without reporting a close. Without a usable `url` or a WebSocket constructor (injected or global) the returned transport is inert: `connect` does nothing, which the plugin treats as a connection that never opens. The transport performs no reconnection of its own — that is §5.3's job.

`sseTransport(config?)` opens `new EventSource(url, { withCredentials })` on `connect`, listening for `open`, the configured `eventName` (default `"message"`), and `error`; data strings parse as above. An `error` while `readyState` is `CLOSED` is reported as a close (the plugin's reconnection takes over); any other `error` goes to `onError` and the source's native retry keeps running — the plugin does not tear down a source that is retrying by itself. The same inert-without-`url` rule applies.

## 6. Shared machinery

### 6.1 Bulk-replacement detection (normative)

The tracker's pending-set clear (§2.3) and the lazy bookkeeping reset (§3.1) fire on every store change that carries no transaction — `DataService.load()` from any caller and `materializeChildren()`. The shared detector (`internal/transactions.ts`) classifies each `data.tasks` store notification by the transaction bracket:

- `data/willApplyTransaction` increments a bracket depth; `data/didApplyTransaction` decrements it (floored at 0). A `tasks` notification arriving at depth > 0 is transactional (the recording side already consumes the did-event); at depth 0 it is a bulk replacement.
- The whole apply flow — will → burst → did — is synchronous on one stack (data-store.md §Apply flow), and bulk paths run with no transaction anywhere in flight. A transaction cancelled in the will phase or whose atomic apply fails produces no burst and no did-event and would leave the depth stale; each will-event therefore also schedules one microtask that resets the depth to 0. The microtask runs only after the synchronous apply flow has fully unwound, and no bulk notification can occur on that same stack, so the reconciliation can never misclassify a genuine burst. Nested applies (a will-handler dispatching) count depth correctly because inner brackets settle before the outer burst.
- **Normative precondition:** no bulk (no-transaction) store mutation — `DataService.load()` or `materializeChildren()` — is ever performed from inside a `data/willApplyTransaction` handler: the bracket depth is non-zero there, so the detector would misclassify the resulting bulk notification as transactional. The data-store spec's will-phase contract (cancel or append patches) gives handlers no sanctioned reason to bulk-load, and no official plugin does; the classification guarantee holds under that precondition.

### 6.2 `sync/activity` — the merged in-flight counter

Operations that start inside the plugin (`autoLoad`, `followFilter` reloads, viewport-following fetches, prefetch, auto-save, auto-restore) give the host no promise to observe, so in-flight work is announced through one counter event, `sync/activity`, discriminated by `area`:

```ts
export type SyncActivity =
  | { area: "source"; op: "load" | "sync" | "flush"; source: string; pending: number }
  | { area: "lazy"; op: "fetchRange"; source: string; pending: number }
  | { area: "offline"; op: "save" | "restore" | "clear"; cause: "manual" | "auto"; pending: number };
```

Per-area semantics: one counter per `(area, op)`, incremented at operation entry and decremented in a `finally`, so a failed operation still reaches zero and a "loading" indicator can never hang; the event fires only when a pending count actually changes (minimal pair 1 → 0; overlapping operations produce 1→2→1→0). Source area: `op` names the service operation invoked (a `sync()` falling back to a full load is still one `"sync"`); a `flush()` with nothing pending and a `load()`/`sync()` with no active source never touch the counter. Lazy area: the unit is the `ensureRange` call, not the page — one pending operation from first fetch to settlement; a call satisfied without any request emits nothing. Offline area: `cause` distinguishes the plugin's own debounced/auto operations (`"auto"`) from explicit service calls (`"manual"`); an absent IndexedDB capability performs no operation and emits nothing. Ordering with the terminal events is fixed in every area: on success the completion event (`sync/sourceSynced` / `sync/sourceFlushed` / `sync/lazyRangeLoaded` / `sync/offlineSaved` / …) precedes the decremented `activity` event; on failure `core/pluginError` precedes it — the substance of the outcome always precedes the UI-terminal signal. The realtime area is deliberately excluded: the `"connecting"` status already gives a start/terminal pair, and resync fetches surface on the source-area counter.

## Events

Declared in `types.ts` (single declaration-merging site):

| Event | Payload | Fired |
|---|---|---|
| `sync/sourceSynced` | `{ source: string; mode: "full" \| "delta"; applied: AppliedCounts }` | after every successful `load()` (full; loaded count as `applied.added`) or delta `sync()` |
| `sync/sourceFlushed` | `{ source: string; sent: { creates: number; updates: number; removes: number } }` | after every successful non-empty `flush()` |
| `sync/sourceRolledBack` | `{ source?: string; tasks: number; cause: "flush" \| "api" }` | after a flush-failure rollback (§2.4) or a non-empty explicit `rollback()` (§2.5); `source` absent only on the api path with no active source |
| `sync/lazyRangeLoaded` | `{ source: string; offset: number; count: number; total?: number }` | once per applied page |
| `sync/lazyChangesApplied` | `{ applied: LazyLoadAppliedCounts }` | after an `applyChanges` with any non-zero count |
| `sync/offlineSaved` | `{ key: string; tasks: number }` | after every successful save |
| `sync/offlineRestored` | `{ key: string; tasks: number }` | after every successful restore |
| `sync/offlineCleared` | `{ key: string }` | after every clear (no-op deletes included) |
| `sync/realtimeApplied` | `{ applied: AppliedCounts; transport?: string }` | after every applied `changes` message (echo messages report zeros) |
| `sync/activity` | `SyncActivity` (§6.2) | on every pending-count change |

Subscribed: `data/willApplyTransaction` and `data/didApplyTransaction` (§2.3, §6.1 — one standing subscription each, taken at `setup()`); `lifecycle/ready` (the `autoLoad` / `lazyLoad.autoLoad` / `offline.autoRestore` / `realtime.connect` startup actions and the late optional-service resolution — see Dependencies); `view/scrolled` (only while viewport following is live, §3.3). Store subscriptions: `data.tasks` (§4.2 auto-save, §6.1), `filter.state` (§2.6, only with `followFilter`). There is no `realtime/statusChanged` event — the `realtime.status` store is the change channel.

## Extension points

- Defines: `storage/snapshot` (collect, §4.3).
- Contributes: none.

## Commands

None owned. The plugin dispatches the public data commands `task/add` / `task/update` / `task/remove`, always stamped with one of the four `"stargantt.data-sync/"` origins (origin table above); a third party observing transactions classifies this plugin's writes by that prefix.

## Config

Factory: `dataSync(config?: DataSyncConfig)`. Every field optional; `dataSync()` ≡ `dataSync({})`; unusable values silently fall back to defaults; resolved once at `setup()`. `sources` / `active` / `lazyLoad.sources` / `lazyLoad.active` / `realtime.transports` entries are applied at `setup()` through the same code paths as the registry methods (same unusable-value treatment). (Design note: the four startup *actions* — `autoLoad`, `lazyLoad.autoLoad`, `offline.autoRestore`, `realtime.connect` — run on `lifecycle/ready`, not at `setup()`: deferring them keeps a boot `load()`/`restore()` from pushing data into the stores before later-tiered plugins have subscribed.)

```ts
export interface GraphqlSourceConfig extends GraphqlAdapterConfig {
  name?: string;       // default "graphql"
  activate?: boolean;  // default false
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
```

| Field | Default | Semantics |
|---|---|---|
| `sources` / `active` | none | seed registrations + startup activation (§1 registry rules) |
| `autoLoad` | `false` | one `load()` on `lifecycle/ready` iff a source is then active; outcome surfaces via events / `core/pluginError` only |
| `rollbackOnError` | `true` | §2.4 |
| `followFilter` | `false` | §2.6; inert without `stargantt.filter` |
| `followFilterDebounceMs` | `200` | §2.6; non-finite or negative falls back |
| `graphql` | absent | iff `url` and `operations.load` are both non-empty strings, builds one `graphqlAdapter(config.graphql)` and registers it under `name` at setup; `activate: true` then activates it; otherwise a complete no-op (§2.7) |
| `lazyLoad.sources` / `.active` / `.autoLoad` | none / none / `false` | lazy registry seed; `autoLoad: true` starts one `ensureRange(0, pageSize)` on `lifecycle/ready` iff a lazy source is active |
| `lazyLoad.pageSize` | `500` | finite integer ≥ 1, else the default |
| `lazyLoad.followViewport` | `false` | §3.3; inert unless `view` and `rows` both resolve |
| `lazyLoad.prefetchPages` | `1` | `0` disables; non-finite or negative falls back; fractions truncate |
| `offline.databaseName` | `"stargantt-offline"` | §4.1 |
| `offline.documentKey` | `"default"` | §4.1 |
| `offline.autoRestore` | `false` | one `restore()` on `lifecycle/ready` |
| `offline.autoSave` | `false` | §4.2 |
| `offline.autoSaveDebounceMs` | `500` | non-finite or negative falls back |
| `offline.registerSource` | `true` | §4.4 (gated on the nest's presence) |
| `offline.sourceName` | `"offline"` | §4.4 |
| `offline.indexedDB` | global `indexedDB` | injectable `IDBFactory` (an entry without an `open` function falls back) |
| `realtime.transports` / `.connect` | none | transport seed; `connect` names the transport opened on `lifecycle/ready` (unregistered/unusable name ignored) |
| `realtime.autoReconnect` | `true` | §5.3 |
| `realtime.reconnectDelayMs` | `1000` | non-finite or negative falls back |
| `realtime.maxReconnectAttempts` | `5` | non-finite or negative falls back |
| `realtime.resyncViaDataSource` | `true` | §5.4 |

## Messages

None. Headless plugin — no DOM, no ARIA output; event payloads and `Error` values are developer-facing (out of catalog scope).

## Internal modules

Directory = feature area; every area enters through `wire.ts`; every file ≤ 800 lines.

| Module | Content |
|---|---|
| `index.ts` | factory, facade assembly, area wiring hand-off |
| `types.ts` | public types + the single `declare module "@stargantt/core"` site (service, events, extension point) |
| `internal/transactions.ts` | the §6.1 bulk-replacement detector + the machine-origin prefix predicate + the §6.2 activity counters (shared by all areas) |
| `internal/adapters/wire.ts` | source registry, `load` / `sync` / `flush` / `rollback` / filter slot, `followFilter`, `autoLoad`, the graphql config-nest gate |
| `internal/adapters/rest.ts` | the REST adapter |
| `internal/adapters/local.ts` | the local adapter |
| `internal/adapters/graphql.ts` | the GraphQL adapter (wire convention, result selection) |
| `internal/tracker/tracker.ts` | the coalescing pending-change tracker (§2.3), fed from `data/didApplyTransaction` |
| `internal/tracker/delta.ts` | the converge-exactly delta application shared by §2.2 and §5.1 (the `orderKey` exception and echo suppression parameterized by the realtime caller) |
| `internal/lazy/wire.ts` | lazy registry, `ensureRange` orchestration, viewport following, `autoLoad` |
| `internal/lazy/pager.ts` | page map, dedup, cursors, `total` clamp |
| `internal/lazy/apply.ts` | add-only page application + minimal-merge `applyChanges` |
| `internal/lazy/prefetch.ts` | velocity estimate + prediction |
| `internal/offline/wire.ts` | offline area service, auto-save/restore, the §4.4 adapter registration |
| `internal/offline/idb.ts` | IndexedDB open/read/write/delete/close |
| `internal/offline/document.ts` | `PersistedDocument` assembly/validation + the `storage/snapshot` capture/apply walks |
| `internal/offline/adapter.ts` | the read-only offline source adapter |
| `internal/realtime/wire.ts` | transport registry, message pipeline, resync delegation, the `status` store |
| `internal/realtime/connection.ts` | the session state machine, backoff/jitter, stability window |
| `internal/realtime/websocket.ts` | the WebSocket transport |
| `internal/realtime/sse.ts` | the SSE transport |

## Dependencies

`dependsOn` (hard): `data` (L1) — the only edge the plugin cannot function without. `meta.optional` (provider *plugin* ids — the core's optional-lookup gate checks the providing plugin's id, not the service key; the tracking.md precedent): `stargantt.interaction` (L5 — the `stargantt.filter` service, `followFilter`), `stargantt.view` (L2) and `stargantt.tree-grid` (L3 — the `stargantt.rows` service) — viewport following. **Resolution timing** follows the scheduling.md §14 pattern: `meta.optional` does not influence startup order (the core tiers by `dependsOn` alone, so this plugin's `setup()` can precede every optional provider's); every optional service is resolved at `lifecycle/ready` or per use — never latched into a variable at `setup()` — and an absent optional service leaves the consuming feature silently inert (no `core/pluginError`). Sibling types arrive via `import type` (devDependencies; no build-graph cycle). No `stargantt.history` edge exists: undo integration is inherent in dispatching public commands and needs no edge.

No upward `ctx.use` edge exists. Export (L8, same layer) integrates without any edge in either direction: its read-only veto exempts this plugin's transactions by origin prefix (origin table above), through the store's public will-hook.

## Third-party surface

- **Consumable services:** `stargantt.data-sync` (`DataSyncService`) — third parties register their own source adapters, lazy adapters, and transports through the same registries the shipped factories use, and drive load / sync / flush / rollback, paging, offline persistence, and realtime connectivity through the facade, including subscribing to the `realtime.status` store.
- **Contributable extension points (with merge strategy):** `storage/snapshot` (collect) — third-party plugins persist their own state into offline snapshots on equal terms (§4.3).
- **Subscribable events:** the ten `sync/*` events of the Events table.
- **Adapter/transport factories:** `restAdapter`, `localAdapter`, `graphqlAdapter`, `webSocketTransport`, `sseTransport` are public hostless factories; any object with a conforming `fetch` / `fetchRange` / `connect`+`disconnect` is an equal citizen.
- **Reserved namespaces (documentation convention only):** the `sync/` event namespace, the `storage/` extension-point namespace, the `stargantt.data-sync` service ID, and the `"stargantt.data-sync/"` transaction-origin prefix. Not enforced in core.
