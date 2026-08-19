import { T0 } from "../../../lib/data";
import type { AnyPlugin, PluginDoc, StarGanttApi } from "../../types";

const DAY = 86_400_000;

/**
 * A task two days from the origin (always on screen) and one 200 days out — off the right edge of
 * any viewport this site renders at, regardless of zoom. `selection.revealSelected` needs a bar
 * that starts off screen to show a difference.
 */
const REVEAL_TASKS = [
  { id: "near", parentId: null, name: "Kickoff", start: T0, end: T0 + DAY * 2 },
  { id: "far", parentId: null, name: "Launch review", start: T0 + DAY * 200, end: T0 + DAY * 202 },
] as const;

/** Two rows given identical dates, so a keyboard-driven edit is visible against the untouched one. */
const TWO_ROWS = [
  { id: "untouched", parentId: null, name: "Left alone", start: T0 + DAY, end: T0 + 4 * DAY, progress: 0.5 },
  { id: "edited", parentId: null, name: "Moved by Ctrl+→", start: T0 + DAY, end: T0 + 4 * DAY, progress: 0.5 },
] as const;

/**
 * Runs interaction's keyboard equivalent of a drag — `Ctrl+ArrowRight`, dispatched through the
 * a11y plugin's key-binding table — three times against one row.
 *
 * A pointer drag would be the other half of the same edit, but a drag has no resting state: the
 * ghost, the tooltip and the insertion line all exist only between the press and the release, so a
 * chart with interaction composed and one without it are the same picture until something has
 * actually been edited (D-23). The keystroke is dispatched as an ordinary DOM keydown on the chart
 * root, which is what the binding dispatcher listens for; `focus()` first, since the chord acts on
 * the focused row.
 */
function keyboardMoveOnLoad(sg: StarGanttApi, taskId: string, presses: number): AnyPlugin {
  return sg.definePlugin({
    meta: {
      id: "docs.interaction-overview",
      dependsOn: ["stargantt.interaction", "stargantt.a11y", "stargantt.data-store"],
    },
    setup(ctx) {
      // `load()` publishes the `tasks` store like any other write, so the first notification is
      // the dataset arriving. The subscription disposes itself before the keystrokes below, which
      // do not publish `tasks` again.
      const off = ctx.use("stargantt.data").tasks.subscribe(() => {
        off.dispose();
        const timer = setTimeout(() => {
          ctx.use("stargantt.focus").focus(taskId as never);
          for (let i = 0; i < presses; i += 1) {
            ctx.root.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", ctrlKey: true, bubbles: true }));
          }
        }, 32);
        ctx.own({ dispose: () => clearTimeout(timer) });
      });
      ctx.own(off);
    },
  });
}

/** Selects a task the moment data loads — the call a host page makes to drive selection from code. */
function selectOnLoad(taskId: string): (sg: StarGanttApi) => AnyPlugin[] {
  return (sg) => [
    sg.definePlugin({
      meta: { id: "docs.interaction-select-demo", dependsOn: ["stargantt.interaction", "stargantt.data-store"] },
      setup(ctx) {
        const off = ctx.use("stargantt.data").tasks.subscribe(() => {
          off.dispose();
          ctx.use("stargantt.selection").select([taskId] as never);
        });
        ctx.own(off);
      },
    }),
  ];
}

/** Selects, then duplicates, a branch the moment data loads — the call a menu item would make. */
function duplicateOnLoad(taskId: string): (sg: StarGanttApi) => AnyPlugin[] {
  return (sg) => [
    sg.definePlugin({
      meta: { id: "docs.interaction-clipboard-demo", dependsOn: ["stargantt.interaction", "stargantt.data-store"] },
      setup(ctx) {
        const off = ctx.use("stargantt.data").tasks.subscribe(() => {
          off.dispose();
          ctx.use("stargantt.selection").select([taskId] as never);
          ctx.dispatch("clipboard/duplicate", undefined);
        });
        ctx.own(off);
      },
    }),
  ];
}

