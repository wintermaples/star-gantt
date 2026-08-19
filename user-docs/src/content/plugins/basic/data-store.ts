import { T0 } from "../../../lib/data";
import type { PluginDoc } from "../../types";

const DAY = 86_400_000;
const d = (n: number): number => T0 + n * DAY;

/**
 * A narrow stand-in for the built-in Name/Start/End/Progress block, used only by the
 * `customFields` demo. Custom-field columns are always appended *after* whatever `columns`
 * resolves to (tree-grid.md § Internal modules), so replacing the built-ins with this one narrow
 * column is what makes two vs. five 110px-wide field columns actually fit — and differ — inside
 * the config page's fixed-width preview, instead of both overflowing past the same clip point and
 * rendering an identical screenshot.
 */
const NAME_ONLY_COLUMN = {
  id: "name",
  header: "Name",
  width: 110,
  render: (el: HTMLElement, task: { name: string }) => {
    el.textContent = task.name;
  },
  getValue: (task: { name: string }) => task.name,
};

/**
 * A small independent dataset for the `customFields` demo: leaf tasks carry `meta.customFields`
 * values for a text, a number, a date and a select field, so every field type in that property's
 * demo values has something real to render the moment a value declares the field. The shared
 * sample dataset has no `meta` at all, so reusing it here would mean every value showed empty
 * cells regardless of which field types were configured.
 */
const FIELDS_DATA = [
  { id: "design", parentId: null, name: "Design", type: "summary", start: d(0), end: d(8) },
  {
    id: "wire",
    parentId: "design",
    name: "Wireframes",
    start: d(0),
    end: d(4),
    progress: 1,
    meta: { customFields: { vendor: "Northwind", budget: 18, deadline: d(-2), tier: "Priority" } },
  },
  {
    id: "visual",
    parentId: "design",
    name: "Visual spec",
    start: d(4),
    end: d(8),
    progress: 0.6,
    meta: { customFields: { vendor: "Acme", budget: 24, deadline: d(6), tier: "Standard" } },
  },
  { id: "build", parentId: null, name: "Build", type: "summary", start: d(7), end: d(20) },
  {
    id: "kernel",
    parentId: "build",
    name: "Core kernel",
    start: d(7),
    end: d(13),
    progress: 0.8,
    meta: { customFields: { vendor: "Northwind", budget: 40, deadline: d(12), tier: "Critical" } },
  },
  {
    id: "renderer",
    parentId: "build",
    name: "Renderer",
    start: d(12),
    end: d(18),
    progress: 0.25,
    meta: { customFields: { vendor: "Bright", budget: 32, deadline: d(17), tier: "Priority" } },
  },
] as const;

