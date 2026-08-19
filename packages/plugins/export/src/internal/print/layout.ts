/** Hostless pagination math: paper geometry, option resolution, page-slice planning. */
// docs/specs/plugins/export.md §1.2 (pagination), §1 (option resolution)
import type { PrintColumnId, PrintLegendEntry, PrintOptions, PrintText } from "../../types";

export const PX_PER_MM = 96 / 25.4;

/** Paper sizes in millimetres, portrait (width × height). */
const PAPERS = {
  a4: { w: 210, h: 297 },
  a3: { w: 297, h: 420 },
  letter: { w: 215.9, h: 279.4 },
} as const;

export type PaperId = keyof typeof PAPERS;

export const HEADER_BAND = 18;
export const DATE_BAND = 24;
export const FOOTER_BAND = 18;
export const LEGEND_BAND = 20;

/** Widths of the built-in printable table columns, CSS px. */
export const COLUMN_WIDTHS: Record<PrintColumnId, number> = {
  name: 160,
  start: 76,
  end: 76,
  progress: 56,
};

const COLUMN_IDS: readonly PrintColumnId[] = ["name", "start", "end", "progress"];

/**
 * Hard ceiling on the total page count `computePlan` will produce. A pathological combination
 * (huge exported range at a large scale, or a tiny page/margin) would otherwise silently try to
 * lay out — and later rasterize — an unbounded number of pages; reject early with an actionable
 * error instead of hanging or exhausting memory.
 */
export const MAX_PAGES = 1000;

/** Every option of `PrintOptions` with its default filled in and unusable values dropped. */
export interface ResolvedOptions {
  paper: PaperId;
  orientation: "portrait" | "landscape";
  /** As a fraction (1 = 100 %). */
  scale: number;
  marginPx: number;
  pixelRatio: number;
  header: { left?: PrintText; center?: PrintText; right?: PrintText };
  footer: { left?: PrintText; center?: PrintText; right?: PrintText };
  range: { start?: number; end?: number };
  rows: { from?: number; to?: number };
  columns: readonly PrintColumnId[];
  /** `true` = auto entries, array = explicit, `false` = none. */
  legend: boolean | readonly PrintLegendEntry[];
  criticalPathOnly: boolean;
}

