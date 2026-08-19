import type { CoreDoc } from "../types";

/**
 * Reference implementation of a core chapter. Core has no options to demonstrate, so these pages
 * are prose plus code — a runnable cell here shows a plugin being written, not a value changed.
 */
const doc: CoreDoc = {
  slug: "plugin-host",
  title: "The plugin host",
  lede: "The kernel knows nothing about tasks, dates or drawing. It registers plugins, resolves the order they start in, hands each one a context, and takes their resources back when the chart is disposed. Everything else in StarGantt is a plugin standing on that.",
  cells: [
    {
      kind: "prose",
      paragraphs: [
        "create() takes an element and an array of plugins, and that array is the whole composition. There is no hidden set of built-ins underneath: presetStandard() is a function that returns nine plugin instances, and you can drop, reorder or replace any of them.",
        "That is worth taking literally. Remove the task-bars entry and the chart still scrolls, still has a timeline header and still has rows — with nothing drawn on them. Nothing in the kernel notices that a gantt chart has stopped being one.",
      ],
    },
    {
      kind: "code",
      caption: "The whole composition, visible in one expression.",
      source: `const gantt = StarGantt.create({
  element: document.getElementById("chart"),
  plugins: [
    ...StarGantt.presetStandard(),   // nine ordinary plugins
    StarGantt.perfTools(),           // one more, on the same footing
  ],
});`,
    },
    {
      kind: "prose",
      paragraphs: [
        "Each plugin declares an id and the ids it depends on. The host resolves that into a start order, so a plugin's setup() can assume everything it declared is already running — ctx.use() returns a service, not a promise, and never a null you have to guard.",
        "A dependency that is not registered is an error at startup rather than a missing feature at runtime. That is the trade the design makes: composition mistakes surface when the chart is built, in one place, instead of as a blank area of the canvas twenty minutes later.",
      ],
    },
    {
      kind: "code",
      caption: "A complete third-party plugin. No privileged API is involved — the official ones are written exactly this way.",
      source: `const rowCounter = StarGantt.definePlugin({
  meta: {
    id: "acme.row-counter",
    dependsOn: ["stargantt.data-store"],
  },
  setup(ctx) {
    const data = ctx.use("stargantt.data");

    const badge = document.createElement("div");
    badge.className = "acme-row-counter";
    ctx.root.append(badge);

    const render = () => { badge.textContent = \`\${data.tasks.get().size} tasks\`; };
    render();

    // Everything the plugin owns goes through ctx.own(), so disposing the chart
    // disposes this too — no teardown function to remember to write. data.tasks is a
    // Store, not an event — there is no "data/changed" to listen for; subscribe() is how
    // a plugin watches it, and ctx.own() releases the subscription along with everything else.
    ctx.own({ dispose: () => badge.remove() });
    ctx.own(data.tasks.subscribe(render));
  },
});`,
    },
    {
      kind: "prose",
      paragraphs: [
        "The last two lines are the rule the kernel exists to enforce. A plugin never disposes its own listeners, elements or timers on the way out; it hands each one to ctx.own() when it creates it, and the host owns the teardown. One chart, one dispose(), nothing left behind.",
        "This is also why a plugin that throws during setup does not take the chart down with it. The host catches it, reports it through the plugin-error event, and disposes whatever that plugin had already registered — so a broken third-party plugin costs you its feature, not your application.",
      ],
    },
    {
      kind: "demo",
      caption: "presetStandard() — nine plugins, one host, one dispose()",
      spec: { preset: { treeGrid: { paneWidth: 200 } } },
    },
  ],
};

export default doc;
