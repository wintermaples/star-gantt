/** Hostless single-page composer: bands, table, chart slice, legend, dimming — one canvas. */
// docs/specs/plugins/export.md §1.3 (page composition)
import type { PrintColumnId, PrintLegendEntry, PrintPageInfo } from "../../types";
import { COLUMN_WIDTHS } from "./layout";
import type { PagePlan, PageSlice } from "./layout";

const TEXT = "#1f2937";
const MUTED = "#4b5563";
const RULE = "#d1d5db";
const FONT = "10px sans-serif";
const HEAD_FONT = "bold 10px sans-serif";

/** One printed table row: its content-space band plus the cell text per selected column. */
export interface PrintRow {
  /** Row top, content CSS px. */
  y: number;
  h: number;
  cells: readonly string[];
  /** `false` dims the row's chart band in critical-path emphasis mode. */
  critical: boolean;
}

export interface DateTick {
  /** Boundary position, content CSS px. */
  x: number;
  label: string;
}

/** Everything a page draw needs, gathered by the caller; all functions are injected. */
export interface PageDeps {
  /** Draws the chart composite for a virtual viewport (the view plugin's `renderTo`). */
  renderChart(
    g: CanvasRenderingContext2D,
    viewport: { scrollLeft: number; scrollTop: number; width: number; height: number },
  ): void;
  /** Date-band ticks intersecting a content-x span (empty without a resolved time span). */
  ticks(x0: number, x1: number): readonly DateTick[];
  /** The task rows intersecting a content-y span, top to bottom. */
  rowsIn(y0: number, y1: number): readonly PrintRow[];
  /** Resolved header/footer text for one position of one page ("" = nothing). */
  headerText(position: 0 | 1 | 2, info: PrintPageInfo): string;
  footerText(position: 0 | 1 | 2, info: PrintPageInfo): string;
  columns: readonly PrintColumnId[];
  columnHeaders: readonly string[];
  legendTitle: string;
  legend: readonly PrintLegendEntry[];
  /** `true` dims non-critical rows across the chart region. */
  dimNonCritical: boolean;
}

function lineTexts(
  g: CanvasRenderingContext2D,
  read: (position: 0 | 1 | 2) => string,
  xLeft: number,
  xRight: number,
  baseline: number,
): void {
  g.fillStyle = MUTED;
  g.font = FONT;
  g.textBaseline = "middle";
  const texts: [string, CanvasTextAlign, number][] = [
    [read(0), "left", xLeft],
    [read(1), "center", (xLeft + xRight) / 2],
    [read(2), "right", xRight],
  ];
  for (const [text, align, x] of texts) {
    if (text === "") continue;
    g.textAlign = align;
    g.fillText(text, x, baseline);
  }
}