const doc: PluginDoc = {
  id: "stargantt.data-store",
  summary:
    "Holds every task, link, resource, assignment and custom field value, and is the only plugin that turns a change into a reversible transaction.",
  overview: [
    "This is the plugin every other plugin ultimately talks to. It owns the in-memory tables — tasks, links, resources, assignments and calendars — and it owns the fourteen commands (`task/*`, `link/*`, `resource/*`, `assignment/*`, plus `history/apply`) that are the only sanctioned way to change any of them. Nothing in the library mutates a task object directly; a drag ends in a `task/move` command, an inline edit ends in a `task/update`, and both arrive here to become one atomic, invertible transaction.",
    "It also owns custom fields: declaring typed fields — text, number, date, select or a computed formula — that attach to every task under `task.meta.customFields`. A chart that never nests `customFields` into this plugin's config pays nothing for the feature; one that does gets it without adding a second package to the composition, because storage, transactions and field definitions live at the same layer.",
    "It has no rendering, no DOM, no timers — it is pure state and pure logic, which is why its own config surface is thin: `messages` and `customFields`, and nothing that shapes what a chart looks like, because that belongs to the plugins that read this store's data, not to the store itself. `dataStore(config?)` still has to be present for the chart to have any tasks at all: remove it and every other basic plugin has nothing to read.",
    "The services it publishes are where you read back what is currently true. `stargantt.data` carries `getTask`, `query()`, `toJSON()`, and four per-entity stores (`tasks`, `links`, `resources`, `assignments`) a subscriber watches instead of listening for a change event — and it is where a dataset is loaded in the first place, since loading is a method call (`gantt.service(\"stargantt.data\").load(rows)`), not a config option. `stargantt.fields` carries the custom-field surface: `definitions()`, `valueOf`, `setValue(s)`, `displayValue`.",
  ],
  whenYouNeedIt:
    "always. It is the foundation every other plugin — rendering, drag-edit, dependencies, undo-redo — is built on; there is no configuration of a StarGantt chart that omits it.",
  demo: { preset: {} },
  // The store has two config options and neither draws a mark on a chart at rest: `messages` is
  // invisible outside an undo panel this site does not mount, and `customFields` starts empty. What
  // is left, and what this chart does, is to show the half of the store that the identical sample
  // dataset on every other page never exercises: the write path. A companion plugin waits for the
  // dataset to land — detected off the `tasks` store rather than an abolished change event — and
  // then creates one task and one link through the store's own commands, so the row, the bar and the
  // arrow on screen are visibly the store's doing rather than the array's. The printed source is
  // written out rather than derived from `preset`, since that call — not a preset key — is where a
  // reader's data meets this plugin.
  overviewDemo: {
    kind: "configured",
    spec: {
      preset: { treeGrid: { rowHeight: 30, paneWidth: 200 } },
      plugins: (sg) => [
        sg.definePlugin({
          meta: { id: "docs.data-store-overview", dependsOn: ["stargantt.data-store"] },
          setup(ctx) {
            const data = ctx.use("stargantt.data");
            // `load()` publishes the `tasks` store like any other write, so the first notification
            // is the dataset arriving. The subscription disposes itself before dispatching, because
            // the two commands below each publish `tasks` again.
            const off = data.tasks.subscribe(() => {
              off.dispose();
              ctx.dispatch("task/add", {
                task: {
                  id: "copy",
                  parentId: "design",
                  name: "Copy review",
                  start: T0 + 4 * DAY,
                  end: T0 + 7 * DAY,
                  progress: 0.5,
                },
              });
              ctx.dispatch("link/add", { sourceId: "wire", targetId: "copy", type: "FS" });
            });
            ctx.own(off);
          },
        }),
      ],
      code: `const gantt = StarGantt.create({
  element: document.getElementById("chart"),
  plugins: StarGantt.presetStandard({ treeGrid: { rowHeight: 30, paneWidth: 200 } }),
});

// Nothing is on screen until the store has rows: loading is a service call, not an option.
gantt.service("stargantt.data").load(rows);

// Everything after that goes through the store's commands, which is what makes it undoable.
gantt.dispatch("task/add", {
  task: { id: "copy", parentId: "design", name: "Copy review", start: startMs, end: endMs, progress: 0.5 },
});
gantt.dispatch("link/add", { sourceId: "wire", targetId: "copy", type: "FS" });`,
    },
    caption:
      "Every row in the grid and every arrow between the bars is one record in this store — but `Copy review` was never in the array handed to `load()`. That row, its bar and the arrow into it from `Wireframes` were created after the chart was up, by dispatching the store's own `task/add` and `link/add`, and the rest of the composition redrew from the `tasks` store update that followed without being told anything else.",
  },

  properties: [
    {
      name: "customFields",
      prose: [
        "Omit this nest and the fields feature is dormant — `stargantt.fields` reports zero definitions and no column arrives — exactly the output of a composition that never configured it. Supply it, even as `{}`, and every declared field starts working the moment the chart mounts; there is no separate opt-in step. What you get for that is typed values that ride along with the task: text, number, date, select, and computed formula fields all read and write through the ordinary `task/update` command, in one transaction, so undo/redo and anything watching `data/didApplyTransaction` see a custom-field edit exactly the way they see a date drag.",
        "The column is not this plugin's to draw: `stargantt.fields` only holds definitions and values, and it is tree-grid that consumes the service and builds one `ColumnDef` per resolved field, `customfields-<key>`, after the built-in Name/Start/End/Progress block. A composition with this nest configured but no tree-grid gets the values and the formula evaluation with nowhere on screen to show them — the service still answers `valueOf` and `displayValue` correctly, there is just no cell.",
        "Each entry needs a non-empty, unique `key`, which is both the storage slot under `task.meta.customFields` and the identity a `select`/`date`/`number` cell's editor validates against. Rename a key in a later edit to `fields.fields` and the old key's stored values are not deleted — they become invisible under the new spelling, which preserves sibling meta keys on every write but is easy to mistake for data loss during development. A `select` field with unusable `options`, or a `formula` whose expression fails to parse, is dropped silently at setup, once, before the chart ever paints, so a broken formula reads as a missing column rather than an error anywhere in the UI.",
        "Widths default to 110px per field and add up: five custom fields is roughly another summary column's width of horizontal scroll before the timeline even starts. Reach for `column: false` on a field that exists only to feed a formula or a side panel — the value stays fully readable and writable through the service, it just costs no grid width. The select-editor's \"no value\" label lives in `TreeGridMessages.noneOption`, since tree-grid is what actually renders the editor.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (no fields declared)", demo: { data: FIELDS_DATA } },
          {
            label: 'vendor (text) + tier (select)',
            demo: {
              data: FIELDS_DATA,
              preset: {
                treeGrid: { paneWidth: 480, columns: [NAME_ONLY_COLUMN] },
                dataStore: {
                  customFields: {
                    fields: [
                      { key: "vendor", type: "text", label: "Vendor" },
                      {
                        key: "tier",
                        type: "select",
                        label: "Tier",
                        options: ["Standard", "Priority", "Critical"],
                      },
                    ],
                  },
                },
              },
            },
          },
          {
            label: "text, number, date, select, and a computed formula",
            demo: {
              data: FIELDS_DATA,
              preset: {
                // Wide enough to show all five 110px field columns beside the narrow Name column —
                // without this, both non-default values overflow past the same clip point in the
                // config page's fixed-width preview and render pixel-identical (D-13).
                treeGrid: { paneWidth: 720, columns: [NAME_ONLY_COLUMN] },
                dataStore: {
                  customFields: {
                    fields: [
                      { key: "vendor", type: "text", label: "Vendor" },
                      { key: "budget", type: "number", label: "Budget ($k)" },
                      { key: "deadline", type: "date", label: "Sign-off" },
                      {
                        key: "tier",
                        type: "select",
                        label: "Tier",
                        options: ["Standard", "Priority", "Critical"],
                      },
                      {
                        key: "remaining",
                        type: "formula",
                        label: "Remaining ($k)",
                        formula: "ROUND(budget - budget * progress, 2)",
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
    {
      name: "messages",
      prose: [
        "The only user-visible string this plugin produces on its own is a transaction's `label` — the phrase an undo/redo UI shows for the step it would take back: \"Move task\", \"Add link\", \"Remove assignment\". This option replaces any subset of those fourteen labels; keys you leave out keep their English default, so translating one command's wording does not require restating the other thirteen.",
        "Labels are resolved once, at setup, by a shallow merge over the built-in catalog — not re-read per transaction. A chart that needs to switch language at runtime rebuilds the plugin rather than mutating the object handed to it; changing the object after construction has no effect on transactions already recorded in history, which keep the label they were created with.",
        "This is display text only. It plays no part in undo/redo's coalescing (`coalesceKey`), in patch application, or in the identity of a transaction — a host free to build its own undo panel can set every member to `\"\"` without breaking anything, since nothing downstream reads the string for meaning. The custom-fields `noneOption` label is a separate catalog member entirely, and lives on `TreeGridMessages`, not here.",
      ],
      demo: {
        kind: "none",
        reason:
          "A transaction's label only ever surfaces inside an undo/redo UI, and the shared sample chart on this site does not mount one — there is no pixel on any demo chart that this option can move.",
      },
    },
  ],

  notes: {
    services: {
      "stargantt.data":
        "The read/write surface for everything this plugin owns beyond custom fields: `getTask`, `taskIds`, `query()` for the indexed view, `load()` to replace the dataset, `toJSON()` to serialize it back out, and four per-entity stores — `tasks`, `links`, `resources`, `assignments` — a subscriber watches instead of listening for a change event. `tasks` is always the last store set in a burst, even for a resource-only transaction, so a repaint driven from it always observes every domain in its final state. Commands are how you change data through the transaction pipeline; this service is how you read it, and it is also where a fresh chart's data enters — `load()` is not a constructor option.",
      "stargantt.fields":
        "The custom-field surface: `definitions()` for the resolved field list in configuration order, `valueOf`/`displayValue` to read a value the way its cell reads it (including the formula fallback to an empty string on evaluation failure), and `setValue`/`setValues` to write. Reach for `setValues` over repeated `setValue` calls whenever you are writing more than one value in the same operation — a bulk-edit panel, an import, a seed run — because it lands as one transaction regardless of how many tasks it touches, so the operation costs one undo entry instead of one per field.",
    },
    extensionPoints: {
      __empty:
        "Neither this plugin nor its custom-fields nest defines an extension point. `stargantt.fields`' only public seam is its service surface; the column that shows a field's value is tree-grid's `grid/columns` contribution, built from that surface — see tree-grid's page for the point itself.",
    },
    events: {
      "data/willApplyTransaction":
        "The only point in the pipeline where a change can still be stopped or extended. Call `preventDefault()` here and the transaction never touches the store — validation plugins (a scheduling rule, a permissions check) live in this handler rather than in the command that produced the transaction, because by the time a command has produced patches, refusing them cleanly means catching it here, not after the fact. A handler may also push its own patches onto `transaction.patches`; they apply and undo atomically with the rest of the transaction, which is how a plugin derives a side effect (recomputing a summary bar, cascading a date) without minting a second, separately-undoable history entry.",
      "data/didApplyTransaction":
        "The authoritative settle signal, fired once per applied transaction immediately after the store burst, carrying the transaction with its final patch list (will-phase appends and summary promotion included). It never fires for a transaction cancelled in the will phase, one whose apply threw, an empty-patch no-op, or a bulk path — `load()` and `materializeChildren()` change the `tasks` store without ever producing a transaction here. Undo-redo records from this event, not from `data/willApplyTransaction`, which is why a will-handler that vetoes a change never leaves a phantom history entry behind.",
    },
    commands: {
      "link/add":
        "At most one link exists per ordered `(sourceId, targetId)` pair. Dispatching this for a pair that already has one produces nothing at all — no link, no transaction, no store notification — whatever `type`, `lag` or `id` the payload asks for, because two dependencies between the same two tasks would be drawn on top of each other and counted twice by everything that reads links. Changing the one that exists is `link/update`; the reverse direction (`b → a` alongside `a → b`) is a different pair and is created normally, though it closes a cycle that `auto-schedule` will refuse if that plugin is present. `load()` applies the same rule to raw rows: a repeated pair keeps its first row and drops the rest.",
      "task/update":
        "`after` and `clears` answer two different questions and get confused often enough to call out: `after` says what changes, `clears` says what goes back to fully absent. Leaving a field out of `after` means \"leave it alone\", not \"remove it\" — there is no way to unset `progress` or `constraint` by omission, which is exactly why `clears` exists. A key listed in both is treated as an `after` assignment, so `clears` only matters for fields `after` does not also touch.",
      "history/apply":
        "Replays a previously recorded patch list — an undo/redo history entry above all — as one transaction, exactly as given: no patch is rebuilt from a command payload and nothing re-validates it against the current store state. It is the mechanism undo/redo is built on, not something most application code calls directly; reach for it only when you are replaying patches you already hold, not to construct a change from scratch.",
    },
  },

  recipes: [
    {
      title: "Load a dataset once the chart exists",
      intent:
        "Initial data is not a constructor option — it goes through the service, after `create()` has returned.",
      code: `const gantt = create({ element: el, plugins: presetStandard() });

gantt.service("stargantt.data").load({
  tasks: rows,          // TRaw[], or an array of Task-shaped objects
  links: dependencyRows,
});`,
    },
    {
      title: "Attach vendor, budget and risk tier to every task",
      intent:
        "The common case: a handful of business attributes that need to be visible in the grid and editable inline, no formula involved.",
      code: `presetStandard({
  dataStore: {
    customFields: {
      fields: [
        { key: "vendor", type: "text", label: "Vendor" },
        { key: "budget", type: "number", label: "Budget ($k)" },
        {
          key: "tier",
          type: "select",
          label: "Tier",
          options: ["Standard", "Priority", "Critical"],
        },
      ],
    },
  },
})`,
    },
    {
      title: "Derive a rollup instead of maintaining a second write path",
      intent:
        "A \"remaining budget\" column that is always correct because it is never stored — it is computed from `budget` and the task's own `progress` on every read.",
      code: `presetStandard({
  dataStore: {
    customFields: {
      fields: [
        { key: "budget", type: "number", label: "Budget ($k)" },
        {
          key: "remaining",
          type: "formula",
          label: "Remaining ($k)",
          formula: "ROUND(budget - budget * progress, 2)",
        },
      ],
    },
  },
})`,
    },
    {
      title: "Rename the undo labels for a non-English UI",
      intent:
        "Replace only the labels your undo panel actually shows; every key you omit keeps its English default.",
      code: `presetStandard({
  dataStore: {
    messages: {
      taskMove: "タスクを移動",
      taskAdd: "タスクを追加",
      taskRemove: "タスクを削除",
    },
  },
})`,
    },
  ],
};

export default doc;