/** Runs an incremental search the instant the chart is ready — the call a host's own search box makes. */
function filterOnReady(query: string): (sg: StarGanttApi) => AnyPlugin[] {
  return (sg) => [
    sg.definePlugin({
      meta: { id: "docs.interaction-filter-demo", dependsOn: ["stargantt.interaction"] },
      setup(ctx) {
        ctx.on("lifecycle/ready", () => {
          ctx.use("stargantt.filter").setQuery(query);
        });
      },
    }),
  ];
}

const doc: PluginDoc = {
  id: "stargantt.interaction",
  summary:
    "Every pointer and keyboard interaction on the chart — selection, drag-edit, snapping, tooltips, context menu, zoom toolbar, clipboard, filter/search, the edit dialog and the side panel — as one composed plugin.",
  overview: [
    "This is the largest official plugin, and it is one package on purpose: ten features — selection, drag-edit, snap, tooltip, context-menu, zoom-controls, clipboard, filter-search, edit-dialog, side-panel — all compete for the same pointer events, and packaging them together gives them one gesture arbiter instead of ten independent listeners. A press, a drag or a hover is interpreted once, in one internal state machine, and dispatched to whichever of the eleven config groups below actually wants it. You never see the arbiter directly; what you configure is still shaped like ten small features, each under its own key.",
    "Four of those groups are on by default the moment interaction is composed — `selection`, `dragEdit`, `snap`, `tooltip` — because they are the baseline pointer behavior a gantt chart is expected to have: click a bar to select it, drag it to move it, have the drop rounded to something sensible, see a name and two dates on hover. The other six — `contextMenu`, `zoomControls`, `clipboard`, `filterSearch`, `editDialog`, `sidePanel` — are off until you pass their nest, even an empty one, which is what lets a chart start minimal and grow one feature at a time without ever hand-assembling a plugin array.",
    "It is also the plugin that owns the most public surface in the standard preset: three services (`stargantt.selection`, `stargantt.snap`, `stargantt.filter`), six extension points third parties can contribute into, and four commands. Removing it does not just remove a feature — it removes the ability to select, edit, or search the chart at all, leaving `task-bars` painting bars nothing can touch.",
  ],
  whenYouNeedIt:
    "as soon as a reader is expected to do anything with the chart besides look at it. A pure reporting view — a printed export, a read-only embed driven entirely by an external tool — can leave it out; every other composition on this site assumes it is present, because task-bars alone paints pixels nobody can act on.",
  demo: {},
  overviewDemo: {
    kind: "configured",
    spec: { data: TWO_ROWS, plugins: (sg) => [keyboardMoveOnLoad(sg, "edited", 3)] },
    caption:
      "Both rows were loaded with the same dates; the lower one is three days later because `Ctrl+ArrowRight` ran three times at mount — interaction's keyboard equivalent of dragging a bar, routed through the a11y plugin's shared key-binding table. Press either bar and drag it sideways to make the same edit by hand.",
  },

  properties: [
    {
      name: "selection",
      prose: [
        "Selection is the one group here that is not really optional: even with every field left at its default, a plain click already replaces whatever was selected before, and the frame it draws is what every other plugin on the page — the side panel, the edit dialog, the export flow — reads to know what \"the current task\" means. `mode` is the field that changes the most: `\"single\"` (the default) replaces on every press, `\"multi\"` adds Ctrl/Cmd toggling, Shift range and rubber-band dragging over empty chart space, and `\"none\"` turns pointer selection off entirely while leaving the service live for a host that wants to be the only thing driving it.",
        "`shortcuts` bundles three keyboard conveniences — select-all, clear-on-Escape, bulk-delete — and every one of them defaults to off, because turning one on is a decision about which keystroke the chart now owns instead of the hosting page. `confirmDelete` replaces the built-in \"Delete N tasks?\" dialog with your own policy (or a silent refusal), and `revealSelected` is the one field that changes existing behavior invisibly: on by default, it scrolls a newly selected task's bar into view whenever the grid or a `select()` call places the selection, never from a direct bar press.",
        "None of this competes with `dragEdit`'s own drag gestures — the gesture arbiter decides once whether a press is the start of a selection, a rubber band, or a date drag, so turning on `multi` mode does not make ordinary editing any less reliable. It does compete with a custom marquee tool a third party might want to build on the same `pointer/background` event, which is worth knowing before you add one.",
      ],
      demo: {
        kind: "values",
        prerequisite: { data: REVEAL_TASKS, plugins: selectOnLoad("far") },
        values: [
          { label: "default — revealSelected scrolls the far task into view", demo: {} },
          {
            label: "revealSelected: false — chart stays where it was",
            demo: { preset: { interaction: { selection: { revealSelected: false } } } },
          },
        ],
      },
    },
    {
      name: "dragEdit",
      prose: [
        "This is the write path behind almost every pointer gesture on the chart: press-drag a bar's body to move it, a handle to resize it, the progress strip to change how complete it is, and — through the gesture arbiter's row and lane states — drag a grid row to reorder it or a bar vertically to reassign it to another resource, when `rowDrag` or `resourceDrag` is on. Eleven fields cover all of that, and every one of them defaults to the conservative choice: `enabled` is the only thing on by default, everything else — `liveUpdate`, `rowDrag`, `clickMove`, `multiDrag`, `dependencyPreview`, `resourceDrag`, `autoScroll`, `frameSync`, `dragTooltip` — starts off, so a fresh `interaction()` composition edits dates and progress by pointer and by keyboard chord and does nothing else.",
        "`enabled: false` is the field to reach for before hand-assembling a different plugin array for a read-only role: it withdraws every pointer gesture and key chord this group contributes while leaving selection, tooltip and everything else in the composition untouched, so one config difference switches a chart between editable and read-only. `minDuration` is the guard against a resize that accidentally turns a two-day task into a same-day one; `clickMove` is the WCAG 2.2 dragging-movements alternative — pick up with one click, place with another, no drag required.",
        "It commits everything through the ordinary command path — `task/move`, `task/setProgress`, `task/update` — the same commands a script could dispatch, and it does not decide what counts as a valid date: that is `snap`'s job, consulted at the moment of each edit. Its own geometry comes from `stargantt.task-bars`, so it can never draw a ghost that disagrees with what is already on screen.",
      ],
      demo: {
        kind: "none",
        reason:
          "Almost everything this group draws — the ghost, the drag tooltip, the insertion line, the lane outline, the dependency preview — exists only between a press and a release. A resting, re-mounted chart looks identical across every value of every field here; the overview chart above works around that by running the keyboard equivalent of a drag instead of a live gesture a picker cannot perform.",
      },
    },
    {
      name: "snap",
      prose: [
        "Snap answers one question — given an instant a drag or a keyboard edit is about to commit, what should it round to — and it is what every editor in this composition consults rather than hardcoding its own rounding rule. `unit` (default `\"scale\"`) follows the timeline header's current zoom, so precision tightens automatically as a reader zooms in; fixing it to a calendar unit is for a chart whose business rules need a boundary the zoom level does not always expose.",
        "`workingDays` and `alignToTasks` refine where an edit lands — keeping it inside working time, or sticking it exactly to another task's edge — and both are inert unless the composition gives them something to consult (a calendars plugin for the former, the data store's own task edges for the latter). `pushSuccessors` is a different kind of feature entirely: instead of changing where an edit lands, it cascades a forward push through dependent tasks in the same transaction, so one undo reverts the edit and everything it pushed together.",
        "`enabled: false` disables rounding entirely: drags commit the pointer's raw, unrounded instant and keyboard steps fall back to one UTC day. Every field here changes what number an edit commits to, never anything painted before the edit happens — which is also why nothing on this page can show it as a picture rather than a rule.",
      ],
      demo: {
        kind: "none",
        reason:
          "Snap has no DOM and no canvas layer of its own; its whole effect is the number a drag or a keyboard edit commits to, which only exists at the moment an edit happens. A static, re-applied chart looks identical for every value of every field here.",
      },
    },
    {
      name: "tooltip",
      prose: [
        "One DOM panel, mounted once, shown or hidden as the pointer acts on a bar — it never touches canvas and never changes layout, so task-bars, timeline-scale and the tree grid look the same whether this group is composed in or configured differently. `trigger` decides what shows it (`\"click\"` by default, plus `\"hover\"` and `\"both\"`); `showDelay` and `hideDelay` tune the hover timing, including the grace window that lets a reader move the pointer from the bar onto the panel itself to select its text.",
        "`content` is the fallback wording — name plus start and end dates by default — consulted only after every `tooltip/content` extension-point contribution has already declined for that hit, so a third-party plugin adding tooltip text for its own hit kind always outranks whatever `content` says. Passing `null` removes the fallback entirely rather than replacing it, which is the shape to reach for when you would rather show nothing than the wrong noun for your domain.",
        "None of the four fields here change anything about a chart nobody has touched: the panel exists only after a click, a hover, or the a11y plugin's own focus-driven display places it. A `trigger` of `\"click\"` and a `trigger` of `\"hover\"` produce an identical resting chart, which is why the value picker below is unavailable and the overview demonstrates the panel by dispatching a pointer move itself.",
      ],
      demo: {
        kind: "none",
        reason:
          "Every field here changes which pointer or keyboard-focus gesture shows the panel, never anything about a chart nobody has interacted with. A picker with no simulated gesture would show identical resting screenshots regardless of which value is selected.",
      },
    },
    {
      name: "contextMenu",
      prose: [
        "Off until you pass its nest — even `{}` is enough. Right-press a bar, a handle, a grid row or empty chart space and the menu opens at the press point with up to six built-in entries: insert, duplicate, delete, the two-step link-drawing pair, and a sixth `cancel-link` entry while a link source is pending. `items` replaces that fallback provider outright (or removes it with `null`); every `contextmenu/items` contribution — from any plugin, official or third-party — is appended after whatever the fallback resolved to, in registration order.",
        "`insertMode` decides only one thing: whether the built-in Insert entry files the new task as a child of the pressed one (the default, which also promotes a leaf to a summary) or as a sibling after it. A background press below the last row, or any background press without `stargantt.tree-grid` composed, always creates a top-level task regardless of this field, because there is no row model to locate a parent with.",
        "The menu is transient: it exists in the DOM only while open, and a chart that never opens it looks exactly like a composition without this group configured at all — which is exactly what makes both fields here impossible to show as a static picture rather than a described interaction.",
      ],
      demo: {
        kind: "none",
        reason:
          "The menu paints nothing while closed, and this site's demo harness screenshots a chart at rest rather than opening one. Every value of items or insertMode produces an identical resting chart; the difference only exists inside a menu a static picker never opens.",
      },
    },
    {
      name: "zoomControls",
      prose: [
        "The one group here that is pure UI chrome with no chart-state opinion at all: a small floating toolbar — zoom slider, plus/minus, fit-to-project, jump-to-today, jump-to-selection — absolutely positioned inside the chart pane's safe area, every click forwarded to the same `stargantt.timeline` calls a host could make directly. It is off by default, deliberately, because a toolbar is a UI decision a host page may already have made elsewhere.",
        "`levels` decides which zoom-level ids the slider and the +/− buttons can reach, defaulting to the six built-in `timeline-scale` levels; `slider`, `zoomButtons`, `fitButton`, `todayButton` and `selectionButton` each toggle one control independently, and `position` picks which of the pane's four safe-area corners the toolbar claims — the same `overlay-corner` slot machinery `filterSearch`'s search box also claims (top-right by default), so composing both is worth checking for a collision before you ship it.",
        "Passing an empty nest gets you every field's own default: a full six-control toolbar in the bottom-right corner with English labels. Every field is independently visible, which is what makes this group — unlike most of the others on this page — demonstrable as a plain before/after picture rather than a described gesture.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default — no toolbar (opt-in group omitted)", demo: {} },
          {
            label: "{} — toolbar shown, every field at its own default",
            demo: { preset: { interaction: { zoomControls: {} } } },
          },
        ],
      },
    },
    {
      name: "clipboard",
      prose: [
        "Gives the chart the editing verb a spreadsheet already has: copy a selection, paste it elsewhere with fresh ids and its internal links reconnected to the copies, or duplicate — copy and paste in one step, landing right after the source. Off until you pass its nest; enabling it also wires the native `copy`/`paste` browser events on the chart root by default (`systemClipboard: true`), so a real Ctrl+C on a selection round-trips through the OS clipboard as tab-separated text unless you turn that off.",
        "`fields` bounds only the spreadsheet-text encoding — which grid columns a paste into or out of an external application can see — never the plugin's own structured copy/paste, which carries the full task record regardless of what `fields` says. Narrowing it is a decision about what a reviewer handed a text export can touch, not about what stays editable inside the chart itself.",
        "It paints nothing at rest and mounts no persistent DOM: composing it changes nothing about a chart's initial render. Everything it does happens in response to a copy, a paste, a duplicate call, or a keystroke — which is why the value picker below demonstrates it by actually calling `duplicate()` the moment data loads, the same call a context-menu item or a keyboard chord would make.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default — clipboard/duplicate does nothing (opt-in group omitted)", demo: {} },
          {
            label: "{} — a duplicate() call on load doubles the Design branch",
            demo: { preset: { interaction: { clipboard: {} } }, plugins: duplicateOnLoad("design") },
          },
        ],
      },
    },
    {
      name: "filterSearch",
      prose: [
        "Never touches the store. It hides rows through the same public seam a third-party plugin would have to use — tree-grid's `rows/height`, overriding a non-matching row to height 0 — so `rowCount()`, undo history, and everything else about the row model stays exactly as it was; a hidden row simply paints and hit-tests as nothing. `searchBox` and `filterPanel` are the two visible toggles (both off by default): an incremental text query with a bigram index sized for tens of thousands of tasks, and a discoverable checkbox panel over whatever `fields` names.",
        "`fields` replaces the built-in filterable fields (`resource`, `type`) outright rather than adding to them — the array you pass is the whole list the panel shows and `FilterCriteria.fields` selections resolve against. `views` seeds named (query, criteria) pairs before anything has called `saveView` at runtime, useful for a chart that should open already narrowed to a saved search a host persists itself.",
        "Everything here is also reachable without any UI at all, through `stargantt.filter`'s `setQuery`/`setCriteria`/`applyView` — the demo below drives the query that way, from a small companion plugin, exactly as a \"show me overdue tasks\" button in your own toolbar would.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default — every row visible (opt-in group omitted)", demo: {} },
          {
            label: 'searchBox: true, with a "render" query run on ready',
            demo: {
              preset: { interaction: { filterSearch: { searchBox: true } } },
              plugins: filterOnReady("render"),
            },
          },
        ],
      },
    },
    {
      name: "editDialog",
      prose: [
        "A modal task editor — name, start, end, progress — validated as a whole against itself on Save rather than field by field, so a single commit can move a task's entire range past its old bounds. Off until you pass its nest; unless `openOnDoubleClick` is false (it defaults to true), two presses of the same bar or grid row within 400ms with no selection modifier opens it, and the `edit-dialog/open` command is always available regardless, for a toolbar button or another plugin to drive it directly.",
        "`renderBody` is the whole-body seam: the plugin keeps owning the chrome (backdrop, header, footer, focus trap, Escape) and hands you the empty body element the built-in four-field form would otherwise fill. A field your body never draws still keeps its prefilled draft value and rides through `commit()` unchanged, which makes the seam suitable for partial redesigns as well as full replacements.",
        "Tree-grid's own inline cell editor answers the identical double-click gesture as `openOnDoubleClick`, and neither plugin detects the other — compose this with the default `openOnDoubleClick` only when inline editing is off, or set `openOnDoubleClick: false` and open the dialog only through the command.",
      ],
      demo: {
        kind: "none",
        reason:
          "The dialog exists only between an open and its own close, and while open it is a modal backdrop over the whole chart — a chart scripted open at mount would show mostly grey veil rather than a legible before/after, and a chart at rest is pixel-identical with either field at any value.",
      },
    },
    {
      name: "sidePanel",
      prose: [
        "A persistent right-hand pane, added through the same `view/panes` collect point tree-grid's own grid pane uses, always showing the same four fields (name, start, end, progress) for whatever is currently selected, plus a read-only list of dependencies and resource assignments. Off until you pass its nest; unlike the edit dialog, an empty selection still shows the pane — just its placeholder text — so composing it is visible immediately, before a reader has clicked anything.",
        "`formatDate` adds a second, read-only line beside each native date input in the house format or locale of your choice; the input itself stays the platform's `YYYY-MM-DD` control regardless. `renderBody` is the same whole-body seam `editDialog.renderBody` offers — the plugin keeps the pane, the divider and the selection-following refresh, and your function only replaces what goes inside it, with `sidepanel/fields` contributions still appended below whatever it draws.",
        "It has no editing shape the edit dialog does not also have, so the two are not mutually exclusive: a wide layout can keep the pane always visible for a glance and add `editDialog` for a focused double-click editor, or drop the pane entirely and rely on the dialog alone.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default — no pane (opt-in group omitted)", demo: {} },
          {
            label: "{} — pane visible, showing its empty-selection placeholder",
            demo: { preset: { interaction: { sidePanel: {} } } },
          },
        ],
      },
    },
    {
      name: "messages",
      prose: [
        "One catalog for every string all ten config groups produce — 58 keys, resolved once at setup by per-key shallow override: a key you leave out keeps its English default, a value of the wrong kind is ignored, and a throwing builder is reported and answered by the built-in default for that one call. The eight keys that collide between the edit dialog's and the side panel's own catalogs are prefixed (`dialog*` / `panel*`) so nothing is silently dropped where the two overlap.",
        "Almost every key here only reaches a reader once the feature it belongs to is actually visible or has actually run — `deleteConfirmTitle` needs a bulk delete staged, `dialogTitle` needs the edit dialog open, `panelNameLabel` needs the side panel composed and something selected. Overriding a key for a group you have not enabled changes nothing observable until you enable it, which is easy to mistake for the override not working.",
        "Because the catalog is resolved once and never re-read, a chart that needs to switch language after mount is rebuilt with a new config rather than mutated in place — `stargantt.i18n` is the sanctioned mechanism for a chart whose language changes without a full remount; this option is for a chart whose language is fixed for its lifetime.",
      ],
      demo: {
        kind: "values",
        prerequisite: { preset: { interaction: { sidePanel: {} } }, plugins: selectOnLoad("visual") },
        values: [
          { label: "default — English side-panel labels", demo: {} },
          {
            label: 'panelNameLabel: "Nom", panelStartLabel: "Début" — French field labels',
            demo: {
              preset: {
                interaction: {
                  messages: { panelNameLabel: "Nom", panelStartLabel: "Début", panelEndLabel: "Fin", panelProgressLabel: "Avancement" },
                },
              },
            },
          },
        ],
      },
    },
  ],

  notes: {
    services: {
      "stargantt.selection":
        "The one source of truth for what is selected, regardless of which surface — bar, grid row, keyboard, or a direct `select()` call — set it. Read it instead of inferring selection from DOM classes or canvas pixels; drive it instead of simulating clicks when a host UI needs to change the selection itself.",
      "stargantt.snap":
        "The rounding rule every editor in this plugin consults, and the one a custom editor of your own should consult too if it wants to respect the chart's configured precision. `snap(t)` and `step(t, direction)` are the two calls that matter.",
      "stargantt.filter":
        "Store-shaped filter state — query, criteria, active, matchCount — plus the mutators and named-view management. The service is dormant — not even registered — unless `filterSearch` is configured, even as `{}`; composing it that way and driving the service from your own toolbar, with the built-in search box and filter panel never mounted, is a supported way to use it headlessly.",
    },
    events: {
      __empty:
        "Interaction has no per-group change events (no `selection/changed`, no `filter/changed`) — store subscriptions on the three services above cover that instead. Subscribe to `SelectionService.state` or `FilterService.state` rather than listening for an event.",
    },
    commands: {
      "clipboard/copy": "Captures the current selection into the internal clipboard, mirroring to the system clipboard when `systemClipboard` is on.",
      "clipboard/paste": "Creates tasks from the held (or an explicitly given) transfer, as one transaction.",
      "clipboard/duplicate": "Copy and paste of the current selection in one step, one transaction — what the demo above calls to double the Design branch.",
      "edit-dialog/open": "Opens the modal editor for one task id, replacing an already-open dialog; an id the store does not know is a silent no-op.",
    },
    extensionPoints: {
      "tooltip/content": "First-wins: contribute here to answer tooltip content for a hit kind the built-in name-and-dates provider does not know about, such as a custom overlay or marker.",
      "contextmenu/items": "Collect, appended after the built-in (or config-replaced) entries: the sanctioned way to add a menu action without replacing the whole `items` provider.",
      "sidepanel/fields": "Collect, read once when the pane mounts: append a section below the built-in four fields — a linked ticket id, a custom risk score — without forking the panel.",
      "snap/workingTime": "First-wins: the working-time authority `snap.workingDays` consults. The scheduling plugin's calendars contribute here; nothing is contributed by default.",
      "snap/pushGuards": "Collect, OR-combined stand-down predicates for the `pushSuccessors` cascade — the scheduling plugin contributes one so its own propagation and this plugin's push-out never race each other.",
      "drag/lanes": "First-wins: the resource-lane drag seam `dragEdit.resourceDrag` needs to do anything. The resource plugin contributes it; without a contribution the flag behaves as off.",
    },
  },

  recipes: [
    {
      title: "Turn on multi-select, the accessible click-move alternative, and group dragging",
      intent:
        "A chart where selecting several tasks at once to move or delete them together is a normal thing to want, with a WCAG 2.2 non-dragging alternative for readers who cannot perform a pointer drag.",
      code: `presetStandard({
  interaction: {
    selection: {
      mode: "multi",
      shortcuts: { selectAll: true, clearOnEscape: true, deleteSelected: true },
    },
    dragEdit: {
      clickMove: true,
      multiDrag: true,
      autoScroll: true,
    },
  },
})`,
    },
    {
      title: "Add a search box, a filter panel, and a zoom toolbar together",
      intent:
        "Three opt-in groups turned on at once — a chart with enough tasks that a reader needs to narrow it, plus a toolbar for reorienting the viewport without a keyboard shortcut cheat sheet.",
      code: `presetStandard({
  interaction: {
    filterSearch: { searchBox: true, filterPanel: true },
    zoomControls: {},
  },
})`,
    },
    {
      title: "Add a menu entry and translate the built-in context menu",
      intent:
        "Contributed entries stack after the built-ins automatically — no need to replace items to add one action, and messages carries the translation independently of the contribution.",
      code: `presetStandard({
  interaction: {
    contextMenu: {
      messages: { menuLabel: "Contextmenü", insertTask: "Aufgabe einfügen" },
    },
  },
}).concat([
  definePlugin({
    meta: { id: "app.export-menu-item", dependsOn: ["stargantt.interaction"] },
    setup(ctx) {
      ctx.contribute("contextmenu/items", (target) => {
        if (target.kind !== "hit" || target.hitKind !== "bar") return undefined;
        return [{ id: "export-row", label: "Export this task", run: (t) => console.log("export", t) }];
      });
    },
  }),
])`,
    },
  ],
};

export default doc;
