import type { PluginDoc } from "../../types";

/**
 * `stargantt.i18n` is a supply-side plugin: it holds a dictionary, it does not paint anything.
 * Every other official plugin resolves its own on-screen wording once, from its own `messages`
 * config, at `setup()` — and never looks at this service again. So none of this page's *property*
 * charts can show a config value changing a picture; that would require also rewiring a sibling
 * plugin's `messages`, which is a different plugin's option.
 *
 * The overview chart shows the other half of that sentence: wording that came out of this
 * dictionary at runtime, through the only route there is — a plugin that asks the service for it.
 * That is a five-line companion here, and it is exactly the shape of a third-party column, tooltip
 * or menu item written to speak the chart's language instead of hard-coding one.
 *
 * Note: `stargantt.i18n` sits in its own `dev` category alongside `perf-tools` — both are opt-in
 * developer-facing tooling rather than end-user chart features. It emits no events: every
 * observable dictionary change (an effective `setLocale`/`setFallbacks`, or an add/remove that
 * changes stored content) publishes a fresh snapshot on the `state` store (`I18nState`, holding
 * `locale`, `fallbacks`, `resolutionOrder` and `locales` together) instead — subscribe there
 * rather than to an event.
 */

/**
 * The `ja` table the overview chart is given, and the English the companion falls back to when no
 * dictionary answers. Keys follow the `"<prefix>.<messageKey>"` shape `catalog()` assumes.
 */
const KIND_TABLE_JA = {
  "kind.column": "種別",
  "kind.summary": "サマリー",
  "kind.task": "タスク",
  "kind.milestone": "マイルストーン",
};
const KIND_DEFAULTS_EN: Readonly<Record<string, string>> = {
  "kind.column": "Kind",
  "kind.summary": "Summary",
  "kind.task": "Task",
  "kind.milestone": "Milestone",
};

