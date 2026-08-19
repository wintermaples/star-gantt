import type { GuideDoc } from "../types";

/**
 * The one opt-in data-layer plugin, `dataSync`, walked nest by nest: sources (REST/GraphQL/local
 * adapters), lazy loading, an offline cache, and realtime updates from other people. The chart
 * draws nothing differently; what changes is what the service can do. Every cell uses an
 * injected in-memory stand-in rather than a real endpoint, and the offline nest's auto-save stays
 * off so a demo never writes to a reader's own IndexedDB.
 */
const doc: GuideDoc = {
  slug: "data-from-a-server",
  title: "Loading data from a server",
  lede: "Getting rows from a backend instead of a literal array — plus paging, an offline cache, and live updates from other people.",
  cells: [
    {
      kind: "prose",
      paragraphs: [
        "This plugin draws nothing. Composing it changes what you can call, not what you see.",
        "`dataSync` is one opt-in factory covering all of it. The source area is the main one: give it an adapter — a small object that knows how to talk to your backend — under `sources`, and it handles the rest. `restAdapter` and `localAdapter` ship with it; `graphqlAdapter` is a third.",
        "Registering an adapter does not fetch anything. The chart below still shows the sample data.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  plugins: (sg) => [
    sg.dataSync({
      sources: {
        rest: sg.restAdapter({
          baseUrl: "https://api.example.com/gantt",
          // Injected so this page makes no real network request.
          fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ tasks: [] }) }),
        }),
      },
    }),
  ],
}`,
      caption: "registered, and doing nothing yet",
      height: 260,
    },
    {
      kind: "prose",
      paragraphs: [
        "Loading happens when you call `load()`, or when you set `autoLoad: true` and let the chart do it at startup.",
        "`sync()` is the cheaper follow-up: it asks the backend only for what has changed. If your adapter cannot do that, it quietly does a full `load()` instead.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  plugins: (sg) => [
    sg.dataSync({
      sources: {
        // localAdapter serves an in-memory document through the same interface a REST one would.
        local: sg.localAdapter({
          tasks: [
            { id: "backend", parentId: null, name: "Loaded from backend", start: Date.now(), end: Date.now() + 6 * 86_400_000 },
            { id: "fetched", parentId: "backend", name: "Fetched row", start: Date.now(), end: Date.now() + 3 * 86_400_000, progress: 0.5 },
          ],
        }),
      },
      active: "local",
      autoLoad: true,
    }),
  ],
}`,
      caption: "`autoLoad: true` — the adapter's own rows replace the sample data, with no network involved",
      height: 260,
    },
    {
      kind: "prose",
      paragraphs: [
        "GraphQL is not a different concept, just a different adapter, registered in the same `sources` map. You supply the query and mutation documents, because only you know your schema.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  plugins: (sg) => [
    sg.dataSync({
      sources: {
        gql: sg.graphqlAdapter({
          url: "https://api.example.com/graphql",
          operations: {
            load: "query LoadTasks($query: String) { project { tasks { id parentId name start end } } }",
            push: "mutation PushTasks($batch: ChangeBatch!) { pushTasks(batch: $batch) { syncToken } }",
          },
          fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: { project: { tasks: [] } } }) }),
        }),
      },
      active: "gql",
    }),
  ],
}`,
      caption: "a GraphQL backend, registered and active",
      height: 260,
    },
    {
      kind: "prose",
      paragraphs: [
        "Edits appear on screen straight away and are queued for the server, not the other way round. You do not turn that on — it is how it works.",
        "`pending()` tells you how many are waiting. `flush()` sends them.",
        "If the server rejects the batch, the edits are rolled back by default — call `rollback()` yourself if you need to trigger it, or set `rollbackOnError: false` if you would rather keep them on screen and decide yourself.",
      ],
    },
    {
      kind: "callout",
      tone: "warn",
      body: "`flush()` sends what was pending when you called it. Edits made while it is in flight go in the next one.",
    },
    {
      kind: "prose",
      paragraphs: [
        "`lazyLoad` is the nest for a plan too big to fetch at once. Give it something that serves pages, and `ensureRange()` fetches the pages a given row range needs.",
        "Rows already in the store are never overwritten by a re-fetched page, so a page cannot clobber an edit.",
        "`followViewport` automates it, but only for a flat list — with a tree or a filter, visible row 40 is not backend row 40, so work out the offsets yourself.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  plugins: (sg) => [
    sg.dataSync({
      lazyLoad: {
        sources: {
          backlog: {
            fetchRange: (req) =>
              Promise.resolve({
                tasks: [],
                total: 4000,
                cursor: "cursor-" + (req.offset + req.limit),
              }),
          },
        },
        active: "backlog",
        pageSize: 200,
        // followViewport is off on purpose: this chart's rows are a tree, not a flat list.
      },
    }),
  ],
}`,
      caption: "a 4,000-row backlog in pages of 200 — nothing is fetched until something asks",
      height: 260,
    },
    {
      kind: "prose",
      paragraphs: [
        "`offline` is not about the network at all. It keeps a copy of the project in the browser, under a key you choose.",
        "`save()`, `restore()` and `clear()` are yours to call; `autoSave` and `autoRestore` do it for you. With a `sources` entry composed too, the cached copy can double as one — a chart has something to show before the first fetch returns.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  plugins: (sg) => [
    sg.dataSync({
      offline: {
        documentKey: "project-42",
        // autoSave is off here: it would write to your own browser's storage from a docs page.
        autoSaveDebounceMs: 400,
      },
    }),
  ],
}`,
      caption: "composed, with auto-save deliberately left off",
      height: 260,
    },
    {
      kind: "prose",
      paragraphs: [
        "`realtime` brings in other people's edits as they happen, over a WebSocket or server-sent events.",
        "An incoming change that matches what is already on screen is discarded, so your own edits coming back from the server do not cause a second repaint or a spurious undo step.",
        "It reconnects a bounded number of times and then stops. After that, the `realtime.status` store reports `\"disconnected\"` and offering a retry is up to you.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  plugins: (sg) => [
    sg.dataSync({
      realtime: {
        transports: {
          live: sg.webSocketTransport({
            url: "wss://api.example.com/gantt",
            // Injected so nothing here opens a real socket.
            webSocket: class {
              constructor() {}
              close() {}
            },
          }),
        },
        // connect is unset on purpose — registering a transport does not connect it.
      },
    }),
  ],
}`,
      caption: 'registered, not connected — set connect: "live" once there is somewhere to connect to',
      height: 260,
    },
    {
      kind: "callout",
      tone: "warn",
      body: "If you use `followFilter` to send the reader's search to the server, do not also set a filter of your own — the next keystroke overwrites it, with no warning. Fold your condition into the same filter instead.",
    },
  ],
  next: ["/reference/data-sync", "/reference/data-sync/config"],
};

export default doc;
