# Plugin: perf-tools (`stargantt.perf-tools`)

Package: `@stargantt/plugin-perf-tools` — Layer 8.
Status: normative.

## Purpose

The opt-in developer tooling plugin, in two areas — **meter** and **trace**: a frame-time overlay — a small floating readout in the chart pane showing frame rate, rolling average frame time, and a sparkline of recent frame durations against the frame budget — and a start/stop trace recorder capturing per-frame durations, named instant marks, and named counters into a JSON-serializable trace, optionally mirrored to the browser Performance API. The plugin touches no store state, owns no extension point, and never changes what the chart renders: with the overlay hidden it adds zero DOM, and the overlay itself is `pointer-events: none`, so no other plugin's interaction is affected. It has no store-shaped state and emits no events of its own.

Frame sampling is a self-owned `requestAnimationFrame` loop: the view plugin exposes no per-frame event, and a dev tool must also observe frames in which StarGantt paints nothing, so the plugin measures the interval between consecutive callbacks of its own loop. The loop runs only while it has a consumer — the overlay is visible or a recording is active — and is stopped (the pending frame cancelled) otherwise; a composition that hides the overlay and never records performs no per-frame work at all. Without `requestAnimationFrame` the loop never starts: the overlay renders its initial all-zero readout once, recordings capture marks and counters but no frames, and nothing throws.

## 1. Service — `stargantt.perf-tools` → `PerfToolsService`

Public types: `FrameStats` (`fps`, `avgMs`, `maxMs`, `lastMs`, `frames`, `overBudget` — every numeric field 0 with no samples), `PerfTraceFrame` (`{ t, dur }`), `PerfTraceMark` (`{ t, name }`), `PerfTrace` (`startedAt`, `endedAt`, `budgetMs`, `frames`, `marks`, `counters`, `stats` — aggregate stats over the whole recording, not the rolling window; JSON-serializable in one `JSON.stringify` call).

```ts
// packages/plugins/perf-tools/src/index.ts (types in src/types.ts)
import type { Plugin } from "@stargantt/core";

export interface PerfToolsService {
  // --- meter ---
  stats(): FrameStats;
  setOverlayVisible(visible: boolean): void;
  // --- trace ---
  startRecording(): void;
  stopRecording(): PerfTrace | undefined;
  isRecording(): boolean;
  lastTrace(): PerfTrace | undefined;
  exportJson(): string | undefined;
  mark(name: string): void;
  count(name: string, delta?: number): void;
}

export declare function perfTools(config?: PerfToolsConfig): Plugin<void>;
```

Member count: 9.

### 1.1 The rolling window and `stats()`

The frame meter keeps the last `windowSize` frame durations in a preallocated ring buffer (no per-frame allocation). `stats()` summarizes the current window. A duration sample is the delta between two *consecutive* callbacks of the running loop: when the loop stops and later restarts, the first callback after the restart produces no sample — the idle gap is not a frame.

### 1.2 Recording

- `startRecording()` while already recording is a no-op (the running recording continues); `stopRecording()` when not recording returns `undefined`, otherwise it returns the completed `PerfTrace` and remembers it as `lastTrace()`. `exportJson()` is `JSON.stringify(lastTrace())` — `undefined` before the first completed recording; the trace contains only own-enumerable data properties, so the string round-trips.
- A recording captures at most 100,000 frames; past the cap further frames are dropped from the trace (counters and the aggregate stats still accumulate) — the cap bounds memory on a forgotten recorder. `marks` is capped at the same 100,000 with the opposite eviction: the oldest mark is dropped for each new one, so `marks` always reflects the most recent marks.
- `mark(name)` appends an instant mark and `count(name, delta = 1)` increments a named counter (non-finite `delta` ignored) **only while recording**; outside a recording both are no-ops except `mark`'s Performance API mirror (§3). A `name` that is not a non-empty string is ignored. Counters are the intended channel for host- or plugin-instrumented occurrence counts — the plugin never observes siblings' internals itself.
- Disposal while recording stops sampling and discards the unfinished recording (no implied `stopRecording`).

### 1.3 The overlay and the corner slot

One `div.sg-perf-tools` is appended to the view plugin's `chartPaneElement()` when `stargantt.view` resolves, else to the chart root (`ctx.root`) — the plugin has no hard dependency. Properties, all normative:

- **Non-interactive:** `pointer-events: none`; no WCAG target-size obligation arises. It floats above the canvases in its corner of the pane's safe area: `calc(var(--sg-safe-<side>, 0px) + 12px)` on each anchored side, keeping it off the timeline header band and the scrollbar strips; on the rendererless chart-root fallback the `0px` fallbacks place it at the plain corner — correct, since without the view plugin there is no header band to avoid.
- **Corner arbitration:** the corner is acquired through the shared slot registry — `ctx.claimSlot("overlay-corner", position, ["top-left", "top-right", "bottom-left", "bottom-right"])` (architecture.md ch. 1.2). A `{ granted: false, alternative }` answer moves the overlay to the granted alternative corner via that corner's `--sg-safe-*` pair; no free alternative keeps the requested corner (the registry already emitted the warning-level report) — the same rule as the resource.md heatmap. The claim is made at `setup()` when `overlay` resolves `true`; with `overlay: false` it is deferred to the first `setOverlayVisible(true)` — an overlay that never exists squats no corner. The default `position` is `"top-right"`. Deterministic outcome in a full official composition with every corner claimant enabled (resource.md's preset enumeration): scheduling holds top-left, interaction top-right and bottom-right, the resource heatmap bottom-left — all four corners occupied, so this plugin's claim (registered after every Layer-≤7 claimant) answers `{ granted: false }` with no `alternative`, and the overlay keeps its requested `position`, visually overlapping the occupant. That overlap is harmless by construction (`pointer-events: none`, `aria-hidden`), and the registry has already emitted the warning-level report. In compositions where a corner is free, the overlay follows the granted `alternative` instead.
- **Excluded from the accessibility tree:** `aria-hidden="true"` — the readout changes many times a second, and exposing it (or a live region) would flood screen readers with debug noise; a sanctioned dev-tool exception to the a11y-parity rule. The overlay carries no `title` attribute (unobservable on a `pointer-events: none`, `aria-hidden` element).
- **Readout** (`.sg-perf-tools__readout`): text from the `readout` message builder, updated at most every 250 ms (not per frame — text layout is not free in a perf tool). Colors come from CSS custom properties with self-contained fallbacks (`--sg-perf-tools-bg` / `--sg-perf-tools-fg`; defaults `rgba(15, 23, 42, 0.85)` / `#f8fafc`, ≥ 4.5:1 contrast), 11 px monospace.
- **Sparkline** (`canvas.sg-perf-tools__spark`, 120×28 CSS px): one bar per window sample, drawn each loop tick from the ring buffer with no allocation. The budget duration sits at a fixed guide-line height; a bar exceeding the budget both crosses the line and changes color, so over-budget is never conveyed by color alone. Canvas colors are fixed literals (a canvas fill cannot resolve `var()`); a dev overlay does not participate in theming.
- `setOverlayVisible(visible)` shows or hides it at runtime (`display: none` when hidden; the element is created lazily on first show when `overlay: false`). Hidden, the overlay is no loop consumer.

## 2. Failure containment

The `readout` builder is config-supplied foreign code invoked on a loop: it is wrapped in the **latched** builder barrier (`sdk/dom` `latchedBuilderBarrier`) — the first throw emits one `core/pluginError` with `pluginId: "stargantt.perf-tools"`, and the built-in default readout answers every later call for the instance's life. All Performance API calls are individually wrapped and their failures swallowed (§3).

## 3. Performance API mirroring

When `performanceMarks` is enabled (the default) and the environment's `performance` object has the needed functions, instants are mirrored under the `stargantt:` prefix: `mark(name)` ⇒ `performance.mark("stargantt:" + name)` — firing even outside a recording, so hosts can drop instants into a DevTools profile without recording; `startRecording()` ⇒ `performance.mark("stargantt:recording:start")`; `stopRecording()` ⇒ `performance.mark("stargantt:recording:end")` followed by `performance.measure("stargantt:recording", "stargantt:recording:start", "stargantt:recording:end")`. A missing API or a throwing call is silently skipped; the plugin never reads Performance API entries back.

## Extension points

None defined, none contributed.

## Commands

None.

## Events

