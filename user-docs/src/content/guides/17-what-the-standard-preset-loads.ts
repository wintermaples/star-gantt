import type { GuideDoc } from "../types";

/**
 * The roster page: what `presetStandard()` actually composes, and what else there is.
 *
 * The roster is written out here rather than derived from `generated/api.json`, because a content
 * module is imported by `tools/build-content-index.ts` under plain Node, where the snapshot's JSON
 * import does not resolve. It is not therefore unchecked: `CONFIG_KEYS` and `OPT_IN_BY_CATEGORY`
 * are exported, and `test/preset-roster.test.ts` compares both against the snapshot, so a plugin
 * that joins or leaves the preset fails the suite by name instead of leaving a roster that quietly
 * disagrees with the library. The composition *order* has no field in the snapshot at all (it is
 * normative in `packages/preset-standard/src/index.ts`'s own import order), so the test checks
 * membership and this page owns the sequence.
 */

/** The preset's composition order, as `packages/preset-standard/src/index.ts` returns it. */
const COMPOSITION_ORDER: readonly string[] = [
  "stargantt.data-store",
  "stargantt.view",
  "stargantt.tree-grid",
  "stargantt.task-bars",
  "stargantt.interaction",
  "stargantt.undo-redo",
  "stargantt.a11y",
  "stargantt.scheduling",
  "stargantt.export",
];

/** One line per plugin: what it is for, in the fewest words that still say something. */
const ROLES: Readonly<Record<string, string>> = {
  "stargantt.data-store": "holds the tasks, links, resources and assignments, and every edit to them",
  "stargantt.view": "the canvases, the viewport, panes, the timeline header, theming and gridlines",
  "stargantt.tree-grid": "the left pane: rows, columns, expand and collapse, conditional formatting",
  "stargantt.task-bars": "the bars themselves, and the geometry other plugins measure them by",
  "stargantt.interaction": "selecting, dragging, snapping, the tooltip, the context menu, the side panel",
  "stargantt.undo-redo": "the history, and the key chords that walk it",
  "stargantt.a11y": "the parallel ARIA treegrid, the roving focus and the announcements",
  "stargantt.scheduling": "dependency links, automatic scheduling, calendars and the critical path",
  "stargantt.export": "PNG/SVG/PDF export, print preview, CSV/XLSX/MSPDI import and export, embedding",
};

/** The `PresetStandardConfig` key each preset plugin is configured through — its factory name. */
export const CONFIG_KEYS: Readonly<Record<string, string>> = {
  "stargantt.data-store": "dataStore",
  "stargantt.view": "view",
  "stargantt.tree-grid": "treeGrid",
  "stargantt.task-bars": "taskBars",
  "stargantt.interaction": "interaction",
  "stargantt.undo-redo": "undoRedo",
  "stargantt.a11y": "a11y",
  "stargantt.scheduling": "scheduling",
  "stargantt.export": "export",
};

/** The opt-in factories, by the category `api.json` puts them in. */
export const OPT_IN_BY_CATEGORY: Readonly<Record<string, readonly string[]>> = {
  data: ["dataSync"],
  dev: ["i18n", "perfTools"],
  portfolio: ["portfolio"],
  resource: ["resource"],
  scheduling: ["tracking"],
};

// The role goes on its own line above the key rather than trailing it: a trailing comment column
// only stays aligned while nothing wraps, and at the 720px floor these all do.
const rosterListing = COMPOSITION_ORDER.map(
  (id) => `  // ${id} — ${ROLES[id] ?? ""}\n  ${CONFIG_KEYS[id] ?? ""}: {},`,
).join("\n");

const optInListing = Object.keys(OPT_IN_BY_CATEGORY)
  .sort()
  .map((category) => `// ${category}\n${(OPT_IN_BY_CATEGORY[category] ?? []).join(", ")}`)
  .join("\n\n");

const doc: GuideDoc = {
  slug: "what-the-standard-preset-loads",
  title: "What the standard preset loads",
  lede: "`presetStandard()` is the composition every example starts from. Here is what is in it, in the order it composes them, and what six more plugins add if you reach for them.",
  cells: [
    {
      kind: "prose",
      paragraphs: [
        "`presetStandard()` returns a plain array of plugin instances. It is not privileged and it is not magic — you can reorder it, filter it, or append to it before handing it to `create()`, and a fresh array of fresh instances comes back on every call, so changing one is safe.",
        "Nine plugins are in it. That is the whole default chart: without any of them the corresponding feature simply is not there, which is the point of a composition you can see. Several of the nine each fold together what would otherwise be several smaller, narrowly-scoped plugins, so a single `view: {}` line configures what a more finely split design would need five separate lines for.",
      ],
    },
    {
      kind: "code",
      source: `presetStandard({\n${rosterListing}\n})`,
      label: "ts",
      caption:
        "The composition order, and the `PresetStandardConfig` key that configures each one. Every key is optional — `presetStandard()` and `presetStandard({})` build the same chart.",
    },
    {
      kind: "runnable",
      source: `{
  preset: { treeGrid: { paneWidth: 260 } },
  height: 280,
}`,
      height: 280,
      caption:
        "`presetStandard()` with one option set — every feature below comes from a plugin in the list above",
    },
    {
      kind: "callout",
      tone: "info",
      body: "Automatic scheduling is composed, but switched off. A drag moves the bar you dragged and nothing else; links are still drawn, and a link that would make a loop is still refused. Pass `scheduling: { autoSchedule: { enabled: true } }` when you want editing one task to move everything downstream of it.",
    },
    {
      kind: "prose",
      paragraphs: [
        "Everything else is opt-in — six factories the bundle exports but `presetStandard()` never calls. An opt-in plugin costs nothing until you compose it: `tracking`, `resource`, `portfolio`, `i18n`, `perfTools` and `dataSync` are each a whole feature area (baselines/EVM, resource workload, cross-project rollups, localization, a perf overlay, live data sources) that most charts never need.",
        "Append them to the array the preset returns. Order inside the array is presentation only: the kernel sorts by declared dependencies before any plugin starts, so a plugin never has to be placed by hand to find what it needs.",
      ],
    },
    {
      kind: "code",
      source: optInListing,
      label: "ts",
      caption: "The opt-in plugin factories, by category. Each one has its own reference page.",
    },
    {
      kind: "code",
      source: `const gantt = StarGantt.create({
  element: document.getElementById("chart"),
  plugins: [
    // The nine above, with two of them configured.
    ...StarGantt.presetStandard({
      treeGrid: { paneWidth: 320 },
      scheduling: { autoSchedule: { enabled: true } },
    }),
    // Two more, appended.
    StarGantt.resource(),
    StarGantt.i18n({ locale: "ja" }),
  ],
});`,
      label: "ts",
      caption: "Configuring what is there, and adding what is not — the two things you do with the array",
    },
    {
      kind: "prose",
      paragraphs: [
        'To drop something instead, filter it out. Each plugin carries its id on `meta.id`, so `presetStandard().filter((p) => p.meta.id !== "stargantt.undo-redo")` is a chart with no undo history. Be careful dropping one another plugin declares a hard dependency on — the kernel refuses to start rather than running a plugin whose dependency is missing, which is the failure you want.',
      ],
    },
  ],
  next: ["/reference/data-store", "/reference/task-bars", "/core/plugin-host"],
};

export default doc;
