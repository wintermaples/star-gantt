// docs/specs/plugins/export.md §1 — the plugin's whole public type surface and its single
// declaration-merging site.
/**
 * Public types of `@stargantt/plugin-export`.
 *
 * The six former export plugins (export-image, export-print, import-export, msproject-io,
 * excel-io, viewer-embed) each carried their own `types.ts`; per the spec's §9 file plan they
 * dissolve into this one module, which is also the plugin's only `declare module
 * "@stargantt/core"` site.
 */
import type { ExtensionPointDecl } from "@stargantt/core";
import type {
  Assignment,
  Link,
  LinkId,
  Resource,
  Task,
  TaskId,
} from "@stargantt/plugin-data-store";

/* ------------------------------------------------------------------ *
 * Image capture (§1.1)
 * ------------------------------------------------------------------ */

/** Which part of the timeline an image export covers. */
export type ExportRange = "viewport" | "full" | { start: number; end: number };

/** Factory-config shape of the `image` nest; also the per-call base options. */
export interface ImageCaptureConfig {
  /**
   * CSS color painted behind the chart before the layers composite. Omitted: transparent
   * (PNG/SVG) — JPEG substitutes opaque white (§1.1). Passed through unparsed.
   */
  background?: string;
  /**
   * Image pixels per CSS pixel. Omitted: the ratio the chart is currently drawn at (recovered from
   * the view plugin's layer canvases, fallback 1). Raster-only.
   */
  pixelRatio?: number;
  /**
   * Default `"viewport"`. `"full"` = the store's whole task extent; the object form is an explicit
   * epoch-ms span.
   */
  range?: ExportRange;
}

export interface RasterOptions extends ImageCaptureConfig {
  /** Encoder. Default `"png"`. `"jpeg"` folds in the standalone JPEG-export behavior (§1.1). */
  format?: "png" | "jpeg";
  /**
   * JPEG-only compression quality 0..1, forwarded to the encoder; unusable values leave the
   * encoder default (about 0.92). Ignored for PNG.
   */
  quality?: number;
}

/** One horizontal slice of the exported area, handed to auxiliary-surface draw callbacks (§4). */
export interface ExportTile {
  /** Slice time span, epoch ms. */
  start: number;
  end: number;
  /** Slice CSS-pixel box (height = the surface's own band height). */
  width: number;
  height: number;
  /** The export's ratio; the raster callback's context is pre-scaled by it. */
  pixelRatio: number;
  /**
   * Start of the WHOLE exported span this tile slices. Decisions that need to agree across every
   * tile of one export (e.g. header label thinning) are computed from this span, not the tile's
   * own slice, so tiles compose without seams.
   */
  rangeStart: number;
  /** End of the whole exported span. See `rangeStart`. */
  rangeEnd: number;
}

/** A non-layer surface that appears in exported images. See §4. */
export interface AuxiliarySurfaceContribution {
  side: "top" | "bottom";
  /** Band height, CSS px. */
  height: number;
  drawTile(ctx: CanvasRenderingContext2D, tile: ExportTile): void;
  /** Vector form of the same slice; absent, SVG exports embed the rasterized `drawTile`. */
  drawTileSVG?(tile: ExportTile): string;
}

/* ------------------------------------------------------------------ *
 * Print (§1.2, §1.3)
 * ------------------------------------------------------------------ */

/** Position-addressed page text: a fixed string or a per-page builder. */
export type PrintText = string | ((info: PrintPageInfo) => string);

export interface PrintPageInfo {
  /** 1-based. */
  page: number;
  /** Total page count of this export. */
  pages: number;
  /** Export creation time, epoch ms (the same value on every page). */
  date: number;
}

export interface PrintLegendEntry {
  color: string;
  label: string;
}

export type PrintColumnId = "name" | "start" | "end" | "progress";

