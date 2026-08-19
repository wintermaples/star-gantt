import { T0 } from "../../../lib/data";
import type { PluginDoc } from "../../types";

const DAY = 86_400_000;
const d = (n: number): number => T0 + n * DAY;

/**
 * A small independent dataset for the `taskFields` demo: every leaf task carries `meta.taskFields`
 * values — status, priority, tags, a deadline, actual dates — so the columns and bar decorations
 * this nest adds have something real to render. The shared sample dataset has no `meta` at all.
 * One task (`api`) has a deadline in the past and is not `done`, so the overdue decoration has
 * something to warn about without waiting on a reader to edit anything.
 */
const FIELDS_DATA = [
  { id: "epic", parentId: null, name: "Payments revamp", type: "summary", start: d(-5), end: d(16) },
  {
    id: "discovery",
    parentId: "epic",
    name: "Discovery",
    start: d(-5),
    end: d(-2),
    progress: 1,
    meta: { taskFields: { status: "done", priority: "medium", tags: ["research"], customId: "PR-001" } },
  },
  {
    id: "api",
    parentId: "epic",
    name: "API design",
    start: d(-4),
    end: d(1),
    progress: 0.9,
    meta: { taskFields: { status: "in-progress", priority: "high", tags: ["api", "design"], deadline: d(-1) } },
  },
  {
    id: "checkout",
    parentId: "epic",
    name: "Checkout UI",
    start: d(-1),
    end: d(6),
    progress: 0.4,
    meta: { taskFields: { status: "in-progress", priority: "medium", tags: ["ui"], deadline: d(5) } },
  },
  {
    id: "fraud",
    parentId: "epic",
    name: "Fraud rules",
    start: d(2),
    end: d(8),
    progress: 0,
    meta: { taskFields: { status: "on-hold", priority: "high", deadline: d(7) } },
  },
] as const;

// Real wall-clock time, not the shared sample's fixed T0 — overdue and progress-status color are
// both computed against "now", so the conditionalFormat demo's tasks are dated around the moment
// the page loads. Every value below also pins view.timeline.origin to a few days before "legacy",
// the only genuinely overdue task, or it opens off the left edge where no scroll reaches it.
const DAY_MS = 86_400_000;
const NOW = Date.now();
const at = (offsetDays: number): number => NOW + offsetDays * DAY_MS;
const RULE_ORIGIN = at(-9);
const RULE_TASKS = [
  { id: "spec", name: "Spec", start: at(-6), end: at(-1), progress: 1, meta: { priority: "high", category: "design" } },
  { id: "build", name: "Build", start: at(-3), end: at(3), progress: 0.4, meta: { priority: "medium", category: "engineering" } },
  { id: "legacy", name: "Legacy fix", start: at(-8), end: at(-2), progress: 0.3, meta: { priority: "high", category: "engineering" } },
  { id: "launch", name: "Launch", type: "milestone", start: at(4), end: at(4) },
];

