// docs/specs/plugins/export.md §1.8 — the SpreadsheetML writer and its bridge helpers.
import { describe, expect, it } from "vitest";
import { usableColumns } from "../src/internal/excel/bridge";
import { buildXlsx, columnLetters, sanitizeSheetName } from "../src/internal/excel/xlsx-write";
import { gridOf, sheetGrid, sheetNameOf, unzipStored } from "./_unzip";

describe("workbook writer", () => {
  it("packs a minimal valid OOXML package with all five parts", () => {
    const parts = unzipStored(buildXlsx([["a"]], "S"));
    expect([...parts.keys()]).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/worksheets/sheet1.xml",
    ]);
    expect(parts.get("xl/workbook.xml")).toContain('<sheet name="S" sheetId="1" r:id="rId1"/>');
  });

  it("writes inline-string cells with XML escaping and preserves the grid", () => {
    const rows = [
      ["name", "start", "end"],
      ['He said "hi" <&>', "1970-01-01", "1970-01-03"],
      ["", "gap before me", "あ"],
    ];
    const workbook = buildXlsx(rows, "My Sheet");
    expect(sheetNameOf(workbook)).toBe("My Sheet");
    expect(sheetGrid(workbook)).toEqual(rows);
    const xml = unzipStored(workbook).get("xl/worksheets/sheet1.xml") ?? "";
    expect(xml).toContain('t="inlineStr"');
    expect(xml).toContain("He said &quot;hi&quot; &lt;&amp;&gt;");
  });

  it("skips empty cells instead of materializing them", () => {
    const xml = unzipStored(buildXlsx([["a", "", "c"]], "S")).get("xl/worksheets/sheet1.xml") ?? "";
    // Only A1 and C1 are written; the gap comes back dense through the grid extractor.
    expect(xml).toContain('<c r="A1"');
    expect(xml).not.toContain('<c r="B1"');
    expect(xml).toContain('<c r="C1"');
    expect(gridOf(xml)).toEqual([["a", "", "c"]]);
  });

  it("escapes the sheet name inside xl/workbook.xml", () => {
    expect(sheetNameOf(buildXlsx([["x"]], "Plan & Co"))).toBe("Plan & Co");
  });

  it("maps column indices to A1 letters past Z", () => {
    expect(columnLetters(0)).toBe("A");
    expect(columnLetters(25)).toBe("Z");
    expect(columnLetters(26)).toBe("AA");
    expect(columnLetters(27 * 26)).toBe("AAA");
  });

  it("maps column indices to A1 letters across the Z/AA and ZZ/AAA boundaries", () => {
    // Z is index 25, AA is index 26.
    expect(columnLetters(25)).toBe("Z");
    expect(columnLetters(26)).toBe("AA");
    // ZZ is index 26 + 26*26 - 1 = 701, AAA is index 702.
    expect(columnLetters(701)).toBe("ZZ");
    expect(columnLetters(702)).toBe("AAA");
  });

  it("strips embedded control characters from cell values so the XML stays valid", () => {
    const rows = [["name\x01tab", "vertical\x0Btab"]];
    const workbook = buildXlsx(rows, "S");
    const xml = unzipStored(workbook).get("xl/worksheets/sheet1.xml") ?? "";
    // eslint-disable-next-line no-control-regex
    expect(/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(xml)).toBe(false);
    expect(sheetGrid(workbook)).toEqual([["nametab", "verticaltab"]]);
  });

  it("writes a formula-looking value as literal inline text, not an interpreted formula", () => {
    const rows = [["=1+1"]];
    const workbook = buildXlsx(rows, "S");
    const xml = unzipStored(workbook).get("xl/worksheets/sheet1.xml") ?? "";
    // Written as an inline string (t="inlineStr"), never as a formula cell (no <f> element).
    expect(xml).toContain('t="inlineStr"');
    expect(xml).not.toContain("<f>");
    expect(xml).toContain('<t xml:space="preserve">=1+1</t>');
    expect(sheetGrid(workbook)).toEqual([["=1+1"]]);
  });

  it("uses the DOS 1980-01-01 epoch timestamp for every entry (byte-deterministic output)", () => {
    // DOS date 0x21 ("1980-01-01"), DOS time 0 ("midnight") at offset 10 of the local header.
    const bytes = new Uint8Array(buildXlsx([["a"]], "S"));
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(10, true)).toBe((0x21 << 16) | 0);
  });
});

describe("bridge helpers", () => {
  it("sanitizes sheet names to Excel's rules", () => {
    expect(sanitizeSheetName("Plan: Q1/Q2 [draft]?*\\")).toBe("Plan Q1Q2 draft");
    expect(sanitizeSheetName("x".repeat(40))).toHaveLength(31);
    expect(sanitizeSheetName(42)).toBe("");
    expect(sanitizeSheetName("///")).toBe("");
    expect(sanitizeSheetName("  Padded  ")).toBe("Padded");
    expect(sanitizeSheetName("'Quoted'")).toBe("Quoted");
    expect(sanitizeSheetName("History")).toBe("Sheet1");
    expect(sanitizeSheetName("HISTORY")).toBe("Sheet1");
    // Truncation to 31 chars can expose a new trailing apostrophe that must also be stripped.
    expect(sanitizeSheetName("x".repeat(30) + "'" + "y".repeat(10))).toBe("x".repeat(30));
  });

  it("filters unusable column requests down to the seven fields", () => {
    expect(usableColumns(["name", "nope", "start"])).toEqual(["name", "start"]);
    expect(usableColumns([])).toEqual(["id", "parentId", "name", "start", "end", "progress", "type"]);
    expect(usableColumns("name")).toHaveLength(7);
  });
});
