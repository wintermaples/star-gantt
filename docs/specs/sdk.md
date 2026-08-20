# StarGantt SDK (@stargantt/sdk)

Status: normative — the full public API enumeration. Module map and design constraints are summarized in `architecture.md`, chapter 2.

## Principles

1. **One SDK for everyone.** The identical helper API official plugins build on is published to third parties; nothing is held back as internal-only.
2. **Single entry point.** Every symbol is imported from the package root (`@stargantt/sdk`); the module directories are internal structure, not subpath entries. Where this document is silent on a symbol's finer behavior, the silence rule of `architecture.md` chapter 1.4 applies.
3. **The public surface is exactly this document.** Everything enumerated here is exported explicitly; nothing else is exported. No implicit quasi-standard.
4. **Dependency direction: core ← sdk ← plugins.** The SDK may import from `@stargantt/core` (e.g. `PluginContext`, `Services`) and may touch the DOM, but never depends on any plugin.
5. **Distribution.** The SDK is embedded in the `stargantt` bundle (zero-runtime-dependency constraint preserved). All eight modules are re-exported flat from the package root — the only published entry point. The per-module directories exist for documentation structure and source organization; tree-shaking works through the flat ESM entry (`sideEffects: false`).
6. **Placement of symbols the architecture table leaves unassigned.** The eight-module table in `architecture.md` chapter 2 names only each module's headline content. The remaining exports are assigned by this document on consumer/purpose affinity: host-seam fault barriers and message-catalog resolution (`latchedSeam`, `latchedBuilderBarrier`, `resolveCatalog`) and the download/wheel/style DOM oddments go to `sdk/dom`; hot-path paint helpers (`alignHalfPixel`, `sameIdSet`, `forEachVisibleRow`, `lateService`) go to `sdk/frame`; transaction batching (`createTransactionBatcher`) goes to `sdk/aggregate`; strict ISO date parsing (`parseIsoDateStrict`) goes to `sdk/time`.

## Module: sdk/time

The working-time engine, duration calculation and duration formatting — the single shared time domain layer. Consumers: scheduling (calendars, auto-schedule), interaction (snap), resource (load chart, utilization), view (timeline).

Constants:

| Symbol | Value / shape | Purpose |
|---|---|---|
| `MS_DAY` | `86_400_000` | One day in milliseconds. |
| `MS_HOUR` | `3_600_000` | One hour in milliseconds. |
| `MS_MINUTE` | `60_000` | One minute in milliseconds. |
| `MS_SECOND` | `1_000` | One second in milliseconds. |
| `DEFAULT_WORKWEEK` | `Readonly<WorkingCalendar>` | The Monday–Friday, all-day default calendar (no working windows; whole-day granularity). |
| `MAX_SKIPPED_DAYS` | `4000` | The engine's runaway guard when walking for the next/previous working instant. |

Types:

| Symbol | Shape | Purpose |
|---|---|---|
| `TimeRange` | `{ start: number; end: number }` | A half-open epoch-ms interval. |
| `WorkingCalendar` | `{ workingDays; workingHours?; exceptions? }` | The id-less calendar shape the engine evaluates. Windows are ms from UTC midnight; `workingDays` are UTC weekday numbers (0 = Sunday); an exception names a UTC day `"YYYY-MM-DD"` and overrides its working flag and windows. |
| `FormatDurationOptions` | `{ maxFractionDigits?, signed? }` | Options of `formatDurationMs` (0–3 fraction digits, default 1, clamped; `signed` prefixes an explicit sign). |

Functions:

| Symbol | Signature | Purpose |
|---|---|---|
| `isoDay` | `(t: number) => string \| undefined` | The `"YYYY-MM-DD"` UTC day of an epoch-ms instant; `undefined` for non-finite or out-of-range input. |
| `parseIsoDateStrict` | `(s: string) => number \| undefined` | Strict `"YYYY-MM-DD"` parse to UTC-midnight epoch ms; `undefined` on any deviation. |
| `startOfUtcDay` | `(t: number) => number` | UTC midnight of the instant's day. |
| `utcDayOfWeek` | `(t: number) => number` | UTC weekday number, 0 = Sunday … 6 = Saturday. |
| `utcDateKey` | `(t: number) => string` | The instant's UTC date key `"YYYY-MM-DD"`. |
| `isDateKey` | `(s: unknown) => s is string` | Whether a value is a well-formed date key. |
| `dateKeyToTime` | `(key: string) => number \| undefined` | Date key back to UTC-midnight epoch ms. |
| `isWorkingDay` | `(cal, t) => boolean` | Whether the instant's UTC day is a working day under the calendar. |
| `isWorkingInstant` | `(cal, t) => boolean` | Whether the instant falls inside a working window. |
| `hasWorkingHours` | `(cal \| undefined) => boolean` | Whether the calendar declares intra-day working windows (vs. whole-day granularity). |
| `workingIntervals` | `(cal, from, to, out?) => TimeRange[]` | The working intervals inside half-open `[from, to)`, merged, ascending; optional `out` reuse. |
| `nonWorkingIntervals` | `(cal, from, to, out?) => TimeRange[]` | The non-working complement, clipped to the query range. |
| `workingMsBetween` | `(cal, from, to) => number` | Working milliseconds counted in `[from, to)`; 0 when `to` is not after `from`. |
| `addWorkingMs` | `(cal, start, workingMs) => number` | The instant `workingMs` of working time after `start` (lands on `nextWorkingStart` for 0). |
| `subtractWorkingMs` | `(cal, end, workingMs) => number` | The instant `workingMs` of working time before `end` (lands on `previousWorkingEnd` for 0). |
| `nextWorkingStart` | `(cal, t) => number` | The earliest working instant at or after `t`. |
| `previousWorkingEnd` | `(cal, t) => number` | The latest working-window end at or before `t`. |
| `landWorkingEnd` | `(cal, t) => number` | Lands an end instant on a working boundary. |
| `durationUnitMs` | `(ms: number) => number` | The display-unit size (ms) the formatting ladder selects for a magnitude — for round *displayed* durations (e.g. axis steps). |
| `durationUnits` | `() => readonly (readonly [ms, suffix])[]` | The unit ladder as `[size, suffix]` pairs, largest first (day, hour, minute, second, millisecond); a shared frozen structure. |
| `formatDurationMs` | `(ms, options?) => string` | The one duration display rule; `""` for non-finite input. Trailing zeros stripped. |

Symbol count: 27 values + 3 types = 30.

## Module: sdk/cpm

The Critical Path Method engine: forward/backward pass, float calculation, per-link slack. Consumers: scheduling (critical-path, diagnostics), tracking (baselines).

Types:

| Symbol | Shape | Purpose |
|---|---|---|
| `CpmTaskId` | `string \| number` | Task identity. |
| `CpmLinkType` | `"FS" \| "SS" \| "FF" \| "SF"` | The four dependency types. |
| `CpmTask` | `{ id; start; end }` | The task shape the engine needs (epoch ms). |
| `CpmLink` | `{ sourceId; targetId; type; lag? }` | The link shape; omitted/non-finite `lag` reads as 0 ms. |
| `LatestTimes` | `{ latestStart; latestFinish }` | One task's latest values under every successor and the project end. |
| `CriticalTaskIdsOptions` | `{ toleranceMs? }` | Total-float tolerance for criticality; defaults to 1 ms. |

Functions:

| Symbol | Signature | Purpose |
|---|---|---|
| `linkAnchors` | `(type: CpmLinkType) => { source: "start" \| "end"; target: "start" \| "end" }` | The date field each side of a link constrains, per link type. |
| `linkSlack` | `(link, source, target) => number` | The link's current slack in ms given both tasks' dates. |
| `latestTimes` | `(tasks, links) => Map<CpmTaskId, LatestTimes>` | The backward pass: latest start/finish per task. |
| `criticalTaskIds` | `(tasks, links, options?) => CpmTaskId[]` | Task ids whose total float is at or under the tolerance. |

Symbol count: 4 values + 6 types = 10.

## Module: sdk/dialog

The draggable dialog foundation every panel-bearing plugin floats over the chart: centered in the host, drag clamped to the host's box, Escape/close-button/backdrop close, optional modal focus trap. Consumers: tracking, resource, export, scheduling panels.

