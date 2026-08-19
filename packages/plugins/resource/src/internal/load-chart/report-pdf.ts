// docs/specs/plugins/resource.md §3.6 — the self-contained PDF report (§6.3).
/**
 * A minimal, dependency-free PDF writer for the utilization report.
 *
 * A4 landscape pages, a title on the first page, a table header repeated on every page, one line
 * per resource × bucket cell, all set in the base-14 Helvetica font (no font embedding needed —
 * that is the whole point of a base-14 face). Text is encoded as Latin-1; anything outside it
 * becomes `?`.
 *
 * Headless and hostless: no DOM, no service reference. The caller wraps the bytes in a `Blob`; the
 * SAVE is the host's own `downloadFile` one-liner (§3.6).
 */

/** A4 landscape, PDF points. */
const PAGE_W = 842;
const PAGE_H = 595;
const MARGIN = 40;
const TITLE_SIZE = 14;
const BODY_SIZE = 9;
const LEADING = 13;
/** Column left edges: resource, from, to, allocated, capacity, utilization. */
const COLUMN_X: readonly number[] = [MARGIN, 280, 380, 480, 580, 680];
/** Rough Helvetica 9 pt fit for the resource column (~5.1 pt per average glyph). */
const RESOURCE_MAX_CHARS = 44;

/** Latin-1-encodes a text run for a PDF string literal: escapes `\ ( )`, replaces the rest. */
function pdfText(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\\" || ch === "(" || ch === ")") out += `\\${ch}`;
    else if (code < 0x20 || code > 0xff) out += "?";
    else out += ch;
  }
  return out;
}

/** Truncates an overlong resource name with an ellipsis (rendered as `...` in Latin-1). */
export function fitResourceName(name: string): string {
  return name.length > RESOURCE_MAX_CHARS ? `${name.slice(0, RESOURCE_MAX_CHARS - 3)}...` : name;
}

/** One `BT … Tj ET` text run at an absolute position. */
function textAt(x: number, y: number, size: number, text: string): string {
  return `BT /F1 ${String(size)} Tf ${String(x)} ${String(y)} Td (${pdfText(text)}) Tj ET\n`;
}

export interface ReportPdfInput {
  title: string;
  /** The six column headers, in report column order. */
  headers: readonly string[];
  /** One table line per cell, each with the six column values in order. */
  lines: readonly (readonly string[])[];
}

/** Lays one table row's six cells onto the column grid. */
function tableRow(y: number, values: readonly string[]): string {
  let out = "";
  values.forEach((value, i) => {
    const x = COLUMN_X[i];
    if (x === undefined) return;
    out += textAt(x, y, BODY_SIZE, i === 0 ? fitResourceName(value) : value);
  });
  return out;
}

/** Builds the page content streams: title on page 1, headers on every page, then the lines. */
export function buildPageStreams(input: ReportPdfInput): string[] {
  const pages: string[] = [];
  let content = "";
  let y = PAGE_H - MARGIN;

  const openPage = (first: boolean): void => {
    content = "";
    y = PAGE_H - MARGIN;
    if (first) {
      content += textAt(MARGIN, y - TITLE_SIZE, TITLE_SIZE, input.title);
      y -= TITLE_SIZE + LEADING;
    }
    content += tableRow(y - BODY_SIZE, input.headers);
    y -= BODY_SIZE + LEADING;
  };

  openPage(true);
  for (const line of input.lines) {
    if (y - BODY_SIZE < MARGIN) {
      pages.push(content);
      openPage(false);
    }
    content += tableRow(y - BODY_SIZE, line);
    y -= LEADING;
  }
  pages.push(content);
  return pages;
}

/**
 * Assembles a complete single-file PDF 1.4 document from the report input.
 *
 * Object layout: 1 catalog, 2 pages, 3 font (ONE shared base-14 Helvetica for every page), then per
 * page `i`: `4 + 2i` page, `5 + 2i` content stream. The cross-reference table is built from the
 * byte offsets recorded while serializing, so the file is a valid, randomly-addressable PDF.
 */
export function buildReportPdf(input: ReportPdfInput): Uint8Array<ArrayBuffer> {
  const streams = buildPageStreams(input);
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${streams
      .map((_, i) => `${String(4 + 2 * i)} 0 R`)
      .join(" ")}] /Count ${String(streams.length)} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ];
  streams.forEach((stream, i) => {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${String(PAGE_W)} ${String(PAGE_H)}] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${String(5 + 2 * i)} 0 R >>`,
    );
    objects.push(`<< /Length ${String(stream.length)} >>\nstream\n${stream}endstream`);
  });

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(body.length);
    body += `${String(i + 1)} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body +=
    `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\n` +
    `startxref\n${String(xref)}\n%%EOF\n`;

  // Everything above is Latin-1 by construction, so a byte-per-char encode is exact.
  const bytes = new Uint8Array(body.length);
  for (let i = 0; i < body.length; i += 1) bytes[i] = body.charCodeAt(i) & 0xff;
  return bytes;
}
