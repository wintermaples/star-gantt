# Plugin: export (`stargantt.export`)

Package: `@stargantt/plugin-export` — Layer 8.
Status: normative.

## Purpose

Image export (PNG / JPEG / SVG vectorization); printing (self-written PDF, pagination, on-demand print preview); CSV / JSON / iCal import-export including the import dialog; MS Project MSPDI XML interchange; Excel workbook export (self-implemented xlsx ZIP); read-only viewing, embed dressing, and URL snapshot tokens. Everything is service-driven and on-demand: the plugin is never resident in the render pipeline, contributes no layer, and paints nothing on its own. With no service call and an all-default config, a composition that includes this plugin renders byte-identically to one without it (the only standing footprint is one `data/willApplyTransaction` subscription, §11).

Every capability is served through the single `stargantt.export` facade. Saving to a file is the host's one-liner through the SDK's public `downloadFile` (`sdk/dom`) — §1.9. The facade deliberately omits a free-standing document/change-list apply pipeline; §1's design notes record what is deliberately absent and why.

## 1. Services

### `stargantt.export` → `ExportService`

```ts
import type { ExtensionPointDecl, Plugin } from "@stargantt/core";
import type {
  Assignment, Link, LinkId, Resource, Task, TaskId,
} from "@stargantt/plugin-data-store";
// Type-only (devDependency; the type-only exemption): the tracking plugin's baseline-seed
// shape. tracking.md fixes the authoritative declaration; the structural content this
// plugin produces is stated at MsProjectImportResult below.
import type { BaselineInit } from "@stargantt/plugin-tracking";

/** Which part of the timeline an image export covers. */
export type ExportRange = "viewport" | "full" | { start: number; end: number };

/** Factory-config shape of the image nest; also the per-call base options. */
export interface ImageCaptureConfig {
  /** CSS color painted behind the chart before the layers composite. Omitted: transparent
   *  (PNG/SVG) — JPEG substitutes opaque white (§1.1). Passed through unparsed. */
  background?: string;
  /** Image pixels per CSS pixel. Omitted: the ratio the chart is currently drawn at
   *  (recovered from the view plugin's layer canvases, fallback 1). Raster-only. */
  pixelRatio?: number;
  /** Default `"viewport"`. `"full"` = the store's whole task extent; the object form is an
   *  explicit epoch-ms span. */
  range?: ExportRange;
}

export interface RasterOptions extends ImageCaptureConfig {
  /** Encoder. Default `"png"`. `"jpeg"` selects the JPEG encoder (§1.1). */
  format?: "png" | "jpeg";
  /** JPEG-only compression quality 0..1, forwarded to the encoder; unusable values leave the
   *  encoder default (about 0.92). Ignored for PNG. */
  quality?: number;
}

/** One horizontal slice of the exported area, handed to auxiliary-surface draw callbacks (§4). */
export interface ExportTile {
  start: number;       // slice time span, epoch ms
  end: number;
  width: number;       // slice CSS-pixel box (height = the surface's own band height)
  height: number;
  pixelRatio: number;  // the export's ratio; the raster callback's context is pre-scaled by it
  /** Start of the WHOLE exported span this tile slices. Decisions that need to agree across every
   *  tile of one export (e.g. header label thinning) are computed from this span, not the
   *  tile's own slice, so tiles compose without seams. */
  rangeStart: number;
  /** End of the whole exported span. See `rangeStart`. */
  rangeEnd: number;
}

/** A non-layer surface that appears in exported images. See §4. */
export interface AuxiliarySurfaceContribution {
  side: "top" | "bottom";
  height: number;      // band height, CSS px
  drawTile(ctx: CanvasRenderingContext2D, tile: ExportTile): void;
  /** Vector form of the same slice; absent, SVG exports embed the rasterized `drawTile`. */
  drawTileSVG?(tile: ExportTile): string;
}

/** Position-addressed page text: a fixed string or a per-page builder. */
export type PrintText = string | ((info: PrintPageInfo) => string);

export interface PrintPageInfo {
  page: number;   // 1-based
  pages: number;  // total page count of this export
  date: number;   // export creation time, epoch ms (same value on every page)
}

export interface PrintLegendEntry { color: string; label: string }

export type PrintColumnId = "name" | "start" | "end" | "progress";

export interface PrintOptions {
  /** Paper size. Default "a4". */
  paper?: "a4" | "a3" | "letter";
  /** Default "landscape". */
  orientation?: "portrait" | "landscape";
  /** Chart scale in percent, clamped to 10–400. Default 100. */
  scale?: number;
  /** Page margin in millimetres, usable in 0–50. Default 10. */
  marginMm?: number;
  /** Image pixels per CSS pixel of the rendered pages. Default 2; a finite value above 4 is
   *  clamped to 4 (canvas-memory guard — a clamp exception like `scale`'s, not an ignore);
   *  non-positive or unusable values fall back to 2. */
  pixelRatio?: number;
  /** Header line, three positions. All omitted (the default): no header band. */
  header?: { left?: PrintText; center?: PrintText; right?: PrintText };
  /** Footer line. Default: `center` is the page-number text; `""` suppresses it. */
  footer?: { left?: PrintText; center?: PrintText; right?: PrintText };
  /** Exported time range, epoch ms; each missing bound taken from the store's task extent. */
  range?: { start?: number; end?: number };
  /** Exported row range, 0-based inclusive indexes into the rows service. Default: all rows. */
  rows?: { from?: number; to?: number };
  /** Table columns repeated on the left of every page. `[]`: no table. Default `["name"]`. */
  columns?: readonly PrintColumnId[];
  /** Legend band: `true` (default) auto-generates entries; an array replaces them; `false` omits. */
  legend?: boolean | readonly PrintLegendEntry[];
  /** Critical-path emphasis: non-critical rows are veiled. Default `false`. */
  criticalPathOnly?: boolean;
}

export type TaskCsvField = "id" | "parentId" | "name" | "start" | "end" | "progress" | "type";
export type CsvMapping = readonly (TaskCsvField | null)[];

export interface CsvExportOptions {
  delimiter?: string;                 // single character; default: the importExport nest's csvDelimiter
  columns?: readonly TaskCsvField[];  // default: all seven fields, in TaskCsvField order
  bom?: boolean;                      // default false
}

export interface ICalExportOptions {
  calendarName?: string;              // X-WR-CALNAME; omitted by default
  includeSummaryTasks?: boolean;      // default false
}

export type ImportIssue =
  | { code: "invalid-json"; reason: string }
  | { code: "invalid-row"; row: number; reason: string }
  | { code: "bad-date"; field: "start" | "end"; value: unknown; row?: number; taskId?: TaskId }
  | { code: "missing-field"; field: string; row?: number; taskId?: TaskId }
  | { code: "duplicate-id"; taskId: TaskId; row?: number }
  | { code: "unknown-parent"; taskId: TaskId; parentId: TaskId }
  | { code: "parent-cycle"; taskId: TaskId }
  | { code: "unknown-link-end"; linkId: LinkId; taskId: TaskId }
  | { code: "dependency-cycle"; taskIds: readonly TaskId[] };

export interface ImportDocument {
  format: "csv" | "json";
  tasks: Task[];
  links: Link[];
  resources: Resource[];
  assignments: Assignment[];
  headers?: readonly string[];   // CSV only: the header row, verbatim
  mapping?: CsvMapping;          // CSV only: the mapping the parse used
  issues: ImportIssue[];         // parse-time issues
}

export type ImportChange =
  | { kind: "add"; task: Task }
  | { kind: "update"; id: TaskId; before: Partial<Task>; after: Partial<Task> }
  | { kind: "remove"; id: TaskId };

export interface ImportApplyResult { added: number; updated: number; removed: number }
export type ImportApplyCause = "api" | "dialog";

export interface ImportOptions {
  /** Store tasks the document does not mention become removes. Default false. */
  removeMissing?: boolean;
  /** Keeps only the changes it returns true for (non-dialog apply path). A throw excludes the
   *  change (fail-safe) and is reported once via `core/pluginError`. */
  filter?: (change: ImportChange) => boolean;
  /** Parse + validate + diff only; nothing applies; `applied` is absent from the result. */
  dryRun?: boolean;
  /** Opens the interactive import dialog (§1.6) instead of applying directly; `applied` is
   *  absent (the dialog's apply is reported via `importexport/applied`, cause "dialog").
   *  `dialog: true` overrides `dryRun`. Default false. */
  dialog?: boolean;
}

export interface CsvImportOptions extends ImportOptions {
  /** Column mapping override; omitted, the mapping is inferred from the header row (§1.4). */
  mapping?: CsvMapping;
}
export type JsonImportOptions = ImportOptions;

export interface ImportResult {
  document: ImportDocument;
  /** Parse-time and cross-record validation issues combined, advisory (never blocking). */
  issues: readonly ImportIssue[];
  /** The computed diff (post-`filter` on the direct apply path). */
  changes: readonly ImportChange[];
  /** Present only on the direct apply path (no `dryRun`, no `dialog`); counts changes that
   *  actually applied. */
  applied?: ImportApplyResult;
}

export type MsProjectIssue =
  | { code: "invalid-xml"; reason: string }
  | { code: "invalid-task"; uid: string; reason: string }
  | { code: "bad-date"; field: "start" | "end"; value: string; uid: string }
  | { code: "unknown-link-end"; predecessorUid: string; successorUid: string }
  | { code: "unknown-parent"; taskId: TaskId; wbs: string };

/** One imported baseline generation: every task snapshot MSP stored under one baseline number. */
export interface MsProjectBaseline {
  number: number;   // MSPDI baseline number 0..10 (0 = MS Project's primary baseline)
  name: string;     // "Baseline" for 0, "Baseline <n>" otherwise (MS Project's own naming)
  tasks: { id: TaskId; start: number; end: number; type?: Task["type"] }[];
}

export interface MsProjectDocument {
  tasks: Task[];
  links: Link[];
  resources: Resource[];
  assignments: Assignment[];
  baselines: MsProjectBaseline[];
  issues: MsProjectIssue[];
}

export interface MsProjectExportOptions {
  /** Project name written as `<Name>`/`<Title>`. Omitted by default. */
  projectName?: string;
  /** Whether saved baselines of a composed `stargantt.baselines` service embed as per-task
   *  `<Baseline>` elements. Default true; without the tracking plugin nothing is written. */
  baselines?: boolean;
}

export interface MsProjectApplyResult {
  tasksAdded: number;
  tasksUpdated: number;
  linksAdded: number;
  resourcesAdded: number;
  assignmentsSet: number;
}

export interface MsProjectImportOptions {
  /** Parse only; nothing applies; `applied` is absent from the result. Default false. */
  dryRun?: boolean;
}

export interface MsProjectImportResult {
  document: MsProjectDocument;
  /** `document.baselines` reshaped as tracking `baselines` config entries — a pure reshape,
   *  computed on every call (§1.7). Structural content:
   *  `{ id: "msp-baseline-<number>"; name; tasks: { id; start; end; type? }[] }` per baseline. */
  baselineInits: readonly BaselineInit[];
  applied?: MsProjectApplyResult;  // absent on dryRun
}

export interface XlsxExportOptions {
  sheetName?: string;                 // default: the excel nest's sheetName (default "Tasks")
  columns?: readonly TaskCsvField[];  // default: all seven fields, in TaskCsvField order
}

export type ReadOnlyCause = "config" | "api";
export type SnapshotSource = "api" | "url";

export interface SnapshotOptions {
  /** Omitted/false: the bare token. `true`: the token attached to the current `location.href`
   *  as the configured fragment parameter. A string: attached to that base URL instead. */
  url?: boolean | string;
}

export interface ExportService {
  // --- image capture (§1.1) ---
  toPng(options?: RasterOptions): Promise<Blob>;
  toSvg(options?: ImageCaptureConfig): Promise<string>;   // pixelRatio is ignored (vector)

  // --- print (§1.2, §1.3) ---
  toPdf(options?: PrintOptions): Promise<Blob>;
  /** The number of pages the current data would produce, without rendering anything. */
  pageCount(options?: PrintOptions): number;
  /** Opens (or, called while open, replaces) the print-preview overlay; `false` closes it.
   *  Returns whether a preview is open after the call; opening returns false — and mounts
   *  nothing — when the pages cannot be produced in this environment. */
  printPreview(options?: PrintOptions | false): boolean;

  // --- generic formats (§1.4–§1.6) ---
  exportCsv(options?: CsvExportOptions): string;
  exportJson(): string;
  exportICal(options?: ICalExportOptions): string;
  importCsv(text: string, options?: CsvImportOptions): ImportResult;
  importJson(text: string, options?: JsonImportOptions): ImportResult;

  // --- MS Project (§1.7) ---
  toMsProjectXml(options?: MsProjectExportOptions): string;
  applyMsProjectXml(text: string, options?: MsProjectImportOptions): MsProjectImportResult;

  // --- Excel (§1.8) ---
  toXlsx(options?: XlsxExportOptions): ArrayBuffer;

  // --- snapshots + read-only viewing (§2) ---
  snapshot(options?: SnapshotOptions): string;
  /** Restores from a token, from a URL carrying the configured parameter, or (omitted) from
   *  the current `location.href`. Returns whether a snapshot was applied. */
  applySnapshot(source?: string): boolean;
  isReadOnly(): boolean;
  setReadOnly(on: boolean): void;
}

declare module "@stargantt/core" {
  interface Services {
    "stargantt.export": ExportService;
  }
  interface ExtensionPoints {
    "export/auxiliarySurfaces": ExtensionPointDecl<
      AuxiliarySurfaceContribution,
      AuxiliarySurfaceContribution[]
    >;  // collect
  }
  interface Events {
    "importexport/applied": { result: ImportApplyResult; cause: ImportApplyCause };
    "msprojectio/applied": { result: MsProjectApplyResult };
    "viewerembed/readOnlyChanged": { readOnly: boolean; cause: ReadOnlyCause };
    "viewerembed/snapshotApplied": { source: SnapshotSource; droppedTasks: number };
  }
}

export declare function exportPlugin(config?: ExportConfig): Plugin<void>;
```

