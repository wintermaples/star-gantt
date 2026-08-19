import { T0 } from "../../../lib/data";
import type { PluginDoc, StarGanttApi } from "../../types";

const DAY = 86_400_000;

/** One row whose name is the whole demonstration: it says which edit the chart is standing on. */
const ONE_ROW = [
  { id: "note", parentId: null, name: "Original name", start: T0, end: T0 + 4 * DAY, progress: 0.4 },
] as const;

/**
 * Makes two edits and rewinds one, so the chart shows a state only an undo could have produced. A
 * single edit followed by an undo would land back on the data the chart was handed — a picture
 * identical to a composition with no history at all (D-23).
 */
function editTwiceThenUndo(sg: StarGanttApi) {
  return sg.definePlugin({
    meta: { id: "docs.undo-redo-overview", dependsOn: ["stargantt.undo-redo", "stargantt.data-store"] },
    setup(ctx) {
      const history = ctx.use("stargantt.history");
      // `load()` publishes the `tasks` store like any other write, so the first notification is
      // the dataset arriving. Disposed first: each edit below publishes `tasks` again.
      const off = ctx.use("stargantt.data").tasks.subscribe(() => {
        off.dispose();
        ctx.dispatch("task/update", { id: "note" as never, after: { name: "First edit" } });
        ctx.dispatch("task/update", { id: "note" as never, after: { name: "Second edit" } });
        history.undo();
      });
      ctx.own(off);
    },
  });
}

