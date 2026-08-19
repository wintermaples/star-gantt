import type { GuideDoc } from "../types";

/**
 * Two channels: momentary events (`gantt.on()`) for things that happen — a press, a
 * scroll, an applied transaction — and stores (`service.someStore.subscribe()`) for state you can
 * also just read. There is no `changed`-suffixed event anywhere in the official catalog (data,
 * selection, filter, undo history, theme, zoom, view mode); each of those is a store instead.
 * The runnable cells are deliberately ones
 * the reader can make fire — drag a bar, and the badge counts the change — because an event guide
 * whose demos only fire at startup teaches nothing a screenshot could not.
 */
const doc: GuideDoc = {
  slug: "listening-to-events",
  title: "Listening to events",
  lede: "How to find out what the chart just did — through a momentary event or a state you can subscribe to — and how to step in before a change happens.",
  cells: [
    {
      kind: "prose",
      paragraphs: [
        "The chart tells you what it did in one of two ways. A momentary occurrence — a pointer press, a scroll, an applied transaction — is an event: subscribe with `gantt.on()`. A piece of state — the task list, the selection, the undo history — lives on a store instead: subscribe with `service.someStore.subscribe()`, or read it once with `.get()`.",
        "Both give you back a subscription. Call `dispose()` on it when you no longer want the handler, and it stops.",
        "Both run straight away, synchronously, in the middle of the change — not on a later tick. Keep handlers short.",
      ],
    },
    {
      kind: "code",
      caption: "subscribing to a momentary event from your own code",
      source: `const gantt = StarGantt.create({
  element: document.getElementById("chart"),
  plugins: StarGantt.presetStandard(),
});

const sub = gantt.on("data/didApplyTransaction", (e) => {
  console.log(e.transaction.label, "by", e.transaction.origin);
});

// When you are done with it:
sub.dispose();`,
    },
    {
      kind: "prose",
      paragraphs: [
        "`data/didApplyTransaction` fires once per applied transaction — an edit, a drag, an undo — right after the store settles. It is never fired for a fresh `load()`, and never for a change that gets cancelled (below).",
        "It carries the whole `Transaction`: `label`, `origin`, and `patches` — the list of what actually changed, each one an object like `{ op: \"task/update\", id, before, after }`. Count them by `op` to answer \"what kind of change was this\".",
      ],
    },
    {
      kind: "code",
      caption: "reacting to the kind of change, not just to the fact of one",
      source: `gantt.on("data/didApplyTransaction", (e) => {
  for (const patch of e.transaction.patches) {
    if (patch.op === "task/add") myCache.set(patch.task.id, buildRow(patch.task.id));
    else if (patch.op === "task/remove") myCache.delete(patch.task.id);
    else if (patch.op === "task/update") myCache.set(patch.id, buildRow(patch.id));
  }
});`,
    },
    {
      kind: "prose",
      paragraphs: [
        "A fresh `load()` carries no transaction at all — there is nothing to be cancelled and nothing to label. For that case, read the task store instead: `gantt.service(\"stargantt.data\").tasks` is set on every `load()` too, always last, whether or not any one task actually changed.",
        "A store never tells you *what* changed by itself — only the new snapshot. Diff it against the previous one yourself when you need that, the same `(next, prev)` pair every subscriber receives.",
      ],
    },
    {
      kind: "code",
      caption: "the store path — for state you can also just read, not only react to",
      source: `const data = gantt.service("stargantt.data");

data.tasks.subscribe((next, prev) => {
  for (const [id, task] of next) {
    if (!prev.has(id)) console.log("added", id);
    else if (prev.get(id) !== task) console.log("updated", id);
  }
  for (const id of prev.keys()) if (!next.has(id)) console.log("removed", id);
});`,
    },
    {
      kind: "prose",
      paragraphs: [
        "The chart below is subscribed to `data/didApplyTransaction` and writes what it hears into a badge.",
        "Drag a bar, or drag its edge, and watch the counts move. Nothing else on the page changed — this is one small plugin doing what your own code would do.",
      ],
    },
    {
      kind: "runnable",
      height: 320,
      caption: "drag a bar: the badge is `data/didApplyTransaction`, reported as it fires",
      source: `{
  plugins: (sg) => [
    sg.definePlugin({
      meta: { id: "docs.change-log", dependsOn: ["stargantt.view"] },
      setup(ctx) {
        // The chart pane, so the badge stays in its corner instead of scrolling with the bars.
        const pane = ctx.use("stargantt.view").chartPaneElement();
        const badge = pane.ownerDocument.createElement("div");
        badge.style.position = "absolute";
        // --sg-safe-* keeps it clear of the timeline header and the scrollbars.
        badge.style.right = "calc(var(--sg-safe-right, 0px) + 8px)";
        badge.style.bottom = "calc(var(--sg-safe-bottom, 0px) + 8px)";
        badge.style.padding = "3px 9px";
        badge.style.borderRadius = "10px";
        badge.style.font = "11px sans-serif";
        badge.style.whiteSpace = "nowrap";
        badge.style.maxWidth = "calc(100% - 24px)";
        badge.style.overflow = "hidden";
        badge.style.textOverflow = "ellipsis";
        badge.style.background = "light-dark(#eef2fb, #1d2534)";
        badge.style.color = "light-dark(#3c4a63, #b9c6dd)";
        badge.textContent = "waiting for a change — drag a bar";
        pane.appendChild(badge);
        ctx.own({ dispose: () => badge.remove() });

        ctx.on("data/didApplyTransaction", (e) => {
          let added = 0, removed = 0, updated = 0;
          for (const patch of e.transaction.patches) {
            if (patch.op.endsWith("/add")) added += 1;
            else if (patch.op.endsWith("/remove")) removed += 1;
            else if (patch.op.endsWith("/update")) updated += 1;
          }
          badge.textContent =
            "+" + added +
            " -" + removed +
            " ~" + updated +
            " of " + e.transaction.patches.length +
            " · " + e.transaction.label;
        });
      },
    }),
  ],
}`,
    },
    {
      kind: "prose",
      paragraphs: [
        "Links, resources and assignments have stores of their own too: `data.links`, `data.resources`, `data.assignments`. Each is set only when that domain's part of the change touched it, so subscribing to one costs you nothing while nothing there is happening — `tasks` is the one that always fires, last, on every change.",
        "They carry the entities, not only their ids, so a diff still tells you what a removed link or resource looked like right before it went.",
      ],
    },
    {
      kind: "code",
      caption: "the other three stores",
      source: `const data = gantt.service("stargantt.data");

data.links.subscribe((next, prev) => {
  for (const [id, link] of prev) {
    if (!next.has(id)) console.log("unlinked", link.sourceId, "->", link.targetId);
  }
});

// A capacity edit reaches you here, diffed the same way as a task.
data.resources.subscribe((next, prev) => {
  for (const [id, r] of next) {
    const before = prev.get(id);
    if (before && before.capacity !== r.capacity) console.log(r.name, "capacity", r.capacity);
  }
});

// Grouped by task — assignments have no id of their own (a task, resource pair).
data.assignments.subscribe((next) => {
  for (const [taskId, list] of next) console.log(taskId, "now has", list.length, "assignments");
});`,
    },
    {
      kind: "callout",
      tone: "info",
      body: "One change publishes both channels: the touched entity stores, `tasks` last, then `data/didApplyTransaction` once the burst is done. That ordering means a store subscriber sees the new state slightly before the event fires — read a store when you only need the current picture, and use the event when you need the label, the origin, or the exact patch list.",
    },
    {
      kind: "prose",
      paragraphs: [
        "Everything above happens after the fact. To step in *before* a change, use `data/willApplyTransaction` — still a plain event, because a veto is genuinely momentary, not a piece of state.",
        "It hands you the transaction — a list of patches, not yet applied. Call `preventDefault()` and none of it happens.",
        "There is one pre-change event rather than one per kind, because a transaction is all-or-nothing. Look at `transaction.patches` to see what kind of change it is.",
      ],
    },
    {
      kind: "code",
      caption: "refusing a change",
      source: `gantt.on("data/willApplyTransaction", (e) => {
  const deletions = e.transaction.patches.filter((p) => p.op === "task/remove");
  if (deletions.some((p) => p.task.meta?.locked)) {
    e.preventDefault();   // nothing in this transaction is applied
  }
});`,
    },
    {
      kind: "prose",
      paragraphs: [
        "The chart below refuses to move anything whose name starts with `Ship`.",
        "Try dragging the milestone: it snaps back. Then drag any other bar, which still works normally.",
      ],
    },
    {
      kind: "runnable",
      height: 320,
      caption: "`preventDefault()` in a pre-change handler — the milestone will not move",
      source: `{
  plugins: (sg) => [
    sg.definePlugin({
      meta: { id: "docs.freeze-ship", dependsOn: ["stargantt.data-store"] },
      setup(ctx) {
        const data = ctx.use("stargantt.data");

        ctx.on("data/willApplyTransaction", (e) => {
          for (const patch of e.transaction.patches) {
            if (patch.op !== "task/update") continue;
            const task = data.getTask(patch.id);
            if (task && task.name.startsWith("Ship")) e.preventDefault();
          }
        });
      },
    }),
  ],
}`,
    },
    {
      kind: "callout",
      tone: "warn",
      body: "A pre-change handler runs inside the change. Do not call a command from it, and do not do anything slow — you are holding up the edit the reader is making. A data-store subscriber has the same rule for a different reason: dispatching from inside one re-enters the store it is reacting to and throws — defer with a microtask if you need to write back.",
    },
    {
      kind: "prose",
      paragraphs: [
        "Inside a plugin, use `ctx.on()` and store subscriptions the same way — the kernel disposes of both with your plugin, so there is nothing to clean up yourself.",
        "Other plugins still publish real events for momentary things: `pointer/barDown` while a press starts, `view/scrolled` while scrolling, `grid/rowPointerDown` on the grid, `resourceView/toggled` when the resource strip opens or closes.",
        "Any *state* notification is a store, never an event: `ctx.use(\"stargantt.selection\").state`, `\"stargantt.filter\"`'s `state`, `\"stargantt.history\"`'s `state` for undo/redo, `\"stargantt.theme\"`'s `tokens`, `\"stargantt.timeline\"`'s `zoomLevel`. Each plugin's reference page says which it has.",
      ],
    },
  ],
  next: ["/core/event-bus", "/reference/data-store", "/guides/writing-a-plugin"],
};

export default doc;