Member count: 17. Design notes:

- **`pageCount`** is the only render-free page-count query — a host showing "N pages" before exporting has no other path.
- **`isReadOnly` / `setReadOnly`** — the `viewerembed/readOnlyChanged` event's `cause: "api"` exists because this runtime toggle exists.
- **One member per capability**: JPEG encoding rides `toPng({ format: "jpeg" })`; the preview closes via `printPreview(false)`; parse-only and dialog flows ride `importCsv` / `importJson` options and results (§1.5, §1.6) and `applyMsProjectXml`'s `dryRun` (§1.7); token/URL handling rides `snapshot` / `applySnapshot` (§2.2); saving rides `downloadFile` (§1.9).
- **Deliberately absent** (an accepted surface narrowing): no member takes or returns a free-standing document or change list for later application — no standalone mapping-inference, validate, diff, or apply members. Host-programmatic use cases are served by the public data commands (command → reversible patch, undo included), and the parse → `dryRun` → `filter` pipeline covers the inspect-then-apply flows. What is deliberately unsupported: applying a caller-constructed or caller-edited document/change list through this plugin.
- **`ImportOptions.filter`** is a subtractive selector over the computed diff — it can exclude changes, never reorder, mutate, or construct them. It is the sanctioned subset-apply capability under the narrowing above.
- **Per-call options on the image path** — each call's options are a per-key shallow override of the `image` nest; `range` is one member.

**Option resolution (all methods).** Effective options are a per-key shallow override of the matching config nest by the call's options. Each key is validated independently; an unusable value (wrong type, non-finite number, unknown literal) is silently ignored and the default used — with two clamp exceptions on the print path: `scale` clamps to 10–400, and print `pixelRatio` clamps to at most 4; oversized-but-finite values are capped rather than reset. Host-supplied callbacks (`PrintText` builders, `ImportOptions.filter`) are foreign code: a throw is contained per call, reported once via `core/pluginError` with this plugin's id, and the documented fail-safe fallback applies (empty string for a page text; exclusion for a filter).

### 1.1 Image capture — `toPng` / `toSvg`

