import type { GuideDoc } from "../types";

/**
 * The one opt-in resourcing plugin, `resource`, walked nest by nest: pool, assign, load chart,
 * utilization, view. Every runnable cell seeds assignments through a tiny bootstrap plugin,
 * because `data:` on this site only reaches load()'s bare-array form, which has no room for
 * assignments — and because a data-store subscriber may not dispatch synchronously (it would
 * re-enter the very store it is reacting to), each bootstrap defers its dispatch one microtask.
 */
const doc: GuideDoc = {
  slug: "resources-and-workload",
  title: "Resources and workload",
  lede: "Who is on a task, how busy that makes them, and what the chart shows when two tasks want the same person at once.",
  cells: [
    {
      kind: "prose",
      paragraphs: [
        "Tasks have dates but no people. One plugin adds them, and it is opt-in: `resource`.",
        "It is five features in one factory, each its own config key — `pool` (the roster), `assign` (the grid column and editor), `loadChart` (the histogram strip), `utilization` (overload warnings), `view` (a row-per-person strip). Every key you omit stays dormant; passing an empty `{}` turns the feature on at its defaults.",
        "`pool` comes first because everything else reads it. A chart with `assign` and no `pool` has an editor with nothing to offer.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: { treeGrid: { paneWidth: 700 } },
  plugins: (sg) => [
    sg.resource({
      pool: {
        resources: [
          { id: "alice", name: "Alice", capacity: 1 },
          { id: "bob", name: "Bob", capacity: 1 },
        ],
        // Mirrors the roster into the data store, so a resource id the pool knows is also
        // one assignment/set can target.
        syncToStore: true,
      },
      assign: {},
    }),
    // A small one-shot plugin: wait for the sample data, then assign through the store commands.
    sg.definePlugin({
      meta: { id: "guide.seed-assign", dependsOn: ["stargantt.data-store", "stargantt.resource"] },
      setup(ctx) {
        const data = ctx.use("stargantt.data");
        const off = data.tasks.subscribe(() => {
          off.dispose();
          // A data-store subscriber may not dispatch synchronously — it would re-enter the
          // tasks store's own set() and throw. One microtask is enough of a defer.
          queueMicrotask(() => {
            ctx.dispatch("assignment/set", { taskId: "wire", resourceId: "alice", units: 1 });
            ctx.dispatch("assignment/set", { taskId: "visual", resourceId: "bob", units: 0.5 });
          });
        });
        ctx.own(off);
      },
    }),
  ],
}`,
      caption: "the roster, and the Resources column that reads it",
    },
    {
      kind: "prose",
      paragraphs: [
        "Chips tell you who is on one task. `loadChart` answers the wider question — how busy is everybody — as a strip under the chart.",
        "`total` draws one band for the whole team. `lanes` draws a row per person, which is what tells you who is actually carrying the load. Both start off; ask for them explicitly.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    view: { timeline: { initialZoom: "week" } },
    treeGrid: { paneWidth: 500 },
  },
  height: 420,
  plugins: (sg) => [
    sg.resource({
      pool: {
        resources: [
          { id: "alice", name: "Alice", capacity: 1 },
          { id: "bob", name: "Bob", capacity: 1 },
          { id: "carol", name: "Carol", capacity: 0.5 },
        ],
        syncToStore: true,
      },
      loadChart: { total: true, lanes: true, axisLabels: true, valueLabels: true },
    }),
    sg.definePlugin({
      meta: { id: "guide.seed-load", dependsOn: ["stargantt.data-store", "stargantt.resource"] },
      setup(ctx) {
        const data = ctx.use("stargantt.data");
        const off = data.tasks.subscribe(() => {
          off.dispose();
          queueMicrotask(() => {
            // Alice is on two tasks that overlap, taking her to 1.6 against a capacity of 1.
            ctx.dispatch("assignment/set", { taskId: "renderer", resourceId: "alice", units: 0.6 });
            ctx.dispatch("assignment/set", { taskId: "plugins", resourceId: "alice", units: 1 });
            // Bob and Carol carry one task each, so their lanes stay flat.
            ctx.dispatch("assignment/set", { taskId: "kernel", resourceId: "bob", units: 1 });
            ctx.dispatch("assignment/set", { taskId: "qa", resourceId: "carol", units: 0.5 });
          });
        });
        ctx.own(off);
      },
    }),
  ],
}`,
      height: 420,
      caption: "Alice's lane goes over where her two tasks overlap — the team band does not, because the team as a whole still has room",
    },
    {
      kind: "prose",
      paragraphs: [
        "The load chart shows the problem; `utilization` names it. It marks the task bars involved with a warning triangle and adds a column saying who is over and by how much.",
        "It reads the same pool and the same store assignments — no extra wiring beyond turning the key on.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    view: { timeline: { initialZoom: "week" } },
    treeGrid: { paneWidth: 700 },
  },
  height: 360,
  plugins: (sg) => [
    sg.resource({
      pool: {
        resources: [
          { id: "alice", name: "Alice", capacity: 1 },
          { id: "bob", name: "Bob", capacity: 1 },
        ],
        syncToStore: true,
      },
      utilization: { threshold: 1 },
    }),
    sg.definePlugin({
      meta: { id: "guide.seed-util", dependsOn: ["stargantt.data-store", "stargantt.resource"] },
      setup(ctx) {
        const data = ctx.use("stargantt.data");
        const off = data.tasks.subscribe(() => {
          off.dispose();
          queueMicrotask(() => {
            ctx.dispatch("assignment/set", { taskId: "renderer", resourceId: "alice", units: 0.6 });
            ctx.dispatch("assignment/set", { taskId: "plugins", resourceId: "alice", units: 1 });
            ctx.dispatch("assignment/set", { taskId: "kernel", resourceId: "bob", units: 1 });
          });
        });
        ctx.own(off);
      },
    }),
  ],
}`,
      height: 360,
      caption: "the warning glyph and the Overallocation column both name Alice; Bob stays clean",
    },
    {
      kind: "prose",
      paragraphs: [
        "Every view so far is one row per task. `view` flips that: one row per person, showing everything they are on.",
        "That is the shape a staffing conversation wants. Group people into teams and each team gets a header with its combined capacity and peak load.",
        "It opens as a strip below the chart — the same place `loadChart` puts its bands, stacked above them — with a divider you can drag to trade height between the two axes. It starts hidden and claims no height at all: set `startOpen` when you want it shown from the first paint.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: { view: { timeline: { initialZoom: "week" } } },
  height: 380,
  plugins: (sg) => [
    sg.resource({
      pool: {
        resources: [
          { id: "alice", name: "Alice", capacity: 1 },
          { id: "bob", name: "Bob", capacity: 1 },
          { id: "carol", name: "Carol", capacity: 0.5 },
        ],
        syncToStore: true,
      },
      view: {
        startOpen: true,
        teams: [
          { name: "Engineering", members: ["alice", "bob"] },
          { name: "Design", members: ["carol"] },
        ],
      },
    }),
    sg.definePlugin({
      meta: { id: "guide.seed-view", dependsOn: ["stargantt.data-store", "stargantt.resource"] },
      setup(ctx) {
        const data = ctx.use("stargantt.data");
        const off = data.tasks.subscribe(() => {
          off.dispose();
          queueMicrotask(() => {
            ctx.dispatch("assignment/set", { taskId: "renderer", resourceId: "alice", units: 0.6 });
            ctx.dispatch("assignment/set", { taskId: "plugins", resourceId: "alice", units: 1 });
            ctx.dispatch("assignment/set", { taskId: "kernel", resourceId: "bob", units: 1 });
            ctx.dispatch("assignment/set", { taskId: "qa", resourceId: "carol", units: 0.5 });
          });
        });
        ctx.own(off);
      },
    }),
  ],
}`,
      height: 380,
      caption: "one row per person — Alice's shows both tasks and the overlap between them",
    },
    {
      kind: "prose",
      paragraphs: [
        "One worth trying on purpose: `loadChart` on its own, with no `pool` and nothing assigned.",
        "It is perfectly legal and draws nothing. There is no error to look for — the lanes simply have nobody to draw.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  plugins: (sg) => [
    sg.resource({
      loadChart: { lanes: true, axisLabels: true },
    }),
  ],
}`,
      caption: "legal, and empty — no people, no assignments, nothing to show",
    },
    {
      kind: "callout",
      tone: "warn",
      body: "`assignment/set` needs both ids to already exist in the data store — a task from your data, a resource from `pool` (with `syncToStore: true`) or added directly with `resource/add`. Skip the sync and the pool has names nobody in the store can be assigned to, and the editor reports `No resources available`.",
    },
  ],
  next: ["/reference/resource", "/reference/resource/config", "/guides/baselines-and-progress"],
};

export default doc;
