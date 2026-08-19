import { T0 } from "../../../lib/data";
import type { AnyPlugin, PluginDoc, StarGanttApi } from "../../types";

const DAY = 86_400_000;
const d = (n: number): number => T0 + n * DAY;

/**
 * `stargantt.data-sync` is one facade covering data transport end to end. One factory call
 * provides all four areas (`sources`/`active`/`autoLoad` for full-snapshot + delta sync,
 * `lazyLoad` for paged loading, `offline` for IndexedDB persistence, `realtime` for a push
 * transport) plus a `graphql` nest for GraphQL as a convenience over the same config. Every one
 * of this page's ten `properties` entries corresponds to exactly one top-level `DataSyncConfig`
 * field — `lazyLoad`, `offline`, `realtime` and `graphql` are each ONE consolidated property
 * covering their whole nested sub-config, not one property per nested field.
 *
 * Events live on a flat `sync/*` namespace (see the D-4 resolution in `data-sync.md`), and every
 * transaction this plugin dispatches carries one of exactly four origins, each prefixed
 * `"stargantt.data-sync/"`.
 *
 * This page never builds one shared `sg.dataSync()` instance for the whole page: most of the ten
 * options are resolved once at setup with no runtime setter (`autoLoad`, `rollbackOnError`,
 * `followFilter*`, everything under `lazyLoad`/`offline`/`realtime`/`graphql` except the registries'
 * own runtime methods), so two different values need two differently configured `dataSync(...)`
 * calls — which would collide with any shared base instance the moment a reader picked a
 * non-default value. So `demo` is deliberately empty and each demonstrable property builds its own
 * complete instance, the same discipline this library's other multi-nest plugin pages use.
 */

/**
 * Backend data for the source-area demos, deliberately unlike the shared sample: three tasks and a
 * milestone all inside the default ~week-wide viewport, with names that read at a glance as "this
 * came from a server" rather than "this is the sample dataset with one field tweaked".
 */
const SOURCE_BACKEND_TASKS = [
  { id: "b1", parentId: null, name: "Backend: onboarding", type: "summary" as const, start: d(0), end: d(6) },
  { id: "b2", parentId: "b1", name: "Backend: contract review", start: d(0), end: d(3), progress: 1 },
  { id: "b3", parentId: "b1", name: "Backend: kickoff call", start: d(3), end: d(6), progress: 0.2 },
  { id: "b4", parentId: null, name: "Backend: go-live", type: "milestone" as const, start: d(6), end: d(6) },
];

/**
 * Eight flat, one-day tasks for the lazy-area demos, none of them nested under a summary, so a
 * paged fetch is exactly "N tasks appear" with nothing folded to complicate a row count.
 */
const LAZY_BACKEND_TASKS = [
  { id: "l0", parentId: null, name: "Backend row 0", start: d(0), end: d(1) },
  { id: "l1", parentId: null, name: "Backend row 1", start: d(1), end: d(2) },
  { id: "l2", parentId: null, name: "Backend row 2", start: d(2), end: d(3) },
  { id: "l3", parentId: null, name: "Backend row 3", start: d(3), end: d(4) },
  { id: "l4", parentId: null, name: "Backend row 4", start: d(4), end: d(5) },
  { id: "l5", parentId: null, name: "Backend row 5", start: d(5), end: d(6) },
  { id: "l6", parentId: null, name: "Backend row 6", start: d(6), end: d(7) },
  { id: "l7", parentId: null, name: "Backend row 7", start: d(7), end: d(8) },
] as const;

/**
 * Triggers the first lazy-load page manually, after the chart's starting data (empty, for every
 * demo below) has landed — rather than through `lazyLoad.autoLoad`, whose `lifecycle/ready` fetch
 * races this site's own post-`create()` `load()` call: that `load()` is itself a bulk store
 * replacement, which bumps the lazy area's async generation counter (data-sync.md §6.1) and
 * silently discards autoLoad's in-flight fetch as "superseded" the instant it resolves — no error,
 * no event, just an empty store. Waiting for the `tasks` store's own first notification sidesteps
 * the race entirely: by the time this fires, the bulk replacement that would have superseded an
 * autoLoad fetch has already happened.
 */
