import type { PluginDoc, StarGanttApi } from "../../types";

/**
 * Puts the keyboard inside the chart and asks it for its shortcut list, so the overview chart shows
 * the two surfaces this plugin owns — the focus box and the help dialog — instead of the chart they
 * appear over, which is identical to one composed without the plugin at all.
 *
 * `focus()` is the plugin's own service, the same call a host's "jump to this task" button makes.
 * The `?` press has no service behind it, so the demo sends the keystroke: an ordinary DOM keydown
 * on the chart root, which is exactly what the dispatcher listens for.
 */
function focusAndShowShortcuts(sg: StarGanttApi, taskId: string) {
  return sg.definePlugin({
    meta: {
      id: "docs.a11y-overview",
      dependsOn: ["stargantt.a11y", "stargantt.data-store"],
    },
    setup(ctx) {
      // `load()` publishes the `tasks` store like any other write, so the first notification is
      // the dataset arriving.
      const off = ctx.use("stargantt.data").tasks.subscribe(() => {
        off.dispose();
        const timer = setTimeout(() => {
          ctx.use("stargantt.focus").focus(taskId as never);
          ctx.root.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true }));
        }, 32);
        ctx.own({ dispose: () => clearTimeout(timer) });
      });
      ctx.own(off);
    },
  });
}