- **`background`** — omitted: nothing is painted before the layers, so wherever no layer paints the PNG is transparent and the SVG has no backdrop rectangle. Given: the offscreen canvas is filled with that color across the exported area before the layers composite (the SVG gains the equivalent full-area backdrop rectangle as its first element). The color is passed through unchanged — no parsing or validation; an unparsable color paints nothing.
- **`pixelRatio`** — omitted: recovered from the view plugin's layer canvases (the largest `canvas.width / cssWidth` among them, fallback 1), i.e. the device ratio the chart is currently drawn at. Given: replaces the recovered value; the offscreen canvas is sized `round(cssSize × pixelRatio)`. Unusable values are ignored. Raster-only; `toSvg` output is resolution-independent.
- **`format: "jpeg"`** — identical coverage, resolution, and composition to PNG; only the encoder differs. JPEG has no alpha channel, so with `background` omitted the exported area is filled opaque white (`#fff`) first; a configured `background` is used instead, unparsed as above. `quality` (0..1) is forwarded to the canvas encoder; unusable values leave the encoder default. An encoding failure rejects with an error naming the format (both encoders).
- **`range`** —
  - Omitted / `"viewport"`: exactly the currently visible viewport (time and rows).
  - `"full"`: earliest `start` to latest `end` over the store's dated tasks (`stargantt.data`). No dated task: silently degrades to `"viewport"`. A zero-width extent (milestone-only schedule) is valid, floored at one content pixel — not a degradation trigger.
  - `{ start, end }`: an explicit epoch-ms span, exported as given. An inverted span is normalized (swapped and exported left-to-right, identical to the right-way-round export). A **degenerate explicit span** — bounds not both finite, or mapping to under one pixel at export resolution — makes `toPng` / `toSvg` **reject** with an error naming the offending values: a caller error, never a silent viewport fallback. Environment conditions (no dated task for `"full"`, unreachable rows service) keep degrading silently.
  - **Row coverage**: `"viewport"` exports the visible rows; `"full"` and the object form export **every row**, tiling vertically too. All-rows coverage reads `RowsService.totalHeight()` (`stargantt.rows`, optional); with the service absent or `totalHeight()` not a finite positive number, the export degrades to the visible rows while still honoring the requested time span.
  - `stargantt.timeline` is co-provided by the hard `view` dependency, so the t↔x mapping always exists — no degradation branch is needed for it.
- **Tiled composition** — whatever the range, the exported area is walked tile-by-tile through `ViewService.renderTo` virtual viewports into offscreen canvases: nothing on-screen scrolls or repaints during an export, layer `draw` code runs unchanged, and spans beyond the scrollable content render correctly instead of clamping. The tile size is an internal constant, not public API.
- **True-vector SVG** — `toSvg` drives `renderTo` with a `CanvasRenderingContext2D`-compatible recording proxy implementing the subset the official layers use (rects, paths, lines, text, transforms, basic state) and emits SVG elements from the recording. Detection is per layer: a layer calling an API outside the recorded subset is rasterized alone and embedded as an image; every other layer stays vector — third-party layers degrade gracefully. Two grains of fallback: drawing recorded **outside** every layer's save/restore block ("loose" output) that is unusable in any tile forces the **whole composite** of every tile to raster — no per-layer split is possible then; otherwise the per-layer decision is taken across **all** tiles, a layer staying vector only when its block is usable in every tile, since one export never mixes a vector transcription of a layer in one tile with a raster replay of it in the next. A full Canvas2D proxy (gradients, patterns, clipping, filters) remains out of scope.
- **Auxiliary surfaces** — a dedicated pass collects `export/auxiliarySurfaces` (§4) and invokes each contribution's `drawTile` (raster) or `drawTileSVG` (SVG, falling back to rasterized `drawTile`) tile by tile over the exported span, at the same resolution ratio as the layers, banded above/below them per `side`.
- **Coverage rule** — an exported image is the view plugin's canvas layers plus the auxiliary surfaces, and nothing else. The DOM tree-grid pane is **by design absent** from every image export (no DOM rasterization): an export showing timeline and bars but no grid columns is correct, not lossy by accident. Grid data reaches paper through the print path's task-column table (§1.3) and the data formats.

### 1.2 Print pagination — `toPdf` / `pageCount` / `printPreview`

- Pixels are CSS px at 96 dpi; paper sizes are A4 210×297 mm, A3 297×420 mm, Letter 215.9×279.4 mm.
- The printable area is the page minus margins, minus the bands present: header band (18 px, only when at least one header text is non-empty), date band (24 px, present when the exported time span resolved **both** bounds — dated tasks or a fully explicit `range`; the t↔x mapping alone, though always available, is not enough — **or** when at least one table column is configured, since the table header row shares this band), legend band (20 px, when entries exist), footer band (18 px, when any footer text is non-empty).
- The chart region is the printable area minus the table width (built-in column widths: name 160 px, start/end 76 px, progress 56 px). Chart content draws at `scale/100`; page breaks fall every `chartRegionWidth / (scale/100)` content px along time and every `chartRegionHeight / (scale/100)` along rows, starting at the range's edges. Page order is time-major within a row band.
- The time range is `range` with each missing bound from the store's task extent; the row span is `rows.from`–`to`, clamped to the rows service and swapped when inverted, resolved through `RowsService.yOf` / `rowHeight`.
- **Silent degradations** (environment, not caller error): no dated task and no fully explicit `range` → a single page of the current viewport's time window, with no date-band labels (the span is unresolved, so the band appears only via the table-column condition above); no reachable `stargantt.rows` → the current viewport's rows as one row band.

### 1.3 Page composition, PDF, and preview

