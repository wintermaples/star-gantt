/**
 * The two report writers (docs/specs/plugins/resource.md §3.6): the RFC 4180 CSV with its inclusive
 * ISO bucket stamps and duration-formatted quantities, and the self-contained A4-landscape
 * base-14-Helvetica PDF.
 */
import { describe, expect, it } from "vitest";
import { formatDurationMs } from "@stargantt/sdk";
import { bucketStamps, isoMinute, reportNumber, reportToCsv } from "../src/internal/load-chart/report-csv";
import { buildPageStreams, buildReportPdf, fitResourceName } from "../src/internal/load-chart/report-pdf";
import type { UtilizationReportRow } from "../src/internal/areas";
import { MONDAY, MS_DAY } from "./load-chart-fixtures";

const HEADERS = ["Resource", "From", "To", "Allocated", "Capacity", "Utilization"];
const duration = (ms: number): string => formatDurationMs(ms);

const rows: readonly UtilizationReportRow[] = [
  {
    resourceId: "r1",
    resourceName: "Alice",
    cells: [
      {
        start: MONDAY,
        end: MONDAY + MS_DAY,
        allocated: 4 * 3_600_000,
        capacity: 8 * 3_600_000,
        ratio: 0.5,
      },
      {
        start: MONDAY + MS_DAY,
        end: MONDAY + 2 * MS_DAY,
        allocated: 0,
        capacity: 0,
        ratio: null,
      },
    ],
  },
];

describe("the CSV report (§3.6)", () => {
  it("writes the header row, then one record per resource × bucket cell, CRLF-separated", () => {
    const csv = reportToCsv(rows, HEADERS, duration);
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(HEADERS.join(","));
    expect(lines[1]).toBe("Alice,2024-01-01,2024-01-01,4h,8h,0.5");
  });

  it("leaves the utilization field empty where the ratio is null", () => {
    expect(reportToCsv(rows, HEADERS, duration).split("\r\n")[2]?.endsWith(",")).toBe(true);
  });

  it("yields the header row alone for an empty report", () => {
    expect(reportToCsv([], HEADERS, duration)).toBe(HEADERS.join(","));
  });

  it("quotes a field holding a comma, a quote or a newline, doubling inner quotes", () => {
    const csv = reportToCsv(
      [{ resourceId: 1, resourceName: 'Ann "A", Ltd', cells: rows[0]?.cells ?? [] }],
      HEADERS,
      duration,
    );
    expect(csv).toContain('"Ann ""A"", Ltd"');
  });

  it("uses day-resolution inclusive stamps at a day or wider, minute resolution below", () => {
    expect(bucketStamps(MONDAY, MONDAY + MS_DAY)).toEqual({
      from: "2024-01-01",
      to: "2024-01-01",
    });
    expect(bucketStamps(MONDAY, MONDAY + 7 * MS_DAY)).toEqual({
      from: "2024-01-01",
      to: "2024-01-07",
    });
    expect(bucketStamps(MONDAY, MONDAY + 3_600_000)).toEqual({
      from: "2024-01-01T00:00Z",
      to: "2024-01-01T00:59Z",
    });
  });

  it("answers nothing for an unusable instant, exactly as `isoDay` does", () => {
    expect(isoMinute(Number.NaN)).toBeUndefined();
    expect(isoMinute(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(isoMinute(8.64e15 * 2)).toBeUndefined();
  });

  it("rounds the ratio to at most four fractional digits, without trailing zeros", () => {
    expect(reportNumber(0.123456)).toBe("0.1235");
    expect(reportNumber(0.5)).toBe("0.5");
    expect(reportNumber(2)).toBe("2");
    expect(reportNumber(Number.NaN)).toBe("");
  });
});

describe("the PDF report (§3.6)", () => {
  const text = (bytes: Uint8Array): string => {
    let out = "";
    for (const byte of bytes) out += String.fromCharCode(byte);
    return out;
  };

  it("produces a structurally complete PDF 1.4 file", () => {
    const bytes = buildReportPdf({
      title: "Resource utilization report",
      headers: HEADERS,
      lines: [["Alice", "2024-01-01", "2024-01-01", "4h", "8h", "0.5"]],
    });
    const body = text(bytes);
    expect(body.startsWith("%PDF-1.4\n")).toBe(true);
    expect(body.endsWith("%%EOF\n")).toBe(true);
    expect(body).toContain("/Type /Catalog");
    expect(body).toContain("/Type /Pages");
    // A4 landscape, in points, and the base-14 face that needs no embedding.
    expect(body).toContain("/MediaBox [0 0 842 595]");
    expect(body).toContain("/BaseFont /Helvetica");
    expect(body).toContain("\nxref\n");
    expect(body).toContain("\ntrailer\n");
    expect(bytes.byteLength).toBeGreaterThan(600);
    expect(bytes.byteLength).toBeLessThan(4000);
  });

  it("records a cross-reference entry per object, each at the object's own byte offset", () => {
    const bytes = buildReportPdf({ title: "T", headers: HEADERS, lines: [] });
    const body = text(bytes);
    const xrefAt = body.indexOf("\nxref\n");
    const entries = body.slice(xrefAt).match(/^\d{10} 00000 n $/gm) ?? [];
    // 1 catalog + 1 pages + 1 font + 1 page + 1 content stream.
    expect(entries).toHaveLength(5);
    const firstOffset = Number(entries[0]?.slice(0, 10));
    expect(body.slice(firstOffset, firstOffset + 7)).toBe("1 0 obj");
  });

  it("paginates long reports while sharing the one font object across every page", () => {
    const lines = Array.from({ length: 120 }, (_, i) => [
      `R${String(i)}`,
      "2024-01-01",
      "2024-01-01",
      "1h",
      "8h",
      "0.125",
    ]);
    const streams = buildPageStreams({ title: "T", headers: HEADERS, lines });
    expect(streams.length).toBeGreaterThan(1);
    const body = text(buildReportPdf({ title: "T", headers: HEADERS, lines }));
    expect(body.match(/\/BaseFont \/Helvetica/g)).toHaveLength(1);
    expect(body.match(/\/Type \/Page[^s]/g)).toHaveLength(streams.length);
  });

  it("replaces every non-Latin-1 codepoint with `?` and escapes the PDF string specials", () => {
    const body = text(
      buildReportPdf({
        title: "報告 (draft) \\ x",
        headers: HEADERS,
        lines: [],
      }),
    );
    expect(body).toContain("(?? \\(draft\\) \\\\ x)");
    for (const byte of body) expect(byte.charCodeAt(0)).toBeLessThanOrEqual(0xff);
  });

  it("ellipsizes a resource name too wide for its column", () => {
    expect(fitResourceName("short")).toBe("short");
    const long = "x".repeat(80);
    expect(fitResourceName(long)).toHaveLength(44);
    expect(fitResourceName(long).endsWith("...")).toBe(true);
  });
});