None emitted (beyond `core/pluginError` from the §2 barrier, which every plugin shares). Subscribed: `lifecycle/ready` (the overlay mount and the late `stargantt.view` resolution — see Dependencies).

## Config

Factory: `perfTools(config?: PerfToolsConfig)`. Every field optional; `perfTools()` ≡ `perfTools({})`; unusable values silently keep their defaults; resolved once at `setup()`.

```ts
export interface PerfToolsConfig {
  overlay?: boolean;
  sparkline?: boolean;
  position?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  budgetMs?: number;
  windowSize?: number;
  performanceMarks?: boolean;
  messages?: Partial<PerfToolsMessages>;
}
```

| Field | Default | Unusable when | Semantics |
|---|---|---|---|
| `overlay` | `true` | anything but the literal `false` keeps the default | whether the overlay exists and is initially visible; `false` creates no DOM (and claims no corner) until `setOverlayVisible(true)` |
| `sparkline` | `true` | anything but the literal `false` keeps the default | whether the overlay includes the sparkline canvas |
| `position` | `"top-right"` | not one of the four corner literals | the requested `overlay-corner` slot (§1.3); the effective corner is the `claimSlot` outcome |
| `budgetMs` | `16.7` | not a finite number > 0 | the frame budget: longer samples count as `overBudget`; the sparkline guide line sits here |
| `windowSize` | `120` | not an integer in [2, 10000] | how many recent frames the rolling window (and sparkline) holds |
| `performanceMarks` | `true` | anything but the literal `false` keeps the default | §3 |
| `messages` | built-in English | per the shared catalog merge rules | Messages table |

## Messages

`PerfToolsMessages` — resolved once at `setup()` with the shared catalog merge rules (`sdk/dom` `resolveCatalog`). Key count: 1.

| Key | Kind | Default |
|---|---|---|
| `readout` | builder `(stats: FrameStats) => string` | `` `${Math.round(stats.fps)} fps · ${stats.avgMs.toFixed(1)} ms` `` |

The builder is per-frame-loop foreign code and latched (§2); the empty string is a usable override value.

## Internal modules

Five files (one declaration-merging file per plugin — architecture.md ch. 1.4):

| Module | Content |
|---|---|
| `index.ts` | factory, config resolution, service assembly, loop ownership |
| `types.ts` | public types + the single `declare module "@stargantt/core"` site (the service; no events) |
| `internal/meter.ts` | ring buffer, sampling loop, `stats()` |
| `internal/trace.ts` | recorder, caps, `PerfTrace` assembly, Performance API mirror |
| `internal/overlay.ts` | overlay DOM, corner claim/placement, readout throttle, sparkline paint |

## Dependencies

`dependsOn` (hard): none. `meta.optional`: `stargantt.view` (L2 — `chartPaneElement()` as the overlay parent; absent, the chart root hosts it). **Resolution timing** follows the scheduling.md §14 pattern: with no hard dependency this plugin's tier carries no ordering guarantee at all, so `stargantt.view` is resolved at `lifecycle/ready` or per use — never latched at `setup()` — and the overlay parents (or re-parents nothing; it mounts once, on whichever parent resolves at mount time inside the `lifecycle/ready` handler). The `claimSlot` call needs no service and follows §1.3's timing. Sibling types arrive via `import type` (devDependencies).

Lifecycle: everything long-lived is owned via `ctx.own()` exactly once — one disposable removes the overlay element (when created) and cancels the currently pending animation frame; re-arming the loop swaps the pending-frame id variable, never registers a new disposable.

## Third-party surface

- **Consumable services:** `stargantt.perf-tools` (`PerfToolsService`) — `stats` / recording / `mark` / `count` instrument third-party plugin code with the same tooling official plugins get; counters are the sanctioned channel for foreign occurrence counts.
- **Contributable extension points:** none defined.
- **Subscribable events:** none.
- **Reserved namespaces / slots (documentation convention only):** the `stargantt.perf-tools` service ID; the `stargantt:` Performance API mark prefix; the `.sg-perf-tools*` class names and `--sg-perf-tools-*` token family; the overlay corner is acquired through the shared `overlay-corner` slot registry, so third parties compete for corners through the same arbitration with `SlotGrant.alternative` fallback. Not enforced in core beyond slot-registry conflict reporting.
