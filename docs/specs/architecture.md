# StarGantt Architecture

Status: normative. This document governs the core, the SDK boundary, and the cross-cutting rules; the per-plugin specifications in `docs/specs/plugins/` are authoritative for plugin details.

StarGantt is a zero-runtime-dependency, plugin-based Gantt chart library: a minimal core + an official SDK + 15 official plugins. The core knows nothing about Gantt concepts (tasks, dates, rendering). Official features are implemented exclusively through the same public APIs available to third parties (no back-door APIs).

---

## 1. Core design (arbitration mechanisms + store-shaped services)

The core consists of 8 files — PluginHost / ServiceRegistry / ExtensionPoint / EventBus / CommandBus / PluginContext / kernel / disposable — plus the mechanisms below. The core holds no Gantt concepts (tasks, dates, rendering) whatsoever. Size target: under 12KB after minification (enforced in CI).

### 1.1 Store-shaped service foundation (`store.ts`)

The central state mechanism. Stateful services expose their state through a single channel — the Store shape below — instead of a service reference paired with a separate change-event subscription to the same counterpart:

```ts
// @stargantt/core API
export interface Store<T> {
  get(): T;
  subscribe(fn: (next: T, prev: T) => void): Disposable;
}
export interface WritableStore<T> extends Store<T> {
  set(next: T): void;
  update(fn: (prev: T) => T): void;
}
export function createStore<T>(initial: T): WritableStore<T>;

// Standard shape for a service exposing a store:
//   interface SelectionService { readonly state: Store<SelectionState>; select(ids): void; ... }
// Subscriptions are auto-disposed via ctx.own():
//   ctx.own(sel.state.subscribe(paint));
```

These signatures are normative and exhaustive: the store API is exactly `get` / `subscribe` (plus `set` / `update` on the writable side). `get()` returns the current state, which all callers and subscribers MUST treat as an immutable snapshot; `update(fn)` is exactly equivalent to `set(fn(get()))`.

**Store semantics (normative).**

1. **Synchronous notification, no coalescing.** `set(next)` synchronously invokes every current subscriber with `(next, prev)` — where `prev` is the value `get()` returned immediately before the call — and only then returns. The store's value is committed to `next` *before* the first subscriber runs: `get()` called from inside a subscriber callback (or from anything it invokes) returns `next`. The core performs no microtask, task, or frame coalescing and no equality gating: every `set()` call produces exactly one notification per live subscriber, even if `next` is identical (by any notion of equality) to `prev`. This matches the immediacy of the EventBus. Frame coalescing is the subscriber's job, using the SDK frame scheduler (`sdk/frame`); it is never the store's.

