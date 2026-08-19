// docs/specs/plugins/export.md §1.8 — minimal SpreadsheetML writer: one worksheet of
// inline-string cells inside a valid OOXML package. Hostless: pure functions from a string grid
// to container bytes.
import { writeZip } from "./zip";

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // Control characters are not representable in XML 1.0; drop them rather than corrupt the part.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

/**
 * Removes Excel's illegal sheet-name characters, trims, truncates to 31 chars, strips leading/
 * trailing apostrophes (re-checked after truncation, since a cut can expose a new one), and
 * renames the reserved name "History" (§1.8); `""` when nothing survives.
 *
 * Known scope limit: this does not check for duplicate names across a workbook, nor for any
 * other Excel-reserved names beyond "History" — callers packing multiple sheets must dedupe
 * themselves. Only one sheet is ever written by this plugin, so that limit is never exercised.
 */
export function sanitizeSheetName(name: unknown): string {
  if (typeof name !== "string") return "";
  let result = name
    .replace(/[\\/?*[\]:]/g, "")
    .trim()
    .slice(0, 31)
    .trim();
  // Truncation can expose a new leading/trailing apostrophe, so strip and re-trim once more.
  result = result.replace(/^'+|'+$/g, "").trim();
  if (result.toLowerCase() === "history") return "Sheet1";
  return result;
}

/** Column index (0-based) → A1-style column letters. */
export function columnLetters(index: number): string {
  let letters = "";
  let n = index;
  do {
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return letters;
}

function sheetXml(rows: readonly (readonly string[])[]): string {
  const body = rows
    .map((cells, r) => {
      const columns = cells
        .map((cell, c) =>
          cell === ""
            ? ""
            : `<c r="${columnLetters(c)}${r + 1}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell)}</t></is></c>`,
        )
        .join("");
      return `<row r="${r + 1}">${columns}</row>`;
    })
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`
  );
}

/** Packs one string grid into a complete .xlsx workbook (stored ZIP, inline strings, no styles). */
export function buildXlsx(rows: readonly (readonly string[])[], sheetName: string): Uint8Array {
  const encoder = new TextEncoder();
  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `</Types>`;
  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;
  const workbook =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `</Relationships>`;

  return writeZip([
    { name: "[Content_Types].xml", data: encoder.encode(contentTypes) },
    { name: "_rels/.rels", data: encoder.encode(rootRels) },
    { name: "xl/workbook.xml", data: encoder.encode(workbook) },
    { name: "xl/_rels/workbook.xml.rels", data: encoder.encode(workbookRels) },
    { name: "xl/worksheets/sheet1.xml", data: encoder.encode(sheetXml(rows)) },
  ]);
}
