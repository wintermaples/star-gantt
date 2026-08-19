// docs/specs/plugins/portfolio.md §3.8 — the report exporter: the model flattened to text lines,
// drawn to a canvas for the PNG form, or typeset into a minimal dependency-free single-page PDF
// for the PDF form.
import { isoDay } from "@stargantt/sdk";
import type { DashboardWidgetId } from "../../types";
import type { PortfolioMessages } from "../messages";
import { percent } from "../messages";
import type { DashboardModel } from "./model";

/** One line per item, or the empty-state label when the list has none. */
function listLines<T>(
  items: readonly T[],
  messages: PortfolioMessages,
  line: (item: T) => string,
): string[] {
  return items.length === 0 ? [messages.emptyLabel] : items.map(line);
}

/** The body lines of one widget, below its title. */
type WidgetLines = (model: DashboardModel, messages: PortfolioMessages) => string[];

// One entry per widget id, so a new widget without a report section is a compile error rather
// than a silently blank block.
const WIDGET_LINES = {
  summary: (model, messages) => [messages.summaryText(model.summary)],
  overdue: (model, messages) => listLines(model.overdue, messages, (e) => messages.overdueLine(e)),
  burndown: (model, messages) => [
    messages.burndownPlanned(model.burndown.taskCount),
    ...model.burndown.actual.map((p) => messages.burndownPoint(p)),
  ],
  workload: (model, messages) =>
    listLines(model.workload, messages, (w) => `${w.name}: ${w.personDays.toFixed(1)}d (${w.taskCount})`),
  status: (model, messages) => {
    // Inlined donut-segment shape (avoids importing `./panel` for one tiny helper): label, count.
    const rows = [
      { label: messages.statusNotStarted, count: model.status.notStarted },
      { label: messages.statusInProgress, count: model.status.inProgress },
      { label: messages.statusCompleted, count: model.status.completed },
    ];
    return rows.map((r) => `${r.label}: ${r.count}`);
  },
  milestones: (model, messages) =>
    listLines(model.milestones, messages, (m) => {
      const state = m.reached
        ? messages.milestoneReached
        : m.overdue
          ? messages.milestoneOverdue
          : messages.milestonePending;
      return `${m.name} — ${isoDay(m.date) ?? ""} (${state})`;
    }),
  goals: (model, messages) =>
    listLines(model.goals, messages, (g) => `${g.name}: ${percent(g.progress)} / ${percent(g.target)}`),
  portfolio: (model, messages) =>
    listLines(model.portfolio, messages, (row) => messages.portfolioRow(row)),
  groups: (model, messages) =>
    listLines(model.groups, messages, (g) => `${g.group}: ${percent(g.progress)} (${g.taskCount})`),
  formulas: (model, messages) => listLines(model.formulas, messages, (f) => `${f.label}: ${f.text}`),
} satisfies Record<DashboardWidgetId, WidgetLines>;

/** Flattens the model to the report's text lines — one line per fact, widget order preserved. */
export function buildReportLines(model: DashboardModel, messages: PortfolioMessages): string[] {
  const lines: string[] = [];
  for (const widget of model.widgets) {
    lines.push(`## ${messages.widgetTitle(widget)}`);
    lines.push(...WIDGET_LINES[widget](model, messages));
  }
  return lines;
}

const LINE_HEIGHT = 18;
const MARGIN = 24;
const PAGE_WIDTH = 800;

/**
 * Draws the report onto a fresh canvas and returns its PNG data URL, or `undefined` when no 2D
 * context (or `toDataURL`) is available in the hosting document.
 */
export function exportPng(doc: Document, title: string, lines: readonly string[]): string | undefined {
  const canvas = doc.createElement("canvas") as HTMLCanvasElement;
  canvas.width = PAGE_WIDTH;
  canvas.height = MARGIN * 2 + LINE_HEIGHT * (lines.length + 2);
  const g = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
  if (g === null || g === undefined || typeof canvas.toDataURL !== "function") return undefined;
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = "#1d2733";
  g.font = "bold 16px system-ui, sans-serif";
  g.fillText(title, MARGIN, MARGIN + 16);
  g.font = "13px system-ui, sans-serif";
  lines.forEach((line, i) => {
    g.fillText(line, MARGIN, MARGIN + 16 + LINE_HEIGHT * (i + 2));
  });
  return canvas.toDataURL("image/png");
}

/* --- minimal PDF ---------------------------------------------------------- */

const escapePdfText = (text: string): string =>
  // Non-Latin-1 characters are replaced — the built-in Helvetica font covers WinAnsi only.
  text.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^ -ÿ]/g, "?");

function toBase64(bytes: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes.charCodeAt(i);
    const b = i + 1 < bytes.length ? bytes.charCodeAt(i + 1) : NaN;
    const c = i + 2 < bytes.length ? bytes.charCodeAt(i + 2) : NaN;
    out += alphabet[a >> 2];
    out += alphabet[((a & 3) << 4) | (Number.isNaN(b) ? 0 : b >> 4)];
    out += Number.isNaN(b) ? "=" : alphabet[((b & 15) << 2) | (Number.isNaN(c) ? 0 : c >> 6)];
    out += Number.isNaN(c) ? "=" : alphabet[c & 63];
  }
  return out;
}

/**
 * Typesets the report into a minimal single-page PDF (built-in Helvetica, A4 portrait) and
 * returns it as a `data:application/pdf;base64,…` URL. Pure — no DOM needed, always succeeds.
 */
export function exportPdf(title: string, lines: readonly string[]): string {
  const pageH = Math.max(842, 72 + 14 * (lines.length + 3));
  let text = `BT /F1 16 Tf 40 ${pageH - 48} Td (${escapePdfText(title)}) Tj ET\n`;
  lines.forEach((line, i) => {
    const y = pageH - 76 - 14 * i;
    text += `BT /F1 10 Tf 40 ${y} Td (${escapePdfText(line)}) Tj ET\n`;
  });
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 ${pageH}] /Contents 4 0 R ` +
      "/Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return `data:application/pdf;base64,${toBase64(body)}`;
}
