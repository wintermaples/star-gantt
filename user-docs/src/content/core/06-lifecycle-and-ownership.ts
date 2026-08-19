import type { CoreDoc } from "../types";

/**
 * The rule that makes a chart disposable: nothing a plugin creates outlives create() unless the
 * host still holds a handle to it. ctx.own() is how a plugin hands that handle over; this chapter
 * walks the three moments where the host's side of that deal actually runs — startup order,
 * the fault barrier, and dispose() — plus the one way people accidentally defeat it.
 */
const doc: CoreDoc = {
  slug: "lifecycle-and-ownership",
  title: "Lifecycle and ctx.own()",
  lede: "A plugin never tears down its own listeners, DOM nodes or timers. It hands each one to ctx.own() the moment it creates it, and the host is the only thing that ever calls dispose() on them — which is what lets a chart be thrown away and rebuilt without leaking a single event handler.",
  cells: [
    {
      kind: "prose",
      paragraphs: [
        "Every resource a plugin allocates — a subscription, an appended element, an armed timer, a MutationObserver — is handed to ctx.own(d) with a Disposable: an object with one method, dispose(). The plugin never calls that method itself. It is added to a per-plugin list the host keeps, and the host is the only caller of dispose() on anything in that list, at exactly one moment: this chart's teardown.",
        "That single rule is what makes Gantt.create() safe to call again after Gantt.dispose(): there is no plugin-owned global state to forget to clear, because there is no plugin-owned state that outlives the ledger entry it was registered under. The three sections below are the host's half of that contract — when it runs each plugin's setup(), what it does when one throws, and what \"release everything\" actually walks.",
      ],
    },
    {
      kind: "prose",
      paragraphs: [
        "Registration order is not startup order. create() resolves the whole dependsOn graph into a topological sort first — a plugin's setup() never runs before every plugin it hard-depends on has finished its own. That sort groups plugins into tiers by dependency depth; dependsOn is the only thing that can force one plugin ahead of another across tiers. Inside a single tier, order: \"pre\" | \"normal\" | \"post\" decides who goes first — pre before normal before post — and registration order (array position in the plugins list) only breaks ties between plugins that land on the same order value in the same tier.",
        "A dependsOn entry naming a plugin id that was never registered is a startup error raised before a single setup() runs; its message names the depending plugin and the missing id it could not find, not a whole chain. A dependency cycle is the other startup error a composition can hit at that same pre-setup stage, and that one's message does carry the offending id chain (a -> b -> c) so you can see exactly which edge closes the loop. Both are deliberate: a broken composition is a mistake the host would rather refuse to start over than let ctx.use() discover the gap later as a runtime throw three components deep.",
      ],
    },
    {
      kind: "code",
      caption: "order only matters inside a tier dependsOn left tied — it never overrides a dependency edge.",
      source: `StarGantt.definePlugin({
  meta: {
    id: "acme.status-badge",
    dependsOn: ["stargantt.data-store"],
    order: "post", // draws after the tier's default-order plugins, all else equal
  },
  setup(ctx) {
    // ...
  },
});`,
    },
    {
      kind: "prose",
      paragraphs: [
        "setup() runs synchronously, one plugin at a time, in that resolved order — which is why ctx.use() inside setup() never returns something half-built. But that synchronous walk has exactly one failure mode, and it is not scoped to the plugin that caused it: if any plugin's setup() throws, the host stops walking, unwinds every plugin that had already started — in reverse order, running each one's own teardown function first and then releasing everything on its ctx.own() ledger — and rethrows to the caller of Gantt.create(). The chart never comes into existence.",
        "That is a sharper failure than it sounds on first read. A typo in a third-party plugin's setup() does not cost you that one plugin's feature; it costs you the whole chart, including the nine preset plugins that had already started cleanly. The trade is the same one dependsOn makes: a broken composition fails loudly, once, at the call to create() — never as a chart that half-renders and leaves you guessing which plugin went missing.",
      ],
    },
    {
      kind: "code",
      caption: "The only call in this file that can throw. Everything after it is running.",
      source: `let gantt;
try {
  gantt = StarGantt.create({
    element: document.getElementById("chart"),
    plugins: [...StarGantt.presetStandard(), StarGantt.perfTools()],
  });
} catch (err) {
  // One plugin's setup() threw — the whole composition failed, and the host has
  // already unwound anything that had started before rethrowing. Nothing to dispose.
  console.error("chart failed to start:", err);
}`,
    },
    {
      kind: "prose",
      paragraphs: [
        "That fault barrier is not something that switches on once setup() is done — it is always on. The core wraps every event-listener call, every extension-point reducer and every command runner in try/catch from the moment the host exists, so a listener that throws while handling an event emitted during some other plugin's setup() is already caught and reported, not fatal. What is special about setup() itself is that the host calls it directly on an unguarded path: a throw there has nothing catching it, which is why it is the one call in this file that can bring the whole chart down. A throw inside a caught call is reported through the core/pluginError event with the offending plugin's id, and the bus moves straight on to the next listener — a plugin that misbehaves on a guarded path costs you its own feature for that one call, not the rest of the chart.",
        "That barrier has an edge worth knowing before you rely on it: it covers what the core itself invokes. A handful of extension points are function-shaped — renderer/hitTest, tooltip/content, taskbars/style — and the core hands their contributed functions to the point-owning plugin unevaluated; that plugin calls them, so guarding those calls is its job, not the core's. Read a plugin's own contract page before assuming a throw inside one of its extension-point callbacks is caught for you.",
      ],
    },
    {
      kind: "code",
      caption: "Watching the fault barrier instead of hitting it — useful while developing a third-party plugin.",
      source: `const off = gantt.on("core/pluginError", ({ pluginId, error }) => {
  console.error(\`stargantt: "\${pluginId}" threw after startup:\`, error);
});`,
    },
    {
      kind: "prose",
      paragraphs: [
        "dispose() is the other end of the same ledger, and it is idempotent — a second call is a no-op, so a host application that calls it defensively on unmount does not need to track whether it already did. It runs each started plugin's optional teardown function first, in reverse startup order, then releases every ctx.own() registration, also in reverse and also per plugin. Reverse order matters for the same reason startup order does: a plugin's teardown can still call into a service a dependency provided, because that dependency has not been torn down yet — it started earlier, so it disposes later.",
        "The two halves of that walk fail differently, and the difference matters. A throw from the optional teardown function returned by setup() is not caught: it aborts dispose() before the ledger sweep for that plugin — or any plugin still waiting behind it — ever runs, so every ctx.own() registration in the whole chart can leak from a single bad teardown. A throw from an owned Disposable's own dispose(), by contrast, is caught per-entry, reported through core/pluginError, and the sweep continues past it. Put teardown work in owned Disposables rather than in the function setup() returns, and a mistake there costs you one leaked resource instead of the whole ledger.",
        "ctx.on() already registers its own unsubscribe with this same ledger, so ctx.own(ctx.on(key, fn)) is not wrong, just redundant — dispose() on an already-disposed subscription is a safe no-op, which is why the pattern shows up throughout the official plugins as a defensive habit rather than a requirement. The calls that do need an explicit ctx.own() are the ones with no built-in teardown of their own: a DOM node you appended, a setTimeout you armed, a ResizeObserver you started.",
      ],
    },
    {
      kind: "prose",
      paragraphs: [
        "The one pattern that quietly defeats all of this is re-arming a timer by calling ctx.own() again on every rearm instead of swapping a variable a single owned Disposable already closes over. It does not look wrong: clearTimeout on a handle that already fired is a silent no-op, so the chart keeps working and nothing throws. What accumulates is the ledger itself — a plugin that rearms on every pointermove during a drag, or every UTC midnight for as long as the tab stays open, adds one more dead entry per rearm, none of which are ever removed until the whole chart is finally disposed.",
        "The fix already ships for exactly this reason inside two official plugins' internals — today-line (an internal module of view) and drag-edit (an internal module of interaction) both re-arm a live handle on every fire. The view plugin's today-line module arms a setTimeout for the next UTC midnight and re-arms itself on every fire; interaction's drag-edit module re-arms an animation-frame handle on every pointer move during a drag. Both own exactly one Disposable, created once, whose dispose() clears whichever handle a shared variable currently points to — arming again only reassigns that variable, so the ledger entry count never grows past one no matter how long the chart runs or how many times the timer fires.",
      ],
    },
    {
      kind: "code",
      caption: "Wrong: one ledger entry per rearm. Right: one entry, ever — the pattern today-line and drag-edit actually use.",
      source: `// Wrong — grows the ledger by one entry every time the timer fires.
function armNextMidnightWrong(ctx) {
  const id = setTimeout(() => {
    render();
    armNextMidnightWrong(ctx); // each call below adds another dead entry after this fires
  }, msUntilNextMidnight());
  ctx.own({ dispose: () => clearTimeout(id) });
}

// Right — one Disposable, owned once, closing over a variable the rearm reassigns.
function armNextMidnightRight(ctx) {
  let timeoutId;
  ctx.own({
    dispose: () => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    },
  });
  const arm = () => {
    timeoutId = setTimeout(() => {
      render();
      arm(); // swaps timeoutId; no new ctx.own() call, no new ledger entry
    }, msUntilNextMidnight());
  };
  arm();
}`,
    },
    {
      kind: "demo",
      caption:
        "The own-once pattern, live: a badge that re-arms its own timer every second, owned exactly once. " +
        "Notice ctx.own() also reverts the inline style the plugin adds to the mount element itself — that counts as a resource too.",
      spec: {
        preset: { treeGrid: { paneWidth: 200 } },
        plugins: (sg) => [
          sg.definePlugin({
            meta: { id: "docs.own-once-clock", dependsOn: [] },
            setup(ctx) {
              const badge = document.createElement("div");
              badge.textContent = "00:00:00";
              badge.style.cssText =
                "position:absolute;bottom:6px;right:10px;z-index:5;font:12px/1.4 monospace;" +
                "padding:2px 6px;border-radius:4px;background:var(--sg-bg,#fff);" +
                "border:1px solid var(--sg-border,#ccc);pointer-events:none;";
              // Mutating the mount element itself is a resource too: capture what was there
              // before and own the revert, so dispose() leaves ctx.root exactly as it found it.
              const prevPosition = ctx.root.style.position;
              ctx.root.style.position ||= "relative";
              ctx.root.append(badge);
              ctx.own({
                dispose: () => {
                  badge.remove();
                  ctx.root.style.position = prevPosition;
                },
              });

              // One Disposable for the whole life of this plugin. Re-arming below only
              // reassigns `timeoutId` — it never calls ctx.own() a second time.
              let timeoutId: ReturnType<typeof setTimeout> | undefined;
              ctx.own({
                dispose: () => {
                  if (timeoutId !== undefined) clearTimeout(timeoutId);
                },
              });
              const tick = () => {
                badge.textContent = new Date().toLocaleTimeString("en-GB", { hour12: false });
                timeoutId = setTimeout(tick, 1000);
              };
              tick();
            },
          }),
        ],
      },
    },
  ],
};

export default doc;
