import type { CoreDoc } from "../types";

/**
 * Core chapter: the event bus. Prose plus code figures — the kernel's event surface has no options
 * to demonstrate, so the runnable content here is a subscriber being written, not a value changed
 * on an existing one.
 */
const doc: CoreDoc = {
  slug: "event-bus",
  title: "The event bus",
  lede: "An event says something already happened; nobody upstream is waiting for a reply. That is the whole difference from the command bus, and it explains why on() has no return value to check and emit() has no per-listener failure channel back to its caller.",
  cells: [
    {
      kind: "prose",
      paragraphs: [
        "Two buses, two jobs, and it is worth keeping them apart in your head before looking at either one's API. The command bus is how you ask for something — dispatch(\"task/move\", …) means \"make this happen\", and exactly one registered handler owns the outcome. The event bus is how the chart announces that something did happen — emit(\"data/didApplyTransaction\", …) means \"this is now true\", and it goes out to however many listeners happen to be subscribed, including zero.",
        "That asymmetry shows up directly in the two methods' shapes. dispatch() runs a single handler and reports failure through core/pluginError because there is one place responsible for the outcome. emit() runs every subscriber in turn and gives no individual listener a way to fail the call back to the emitter — a listener that throws is caught, reported, and skipped, but the announcement itself already happened before the first listener ran. (emit() itself can still throw, but from the bus's own re-entrancy guard, not from a listener — more on that below.) You cannot preventDefault() your way out of a plain event; only the will-prefixed ones (data/willApplyTransaction and its kin) are cancelable, and those are a narrow, explicitly-typed exception via the Cancelable interface, not the general case.",
      ],
    },
    {
      kind: "code",
      caption: "Application code only ever has one door in: GanttInstance.on(). Commands and events side by side.",
      source: `const gantt = StarGantt.create({
  element: document.getElementById("chart"),
  plugins: StarGantt.presetStandard(),
});

// Asking: exactly one handler (data-store's) owns "task/move" and decides what happens.
gantt.dispatch("task/move", { id: "kernel", start: 1_723_680_000_000, end: 1_724_284_800_000 });

// Announcing: however many listeners are subscribed hear about it — but subscribe before you
// dispatch. emit() is synchronous, so the dispatch() above has already run every listener that
// was registered at the time and returned; this subscription only catches the *next* change.
const subscription = gantt.on("data/didApplyTransaction", ({ transaction }) => {
  console.log(\`\${transaction.label}: transaction applied\`);
});

// Application code owns this Disposable — nothing releases it for you. A plugin's ctx.on()
// does not have this problem; see below.
subscription.dispose();`,
    },
    {
      kind: "prose",
      paragraphs: [
        "Every key you can pass to on() or emit() is typed, not because the bus validates strings at runtime — it does not — but because the Events interface a plugin's own .d.ts merges into is the same declaration-merging trick the service registry, command bus and extension points use. keyof Events is closed: pass a key nobody's module declared and it is a compile error, not a silent no-op discovered at runtime. The core itself contributes exactly two concrete keys — lifecycle/ready and core/pluginError — because it is the only thing that emits them; every other key you will ever subscribe to (data/didApplyTransaction, pointer/barDown, schedule/cycleRejected, and so on) exists because some plugin's module is part of your program. Notice what is missing from that list: there is no \"…/changed\" family — no data/tasksChanged, selection/changed, timeline/zoomChanged, or anything shaped like them — in the official catalog. A piece of state that just changed is something you subscribe to as a Store on the service that owns that state instead (the lifecycle-and-ownership and service-registry chapters cover the store side of that split); an event is what remains once you subtract \"a value changed\" from the things a plugin might want to announce.",
        "The naming convention is domain/pastTenseEvent — data/didApplyTransaction, not data/applyTransaction, and its cancelable counterpart is data/willApplyTransaction, not data/applyingTransaction. Reading the tense tells you which side of the change you are on: a past-tense event is a fait accompli you are reacting to, a will-prefixed one is a chance to still call preventDefault() before anything is committed.",
      ],
    },
    {
      kind: "code",
      caption: "A plugin's own module carries the type augmentation next to the emit() call that makes it real.",
      source: `declare module "@stargantt/core" {
  interface Events {
    "acme.row-counter/thresholdCrossed": { count: number; over: boolean };
  }
}

const rowCounter = StarGantt.definePlugin({
  meta: { id: "acme.row-counter", dependsOn: ["stargantt.data-store"] },
  setup(ctx) {
    const data = ctx.use("stargantt.data");
    let wasOver = false;

    // There is no data/tasksChanged event — data-store publishes a "tasks" store instead
    // (the service-registry and lifecycle chapters cover ctx.own()'d subscriptions), so this
    // plugin watches that store rather than listening for a changed event. Emitting its own
    // event below is unaffected: a plugin still defines and emits any event name it likes.
    ctx.own(data.tasks.subscribe((tasks) => {
      const over = tasks.size > 500;
      if (over !== wasOver) {
        wasOver = over;
        ctx.emit("acme.row-counter/thresholdCrossed", { count: tasks.size, over });
      }
    }));
  },
});`,
    },
    {
      kind: "prose",
      paragraphs: [
        "gantt.on() and ctx.on() are the same bus reached through two different doors, and the difference is who cleans up. GanttInstance.on() is application code's only entry point — it hands back a Disposable that nobody releases for you, so a subscription an app forgets to dispose outlives the component that made it. ctx.on() inside a plugin's setup() is different on purpose: the core stamps the subscription with the calling plugin's id and hands it straight to the same per-plugin ledger that ctx.own() uses, so it is already released when the chart disposes. Most official plugins' source calls ctx.on() bare, with no surrounding ctx.own() — task-bars, view and most of the rest do this, because the extra wrap buys nothing that ctx.on() has not already done. A few call sites in resource (load-chart, pool) wrap it in ctx.own() anyway, purely for stylistic consistency with that plugin's other ctx.on() call sites — harmless, and not a sign the bare form is unsafe.",
        "The one thing ctx.on() does not do for you is unsubscribe early, mid-lifetime — dispose() is idempotent, so calling it yourself when a plugin's own state says a listener is no longer needed is exactly what its return value is for. What ctx.own() is for instead is everything that is not already a ctx.on() or ctx.registerCommand() call: a DOM node you appended to ctx.root, a setInterval you started, a ResizeObserver you attached. Reach for it when you created a resource the ledger does not already know about.",
      ],
    },
    {
      kind: "prose",
      paragraphs: [
        "Delivery is synchronous both ways: emit() runs every subscriber before it returns, in the order they subscribed, and a subscriber that itself calls emit() — including one that re-emits the same key it is handling — is allowed. That is not a footgun the bus prevents, it is a footgun the bus bounds: nesting depth 32 throws, so an emit chain that would otherwise recurse forever fails loudly with a stack you can read, instead of hanging the tab. The bound exists for exactly the shape you would expect to trip it — a listener on data/willApplyTransaction that appends patches and dispatches a command whose own runner fires data/willApplyTransaction again before the outer one has settled, whose listener appends and dispatches again. (A store subscription that writes back to its own store is a different mechanism with a sharper rule — architecture ch. 1.1 rule 2 makes that a synchronous throw on the first re-entrant call, not a bounded chain — see the lifecycle-and-ownership chapter.)",
        "Most of the time you do not want that chain running even 31 times, let alone 32 — you want the second firing to recognize its own effect and stop. That is what the origin field on the Transaction attached to data/willApplyTransaction and data/didApplyTransaction is for: it is not a re-entrancy flag bolted onto the bus, it is a fact about who or what made the change, carried on the payload like any other field, that a handler can branch on to tell \"this is new information\" from \"this is an echo of what I just did\".",
      ],
    },
    {
      kind: "code",
      caption: "auto-schedule listens for data/willApplyTransaction and re-propagates a moved task's successors — but only once per user edit, never in response to its own writes.",
      source: `ctx.on("data/willApplyTransaction", (event) => {
  const { transaction } = event;

  // origin decides whether this transaction starts a propagation chain. A direct edit is
  // "user"; auto-schedule's own successor patches, and a replayed undo/redo entry, carry a
  // different origin. Without this check, propagating over the scheduler's own output would
  // re-trigger the same handler, which would propagate again, forever — the depth-32 throw
  // exists for exactly this shape, and this branch is what stops it from ever being reached.
  if (transaction.origin !== "user") return;

  // ...compute and append successor patches to this same transaction
});`,
    },
    {
      kind: "prose",
      paragraphs: [
        "setZoomLevel and setOrigin both move the mapping from time to pixels, and a subscriber that persists the user's chosen zoom level to localStorage needs to know which one just happened — an automatic origin extension is not a choice worth saving. There is no event with a cause field to carry that distinction, and no event at all for a zoom change: timeline.zoomLevel is a Store<ZoomLevel>, set on every mapping change — a zoom-level change publishes the new level, an origin move republishes the same level object unchanged, because stores perform no equality gating and notify regardless.",
        "A subscriber that only invalidates cached geometry treats every notification alike; one that must distinguish compares next.id !== prev.id (a real zoom step) against equal ids (an origin move) — the (next, prev) pair every store subscriber already receives recovers the same distinction a cause field would otherwise exist to carry, with no extra field needed. That is the shape of the store-first design throughout the catalog: a value that changes needs no payload field to say how it changed, because a store's own (next, prev) argument already makes that redundant.",
      ],
    },
    {
      kind: "code",
      caption: "The (next, prev) pair a store hands its subscribers recovers what a cause field would otherwise carry — no field, no event, just the two values.",
      source: `// Subscribe to the store — its own (next, prev) pair tells you the same thing a cause field would.
const timeline = ctx.use("stargantt.timeline");

ctx.own(timeline.zoomLevel.subscribe((next, prev) => {
  if (next.id !== prev.id) {
    // a real zoom step — the active level itself changed
  }
  // same id either way: an origin move republished the unchanged level — invalidate
  // cached geometry, but do not treat it as a zoom level worth persisting
}));`,
    },
    {
      kind: "prose",
      paragraphs: [
        "One thing the bus deliberately does not give you: a guarantee about which subscriber runs first when two plugins listen for the same key. Delivery order follows subscription order, and subscription order follows plugin start order, which follows the dependsOn graph — a topological sort with ties broken by pre/normal/post and then registration order. Reorder the plugin array, add a plugin with a dependency edge that was not there before, and a chain of same-key listeners can run in a different sequence without any of your own code changing. Design each listener so it does not need to run before or after another plugin's listener on the same key; if you find yourself needing that, the ordering guarantee you actually want is a dependsOn edge and a service call, not a race you are hoping the event bus resolves in your favor.",
      ],
    },
    {
      kind: "demo",
      caption: "presetStandard() — task-bars, tree-grid and the view plugin's own passes all repaint off the same data.tasks and timeline.zoomLevel store subscriptions, none of them aware of who else is watching.",
      spec: { preset: { treeGrid: { paneWidth: 240 } } },
    },
  ],
};

export default doc;
