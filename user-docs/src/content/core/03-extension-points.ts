import type { CoreDoc } from "../types";

/**
 * Extension points are the third connective tissue in the kernel, next to services and events. A
 * service is one plugin answering a fixed question for callers; an event tells everyone something
 * happened; an extension point is the shape for "many plugins add to one thing that only one
 * plugin owns and does something with" — a layer on the canvas, an entry in a menu, a strip of
 * width the timeline header must reserve. This chapter is prose and code, because the mechanism has
 * no options — the interesting part is the contract between the plugin that owns a point and the
 * plugins that add to it, which is exactly what the type system does not enforce.
 */
const doc: CoreDoc = {
  slug: "extension-points",
  title: "Extension points",
  lede: "One plugin defines a point and decides what happens with the contributions; any number of other plugins add to it. Three merge strategies cover every point in the library, and the same three cover a point you define yourself.",
  cells: [
    {
      kind: "prose",
      paragraphs: [
        "Twenty-five points exist across the official plugins today — renderer/layers, taskbars/overlays, grid/columns, keys/bindings, tooltip/content, and so on. Every one of them is defined by exactly one plugin, which is the only plugin that ever calls .get() on it and paints, composes or decides from the result. Everyone else — official plugins and third parties alike — only ever calls ctx.contribute(key, value); they never see the reduced result and never need to.",
        "Defining a point is two calls a plugin makes on itself, at setup(): defineExtensionPoint to declare the key and how contributions combine, and contribute if the definer also wants to add to its own point (the renderer, for instance, does not contribute to renderer/layers — task-bars and a dozen others do that).",
      ],
    },
    {
      kind: "code",
      caption: "The point-owning side. This is literally what task-bars.md's declaration-merging block adds to the global ExtensionPoints interface, plus the two calls that make it live.",
      source: `declare module "@stargantt/core" {
  interface ExtensionPoints {
    // collect: every contribution, as an array, in startup order
    "taskbars/overlays": ExtensionPointDecl<BarOverlayRenderer, BarOverlayRenderer[]>;
  }
}

// inside task-bars' own setup(ctx):
const overlays = ctx.defineExtensionPoint("taskbars/overlays", StarGantt.collect());
// … later, once per visible bar, once per paint:
for (const draw of overlays.get()) draw(g, barBox);`,
    },
    {
      kind: "prose",
      paragraphs: [
        "collect is the plain case: every contribution survives, in the order plugins started in, and the definer iterates all of them — but what the definer then does with duplicates is its own rule, not the mechanism's. renderer/layers, taskbars/overlays and grid/columns are all collect with no notion of duplicates, because a canvas can hold any number of painted layers and a grid can hold any number of columns. keys/bindings is also collect, but a11y resolves two contributions for the same chord last-wins, so a later plugin can silently displace an earlier one's binding — worth knowing before you ship a plugin that binds a chord someone else might already own.",
        "first is call-time, not startup-time, and that distinction is the whole point of it. Contributions are functions with a shared signature; StarGantt.first() builds one composite function that calls each contribution in order and returns the first result that is not undefined — recomputed on every call, not once at startup. renderer/hitTest uses this because which plugin owns a given pixel changes from click to click: task-bars answers for a point over a bar, scheduling answers for a point over a dependency link, and anything left over falls through to a third party's tester or to no hit at all. A reducer that just kept 'the first plugin that registered' could never let a later plugin intercept — the first hit-tester would win forever.",
        "reduce is an arbitrary fold to one value, the same shape Array.prototype.reduce takes: a combining function and a seed — but what gets folded is a property of the point, not of the strategy. rows/height's contributions are themselves functions, `(task, defaultHeight) => number | undefined`, and the fold runs once at startup, composing interaction's filter row-hiding rule (a filtered-out task's row height overrides to 0) and any others into a single `ResolvedRowHeight` — one function the tree-grid then calls per row to get that row's height. The fold is startup-time; the answer it produces is call-time, same as a first point's composite would be. Nothing stops a reduce point from being lossy — that is what picking it means: the definer wants one answer, not a list.",
      ],
    },
    {
      kind: "prose",
      paragraphs: [
        "A contribution is added, never withdrawn, and the definer has to design around that. a11y's keys/bindings and undo-redo's contribution to it are the ordinary case: register once at setup(), stay registered for the life of the chart. task-bars' taskbars/style point (strategy first) makes the constraint explicit in its own contract: tree-grid's conditional-format rule engine registers unconditionally at setup() — answering undefined for tasks its rules do not match — because a contribution cannot be withdrawn or inserted later, so there is no later hook to add itself into the chain once the reader turns coloring on. If you write a point definer of your own and expect a contributor set that changes over a chart's lifetime, that has to be a service call the contributor makes later (change a value the definer already reads), not a second contribute().",
        "Ordering follows the same topological sort that decides plugin startup: dependsOn edges first, then pre before normal before post within a tier, then registration order as the final tie-break — there is no numeric priority field anywhere in the kernel. A subtlety worth knowing before it surprises you: contribute() on a key nobody has defined yet is legal and buffered, delivered in registration order the moment the owning plugin's defineExtensionPoint runs. The spec's own plugin order requires this — undo-redo contributes to keys/bindings before a11y, which defines it, even exists — and no dependsOn edge could reorder them without inventing a dependency that isn't otherwise there.",
      ],
    },
    {
      kind: "code",
      caption: "A real third-party contribution to renderer/layers — sprint-boundary shading behind the bars, condensed from examples/custom-plugin.html. draw() gets a viewport-local 2D context plus the current scroll offsets; converting content coordinates (tToX) to canvas coordinates by subtracting vp.scrollLeft is the contribution's own job, and it never touches the DOM. This bands whole weeks, alternating on and off from a fixed epoch — a pattern the view plugin's own grid-lines pass has no config option for, unlike weekend shading, which its gridLines.nonWorkingDays default already paints and is the supported way to get it. The single dependsOn entry below is worth noticing: stargantt.timeline and stargantt.theme are two different service keys, but both are provided by the one stargantt.view plugin (the service-registry chapter covers why a dependsOn entry names a provider plugin, not a service key).",
      source: `const sprintBands = StarGantt.definePlugin({
  meta: {
    id: "acme.sprint-bands",
    dependsOn: ["stargantt.view"],
  },
  setup(ctx) {
    const timeline = ctx.use("stargantt.timeline");
    const theme = ctx.use("stargantt.theme");

    ctx.contribute("renderer/layers", {
      id: "acme-sprint-bg",
      zIndex: -100, // behind grid-lines (10) and bars (60) — negative zIndex is legal
      draw(g, vp) {
        if (timeline.zoomLevel.get().pxPerDay < 12) return; // texture, not signal, below this
        const DAY = 86_400_000;
        const WEEK = 7 * DAY;
        let t = Math.floor(timeline.xToT(vp.scrollLeft) / DAY) * DAY;
        const rightT = timeline.xToT(vp.scrollLeft + vp.width);
        // theme.get() returns "" when the token is unset, never undefined — "??" would
        // never fall through, so the idiom the theme contract prescribes is "||". This
        // token is a reader-defined custom property (nothing in the library sets it);
        // until the reader defines it, get() returns "" and the fallback below is used.
        g.fillStyle = theme.get("--acme-sprint-bg") || "rgba(120, 170, 220, 0.18)";
        while (t <= rightT) {
          // Weeks are numbered from the Unix epoch, not from any task's own start, so the
          // on/off banding stays put as the reader scrolls or the dataset changes.
          if (Math.floor(t / WEEK) % 2 === 0) {
            const x = timeline.tToX(t) - vp.scrollLeft;
            const w = timeline.tToX(t + DAY) - vp.scrollLeft - x;
            g.fillRect(x, 0, w, vp.height);
          }
          t += DAY;
        }
      },
    });
  },
});`,
    },
    {
      kind: "prose",
      paragraphs: [
        "That draw() call can throw — a theme token that resolves to garbage, a timeline edge case, an arithmetic slip — and the contract is explicit about who catches it. The core's own automatic try/catch (§1.9) covers exactly one thing: the reduce function passed to defineExtensionPoint, attributed to the point's owner. Everything else contributed to renderer/layers, renderer/hitTest, renderer/insets, renderer/domOverlays and renderer/contentExtent is a bare value the core never calls — the renderer calls it, so the renderer is the one that has to guard it, and the contract requires that it does: every individual draw() runs inside its own try/catch, bracketed by save()/restore() so a throw cannot leave stray canvas state behind, and a throw is reported through core/pluginError with the renderer's own plugin id (a contribution is a bare object; the contributor's id was never observable to begin with) and painting continues with the remaining layers.",
        "Write a point of your own and you inherit that obligation, not a mechanism that gives it to you for free: if your contributions are function-shaped, wrap every call yourself the way the renderer does, or one contributor's bug takes down every contributor that runs after it in your loop. task-bars guards taskbars/overlays the same way and then goes one step further: an overlay that throws once is latched off and never called again for the rest of the chart's life, not merely skipped for that frame — so defensive code inside the contribution (the low-progress badge above included) is not optional, it is what keeps a single bad task from silencing the overlay for every other row, forever.",
      ],
    },
    {
      kind: "code",
      caption: "A real third-party contribution to taskbars/overlays — a warning dot on any bar behind schedule, drawn after the bar body, its progress fill and its label, which is where this point always runs.",
      source: `const lowProgressBadge = StarGantt.definePlugin({
  meta: {
    id: "acme.low-progress-badge",
    dependsOn: ["stargantt.task-bars", "stargantt.data-store"],
  },
  setup(ctx) {
    const data = ctx.use("stargantt.data");

    ctx.contribute("taskbars/overlays", (g, bar) => {
      const task = data.getTask(bar.id);
      // Skip summaries and milestones — they carry no progress of their own, and
      // "?? 0" would otherwise flag every one of them as behind schedule.
      if (!task || task.type === "summary" || task.type === "milestone") return;
      if ((task.progress ?? 0) >= 0.5) return; // most leaf bars decline — that is fine

      const r = 4;
      const cx = bar.x + r + 2; // left end of the bar, so it is on screen even when the
      const cy = bar.y + r + 2; // bar runs off the right edge of the viewport
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.fillStyle = "#e2a53b";
      g.fill();
    });
  },
});`,
    },
    {
      kind: "prose",
      paragraphs: [
        "Both plugins above are on screen below, unmodified — the same definePlugin() call a reader would paste into their own project, composed next to presetStandard() the way the kernel chapter's rowCounter was. The sprint bands paint at zIndex -100, behind the view plugin's own grid-lines pass at zIndex 10 — legal, since negative zIndex is allowed, but that pass's default row stripes and non-working-day shading are opaque fills on that same layer, so most of the band paints over: what actually reaches the screen is fragmented patches on the unstriped, working-day columns, not one continuous week block. The bands themselves are plain 7-day cycles counted from the Unix epoch (00:00 UTC, 1 January 1970 — a Thursday), so the on/off boundary falls on Thursdays and Wednesdays, not on any calendar week or sprint start a reader would recognize; the demo is evidence that renderer/layers can paint a pattern grid-lines has no config option for, not a working sprint indicator on its own. Weekend shading, by contrast, is already the gridLines.nonWorkingDays default (nested under the view plugin's own config) and would be indistinguishable from the preset's own chart if used here. The badge is one row-model lookup and an arc(), and it skips summary rows and milestones on purpose, because a summary carries no progress of its own and (task.progress ?? 0) would otherwise flag every one of them as behind schedule regardless of how their children are actually doing. Neither plugin needed a privileged import — ctx.use, ctx.contribute and the public Task shape were enough for both.",
        "Choosing a strategy for a point of your own comes down to three questions, not a table to match against: first when a contributor has to be able to decline per call and let someone later in the chain answer instead (taskbars/style has three official contributors doing exactly that — tree-grid's conditional-format rules, scheduling's critical-path highlighting and tracking's RAG recoloring each recolor a bar only when their own config says to, and defer otherwise); collect when the definer wants every contribution, not a winner; reduce when the definer wants one composed answer built from all of them. And separately: if the honest answer for a point you are designing is \"there will only ever be one contributor,\" that is a service, not an extension point — the mechanism is for composition, and composition you do not need is a call you can make yourself.",
      ],
    },
    {
      kind: "demo",
      caption: "Sprint-boundary shading (renderer/layers, zIndex -100 — a pattern grid-lines has no option for) and a badge on any task under 50% progress (taskbars/overlays) — two ordinary third-party plugins next to the standard preset.",
      spec: {
        preset: { treeGrid: { paneWidth: 220 } },
        plugins: (sg) => [
          sg.definePlugin({
            meta: {
              id: "acme.sprint-bands",
              dependsOn: ["stargantt.view"],
            },
            setup(ctx) {
              const timeline = ctx.use("stargantt.timeline");
              const theme = ctx.use("stargantt.theme");
              ctx.contribute("renderer/layers", {
                id: "acme-sprint-bg",
                zIndex: -100,
                draw(g, vp) {
                  if (timeline.zoomLevel.get().pxPerDay < 12) return;
                  const DAY = 86_400_000;
                  const WEEK = 7 * DAY;
                  let t = Math.floor(timeline.xToT(vp.scrollLeft) / DAY) * DAY;
                  const rightT = timeline.xToT(vp.scrollLeft + vp.width);
                  // theme.get() returns "" when unset, never undefined, so "||" (not "??") is
                  // the right fallback idiom. This token is a reader-defined custom property.
                  g.fillStyle = theme.get("--acme-sprint-bg") || "rgba(120, 170, 220, 0.18)";
                  while (t <= rightT) {
                    if (Math.floor(t / WEEK) % 2 === 0) {
                      const x = timeline.tToX(t) - vp.scrollLeft;
                      const w = timeline.tToX(t + DAY) - vp.scrollLeft - x;
                      g.fillRect(x, 0, w, vp.height);
                    }
                    t += DAY;
                  }
                },
              });
            },
          }),
          sg.definePlugin({
            meta: {
              id: "acme.low-progress-badge",
              dependsOn: ["stargantt.task-bars", "stargantt.data-store"],
            },
            setup(ctx) {
              const data = ctx.use("stargantt.data");
              ctx.contribute("taskbars/overlays", (g, bar) => {
                const task = data.getTask(bar.id);
                if (!task || task.type === "summary" || task.type === "milestone") return;
                if ((task.progress ?? 0) >= 0.5) return;
                const r = 4;
                const cx = bar.x + r + 2;
                const cy = bar.y + r + 2;
                g.beginPath();
                g.arc(cx, cy, r, 0, Math.PI * 2);
                g.fillStyle = "#e2a53b";
                g.fill();
              });
            },
          }),
        ],
      },
    },
  ],
};

export default doc;