| Symbol | Kind | Purpose |
|---|---|---|
| `DialogOptions` | type | `{ host; className; label; onClose?; modal?; draggable?; resizable?; closeButton?; width?; minWidth?; maxWidth?; maxHeight?; top?; offsetX? }` — host element (append/clamp cage), accessible name, modality, drag/resize, sizing and opening position. |
| `Dialog` | type | The mounted dialog: `root`, `header`, `body`, lazily-created `footer`, `focus()`, idempotent `dispose()`. |
| `createDialog` | function | `(options: DialogOptions) => Dialog` — builds and mounts the dialog in the host. |

Symbol count: 1 value + 2 types = 3.

## Module: sdk/dom

DOM construction and event helpers, keyboard/focus target logic, bottom-strip height bookkeeping and toggling (panel foundation for `view/bottomPanes` contributors), file download, wheel-delta normalization, inline styling, and the fault barriers for host-supplied DOM seams and text builders.

Types:

| Symbol | Shape | Purpose |
|---|---|---|
| `FocusRestorer` | `{ save(); restore() }` | Records the document's `activeElement` and returns focus to it later (forgetting it after). |
| `StripHeightTracker` | `{ height(); isManual(); selfRequest(dispatch); resized(height); seed(height) }` | One bottom strip's height bookkeeping: distinguishes reader-chosen heights from plugin-derived ones, matching self-requests by origin. |
| `StripToggle` | `{ visible(); set(visible) }` | One strip's visibility toggle. |
| `StripToggleDeps` | `{ initial; currentHeight; readerSized; defaultHeight; apply; onChange }` | What a strip toggle needs from its surroundings. |
| `StylableElement` | `{ style: object }` | The element shape `styled` writes to; real elements and DOM doubles alike. |
| `WheelDeltaInput` | `{ deltaX; deltaY; deltaMode }` | The wheel-event slice `normalizeWheelDelta` reads. |
| `NormalizedWheelDelta` | `{ dx; dy }` | Pixel-space wheel deltas. |

Functions:

| Symbol | Signature | Purpose |
|---|---|---|
| `listen` | `(ctx: PluginContext, target, type, fn, options?) => void` (overloaded for `HTMLElement`/`Document`/`EventTarget`) | Adds an event listener whose removal is owned via `ctx.own()` — the required listener idiom. |
| `findUp` | `(start, pred, root?) => HTMLElement \| null` | Walks ancestors from `start` (stopping at `root`) to the first element matching `pred`. |
| `focusRestorer` | `(doc: { activeElement }) => FocusRestorer` | Creates a focus save/restore pair. |
| `isEditableTarget` | `(target: unknown) => boolean` | Whether the event target is (inside) an enabled input/textarea/select or editable region — keyboard handlers must stand down. |
| `createStripHeightTracker` | `() => StripHeightTracker` | Creates one strip's height tracker. |
| `createStripToggle` | `(deps: StripToggleDeps) => StripToggle` | Creates one strip's toggle; hiding applies height 0 (release), showing replays the reader's height or re-derives the default at that moment. |
| `styled` | `(el: StylableElement, styles: Readonly<Record<string, string>>) => void` | Assigns a record of camelCase inline-style properties — a thin typed loop, not a styling framework. |
| `downloadFile` | `(doc: Document, data: Blob \| ArrayBuffer \| string, filename: string, mimeType?: string) => void` | The one save incantation behind every export `download*` member; never leaks an object URL. |
| `normalizeWheelDelta` | `(e: WheelDeltaInput, pageSizePx?: number) => NormalizedWheelDelta` | Converts line/page delta modes to CSS pixels (16 px per line; `pageSizePx` for page mode). |
| `latchedSeam` | `(fn: (host: HTMLElement, ctx) => void, onFault) => (host, ctx) => boolean` | Fault barrier for a host-supplied render seam: first throw reported once, every later call declines; returns whether the seam ran (caller paints its fallback on `false`). |
| `latchedBuilderBarrier` | `(build, fallback, onFault) => (...args) => string` | Fault barrier for a host-supplied message builder: a throw or non-string return latches to the fallback for the instance's life; `onFault` fires exactly once. |
| `resolveCatalog` | `(defaults, overrides, onFault) => M` | The uniform message-catalog merge: usable overrides (same `typeof` as the default, not `undefined`) win key by key; supplied builders are wrapped in `latchedBuilderBarrier`; non-object `overrides` yields the defaults. |

Symbol count: 12 values + 7 types = 19.