/** Draws one complete page into `g`, which is already scaled to CSS-px coordinates. */
export function composePage(
  g: CanvasRenderingContext2D,
  plan: PagePlan,
  slice: PageSlice,
  info: PrintPageInfo,
  deps: PageDeps,
): void {
  const right = plan.pageWidth - plan.margin;

  // Page background.
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, plan.pageWidth, plan.pageHeight);

  if (plan.headerH > 0) {
    lineTexts(g, (p) => deps.headerText(p, info), plan.margin, right, plan.headerY + plan.headerH / 2);
  }
  if (plan.footerH > 0) {
    lineTexts(g, (p) => deps.footerText(p, info), plan.margin, right, plan.footerY + plan.footerH / 2);
  }

  const rows = deps.rowsIn(slice.y0, slice.y0 + slice.h);

  // Date band over the chart region (labels for this page's own time slice).
  if (plan.dateBandH > 0) {
    g.strokeStyle = RULE;
    g.lineWidth = 1;
    g.strokeRect(plan.chartX, plan.dateBandY, plan.chartW, plan.dateBandH);
    g.save();
    g.beginPath();
    g.rect(plan.chartX, plan.dateBandY, plan.chartW, plan.dateBandH);
    g.clip();
    g.fillStyle = TEXT;
    g.font = FONT;
    g.textAlign = "left";
    g.textBaseline = "middle";
    for (const tick of deps.ticks(slice.x0, slice.x0 + slice.w)) {
      const x = plan.chartX + (tick.x - slice.x0) * plan.scale;
      g.beginPath();
      g.moveTo(x, plan.dateBandY);
      g.lineTo(x, plan.dateBandY + plan.dateBandH);
      g.stroke();
      g.fillText(tick.label, x + 3, plan.dateBandY + plan.dateBandH / 2);
    }
    g.restore();
  }

  // Table: column headers in the date band's row, then one text row per task row.
  if (plan.tableW > 0) {
    g.save();
    g.beginPath();
    g.rect(plan.tableX, plan.dateBandY, plan.tableW, plan.dateBandH + plan.chartH);
    g.clip();
    g.textBaseline = "middle";
    g.textAlign = "left";
    if (plan.dateBandH > 0) {
      g.fillStyle = TEXT;
      g.font = HEAD_FONT;
      let hx = plan.tableX;
      deps.columns.forEach((column, i) => {
        g.fillText(deps.columnHeaders[i] ?? "", hx + 4, plan.dateBandY + plan.dateBandH / 2);
        hx += COLUMN_WIDTHS[column];
      });
    }
    g.font = FONT;
    for (const row of rows) {
      const y = plan.chartY + (row.y - slice.y0) * plan.scale;
      const h = row.h * plan.scale;
      g.strokeStyle = RULE;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(plan.tableX, y + h);
      g.lineTo(plan.tableX + plan.tableW, y + h);
      g.stroke();
      g.fillStyle = deps.dimNonCritical && !row.critical ? MUTED : TEXT;
      let cx = plan.tableX;
      deps.columns.forEach((column, i) => {
        g.fillText(row.cells[i] ?? "", cx + 4, y + h / 2);
        cx += COLUMN_WIDTHS[column];
      });
    }
    g.restore();
  }

  // Chart slice through one virtual viewport; nothing on screen is touched.
  g.save();
  g.beginPath();
  g.rect(plan.chartX, plan.chartY, plan.chartW, plan.chartH);
  g.clip();
  g.translate(plan.chartX, plan.chartY);
  g.scale(plan.scale, plan.scale);
  deps.renderChart(g, { scrollLeft: slice.x0, scrollTop: slice.y0, width: slice.w, height: slice.h });
  // Critical-path emphasis: veil the non-critical row bands (emphasis, not a filter). The 75 %
  // white veil is fixed by docs/specs/plugins/export.md §1.3.
  if (deps.dimNonCritical) {
    g.fillStyle = "rgba(255, 255, 255, 0.75)";
    for (const row of rows) {
      if (!row.critical) g.fillRect(0, row.y - slice.y0, slice.w, row.h);
    }
  }
  g.restore();
  g.strokeStyle = RULE;
  g.lineWidth = 1;
  g.strokeRect(plan.chartX, plan.chartY, plan.chartW, plan.chartH);

  // Legend band: title plus swatch + label per entry.
  if (plan.legendH > 0 && deps.legend.length > 0) {
    g.font = HEAD_FONT;
    g.fillStyle = TEXT;
    g.textAlign = "left";
    g.textBaseline = "middle";
    const cy = plan.legendY + plan.legendH / 2;
    let lx = plan.margin;
    g.fillText(deps.legendTitle, lx, cy);
    lx += Math.max(40, g.measureText(deps.legendTitle).width + 12);
    g.font = FONT;
    for (const entry of deps.legend) {
      g.fillStyle = entry.color;
      g.fillRect(lx, cy - 5, 10, 10);
      g.strokeStyle = RULE;
      g.strokeRect(lx, cy - 5, 10, 10);
      lx += 14;
      g.fillStyle = TEXT;
      g.fillText(entry.label, lx, cy);
      lx += Math.max(30, g.measureText(entry.label).width) + 16;
    }
  }
}
