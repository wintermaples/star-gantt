import type { CoreDoc } from "../types";

/**
 * Core chapter: the command bus. Prose plus code figures — the kernel's command surface has no
 * options to demonstrate, so the runnable content here is a plugin registering and dispatching a
 * command, not a value changed on an existing one.
 */
const doc: CoreDoc = {
  slug: "command-bus",
  title: "The command bus",
  lede: "Every change the chart makes to its own data goes through the same door: dispatch a command, a registered handler runs it, and what it does becomes a reversible patch inside a transaction. Undo is not a snapshot — it is that patch, run backwards.",
  cells: [
    {
      kind: "prose",
      paragraphs: [
        "A drag, a keyboard nudge, a context-menu action and a line of your own application code all end up calling the same method: dispatch(key, payload). The chart does not distinguish who called it — drag-edit dispatches task/move for a mouse drag and the exact same command for the keyboard equivalent, and nothing downstream of the command bus can tell which one happened.",
        "Exactly one plugin owns a given command key. data-store owns task/*, link/*, resource/* and assignment/* — the domain commands that touch the data model — because it is the plugin that can build a Transaction. A UI plugin like drag-edit or the tree-grid never mutates data itself; it computes a payload and dispatches, which is what keeps the write path in one place no matter how many plugins want to trigger it.",
      ],
    },
    {
      kind: "code",
      caption: "Application code dispatches the same commands a drag would.",
      source: `const gantt = StarGantt.create({
  element: document.getElementById("chart"),
  plugins: StarGantt.presetStandard(),
});

const DAY = 86_400_000;

// Same command, same handler, same undo step a drag would produce.
const t0 = Date.now();
// "kernel" is a task id from the sample dataset this page's demos load.
gantt.dispatch("task/move", { id: "kernel", start: t0 + 7 * DAY, end: t0 + 13 * DAY });

// dispatch() never returns a result and never throws back to the caller (see below).
// The only way to observe what happened is the event data-store emits once the write lands.
gantt.on("data/didApplyTransaction", ({ transaction }) => {
  console.log(\`\${transaction.label}: transaction applied\`);
});`,
    },
    {
      kind: "prose",
      paragraphs: [
        "Registering a handler is one call, registerCommand(key, run), made once during a plugin's setup() — there is no separate 'am I already registered' check. The bus keeps a single handler per key, so a second registerCommand() call for a key that already has one silently replaces it; nothing errors, and nothing warns you that the first handler stopped running. In practice this only happens if you register your own handler under a key an official plugin already owns, which is also how you would shadow one on purpose.",
        "Whoever owns the key decides its payload shape and publishes it through the same declaration-merging surface as everything else: a plugin package's .d.ts augments the global Commands interface, so gantt.dispatch(\"task/move\", …) is typed end to end without either side importing the other's source.",
      ],
    },
    {
      kind: "code",
      caption: "A third-party plugin that owns a command of its own, and uses an existing one to implement it.",
      source: `declare module "@stargantt/core" {
  interface Commands {
    "acme.postponeAll": { days: number };
  }
}

const bulkPostpone = StarGantt.definePlugin({
  meta: {
    id: "acme.bulk-postpone",
    dependsOn: ["stargantt.data-store"],
  },
  setup(ctx) {
    const data = ctx.use("stargantt.data");
    const DAY = 86_400_000;

    ctx.registerCommand("acme.postponeAll", ({ days }) => {
      for (const id of data.taskIds()) {
        const task = data.getTask(id);
        if (!task) continue;
        // Re-dispatching an existing command, not calling into data-store directly — this
        // plugin never builds a Transaction itself, it only ever asks for one.
        ctx.dispatch("task/move", {
          id: task.id,
          start: task.start + days * DAY,
          end: task.end + days * DAY,
          // Same coalesceKey on every iteration: the store stamps it onto every resulting
          // transaction, and undo-redo merges an incoming entry into the *immediately
          // preceding* one when the keys match — so the whole loop is one undo step, not
          // one per task, as long as nothing else dispatches in between. A transaction from
          // another source landing mid-loop breaks the run into separate undo steps.
          coalesceKey: "acme.postponeAll",
        });
      }
    });
  },
});`,
    },
    {
      kind: "prose",
      paragraphs: [
        "A command nobody registered — a typo in the key, or a plugin that provides it left out of the composition — is a silent no-op. dispatch() looks the key up, finds nothing, and returns; no error is thrown, no event fires, no fault is reported anywhere. The declaration-merging types make a genuine typo a compile error before you ever run the page, but they cannot catch a key that is spelled correctly and simply has no handler in this particular composition — drop the plugin that owns task/move and every drag on the chart becomes a gesture that does nothing.",
        "A handler that does run and then throws is a different story: the bus wraps every command-runner invocation in try/catch, same as it does for event listeners and extension-point reducers. The throw does not propagate to your dispatch() call — you cannot wrap it in your own try/catch — it is reported as a core/pluginError event carrying the owning plugin's id, and the chart keeps running. That is also why dispatch has no return value to check: success is 'a transaction happened', observed through data/didApplyTransaction, not a value dispatch hands back.",
      ],
    },
    {
      kind: "prose",
      paragraphs: [
        "Inside data-store, a command's handler builds the patches for the change but does not apply them yet. It fires data/willApplyTransaction — cancelable, and other plugins may still append patches of their own to the same transaction — then applies the whole patch list atomically, publishes the tasks store (and links/resources/assignments when the transaction touched them) with the new snapshot, and fires data/didApplyTransaction with the transaction attached. A transaction that gets cancelled here, or a bulk load() that never went through dispatch() at all, produces no transaction and is never pushed to history: load() replaces the dataset outright and is not something undo can meaningfully reverse.",
        "The undo-redo plugin does none of that work itself — it listens for data/didApplyTransaction and pushes the applied transaction onto a stack, exposed to a reader through its own history.state store rather than through an event of its own. Every patch variant is defined as an inverse pair (task/add undoes with task/remove, task/update carries both a before and an after), and undo() turns each stored patch back into a command dispatch — task/remove for a task/add patch, task/update with before and after swapped for a task/update patch — routed back through the same dispatch() as any other command. The history plugin itself sets an internal flag around that replay and ignores the resulting data/didApplyTransaction while it is set, so the replay is not pushed onto the undo stack a second time; separately, the dispatch is stamped with a replay origin so *other* reactive plugins — auto-schedule above all — recognize it as a replay and stand aside instead of re-deriving follow-on changes on top of the state being restored. redo() dispatches the same patches forward again. That is the payoff of everything above: undo has no privileged access to the store, it goes back through the same command bus as a drag or a line of application code, which is also why undo stays cheap regardless of how large the dataset is — the cost of one undo step is the size of that one transaction's patch list, not the size of the chart.",
      ],
    },
    {
      kind: "prose",
      paragraphs: [
        "By default, a mouse drag does not dispatch anything until you let go: drag-edit paints an unsnapped ghost bar that tracks the cursor purely as a visual overlay, and only on release does it dispatch a single task/move with the snapped, rounded result. One gesture, one dispatch, one undo step — coalescing has nothing to merge in that case.",
        "coalesceKey earns its keep in two opt-in cases, both off by default. First, multiDrag: true: a move drag started with the press inside an existing multi-selection dispatches one task/move per other selected task, all stamped with the same key minted for that gesture, and the store copies the key onto each resulting transaction so undo-redo folds the whole group into one undo step instead of one per task. Second, liveUpdate: true, which dispatches task/move on every pointer-move frame instead of waiting for release, so dependents re-schedule live as the bar moves. Both are what coalescing actually protects you from: without the shared key, one drag would leave one undo entry per selected task, or one per frame. The cost is real too — liveUpdate means one transaction, and if auto-schedule is composed one re-schedule pass, per frame, for the whole gesture.",
      ],
    },
    {
      kind: "demo",
      caption: "Drag a bar to dispatch task/move on release, then press Ctrl+Z — undo re-enters the bus through task/update, carrying the inverse of that patch.",
      spec: { preset: { treeGrid: { paneWidth: 260 } } },
    },
  ],
};

export default doc;