function finite(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function textSpec(v: unknown): { left?: PrintText; center?: PrintText; right?: PrintText } {
  if (v === null || typeof v !== "object") return {};
  const out: { left?: PrintText; center?: PrintText; right?: PrintText } = {};
  for (const key of ["left", "center", "right"] as const) {
    const t = (v as Record<string, unknown>)[key];
    if (typeof t === "string" || typeof t === "function") out[key] = t as PrintText;
  }
  return out;
}

function bounds<A extends string, B extends string>(
  v: unknown,
  a: A,
  b: B,
): Partial<Record<A | B, number>> {
  const out: Partial<Record<A | B, number>> = {};
  if (v === null || typeof v !== "object") return out;
  const lo = finite((v as Record<string, unknown>)[a]);
  const hi = finite((v as Record<string, unknown>)[b]);
  if (lo !== undefined) out[a] = lo;
  if (hi !== undefined) out[b] = hi;
  return out;
}

/** Per-key shallow merge of factory config and per-call options, then per-key validation. */
export function resolveOptions(config: PrintOptions, call?: PrintOptions): ResolvedOptions {
  const merged: PrintOptions = {
    ...config,
    ...(call !== null && typeof call === "object" ? call : {}),
  };
  const paper = typeof merged.paper === "string" && merged.paper in PAPERS ? merged.paper : "a4";
  const orientation =
    merged.orientation === "portrait" || merged.orientation === "landscape"
      ? merged.orientation
      : "landscape";
  const rawScale = finite(merged.scale);
  // docs/specs/plugins/export.md §1 (option resolution): any finite scale is clamped into 10–400,
  // never ignored — 0 and negatives clamp to the 10 % floor; only a missing/non-finite value falls
  // back to 100 %.
  const scale = rawScale !== undefined ? Math.min(400, Math.max(10, rawScale)) / 100 : 1;
  const marginMm = finite(merged.marginMm);
  const marginPx =
    (marginMm !== undefined && marginMm >= 0 && marginMm <= 50 ? marginMm : 10) * PX_PER_MM;
  const ratio = finite(merged.pixelRatio);
  const columns = Array.isArray(merged.columns)
    ? merged.columns.filter((c): c is PrintColumnId => COLUMN_IDS.includes(c as PrintColumnId))
    : (["name"] as const);
  const legend = Array.isArray(merged.legend)
    ? merged.legend.filter(
        (e) =>
          e !== null && typeof e === "object" && typeof e.color === "string" && typeof e.label === "string",
      )
    : merged.legend === false
      ? false
      : true;
  return {
    paper,
    orientation,
    scale,
    marginPx,
    // docs/specs/plugins/export.md §1 (option resolution) — an unusable value falls back to the
    // default, but an oversized-yet-finite one is clamped rather than rejected: an unbounded
    // pixelRatio would blow up canvas memory/time per page, so cap it at 4.
    pixelRatio: ratio !== undefined && ratio > 0 ? Math.min(4, ratio) : 2,
    header: textSpec(merged.header),
    footer: textSpec(merged.footer),
    range: bounds(merged.range, "start", "end"),
    rows: bounds(merged.rows, "from", "to"),
    columns,
    legend,
    criticalPathOnly: merged.criticalPathOnly === true,
  };
}

/** Paper box in CSS px for the chosen size and orientation. */
export function paperPx(
  paper: PaperId,
  orientation: "portrait" | "landscape",
): { width: number; height: number } {
  const p = PAPERS[paper];
  const w = p.w * PX_PER_MM;
  const h = p.h * PX_PER_MM;
  return orientation === "portrait" ? { width: w, height: h } : { width: h, height: w };
}

/** One page's slice of the chart content, in unscaled content CSS px. */
export interface PageSlice {
  /** Time-axis page column, 0-based. */
  col: number;
  /** Row-axis page band, 0-based. */
  band: number;
  x0: number;
  y0: number;
  w: number;
  h: number;
}

/** The fixed per-page geometry plus every page's content slice, in output order. */
export interface PagePlan {
  pageWidth: number;
  pageHeight: number;
  margin: number;
  scale: number;
  /** y of each band's top, CSS px from the page top. */
  headerY: number;
  headerH: number;
  dateBandY: number;
  dateBandH: number;
  chartY: number;
  chartH: number;
  legendY: number;
  legendH: number;
  footerY: number;
  footerH: number;
  /** x/width of the repeated table region and of the chart region, CSS px. */
  tableX: number;
  tableW: number;
  chartX: number;
  chartW: number;
  cols: number;
  bands: number;
  slices: PageSlice[];
}

export interface PlanInput {
  options: ResolvedOptions;
  /** Whether a header band / date band / legend band / footer band is present. */
  hasHeader: boolean;
  hasDateBand: boolean;
  hasLegend: boolean;
  hasFooter: boolean;
  /** Chart content span to export, content CSS px (x along time, y along rows). */
  contentX0: number;
  contentX1: number;
  contentY0: number;
  contentY1: number;
}

/** Computes the page grid: band layout, table/chart split, and every page's content slice. */
export function computePlan(input: PlanInput): PagePlan {
  const o = input.options;
  const { width: pageWidth, height: pageHeight } = paperPx(o.paper, o.orientation);
  const margin = o.marginPx;
  const headerH = input.hasHeader ? HEADER_BAND : 0;
  const dateBandH = input.hasDateBand ? DATE_BAND : 0;
  const legendH = input.hasLegend ? LEGEND_BAND : 0;
  const footerH = input.hasFooter ? FOOTER_BAND : 0;

  const headerY = margin;
  const dateBandY = headerY + headerH;
  const chartY = dateBandY + dateBandH;
  const footerY = pageHeight - margin - footerH;
  const legendY = footerY - legendH;
  const chartH = Math.max(1, legendY - chartY);

  const tableW = o.columns.reduce((w, c) => w + COLUMN_WIDTHS[c], 0);
  const tableX = margin;
  const chartX = margin + tableW;
  const chartW = Math.max(1, pageWidth - margin - chartX);

  const sliceW = chartW / o.scale;
  const sliceH = chartH / o.scale;
  const spanX = Math.max(1, input.contentX1 - input.contentX0);
  const spanY = Math.max(1, input.contentY1 - input.contentY0);
  const cols = Math.max(1, Math.ceil(spanX / sliceW));
  const bands = Math.max(1, Math.ceil(spanY / sliceH));

  const pageCount = cols * bands;
  if (pageCount > MAX_PAGES) {
    throw new Error(
      `stargantt.export: computed page count (${pageCount}) exceeds the ${MAX_PAGES}-page limit. ` +
        "Narrow the exported range, increase the scale, or reduce the row selection.",
    );
  }

  const slices: PageSlice[] = [];
  for (let band = 0; band < bands; band++) {
    for (let col = 0; col < cols; col++) {
      slices.push({
        col,
        band,
        x0: input.contentX0 + col * sliceW,
        y0: input.contentY0 + band * sliceH,
        w: sliceW,
        h: sliceH,
      });
    }
  }
  return {
    pageWidth,
    pageHeight,
    margin,
    scale: o.scale,
    headerY,
    headerH,
    dateBandY,
    dateBandH,
    chartY,
    chartH,
    legendY,
    legendH,
    footerY,
    footerH,
    tableX,
    tableW,
    chartX,
    chartW,
    cols,
    bands,
    slices,
  };
}

/** Picks the date-band labelling unit from the exported span. */
export function bandUnit(spanMs: number): "day" | "week" | "month" | "year" {
  const days = spanMs / 86_400_000;
  if (days <= 21) return "day";
  if (days <= 140) return "week";
  if (days <= 1100) return "month";
  return "year";
}
