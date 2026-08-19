// tools/official-events.mjs
//
// Official event catalog — CI LINT ONLY.
//
// This module is consumed exclusively by tools/lint-deps.mjs to check `ctx.emit`
// / `ctx.on` call sites in OFFICIAL PLUGIN SOURCES against v2's closed event
// catalog (see docs/specs/architecture.md, "Official event catalog"). It is a
// development-time discipline for this repository only.
//
// DO NOT import this module from any runtime code (packages/core, packages/sdk,
// or any packages/plugins/*/src file that ships in the bundle). The core does
// not — and must not — restrict event names at runtime (architecture.md 1.3,
// 3, 8): third-party plugins remain free to define, emit, and subscribe to any
// event name. Baking this catalog into the runtime would violate that
// "no back-door APIs" principle.
//
// Plain JS (.mjs) on purpose, not TypeScript: tools/lint-deps.mjs runs this
// directly via `node` with no build step, so no `as const` / type-only syntax.

// Core lifecycle / error-boundary events.
const CORE_EVENTS = ["core/pluginError", "lifecycle/ready"];

// Hook-type events (stateless notification hooks other plugins can observe).
const HOOK_EVENTS = ["data/willApplyTransaction", "data/didApplyTransaction", "schedule/cycleRejected"];

// Input-stream events (stateless input; interaction's gesture arbiter is the
// primary consumer). See architecture.md 3.1 / 4.2.
const INPUT_STREAM_EVENTS = [
  "pointer/barHover",
  "pointer/barDown",
  "pointer/barMove",
  "pointer/barUp",
  "pointer/background",
  "grid/rowPointerDown",
  "grid/rowPointerMove",
  "grid/rowPointerUp",
  "grid/rowContextMenu",
  "grid/backgroundContextMenu",
  "view/scrolled",
];

// Activity / notification events (stateless notifications; NOT "...changed"
// store-replacement events, which are abolished entirely — see
// architecture.md 3.3). Per architecture.md 3.2, `view/bottomPaneResized` and
// `resourceView/toggled` are classified here (hook/activity-notification
// events), not as input streams.
//
// The merged data-sync plugin's activity notifications live in the `sync/*`
// namespace (area-prefixed verbs; see docs/specs/plugins/data-sync.md), and
// the three per-area `*/activity` counters merge into one discriminated
// `sync/activity`. The old names — datasource/*, offline/*, lazyload/*,
// realtime/applied — are DELETED from this catalog; residual emit/on of them
// in official sources is exactly what this lint exists to catch.
const ACTIVITY_EVENTS = [
  "sync/sourceSynced",
  "sync/sourceFlushed",
  "sync/sourceRolledBack",
  "sync/lazyRangeLoaded",
  "sync/lazyChangesApplied",
  "sync/offlineSaved",
  "sync/offlineRestored",
  "sync/offlineCleared",
  "sync/realtimeApplied",
  "sync/activity",
  "importexport/applied",
  "msprojectio/applied",
  "viewerembed/readOnlyChanged",
  "viewerembed/snapshotApplied",
  "dashboard/refreshed",
  "dashboard/opened",
  "dashboard/closed",
  "view/bottomPaneResized",
  "resourceView/toggled",
];

export const OFFICIAL_EVENTS = Object.freeze([
  ...CORE_EVENTS,
  ...HOOK_EVENTS,
  ...INPUT_STREAM_EVENTS,
  ...ACTIVITY_EVENTS,
]);
