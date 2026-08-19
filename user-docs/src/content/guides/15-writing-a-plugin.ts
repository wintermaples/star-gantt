import type { GuideDoc } from "../types";

/**
 * A complete third-party plugin, built up in place. The code cells carry the detail; the prose only
 * says what each step is for. The kernel's own rules — registry, ordering, extension-point
 * strategies — are the core chapters' job, and this guide links to them.
 */
const doc: GuideDoc = {
  slug: "writing-a-plugin",
  title: "Writing your own plugin",
  lede: "Everything in the standard preset is written with the same API you get. This builds one plugin from nothing, then a second one that uses it.",
  cells: [
    {
      kind: "prose",
      paragraphs: [
        "A plugin is a plain object: `{ meta, setup(ctx) }`. `definePlugin()` just adds the types.",
        "The one on this page shades tasks that are past their end date and shows how many. It needs the task data, the canvas, and somewhere to put a small piece of HTML.",
      ],
    },
    {
      kind: "prose",
      paragraphs: [
        "List what you need in `dependsOn`. That guarantees those plugins are ready before yours starts, and it is also what lets you look them up — asking for something you did not declare throws, immediately, with a readable message.",
        "This plugin contributes to two extension points: one to paint behind the bars, one to add an HTML badge on top. A negative `zIndex` is what puts the shading behind the bars rather than over them.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    view: { timeline: { initialZoom: "week", origin: Date.now() - 10 * 86_400_000 } },
  },
  data: [
    { id: "spec", parentId: null, name: "Spec", start: Date.now() - 9 * 86_400_000, end: Date.now() - 4 * 86_400_000, progress: 1 },
    { id: "build", parentId: null, name: "Build", start: Date.now() - 6 * 86_400_000, end: Date.now() - 1 * 86_400_000, progress: 0.6 },
    { id: "docs", parentId: null, name: "Docs", start: Date.now() - 2 * 86_400_000, end: Date.now() - 0.5 * 86_400_000, progress: 0.5 },
    { id: "integrate", parentId: null, name: "Integrate", start: Date.now() - 3 * 86_400_000, end: Date.now() + 3 * 86_400_000, progress: 0.3 },
    { id: "launch", parentId: null, name: "Launch", type: "milestone", start: Date.now() + 5 * 86_400_000, end: Date.now() + 5 * 86_400_000 },
  ],
  plugins: (sg) => [
    sg.definePlugin({
      meta: {
        id: "acme.overdue-badge",
        dependsOn: ["stargantt.data-store", "stargantt.view"],
      },
      setup(ctx) {
        const data = ctx.use("stargantt.data");
        const view = ctx.use("stargantt.view");
        const timeline = ctx.use("stargantt.timeline");

        function isOverdue(id) {
          const task = data.getTask(id);
          if (!task || task.type === "summary" || task.type === "milestone") return false;
          return task.end < Date.now() && (task.progress ?? 0) < 1;
        }

        function countOverdue() {
          let n = 0;
          for (const id of data.taskIds()) if (isOverdue(id)) n += 1;
          return n;
        }

        // A shaded band behind every overdue task. zIndex below zero puts it under the bars.
        // The extension point is still named renderer/layers — only the plugin providing it
        // (view, not a standalone "renderer") changed.
        ctx.contribute("renderer/layers", {
          id: "acme-overdue-shading",
          zIndex: -50,
          draw(g, vp) {
            g.fillStyle = "rgba(210, 60, 60, 0.14)";
            for (const id of data.taskIds()) {
              if (!isOverdue(id)) continue;
              const task = data.getTask(id);
              const x1 = timeline.tToX(task.start) - vp.scrollLeft;
              const x2 = timeline.tToX(task.end) - vp.scrollLeft;
              g.fillRect(x1, 0, x2 - x1, vp.height);
            }
          },
        });

        // An HTML badge, placed by the view plugin.
        let badge;
        ctx.contribute("renderer/domOverlays", {
          id: "acme-overdue-badge",
          mount(wrapper) {
            badge = wrapper.ownerDocument.createElement("div");
            badge.style.position = "absolute";
            badge.style.left = "8px";
            badge.style.top = "6px";
            badge.style.padding = "2px 8px";
            badge.style.borderRadius = "10px";
            badge.style.font = "11px sans-serif";
            badge.style.background = "light-dark(#fdeaea, #3a1616)";
            badge.style.color = "light-dark(#a03030, #f2a3a3)";
            wrapper.appendChild(badge);
            badge.textContent = countOverdue() + " overdue";
          },
        });

        // ctx.on() cleans itself up — nothing to wrap around it. A store subscription does not:
        // it is a bare disposable with no plugin attached, so ctx.own() it yourself.
        ctx.own(
          data.tasks.subscribe(() => {
            if (badge) badge.textContent = countOverdue() + " overdue";
            view.invalidate("background");
          }),
        );

        // A timer needs owning for the same reason — nothing else knows it exists. This one
        // re-checks the clock so a task that becomes overdue while the tab is open gets shaded
        // without waiting for an edit.
        const recheckId = setInterval(() => {
          if (badge) badge.textContent = countOverdue() + " overdue";
          view.invalidate("background");
        }, 4000);
        ctx.own({ dispose: () => clearInterval(recheckId) });
      },
    }),
  ],
  height: 320,
}`,
      height: 320,
      caption: "one plugin, two extension points: the shading and the count badge",
    },
    {
      kind: "prose",
      paragraphs: [
        "Note what `ctx.own()` is actually for. The badge element belongs to the view plugin, and `ctx.on()` already tidies up after itself — neither needs owning. A store subscription does, though: `store.subscribe()` returns a bare disposable with no plugin attached, so it is on you to wrap it. The timer needs owning for the same reason — nothing else knows it exists.",
        "The rule is: own whatever you started that has no cleanup of its own. Miss one and it keeps running after the chart is gone.",
        "One more thing about that overlay: it scrolls with the chart. Fine for something anchored to a date, wrong for a badge that should stay in one corner.",
        "For a corner badge, append your own absolutely positioned element to `ctx.use(\"stargantt.view\").chartPaneElement()` instead. Offset it with the `--sg-safe-top` / `--sg-safe-right` / `--sg-safe-bottom` / `--sg-safe-left` custom properties that element publishes — `top: calc(var(--sg-safe-top, 0px) + 8px)` and so on — and it lands below the timeline header and clear of the scrollbars rather than on top of them. That is exactly how every official floating panel is placed.",
      ],
    },
    {
      kind: "prose",
      paragraphs: [
        "To let another plugin use your count, publish it as a service with `ctx.provide`, and let the other one look it up with `ctx.use`. That is the same mechanism the built-in plugins use.",
        "Pick a key with your own prefix — `stargantt.*` is taken, and two plugins publishing the same key silently overwrite each other.",
        "In TypeScript, one small declaration adds your key to the known set. Without it the key does not type-check, which is the point: a typo becomes a compile error instead of an undefined at runtime.",
      ],
    },
    {
      kind: "code",
      source: `// overdue-badge.ts
import { definePlugin } from "@stargantt/core";

declare module "@stargantt/core" {
  interface Services {
    "acme.overdue-count": () => number;
  }
}

export const overdueBadge = definePlugin({
  meta: {
    id: "acme.overdue-badge",
    dependsOn: ["stargantt.data-store", "stargantt.view"],
  },
  setup(ctx) {
    const data = ctx.use("stargantt.data");
    ctx.provide("acme.overdue-count", () => data.taskIds().filter(isOverdue).length);
    // ...the contributions from the cell above go here.
  },
});`,
      caption: "the same plugin as a real module — the `declare module` block is what makes the key legal",
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    view: { timeline: { initialZoom: "week", origin: Date.now() - 10 * 86_400_000 } },
  },
  data: [
    { id: "spec", parentId: null, name: "Spec", start: Date.now() - 9 * 86_400_000, end: Date.now() - 4 * 86_400_000, progress: 1 },
    { id: "build", parentId: null, name: "Build", start: Date.now() - 6 * 86_400_000, end: Date.now() - 1 * 86_400_000, progress: 0.6 },
    { id: "docs", parentId: null, name: "Docs", start: Date.now() - 2 * 86_400_000, end: Date.now() - 0.5 * 86_400_000, progress: 0.5 },
    { id: "integrate", parentId: null, name: "Integrate", start: Date.now() - 3 * 86_400_000, end: Date.now() + 3 * 86_400_000, progress: 0.3 },
  ],
  plugins: (sg) => [
    sg.definePlugin({
      meta: {
        id: "acme.overdue-badge",
        dependsOn: ["stargantt.data-store", "stargantt.view"],
      },
      setup(ctx) {
        const data = ctx.use("stargantt.data");
        const timeline = ctx.use("stargantt.timeline");
        function isOverdue(id) {
          const task = data.getTask(id);
          if (!task || task.type === "summary" || task.type === "milestone") return false;
          return task.end < Date.now() && (task.progress ?? 0) < 1;
        }
        function countOverdue() {
          let n = 0;
          for (const id of data.taskIds()) if (isOverdue(id)) n += 1;
          return n;
        }

        // The key this plugin publishes. In TypeScript it pairs with:
        // declare module "@stargantt/core" { interface Services { "acme.overdue-count": () => number } }
        ctx.provide("acme.overdue-count", countOverdue);

        ctx.contribute("renderer/layers", {
          id: "acme-overdue-shading",
          zIndex: -50,
          draw(g, vp) {
            g.fillStyle = "rgba(210, 60, 60, 0.14)";
            for (const id of data.taskIds()) {
              if (!isOverdue(id)) continue;
              const task = data.getTask(id);
              const x1 = timeline.tToX(task.start) - vp.scrollLeft;
              const x2 = timeline.tToX(task.end) - vp.scrollLeft;
              g.fillRect(x1, 0, x2 - x1, vp.height);
            }
          },
        });

        let badge;
        ctx.contribute("renderer/domOverlays", {
          id: "acme-overdue-badge",
          mount(wrapper) {
            badge = wrapper.ownerDocument.createElement("div");
            badge.style.position = "absolute";
            badge.style.left = "8px";
            badge.style.top = "6px";
            badge.style.padding = "2px 8px";
            badge.style.borderRadius = "10px";
            badge.style.font = "11px sans-serif";
            badge.style.background = "light-dark(#fdeaea, #3a1616)";
            badge.style.color = "light-dark(#a03030, #f2a3a3)";
            wrapper.appendChild(badge);
            badge.textContent = countOverdue() + " overdue";
          },
        });
      },
    }),
    sg.definePlugin({
      meta: {
        id: "acme.overdue-legend",
        dependsOn: ["acme.overdue-badge", "stargantt.view"],
      },
      setup(ctx) {
        // A declared dependency, so the other plugin has already published its key.
        const overdueCount = ctx.use("acme.overdue-count");
        ctx.contribute("renderer/domOverlays", {
          id: "acme-overdue-legend",
          mount(wrapper) {
            const legend = wrapper.ownerDocument.createElement("div");
            legend.style.position = "absolute";
            legend.style.left = "8px";
            legend.style.top = "28px";
            legend.style.font = "11px sans-serif";
            legend.style.color = "light-dark(#666, #b8b8b8)";
            legend.textContent = "shading = past due — read from acme.overdue-badge (" + overdueCount() + " now)";
            wrapper.appendChild(legend);
          },
        });
      },
    }),
  ],
  height: 320,
}`,
      height: 320,
      caption: "the second plugin has never seen the first one's code — only the key it publishes",
    },
    {
      kind: "prose",
      paragraphs: [
        "That worked because `dependsOn` guaranteed the order. optional is the other way to look something up, and it is worth seeing fail once.",
        "optional does not affect the order — it only permits the lookup. Ask during setup and you may get nothing, every time, with no error to tell you.",
        "So do not hold on to that first answer. Look it up when you actually need it, or wait for lifecycle/ready.",
      ],
    },
    {
      kind: "runnable",
      source: `{
  preset: {
    view: { timeline: { initialZoom: "week", origin: Date.now() - 10 * 86_400_000 } },
  },
  data: [
    { id: "build", parentId: null, name: "Build", start: Date.now() - 6 * 86_400_000, end: Date.now() - 1 * 86_400_000, progress: 0.6 },
    { id: "docs", parentId: null, name: "Docs", start: Date.now() - 2 * 86_400_000, end: Date.now() - 0.5 * 86_400_000, progress: 0.5 },
  ],
  plugins: (sg) => [
    // Registered first, and using optional — the order that makes the bug reproducible.
    sg.definePlugin({
      meta: {
        id: "acme.overdue-legend",
        optional: ["acme.overdue-badge"],
      },
      setup(ctx) {
        // Wrong: the other plugin has not run yet, so this is undefined — always, not sometimes.
        const overdueCount = ctx.useOptional("acme.overdue-count");
        ctx.contribute("renderer/domOverlays", {
          id: "acme-overdue-legend",
          mount(wrapper) {
            const legend = wrapper.ownerDocument.createElement("div");
            legend.style.position = "absolute";
            legend.style.left = "8px";
            legend.style.top = "6px";
            legend.style.font = "11px sans-serif";
            legend.style.color = "light-dark(#666, #b8b8b8)";
            legend.textContent = overdueCount ? "overdue: " + overdueCount() : "overdue count unavailable (asked too early)";
            wrapper.appendChild(legend);
          },
        });
      },
    }),
    sg.definePlugin({
      meta: {
        id: "acme.overdue-badge",
        dependsOn: ["stargantt.data-store"],
      },
      setup(ctx) {
        const data = ctx.use("stargantt.data");
        function countOverdue() {
          let n = 0;
          for (const id of data.taskIds()) {
            const task = data.getTask(id);
            if (task && task.type !== "summary" && task.type !== "milestone" && task.end < Date.now() && (task.progress ?? 0) < 1) n += 1;
          }
          return n;
        }
        ctx.provide("acme.overdue-count", countOverdue);
      },
    }),
  ],
  height: 240,
}`,
      height: 240,
      caption: "legal, and wrong: both plugins are there, the chart is fine, and the count never arrives",
    },
    {
      kind: "callout",
      tone: "warn",
      body: "There is no private API here. `ctx.use`, `ctx.provide`, `ctx.contribute` and `ctx.own` are everything the built-in plugins get too. Use `dependsOn` when a lookup has to work; use optional only when your plugin can do without.",
    },
  ],
  next: ["/core/plugin-host", "/core/service-registry", "/core/extension-points", "/reference/view"],
};

export default doc;
