import { T0 } from "../../../lib/data";
import type { AnyPlugin, PluginDoc, StarGanttApi } from "../../types";

const DAY = 86_400_000;

/**
 * `stargantt.export` ships inside `presetStandard()` as one facade over image export, print/PDF,
 * CSV/JSON/iCal, MS-Project XML, xlsx and read-only embedding, so every demo below configures it under
 * `preset: { export: {...} } }` rather than composing a second instance through `plugins`. The
 * plugin itself paints nothing at any configuration — it contributes no layer, and a composition
 * that never calls its service renders byte-identical to one without it (export.md §"Purpose"). The
 * one visible surface any demo here can show is therefore a service call a companion plugin makes
 * once the chart's data has loaded: `printPreview()` mounts a real on-screen overlay, and
 * `importCsv(text, { dialog: true })` mounts the import dialog — both are used below. `toPng`,
 * `toXlsx` and the rest return bytes or strings with nothing on the page to point at, which is why
 * `image` and `excel` are the two properties on this page with no picker.
 */

/** Opens the print preview once the demo's data has loaded — the same call a host's own "Print"
 *  button makes. Depending on `stargantt.export` (always present via the preset) and
 *  `stargantt.data-store` guarantees both exist before this runs; waiting for the `tasks` store's
 *  first notification matters because `GanttPreview` creates the chart before it loads the demo
 *  dataset, and a preview opened against an empty store would degrade to one blank page. */
function openPreviewOnLoad(sg: StarGanttApi): AnyPlugin {
  return sg.definePlugin({
    meta: { id: "docs.export-preview", dependsOn: ["stargantt.export", "stargantt.data-store"] },
    setup(ctx) {
      const data = ctx.use("stargantt.data");
      const off = data.tasks.subscribe(() => {
        off.dispose();
        ctx.use("stargantt.export").printPreview();
      });
      ctx.own(off);
    },
  });
}

/** As {@link openPreviewOnLoad}, but passes `options` through to `printPreview`. */
function openPreviewWith(sg: StarGanttApi, options: Record<string, unknown>): AnyPlugin {
  return sg.definePlugin({
    meta: { id: "docs.export-preview-options", dependsOn: ["stargantt.export", "stargantt.data-store"] },
    setup(ctx) {
      const data = ctx.use("stargantt.data");
      const off = data.tasks.subscribe(() => {
        off.dispose();
        ctx.use("stargantt.export").printPreview(options);
      });
      ctx.own(off);
    },
  });
}

const T2 = T0 + DAY * 2;
const T4 = T0 + DAY * 4;

/** A semicolon-delimited CSV file, staged and imported (with the dialog open) once the demo's data
 *  has loaded — the same three-step `importCsv(text, { dialog: true })` call a host's own file-input
 *  handler would make. Under the default `","` delimiter the header row never splits into real
 *  columns, so every data row fails validation and the dialog shows no changes; under `";"` it
 *  parses into a real `Add` change. */
function importSemicolonCsvOnLoad(sg: StarGanttApi): AnyPlugin {
  const text = `name;start;end\nImported via CSV;${T2};${T4}\n`;
  return sg.definePlugin({
    meta: { id: "docs.export-csv-import", dependsOn: ["stargantt.export", "stargantt.data-store"] },
    setup(ctx) {
      const data = ctx.use("stargantt.data");
      const off = data.tasks.subscribe(() => {
        off.dispose();
        ctx.use("stargantt.export").importCsv(text, { dialog: true });
      });
      ctx.own(off);
    },
  });
}

/** Attempts one task edit the instant the chart's data has finished loading, tagged with a
 *  caller-chosen transaction origin — the only way to make a read-only veto, or an exemption from
 *  it, show up as a different pixel: the `sg-readonly` root class carries no styling of its own
 *  (export.md §2.1), so a vetoed edit and one never attempted render identically unless you actually
 *  try the edit and look at whether it landed. */
function attemptEdit(sg: StarGanttApi, taskId: string, progress: number, origin: string): AnyPlugin {
  return sg.definePlugin({
    meta: { id: "docs.export-attempt-edit", dependsOn: ["stargantt.data-store"] },
    setup(ctx) {
      const data = ctx.use("stargantt.data");
      const off = data.tasks.subscribe(() => {
        off.dispose();
        ctx.dispatch("task/update", { id: taskId, after: { progress }, origin });
      });
      ctx.own(off);
    },
  });
}

