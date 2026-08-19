/** Hostless export pipeline: plan the page grid, compose page canvases, encode the PDF. */
// docs/specs/plugins/export.md §1.2 (pagination), §1.3 (page composition, PDF)
import type { PrintLegendEntry, PrintPageInfo, PrintText } from "../../types";
import type { ExportMessages } from "../messages";
import { bandUnit, computePlan } from "./layout";
import type { PagePlan, ResolvedOptions } from "./layout";
import { composePage } from "./page";
import type { DateTick, PageDeps, PrintRow } from "./page";
import { buildPdf } from "./pdf";
import type { PdfPageImage } from "./pdf";

/** Auto-legend swatch colors (theme-neutral fixed values; ≥3:1 against the white page). */
const LEGEND_COLORS = {
  task: "#4e79a7",
  summary: "#78716c",
  milestone: "#111827",
  critical: "#c62828",
} as const;

/** What one printed row's task contributes to the table cells. */
export interface PrintTask {
  name?: string;
  start?: number;
  end?: number;
  progress?: number;
}

/**
 * The host adapter: every service the pipeline touches, injected so the pipeline itself needs no
 * plugin host. Optional members model absent optional services (silent degradation).
 */
export interface PrintEnv {
  doc: Document;
  locale: string;
  now(): number;
  renderTo(
    g: CanvasRenderingContext2D,
    viewport: { scrollLeft: number; scrollTop: number; width: number; height: number },
  ): void;
  currentViewport(): { scrollLeft: number; scrollTop: number; width: number; height: number };
  /**
   * Time ↔ x mapping. Always present: the timeline is co-provided by the hard `view`
   * dependency (docs/specs/plugins/export.md §1.2/§1.3), so the "no timeline-scale" branch is
   * unreachable and its guards are gone.
   */
  tToX(t: number): number;
  /** `TimelineService.unitBoundaries`; always present, for the same reason as `tToX`. */
  boundaries(unit: "day" | "week" | "month" | "year", fromMs: number, toMs: number): readonly number[];
  /** Earliest start / latest end over dated tasks; `undefined` with none. */
  taskExtent(): { start: number; end: number } | undefined;
  /** The optional rows service (tree-grid); absent without it. */
  rows?: {
    rowCount(): number;
    yOf(row: number): number;
    rowHeight(row: number): number;
    rowAtY(y: number): number;
    taskIdAt(row: number): unknown;
  };
  taskById(id: unknown): PrintTask | undefined;
  /** `true` when the task carries a criticality classification; absent without the service. */
  criticality?: (id: unknown) => boolean;
  fault(where: string, error: unknown): void;
}

/** What `prepare` hands the renderer: the page grid plus the injected page-composer callbacks. */
export interface Prepared {
  plan: PagePlan;
  deps: PageDeps;
}

function textPresent(t: PrintText | undefined): boolean {
  return typeof t === "function" || (typeof t === "string" && t !== "");
}

/**
 * Resolves one header/footer position with the fault barrier around host-supplied builders
 * (docs/specs/plugins/export.md §1, host-supplied callbacks): a throw is contained per call,
 * reported once via `core/pluginError`, and the empty string is used for that page text.
 */
function resolveText(env: PrintEnv, t: PrintText | undefined, info: PrintPageInfo): string {
  if (typeof t === "string") return t;
  if (typeof t !== "function") return "";
  try {
    const out = t(info);
    return typeof out === "string" ? out : "";
  } catch (error) {
    env.fault("header/footer text builder", error);
    return "";
  }
}

function dateFormatter(locale: string, unit: "day" | "week" | "month" | "year"): Intl.DateTimeFormat {
  const opts: Intl.DateTimeFormatOptions =
    unit === "year"
      ? { year: "numeric" }
      : unit === "month"
        ? { year: "numeric", month: "short" }
        : { month: "short", day: "numeric" };
  return new Intl.DateTimeFormat(locale, { timeZone: "UTC", ...opts });
}

/** The exported time span and its content-x extent. */
interface TimeSpan {
  /**
   * Whether both bounds of the exported span resolved — dated tasks or a fully explicit `range`.
   *
   * The "no timeline-scale" branch is unreachable (hard `view` dependency), so what survives is
   * the genuinely live degradation of §1.2: no dated task AND no fully explicit `range` ⇒
   * unmapped ⇒ a single page of the current viewport's time window with no date-band labels.
   */
  mapped: boolean;
  start: number | undefined;
  end: number | undefined;
  contentX0: number;
  contentX1: number;
}