const doc: PluginDoc = {
  id: "stargantt.a11y",
  summary:
    "Makes the chart operable from a keyboard and legible to a screen reader: a virtualized treegrid mirror, a roving focus, and every operation routed through a shortcut table other plugins can extend.",
  overview: [
    "Every other official plugin assumes a pointer. This one is what makes the same chart usable without one: it builds a hidden `role=\"treegrid\"` DOM next to the canvas, mirroring exactly the rows currently on screen, and moves a roving tabindex through it with the arrow keys. What a sighted user does by dragging and clicking, a keyboard user does through this plugin's bindings — and because every binding, built-in or contributed, goes through the same `keys/bindings` extension point this plugin defines, a chord it owns today can be replaced by a later contribution without touching its code. Interaction's own drag-edit chords (`Ctrl+ArrowRight` and its siblings) and undo-redo's chords are both buffered and inert until this plugin is composed to give them somewhere to dispatch to — the a11y plugin is the consumer every other plugin's keyboard story quietly depends on.",
    "None of that shows up on a canvas at rest. The mirror is off-screen text, the announcements are an `aria-live` region nobody sees, and the focus box this plugin draws only exists after a placement has actually happened — tabbing into the widget, an arrow key, a click. A chart nobody has interacted with is pixel-identical whether this plugin is composed or not, which is exactly the property that makes it safe to leave on unconditionally: it costs nothing visually and pays for itself the moment a keyboard or a screen reader shows up.",
    "The seven options below are almost entirely about who gets what channel and how much of it is turned on — none of them repaint the chart by themselves, because the effects they gate are DOM attributes, live-region text and on-demand dialogs. Verifying any of them means using a keyboard (or a screen reader) against the running chart, not comparing two screenshots.",
  ],
  whenYouNeedIt:
    "whenever the chart ships to anyone who cannot or does not use a mouse — which, for a public or enterprise product, is every chart. Remove it and the treegrid mirror, the roving focus, the live announcements and the `keys/bindings` point all disappear with it: the rows and bars the canvas paints become unreachable from a keyboard, and interaction's own keyboard chords lose their dispatcher. The grid header is unaffected, since tree-grid owns its own header keyboard model (sort cycling, column resize) independently of this plugin.",
  demo: { preset: { treeGrid: { rowHeight: 30, paneWidth: 200 } } },
  overviewDemo: {
    kind: "configured",
    spec: {
      preset: { treeGrid: { rowHeight: 30, paneWidth: 200 }, a11y: { shortcutHelp: true } },
      plugins: (sg) => [focusAndShowShortcuts(sg, "kernel")],
    },
    caption:
      "The keyboard is inside the chart: `Core kernel` holds the focus, the timeline scrolled sideways to bring its bar into view, and the panel is the shortcut list `?` opens. Close it with Escape and the arrow keys walk the rows from there.",
  },

  properties: [
    {
      name: "label",
      prose: [
        "This is the name a screen reader announces for the whole treegrid, and it only matters once a page holds more than one thing worth naming — two embedded charts, or a chart next to another treegrid. Leave every instance on the default and a screen-reader user hears \"Gantt chart\" twice with no way to tell which is which from the announcement alone; setting a distinct label per instance is the fix, and it costs nothing else, since it touches only the mirror's `aria-label`, applied once when the mirror is created.",
        "It is easy to reach for this and set it to something that duplicates visible text already next to the chart — a page heading, say — which is redundant rather than wrong. The more useful label names the chart's role in the page (\"Sprint 14 burndown\", \"Q3 releases\") rather than repeating what a sighted user already reads above it. An empty or blank string is ignored and the default stands, since a nameless grid is announced as a bare \"treegrid\".",
      ],
      demo: {
        kind: "none",
        reason:
          "aria-label is inaudible to a sighted eye and invisible to a pixel diff; it changes what a screen reader announces, not anything a chart screenshot could show differently.",
      },
    },
    {
      name: "messages",
      prose: [
        "Every string this plugin speaks — the text of a mirrored row, the expand/collapse announcement, the selection count, the dependency read-out, the help dialog's title and close-button name, the zoom announcement, the sort-cycle announcement, the keyboard-driven edit-commit announcement, the summary table's caption and column headers — is a builder function in this one catalog, replaceable a key at a time. Leaving a key out keeps its English default; supplying one only changes that key, so a host can, for example, replace `selectionCount` for pluralization without touching how rows are described.",
        "The catalog is resolved once, at setup, from whatever object is passed in — it is not re-read afterward, so swapping the object later has no effect on a running chart. A throwing builder is caught and reported through `core/pluginError`, and the built-in default answers that one call. Two things are deliberately outside it: the mirror's own accessible name is `label`, not a catalog key, because one string should have exactly one channel; and `rowText`'s dates stay ISO (`YYYY-MM-DD`) regardless of the chart's locale, since a locale-aware date needs the instant and an `Intl` formatter, which only your own builder can supply — there is no built-in locale-aware default to opt into.",
      ],
      demo: {
        kind: "none",
        reason:
          "Every member of this catalog produces spoken or off-screen text only — row announcements, dialog chrome, live-region wording — none of which a canvas screenshot can render differently.",
      },
    },
    {
      name: "syncSelection",
      prose: [
        "By default, moving the keyboard focus also moves the selection — arrow to a row and that row becomes selected, exactly as if you had clicked it. That is the right default for a chart with no separate focus indicator worth mentioning, but it has a cost the moment something else reacts to selection: a details panel that repaints on every selection change, or an export that operates on \"the selected tasks\", now repaints or changes scope on every arrow press, whether or not that was the intent.",
        "Set it to `false` and browsing stops being selecting. The roving focus still moves, still scrolls the row into view and still draws its own stroke-only box on the bar, but the selection — and anything downstream of it — stays exactly where a pointer last left it. The trade is that the focus visualization — the canvas box, the mirrored grid row's inset outline and the pane's own focus ring, all three together — becomes the only cue of keyboard position, replacing the selection highlight; a chart whose theme sets `--sg-focus-stroke` to something barely visible will read as unresponsive to arrow keys even though it is working correctly, since that one token drives all three cues.",
        "Without a composed `interaction()` there is nothing to sync in the first place — this option resolves an optional, late-bound `SelectionService`, and an absent one simply leaves plain focus moves moving only the focus, exactly as `syncSelection: false` would, with no error reported either way.",
      ],
      demo: {
        kind: "none",
        reason:
          "The behavioral difference only appears once a placement happens — an arrow press or a FocusService.focus() call — which a static demo config cannot trigger, so both values paint the same untouched chart.",
      },
    },
    {
      name: "describeDependencies",
      prose: [
        "Turns each mirrored row's link neighborhood into a spoken description: what it depends on, what depends on it. Without this, a screen-reader user can discover a link only by opening it in a side panel or by cross-referencing the visible arrows on the canvas, which are exactly the thing they cannot see. With it on, the relationship rides along with the row's own text the moment focus lands there.",
        "It only has anything to describe when the composition also has a dependency source — links loaded directly into the store, or created through interaction's link-drawing context-menu entries. On a chart with no links, turning this on changes nothing at all: every row's predecessor and successor list is empty, so no row gains an `aria-describedby`. It is inexpensive to leave on by default in a composition that has dependencies, since the extra markup is generated only for rows that actually carry links, and the description nodes live in a dedicated hidden container, never inside the treegrid rows themselves.",
      ],
      demo: {
        kind: "none",
        reason:
          "It attaches an aria-describedby reference to hidden text; the description exists only in the accessibility tree and never changes a single painted pixel a screenshot diff could catch.",
      },
    },
    {
      name: "shortcutHelp",
      prose: [
        "Gives a keyboard user a way to discover what this chart's keys do, which matters because there is no visible affordance for any of them — no toolbar button reads \"press + to expand\". With this on, `?` opens a dialog that lists the current `keys/bindings` collection, one line per chord, built from whatever is actually composed at the moment it opens: a plugin that contributes its own binding shows up here automatically, with no extra wiring in this option.",
        "The catch is that only described bindings appear. A custom chord contributed without a `description` works exactly the same as any other binding but is invisible to this dialog — silently, with no warning — so a team adding shortcuts through `keys/bindings` should treat `description` as required, not optional, if they also turn this option on. The dialog is a full modal while open: every other chart shortcut is suppressed until it closes, which is deliberate but worth knowing if a keyboard test seems to \"stop working\" right after `?`.",
      ],
      demo: {
        kind: "none",
        reason:
          "The dialog only exists after a `?` keypress a demo config cannot simulate, and its content is generated on open from the live keys/bindings collection rather than from anything in this option's value.",
      },
    },
    {
      name: "zoomKeys",
      prose: [
        "Lets `+` and `-` step the timeline zoom ladder from the keyboard, dispatching the view plugin's own `timeline/zoomIn` / `timeline/zoomOut` commands directly rather than going through interaction's `zoomControls` group — so this works even in a composition with no zoom toolbar mounted at all, and it walks the full composed zoom ladder rather than whatever subset `zoomControls.levels` might restrict the toolbar to.",
        "What it costs is the two keys it was already using: with this on, `+` and `-` stop expanding and collapsing the focused summary row and start zooming instead, because `keys/bindings` is last-write-wins and this option's contribution is registered after the built-in expand/collapse pair. Nothing is actually lost — `ArrowRight` and `ArrowLeft` still expand and collapse per the APG treegrid convention — but a team that documented `+`/`-` as \"expand/collapse\" for their users needs to update that documentation the moment this option is turned on.",
      ],
      demo: {
        kind: "none",
        reason:
          "The zoom step only fires on a real + or - keypress against a mounted, focused chart; a demo config cannot dispatch that keystroke, and the resulting timeline repaint would be identical to a reader manually changing zoom, not to this option's value.",
      },
    },
    {
      name: "summaryTable",
      prose: [
        "Gives a screen-reader user a way to survey the whole dataset at once, which the virtualized mirror deliberately does not offer — the mirror only ever holds the rows around the current scroll position, by design, so that a ten-thousand-row chart does not put ten thousand DOM nodes in the accessibility tree. `Ctrl`+`Alt`+`S` trades that virtualization for a one-off plain HTML table built from the whole store, tree order, collapsed branches included, so the reader's own table navigation commands can be used to scan it.",
        "It is built on demand and only on demand — never eagerly at setup — so leaving this on costs nothing until someone actually presses the chord, at which point building the table is proportional to task count, capped at the first 1000 tasks (the caption states the truncation). That cap is worth knowing before relying on this for a genuinely large project: past a thousand tasks, the table is a partial survey, not a complete one, and the caption's wording is the only place that says so.",
      ],
      demo: {
        kind: "none",
        reason:
          "The table is visually hidden even while open and is built strictly on demand from a Ctrl+Alt+S keypress a demo cannot simulate, so no chart state this option controls is ever painted.",
      },
    },
  ],

  notes: {
    services: {
      "stargantt.focus":
        "Reach for this from application code or a sibling plugin that needs to read or move the keyboard focus programmatically — jumping to a task after a search, say, or announcing a result through the same live region this plugin already owns rather than building a second one.",
    },
    events: {
      __empty:
        "This plugin emits no events. The store is set only on an effective placement — never for the initial row-0 tabindex fallback a chart shows before anyone has interacted with it — so subscribe to `FocusService.state` rather than an event; a listener that mirrors the focus elsewhere never fires on a chart nobody has touched yet.",
    },
    commands: {
      __empty:
        "This plugin dispatches into other plugins' commands rather than declaring its own — Enter, for instance, dispatches tree-grid's edit-start command with the focused task's id. There is nothing here of this plugin's own to call imperatively.",
    },
    extensionPoints: {
      "keys/bindings":
        "Collect, last-write-wins: add a chord by contributing here, and replace one of this plugin's own defaults (including the `+`/`-` pair `zoomKeys` shadows) by contributing the same chord string after it. Give every binding a `description` if `shortcutHelp` is also on — an undescribed binding works but never appears in that dialog.",
    },
  },

  recipes: [
    {
      title: "Distinguish several embedded charts for screen-reader users",
      intent:
        "The default label is the same constant on every chart. A page with more than one gantt needs each to announce a name a listener can tell apart.",
      code: `presetStandard({
  a11y: { label: "Sprint 14 burndown" },
})`,
    },
    {
      title: "Let keyboard users browse without disturbing a live selection",
      intent:
        "A details panel or export that reacts to selection should not repaint on every arrow press. Decoupling focus from selection keeps browsing from acting as selecting.",
      code: `presetStandard({
  a11y: { syncSelection: false },
})`,
    },
    {
      title: "Turn on the full accessibility feature set for a public release",
      intent:
        "Three of the four opt-in features — dependency descriptions, the shortcut-help dialog and the summary table — are off by default, so a composition opts in deliberately (the fourth, `zoomKeys`, is omitted here since it competes with expand/collapse for the same two keys). `label` overrides the default container name rather than turning something on, since some label is always present. This is the combination a chart shipping to the public — where keyboard and screen-reader use cannot be assumed away — typically wants.",
      code: `presetStandard({
  a11y: {
    label: "Project timeline",
    describeDependencies: true,
    shortcutHelp: true,
    summaryTable: true,
  },
})`,
    },
  ],
};

export default doc;