function fetchFirstLazyPage(sg: StarGanttApi, pageSize: number): AnyPlugin {
  return sg.definePlugin({
    meta: { id: "docs.data-sync-lazy-fetch", dependsOn: ["stargantt.data-sync", "stargantt.data-store"] },
    setup(ctx) {
      const data = ctx.use("stargantt.data");
      const off = data.tasks.subscribe(() => {
        off.dispose();
        void ctx.use("stargantt.data-sync").lazy.ensureRange(0, pageSize);
      });
      ctx.own(off);
    },
  });
}

/** An in-memory range adapter over a fixed task list — the shape `lazyLoad.sources` expects. */
function makeLazyAdapter<T extends { id: string }>(
  tasks: readonly T[],
): { fetchRange: (request: { offset: number; limit: number }) => Promise<{ tasks: T[]; total: number }> } {
  return {
    fetchRange: (request) =>
      Promise.resolve({
        tasks: tasks.slice(request.offset, request.offset + request.limit) as T[],
        total: tasks.length,
      }),
  };
}

/** The rows a stubbed GraphQL endpoint answers with. */
const GRAPHQL_TASKS = [
  { id: "g1", parentId: null, name: "From GraphQL: schema review", start: d(0), end: d(3), progress: 1 },
  { id: "g2", parentId: null, name: "From GraphQL: resolver work", start: d(2), end: d(6), progress: 0.4 },
  { id: "g3", parentId: null, name: "From GraphQL: cutover", type: "milestone" as const, start: d(7), end: d(7) },
];

const LOAD_QUERY = `query LoadTasks($query: String, $criteria: JSON) {
  tasks(query: $query, criteria: $criteria) { id parentId name start end progress type }
}`;

/**
 * The whole reason this can be demonstrated on a site with no back end: `fetch` is config, not a
 * global the adapter reaches for. This answers the single POST the adapter makes with a standard
 * GraphQL envelope, whose single root field the adapter unwraps by itself — everything downstream
 * of the request is the real code path a live endpoint would drive.
 */
function stubbedEndpoint(): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify({ data: { tasks: GRAPHQL_TASKS } }), {
      headers: { "Content-Type": "application/json" },
    }),
  );
}

/** The overview chart's own data: short enough that a row arriving after it is on screen. */
const REALTIME_LOCAL_ROWS = [
  { id: "local-a", parentId: null, name: "Loaded by this page", start: d(0), end: d(3) },
  { id: "local-b", parentId: null, name: "Also loaded by this page", start: d(2), end: d(5) },
] as const;

/**
 * Registers a transport named `"peer"` that opens immediately and, on the next macrotask (after
 * `GanttPreview` has already loaded its own data), delivers one `changes` message adding a task.
 * The macrotask delay matters: `realtime.connect` runs synchronously inside `create()`, before
 * `GanttPreview` calls `data.load(...)`, so a synchronous push here would be overwritten the
 * instant that load lands — deferring one tick means the pushed task survives it instead.
 */
function peerPushDemo() {
  return {
    plugins: (sg: StarGanttApi) => [
      sg.dataSync({
        realtime: {
          transports: {
            peer: {
              connect(handlers: { onOpen(): void; onMessage(message: unknown): void }) {
                handlers.onOpen();
                setTimeout(() => {
                  handlers.onMessage({
                    type: "changes",
                    changes: [
                      {
                        type: "upsert",
                        task: { id: "peer-note", parentId: null, name: "Pushed by a peer", start: d(1), end: d(3) },
                      },
                    ],
                  });
                }, 0);
              },
              disconnect() {
                /* the demo transport never drops on its own */
              },
            },
          },
          connect: "peer",
        },
      }),
    ],
  };
}