/** Time span: explicit bounds → task extent → current viewport (silent degradation, §1.2). */
function resolveTimeSpan(
  env: PrintEnv,
  o: ResolvedOptions,
  vp: ReturnType<PrintEnv["currentViewport"]>,
): TimeSpan {
  const extent = env.taskExtent();
  let start = o.range.start ?? extent?.start;
  let end = o.range.end ?? extent?.end;
  const mapped = start !== undefined && end !== undefined;
  if (mapped && start! > end!) [start, end] = [end, start];
  const contentX0 = mapped ? env.tToX(start!) : vp.scrollLeft;
  const contentX1 = mapped ? Math.max(env.tToX(end!), contentX0 + 1) : vp.scrollLeft + vp.width;
  return { mapped, start, end, contentX0, contentX1 };
}

/** Row span: rows service → current viewport band. */
function resolveRowSpan(
  env: PrintEnv,
  o: ResolvedOptions,
  vp: ReturnType<PrintEnv["currentViewport"]>,
): { contentY0: number; contentY1: number } {
  const rm = env.rows;
  const rowCount = rm?.rowCount() ?? 0;
  if (rm === undefined || rowCount === 0) {
    return { contentY0: vp.scrollTop, contentY1: vp.scrollTop + vp.height };
  }
  let from = Math.max(0, Math.min(rowCount - 1, Math.floor(o.rows.from ?? 0)));
  let to = Math.max(0, Math.min(rowCount - 1, Math.floor(o.rows.to ?? rowCount - 1)));
  if (from > to) [from, to] = [to, from];
  return { contentY0: rm.yOf(from), contentY1: rm.yOf(to) + rm.rowHeight(to) };
}

function buildLegend(
  o: ResolvedOptions,
  messages: ExportMessages,
  dimNonCritical: boolean,
): PrintLegendEntry[] {
  if (Array.isArray(o.legend)) return [...o.legend];
  if (o.legend !== true) return [];
  return [
    { color: LEGEND_COLORS.task, label: messages.legendTask },
    { color: LEGEND_COLORS.summary, label: messages.legendSummary },
    { color: LEGEND_COLORS.milestone, label: messages.legendMilestone },
    ...(dimNonCritical ? [{ color: LEGEND_COLORS.critical, label: messages.legendCritical }] : []),
  ];
}

/** The unmapped span's tick reader: no bounds resolved, so the date band carries no labels. */
const NO_TICKS = (_x0: number, _x1: number): readonly DateTick[] => [];

/**
 * The date-tick reader for one page's x range. The labelling unit is picked once from the whole
 * exported span, so every page of one export labels consistently (no per-page seam differences).
 */
function makeTicks(env: PrintEnv, span: TimeSpan): (x0: number, x1: number) => readonly DateTick[] {
  if (!span.mapped) return NO_TICKS;
  const [t0, t1] = [span.start!, span.end!];
  const unit = bandUnit(t1 - t0);
  const fmt = dateFormatter(env.locale, unit);
  const { contentX0, contentX1 } = span;
  const pxPerMs = (contentX1 - contentX0) / Math.max(1, t1 - t0);
  return (x0, x1) => {
    const from = t0 + (x0 - contentX0) / pxPerMs;
    const to = t0 + (x1 - contentX0) / pxPerMs;
    return env
      .boundaries(unit, Math.max(t0, from), Math.min(t1, to))
      .map((t) => ({ x: env.tToX(t), label: fmt.format(t) }));
  };
}

/** One grid cell's text for a column, formatted in the export's locale. */
function makeCellOf(locale: string): (task: PrintTask | undefined, column: string) => string {
  const cellFmt = new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return (task, column) => {
    if (task === undefined) return "";
    switch (column) {
      case "name":
        return typeof task.name === "string" ? task.name : "";
      case "start":
        return Number.isFinite(task.start) ? cellFmt.format(task.start!) : "";
      case "end":
        return Number.isFinite(task.end) ? cellFmt.format(task.end!) : "";
      case "progress":
        return Number.isFinite(task.progress) ? `${Math.round(task.progress! * 100)}%` : "";
      default:
        return "";
    }
  };
}

function columnHeaderOf(column: string, messages: ExportMessages): string {
  if (column === "name") return messages.columnName;
  if (column === "start") return messages.columnStart;
  return column === "end" ? messages.columnEnd : messages.columnProgress;
}

/**
 * Plans the page grid and builds the injected page-composer dependencies.
 *
 * Renders nothing at all — no canvas is created and no chart pass runs — which is what lets
 * `pageCount` answer without pinning the color scheme (docs/specs/plugins/export.md §1.3).
 */