export interface PrintOptions {
  /** Paper size. Default `"a4"`. */
  paper?: "a4" | "a3" | "letter";
  /** Default `"landscape"`. */
  orientation?: "portrait" | "landscape";
  /** Chart scale in percent, clamped to 10–400. Default 100. */
  scale?: number;
  /** Page margin in millimetres, usable in 0–50. Default 10. */
  marginMm?: number;
  /**
   * Image pixels per CSS pixel of the rendered pages. Default 2; a finite value above 4 is clamped
   * to 4 (canvas-memory guard — a clamp exception like `scale`'s, not an ignore); non-positive or
   * unusable values fall back to 2.
   */
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

/* ------------------------------------------------------------------ *
 * Generic formats (§1.4–§1.6)
 * ------------------------------------------------------------------ */

export type TaskCsvField = "id" | "parentId" | "name" | "start" | "end" | "progress" | "type";
export type CsvMapping = readonly (TaskCsvField | null)[];

export interface CsvExportOptions {
  /** Single character; default: the `importExport` nest's `csvDelimiter`. */
  delimiter?: string;
  /** Default: all seven fields, in `TaskCsvField` order. */
  columns?: readonly TaskCsvField[];
  /** Default false. */
  bom?: boolean;
}

export interface ICalExportOptions {
  /** `X-WR-CALNAME`; omitted by default. */
  calendarName?: string;
  /** Default false. */
  includeSummaryTasks?: boolean;
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
  /** CSV only: the header row, verbatim. */
  headers?: readonly string[];
  /** CSV only: the mapping the parse used. */
  mapping?: CsvMapping;
  /** Parse-time issues. */
  issues: ImportIssue[];
}

export type ImportChange =
  | { kind: "add"; task: Task }
  | { kind: "update"; id: TaskId; before: Partial<Task>; after: Partial<Task> }
  | { kind: "remove"; id: TaskId };

export interface ImportApplyResult {
  added: number;
  updated: number;
  removed: number;
}
export type ImportApplyCause = "api" | "dialog";

export interface ImportOptions {
  /** Store tasks the document does not mention become removes. Default false. */
  removeMissing?: boolean;
  /**
   * Keeps only the changes it returns true for (non-dialog apply path). A throw excludes the
   * change (fail-safe) and is reported once via `core/pluginError`.
   */
  filter?: (change: ImportChange) => boolean;
  /** Parse + validate + diff only; nothing applies; `applied` is absent from the result. */
  dryRun?: boolean;
  /**
   * Opens the interactive import dialog (§1.6) instead of applying directly; `applied` is absent
   * (the dialog's apply is reported via `importexport/applied`, cause `"dialog"`).
   * `dialog: true` overrides `dryRun`. Default false.
   */
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
  /**
   * Present only on the direct apply path (no `dryRun`, no `dialog`); counts changes that actually
   * applied.
   */
  applied?: ImportApplyResult;
}

/* ------------------------------------------------------------------ *
 * MS Project (§1.7)
 * ------------------------------------------------------------------ */

export type MsProjectIssue =
  | { code: "invalid-xml"; reason: string }
  | { code: "invalid-task"; uid: string; reason: string }
  | { code: "bad-date"; field: "start" | "end"; value: string; uid: string }
  | { code: "unknown-link-end"; predecessorUid: string; successorUid: string }
  | { code: "unknown-parent"; taskId: TaskId; wbs: string };

/**
 * One imported baseline generation: every task snapshot MSP stored under one baseline number.
 */
export interface MsProjectBaseline {
  /** MSPDI baseline number 0..10 (0 = MS Project's primary baseline). */
  number: number;
  /** `"Baseline"` for 0, `"Baseline <n>"` otherwise (MS Project's own naming). */
  name: string;
  tasks: { id: TaskId; start: number; end: number; type?: Task["type"] }[];
}

/**
 * The tracking plugin's baseline-seed shape, declared structurally on purpose.
 *
 * A type-only import from `@stargantt/plugin-tracking` was tried and abandoned: the
 * devDependency edge closes a three-package build ring (tracking -> resource -> export ->
 * tracking) that makes the workspace build order non-deterministic. The structural copy is
 * therefore permanent; `docs/specs/plugins/export.md` §1.7 documents the shape as the contract,
 * and the tracking package's own `BaselineInit` is the authority it mirrors.
 */
export interface BaselineInit {
  id: string;
  name: string;
  tasks: readonly { id: TaskId; start: number; end: number; type?: Task["type"] }[];
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
  /**
   * Whether saved baselines of a composed `stargantt.baselines` service embed as per-task
   * `<Baseline>` elements. Default true; without the tracking plugin nothing is written.
   */
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
  /**
   * `document.baselines` reshaped as tracking `baselines` config entries — a pure reshape, computed
   * on every call (§1.7).
   */
  baselineInits: readonly BaselineInit[];
  /** Absent on `dryRun`. */
  applied?: MsProjectApplyResult;
}

/* ------------------------------------------------------------------ *
 * Excel (§1.8)
 * ------------------------------------------------------------------ */

export interface XlsxExportOptions {
  /** Default: the `excel` nest's `sheetName` (default `"Tasks"`). */
  sheetName?: string;
  /** Default: all seven fields, in `TaskCsvField` order. */
  columns?: readonly TaskCsvField[];
}

/* ------------------------------------------------------------------ *
 * Snapshots + read-only viewing (§2)
 * ------------------------------------------------------------------ */

export type ReadOnlyCause = "config" | "api";
export type SnapshotSource = "api" | "url";

export interface SnapshotOptions {
  /**
   * Omitted/false: the bare token. `true`: the token attached to the current `location.href` as the
   * configured fragment parameter. A string: attached to that base URL instead.
   */
  url?: boolean | string;
}

/* ------------------------------------------------------------------ *
 * The facade (§1)
 * ------------------------------------------------------------------ */

export interface ExportService {
  // --- image capture (§1.1) ---
  toPng(options?: RasterOptions): Promise<Blob>;
  /** `pixelRatio` is ignored (vector). */
  toSvg(options?: ImageCaptureConfig): Promise<string>;

  // --- print (§1.2, §1.3) ---
  toPdf(options?: PrintOptions): Promise<Blob>;
  /** The number of pages the current data would produce, without rendering anything. */
  pageCount(options?: PrintOptions): number;
  /**
   * Opens (or, called while open, replaces) the print-preview overlay; `false` closes it. Returns
   * whether a preview is open after the call; opening returns false — and mounts nothing — when the
   * pages cannot be produced in this environment.
   */
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
  /**
   * Restores from a token, from a URL carrying the configured parameter, or (omitted) from the
   * current `location.href`. Returns whether a snapshot was applied.
   */
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
    >; // collect
  }
  interface Events {
    "importexport/applied": { result: ImportApplyResult; cause: ImportApplyCause };
    "msprojectio/applied": { result: MsProjectApplyResult };
    "viewerembed/readOnlyChanged": { readOnly: boolean; cause: ReadOnlyCause };
    "viewerembed/snapshotApplied": { source: SnapshotSource; droppedTasks: number };
  }
}