const doc: PluginDoc = {
  id: "stargantt.data-sync",
  summary:
    "The complete external-data connectivity set: REST/GraphQL full snapshots with token-based delta sync and optimistic write-back, lazy paged loading, IndexedDB offline snapshots, and realtime transport application — one facade, five areas, default-off.",
  overview: [
    "This plugin owns none of the chart's data model — that is data-store's job — and it draws nothing. What it owns is every conversation with whatever holds the data before or after it reaches the store: a REST or GraphQL endpoint for full snapshots and deltas, a paged backend for datasets too large to load at once, the browser's own IndexedDB for offline persistence, and a WebSocket or SSE channel for other clients' live edits. Four areas, one service (`stargantt.data-sync`), reached as `sources`/`active`/`load`/`sync`/`flush`/`rollback` for the source area and `lazy`/`offline`/`realtime` as three nested sub-services for the rest.",
    "Everything here is service-driven and default-off. With nothing registered and nothing activated in any area, composing this plugin changes nothing about the chart: no request goes out, no database opens, no timer starts, nothing paints differently. That matters because it means you can add `dataSync()` to a chart that already works and nothing breaks until you actually register and activate something — the plugin waits for you rather than reaching for a network or IndexedDB the moment it exists. The four areas are also independent of each other: composing a source and a realtime transport together does not require them to agree on anything, and using only one area (lazy loading, say) costs nothing from the other three.",
    "Every write this plugin makes — on a full load, a delta sync, a lazy page, an applied realtime message, or a rollback — goes through the ordinary `task/add`, `task/update` and `task/remove` commands data-store already defines, stamped with one of four `\"stargantt.data-sync/\"`-prefixed origins so a listener (or the export plugin's read-only veto) can tell a backend-driven change from a reader's own edit by a simple prefix test. All four are ordinary service calls, so a host builds its own \"Refresh\" button, save indicator, connection badge or retry logic on top rather than being handed one.",
  ],
  whenYouNeedIt:
    "the task list does not already live in memory as a plain array you control end to end. If you already have the rows, call `stargantt.data`'s `load()` yourself and skip this plugin entirely — it exists for the case where fetching, paging, persisting offline, or reflecting other clients' edits is itself the problem to solve, and it is deliberately opt-in rather than in the standard preset because a chart with no backend should not carry the machinery for one.",
  demo: {},
  // The smallest thing this plugin can be seen doing: register one adapter, activate it, and let
  // the startup load put its rows in the store. `localAdapter` keeps the whole exchange in the
  // page — a reader swaps it for `restAdapter`, `graphqlAdapter`, or their own object and the rest
  // is unchanged.
  overviewDemo: {
    kind: "configured",
    spec: {
      plugins: (sg) => [
        sg.dataSync({
          sources: { demo: sg.localAdapter({ tasks: SOURCE_BACKEND_TASKS }) },
          active: "demo",
          autoLoad: true,
        }),
      ],
    },
    caption:
      "Every row here came out of the adapter, not out of the page: the chart mounts with this site's sample data and the startup load() — stamped with origin \"stargantt.data-sync/sync\" — replaces it with the four rows named Backend.",
  },

  properties: [
    {
      name: "sources",
      prose: [
        "Registers named adapters for the *full-snapshot source area* at startup — the same effect as calling the service's `sources.register(name, adapter)` once per entry, just done before the chart's first paint. This registry is separate from `lazyLoad.sources` (paged adapters) and `realtime.transports` (push transports), each documented under its own property below; an adapter here needs a `fetch` method, optionally `fetchDelta` and `push`. Registering a source does not activate it and does not fetch anything; it only makes the name usable by `active` (here or later, via `sources.activate`).",
        "An entry with no `fetch` function, or a key that is not a usable string, is silently dropped rather than throwing (the library's general rule for unusable config: a malformed entry is ignored, not fatal). If a source you registered here never seems to load anything, check the adapter object actually has a `fetch` method before looking anywhere else — a typo'd factory call or a plain data object passed by mistake fails this way, quietly.",
        "By itself this option paints nothing at all: a registered-but-inactive source is inert, and an active source with no load or sync yet run is equally inert. See `autoLoad` below, whose demo registers a source through this exact option and then shows what appears once it is also active and loaded — that is this option's visible effect, just attached to the flag that actually triggers it.",
      ],
      demo: {
        kind: "none",
        reason:
          "Registering an adapter changes nothing on screen until it is also active and something has loaded or synced from it — showing that combination needs its own dataSync() instance, and this page's one collision-safe instantiation for the source area is already spent making that exact combination visible on autoLoad below.",
      },
    },
    {
      name: "active",
      prose: [
        "Selects, from whatever `sources` registered, the one name that `load()`, `sync()` and `flush()` act on. Naming an entry that `sources` did not register (a typo, or a name meant for a source you register later through the service) is ignored — the plugin starts with no active source rather than throwing, the same as if `active` were left out.",
        "Switching the active source at runtime — through the service, since this option only sets the *startup* value — drops the held sync token and any pending local edits, and bumps the internal generation counter that makes a still-in-flight request against the old source unable to touch the store. That is not a bug to work around: a token and a pending-edit set are both baselined against one backend's state, and carrying them across to a different backend would apply changes computed against data the new source never returned.",
        "Like `sources`, this option has no pixel of its own: naming an active source that nothing has yet loaded from looks identical to no source being active at all. `autoLoad` below sets both `sources` and `active` and is the option whose value actually decides whether anything appears.",
      ],
      demo: {
        kind: "none",
        reason:
          "An active source with nothing loaded from it yet renders identically to no source at all, so this option alone has no honest before/after chart — showing the difference needs the same dataSync() instance autoLoad's demo already builds, and this page can only safely mount one for the source area.",
      },
    },
    {
      name: "autoLoad",
      prose: [
        "The one flag that turns a registered, active source into visible data. With it off — the default — a chart can carry `sources` and `active` all day and render exactly as if neither were set; the store keeps whatever it started with until something calls `load()` or `sync()` explicitly. With it on, one `load()` runs on `lifecycle/ready`, replacing the store's contents with whatever the active adapter's `fetch()` returns.",
        "This is a one-shot at startup, not a standing subscription — it does not mean \"keep this chart in sync with the backend\", it means \"populate it once from the backend instead of from whatever `data` the chart was created with\". A chart that also passed rows via the ordinary load path has that data discarded the moment this load resolves; do not do both if the flash of the original rows mid-load would be confusing to a reader.",
        "Because the load is async, there is a real window — one network round trip, however short — during which the store still holds its starting contents (empty, or whatever `data` supplied). A reader who expects the backend's data to be there immediately on mount should treat this the way any other async fetch is treated: with a loading state, not an assumption that the chart is already populated on the first frame. It runs on `lifecycle/ready` rather than synchronously inside `setup()`, specifically so a boot load never races a later-tiered plugin's own subscriptions.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (off)", demo: {} },
          {
            label: "true, with a registered and active local source",
            demo: {
              plugins: (sg) => [
                sg.dataSync({
                  sources: { demo: sg.localAdapter({ tasks: SOURCE_BACKEND_TASKS }) },
                  active: "demo",
                  autoLoad: true,
                }),
              ],
            },
          },
        ],
      },
    },
    {
      name: "rollbackOnError",
      prose: [
        "Decides what happens to a *local* edit after `flush()` pushes it and the backend says no. The default, `true`, treats a rejected push the way an optimistic-UI pattern is supposed to: the edit is reversed in the store through ordinary store commands (origin `\"stargantt.data-sync/rollback\"`), so the chart snaps back to the last backend-confirmed state and a reader is never left looking at a change the server never accepted.",
        "Setting it `false` keeps the local edit exactly as it was, un-reverted, and stops treating it as pending (it will not be resent on the next `flush()`). That trade only makes sense when your own code is going to look at the resolved `error` and decide what to do — retry, prompt the reader, queue it differently — because with rollback off, nothing else in the plugin will reconcile the local state with the backend's rejection for you.",
        "Rollback restores task fields only, using the first-seen prior values for each key it reverses, and it never reverts an id that has already picked up a *new* pending edit by the time the push settles — that edit is the reader's own later work, not part of the rejected batch. If a task you deleted locally is re-added by rollback, the links and assignments that were cascade-removed along with it do not come back — a known limitation, task rows only.",
      ],
      demo: {
        kind: "none",
        reason:
          "Seeing this requires driving a real sequence — load from a source, edit a task, call flush() against a backend written to reject the push, then compare the chart with rollback on versus off — and every step after the load needs the same dataSync() instance autoLoad's demo already spends this page's one collision-safe source-area instantiation on.",
      },
    },
    {
      name: "followFilter",
      prose: [
        "Binds the stored server-side filter to the interaction plugin's `stargantt.filter` service — always present, since interaction is one of `presetStandard()`'s nine plugins. Every notification on that service's `state` store while a source is active schedules a reload, debounced by `followFilterDebounceMs`, so a large dataset can be narrowed on the backend instead of hidden row-by-row in the browser after being shipped whole.",
        "The trigger is a store notification: the reload itself never runs on the filter store's own dispatching stack, it is only ever scheduled from there — the corpus-wide rule that a store subscriber schedules work rather than performing it inline. It is otherwise a soft integration: nothing breaks if no filter state is ever set, this option simply never fires. But while it is on, it owns the filter slot outright: every change overwrites whatever `setFilter()` last held, unconditionally, with no merge. A host that also needs a standing base condition (\"only this project\") alongside the reader's interactive filter has to fold that base condition into what it hands to the interaction plugin's own criteria, or skip this option and subscribe to `state` itself to compute the merge before calling `setFilter()`.",
        "This is squarely a large-dataset feature: on a chart small enough that a client-side filter is instant, the round trip this option adds is pure latency with no benefit. Reach for it once the dataset is big enough that walking every row in the browser on every keystroke is the slower path.",
      ],
      demo: {
        kind: "none",
        reason:
          "The effect is a narrower dataset after a debounced network round trip, which needs a live dataSync() instance actually receiving filter-state changes and reloading from a real adapter — a live sequence beyond what a static before/after chart comparison can show, and this page's one collision-safe source-area instantiation is already spent on autoLoad above.",
      },
    },
    {
      name: "followFilterDebounceMs",
      prose: [
        "How long `followFilter` waits after the last `state` notification before it reloads — 200ms by default, so a reader typing a search query does not fire one request per keystroke. Passing `0` still arms a zero-delay timer rather than reloading synchronously on the notifying stack (the store re-entrancy rule holds even at zero); a negative or non-finite value is treated as unset and falls back to the default rather than erroring.",
        "This only has anything to time when `followFilter` is `true`; set alone, it configures a delay for a reload that never happens. Tune it down for criteria changes (a checkbox in a filter panel, where each change is deliberate and infrequent) and up for free-text query boxes on a slow or rate-limited backend, where a request per keystroke is wasteful even at normal typing speed.",
      ],
      demo: {
        kind: "none",
        reason:
          "This tunes the timing of a reload that only exists when followFilter is also on, and demonstrating a delay difference on top of that would need the same live sequence followFilter itself cannot show on this page — a picker could not honestly show a timing difference as a static screenshot comparison in any case.",
      },
    },
    {
      name: "graphql",
      prose: [
        "Builds and registers one `graphqlAdapter(config.graphql)` at setup, iff both `url` and `operations.load` are non-empty strings — otherwise the whole nest is a complete no-op, not a broken adapter that fails on first use. GraphQL is a config nest rather than a separate plugin specifically so registration and the top-level `autoLoad` check happen inside this one plugin's own setup in the right order — `dataSync({ graphql: { ..., activate: true }, autoLoad: true })` loads from GraphQL on startup with no workaround needed.",
        "There are no default documents. A REST adapter can guess a URL shape from a base path; a GraphQL schema is application-specific down to field names, so `operations.load`, `operations.delta` and `operations.push` each have to be supplied as literal query/mutation strings or the corresponding capability simply does not exist on the adapter. `select` is the escape hatch for a reply shape the default unwrapping (the single root field of `data`, or `data` itself with more than one) gets wrong; `headers` and the injectable `fetch` exist for auth tokens and for making the adapter testable without a network, which is exactly how this page's own demo talks to a `graphqlAdapter` with no server behind it.",
        "`name` (default `\"graphql\"`) is the key this source registers under in the *same* `sources` registry the top-level `sources` option populates — the two are one registry, so a composition that also registers a REST source needs a distinct name here to avoid the second `sources.register()` call silently replacing the first.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (absent — nothing registered)", demo: {} },
          {
            label: "a GraphQL endpoint, activated and loaded on startup",
            demo: {
              plugins: (sg) => [
                sg.dataSync({
                  graphql: {
                    url: "https://example.com/graphql",
                    operations: { load: LOAD_QUERY },
                    fetch: stubbedEndpoint,
                    activate: true,
                  },
                  autoLoad: true,
                }),
              ],
            },
          },
        ],
      },
    },
    {
      name: "lazyLoad",
      prose: [
        "The paged-loading area, for a dataset too large to hand `stargantt.data`'s `load()` in one call. `lazyLoad.sources` and `lazyLoad.active` register and select a *separate* registry of range adapters — any object with a `fetchRange({ offset, limit, cursor? })` method — from the full-snapshot `sources`/`active` above; there is no bundled REST or GraphQL range adapter, because a paged backend's request shape (offset-based, cursor-based, page-number-based) varies enough between real APIs that a one-size adapter would fit almost none of them.",
        "`autoLoad` here is the paged equivalent of the top-level flag: one `ensureRange(0, pageSize)` on `lifecycle/ready`, once, not a subscription — a ten-thousand-row dataset served in pages of 500 still only has the first page in the store until something asks for more. `pageSize` (default 500) is a request size, not a promise: an adapter is free to return fewer rows, especially on the last page, and the plugin accepts that without complaint; a value that is not a finite integer ≥ 1 falls back to the default.",
        "`followViewport` and `prefetchPages` turn scrolling itself into the trigger, once both `stargantt.view` and `stargantt.tree-grid`'s row service resolve (both always true under `presetStandard()`): every scroll computes the visible row range and calls `ensureRange` over it, extending one page past the loaded edge so a reader who reaches it keeps pulling data instead of hitting a wall. `prefetchPages` (default 1) reaches further still, in the direction of active scrolling only, estimated from real scroll velocity — at rest, nothing is prefetched regardless of the value; `0` disables it outright rather than falling back to the default.",
        "Applied pages are strictly add-only — a row whose id the store already holds is skipped, never replaced — so a chart created with `data:` already populated does not get a clean handoff to fetched rows; it ends up holding both. Starting the store empty, as every demo below does, is what keeps the two datasets from merging into one list a reader can't tell apart by origin.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (nothing registered)", demo: {} },
          {
            label: "pageSize: 4 (four of eight rows load)",
            demo: {
              data: [],
              plugins: (sg) => [
                sg.dataSync({
                  lazyLoad: {
                    sources: { demo: makeLazyAdapter(LAZY_BACKEND_TASKS) },
                    active: "demo",
                    pageSize: 4,
                  },
                }),
                fetchFirstLazyPage(sg, 4),
              ],
            },
          },
          {
            label: "pageSize: 8 (the whole backend loads in one page)",
            demo: {
              data: [],
              plugins: (sg) => [
                sg.dataSync({
                  lazyLoad: {
                    sources: { demo: makeLazyAdapter(LAZY_BACKEND_TASKS) },
                    active: "demo",
                    pageSize: 8,
                  },
                }),
                fetchFirstLazyPage(sg, 8),
              ],
            },
          },
        ],
      },
    },
    {
      name: "offline",
      prose: [
        "The IndexedDB persistence area: `save()`, `restore()`, `clear()`, `persisted()` and `available()`, reachable headlessly through `service.offline` regardless of whether `autoSave`/`autoRestore` are on. `databaseName` (default `\"stargantt-offline\"`) and `documentKey` (default `\"default\"`) together address one snapshot slot — two charts sharing both values share one slot, which is rarely what you want for unrelated data, so give each chart (or each distinct dataset one chart can load) its own combination.",
        "`autoRestore: true` runs one `restore()` on `lifecycle/ready`, replacing whatever the host just loaded if a usable snapshot exists and doing nothing at all if it does not — the usual pattern is to skip your own initial `data.load()` call and let this supply the starting data instead. `autoSave: true` schedules a `save()` on every `data.tasks` store notification, debounced by `autoSaveDebounceMs` (default 500ms; `0` starts the write on the same stack rather than waiting) so a burst of edits persists once.",
        "`registerSource` (default `true`) and `sourceName` (default `\"offline\"`) register this snapshot as a *read-only* adapter into the same `sources` registry `sources`/`active`/`autoLoad` above use — a fallback the source area can activate when the network is unreachable, gated on the `offline` nest's presence so composing it does not silently add a registry entry you never asked for. `indexedDB` injects the `IDBFactory` this area opens its database through, in place of the global `indexedDB`; the real use is tests and shims, not a production chart.",
      ],
      demo: {
        kind: "none",
        reason:
          "Every field here changes when or where an IndexedDB write happens, or which registry entry gets a fallback adapter — none of it is a pixel the chart paints. A successful save, restore or clear renders identically to one that never ran, so no static chart comparison can show any of these fields doing anything.",
      },
    },
    {
      name: "realtime",
      prose: [
        "The push-transport area: `transports` registers named transports (any object with a conforming `connect`/`disconnect` pair — `webSocketTransport` and `sseTransport` ship in the package), and `connect` names the one to open at startup. Leave `connect` unset and a chart can carry a full transport map all day while rendering exactly as if none of it were there; a message only ever applies once something has actually connected, whether that is this startup value or the service's own `realtime.connect(name)` later.",
        "Once connected, every `changes` message converges the local row to exactly what the peer sent — every incoming field is assigned and every optional field the peer's row omits is cleared, except `orderKey`, which a row that omits it never clears, so a backend that does not round-trip sibling ordering cannot scramble row order. An `upsert` whose row is value-identical to what the store already holds produces no store command at all — no transaction, no undo entry, no repaint — so a naive broadcast-everything backend does not spam the undo stack with pure echoes.",
        "`autoReconnect` (default `true`), `reconnectDelayMs` (default 1000) and `maxReconnectAttempts` (default 5) govern automatic retry after an unexpected close, with capped exponential backoff and full jitter; the attempt counter only resets after roughly 30 seconds of a stable open connection, so a flapping link keeps accumulating attempts toward the cap rather than getting a fresh budget on every brief recovery. `resyncViaDataSource` (default `true`) delegates a bare `resync` message to this plugin's own `sync()` — a token delta when one is held, a full reload otherwise — so a backend that pushes small edits inline but occasionally says \"pull the rest yourself\" hands that off to the source area automatically.",
        "The demo below registers a small transport that opens immediately and, a beat later, pushes one `changes` message adding a task named \"Pushed by a peer\" — a stand-in for a real WebSocket or SSE peer announcing an edit. Watch for the new bar to appear on the timeline; the delay is deliberate, so the pushed row survives this page's own initial data load instead of racing it.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (nothing connected)", demo: {} },
          { label: '"peer" — a transport that pushes a task on connect', demo: peerPushDemo() },
        ],
      },
    },
  ],

  notes: {
    services: {
      "stargantt.data-sync":
        "Everything this plugin does is reachable here, grouped by area: sources/setFilter/filter/load/sync/pending/flush/rollback for the source area, and the lazy/offline/realtime nested objects for the other three. Build your own toolbar — Refresh, Save, a pending-changes badge, a connection indicator — on top of this rather than waiting for one to be provided; none of the four areas renders anything of its own.",
    },
    events: {
      "sync/activity":
        "The merged in-flight counter across three of the four areas (source, lazy, offline — realtime is excluded on purpose, since its own \"connecting\" status already gives a start/terminal pair). Discriminated by `area`, incremented at operation entry and decremented in a `finally`, so a failed operation still reaches zero and a loading indicator can never hang; it fires only when the pending count actually changes.",
      "sync/sourceRolledBack":
        "Fires after a flush-failure rollback or a non-empty explicit `rollback()` call — `cause` tells you which. `source` is absent only on the explicit-`rollback()` path with no active source; the flush path always names one.",
      "sync/realtimeApplied":
        "Fires after every applied `changes` message, including pure echoes, which report all-zero counts. That makes it a useful heartbeat even when nothing visibly changed — a chart that stops receiving these while `realtime.status.get().status` still reads `\"connected\"` has a quiet backend, not a broken one.",
      "sync/lazyRangeLoaded":
        "Fires once per page actually applied, including pages `lazyLoad.followViewport` fetched automatically, not just ones your own code requested via `ensureRange`. `total` is only present once some reply has carried it — treat it as unknown, not zero, until then.",
      "sync/offlineSaved":
        "Fires after every successful save, whether you called it directly or `autoSave` triggered it — the only way to observe an auto-save write without polling `persisted()`.",
    },
    commands: {
      __empty:
        "This plugin registers no commands of its own. Every write it makes — on a full load, a delta sync, a lazy page, a realtime message, or a rollback — is an ordinary task/add, task/update or task/remove dispatch, stamped with one of the four \"stargantt.data-sync/\"-prefixed origins rather than routed through a command this plugin owns.",
    },
    extensionPoints: {
      "storage/snapshot":
        "How another plugin folds its own state into the same offline document — a portfolio's node list, a saved baseline — so it survives an `offline.restore()` alongside the store's five entity lists instead of silently vanishing on reload. `capture()` runs at save time and `apply(state)` at restore time, both in registration order; no official plugin contributes here, it exists for third parties and hosts.",
    },
  },

  recipes: [
    {
      title: "Load once from a REST backend at startup",
      intent:
        "The common case: a JSON API under one base URL, following the plugin's default endpoint conventions, populated as soon as the chart mounts.",
      code: `presetStandard().concat([
  dataSync({
    sources: { api: restAdapter({ baseUrl: "/api/gantt" }) },
    active: "api",
    autoLoad: true,
  }),
])`,
    },
    {
      title: "Optimistic edits with rollback on rejection",
      intent:
        "Let a reader keep editing while a save is in flight, and have a rejected save reverse itself automatically instead of leaving the chart out of sync with the backend.",
      code: `var gantt = create({
  element,
  plugins: presetStandard().concat([
    dataSync({
      sources: { api: restAdapter({ baseUrl: "/api/gantt" }) },
      active: "api",
      autoLoad: true,
      // rollbackOnError: true is the default — spelled out here for clarity.
      rollbackOnError: true,
    }),
  ]),
});

// Call this after your own edit flow, or on an interval, or from a "Save" button —
// the plugin never flushes on its own.
function save() {
  gantt.service("stargantt.data-sync").flush().then(function (result) {
    if (!result.ok && result.rolledBack) {
      // The chart already snapped back; tell the reader why.
      showToast("Save failed — your change was reverted.");
    }
  });
}`,
    },
    {
      title: "Page a REST backend behind a scrolling viewport",
      intent:
        "The common large-dataset shape: a paged endpoint, a startup page so the chart isn't blank on first paint, and viewport-following so scrolling keeps pulling data instead of hitting a wall.",
      code: `presetStandard().concat([
  dataSync({
    lazyLoad: {
      sources: {
        api: {
          fetchRange: ({ offset, limit, cursor }) =>
            fetch(\`/api/tasks?offset=\${offset}&limit=\${limit}\` + (cursor ? \`&cursor=\${cursor}\` : ""))
              .then((res) => res.json()), // { tasks, total, cursor }
        },
      },
      active: "api",
      pageSize: 200,
      autoLoad: true,
      followViewport: true,
      prefetchPages: 2,
    },
  }),
])`,
    },
    {
      title: "Offline-first, with a fallback source when the network drops",
      intent:
        "Persist every change locally and reload it on the next visit; register the same snapshot as a read-only source so a host can fall back to it explicitly when a live fetch fails.",
      code: `plugins: [
  ...presetStandard(),
  dataSync({
    sources: { api: restAdapter({ baseUrl: "/api/gantt" }) },
    active: "api",
    autoLoad: true,
    offline: { documentKey: "my-project", autoSave: true, autoSaveDebounceMs: 800 },
  }),
]
// elsewhere, on a fetch failure:
gantt.service("stargantt.data-sync").sources.activate("offline");
// activate() returns false if "offline" was never registered; the source still
// needs its own load()/sync() call to actually pull the persisted snapshot in.`,
    },
    {
      title: "Reflect a WebSocket peer's edits as they arrive",
      intent:
        "A server pushes JSON frames over a WebSocket whenever any client edits the shared chart, and every other client should pick the change up without a manual refresh — pairing with resyncViaDataSource lets a bulk resync fall back to the source area's own sync().",
      code: `presetStandard().concat([
  dataSync({
    sources: { api: restAdapter({ baseUrl: "/api/gantt" }) },
    active: "api",
    autoLoad: true,
    realtime: {
      transports: { live: webSocketTransport({ url: "wss://example.com/gantt" }) },
      connect: "live",
      reconnectDelayMs: 1000,
      maxReconnectAttempts: 8,
      // resyncViaDataSource: true is the default — spelled out here for clarity.
      resyncViaDataSource: true,
    },
  }),
])`,
    },
  ],
};

export default doc;