2. **Re-entrant `set()` is forbidden — always throws.** Calling `set()` or `update()` on a store while that same store is dispatching notifications throws synchronously, in every build; the in-flight dispatch is not affected and continues with its original `(next, prev)` pair. There is no dev/prod split and no environment-detection machinery: the guard is an O(1) boolean and ships in all builds. Writing to a *different* store, emitting events, or dispatching commands from inside a subscriber is permitted (subject to those mechanisms' own re-entrancy rules).

3. **Subscriber exceptions are contained.** An exception thrown by a subscriber callback does not abort the dispatch: remaining subscribers still run, and `set()` returns normally to its caller (the standard error-containment pattern of this library). `createStore` itself is context-free — a bare store knows no host and no plugin. The binding rule is normative: when a subscription's `Disposable` is registered via `ctx.own()`, the owning context stamps, once, both the owner plugin's id AND the host's fault channel onto that subscription (the first `ctx.own()` call that receives the `Disposable` wins). A thrown subscriber exception is then handled as follows:
   - **Fault channel bound** (the subscription was owned by a plugin context): the error is reported as `core/pluginError` with the owner plugin's id, through the host's fault barrier — delivery is re-entry-suppressed, so a throwing `core/pluginError` listener cannot loop.
   - **Never owned by any plugin context** (application code): no bus is reachable, so no `core/pluginError` is emitted; the error is contained and reported via `console.error`.

   EventBus listener faults are attributed to the `"app"` sentinel plugin id when no plugin owns the listener — an EventBus listener always has a bus to report through — but that sentinel does NOT apply to store subscriptions, which follow the fault-channel rule above.

4. **Unsubscribe via the returned `Disposable`.** `subscribe()` returns a `Disposable`; calling its `dispose()` removes the subscription and is idempotent (second and later calls are no-ops). A subscription disposed while a dispatch is in flight — including by an earlier subscriber in the same dispatch — is skipped for the remainder of that dispatch and never called again. Conversely, a `subscribe()` made while a dispatch is in flight registers the new subscriber but does NOT call it for the in-flight dispatch (dispatch snapshots the subscriber list); it is first notified on the next `set()`.

**Ruling — no selector subscriptions.** `subscribe(selector, fn)` is NOT included. The store API is `get` / `subscribe` only, as declared above. This may be revisited if partial redraw turns out to need selector-granularity invalidation; until such a revision lands in this document, no selector overload exists and none may be assumed.

### 1.2 The three arbitration mechanisms (`arbitration.ts`)

Shared resources — render z-order, reserved metadata keys, overlay slots — are arbitrated in code rather than by hand-maintained documentation tables. All three mechanisms are variants of the same generic form — a "namespaced token ownership registry" — and hold no Gantt-specific concepts.

```ts
// arbitration (PluginContext):
claimOrder(scope: string, key: string, order: number): void;   // dup (scope,order) or (scope,key) -> core/pluginError
claimKey(bag: string, key: string): void;                      // dup (bag,key)    -> core/pluginError
claimSlot(group: string, slot: string, candidates?: readonly string[]): SlotGrant;
                                                               // { granted: boolean; alternative?: string }
// host introspection: host.orders(scope): ReadonlyArray<{key, order, pluginId}>

export interface SlotGrant {
  granted: boolean;
  alternative?: string;
}
```

Throughout this document, "host" in `host.orders(scope)` means the public instance handle returned by `Gantt.create()` (`GanttInstance`).

The three claim methods live on `PluginContext`, so every claim is attributed to the calling plugin's id. Claims are registration-time declarations of ownership; they exist for conflict detection and introspection, not for access control.

| Mechanism | Arbitrates | API | Example |
|---|---|---|---|
| Order-key registry | Render z-order (the `renderer/layers` paint stack) | `ctx.claimOrder(scope, key, order)` | `claimOrder("renderer/layers", "task-bars:bars", 60)` |
| Key registry | Reserved `task.meta` keys | `ctx.claimKey(bag, key)` | `claimKey("task.meta", "taskFields")` |
| Slot registry | Overlay corner slots (4 corners) | `ctx.claimSlot(group, slot, candidates?): SlotGrant` | `claimSlot("overlay-corner", "top-right", ["top-left", "top-right", "bottom-left", "bottom-right"])` |

**Collision semantics (normative).**

- **`claimOrder`:** a claim of a `(scope, order)` pair already registered in that scope is detected at registration time; the duplicate claim is NOT recorded, and the conflict is reported via `core/pluginError` attributed to the later claimant. A duplicate `(scope, key)` is ALSO a `core/pluginError` under the same rule: a key registers at most once per scope. Claims with a fresh key and a fresh order within a scope always register successfully; the same plugin may claim multiple `(key, order)` entries in one scope.
- **`claimKey`:** a claim of a `(bag, key)` pair already owned is detected at registration time; the duplicate claim is NOT recorded, and the conflict is reported via `core/pluginError` attributed to the later claimant. Unclaimed keys are NOT write-protected: any code may read or write keys nobody claimed (host free area). A claim declares ownership for conflict detection only — the core never intercepts reads or writes of the underlying bag.
- **`claimSlot`:** the first claim of a free `(group, slot)` occupies it and returns `{ granted: true }`. A claim of an occupied slot does NOT change occupancy and returns `{ granted: false, alternative }`, where `alternative` is the lexicographically smallest slot in the group's known-slot set not currently occupied (by plain UTF-16 code-unit string ordering, i.e. JavaScript `<` on the slot names); `alternative` is absent when no known slot is free. A group's **known-slot set** is the union of every slot name ever mentioned for that group: slots successfully claimed, slots requested (granted or not), and every name in any `candidates` array passed to `claimSlot` for that group. Rationale: the core keeps zero slot vocabulary of its own — claimants supply it, typically by passing the group's full vocabulary as `candidates` so a useful alternative can be proposed even on the first collision. Whether the claimant follows the proposal is optional — the core cannot police where a plugin actually renders, which is why the duplicate occupancy attempt is additionally reported as a **warning-level** `core/pluginError` attributed to the later claimant, rather than rejected.

For warning-level reports the `core/pluginError` payload carries an optional severity field: `{ pluginId: string; error: unknown; level?: "warning" }`. An absent `level` means error-level; slot duplicate occupancy is currently the only warning-level report.

**Introspection (normative).** `orders(scope)` — exposed on the public instance handle returned by `Gantt.create()` (`GanttInstance`), not on `PluginContext` — returns a read-only snapshot array of every registration in `scope`, each entry `{ key, order, pluginId }`, **sorted ascending by `order`**. An unknown or empty scope yields an empty array. The result is a snapshot, not a live view; it is the source from which `docs/specs/render-order.md` is generated (chapter 7 — documentation becomes a generated artifact).

### 1.3 EventBus role

The EventBus is exclusively for "true stateless broadcast": input streams, activity notifications, and hook-type events. State changes are NOT events — they are store subscriptions (chapter 1.1); chapter 3.3 enumerates the "…/changed" names that are consequently excluded from the official catalog.

- **The core (EventBus) does not restrict event names in any way (ruling).** Third-party plugins may freely define, emit, and subscribe to any event name at runtime (type extension via declaration merging). No official event table is ever baked into the runtime, and importing the catalog module below from runtime code is forbidden.
- **The official event catalog exists only in `tools/official-events.mjs`**, consumed by this repository's CI lint (chapter 7 below). The lint is allowlist-based: targeting official plugin sources only, it flags `ctx.emit`/`ctx.on` of any event name outside that catalog — which necessarily catches every excluded "…/changed" name (enumerated in chapter 3.3), with no separate denylist or count needed. This is a development-discipline safeguard of this repository; it imposes nothing on users or third parties.
- **Namespaces are documentation convention only:** official event namespaces (`data/`, `pointer/`, `grid/`, `view/`, `schedule/`, `sync/`, etc.) are reserved by documentation, and third parties should prefix events with their own plugin ID (e.g. `my-plugin/rowsPainted`). The core does not enforce this — the same documented-arbitration approach as the meta-key convention.

### 1.4 The five classic mechanisms

The five remaining core mechanisms — PluginHost, ServiceRegistry, ExtensionPoint, EventBus, and CommandBus — are governed by this corpus where it speaks. **Silence rule (normative):** where a spec is silent, the shipped implementation's behavior as pinned by its test suite governs; a spec amendment records any newly decided behavior. Where this chapter's mechanisms (stores, arbitration) state their own semantics, those statements govern.

In particular, the following are fixed:

- ExtensionPoint (the three strategies `collect` / `first` / `reduce`, and `defineExtensionPoint`).
- CommandBus (command → reversible-patch transactions).
- Resource ownership via `ctx.own()`.
- Error boundary (the containment pattern: a plugin's exception is caught, reported as `core/pluginError`, and never aborts its siblings; `ctx.use` / `ctx.useOptional`, `ctx.emit` / `ctx.on`, and `Disposable` are the fixed context surface).
- Typing via declaration merging (extension of the global `Services` / `Events` / `Commands` interfaces), consolidated into one declaration file per plugin (15 total).

---

## 2. SDK overview (@stargantt/sdk)

The SDK is an official public API: the identical helper surface official plugins build on is published to third parties, so no "quasi-standard loophole" exists. The SDK is embedded in the bundle (the zero-runtime-dependency constraint is preserved). Module map:

| Module | Content | Notes |
|---|---|---|
| `sdk/time` | Working-time engine, duration calculation, duration formatting | Shared by scheduling / snap / load-chart / utilization. The most important shared domain layer. |
| `sdk/cpm` | Critical Path Method (forward/backward pass, float calculation) | Shared by scheduling (critical-path) and tracking (baselines). |
| `sdk/dialog` | Draggable dialog foundation (centered in `ctx.root`) | Used by the tracking / resource / export / scheduling panels. |
| `sdk/dom` | DOM construction helpers, strip open/close, panel foundation | |
| `sdk/color` | Color parsing, contrast calculation, CSS length resolution | Used by task-bars labels and conditional-format. |
| `sdk/frame` | Frame-coalescing scheduler (rAF batching) | The standard coalescing point for store subscription → repaint (chapter 1.1). |
| `sdk/aggregate` | Common types/helpers for time-bucket aggregation | Shared by resource / tracking. |
| `sdk/testing` | Plugin test harness (host startup, service mocks, depsOn consistency check — chapter 7) | Also offered to third parties for plugin testing. |

- The public surface is fixed by explicit exports, and every API is enumerated in `docs/specs/sdk.md` (no implicit quasi-standard).
- The SDK may depend on the core and on the DOM, but never on plugins (dependency direction: core ← sdk ← plugins).

---

## 3. Official event catalog

This catalog exists **for CI lint only** — the core does NOT restrict event names at runtime. It lists the events official plugins are permitted to emit/subscribe; the architecture lint (chapter 7) checks official plugin sources against it. Third parties are unaffected.

The canonical, machine-readable form of this catalog is `tools/official-events.mjs` — the lint authority. The tables in this chapter are a descriptive mirror; if they ever diverge, the `.mjs` file wins and this chapter must be updated to match.

### 3.1 Input-stream events (stateless input)

`pointer/barHover`, `pointer/barDown`, `pointer/barMove`, `pointer/barUp`, `pointer/background`, `grid/rowPointerDown`, `grid/rowPointerMove`, `grid/rowPointerUp`, `grid/rowContextMenu`, `grid/backgroundContextMenu`, `view/scrolled` — stateless input events (the interaction plugin's gesture arbiter is the primary consumer).

### 3.2 Hook and activity-notification events (stateless notification)

`core/pluginError`, `lifecycle/ready`, `data/willApplyTransaction`, `data/didApplyTransaction` (the post-apply settle signal), `schedule/cycleRejected`, `sync/activity`, `sync/sourceSynced`, `sync/sourceFlushed`, `sync/sourceRolledBack`, `sync/lazyRangeLoaded`, `sync/lazyChangesApplied`, `sync/offlineSaved`, `sync/offlineRestored`, `sync/offlineCleared`, `sync/realtimeApplied`, `importexport/applied`, `msprojectio/applied`, `viewerembed/*`, `dashboard/refreshed`, `dashboard/opened`, `dashboard/closed`, `view/bottomPaneResized`, `resourceView/toggled` — stateless notifications. Design note: the data-sync plugin's notifications use one flat `sync/*` namespace, with a single `sync/activity` counter event discriminated by an `area` field rather than per-area counter events (data-sync.md is authoritative for the payloads).

### 3.3 Excluded "…/changed" names (state changes are store subscriptions, not events)

`data/tasksChanged`, `data/linksChanged`, `data/resourcesChanged`, `data/assignmentsChanged`, `rows/changed`, `grid/columnWidthsChanged`, `grid/sortChanged`, `selection/changed`, `filter/changed`, `history/changed`, `focus/changed`, `theme/changed`, `timeline/zoomChanged`, `view/modeChanged`, `i18n/changed`, `calendars/changed`, `baselines/changed`, `baselines/activeChanged`, `evm/changed`, `resourcePool/changed`, `resourcePool/bookingsChanged`, `costTracking/changed`, `portfolio/nodesChanged`, `portfolio/goalsChanged`, `realtime/statusChanged` — these state changes are surfaced by `state.subscribe()` on the corresponding service and are NOT events. The names are excluded from the official catalog; any `emit`/`on` of them in official code is caught by CI lint (a development-discipline safeguard, not a runtime restriction).

---

## 4. Service, event and command reference

### 4.1 Services (28)

Service IDs in this table are shown without the `stargantt.` prefix; the canonical form used everywhere else is `stargantt.<id>`.

| Service ID(s) | Provided by | Notes |
|---|---|---|
| `data`, `fields` | data-store | `data` is store-shaped. `fields` covers custom field definitions. |
| `view`, `timeline`, `theme` | view | `view` unifies the renderer and the view-mode state; viewport / theme tokens / zoomLevel are stores. |
| `rows`, `grid` | tree-grid | Row model and grid. Row set, column widths, and sort are stores. |
| `task-bars` | task-bars | Geometry service. |
| `selection`, `snap`, `filter` | interaction | `selection` and `filter` are store-shaped. Clipboard and zoom control are commands/config, not services. |
| `history` | undo-redo | Store-shaped. |
| `focus` | a11y | Store-shaped. |
| `scheduler`, `calendars`, `critical-path` | scheduling | Schedule diagnostics are internal to the plugin's panel, not a separate service. |
| `baselines`, `progress`, `cost`, `evm` | tracking | All four store-shaped; their mutual references are internal to the plugin. |
| `resource-pool`, `utilization` | resource | The assignment, resource-view and load-chart UI is internal, not separate services. |
| `export` | export | Single facade over export, print, generic import/export, MS Project I/O, Excel I/O, and viewer embedding. |
| `data-sync` | data-sync | Single facade over data sources, lazy load, offline storage, realtime sync, and GraphQL. |
| `portfolio`, `dashboard` | portfolio | `portfolio` exposes `nodes` / `goals` stores; `dashboard` is a facade whose events are retained notifications. |
| `i18n`, `perf-tools` | same-name plugins | `i18n` exposes a `state` store; `perf-tools` is a stateless facade. |

### 4.2 Events

The closed official event set is the catalog in `tools/official-events.mjs`, mirrored in chapter 3: the input streams of 3.1 and the hooks/notifications of 3.2. State changes are store subscriptions, not events — the "…/changed" names of 3.3 are excluded and lint-enforced (chapter 7).

### 4.3 Commands (35)

All mutations go through the command system (command → reversible patch). The official commands: `task/*` (5), `link/*` (3), `resource/*` (3), `assignment/*` (2), `history/*` (3), `view/*` (11), `timeline/*` (2), `schedule/*` (2), `clipboard/*` (3), `edit-dialog/open`. The per-plugin specs are authoritative for each command's payload and patch semantics.

---

## 5. Layer structure

```
Layer 0  core, sdk
Layer 1  data-store
Layer 2  view
Layer 3  tree-grid
Layer 4  task-bars
Layer 5  interaction, undo-redo, a11y
Layer 6  scheduling
Layer 7  tracking, resource
Layer 8  export, data-sync, portfolio, i18n, perf-tools
```

- Service consumption (`ctx.use`) is allowed only toward lower layers. Acting on upper layers happens only via extension-point contribution and command emission.
- Same-layer references are optional-only (e.g. tracking ⇄ resource cost integration).
- task-bars occupies its own layer (4) above tree-grid so that its hard dependency on row geometry (`stargantt.rows`) points strictly downward (ruling). tree-grid's decorations still reach task-bars through the `taskbars/*` extension points — the sanctioned upward direction.
- **Type-only imports are exempt from the layer rule** (ruling): `import type` from an upper-layer package erases at compile time (no runtime edge) and is the sanctioned way to type an upward extension-point contribution. The upper package goes in `devDependencies` (never `dependencies`). Value imports remain strictly layered; the CI lint enforces the distinction.

---

## 6. Quantitative targets

| Metric | Target |
|---|---|
| Plugin count | 15 |
| Service count / of which store-shaped | 22 / ~15 |
| Official event kinds | ~20 (managed by lint via the official catalog; third-party event additions remain free) |
| Declaration-merging file count | 15 (one `types.ts` per plugin) |
| Extension point count | ~25, soft target (internalizing the grid-lines / today-line / calendars contributions removes points, while dependency-inversion seams add them — e.g. `renderer/rowGeometry` letting the view plugin read row geometry without an upward row-model dependency, and interaction's `snap/workingTime` / `snap/pushGuards` / `drag/lanes` inverting what would otherwise be upward service edges; every third-party extension surface is preserved. The per-plugin spec files are authoritative for the exact set) |
| Cross-plugin service references (total) | ≤ 70 (the view and interaction consolidations internalize the majority) |
| Max lines per file | 800 (enforced in review) |

---

## 7. Mechanical enforcement (CI)

- **Dependency-direction linter:** cross-checks each plugin's package.json dependencies plus `ctx.use` target services against providing plugins; layer-structure (chapter 5) violations and cycles fail the build (script: `tools/lint-deps.mjs`).
- **Official event catalog check:** targets official plugin sources only; matches the first-argument literals of `ctx.emit` / `ctx.on` against the official catalog (chapter 3). Third-party code is out of scope — the lint is a development discipline of this repository, not a runtime mechanism.
- **depsOn consistency check:** mechanical verification, via the `sdk/testing` harness, that declared hard dependencies match actual non-optional `ctx.use`.
- **Core size gate:** core minified size capped at 12KB.
- **z-order table generation:** a Markdown table is generated from `host.orders("renderer/layers")` into `docs/specs/render-order.md` and reviewed via commit diff (hand-written tables abolished).

---

## 8. Third-party principles

The mechanisms official plugins use are **exactly** the mechanisms third parties can use. There are no back-door APIs; officialness confers no runtime privilege.

- **EventBus event definition is unrestricted.** Any plugin — official or third-party — may define, emit, and subscribe to any event name. The core never validates event names at runtime; the official catalog (chapter 3) exists solely for this repository's CI lint of official sources.
- **Declaration merging is open to all plugins.** Third parties extend the global `Services` / `Events` / `Commands` interfaces via `declare module "@stargantt/core"` exactly as official plugins do.
- **Extension-point contribution is open to all plugins.** Every extension point defined by an official plugin (all `collect` / `first` / `reduce` points) accepts third-party contributions on equal terms. Where a cross-plugin collaboration is fulfilled internally, the extension point itself remains defined and continues to accept third-party contributions (e.g. `grid/columns` remains a collect point even though the task-fields columns are contributed internally).
- **The arbitration mechanisms are open to all plugins.** `claimOrder` / `claimKey` / `claimSlot` and `host.orders` are public core APIs; third parties claim render orders, meta keys, and overlay slots through the same registries as official plugins, with the same conflict detection.
- **Official namespaces are reserved by documentation convention only, never enforced in core.** Official event namespaces (`data/`, `pointer/`, `grid/`, `view/`, `schedule/`, `sync/`, …), service IDs (`stargantt.*`), and claimed keys/orders/slots are reserved in documentation; third parties should prefix their own tokens with their plugin ID. The core performs no namespace policing — conflicts on claimed tokens are surfaced by the arbitration registries (chapter 1.2), and everything else is convention.
- **The SDK is the same for everyone.** `@stargantt/sdk` is a published, documented API (see `sdk.md`); third-party plugins build on the identical helpers, including the `sdk/testing` harness.