- Each page composes onto one canvas: white background; header texts; the date band (unit boundaries from `TimelineService.unitBoundaries`, day/week/month/year picked from the exported span, labelled via `Intl.DateTimeFormat` with the chart locale); the table (headers from the catalog, one row per task row in the band; name verbatim, dates `Intl`-formatted UTC, progress as a percentage — the table is drawn by this plugin, never captured from the grid DOM); the chart slice via one `renderTo` virtual-viewport call; the legend band; footer texts. Auto-generated legend entries are Task / Summary / Milestone (theme-neutral fixed swatches) plus Critical path when `criticalPathOnly` is active and the service present.
- **Light-scheme pin** — page chrome is always drawn for a light page, so for the duration of a `toPdf` or `printPreview` rendering the chart's color scheme is pinned to `"light"` through `ThemeService.setColorScheme`, restoring the prior scheme (pinned or `"auto"`) immediately afterward. `pageCount` only plans — it renders nothing and pins nothing. The theme service is co-provided by the hard `view` dependency, so the pin always happens on the two rendering calls.
- **Critical-path emphasis** — with `criticalPathOnly: true` and `stargantt.critical-path` composed, each printed row whose task carries no criticality classification is overlaid with a 75 % white veil across the chart region — an emphasis layout, not a row filter. Without the service the option is silently ignored. (The consumed surface is the per-task criticality query — `criticalityOf(id) === undefined` means unclassified; scheduling.md fixes the exact member and governs on divergence.)
- **PDF output** — `toPdf` produces a self-contained PDF 1.4 `application/pdf` Blob written by this plugin (zero dependencies). Each page is one lossless full-page raster at `pixelRatio`: `getImageData` pixels embedded as a `/Filter /FlateDecode` image XObject with the PNG "None" row filter and predictor (`/DecodeParms << /Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns w >>`), the DEFLATE layer using stored blocks inside a correctly framed zlib stream — no lossy step ever touches the output. MediaBoxes are the paper size in points. The promise rejects when the environment yields no 2D context or refuses pixel readback. Size caveat: stored-block Flate makes an A4 page at `pixelRatio: 2` about 10.2 MiB (≈ 794 × 1123 CSS px → 1588 × 2246 image px × 3 bytes), all pages held in memory during assembly — hosts keep `pixelRatio` and range modest for multi-page exports, or use the browser print path. Emitting compressed DEFLATE remains a tracked deferral, not an accepted permanent cost. Accessibility scope: the PDF is raster-per-page (no extractable text, no tagging); hosts with PDF accessibility obligations route users to the preview's browser-print path, which prints the browser's own accessible rendering.
- **Print preview** — `printPreview(options?)` mounts a modal overlay via `sdk/dialog`'s `createDialog` (host = `ViewService.chartPaneElement()`, `modal: true`, `className: "sg-print-preview"`, label = `messages.previewTitle`), showing every page scaled to fit with Print and Close buttons (≥ 24×24 px hit areas). The dialog foundation supplies: `role="dialog"` / `aria-modal`, Tab cycling confined to the overlay, Escape/close/disposal teardown, and focus return to the previously focused element (chart pane fallback). Two stylesheets serve printing: a **static print stylesheet** installed for the preview's lifetime (page layout under `@media print`, plus neutralizing ancestor `overflow` so the fixed overlay paginates across full pages instead of clipping to an ancestor's scroll box), and a **hide-everything-else stylesheet** installed only around the actual print — added by the Print button and on `beforeprint`, removed on `afterprint`, with a timed fallback removal for hosts that never fire it. Stylesheets and overlay are owned via `ctx.own()`. Calling while open replaces the preview; `printPreview(false)` closes it.

### 1.4 CSV — `exportCsv` / the CSV side of `importCsv`

**Export.** One header row of field names, then one row per task in store insertion order, CRLF-joined with a trailing CRLF. Cells containing the delimiter, a quote, or a line break are quoted with doubled quotes (RFC 4180). Dates are ISO 8601 UTC date-times (`Date.toISOString()`; an instant outside `Date`'s representable ±8.64e15 ms range is written as the raw number in text instead — export returns a string, never throws); `progress` is the 0..1 fraction or empty; a root's `parentId` is empty; an absent `type` is empty. `columns` selects and orders the fields; an unusable `columns` falls back to all seven. `bom: true` prefixes U+FEFF. `delimiter` is any single character; anything else falls back to the nest's `csvDelimiter`.

**Import parsing** (inside `importCsv`). The first row is always the header row. The mapping — one `TaskCsvField` or `null` per column — comes from `options.mapping` when usable (unusable entries become `null`), else from header inference: headers lowercased, stripped of non-alphanumerics, matched against the alias table (each field is claimed at most once; a later column matching an already-claimed field maps to `null`):

| Field | Header aliases (after normalization) |
|---|---|
| `id` | `id`, `taskid`, `uid`, `key` |
| `parentId` | `parent`, `parentid`, `parenttask` |
| `name` | `name`, `title`, `task`, `taskname`, `text`, `summary` |
| `start` | `start`, `startdate`, `begin`, `begindate`, `from` |
| `end` | `end`, `enddate`, `finish`, `finishdate`, `due`, `duedate`, `to` |
| `progress` | `progress`, `percentcomplete`, `complete`, `done` |
| `type` | `type`, `tasktype`, `kind` |

Cell parsing: dates accept bare-integer epoch ms; an ISO-like calendar date — 4-digit year with 1–2-digit month and day, joined by `-` or `/` (`2026-08-19`, `2026/8/9`, …) — read as UTC midnight via `Date.UTC` (the store's UTC-fixed semantics); and, failing both, `Date.parse` text. Progress: a `%` suffix always reads as a percentage regardless of magnitude; a bare number above 1 reads as a percentage; a bare number in 0..1 is the fraction itself (bare `1` is the fraction 1.0, not 1 %); negative values and values above 1 **after** conversion (`150%`, `150`) are rejected as unusable — not clamped. **Bare-integer date window**: `0` and any value from one day (`86_400_000`) through `2200-12-31T23:59:59.999Z` are accepted as epoch ms; a positive value under one day is rejected as `bad-date` — that band is where spreadsheet date serials land when mis-exported as raw numbers, and reading them as milliseconds would silently produce nonsense instants. The same date-cell parser serves JSON *string*-typed dates; a genuine JSON number is taken as-is.

Tolerance: a row missing a usable `name`, `start`, or `end`, with `end < start`, or repeating a seen id keeps the earlier data and yields one issue (`missing-field` / `bad-date` / `invalid-row` / `duplicate-id`) carrying the 1-based data-row number; good rows survive. A file without an id column mints `import-<row>` ids (making every row an `add`). An empty or unknown `type` cell leaves the field unset. A non-string `text` argument yields an empty document.

### 1.5 JSON, validation, diff, apply — `exportJson` / `importJson` / the shared import pipeline

**Export.** The StarGantt project schema: `DataService.toJSON()`'s five lists under a `schema: "stargantt/v1"` tag, pretty-printed two-space — the whole project, round-trippable through `importJson` to an empty diff.

**Import parsing** (inside `importJson`). Accepts, in recognition order: a bare task array; an object with a `tasks` array (the own schema included — the tag is informative; the import does not depend on it); an object with a **non-empty** `data.tasks` (an empty `data.tasks` is too weak a signal to read the value as a document — while an empty top-level array or an empty `tasks` property is accepted). Task keys match leniently (`id`/`uid`/`key`; `name`/`title`/`text`/`summary`; `start`/`startDate`/`start_date`/`begin`; `end`/`endDate`/`end_date`/`finish`/`due`; `parentId`/`parent`/`parent_id`; `progress`/`percentComplete`/`percent_complete`; `type`; `meta`), with §1.4's date/progress cell rules. `links` (`sourceId`/`source`/`from`, `targetId`/`target`/`to`, type defaulting `"FS"`), `resources`, and `assignments` normalize when present; unusable entries are skipped silently. Malformed JSON, or JSON with no recognizable task array, yields one `invalid-json` issue and an otherwise empty document. Parsed links/resources/assignments ride in the document for validation and host code; **apply is tasks-only** for the generic formats (a documented limitation — the MSPDI path applies all entity kinds, §1.7).

**iCal.** `exportICal` writes an RFC 5545 `VCALENDAR` (VERSION 2.0, PRODID `-//StarGantt//StarGantt//EN`; optional `X-WR-CALNAME` from `calendarName`) with one `VEVENT` per task: `UID` `<taskId>@stargantt`, `DTSTAMP` (export time), `DTSTART`/`DTEND` as UTC date-times in the basic `YYYYMMDDTHHMMSSZ` format, `SUMMARY` (the task name, TEXT-escaped), and `X-STARGANTT-PERCENT-COMPLETE` when the task has finite progress — the RFC-conformant vendor-extension form, since RFC 5545 reserves `PERCENT-COMPLETE` for `VTODO`. `Task.end` is exclusive exactly as `DTEND` is, so both bounds are written verbatim. A milestone gets `DTSTART` only (an instant); a summary task is skipped unless `includeSummaryTasks: true`. Lines are CRLF-terminated and folded under the 75-octet limit with space-prefixed continuations. iCal is export-only: no import path exists (a future importer would be expected to accept both the vendor property and bare `PERCENT-COMPLETE`, a note for that work, not a behavior here).

**Pipeline.** Both import methods run parse → validate → diff, then branch on options: default = apply directly (cause `"api"`); `dryRun` = stop before apply; `dialog` = open the interactive dialog (§1.6). Parsing and diffing never touch the store; only apply dispatches.

- **Validation** (advisory, never blocking; merged into `ImportResult.issues` after the parse issues): a `parentId` naming neither a document nor a store task (`unknown-parent`); a parent cycle among document tasks (`parent-cycle`, one per cycle); a link end naming an unknown task (`unknown-link-end`); a dependency cycle over the **union** of document links and existing store links (`dependency-cycle`, carrying the cycle's ids).
- **Diff.** Each document task against the store: unknown id → `add`; known id with differing fields → `update` carrying only changed fields in `before`/`after` (`name`, `start`, `end` always compared; `parentId` compared **only when the document states parent linkage** — a JSON document always does, a CSV document only when its mapping includes a `parentId` column, because a CSV parse normalizes every row to `parentId: null`, and with the column mapped out that `null` means "not stated" — comparing it would propose re-parenting the whole hierarchy to the root; `progress` and `type` only when the incoming task states them — an absent optional field means "not stated", never "clear it"); identical → nothing. With `removeMissing: true` (default false — an import never deletes unless asked), each unmentioned store task adds a `remove`. Order: adds parents-first, then updates, then removes; apply runs in that order. `filter` then drops the changes it rejects (direct path only).
- **Apply — one call, one history entry.** Changes are built from the store's public commands, each stamped `origin: "import"`: one `task/add` per add, one `task/update` per update, one `task/remove` carrying all removed ids (the store cascades subtrees, links, assignments). The batch commits as **one** transaction via the harvest-and-cancel mechanism over the retained `data/willApplyTransaction` hook: every command is first dispatched with `preventDefault()` called immediately, its runner-built patch list harvested against the still-untouched pre-import state; the first command with a non-empty harvest then dispatches for real as the driver, and the handler appends every other harvested patch list to its transaction before it applies. The handler acts only on `origin: "import"` transactions, so foreign transactions inside the window pass through untouched. Compensations: sibling `orderKey`s are pre-assigned by chaining the store's exported `midKey` from the parent's current last sibling key (two same-parent adds harvested against the same sibling list would otherwise mint equal keys); store-minted ids are captured from the harvest and copied back onto the add's payload before the driver dispatch; an `update` naming a same-batch add merges into that add, and a `remove` naming one drops the add together with every batch add transitively parented under it (netting to nothing in the counts). An apply whose harvests are all empty (including the zero-change case) selects no driver and commits no transaction — the canceled harvest dispatches are the only dispatches that occur, and no store notification and no history entry results. `applied` counts changes that actually applied — not requests, not cascade effects. After a non-empty apply, one `importexport/applied` event carries `{ result, cause }`. Undoing the import restores the whole pre-import state in one step. (The simpler head-plus-precomputed-tail case is what `sdk/aggregate`'s `createTransactionBatcher` covers; this pipeline needs the runners themselves to compute the patches, so the harvest step remains this plugin's own — same hook, same origin-keyed discipline.)
- **Read-only interplay** (normative): while read-only (§2.1) is active, the import driver transaction is vetoed at the same choke point as any other non-exempt mutation — `importCsv` / `importJson` / `applyMsProjectXml` apply nothing, report all-zero counts, and emit no applied event.

### 1.6 The import dialog

Opened by `importCsv` / `importJson` with `dialog: true` (replacing any open one; at most one exists). Mounted via `sdk/dialog`'s `createDialog` — host = `ViewService.chartPaneElement()`, `modal: true`, `className: "sg-ie-dialog"`, label = `messages.dialogTitle` — which supplies the focus contract (focused on open; Tab confined; Escape/close/disposal teardown with focus return to the prior element, chart-pane fallback). The dialog chrome (title band, close control) comes from the `sdk/dialog` foundation — there are no `sg-ie-title` / `sg-ie-footer` elements of the dialog's own; the footer's buttons carry the `sg-ie-cancel` / `sg-ie-apply` class names. Text inside the dialog panel is styled with the **dialog token family** (`--sg-dialog-*`, the same family the panel background uses — chart theme tokens like `--sg-muted-fg` follow the chart's color scheme while the dialog panel does not, which would break contrast in dark scheme); the bundled stylesheet gains no rule for it. The dialog root is owned at `setup()` (one disposable removes whichever dialog is current). The chart pane always exists (hard `view` dependency); unusable text simply produces an empty-document dialog showing `messages.noChanges`.

- **Column mapping** (CSV sources only): one row per header (`sg-ie-mapping-row`), each a native `<select>` (`sg-ie-mapping-select`, `aria-label` = the header text, min-height 24 px) listing `messages.ignoreColumn` plus the seven fields via `messages.fieldLabel`. Changing a select re-parses under the new mapping, re-validates, re-diffs, and rebuilds issues and preview in the same event turn.
- **Issue list**: heading `sg-ie-issues-heading` (`messages.issuesHeading(count)`) over `<ul class="sg-ie-issues">` of `messages.issueText(issue)` lines, parse and validation issues combined; absent when none.
- **Preview**: heading `sg-ie-preview-heading`, then one `<label class="sg-ie-change">` per change (`data-kind` = kind) with a native checkbox, the kind tag (`messages.changeAdd` / `changeUpdate` / `changeRemove`), and the task name (id for removes). Adds and updates pre-checked; **removes unchecked by default** — deleting is a deliberate choice. `messages.noChanges` replaces an empty preview.
- **Footer**: cancel (`sg-ie-cancel`) and apply (`sg-ie-apply`, text `messages.applyButton(checkedCount)`, disabled at zero). Apply dispatches the checked changes through §1.5's batch (cause `"dialog"`) and closes; Escape and Cancel close with nothing applied. All controls are native elements (keyboard-operable, browser focus indicators, ≥ 24 px targets). The dialog assumes the project's ≥ 720×540 viewport; no responsive collapse.

### 1.7 MS Project — `toMsProjectXml` / `applyMsProjectXml`

The parser is a small self-contained XML reader (no `DOMParser`, no dependency): element tree with namespace prefixes stripped, the five named entities and numeric entities decoded, comments/CDATA/PIs handled, attributes ignored (MSPDI is element-based). A non-string argument, malformed XML, or a root other than `Project` yields an otherwise-empty document with one `invalid-xml` issue. Parsing never touches store or DOM.

**Import mapping — tasks** (one store `Task` per `<Tasks><Task>`):

| MSPDI | Store field | Rule |
|---|---|---|
| `<UID>` | `id` | text verbatim (a string). Missing/duplicate → skipped, one `invalid-task` issue. `<UID>0</UID>` (the hidden project-summary task) and `<IsNull>1</IsNull>` skipped silently. |
| `<Name>` | `name` | missing/blank → `Task <uid>` |
| `<Start>` / `<Finish>` | `start` / `end` | UTC wall-clock: `YYYY-MM-DDTHH:MM:SS`, optionally a fraction and/or literal `Z`, nothing else — an explicit zone offset (`+05:00` etc.) is a `bad-date`, never silently misread. Values map verbatim (no exclusive-end adjustment). Unparsable/missing → `bad-date`, task skipped; `end < start` clamps to `end = start`. |
| `<PercentComplete>` | `progress` | 0..100 → 0..1 fraction; non-finite leaves unset |
| `<Summary>` / `<Milestone>` | `type` | `1` → `"summary"`, else `1` → `"milestone"`, else unset |
| `<OutlineNumber>` / `<WBS>` / `<OutlineLevel>` | `parentId` | dotted code first: parent = the previously-parsed task whose code is the code minus its last segment (single segment = root; unmatched parent code → one `unknown-parent` issue, falls through). Otherwise the outline-level stack: under the most recent task whose level is exactly one less (level ≤ 1 / unusable / no ancestor → root). Document order kept within a parent. |

**Import mapping — links, resources, assignments, baselines:**

| MSPDI | Result | Rule |
|---|---|---|
| `<PredecessorLink>` (per successor task) | one `Link` | `<PredecessorUID>` = source, containing task = target; `<Type>` 0→`FF`, 1→`FS`, 2→`SF`, 3→`SS` (else `FS`); `<LinkLag>` in tenths of minutes → `lag` ms (×6000), zero/absent unset; ids minted `mspl-<n>` in encounter order; an unknown end → `unknown-link-end`, no link |
| `<Resources><Resource>` | one `Resource` | needs non-empty `<UID>` and `<Name>`; `<UID>0</UID>` ("Unassigned") and nameless skipped silently; `<MaxUnits>` (fraction, 1 = full-time) → `capacity` when finite positive |
| `<Assignments><Assignment>` | one `Assignment` | `<TaskUID>` / `<ResourceUID>` naming parsed entities; others skipped silently; `<Units>` → `units` when finite positive, else 1 (an omitted `<Units>` behaves as stated) |
| per-task `<Baseline>` | grouped `MsProjectBaseline` | `<Number>` (0..10, default 0), `<Start>`, `<Finish>`; grouped by number, ordered by number; snapshot `type` = the owning task's type; unparsable dates skipped silently |

**Apply** (skipped under `dryRun`). Tasks parents-first — the order that satisfies "parent already added", independent of source document order, so hand-built MSPDI with children listed first still applies correctly: unknown id → `task/add` (with `parentId` pointing at the already-added parent); known id → `task/update` with changed fields (`progress`/`type` only when stated — absent ≠ clear); identical → nothing. Then `resource/add` for unknown resources, `link/add` for links whose ends exist and whose id is new, `assignment/set` for each assignment — all stamped `origin: "msproject"`. **Nothing is ever removed** — an MSP import adds and updates only. Each command is one ordinary undoable transaction (a per-command grain — unlike §1.5's single-entry batch). A `document` with unusable lists contributes nothing for those parts; `applied` reports what actually dispatched. After a non-zero apply, one `msprojectio/applied` event carries the result. Imported baselines are **not applied**: the tracking service snapshots only the current schedule, so the host feeds `result.baselineInits` to the tracking plugin's `baselines` config at composition time; `baselineInits` maps each baseline to `{ id: "msp-baseline-<number>", name, tasks }`.

**Export.** `toMsProjectXml` writes an XML declaration and `<Project xmlns="http://schemas.microsoft.com/project">` holding `<Name>`/`<Title>` (when `projectName` is non-blank), `<Tasks>`, `<Resources>`, `<Assignments>`. Tasks depth-first in store tree order with sequential integer `<UID>`/`<ID>` from 1, `<Name>`, `<OutlineNumber>` and `<WBS>` (dotted codes derived from the tree), `<OutlineLevel>`, `<Start>`/`<Finish>` as `YYYY-MM-DDTHH:MM:SS` UTC, `<Milestone>`/`<Summary>` flags, `<PercentComplete>` (rounded 0..100, only with finite progress), each incoming link as `<PredecessorLink>` (`<PredecessorUID>`, `<Type>` by the inverse map, `<LinkLag>` in tenths of minutes when lagged), and — with `baselines` not `false` and `stargantt.baselines` composed — per-task `<Baseline>` elements for every saved baseline in `list()` order (at most 11, numbered 0.. in that order; baseline names are not representable in MSPDI and drop). Resources get `<UID>`/`<ID>` from 1, `<Name>`, `<MaxUnits>` (when `capacity` is stated); assignments get `<UID>`, `<TaskUID>`, `<ResourceUID>`, `<Units>`; assignments whose endpoints were not written are skipped. Store ids are not representable and are replaced by minted UIDs — a round-trip preserves structure and dates, not ids. Text is XML-escaped; lines LF-joined, two-space indented.

### 1.8 Excel — `toXlsx`

Returns a complete `.xlsx` workbook as an `ArrayBuffer`: a minimal valid OOXML package (`[Content_Types].xml`, `_rels/.rels`, `xl/workbook.xml`, `xl/_rels/workbook.xml.rels`, `xl/worksheets/sheet1.xml`) ZIP-packed with the **stored** method, UTF-8 entry names, correct CRC-32s — the plugin's own container codec, zero dependencies. The worksheet holds one header row of field names, then one row per task in store insertion order — the same rows, order, and cell text as `exportCsv` (§1.4; the shared cell-text builder). Every cell is an inline string (`t="inlineStr"`, XML-escaped): no shared-string table, no styles, no number formats; ZIP entry timestamps are not the current time but the fixed DOS epoch, 1980-01-01 00:00:00 (DOS date/time has no "unset" sentinel readers treat as valid) — so identical store state produces byte-identical output. Inline-string cells are never interpreted as formulas by spreadsheet applications, so the CSV-formula-injection class of risk does not apply to this output (a byproduct of the self-containment decision, not an escaping step). `sheetName` is sanitized to Excel's rules — the characters `\ / ? * [ ] :` removed, the result trimmed and truncated to 31 characters, then leading/trailing apostrophes stripped and re-trimmed (truncation can expose one); a result equal to `history` case-insensitively (an Excel-reserved sheet name) becomes `Sheet1` — a replacement, bypassing the nest default; a value sanitizing to empty is unusable and the nest default applies. Sanitization keeps every value producing an openable file; duplicate-name checks are out of scope (one sheet is written). Export-only: there is no xlsx import.

### 1.9 Saving to a file

The facade returns bytes and strings; saving is the host's one-liner through the SDK's public `downloadFile` (`sdk/dom`) — the one object-URL/`<a download>`/revoke incantation. There are deliberately no `download*` facade members; the conventional file names and media types are recorded here as the documentation convention: `gantt.png` `image/png`, `gantt.jpg` `image/jpeg`, `gantt.svg` `image/svg+xml`, `tasks.csv` `text/csv`, `project.json` `application/json`, `tasks.ics` `text/calendar`, `project.xml` `application/xml`, `tasks.xlsx` `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`. `downloadFile` in an environment without `URL.createObjectURL` is a silent no-op.

## 2. Read-only viewing, embed mode, snapshots

### 2.1 Read-only mode — `isReadOnly` / `setReadOnly`

The mechanism is the store's own cancelable pre-event: one `data/willApplyTransaction` subscription taken at `setup()`, and, while read-only is active, `preventDefault()` on every transaction **except** those whose `origin` identifies an official data-layer flow. The built-in exemption is the machine-origin prefix rule (data-sync.md): transactions whose `origin` is a string beginning with `"stargantt.data-sync/"` are exempt; always active, never narrowable. `viewerEmbed.readOnlyExemptOrigins` adds origins on top (non-array ignored; non-string entries dropped per element); the set only grows. Consequences, all deliberate:

- A read-only viewer composed with data-sync keeps receiving machine-originated sync while user edits — and every other plugin's transactions, including scheduling's — stay vetoed at the single choke point all mutations share. No per-plugin disabling; no editing plugin knows this plugin exists.
- `DataService.load()` runs outside the transaction system, so initial data loads and snapshot restores (§2.2) work while read-only — the intended way to feed a viewer.
- Vetoed transactions never reach `data/didApplyTransaction`, so undo-redo records nothing — zero commits, zero steps, trivially consistent.
- In-progress gestures (a drag ghost) still render; their commit dies. A host wanting no edit affordances composes without the editing plugins — read-only is the safety net, not a UI restyler.
- This plugin's own imports are vetoed too (§1.5, read-only interplay).

While active, the chart root carries the class `sg-readonly` (removed when it ends) — a styling hook; the plugin attaches no rule to it. Initial state comes from `viewerEmbed.readOnly` (default `false`; `embed: true` flips the default to `true`, §2.3). The initial state emits nothing — the event reports changes. `setReadOnly(on)` switches at runtime (non-boolean ignored; a no-change call emits nothing); an effective change emits one `viewerembed/readOnlyChanged` with `cause: "api"` (`"config"` stays reserved for a future config-driven runtime source and is not emitted).

### 2.2 Snapshot tokens — `snapshot` / `applySnapshot`

A snapshot is `{ schema: "stargantt/snapshot/v1", data: DataService.toJSON() }`, UTF-8 then base64url encoded (RFC 4648 §5, unpadded). Self-contained: no server, no storage, no id registry — the token is the id. Tokens are not compressed; the practical maximum token length is ~64 KB, beyond which URL delivery is unreliable — no hard cutoff exists and no size flag is returned, so hosts embedding large projects measure `snapshot().length` and fall back to their own delivery above that guidance. The `schema` tag versions the format for a future compressed sibling.

- `snapshot()` returns the bare token (reads only, never mutates). `snapshot({ url: true })` attaches it to the current `location.href` — headless, the result is the bare fragment `#<param>=<token>`; `snapshot({ url: base })` uses the given base verbatim. The token always rides the **fragment** (`#<param>=<token>`, parameter name = `viewerEmbed.snapshotParam`), never the query string; an existing `<param>=…` pair in the base's fragment is replaced, other fragment content preserved with `&` joining.
- `applySnapshot(source?)` accepts three input forms: omitted — the current `location.href` is read; a string carrying `<param>=` in its fragment (or, failing that, its query string) — the parameter's value is the token, `source: "url"`; any other string — treated as the token itself, `source: "api"`. The forms never collide: an unpadded base64url token cannot contain `<param>=`. A valid snapshot replaces the whole store through one `DataService.load()` and returns `true`; per the store contract the restore is **not undoable**, runs outside the transaction system, and works in read-only mode. Any unusable token — not a string, not base64url, not JSON, or JSON without the schema tag — returns `false` and touches nothing (no half-load from arbitrary shared-URL text). A successful apply emits one `viewerembed/snapshotApplied` with `{ source, droppedTasks }`.
- **Trust boundary.** A snapshot URL is exactly as trusted as the page carrying it; the schema tag is a format guard, not authentication. The decode path is bounded: a token whose decoded byte size exceeds 4 MiB (`MAX_DECODED_BYTES`) is unusable — `false`, nothing touched — and decoding allocates one pre-sized buffer from the token's length, so a hostile token on the untrusted-URL path can never force an unbounded allocation. Decoded task entries are still treated as untrusted: minimal per-task validation (`id` a string or number; `start`/`end`, when present, finite numbers) drops failing entries rather than rejecting the token; the other four lists keep the array-only check. The dropped count is report-only on `droppedTasks` (`0` when none).
- `viewerEmbed.autoRestore: true` runs the omitted-argument restore once at `setup()` (after the service is provided) — the piece that makes a "share this link" viewer a zero-code HTML file. Default `false`: a composition that does not ask never reads `location`.

### 2.3 Embed mode

`viewerEmbed.embed: true` dresses the instance for iframe hosting: the chart root gains the class `sg-viewer-embed`; one `<style>` element is appended under the root (owned via `ctx.own()`) whose entire text is scoped to `.sg-viewer-embed` — the root fills its container (`width:100%; height:100%`) and text selection inside it is disabled. Nothing else is styled; no sibling plugin's DOM or class names are touched. Read-only defaults to on under embed; an explicit `readOnly: false` keeps an editable embed — embed only flips the default. Minimal UI is achieved by composing minimally; the ≥ 720×540 viewport constraint applies to embeds like everything else. The embed snapshot machinery is unrelated to data-sync's `storage/snapshot` extension point (specified in data-sync.md §4.3; this plugin neither defines nor uses it).

## 3. Fidelity

What round-trips exactly and what is lossy, per channel:

| Channel | Preserved exactly | Lossy / one-way |
|---|---|---|
| CSV (§1.4) | the seven `TaskCsvField` values per task; re-import of an own export diffs empty | links, resources, assignments, calendars, `meta` (custom fields included), `orderKey` (insertion order only survives) |
| JSON (§1.5) | all five entity lists (`stargantt/v1` schema); re-import diffs empty | apply is tasks-only — links/resources/assignments ride in the document but are not applied; history not carried |
| iCal (§1.5) | per-task `UID` (`<taskId>@stargantt`), `DTSTART`/`DTEND` verbatim (`Task.end` is exclusive exactly as RFC 5545 `DTEND`), `SUMMARY`, `X-STARGANTT-PERCENT-COMPLETE` (the RFC-conformant vendor property — `PERCENT-COMPLETE` is VTODO-only) | export-only (no iCal import); hierarchy, links, resources absent; milestones are `DTSTART`-only instants; summary tasks skipped unless `includeSummaryTasks`; lines CRLF-terminated and folded under 75 octets |
| MSPDI (§1.7) | tree structure (via WBS/outline), dates (UTC, no exclusive-end adjustment), progress, type, links (type + lag), resources (name + capacity), assignments (units), baselines (number + dates) | ids re-minted as sequential UIDs; baseline names dropped; lag rounded to tenth-minutes; calendars, `meta`, custom fields absent |
| xlsx (§1.8) | the same cells as CSV, byte-deterministic per store state | export-only; everything CSV loses, plus no styling/number formats by design |
| Snapshot (§2.2) | the whole project verbatim (all five lists) | restore replaces (not merges) and is not undoable; undo history not carried |
| PNG/JPEG/SVG (§1.1) | canvas layers + auxiliary surfaces at the export's resolution; SVG keeps official layers as true vectors | DOM tree-grid pane absent by design; SVG rasterizes (per layer) anything outside the recorded drawing subset; JPEG flattens transparency |
| PDF (§1.2–§1.3) | each page a lossless raster of the composed page | no extractable/searchable text, no tagging (raster-per-page); chart pinned to the light scheme |

## 4. Extension points

Defines one point; contributes to none.

| Point | Strategy | Contribution type | Result | Rules |
|---|---|---|---|---|
| `export/auxiliarySurfaces` | collect | `AuxiliarySurfaceContribution` | `AuxiliarySurfaceContribution[]` | image capture only (§1.1); print composes its own bands (§1.3) and never consults the point |

`export/auxiliarySurfaces` is how surfaces that are not renderer layers join exported images without any back door: each surface's own plugin contributes an `AuxiliarySurfaceContribution` (types in §1) whose callbacks close over that plugin's private state and configuration — no other plugin ever reads it. The capture pass invokes `drawTile` (raster) or `drawTileSVG` (SVG, falling back to rasterized `drawTile`) tile by tile over the exported span; contributions draw each tile's own time slice but derive span-wide decisions (label thinning and the like) from `rangeStart`/`rangeEnd`, so tiles compose seamlessly. Contributions redraw **from data** through the contributor's own paint routine — never by compositing an on-screen canvas or DOM band, which is only viewport-wide. Surfaces render at the same resolution ratio as the layers; `side` stacks bands above or below the drawing layers in declared order.

**Official contributors (dovetail).** The view plugin contributes the timeline header band (top — `internal/timeline/export-contrib.ts`, view.md). The resource plugin contributes the load-chart bottom surface (redrawing from its aggregation pipeline, custom `load`/`capacity` functions included, with a vector `drawTileSVG` mapping the same redraw to SVG shapes — resource.md §3.6). Lower layers contributing to this Layer-8 point is the sanctioned upward direction (architecture ch. 5); contributors type their contribution via type-only import from `@stargantt/plugin-export` (devDependency) or structurally, and the core buffers contributions made while this plugin is not composed (the `sidepanel/fields` precedent) — so contributors register unconditionally and compositions without the export plugin lose nothing.

**Trust note on `drawTileSVG`.** Its return value is trusted markup, spliced verbatim into the exported SVG — not escaped, not validated. This is not a new boundary (a canvas contribution could already composite any pixels), but for the vector path the "anything" is literal markup that travels to whoever the exported SVG is later shared with; a contribution's own markup bugs travel with it.

## 5. Commands

None owned. Dispatches (all through the public data-store commands, gaining transactions and undo integration for free):

| Dispatched | Origin | From |
|---|---|---|
| `task/add`, `task/update`, `task/remove` | `"import"` | §1.5 apply (batched into one transaction) |
| `task/add`, `task/update`, `link/add`, `resource/add`, `assignment/set` | `"msproject"` | §1.7 apply (one transaction per command) |

## 6. Events

Emits four retained activity notifications (official catalog, architecture ch. 3.2) — payloads in §1's declaration block:

| Event | Payload | When |
|---|---|---|
| `importexport/applied` | `{ result: ImportApplyResult; cause: "api" \| "dialog" }` | once after a non-empty §1.5 apply |
| `msprojectio/applied` | `{ result: MsProjectApplyResult }` | once after a non-zero §1.7 apply |
| `viewerembed/readOnlyChanged` | `{ readOnly: boolean; cause: ReadOnlyCause }` | on effective runtime read-only changes only (never for the initial state) |
| `viewerembed/snapshotApplied` | `{ source: SnapshotSource; droppedTasks: number }` | once per successful snapshot restore |

Subscribes to `data/willApplyTransaction` (the read-only veto and the import batch harvest, §2.1 / §1.5).

**Namespace boundary (normative).** The `importexport/`, `msprojectio/`, and `viewerembed/` namespaces belong to this plugin, and the event names above are fixed by this spec. The data-layer notifications live in data-sync's `sync/*` namespace — none of this plugin's; the one export surface tied to data-sync is the read-only veto's built-in exempt **origin** rule (§2.1), which tracks data-sync's machine-origin prefix.

## 7. Config

Factory: `exportPlugin(config?: ExportConfig)`. All fields optional; unusable values silently fall back; resolved once at `setup()`. Per-call service options override the matching nest per key (§1, option resolution).

```ts
export interface ExportConfig {
  messages?: Partial<ExportMessages>;
  image?: ImageCaptureConfig;
  /** Factory-level print defaults; each PrintOptions call overrides per key. */
  print?: PrintOptions;
  importExport?: {
    /** Field separator for exportCsv and importCsv. Single character; default ",". */
    csvDelimiter?: string;
  };
  excel?: {
    /** Worksheet name, sanitized per §1.8. Default "Tasks". */
    sheetName?: string;
  };
  viewerEmbed?: {
    readOnly?: boolean;                        // default false (embed flips the default — §2.3)
    embed?: boolean;                           // default false
    snapshotParam?: string;                    // default "sg-snapshot"
    autoRestore?: boolean;                     // default false
    readOnlyExemptOrigins?: readonly string[]; // adds to the built-in exempt set — §2.1
  };
}
```

| Field | Default | Semantics |
|---|---|---|
| `messages` | English defaults (§8) | per-key shallow override, resolved once at `setup()` (`sdk/dom` `resolveCatalog`; builders wrapped in the latched barrier) |
| `image.background` | none (transparent; JPEG substitutes white) | §1.1 |
| `image.pixelRatio` | the chart's current drawn ratio | §1.1 |
| `image.range` | `"viewport"` | §1.1 |
| `print.*` | `paper` `"a4"`, `orientation` `"landscape"`, `scale` `100`, `marginMm` `10`, `pixelRatio` `2`, `header` none, `footer` center = page number, `range` task extent, `rows` all, `columns` `["name"]`, `legend` `true`, `criticalPathOnly` `false` | §1.2–§1.3 |
| `importExport.csvDelimiter` | `","` | any single character; else ignored |
| `excel.sheetName` | `"Tasks"` | sanitized per §1.8 |
| `viewerEmbed.readOnly` | `false` (`true` under `embed`) | §2.1 |
| `viewerEmbed.embed` | `false` | §2.3 |
| `viewerEmbed.snapshotParam` | `"sg-snapshot"` | §2.2 |
| `viewerEmbed.autoRestore` | `false` | §2.2 |
| `viewerEmbed.readOnlyExemptOrigins` | `[]` | grows the exempt set only |

## 8. Messages

`ExportMessages` — one catalog: 13 print keys + 13 import keys = **26 keys**, no collisions. The image, MS Project, Excel, and viewer/embed areas contribute no keys (their only English output is developer-facing errors and data cells, out of catalog scope). All builders get the latched fault containment: a throw is reported once via `core/pluginError` and the built-in default text is used for that call. The two count builders share one plural rule — `plural(count, noun)` = `` `${count} ${noun}` `` with `s` appended unless the count is exactly 1.

| Key | Kind | Default | Where |
|---|---|---|---|
| `pageNumber` | `(info: PrintPageInfo) => string` | produces `"Page 3 of 7"` | print footer |
| `legendTitle` | string | `"Legend"` | print legend band |
| `legendTask` | string | `"Task"` | print legend entry |
| `legendSummary` | string | `"Summary"` | print legend entry |
| `legendMilestone` | string | `"Milestone"` | print legend entry |
| `legendCritical` | string | `"Critical path"` | print legend entry |
| `previewTitle` | string | `"Print preview"` | preview dialog accessible name |
| `printButton` | string | `"Print"` | preview toolbar |
| `closeButton` | string | `"Close"` | preview toolbar |
| `columnName` | string | `"Name"` | printed table header |
| `columnStart` | string | `"Start"` | printed table header |
| `columnEnd` | string | `"End"` | printed table header |
| `columnProgress` | string | `"Progress"` | printed table header |
| `dialogTitle` | string | `"Import data"` | import dialog accessible name |
| `mappingLegend` | string | `"Column mapping"` | import dialog |
| `ignoreColumn` | string | `"Ignore"` | mapping select entry |
| `fieldLabel` | `(field: TaskCsvField) => string` | the field name verbatim | mapping select entries |
| `issuesHeading` | `(count: number) => string` | `plural(count, "issue")` — `"1 issue"` / `"3 issues"` | import dialog |
| `issueText` | `(issue: ImportIssue) => string` | an English sentence per issue code | import dialog issue list |
| `previewHeading` | string | `"Preview"` | import dialog |
| `changeAdd` | string | `"Add"` | change-kind tag |
| `changeUpdate` | string | `"Update"` | change-kind tag |
| `changeRemove` | string | `"Remove"` | change-kind tag |
| `noChanges` | string | `"No changes to import"` | empty preview |
| `applyButton` | `(count: number) => string` | `` `Import ${plural(count, "change")}` `` — `"Import 1 change"` / `"Import 3 changes"` | import dialog footer |
| `cancelButton` | string | `"Cancel"` | import dialog footer |

## 9. Internal modules

Directory = feature area; `internal/excel/` consumes `internal/formats/csv`'s shared cell-text builder.

| Directory | Files | Content |
|---|---|---|
| root (3) | `index`, `types`, `internal/messages` | factory, facade, service + extension-point registration, veto/batch subscription; all public types + the single declaration-merging site; the 26-key catalog + resolver |
| `internal/capture/` (12) | `capture`, `compose`, `range`, `recorder`, `vectorization`, `xml`, `svg/blocks`, `svg/emit`, `svg/format`, `svg/matrix`, `svg/path`, `svg/state` | tiled offscreen composition, range/row-coverage resolution, recording proxy, per-layer vectorization fallback, SVG document emission, auxiliary-surface pass |
| `internal/print/` (6) | `layout`, `page`, `pdf`, `png`, `preview`, `render` | pagination arithmetic, page composition, PDF 1.4 writer (Flate/predictor codec), canvas readback, preview dialog + print stylesheet, `renderTo` slicing + light-scheme pin |
| `internal/formats/` (7) | `csv`, `json`, `ical`, `validate`, `diff`, `apply-plan`, `dialog` | CSV codec + alias inference, JSON codec, iCal writer, cross-record validation, diff, harvest-and-cancel batch apply, the import dialog on `sdk/dialog` |
| `internal/msproject/` (4) | `xml`, `parse`, `serialize`, `apply` | self-contained XML reader, MSPDI parse + WBS reconstruction + baselines, MSPDI writer, per-command apply |
| `internal/excel/` (3) | `zip`, `xlsx-write`, `bridge` | stored-ZIP writer, SpreadsheetML writer, the cell-text bridge sharing `internal/formats/csv`'s row builder (one shared implementation — in particular §1.4's out-of-range-date raw-number fallback applies to Excel cells too) |
| `internal/embed/` (3) | `readonly`, `embed`, `snapshot` | veto + exempt origins + `sg-readonly`, embed dressing, token codec + URL fragment handling + validation |

## 10. Dependencies

hard: `data` (store reads for every serializer; the task extent for `"full"` and print ranges; commands + `midKey` for the import applies), `view` (services `stargantt.view` — `renderTo`, `chartPaneElement`, layer-canvas ratio recovery; `stargantt.timeline` — t↔x, `unitBoundaries`, locale date formatting; `stargantt.theme` — the print light-scheme pin). optional: `rows` (tree-grid — all-rows image coverage, print row spans), `critical-path` (scheduling — print emphasis), `baselines` (tracking — MSPDI baseline export; `BaselineInit` typed via type-only import, devDependency).

Dependency notes: `theme` folds into the hard `view` dependency (one plugin provides all three services); no `task-bars` or `history` edge exists (capture reaches bars through `renderTo`, and undo integration comes free from dispatching public commands); `critical-path` and `baselines` are the two real optional consumptions. All consumption points strictly downward (Layer 8 above all providers); the upward-facing seam is the `export/auxiliarySurfaces` point (§4), which lower layers contribute into.

## 11. Performance

Everything is pull-driven and on-demand: no layer contribution, no store subscription, no per-frame work, nothing resident in the render pipeline. Serializers are one O(entities) pass; parsers one pass per source plus O(tasks + links) reconstruction/validation; diffing O(tasks) over the store's id map; snapshot encode/decode one O(project) pass; image/print rendering is bounded by the requested area and runs entirely offscreen. The single standing cost is one `data/willApplyTransaction` subscription (read-only veto + import batching): one boolean/origin test per transaction attempt. A composition that includes the plugin but never calls the service pays that subscription and nothing else after `setup()`.

## 12. Third-party surface

- **Consumable services:** `stargantt.export` (`ExportService`) — the full facade (image, print/PDF, CSV/JSON/iCal, MS Project XML, xlsx, snapshots, read-only) is publicly callable; §1's design notes are the authoritative statement of what the facade deliberately omits.
- **Contributable extension points (merge strategy + contribution type):** `export/auxiliarySurfaces` (collect, `AuxiliarySurfaceContribution`) — third parties add top/bottom surfaces to exported images exactly as the official view header band and resource bottom surface do (§4), including a vector path via `drawTileSVG`.
- **Subscribable events:** `importexport/applied`, `msprojectio/applied`, `viewerembed/readOnlyChanged`, `viewerembed/snapshotApplied`.
- **Commands:** none owned; the applies dispatch the public data commands (a third party observing transactions sees origins `"import"` / `"msproject"`).
- **Reserved namespaces (documentation convention only):** the `export/` extension-point namespace; the `importexport/`, `msprojectio/`, `viewerembed/` event namespaces; the `stargantt.export` service ID; the `"import"` and `"msproject"` transaction origins; the `sg-readonly` / `sg-viewer-embed` root classes and the `sg-ie-*` / `sg-print-preview` dialog classes. Not enforced in core.