const doc: PluginDoc = {
  id: "stargantt.i18n",
  summary:
    "A locale-keyed dictionary with a fallback chain, published as a service so other plugins' message catalogs can be built from one table instead of many.",
  overview: [
    "This plugin owns no pixels. It registers per-locale translation tables, computes a fallback chain, and answers lookups — and that is the entire job. Nothing else in the chart consults it automatically: the tree grid's column headers, the side panel's field labels, undo/redo's announcements and every other piece of built-in wording are each fixed at that plugin's own `setup()`, from that plugin's own `messages` config, and never revisited. Composing `i18n()` into a chart with no other change produces a chart that renders byte-identically to one without it.",
    "The way it actually localizes anything is indirect, and worth having straight before you reach for it: build a dictionary (usually with the standalone `createDictionary()`, since sibling factories close over their config before `Gantt.create()` runs and the service does not exist yet), call `catalog(prefix, defaults)` once per sibling to get a `messages` object with the translated members substituted in, and pass those objects to the sibling factories. The `stargantt.i18n` plugin itself is then composed alongside them so the same table is available at runtime as a service — for diagnostics, for a lookup a host does directly, or for building further catalogs after the fact.",
    "Because every sibling's wording is frozen at setup, changing the active language at runtime means re-creating the chart with a new set of `messages` objects, not calling `setLocale()` on a running one. `setLocale()`, `setFallbacks()` and `add()`/`remove()` are real and take effect immediately in the service's own answers — `t()`, `has()`, `state.get().resolutionOrder` — they just do not reach back into bars, columns or menus that already resolved their strings.",
  ],
  whenYouNeedIt:
    "When the chart ships in more than one language and hand-writing a separate `messages` object per plugin, per locale, has stopped scaling — one dictionary and one `catalog()` call per plugin replaces that.",
  demo: { plugins: (sg) => [sg.i18n()] },
  overviewDemo: {
    kind: "configured",
    // A dictionary with nobody reading it is invisible by construction, so this chart composes the
    // reader too: a companion plugin contributing one grid column, whose header and every cell it
    // fills come from `t()` rather than from a string in its own source. `optional` rather than
    // `dependsOn` is what makes the comparison honest — pull `i18n()` out of the array and that
    // companion still starts, `useOptional` resolves to nothing, and the same column comes back in
    // English from the defaults it carries.
    //
    // The column is contributed at a negative weight so it lands ahead of tree-grid's own four
    // (they contribute at weight 0) and stays on screen where the grid pane is clamped narrow; the
    // extra height is so the milestone row, the third of the three translated words, is above the
    // fold rather than one scroll below it.
    spec: {
      height: 360,
      preset: { treeGrid: { rowHeight: 30, paneWidth: 360 } },
      plugins: (sg) => [
        sg.i18n({ locale: "ja", translations: { ja: KIND_TABLE_JA } }),
        sg.definePlugin({
          meta: { id: "docs.i18n-overview", optional: ["stargantt.i18n"] },
          setup(ctx) {
            const dictionary = ctx.useOptional("stargantt.i18n");
            const say = (key: string): string => dictionary?.t(key) ?? KIND_DEFAULTS_EN[key] ?? key;
            ctx.contribute("grid/columns", {
              id: "docs.kind",
              header: say("kind.column"),
              width: 160,
              weight: -1,
              getValue: (task) => task.type ?? "task",
              render: (element, task) => {
                element.textContent = say(`kind.${task.type ?? "task"}`);
              },
            });
          },
        }),
      ],
      code: `// A plugin that speaks the chart's language instead of hard-coding one: it holds
// English defaults and asks the dictionary for everything it puts on screen.
const kindColumn = StarGantt.definePlugin({
  meta: { id: "app.kind-column", optional: ["stargantt.i18n"] },
  setup(ctx) {
    const dictionary = ctx.useOptional("stargantt.i18n");
    const say = (key) => dictionary?.t(key) ?? DEFAULTS_EN[key] ?? key;

    ctx.contribute("grid/columns", {
      id: "app.kind",
      header: say("kind.column"),
      width: 160,
      weight: -1, // ahead of tree-grid's own four columns
      getValue: (task) => task.type ?? "task",
      render: (element, task) => {
        element.textContent = say(\`kind.\${task.type ?? "task"}\`);
      },
    });
  },
});

const gantt = StarGantt.create({
  element: document.getElementById("chart"),
  plugins: [
    ...StarGantt.presetStandard({ treeGrid: { rowHeight: 30, paneWidth: 360 } }),
    StarGantt.i18n({
      locale: "ja",
      translations: {
        ja: {
          "kind.column": "種別",
          "kind.summary": "サマリー",
          "kind.task": "タスク",
          "kind.milestone": "マイルストーン",
        },
      },
    }),
    kindColumn,
  ],
});`,
    },
    caption:
      "Every word in the leftmost column came out of the `ja` table this plugin was handed: the header `種別`, `サマリー` on the three summary rows, `タスク` on the six leaves, `マイルストーン` on `Ship` at the bottom. The plugin that contributes the column has no Japanese in it — it asks `t()` for each string and keeps its own English when nothing answers, which is what the same chart without `i18n()` shows.",
  },

  properties: [
    {
      name: "locale",
      prose: [
        "Chooses which locale's table this service's lookups start from. It is deliberately separate from the chart-wide `locale` option that drives `Intl` date and month formatting in the timeline header: that one is usually a precise regional tag like `\"ja-JP-u-ca-japanese\"` for correct calendar and numbering behaviour, while a translation table is often coarser — most projects maintain one `\"ja\"` table, not one per region. Leaving this unset inherits the chart-wide locale, which is the right choice until you specifically need the two to diverge.",
        "This matters most when the value is not a literal you typed but something that arrived from outside — a browser's `navigator.language`, a settings blob that finished loading after the chart did, a URL query param a user can edit by hand. Any of those can hand you a value that is not a non-empty string, and the service's answer to that is to fall back to the default quietly rather than throw, so a bad or half-loaded setting degrades to \"chart in its default language\" instead of a construction-time crash a host would have to guard against everywhere it reads config from the outside world.",
        "Setting it later through the service's `setLocale()` re-runs resolution and publishes a fresh snapshot on the `state` store, but only this plugin's own lookups see the new order; nothing repaints because of it.",
      ],
      demo: {
        kind: "none",
        reason:
          "The active locale only changes which table this service's own lookups consult; nothing on the chart re-reads the service, so no chart configuration this page could offer would look different.",
      },
    },
    {
      name: "translations",
      prose: [
        "The actual payload — one or more locale tables, each a flat map of dot-separated keys to translated strings. This is what makes the dictionary non-empty in the first place; every other option only changes how lookups traverse tables that this one supplies. The recommended key shape, `\"<pluginCamelName>.<messageKey>\"` such as `\"treeGrid.nameColumn\"`, is not enforced by the service but is what `catalog(prefix, defaults)` assumes when it builds a sibling's `messages` object.",
        "Read once at `setup()` and then owned entirely by the service's own copy: mutating the object you passed in afterwards has no effect, by the same rule that governs every plugin's config (a snapshot, not a live reference). To add or replace entries after the chart exists, call the service's `add(locale, entries)` — which merges per key, last write wins — or `remove(locale)` to drop a whole table. Values that are not plain strings are silently skipped per entry rather than failing the whole call, so a malformed translation file degrades one key instead of the load.",
      ],
      demo: {
        kind: "none",
        reason:
          "Loading translations changes what this service's t() and catalog() return, not what is drawn — the visible effect only appears once a sibling's own messages option is built from the result, which is that option's demo to carry, not this one's.",
      },
    },
    {
      name: "fallbacks",
      prose: [
        "The chain of extra locales consulted, in order, after the active locale and its own shortened prefixes have all missed. `\"en\"` is always appended at the end if it is not already present, so a lookup can never fail purely for lack of a terminal fallback — it fails only when no table anywhere holds the key, and then callers keep their own built-in default.",
        "The default is `[\"en\"]`, which is almost always right if your English table is complete. Passing an explicit empty array is honored rather than treated as \"unset\": it removes any intermediate fallback locales while `\"en\"` still lands as the terminal step, which is the shape you want for a two-language chart with no regional variants to bridge. Changing this at runtime with `setFallbacks()` recomputes `resolutionOrder` immediately and publishes a fresh snapshot on the `state` store, but — like `locale` — nothing outside the service itself reacts to that change.",
      ],
      demo: {
        kind: "none",
        reason:
          "The fallback chain is only observable by calling the service directly (t(), has(), state.get().resolutionOrder); it changes lookup order inside a table, never a pixel, so no chart configuration demonstrates it.",
      },
    },
  ],

  notes: {
    services: {
      "stargantt.i18n":
        "The one thing this plugin does. Use it to build `catalog()` results for sibling `messages` configs before `Gantt.create()` runs (prefer the standalone `createDictionary()` for that timing), or after creation for a host's own runtime lookups and diagnostics. No official plugin calls it on your behalf. Its `state` store is the thing to subscribe to if a host caches resolved strings of its own and wants to know when to re-resolve them.",
    },
    events: {
      __empty:
        "This plugin emits no events — every observable dictionary change (an effective setLocale or setFallbacks, or an add/remove that changes stored content) publishes a fresh snapshot on the service's own `state` store instead of firing an event, so there is nothing left to subscribe to on the event bus; subscribe to `state` in its place.",
    },
    commands: {
      __empty:
        "There is no imperative gesture to route through a command here — every change is a direct call on the stargantt.i18n service (setLocale, add, remove, setFallbacks), made by host code rather than triggered by the user through the chart's UI.",
    },
    extensionPoints: {
      __empty:
        "The plugin contributes nothing to the render pipeline and defines no point of its own for others to contribute to — it is a data structure behind a service, not a participant in painting, hit-testing, or layout.",
    },
  },

  recipes: [
    {
      title: "Build every sibling's messages from one dictionary",
      intent:
        "The pattern the contract recommends: assemble the dictionary before Gantt.create() runs, since the sibling factories close over their config too early for the service to exist yet.",
      code: `const TRANSLATIONS = {
  ja: {
    "treeGrid.nameColumn": "名前",
    "treeGrid.startColumn": "開始",
    "treeGrid.endColumn": "終了",
    "undoRedo.undone": "元に戻しました",
    "undoRedo.redone": "やり直しました",
  },
};

// Built before Gantt.create(), since the sibling factories below close over their
// config too early for the stargantt.i18n service to exist yet.
const dict = createDictionary({ locale: "ja", fallbacks: ["en"], translations: TRANSLATIONS });

const treeGridDefaults = { nameColumn: "Name", startColumn: "Start", endColumn: "End" };
const undoRedoDefaults = { undone: "Undone", redone: "Redone" };

const gantt = Gantt.create({
  container: "#chart",
  locale: "ja-JP", // drives Intl date/month formatting separately from the dictionary above
  plugins: [
    // undoRedo is one of the nine plugins presetStandard() already returns — configure it
    // through the preset's own key, the same way as treeGrid, rather than appending a second
    // undoRedo() (that would throw: duplicate plugin id at create time).
    ...presetStandard({
      treeGrid: { messages: dict.catalog("treeGrid", treeGridDefaults) },
      undoRedo: { messages: dict.catalog("undoRedo", undoRedoDefaults) },
    }),
    // Composed too, so the same table is reachable at runtime as a service.
    i18n({ locale: "ja", fallbacks: ["en"], translations: TRANSLATIONS }),
  ],
});`,
    },
    {
      title: "Diagnose a missing translation at runtime",
      intent:
        "state.get().resolutionOrder shows exactly which tables a lookup will try, in order — the fastest way to tell \"the key is missing everywhere\" from \"the key is in a table this locale never reaches\".",
      code: `const svc = gantt.service("stargantt.i18n");

console.log(svc.state.get().resolutionOrder);
// e.g. ["ja-jp", "ja", "en"] for locale "ja-JP" with fallbacks ["en"]

console.log(svc.has("treeGrid.nameColumn", "ja-JP")); // exact table, no chain
console.log(svc.has("treeGrid.nameColumn"));           // whole chain, same as t() !== undefined`,
    },
    {
      title: "Let a partial translation degrade to English key by key",
      intent:
        "A table that only covers part of the UI is normal, not an error — missing keys fall through to the caller's own default rather than showing blank or throwing.",
      code: `const dict = createDictionary({
  locale: "fr",
  translations: {
    fr: {
      "treeGrid.nameColumn": "Nom",
      "treeGrid.startColumn": "Début",
      // treeGrid.endColumn intentionally left untranslated: catalog() will keep the English default.
    },
  },
});

const messages = dict.catalog("treeGrid", { nameColumn: "Name", startColumn: "Start", endColumn: "End" });
// => { nameColumn: "Nom", startColumn: "Début", endColumn: "End" }`,
    },
  ],
};

export default doc;