## Module: sdk/color

Color parsing, compositing, contrast arithmetic (WCAG relative luminance) and CSS length resolution. Consumers: task-bars labels, tree-grid conditional-format, view (theme audit).

| Symbol | Kind | Purpose |
|---|---|---|
| `Rgba` | type | `{ r; g; b; a }` — a parsed color. |
| `parseColor` | function | `(value: string) => Rgba \| null` — parses a CSS color string; `null` when unparseable. |
| `composite` | function | `(top: Rgba, bottom: Rgba) => Rgba` — alpha-composites `top` over `bottom`. |
| `relativeLuminance` | function | `(c: Rgba) => number` — WCAG relative luminance. |
| `contrastRatio` | function | `(foreground: Rgba, background: Rgba) => number` — WCAG contrast ratio. |
| `parsePx` | function | `(value: string, fallback: number) => number` — parses a CSS px length; the fallback answers non-finite or non-positive results. |

Symbol count: 5 values + 1 type = 6.

## Module: sdk/frame

The frame-coalescing scheduler (rAF batching with a timer fallback) — the standard coalescing point for store subscription → repaint (`architecture.md` chapter 1.1) — together with the hot-path (per-frame / per-pointer-event) helpers: half-pixel stroke alignment, visible-row walking, repaint-skipping set equality, and memoized late service access.

Types:

| Symbol | Shape | Purpose |
|---|---|---|
| `FrameScheduler` | `{ schedule(); dispose() }` | `schedule()` collapses repeated requests until the pending run fires; `dispose()` cancels and is `ctx.own()`-shaped. |
| `VisibleRowSource` | `{ rowCount(); rowAtY(y); yOf(row); rowHeight(row) }` | The row-geometry surface the visible-row walk reads (the shape the tree-grid rows service publishes). |
| `VisibleRowViewport` | `{ scrollTop; height }` | The viewport slice of the walk. |
| `LateServiceContext` | `{ useOptional(key) }` | The one member of `PluginContext` that `lateService` reads, kept narrow for unit-testability. |

Functions:

| Symbol | Signature | Purpose |
|---|---|---|
| `createFrameScheduler` | `(run: () => void) => FrameScheduler` | Creates the coalescing scheduler around one run callback. |
| `alignHalfPixel` | `(v: number) => number` | `round(v) + 0.5` — half-pixel alignment for crisp 1 px canvas strokes. |
| `sameIdSet` | `<T>(a: ReadonlySet<T>, b: ReadonlySet<T>) => boolean` | Exact set equality, to skip a repaint or a change notification when a new selection is the old one. |
| `forEachVisibleRow` | `(rows: VisibleRowSource, vp: VisibleRowViewport, fn: (row, top, height) => void) => void` | Calls `fn` for every row intersecting the viewport band, in row order; `top` is content-space. |
| `lateService` | `<K extends keyof Services>(ctx: LateServiceContext, id: K) => () => Services[K] \| undefined` | Memoized accessor for an optional service that may be provided after setup; retries until resolved, then caches for the plugin's life. |

Symbol count: 5 values + 4 types = 9.

## Module: sdk/aggregate

Common types and helpers for time-bucket aggregation and atomic multi-patch data changes, shared by the resource and tracking domains. `ResourceBucketInput` is the per-resource, per-bucket hook input of the unified aggregation engine; `createTransactionBatcher` commits a head command plus tail patches as one user-undoable transaction via the `data/willApplyTransaction` hook.

| Symbol | Kind | Purpose |
|---|---|---|
| `ResourceBucketInput` | type | `<R>{ resource; resourceId; resourceName; capacityRate; bucketStart; bucketEnd; workingMs; workingDays; allocated; capacity }` — one aggregation cell as handed to `resourceLoad` / `resourceCapacity` hooks; the `resource` reference is valid only during the call. |
| `AppendableTransaction` | type | `<P>{ origin?; patches: P[] }` — the transaction slice the batcher appends to. |
| `TransactionBatcherContext` | type | `<P>{ on("data/willApplyTransaction", fn) }` — the narrow `PluginContext` slice the batcher needs. |
| `TransactionBatch` | type | `<P>(dispatchHead: (origin: string) => void, tailPatches: readonly P[]) => void` — commits one multi-patch change as a single undo step under the head command's label. |
| `createTransactionBatcher` | function | `<P>(ctx: TransactionBatcherContext<P>, originPrefix: string) => TransactionBatch<P>` — one subscription whose appends are keyed on a per-call unique origin (`<originPrefix>#<n>`), so a foreign transaction can never absorb another batch's patches. |