const doc: PluginDoc = {
  id: "stargantt.undo-redo",
  summary:
    "Records every applied transaction and replays it in reverse on undo, forward again on redo — no DOM, no canvas, pure logic behind three small config fields.",
  overview: [
    "This plugin draws nothing. It listens for the settle signal data-store fires after every applied transaction (`data/didApplyTransaction`), keeps the reversed and re-applied forms of each on two stacks, and exposes both through `stargantt.history`. Undoing a drag, an inline edit, a dependency retype or a resource assignment is the same mechanism for all of them, because every one of those ends the same way: a command produces a transaction, data-store applies it, and this plugin records the patches that would put it back.",
    "It is its own package rather than folded into data-store or interaction. Being its own plugin is what makes it optional in the strict sense: a composition that genuinely never needs undo (a fully read-only viewer, a chart driven entirely by an external source of truth) can drop it, and every other plugin's commands keep working exactly as before, they just stop being reversible.",
    "Its config surface is deliberately small: a host wires its own undo/redo buttons to one line of store subscription (`ctx.own(history.state.subscribe(sync))`) rather than an imperative binding helper, leaving exactly three fields to configure: how many transactions the stack keeps, what gets spoken after an undo or redo, and which keyboard chords trigger them.",
  ],
  whenYouNeedIt:
    "whenever an edit should be reversible. Every drag, inline edit, dependency change and assignment change already goes through data-store's transaction pipeline whether or not this plugin is present — remove undo-redo and those transactions simply go unrecorded, so a user's last action has no way back except editing it again by hand.",
  demo: {},
  overviewDemo: {
    kind: "configured",
    spec: {
      preset: {
        undoRedo: { keys: { undo: ["Ctrl+Z", "Meta+Z"], redo: ["Ctrl+Shift+Z", "Meta+Shift+Z"] } },
      },
      data: ONE_ROW,
      plugins: (sg) => [editTwiceThenUndo(sg)],
    },
    caption:
      "The row reads `First edit` because two renames ran at mount and one `undo()` rewound the second. Click the row, then press Ctrl+Shift+Z to walk forward to `Second edit`, or Ctrl+Z twice to get back to `Original name` — the chart was never handed either of the first two names.",
  },

  properties: [
    {
      name: "messages",
      prose: [
        "Replacement wording for the two strings spoken through the aria-live region after a completed undo or redo — `undone` (default \"Undone\") and `redone` (default \"Redone\"). They are announcements, not labels: nothing about them is painted, and a sighted user with no screen reader running will never encounter either string.",
        "Setting a key to the empty string suppresses that announcement rather than speaking a blank one — useful for a host that already shows its own toast or status line and does not want two things saying the same thing at once. A key left out of the object keeps its English default; you can override just `redone` without having to restate `undone`.",
        "These are spoken only when `stargantt.a11y` is present, and only through its `stargantt.focus` service — a composition without that plugin announces nothing regardless of what this option is set to. They are also unrelated to the *label* an undo/redo UI would show for a step, such as \"Move task\": that text comes from data-store's own `messages`, not this plugin's.",
      ],
      demo: {
        kind: "none",
        reason:
          "An aria-live announcement has no visual rendering at all — it is read by assistive technology, never painted to the canvas — so no chart state before or after configuring it can look any different.",
      },
    },
    {
      name: "limit",
      prose: [
        "The number of transactions the undo stack keeps before it starts dropping the oldest. It defaults to 200, which is generous enough that most sessions never reach it; a chart that expects very long editing sessions, or one under memory pressure because it also holds ten thousand rows, is the case for lowering it.",
        "Eviction is silent and permanent: the oldest entry is simply gone, with no separate event beyond the same store update that fires on every other stack change, and no way to recover it. This has nothing to do with the redo stack, which is not size-limited at all — it is bounded only by how many times you have undone in a row, so lowering `limit` shortens how far back a user can undo without shortening how far forward they can redo.",
        "A value that is not a positive finite integer is silently ignored and the default of 200 stands — a config of `{ limit: 0 }` or `{ limit: -5 }` does not disable history, it just gets the default. There is no supported way to keep zero steps of history short of not installing this plugin.",
      ],
      demo: {
        kind: "none",
        reason:
          "The effect only shows up after recording well past 200 transactions in one session, which no static chart on this site can demonstrate — every demo chart here starts fresh, with an empty history, regardless of this option's value.",
      },
    },
    {
      name: "keys",
      prose: [
        "Replaces the keyboard chords that trigger undo and redo. Omit it and you get the conventional set for both platform families at once — `Ctrl+Z` / `Meta+Z` for undo, `Ctrl+Shift+Z` / `Meta+Shift+Z` / `Ctrl+Y` for redo — so a chart works the way a user already expects on Windows, Linux and macOS without you branching on platform yourself.",
        "An array you provide replaces the corresponding default in full rather than adding to it: `{ keys: { undo: [\"Ctrl+Z\"] } }` drops `Meta+Z` for undo entirely, and leaves redo's three defaults untouched because you did not mention it. An empty array leaves that operation with no keyboard chord at all — the `history/undo` command is still dispatchable by other means (a bound button, your own listener), it just has no key.",
        "The chords are contributed to `keys/bindings`, which the a11y plugin defines and dispatches. Compose a chart without that plugin and this option does nothing at all — not an error, just an inert config, because there is no consumer left to bind the chord to. `presetStandard()` includes a11y, so this only bites a hand-assembled plugin list.",
      ],
      demo: {
        kind: "none",
        reason:
          "A chord is invisible until pressed, and this site's demo charts do not accept focus for a scripted keypress to land on — there is no pixel a picker could compare before and after a chord rebinding.",
      },
    },
  ],

  notes: {
    services: {
      "stargantt.history":
        "The full read/write surface: `canUndo`/`canRedo`/`depth` in the store for a toolbar's live state, `peekUndo()`/`peekRedo()` for the label of the next step, `undoLabels()`/`redoLabels()` for a dropdown of pending steps, `undo()`/`redo()`/`clear()` to act. `serialize()` and `restore()` exist for one narrow case: carrying history across a host's own dispose/recreate cycle, for options that can only be set at construction — they are not a general persistence feature and not a substitute for data-store's own load/save path.",
    },
    events: {
      __empty:
        "This plugin emits no events. Every stack mutation — record, merge, undo, redo, clear, limit eviction, restore — sets the `stargantt.history` store exactly once instead; subscribe to `history.state` rather than an event.",
    },
    commands: {
      "history/undo":
        "Reverts the transaction the undo stack's top entry represents, in reverse patch order, and pushes it onto the redo stack. A no-op when the stack is empty — safe to bind to a chord or a button without guarding it with `canUndo` first.",
      "history/redo":
        "Re-applies the transaction the redo stack's top entry represents, in forward patch order, and pushes it back onto the undo stack. A no-op when the stack is empty, for the same reason `history/undo` is.",
    },
    extensionPoints: {
      __empty:
        "This plugin defines no extension point of its own. It is a *contributor* to the a11y plugin's `keys/bindings` (one contribution per configured chord) — there is nothing here for a third-party plugin to extend, only default chords to override through `keys`.",
    },
  },

  recipes: [
    {
      title: "Drive a toolbar's disabled state from the history store",
      intent:
        "No `bindButtons()` helper — subscribe to the store directly, which is one line and needs no extra API to learn.",
      code: `const gantt = create({ element: el, plugins: presetStandard() });
const history = gantt.service("stargantt.history");
const undoBtn = document.querySelector("#undoBtn");
const redoBtn = document.querySelector("#redoBtn");

history.state.subscribe((state) => {
  undoBtn.disabled = !state.canUndo;
  redoBtn.disabled = !state.canRedo;
});

undoBtn.addEventListener("click", () => gantt.dispatch("history/undo", undefined));
redoBtn.addEventListener("click", () => gantt.dispatch("history/redo", undefined));`,
    },
    {
      title: "Carry undo history across a locale change",
      intent:
        "locale is a create()-time option, so switching it means dispose and recreate. serialize()/restore() are what stop that from silently dropping the user's history.",
      code: `const snapshot = gantt.service("stargantt.history").serialize();
localStorage.setItem("gantt-history", JSON.stringify(snapshot));

gantt.dispose();
const next = create({ element: el, plugins: presetStandard(), locale: "ja" });
next.service("stargantt.data").load(sameDataset);
next.service("stargantt.history").restore(JSON.parse(localStorage.getItem("gantt-history")));`,
    },
    {
      title: "A single undo/redo chord, no macOS alternates, with silent announcements",
      intent:
        "Replace the default chord list entirely for a chart embedded in a host that already owns Ctrl+Shift+Z for something else, and suppress the aria-live wording in favor of the host's own status line.",
      code: `presetStandard({
  undoRedo: {
    keys: { undo: ["Ctrl+Z"], redo: ["Ctrl+Y"] },
    messages: { undone: "", redone: "" },
  },
})`,
    },
  ],
};

export default doc;