const doc: PluginDoc = {
  id: "stargantt.export",
  summary:
    "The chart's whole outbound and inbound surface in one facade: image and PDF export, CSV/JSON/iCal and MS-Project interchange, an .xlsx writer, and read-only/embed viewing with self-contained snapshot links.",
  overview: [
    "This one service, `stargantt.export`, has no `downloadX` methods (`downloadPng`, `downloadCsv`, and so on). Every producing method returns bytes or a string — a `Blob`, an `ArrayBuffer`, plain text — and saving that to a file is the SDK's public `downloadFile` helper (`sdk/dom`), the exact object-URL/`<a download>`/revoke incantation a download needs. A host that wants a file on disk calls the export method, then calls `downloadFile` on the result; there is no export method that triggers a download by itself. Deliberately out of scope: a standalone `inferCsvMapping`, `validate`, `diff` or `apply` for a caller-constructed document or change list — the members that took or returned a free-standing document a host could build or edit before applying. What replaces them is the parse-then-`dryRun`-then-`filter` pipeline on `importCsv` / `importJson` / `applyMsProjectXml` themselves; a caller-constructed document has no path into this plugin at all.",
    "The plugin is entirely pull-driven: it contributes no renderer layer, subscribes to nothing per frame, and its one standing cost — for the whole instance's life, whether or not you ever call it — is a single `data/willApplyTransaction` subscription that exists for the read-only veto and the import batch harvest. A composition that includes `stargantt.export` and never calls its service pays that one subscription and nothing else. Everything downstream of a call runs entirely offscreen: image and PDF rendering walk the view plugin's own `renderTo` virtual-viewport path into canvases nothing on the page ever shows, so no zoom, scroll or repaint on the live chart is visible while an export runs.",
    "It ships inside `presetStandard()`, so `gantt.service(\"stargantt.export\")` exists the moment a reader already calling `presetStandard()` needs it, with nothing extra to add — the six config nests below are set by passing an `export` block into `presetStandard({ export: {...} })`, the same way `treeGrid` or `theme` are configured on the same call. There is no standalone `exportPlugin()` export from the bundle to compose a second time; the preset has already registered the one instance a composition gets.",
  ],
  whenYouNeedIt:
    "the chart needs to leave the browser tab it lives in — a PNG for a status report, a PDF a printer can produce, a CSV or MS-Project file another tool opens, a share link that rebuilds the whole project with no backend — or needs to become a locked-down viewer for an audience that should not edit it. It is already present the moment `presetStandard()` is in play; without composing anything further, a chart's data only ever leaves through whatever a host writes by hand against the raw store.",
  demo: {},
  overviewDemo: {
    kind: "configured",
    spec: { plugins: (sg) => [openPreviewOnLoad(sg)], height: 420 },
    caption:
      "The print-preview overlay, opened over the chart by a single service call: one sheet per page, each carrying the repeated task table down its left edge and a numbered footer.",
  },

  properties: [
    {
      name: "messages",
      prose: [
        "One merged 26-key catalog with no collisions and no renames between its two halves: the thirteen keys the print path uses (legend labels, the preview overlay's title and buttons, the printed table's column headers, the page-number builder) and the thirteen the import dialog uses (its title, the column-mapping legend, per-field labels, issue text, change-preview labels, the two footer buttons). export-image, msproject-io, excel-io and viewer-embed contribute no keys at all — their only English-language output is developer-facing error text and data cells, which sit outside catalog scope.",
        "Resolved once at `setup()` from whatever the factory `config` closed over: a chart that needs a different language rebuilds with a new `export` block rather than mutating this object in place after the fact. Every builder key (`pageNumber`, `fieldLabel`, `issuesHeading`, `issueText`, `applyButton`) is wrapped in the same per-call containment — a throw is reported once through `core/pluginError` and the built-in English text answers for that one call, so a broken localization function degrades a single label rather than the whole dialog or page.",
        "Only two of the twenty-six keys have no honest way to appear in a demo picker here: `columnName` / `columnStart` / `columnEnd` / `columnProgress` only ever print inside a rendered PDF page, which this site's live-demo mechanism cannot show the contents of any more than it can show a downloaded PNG. The value below instead changes three keys a reader can actually see on screen — the preview overlay's own chrome — leaving the rest to the generated reference below and the plugin's own `ExportMessages` type for the full list.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (no preview open)", demo: {} },
          { label: "default (English) — the preview overlay opened", demo: { plugins: (sg) => [openPreviewOnLoad(sg)], height: 420 } },
          {
            label: '{ previewTitle: "Vorschau drucken", printButton: "Drucken", closeButton: "Schließen" }',
            demo: {
              preset: {
                export: {
                  messages: { previewTitle: "Vorschau drucken", printButton: "Drucken", closeButton: "Schließen" },
                },
              },
              plugins: (sg) => [openPreviewOnLoad(sg)],
              height: 420,
            },
          },
        ],
      },
    },
    {
      name: "image",
      prose: [
        "Factory-level defaults for `toPng` / `toSvg`: the backdrop colour painted before the layers composite (omitted, the exported area stays transparent — JPEG substitutes opaque white since it has no alpha channel), the pixel density of the raster encoders (omitted, recovered from whatever ratio the chart is currently drawn at), and how much of the timeline the export covers (`\"viewport\"` by default, versus `\"full\"` or an explicit `{ start, end }` span). Every field here is also a per-call option — `toPng({ range: \"full\" })` overrides this nest's `range` for that one call without touching the factory default the next call falls back to.",
        "None of the three fields has any bearing on the live chart. `background`, `pixelRatio` and `range` only ever shape bytes an offscreen canvas produces and a caller has not yet asked for — there is no image preview surface anywhere in this plugin, unlike the print path's `printPreview()`. That is a structural fact about image capture, not a gap in this demo: the exported PNG or SVG is a file a reader downloads and opens elsewhere, never a picture this site's live chart could show changing.",
        "Reach for `range: \"full\"` the moment an export needs to hand someone the whole project rather than whatever happened to be scrolled into view — it walks every row and the full task-date extent through tiled virtual viewports, so a ten-thousand-row chart does not need a ten-thousand-row canvas to capture, and nothing on the live page scrolls or flickers while it happens. An explicit `{ start, end }` is the middle ground for \"just this sprint\"; get the numbers wrong in a way that cannot be repaired (an inverted pair is simply swapped, but a span under one exported pixel is not) and `toPng` / `toSvg` reject outright, because that combination can only be a caller mistake.",
      ],
      demo: {
        kind: "none",
        reason:
          "Every field here only ever shapes bytes written into an offscreen canvas for a caller who has not asked for them yet — there is no on-screen image preview anywhere in this plugin, unlike the print path's printPreview(), so no picker here could ever show two different pictures of the live chart.",
      },
    },
    {
      name: "print",
      prose: [
        "Factory-level defaults for `toPdf`, `pageCount` and `printPreview` — paper size, orientation, chart scale, margins, header/footer text, the exported date and row range, which task-table columns repeat down the left of every page, the legend, and a critical-path emphasis mode. Every field is also a per-call option, shallow-overridden per key onto this baseline, so a chart that prints both a landscape overview and a portrait detail sheet sets the common defaults once here and passes only what differs at each call site.",
        "Paper and orientation are the two fields a demo can show changing shape rather than only text: the printable area, the table's fixed column widths and where page breaks fall are all derived from them, so a `printPreview()` under `{ orientation: \"portrait\" }` visibly reflows into a taller, narrower page rather than merely relabelling the same one. `criticalPathOnly` needs `stargantt.critical-path` composed to do anything — without it the option is silently ignored, one of several optional-plugin interactions this nest has (row spans read `stargantt.tree-grid`'s row model when present, otherwise the current viewport's rows).",
        "The PDF path is worth budgeting before scaling `pixelRatio` up: each page is a lossless raster with no compression beyond a PNG-style row filter, so an A4 page at the default ratio (2) lands near 10 MB and every page is held in memory at once while the document assembles. `printPreview()` routes around that entirely — it prints the browser's own accessible rendering of the same pages through `window.print()`, which is also the path to prefer for anything with PDF accessibility obligations, since the raster PDF itself carries no extractable or tagged text.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (no preview open)", demo: {} },
          {
            label: 'default ("a4", "landscape") — the preview overlay opened',
            demo: { plugins: (sg) => [openPreviewOnLoad(sg)], height: 420 },
          },
          {
            label: '{ orientation: "portrait" } — a taller, narrower page',
            demo: {
              preset: { export: { print: { orientation: "portrait" } } },
              plugins: (sg) => [openPreviewOnLoad(sg)],
              height: 420,
            },
          },
        ],
      },
    },
    {
      name: "importExport",
      prose: [
        "One field, `csvDelimiter`, shared by `exportCsv()` (unless a call passes its own `delimiter`) and `importCsv()`'s header parsing. Reach for it when the destination is a spreadsheet locale that treats comma as a decimal separator and expects semicolon-delimited files, or when a source file you need to import already uses one — this is the chart-wide default, and a single button that needs the other delimiter passes `{ delimiter: \";\" }` to that one `exportCsv()` call rather than changing this nest.",
        "On export this is purely cosmetic to anything on screen: every effect of the delimiter lands inside a string `exportCsv()` returns, never a chart pixel. Import is the opposite — it decides whether a file parses at all. A semicolon-delimited file fed through the default `\",\"` turns the header row into one unmatched column, so every data row fails validation and the diff has nothing to apply; the same text imported with `csvDelimiter: \";\"` set correctly turns into a real change. That divide (inert on export, decisive on import) is why the demo below stages a file and imports it with the dialog open, rather than showing an exported string.",
        "Anything other than exactly one character — an empty string, two characters, a non-string value — is silently ignored and the plugin falls back to `\",\"`, the same tolerant-input stance every option here takes. There is no validation event for this, so a typo reads as \"my delimiter did nothing\" rather than as an error; if a CSV round-trip looks wrong, this field not taking effect is the first thing to check.",
      ],
      demo: {
        kind: "values",
        prerequisite: {
          data: [{ id: "existing", parentId: null, name: "Existing task", start: T0, end: T0 + DAY }],
        },
        values: [
          { label: 'default (",")', demo: {} },
          {
            label: 'default (",") — a semicolon-delimited file staged; the dialog finds nothing to import',
            demo: { plugins: (sg) => [importSemicolonCsvOnLoad(sg)], height: 420 },
          },
          {
            label: '";" — the same file now parses into one real Add change',
            demo: {
              preset: { export: { importExport: { csvDelimiter: ";" } } },
              plugins: (sg) => [importSemicolonCsvOnLoad(sg)],
              height: 420,
            },
          },
        ],
      },
    },
    {
      name: "excel",
      prose: [
        "One field, `sheetName` — the label on the single worksheet tab inside the `.xlsx` workbook `toXlsx()` returns, sanitized to Excel's own rules (the characters `\\ / ? * [ ] :` stripped, truncated to 31 characters, leading/trailing apostrophes trimmed after that, and a result that would collide with Excel's reserved `history` sheet name replaced outright). The per-call `toXlsx({ sheetName })` option always wins over this factory default, so this nest is best read as \"what the sheet is called when no call names it explicitly\" for a composition that exports more than one project through the same chart instance.",
        "There is nothing else to configure on this path on purpose: every cell is written as an inline string with no styles, no number formats and no shared-string table, and even the ZIP entry timestamps are fixed rather than the current time — identical store state always produces byte-identical output. `toXlsx()` shares its row and column model with `exportCsv()` (the same seven-field vocabulary, the same ISO 8601 UTC date-time text, the same insertion-order rows), so a `columns` list that narrows one export form narrows the other unchanged.",
        "Like every other producing method here, `toXlsx()` neither writes to the store nor triggers a download by itself — it returns an `ArrayBuffer`, and turning that into a saved file is the same `downloadFile` one-liner every other export path uses. There is no `.xlsx` import in this plugin at all; the workbook writer is export-only.",
      ],
      demo: {
        kind: "none",
        reason:
          "sheetName only changes text inside a downloaded .xlsx file this plugin never opens or renders on the page — the chart itself is pixel-identical at every value, and a spreadsheet's own tab label is not something a browser page can display at all.",
      },
    },
    {
      name: "viewerEmbed",
      prose: [
        "Three concerns in one nest because they share one job: turning an editable chart into something safe to hand to someone who should not, or cannot, run the full editing stack. `readOnly` vetoes every store transaction at the single choke point every editing plugin's commits pass through — tree-grid edits, drag-edit commits, paste, this plugin's own imports — so no editing plugin needs to know this nest exists. `embed` dresses the chart root for iframe hosting with one scoped stylesheet (fill-container sizing, disabled text selection) and nothing else; it also flips `readOnly`'s own default to `true`, though an explicit `readOnly: false` still wins.",
        "The veto is deliberately porous to machine-originated writes: transactions whose `origin` begins with `\"stargantt.data-sync/\"` always pass, and `readOnlyExemptOrigins` names more on top — the built-in set only ever grows, never narrows. That is what lets a read-only viewer composed alongside a live sync plugin keep receiving that feed's updates while a reader's own clicks and drags are silently discarded; without an exemption, a read-only viewer of live data would go stale with no diagnostic the moment `readOnly` turned on.",
        "`snapshotParam` and `autoRestore` belong to the third concern, snapshot tokens: a whole project serialized into a URL-safe string a plain HTML page restores with no backend. `snapshotParam` only decides where in the URL fragment the token is looked for, not the token's own format, and matters the moment two independently-hosted instances need to hand each other links — they only understand each other's URLs if both agree on this name. `autoRestore` runs the omitted-argument form of `applySnapshot()` during `setup()`, which is before `create()` even returns — a host that seeds the chart with its own `data.load()` call afterward (the normal pattern) overwrites that restore outright, so `autoRestore` only helps a page that loads no data of its own.",
      ],
      demo: {
        kind: "values",
        values: [
          { label: "default (baseline chart)", demo: {} },
          {
            label: "readOnly: true — the attempted edit is vetoed; the bar stays at 0%",
            demo: {
              preset: {
                export: { viewerEmbed: { readOnly: true } },
                // The default day-scale zoom only shows the first handful of days from the
                // dataset's origin, and "plugins" (the task attemptEdit targets) sits two weeks
                // in — its row is visible in the grid pane, but its bar renders off the right
                // edge of the canvas, so a progress change on it was pixel-invisible even though
                // it landed correctly. Zooming to a week-per-column view brings the whole
                // 24-day dataset on screen.
                view: { timeline: { initialZoom: "week" } },
              },
              plugins: (sg) => [attemptEdit(sg, "plugins", 0.9, "docs.export-attempt-edit")],
              height: 420,
            },
          },
          {
            label: 'readOnly: true, readOnlyExemptOrigins: ["docs.export-attempt-edit"] — the same edit lands',
            demo: {
              preset: {
                export: {
                  viewerEmbed: { readOnly: true, readOnlyExemptOrigins: ["docs.export-attempt-edit"] },
                },
                view: { timeline: { initialZoom: "week" } },
              },
              plugins: (sg) => [attemptEdit(sg, "plugins", 0.9, "docs.export-attempt-edit")],
              height: 420,
            },
          },
        ],
      },
    },
  ],

  notes: {
    services: {
      "stargantt.export":
        "The full facade — image, print/PDF, CSV/JSON/iCal, MS-Project XML, xlsx, snapshots, read-only. Four members this page's demos never call directly, named here so a reader scanning the page — rather than the generated member table — still finds them: `exportJson()` wraps `stargantt.data`'s own `toJSON()` in a schema tag and returns it as text, the JSON-interchange counterpart `importJson()` reads back; `exportICal()` returns an `.ics` calendar body (one `VEVENT` per task) for subscribing a calendar app to the schedule rather than round-tripping a project file; `toMsProjectXml()` is the export half of `applyMsProjectXml()` — an MSPDI XML string a reader saves or hands straight to Microsoft Project; and `MsProjectImportResult.baselineInits` (on the object `applyMsProjectXml()` resolves to) reshapes any baselines the imported file declared into the exact array the tracking plugin's `baselines` nest takes — `tracking({ baselines: { baselines: result.baselineInits } })` seeds a chart's saved plan in the same call that seeds its live schedule.",
    },
    events: {
      "importexport/applied":
        "Fires once per non-empty CSV/JSON apply, whether the call came from host code (`cause: \"api\"`) or the import dialog's own Apply button (`cause: \"dialog\"`) — the hook to watch for reacting to data arriving from a file rather than a drag.",
      "msprojectio/applied":
        "Fires once per non-zero `applyMsProjectXml` apply. Unlike the CSV/JSON path, an MS-Project import dispatches one command per task, link, resource and assignment rather than batching into one transaction, so it leaves that many undo steps — this event still fires exactly once regardless.",
      "viewerembed/readOnlyChanged":
        "Fires only on an effective runtime change made through `setReadOnly()` — the initial state from `viewerEmbed.readOnly` (or its `embed`-flipped default) emits nothing, so call `isReadOnly()` to learn what a chart started as rather than listening here.",
      "viewerembed/snapshotApplied":
        "The `source` field is the only way to tell an `autoRestore` pickup apart from a host calling `applySnapshot()` by hand — both restore identically, and `droppedTasks` reports how many decoded entries failed the minimal per-task validation on the untrusted-URL path.",
    },
    commands: {
      __empty:
        "This plugin owns no commands of its own. Every mutation it makes dispatches the data store's public commands instead — task/add, task/update, task/remove stamped origin \"import\" for the generic formats; task/add, task/update, link/add, resource/add, assignment/set stamped origin \"msproject\" for MS-Project — so a third party observing transactions sees ordinary, undoable data-store commands rather than anything specific to this plugin.",
    },
    extensionPoints: {
      "export/auxiliarySurfaces":
        "How a band that is not a canvas layer — the view plugin's timeline header, the resource plugin's load-chart band — gets into an exported image at all. Each contributor supplies its own `drawTile` (and optionally `drawTileSVG` for a true vector path); this plugin never inspects what a surface draws, only calls the callback tile by tile and stacks the results above or below the composited layers per `side`. Contributions register unconditionally, even in a composition without this plugin present, so nothing is lost by composing this plugin later than its contributors.",
    },
  },

  recipes: [
    {
      title: "A print button that downloads a PDF",
      intent: "The common case: one click, one file, no dialog the reader has to navigate first.",
      code: `const gantt = create({
  element: mount,
  plugins: presetStandard({
    export: { print: { paper: "a4", orientation: "landscape" } },
  }),
});
gantt.service("stargantt.data").load(dataset);

printButton.addEventListener("click", async () => {
  const blob = await gantt.service("stargantt.export").toPdf({
    header: { left: "Release plan", right: (info) => \`Page \${info.page} of \${info.pages}\` },
  });
  downloadFile(document, blob, "schedule.pdf", "application/pdf"); // sdk/dom's public downloadFile — no bespoke a[download] wiring
});`,
    },
    {
      title: "Let a reader review a dropped CSV or JSON file before it lands",
      intent:
        "importCsv / importJson do the parsing, cross-record validation, diffing and (with dialog: true) the column-mapping preview UI for you — wire a file input to it and the reader decides what to keep.",
      code: `const exportSvc = gantt.service("stargantt.export");

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  const text = await file.text();
  if (file.name.endsWith(".json")) exportSvc.importJson(text, { dialog: true });
  else exportSvc.importCsv(text, { dialog: true });
  // The dialog's own Apply button dispatches the batch (cause "dialog") and fires importexport/applied.
});`,
    },
    {
      title: "Ship a read-only public viewer with a share-link button",
      intent:
        "No backend, no id registry: the whole project rides inside the URL fragment. autoRestore is left off deliberately — it fires during create(), before the host's own load() below, and would otherwise be overwritten by it.",
      code: `const plugins = presetStandard({
  export: { viewerEmbed: { embed: true } }, // fills its container, read-only defaults to on
});
const gantt = create({ element: mount, plugins });
gantt.service("stargantt.data").load(dataset);

const link = gantt.service("stargantt.export").snapshot({ url: true });
navigator.clipboard.writeText(location.origin + location.pathname + link);`,
    },
  ],
};

export default doc;