Symbol count: 1 value + 4 types = 5.

## Module: sdk/testing

The published plugin test harness, offered to third parties on the same terms as the official plugins (purely internal test doubles stay in the repo's dev-only test utilities). It provides host startup against a real core, service mocking, and the mechanical `depsOn` consistency check (`architecture.md` chapter 7): declared hard dependencies must match actual non-optional `ctx.use` calls.

Entry points:

```ts
interface CreateTestHostOptions {
  plugins: readonly AnyPlugin[];
  element?: HTMLElement;          // omitted -> headless: a detached <div> where a DOM exists, else a type-only stand-in
  services?: Record<string, unknown>;  // mock service impls, keyed by service id
}
interface TestHost {
  host: GanttInstance;            // the real instance handle createTestHost booted
  ctxOf(pluginId: string): PluginContext;  // throws if pluginId never registered/ran
  dispose(): void;                // host.dispose(); idempotent
}
function createTestHost(opts: CreateTestHostOptions): TestHost;

function mockStore<T>(initial: T): WritableStore<T>;

function expectDepsConsistency(plugin: AnyPlugin, serviceProviders?: Record<string, string>): void;
// serviceProviders: service id -> provider plugin id (e.g. { "stargantt.data": "stargantt.data-store" }).
// Throws on mismatch, listing both directions.
```

| Symbol | Kind | Purpose |
|---|---|---|
| `createTestHost` | function | Boots a real `@stargantt/core` (`Gantt.create`) with `opts.plugins`, in a test DOM or headless, and returns a `TestHost` for driving and inspecting it. `element` omitted boots headless (a detached `<div>` when a DOM global exists, otherwise a type-only object stand-in — the core only ever references `HTMLElement` as a type). `services`, when given, registers one synthetic provider plugin publishing each entry and transparently adds it as a hard dependency of every plugin in `opts.plugins`, so a mocked service resolves through `ctx.use()`/`ctx.useOptional()` without the caller declaring the synthetic id itself; because every other plugin is forced to run after it, a real plugin registered in the same host that also provides the same service key overwrites the mock (last write to the core's service registry wins — the real implementation is what a consumer observes). `ctxOf(pluginId)` returns the real `PluginContext` captured from that plugin's `setup()` (every registered plugin is wrapped to capture it before delegating); it throws for an id that was never registered or never ran. `dispose()` calls the real `host.dispose()` and is idempotent. Built entirely from the public core surface (`Gantt.create`, `PluginContext`, `AnyPlugin`) — no internal/back-door access. **Limitation:** `services` only fills service *keys*; it does not stand in for a missing `dependsOn` *plugin id* — a plugin declaring a real hard dependency on a provider plugin that is not registered still fails to resolve (`Gantt.create`'s own unregistered-dependency error), so the caller must register a dummy plugin for each such id itself. |
| `mockStore` | function | `createStore(initial)` under a name that reads as "test double" at the call site — the real store contract (synchronous notification, no coalescing, re-entrant `set()` throws) needs no host, so this is a thin, semantically-named re-export. |
| `expectDepsConsistency` | function | Asserts a plugin's declared `meta.dependsOn` exactly matches the provider set implied by its non-optional `ctx.use()` calls during `setup()`; throws listing both directions of any mismatch ("used but not declared" / "declared but not used"), returns normally when they match. Runs `setup()` once against a fully permissive mock `PluginContext` (no real core, no siblings): `use()` records the key and answers with a chain-safe harmless stub (safe to call, index, or coerce to a primitive) so `setup()` runs to completion; `useOptional()` answers `undefined` and is excluded from the comparison. **Limitation: `setup()` only.** Only `ctx.use()` calls made synchronously during `setup()` are recorded; a `ctx.use()` call made from a deferred callback the plugin registers during `setup()` (an event handler, a `lifecycle/ready` listener, and the like) runs after `expectDepsConsistency` has already read the recorded set and is invisible to this check. **`serviceProviders` (service id → provider plugin id).** In the real core, `dependsOn` names provider *plugin* ids while `ctx.use()` takes *service* ids, and these are not required to be the same string (`architecture.md` §4.1 — e.g. `data-store` provides both `data` and `fields`); `@stargantt/core`'s public surface exposes no service-id → provider-plugin-id lookup at runtime (chapter 8, no back-door API), so `expectDepsConsistency` cannot derive that mapping itself. `serviceProviders` closes this gap by having the caller supply it: when given, every recorded key is translated through it before comparison (a key absent from the map passes through unchanged), and the resulting set is deduplicated — so two services from the same provider collapse to that provider's one `dependsOn` entry. An official plugin's test passes the relevant `architecture.md` §4.1 row inline; a third party passes its own map. Omitting the parameter keeps the literal comparison (declared `dependsOn` entries against the raw `ctx.use()` keys), exact only when a plugin's `ctx.use()` keys are themselves the tokens listed in its `dependsOn`. |

DOM doubles, event synthesis, download capture, and slot geometry are out of this module's scope — they remain in the repo's dev-only test utilities. `createTestHost`, `mockStore` and `expectDepsConsistency` are `sdk/testing`'s entire committed function surface; `CreateTestHostOptions` and `TestHost` are its type-only support for `createTestHost` and are not separate entry points.

Symbol count: 3 values + 2 types (`CreateTestHostOptions`, `TestHost`).

## Public export list

Every public symbol of `@stargantt/sdk`, flat and alphabetical. (v) value — function or constant; (t) type-only.

`AppendableTransaction` (t), `CpmLink` (t), `CpmLinkType` (t), `CpmTask` (t), `CpmTaskId` (t), `CreateTestHostOptions` (t, sdk/testing), `CriticalTaskIdsOptions` (t), `DEFAULT_WORKWEEK` (v), `Dialog` (t), `DialogOptions` (t), `FocusRestorer` (t), `FormatDurationOptions` (t), `FrameScheduler` (t), `LateServiceContext` (t), `LatestTimes` (t), `MAX_SKIPPED_DAYS` (v), `MS_DAY` (v), `MS_HOUR` (v), `MS_MINUTE` (v), `MS_SECOND` (v), `NormalizedWheelDelta` (t), `ResourceBucketInput` (t), `Rgba` (t), `StripHeightTracker` (t), `StripToggle` (t), `StripToggleDeps` (t), `StylableElement` (t), `TestHost` (t, sdk/testing), `TimeRange` (t), `TransactionBatch` (t), `TransactionBatcherContext` (t), `VisibleRowSource` (t), `VisibleRowViewport` (t), `WheelDeltaInput` (t), `WorkingCalendar` (t), `addWorkingMs` (v), `alignHalfPixel` (v), `composite` (v), `contrastRatio` (v), `createDialog` (v), `createFrameScheduler` (v), `createStripHeightTracker` (v), `createStripToggle` (v), `createTestHost` (v, sdk/testing), `createTransactionBatcher` (v), `criticalTaskIds` (v), `dateKeyToTime` (v), `downloadFile` (v), `durationUnitMs` (v), `durationUnits` (v), `expectDepsConsistency` (v, sdk/testing), `findUp` (v), `focusRestorer` (v), `forEachVisibleRow` (v), `formatDurationMs` (v), `hasWorkingHours` (v), `isDateKey` (v), `isEditableTarget` (v), `isWorkingDay` (v), `isWorkingInstant` (v), `isoDay` (v), `landWorkingEnd` (v), `latchedBuilderBarrier` (v), `latchedSeam` (v), `lateService` (v), `latestTimes` (v), `linkAnchors` (v), `linkSlack` (v), `listen` (v), `mockStore` (v, sdk/testing), `nextWorkingStart` (v), `nonWorkingIntervals` (v), `normalizeWheelDelta` (v), `parseColor` (v), `parseIsoDateStrict` (v), `parsePx` (v), `previousWorkingEnd` (v), `relativeLuminance` (v), `resolveCatalog` (v), `sameIdSet` (v), `startOfUtcDay` (v), `styled` (v), `subtractWorkingMs` (v), `utcDateKey` (v), `utcDayOfWeek` (v), `workingIntervals` (v), `workingMsBetween` (v)

Totals: 87 symbols — 58 values and 29 types, across 8 modules.