export function prepare(env: PrintEnv, o: ResolvedOptions, messages: ExportMessages): Prepared {
  const vp = env.currentViewport();
  const span = resolveTimeSpan(env, o, vp);
  const { contentX0, contentX1 } = span;
  const { contentY0, contentY1 } = resolveRowSpan(env, o, vp);
  const rm = env.rows;
  const rowCount = rm?.rowCount() ?? 0;

  const dimNonCritical = o.criticalPathOnly && env.criticality !== undefined;
  const legend = buildLegend(o, messages, dimNonCritical);

  const footerCenter = "center" in o.footer ? o.footer.center : messages.pageNumber;
  const footer = { ...o.footer, ...(footerCenter === undefined ? {} : { center: footerCenter }) };

  const plan = computePlan({
    options: o,
    hasHeader:
      textPresent(o.header.left) || textPresent(o.header.center) || textPresent(o.header.right),
    // §1.2 — the 24 px date band is present when the exported span resolved both bounds, or when
    // at least one table column is configured (the table's header row shares this band).
    hasDateBand: span.mapped || o.columns.length > 0,
    hasLegend: legend.length > 0,
    hasFooter:
      textPresent(footer.left) || textPresent(footer.center) || textPresent(footer.right),
    contentX0,
    contentX1,
    contentY0,
    contentY1,
  });

  const ticks = makeTicks(env, span);
  const cellOf = makeCellOf(env.locale);
  const rowsIn = (y0: number, y1: number): readonly PrintRow[] => {
    if (rm === undefined || rowCount === 0) return [];
    const out: PrintRow[] = [];
    for (let r = Math.max(0, rm.rowAtY(y0)); r < rowCount; r++) {
      const y = rm.yOf(r);
      if (y >= y1) break;
      const h = rm.rowHeight(r);
      if (y + h <= y0) continue;
      const id = rm.taskIdAt(r);
      out.push({
        y,
        h,
        cells: o.columns.map((c) => cellOf(env.taskById(id), c)),
        critical: env.criticality?.(id) ?? true,
      });
    }
    return out;
  };

  const columnHeaders = o.columns.map((c) => columnHeaderOf(c, messages));

  const deps: PageDeps = {
    renderChart: (g, viewport) => env.renderTo(g, viewport),
    ticks,
    rowsIn,
    headerText: (p, info) => resolveText(env, [o.header.left, o.header.center, o.header.right][p], info),
    footerText: (p, info) => resolveText(env, [footer.left, footer.center, footer.right][p], info),
    columns: o.columns,
    columnHeaders,
    legendTitle: messages.legendTitle,
    legend,
    dimNonCritical,
  };
  return { plan, deps };
}

export interface RenderedPages {
  plan: PagePlan;
  canvases: HTMLCanvasElement[];
}

/** Composes every page onto its own canvas; `undefined` when no 2D context is obtainable. */
export function renderPages(
  env: PrintEnv,
  o: ResolvedOptions,
  messages: ExportMessages,
): RenderedPages | undefined {
  const { plan, deps } = prepare(env, o, messages);
  const date = env.now();
  const canvases: HTMLCanvasElement[] = [];
  for (let i = 0; i < plan.slices.length; i++) {
    const canvas = env.doc.createElement("canvas") as HTMLCanvasElement;
    canvas.width = Math.round(plan.pageWidth * o.pixelRatio);
    canvas.height = Math.round(plan.pageHeight * o.pixelRatio);
    const g = canvas.getContext("2d");
    if (g === null) return undefined;
    g.scale(o.pixelRatio, o.pixelRatio);
    composePage(g, plan, plan.slices[i]!, { page: i + 1, pages: plan.slices.length, date }, deps);
    canvases.push(canvas);
  }
  return { plan, canvases };
}

/** Drops the alpha channel from `ImageData`-shaped RGBA pixels, producing tightly packed RGB. */
function toRgb(rgba: Uint8ClampedArray | Uint8Array): Uint8Array {
  const out = new Uint8Array((rgba.length / 4) * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    out[j] = rgba[i]!;
    out[j + 1] = rgba[i + 1]!;
    out[j + 2] = rgba[i + 2]!;
  }
  return out;
}

/** Encodes rendered pages into a single PDF Blob; `undefined` when a page cannot be encoded. */
export function encodePdf(rendered: RenderedPages): Blob | undefined {
  const pages: PdfPageImage[] = [];
  for (const canvas of rendered.canvases) {
    const g = canvas.getContext("2d");
    if (g === null) return undefined;
    let data: ImageData;
    try {
      data = g.getImageData(0, 0, canvas.width, canvas.height);
    } catch {
      // Environment refuses pixel readback (e.g. a tainted canvas): no lossy fallback, fail closed.
      return undefined;
    }
    pages.push({
      widthPx: rendered.plan.pageWidth,
      heightPx: rendered.plan.pageHeight,
      imageWidth: canvas.width,
      imageHeight: canvas.height,
      pixels: toRgb(data.data),
    });
  }
  return new Blob([buildPdf(pages) as BlobPart], { type: "application/pdf" });
}