const doc: PluginDoc = {
  id: "stargantt.tree-grid",
  summary:
    "Owns the left-hand grid pane and the row model every other plugin measures rows against, plus the standard field columns and rule-driven bar colouring as two config nests on the same foundation.",
  overview: [
    "Everything about \"which tasks are visible, in what order, at what height, at what vertical offset\" lives here, exposed as `stargantt.rows` — the service task-bars, drag-edit, dependencies and every row-aware plugin ask instead of re-deriving it from the store. It also owns the grid pane itself: a DOM tree of header and body cells, contributed to `view/panes` rather than hand-inserted, sharing the chart's vertical scroll (through `stargantt.view`'s `viewport` store) and its own private horizontal one.",
    "The four built-in columns (Name, Start, End, Progress) are ordinary contributions to `grid/columns`, which is why `columns` can replace them outright rather than needing a separate \"disable the built-ins\" switch — supply an array and the built-ins are simply never constructed. `taskFields` and `conditionalFormat`, the two nests for optional field columns and rule-driven bar colouring, sit on top of that same foundation: the first adds nine more optional columns plus bar decorations and a side-panel section, all reading and writing `task.meta.taskFields`; the second recolors bars by rule, lateness or priority without touching what a task is, contributing to task-bars' own extension points rather than owning any paint of its own.",
    "Two things live outside this plugin on purpose. Selection is reflected in, not owned: a row pointerdown only emits `grid/rowPointerDown`, and a selection-owning plugin answers back through `stargantt.grid`'s `setSelected`/`setFocused`. And sorting is display-only — clicking a sortable header reorders what the `rows` store reports, published through `stargantt.grid`'s own `sort` store, never the store's `orderKey` — so a sorted grid and an unsorted one are the same data looked at two ways, not two different projects.",
    "Custom fields are the one closely related feature that lives elsewhere: declaring a field belongs to `dataStore.customFields` now, and this plugin only builds the column for it, consuming the optional `stargantt.fields` service and adding one `ColumnDef` per resolved definition. A composition with custom fields declared but no tree-grid gets the values with nowhere on screen to show them; see the data-store page for the declaration side.",
  ],
  whenYouNeedIt:
    "always — remove tree-grid and the chart has no row model, no left pane, and nothing to tell the renderer which row a task occupies.",
  demo: {},
  overviewDemo: {
    kind: "configured",
    // One option, and it lands in the leftmost column where this page's clamped pane width cannot
    // clip it — a row-height or indent change would be just as real and much easier to miss.
    // The default indent needs no help here: the gutter is charged to the tree column (Name), not
    // to the WBS column, so the numbering column keeps its full 70px at every depth and "1.1.1"
    // renders whole. See docs/specs/plugins/tree-grid.md, the `indent` config row.
    spec: { preset: { treeGrid: { wbs: true } } },
    caption:
      "The numbers ahead of the Name column are the WBS codes this plugin computes from the tree — 1 for the release, 1.1 for Design, 1.1.1 for the first task inside it. Each code keeps the same 70px whatever its depth: the tree indentation is charged to the Name column beside it, which is where the staircase of toggles and labels steps rightward.",
  },

  properties: [
    {
      name: "messages",
      prose: [
        "Forty keys in total, the largest message catalog in the library: seven native to the grid itself (`nameColumn` through `wbsColumn`, plus `newTaskName` and `paneResizeLabel`), twenty-seven from the taskFields nest (column headers, status/priority labels, panel captions), and five from conditional-format's legend, resolved once at setup by per-key shallow override. `newTaskName` is the one deliberate collision between the grid's own meaning and taskFields': this plugin's meaning (the `view/rowInsert` default name) wins the key, and taskFields' template fallback name lives under `templateTaskName` instead.",
        "The status and priority labels are not just display text — a reader can type `\"Complete\"` into an editable Status cell and have it match the underlying `done` value the same way typing `\"Done\"` would, because a cell always accepts its internal key regardless of what `messages` says; overriding a label adds an accepted spelling rather than replacing the one the key itself already accepts.",
        "Resolved once at setup and never re-read: changing the object passed in later, after the chart is already running, has no effect. A chart that needs to switch language at runtime rebuilds the plugin with a new catalog rather than mutating this one in place.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (English)", demo: {} },
          {
            label: '{ nameColumn: "Task", progressColumn: "% Done" }',
            demo: { preset: { treeGrid: { messages: { nameColumn: "Task", progressColumn: "% Done" } } } },
          },
        ],
      },
    },
    {
      name: "rowHeight",
      prose: [
        "The row height every row uses unless a `rows/height` contribution overrides it — and, because contributions receive it as `defaultHeight`, it is also the number they override *from*. Change it and every plugin that adds a taller row for its own reason (a resource-load sparkline, a baseline strip) is still measuring against your new baseline, not the shipped 28.",
        "It is also a performance lever you would not guess from the name: when every row ends up at the same height, the row model skips its Fenwick-tree offset index entirely and multiplies row index by height instead. What breaks that fast path is not a `rows/height` contribution returning a value at all — it is that value differing from `rowHeight` for even a single row. A contribution that deliberately re-confirms the default costs nothing extra; one that returns anything else, even for one row out of ten thousand, drops the whole chart onto the Fenwick-tree path.",
        "It is read once at setup and never again — a chart that needs to change density at runtime remounts rather than reassigning this after the fact.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (28)", demo: {} },
          { label: "22 (dense)", demo: { preset: { treeGrid: { rowHeight: 22 } } } },
          { label: "40 (comfortable)", demo: { preset: { treeGrid: { rowHeight: 40 } } } },
        ],
      },
    },
    {
      name: "paneWidth",
      prose: [
        "Only the divider's starting position — this plugin's own `view/panes` contribution is what actually owns drag-resize afterwards, so a reader who drags the divider is not fighting this option, and there is no way (short of remounting) to force the pane back to a width once the user has moved it.",
        "580 is wide enough to show all four built-in columns at once without truncation; narrowing it below that does not hide a column, it just clips the last one and makes horizontal scrolling of the grid body — a separate scroll from the chart's own horizontal scroll — the way to reach it. If you replace the built-ins with `columns` and end up with fewer or narrower ones, a narrower `paneWidth` stops looking cramped.",
        "This is unrelated to the `minWidth: 120` this plugin's own pane contribution declares — the floor the view plugin's divider-drag logic enforces. Set `paneWidth` below that and the pane still opens no narrower than 120px, it just starts already pinned at the floor. There is a ceiling too, and it is not a number you set: the view plugin never squeezes the chart pane below `--sg-chart-min-width`, so in a narrow container a large `paneWidth` opens at whatever that leaves rather than at what you asked for — every chart on this site sits beside a column of prose, which is why this option's own demo values are two small widths rather than three that would all cap at the same picture.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (580)", demo: {} },
          { label: "160", demo: { preset: { treeGrid: { paneWidth: 160 } } } },
          { label: "80 — below the 120px floor, so it opens at 120", demo: { preset: { treeGrid: { paneWidth: 80 } } } },
        ],
      },
    },
    {
      name: "indent",
      prose: [
        "What this spends is the tree column's own width, never the row's: the gutter grows by `indent` per level and that one column's text box gives up exactly as much, so a deep row is the same total width as a shallow one and every later column still starts under its own header. The trade is therefore local and easy to size — at four levels the default 16 has eaten 64px of the column's text, which the 220px Name column of the default four-column grid can afford and a 120px column cannot.",
        "Which column pays is worth checking before you tune this. It is the first *displayed* column that is not the WBS numbering column, so `columnLayout` deciding what shows, or `wbs` prepending its column, both move the staircase somewhere you may not have expected: with `wbs: true` the codes keep their full room at every depth and the indentation lands on the column after them.",
        "`0` is a real value, not \"use the default\": it turns off indentation entirely while the toggle gutter itself stays reserved (hidden, not removed) so leaf and branch rows still line up. That is the setting for a chart whose hierarchy is communicated some other way — a WBS column, say — and does not need the visual staircase.",
        "Deep enough trees stop stepping: once the inset would leave the tree column less than 24px of text, it stops growing, so rows past that depth all sit at the same indent and the staircase flattens instead of the row outgrowing its header. If your data nests more than four or five levels, look at it at your actual depth and your actual column width rather than assuming the default keeps stepping.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (16)", demo: {} },
          { label: "0 (no indent)", demo: { preset: { treeGrid: { indent: 0 } } } },
          { label: "32", demo: { preset: { treeGrid: { indent: 32 } } } },
        ],
      },
    },
    {
      name: "readOnly",
      prose: [
        "A blunt, config-time override: it behaves as if every composed column declared `editable: false`, regardless of what its own `setValue`/`editable` say — so a column another plugin contributed specifically to be editable is silently overridden too. There is no per-column exception once this is set; if you need most columns locked and one open, leave this off and set `editable: false` on the individual `ColumnDef`s instead.",
        "It only closes the grid's own edit paths (F2, double-click, `view/editStart`). Sorting, column resize, expand/collapse and row selection are all untouched, and neither is the chart pane — pair it with the interaction plugin's `dragEdit.enabled: false` if you want a chart that is read-only end to end rather than just in the grid.",
      ],
      demo: {
        kind: "none",
        reason:
          "readOnly only gates whether a cell is editable — it closes F2, double-click and view/editStart. Headers, column widths, cell rendering and sorting are all untouched, so a chart with it on renders pixel-identical to one with it off; the difference only shows up the moment a reader tries to edit a cell, which a static demo picker cannot depict.",
      },
    },
    {
      name: "columns",
      prose: [
        "This is a replacement, not a filter: supply an array and the built-in Name/Start/End/Progress `ColumnDef`s are never constructed at all, so `messages`' four built-in header keys and both `formatDate`/`formatProgress` go inert — there is nothing left for them to title or format. `messages.wbsColumn` is the one exception: the WBS column is prepended ahead of a `columns` replacement too whenever `wbs: true`, so that header key stays live. If you only want to drop one built-in column and keep the rest, this is the wrong tool; there is no per-column suppression, only replace-all-four.",
        "The empty array is a deliberate, supported value — \"no built-in columns\" — treated as usable, not as \"nothing supplied\", so it does not fall back to the default four. That is how a chart clears the grid down to whatever other plugins contribute (custom fields, the WBS column) without hand-writing the built-ins back.",
        "Every `ColumnDef` needs its own `id`, `header`, `render` and `getValue` — this option does not inherit anything from the built-ins it is replacing, including their sort comparators or edit wiring. A column that wants to sort needs its own `compare`; one that wants to edit needs its own `setValue`.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (Name / Start / End / Progress)", demo: {} },
          {
            label: "single custom column",
            demo: {
              preset: {
                treeGrid: {
                  columns: [
                    {
                      id: "name",
                      header: "Task",
                      render: (el: HTMLElement, task: { name: string }) => {
                        el.textContent = task.name;
                      },
                      getValue: (task: { name: string }) => task.name,
                    },
                  ],
                },
              },
            },
          },
          { label: "[] (no columns at all)", demo: { preset: { treeGrid: { columns: [] } } } },
        ],
      },
    },
    {
      name: "formatDate",
      prose: [
        "Formats the built-in Start/End cells only — it never runs against a `columns` replacement, whose own `render` is responsible for its own formatting. The default is deliberately locale-neutral ISO (`2026-08-07`) rather than following the browser's locale, so a chart embedded across regions renders the same date text everywhere until you opt into something else here.",
        "The guard against missing data stays in the plugin: a task with no start/end, or a non-finite one, renders an empty cell without ever calling this hook, so you never have to defend against `t` being `NaN` or `undefined` inside your own formatter.",
        "It runs inside row materialization, which happens at scroll frequency on a virtualized grid — so a throwing formatter is caught once, reported through `core/pluginError`, and then silently skipped for the rest of the instance's life rather than reported on every scrolled-in row. Test it against edge-case timestamps before shipping, because you only get one error report to notice it broke.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (ISO, e.g. 2026-08-07)", demo: {} },
          {
            label: "(t) => new Date(t).toLocaleDateString()",
            demo: { preset: { treeGrid: { formatDate: (t: number) => new Date(t).toLocaleDateString() } } },
          },
        ],
      },
    },
    {
      name: "formatProgress",
      prose: [
        "Formats the built-in Progress cell only, ignored under a `columns` replacement exactly like `formatDate`. The value handed in is the raw stored `Task.progress` — normally 0..1, but not clamped on the way in, so a stored `1.5` reaches your formatter as `1.5` and the default renders `150%`. If a chart's data can carry out-of-range progress, decide here whether to clamp, flag or simply render the raw excess.",
        "As with `formatDate`, a missing or non-finite value never reaches the hook — that cell is just empty — and a throwing formatter is latched off after its first failure for the rest of the instance's life, so a bug here degrades one column rather than the chart.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (rounded percent, e.g. 45%)", demo: {} },
          {
            label: "(p) => (p * 100).toFixed(1) + \"%\"",
            demo: { preset: { treeGrid: { formatProgress: (p: number) => (p * 100).toFixed(1) + "%" } } },
          },
        ],
      },
    },
    {
      name: "columnLayout",
      prose: [
        "Purely a display-order override — it changes what the grid pane shows and in what order, but the `grid/columns` reduction every other consumer reads is untouched, so a plugin that keys off contributed columns (rather than what is currently visible) sees no difference. Hiding a column here does not stop it being contributed, sorted or resized; it just never renders.",
        "`order` only needs the columns you care about pinned first — anything you leave out keeps its contribution-order place after the named ones, so reordering the first two columns of a five-column grid takes a two-element array, not five.",
        "This is configuration-time only. There is no drag-to-reorder for columns, so if a reader needs to rearrange columns themselves at runtime, you would need to wire that yourself and call back into this option — it will not happen from pointer input alone.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (Name / Start / End / Progress, in that order)", demo: {} },
          {
            label: '{ hidden: ["start", "end"] }',
            demo: { preset: { treeGrid: { columnLayout: { hidden: ["start", "end"] } } } },
          },
          {
            label: '{ order: ["progress", "name"] }',
            demo: { preset: { treeGrid: { columnLayout: { order: ["progress", "name"] } } } },
          },
        ],
      },
    },
    {
      name: "cellRenderers",
      prose: [
        "A per-column paint override, not a per-cell one — it replaces `render` for every cell in a named column, keyed by column `id`. It composes with everything else about that column: a column named here can still sort, still edit through its own `setValue`/`editor`, and still resize, because none of that goes through `render`.",
        "This is the escape hatch for cells that need a visual you cannot express through `formatDate`/`formatProgress` alone — a coloured pill, a meter, an icon plus text — without giving up the built-in column's id, header and edit wiring the way a full `columns` replacement would.",
        "Like `rowClass` and every other per-cell hook here, a throwing renderer is reported once and then retired for the instance's life, with the column falling back to its own `render` from then on — so a bug in a custom renderer degrades gracefully to the plain built-in look rather than breaking the grid.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (off)", demo: {} },
          {
            label: "colour-coded progress cell",
            demo: {
              preset: {
                treeGrid: {
                  cellRenderers: {
                    progress: (el: HTMLElement, task: { progress?: number }) => {
                      const p = task.progress ?? 0;
                      el.textContent = `${Math.round(p * 100)}%`;
                      el.style.fontWeight = "600";
                      el.style.color = p >= 1 ? "#2e7d32" : p > 0 ? "#e08a00" : "#9e9e9e";
                    },
                  },
                },
              },
            },
          },
        ],
      },
    },
    {
      name: "rowClass",
      prose: [
        "Only ever adds class tokens; it never touches geometry or content, so it is safe to compute from anything about the task without worrying about layout side effects. Nothing ships a stylesheet rule for whatever token you return — the class is inert until your own CSS targets it, which is also why this page needs a small companion plugin (see the demo's source) just to inject a rule the class can be seen against.",
        "It is re-evaluated on every paint of that row, not cached from first render, and reset when a virtualized row slot is recycled for a different task — so a class here always reflects the row's current task, never a stale one left over from whatever used to occupy that slot during a fast scroll.",
        "Because it runs per row on the same paint pass as everything else, keep it cheap: a field read and maybe a string join, not a lookup into another data structure. It is latched off after a first throw like the other per-row hooks, so a bug here loses the highlighting rather than breaking the grid.",
      ],
      demo: {
        kind: "values",
        prerequisite: {
          plugins: (sg) => [
            sg.definePlugin({
              meta: { id: "docs.tree-grid-row-class-style", dependsOn: [] },
              setup(ctx) {
                const style = document.createElement("style");
                style.textContent = ".docs-zero-progress { background: var(--sg-row-selected-bg, #fde9c8); }";
                document.head.appendChild(style);
                ctx.own({ dispose: () => style.remove() });
              },
            }),
          ],
        },
        values: [
          { label: "default (none)", demo: {} },
          {
            label: '(task) => task.progress === 0 ? "docs-zero-progress" : undefined',
            demo: {
              preset: {
                treeGrid: {
                  rowClass: (task: { progress?: number }) =>
                    (task.progress ?? 0) === 0 ? "docs-zero-progress" : undefined,
                },
              },
            },
          },
        ],
      },
    },
    {
      name: "wbs",
      prose: [
        "Adds a numbering column ahead of everything else — built-ins or a `columns` replacement — computed from the store's sibling order, not from display sorting: sort the Name column and the WBS codes stay put, still telling you where a task actually lives in the tree while the grid shows it in a different order. That divergence is intentional, but it surprises a reader expecting the number to track the row.",
        "The codes are cached per data generation and only recomputed when the `tasks` store publishes a new snapshot, so scrolling never re-walks the tree — but it also means the column is only as fresh as the last data change, which is fine since nothing else can move a code between changes anyway (collapsing a branch does not renumber it).",
        "It is read-only and unsortable by anything but itself — its own header sorts numerically segment by segment (`1.2` before `1.10`), which a plain string compare on `\"1.2\"` vs `\"1.10\"` would get backwards.",
        "The column is a fixed 70px and never auto-sizes, so a code does eventually outgrow it — around five segments — and is ellipsised. That is lossless rather than merely truncated: every cell carries its full code as a `title`, and dragging the column's header edge wider restores the digits for good. What the column will not do is shrink as codes lengthen; the tree indentation is charged to the column after it, so `1.1.1.1` gets exactly the room `1` got.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (off)", demo: {} },
          { label: "true", demo: { preset: { treeGrid: { wbs: true } } } },
        ],
      },
    },
    {
      name: "collapsedBadge",
      prose: [
        "Purely a folded-row affordance: it has nothing to draw on a row that is expanded, or on a leaf, so turning this on against a tree that starts fully open changes nothing until someone actually collapses a branch. Reach for it when charts default to a mostly-collapsed view (a portfolio rollup, a filtered search result) where \"this row hides more\" is otherwise silent.",
        "The count is descendants, not direct children, and — like the WBS column — cached per data generation so it does not re-walk the subtree on every scroll frame. The text sits in the row's own foreground colour rather than a colour cue, so it survives greyscale and does not compete with any status colour the row itself carries.",
        "It lands after the tree column's own content — the Name text in the default grid — which is also the column the indentation comes out of, so on a deep collapsed row the badge and the staircase are competing for the same width. With `wbs: true` the numbering column is untouched by both, so turning this on can never cost you a digit of a WBS code.",
        "Because it only appends to a cell the paint pass actually repaints, a row mid-edit is left alone rather than having its editor clobbered — you will not see the badge flicker in and out under an open inline editor.",
      ],
      demo: {
        kind: "values",
        prerequisite: {
          plugins: (sg) => [
            sg.definePlugin({
              meta: { id: "docs.tree-grid-collapse-build", dependsOn: ["stargantt.tree-grid", "stargantt.data-store"] },
              setup(ctx) {
                // There is no `data/tasksChanged` event — the tasks store is set once per
                // `load()`, among other times; subscribe to that instead.
                const data = ctx.use("stargantt.data");
                const off = data.tasks.subscribe(() => {
                  off.dispose();
                  ctx.dispatch("view/rowToggle", { id: "build", expanded: false });
                });
                ctx.own(off);
              },
            }),
          ],
        },
        values: [
          { label: "default (off)", demo: {} },
          { label: "true, with the \"Build\" row collapsed", demo: { preset: { treeGrid: { collapsedBadge: true } } } },
        ],
      },
    },
    {
      name: "outlineEditing",
      prose: [
        "This trades a browser default for a spreadsheet one: with it on, `Tab` inside the grid pane stops moving focus to the next control on the page and instead indents the active row under its preceding sibling, `Shift+Tab` outdents. That is the right call for a chart used like an outline editor, and the wrong one for a chart embedded in a longer form where `Tab` is expected to leave the grid.",
        "It only changes the keyboard binding — `view/rowIndent` and `view/rowOutdent` are always registered as commands regardless of this flag, so a context menu or toolbar button can drive the same reshaping whether or not `Tab` does. Turning this on is purely about which key triggers it.",
        "Because a keyboard trap on `Tab` is a real accessibility hazard if there is no way out, the grid always honours `Escape` (outside an open cell editor) as a one-step release back to native tab order — that release is not configurable and does not need enabling here; it exists whenever this option is on.",
      ],
      demo: {
        kind: "none",
        reason:
          "This only rebinds Tab/Shift+Tab inside the grid pane; nothing about the chart's paint changes whether it is on or off. The effect is entirely behavioural — a keypress does or does not indent a row — and a static picker showing the same chart twice would suggest a visual difference that does not exist.",
      },
    },
    {
      name: "collation",
      prose: [
        "Only changes how the built-in Name column sorts once its header is clicked — it adds a `compare` where the default has none, so `true` here is the difference between an unsortable Name header and a sortable one, not a difference you can see at rest. With `columns` replacing the built-ins this is inert; give your own replacement column its own `compare` instead.",
        "The plain object form (`{ locales, options }`) is what you reach for once ASCII compare gets embarrassing — `\"Étape 2\"` sorting after `\"Zzz\"` under a naive string compare, or `\"Task 10\"` sorting before `\"Task 2\"` without `options: { numeric: true }`. An unusable locale is swallowed rather than thrown: the environment silently falls back to no collation (the default, unsortable) rather than breaking the chart, so test the actual sort order you get rather than assuming the option took effect.",
      ],
      demo: {
        kind: "none",
        reason:
          "At rest this only changes the Name header's aria-sort from absent to \"none\" — nothing paints differently until a reader clicks the header, and even then the difference is which order rows land in, not anything a fixed before/after picker can show without scripting a click into the demo harness.",
      },
    },
    {
      name: "taskFields",
      prose: [
        "The taskFields nest: nine optional grid columns (id, status, priority, tags, assignees, deadline, actual start/end, duration), bar decorations (a status glyph, an overdue warning triangle, assignee avatars), and a side-panel editing section, all reading and writing one plain object under `task.meta.taskFields`. Omit the nest and the whole feature is dormant — no columns, no bar decorations, no panel section, output identical to a composition that never configured it. Supply it, even as `{}`, and every sub-option activates with its defaults: `columns: [\"status\", \"priority\", \"deadline\"]` plus the three bar decorations, all at once.",
        "`columns` picks which of the nine field columns to contribute and in what order, but only relative to each other: tree-grid sorts every contributed column by weight, built-ins carry the lowest, and this nest's columns declare none of their own, so they always render to the right of the built-in Name/Start/End/Progress block regardless of composition order. `showStatusOnBars`, `showDeadlineWarnings` and `showAssigneeAvatars` are three independent toggles for the same underlying data shown a second way, on the bar itself — a status glyph, a warning triangle on a task whose deadline has passed while its status is not `done` (re-evaluated live against the clock on every paint, not stamped once), and up to three assignee initials past the bar's right end. All three default on and cost nothing to leave on: with no matching condition (nothing overdue, nothing assigned) they simply draw nothing.",
        "`detailFields` contributes an editing section — status and priority selects, a tags input, date fields, a notes textarea — to the `sidepanel/fields` extension point the interaction plugin's `sidePanel` nest owns. Enabling this with no side panel composed changes nothing visibly: the contribution sits unclaimed until a side panel exists to render it, which is worth knowing before concluding the option \"doesn't work\".",
        "`durationUnit` changes only how the Duration column and the field service express and accept a span — the underlying `start`/`end` epoch milliseconds never move on their own. `idNumbering` reshapes the automatic `id` column's sequence (`prefix`, `start`, `minDigits`) without touching a task's real storage id; a stored `customId` on an individual task always wins over the computed sequence value, silently, with no config needed here — reach for it the moment a reader needs an id that survives edits to unrelated tasks, since the automatic sequence renumbers on any insert or remove anywhere in the set.",
        "`autoRecordCompletion` (on by default) stamps `actualEnd = Date.now()` into the same transaction the moment a `task/update` sets status to `done` from something else, so undoing the status change removes the stamp in the same step; it never fires on a transaction that already sets `actualEnd` itself. `templates` declares named field/name/duration bundles for a host's own toolbar or context menu to apply through the field service — declaring the option alone adds no button anywhere, so it needs a caller to do anything visible.",
      ],
      demo: {
        kind: "values",
        // This page's preview pane is clamped narrower than the built-in Name/Start/End/Progress
        // block, so without dropping the built-ins for the duration of this picker, every value —
        // whichever columns it asks for — would be clipped down to the same sliver of "Name".
        prerequisite: { data: FIELDS_DATA, preset: { treeGrid: { columns: [] } } },
        values: [
          { label: "default (nest omitted — no extra columns)", demo: {} },
          {
            label: "default nest: status, priority, deadline columns + bar decorations",
            demo: { preset: { treeGrid: { taskFields: {} } } },
          },
          {
            label: "wider column set, weekly durations, custom id prefix",
            demo: {
              preset: {
                treeGrid: {
                  taskFields: {
                    columns: ["id", "status", "priority", "tags", "deadline", "duration"],
                    durationUnit: "weeks",
                    idNumbering: { prefix: "T-", start: 100, minDigits: 3 },
                  },
                },
              },
            },
          },
        ],
      },
    },
    {
      name: "conditionalFormat",
      prose: [
        "The conditionalFormat nest: it never touches what a task *is*, only what one bar's fill colour says about it. It contributes a single style provider to task-bars' `taskbars/style` point and, when overdue or progress colouring is on, a decoration to `taskbars/overlays` for the warning triangle and the recoloured progress fill. Omit the nest and it colours nothing — the style provider answers `undefined` for every task, so the chart renders byte-identically to a composition that never enabled the feature.",
        "Three ways to produce a colour, checked in this order, first match wins the task's colour slot: `rules`, a list of `{ when: Condition, style: { color } }` entries evaluated top to bottom (field paths read a task property directly or fall through to `task.meta`, and a malformed condition or an unresolved token colour simply fails to match rather than throwing); the built-in `overdue` check (end passed, progress under 1, exempting summary rows, re-armed on a UTC-midnight timer so a chart left open overnight catches up on its own); and `priorityColors`, a flat map keyed by the stringified `task.meta.priority`. Winning a task's colour and triggering the overdue warning icon are independent: the icon tests lateness directly and appears regardless of which of the three coloured the bar, so a task recoloured by an unrelated rule still shows the triangle if it is genuinely overdue.",
        "`progress` is a fourth, narrower pass layered on top: it recolours only the progress portion of an ordinary bar into one of three status colours by comparing actual progress against a straight-line expected fraction — `onTrack`'s default is the same theme token ordinary bars already use, so an on-track bar is repainted but looks unchanged unless you override that default with a literal, which then stops following a theme switch.",
        "`legend` mounts a small panel in the chart pane's bottom-right safe-area corner listing every active colour source — each rule with its own `legend` label, the overdue entry, every `priorityColors` key, the three progress-status colours — and mounts nothing at all when none of those is configured, so it is safe to turn on ahead of the colour config that will eventually populate it. `now` overrides the clock the overdue check and the progress expectation both read; it changes nothing until `overdue` or `progress` is also on, and the day-rollover repaint timer always reads the real clock to decide when to next repaint regardless of what this returns.",
      ],
      demo: {
        kind: "values",
        prerequisite: {
          data: RULE_TASKS,
          preset: { view: { timeline: { origin: RULE_ORIGIN } }, treeGrid: { rowHeight: 30, paneWidth: 200 } },
        },
        values: [
          { label: "default (nest omitted — no recolouring)", demo: {} },
          {
            label: "{ overdue: true }",
            demo: { preset: { treeGrid: { conditionalFormat: { overdue: true } } } },
          },
          {
            label: '{ priorityColors: { high: "#c53030", medium: "#dd6b20" } }',
            demo: { preset: { treeGrid: { conditionalFormat: { priorityColors: { high: "#c53030", medium: "#dd6b20" } } } } },
          },
          {
            label: "one rule + legend",
            demo: {
              preset: {
                treeGrid: {
                  conditionalFormat: {
                    legend: true,
                    rules: [
                      {
                        when: { field: "meta.category", op: "eq", value: "engineering" },
                        style: { color: "#2b6cb0" },
                        legend: "Engineering",
                      },
                    ],
                  },
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
      "stargantt.rows":
        "The row-index authority every other row-aware plugin defers to — ask `rowOf`/`taskIdAt`/`yOf` here rather than deriving a row's position from the store, so your answer cannot disagree with what the grid and chart panes actually show. Its `rows` store is set, not an event fired: it publishes a fresh `RowsSnapshot` — visible task ids in row order, plus total height — once per change, even one that ends up unchanged.",
      "stargantt.grid":
        "The write side of selection and focus reflection: a selection- or focus-owning plugin calls `setSelected`/`setFocused` here to mark rows, since the grid itself only emits pointer/context-menu events and never decides selection on its own. Its two stores, `columnWidths` and `sort`, replace the abolished `grid/columnWidthsChanged` and `grid/sortChanged` events — a resize drag publishes `columnWidths` at most once per frame, and `sort` carries `null` when no column is sorted.",
    },
    commands: {
      "view/rowsInvalidate":
        "The public way to tell the grid a `rows/height` contribution now answers differently — a filter toggling, say — without faking a `view/rowToggle`. Dispatch it after anything that changes what a height contribution would return, and also whenever the `tasks` store publishes while your contribution is actively overriding heights: `dependsOn` orders `setup()`, not the order subscribers to one store run in, so a sibling plugin can make the grid re-consult your contribution before your own subscriber has run, and the answer it gets is the one that sticks.",
    },
    extensionPoints: {
      "grid/columns":
        "Collect, so third-party columns stack after the composed built-ins rather than replacing them — use `columns` on this plugin instead when the goal is actually to replace what tree-grid itself contributes. The `taskFields` and custom-field columns are internalized contributors to this same point, on equal terms with anyone else's.",
      "rows/height":
        "Reduce over `rowHeight` as the starting `defaultHeight`: the first contribution to return a number wins for that row, and returning `undefined` defers to the next contributor (or the default). A single overriding row anywhere in the chart turns off the uniform-height fast path for the whole grid.",
    },
  },

  recipes: [
    {
      title: "Read-only status board with a WBS column",
      intent:
        "A chart meant for viewing, not editing — a reporting view or a shared dashboard — with the work-breakdown code visible and folded branches showing how much they hide.",
      code: `presetStandard({
  treeGrid: {
    readOnly: true,
    wbs: true,
    collapsedBadge: true,
  },
})`,
    },
    {
      title: "The standard status/priority/deadline board, with avatars",
      intent:
        "The common case: enough columns to triage a schedule at a glance, status visible on the bars themselves, and ownership visible without opening a row.",
      code: `presetStandard({
  treeGrid: {
    taskFields: {
      columns: ["status", "priority", "deadline", "assignees"],
      showStatusOnBars: true,
      showDeadlineWarnings: true,
      showAssigneeAvatars: true,
    },
  },
})`,
    },
    {
      title: "Flag late work and explain the colors",
      intent:
        "The everyday combination: turn on the overdue warning, add one custom rule for a status your team tracks, and let readers see what each color means instead of memorizing it.",
      code: `presetStandard({
  treeGrid: {
    conditionalFormat: {
      overdue: true,
      rules: [
        { when: { field: "meta.status", op: "eq", value: "blocked" }, style: { color: "#805ad5" }, legend: "Blocked" },
      ],
      legend: true,
    },
  },
})`,
    },
    {
      title: "Localize headers, dates and Name sorting together",
      intent:
        "The three pieces of a translated grid that have to move together: retitled headers, locale-formatted cells, and a Name column that sorts the way that locale expects.",
      code: `presetStandard({
  treeGrid: {
    messages: {
      nameColumn: "Tâche",
      startColumn: "Début",
      endColumn: "Fin",
      progressColumn: "Avancement",
    },
    formatDate: (t) => new Date(t).toLocaleDateString("fr-FR"),
    formatProgress: (p) => \`\${Math.round(p * 100)} %\`,
    collation: { locales: "fr" },
  },
})`,
    },
  ],
};

export default doc;
