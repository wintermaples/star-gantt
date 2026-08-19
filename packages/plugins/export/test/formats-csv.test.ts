// @vitest-environment happy-dom
// docs/specs/plugins/export.md §1.4 — CSV export/import.
import { afterEach, describe, expect, it } from "vitest";
import {
  inferMapping,
  isoOrRaw,
  parseCsvRows,
  parseCsvTasks,
  parseDateCell,
  parseProgressCell,
  serializeCsv,
} from "../src/internal/formats/csv";
import { DISPOSED_MESSAGE } from "../src/internal/wiring";
import { boot, DAY, sampleData } from "./_boot";
import type { Booted } from "./_boot";

let booted: Booted | undefined;
afterEach(() => {
  booted?.dispose();
  booted = undefined;
});

describe("CSV export (service)", () => {
  it("writes a header row and one quoted-when-needed row per task", () => {
    const { tasks, resources, assignments } = sampleData();
    booted = boot({ tasks, resources, assignments });
    const csv = booted.service.exportCsv();
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe("id,parentId,name,start,end,progress,type");
    expect(lines).toHaveLength(5);
    expect(lines[1]).toBe(
      `a,,Design phase,${new Date(0).toISOString()},${new Date(10 * DAY).toISOString()},,summary`,
    );
    // Comma and quotes in a name force RFC 4180 quoting with doubled quotes.
    expect(lines[3]).toContain('"Visual, ""final"" design"');
  });

  it("returns a string (raw epoch cell) for a date outside the Date range instead of throwing", () => {
    const { tasks } = sampleData();
    booted = boot({ tasks });
    booted.dispatch("task/update", { id: "m1", after: { start: 1e16, end: 1e16 } });
    const csv = booted.service.exportCsv();
    expect(csv).toContain("m1,,Launch,10000000000000000,10000000000000000");
  });

  it("honors delimiter and column selection; unusable options fall back to the nest", () => {
    const { tasks } = sampleData();
    booted = boot({ tasks, config: { importExport: { csvDelimiter: "," } } });
    const csv = booted.service.exportCsv({ delimiter: ";", columns: ["name", "progress"] });
    expect(csv.startsWith("name;progress\r\n")).toBe(true);
    const fallback = booted.service.exportCsv({ delimiter: "long", columns: ["nope"] as never });
    expect(fallback.startsWith("id,parentId,name,")).toBe(true);
    expect(booted.errors).toHaveLength(0);
  });

  it("§1.4 — an unusable per-call delimiter falls back to the configured nest, not a bare comma", () => {
    const { tasks } = sampleData();
    booted = boot({ tasks, config: { importExport: { csvDelimiter: ";" } } });
    const csv = booted.service.exportCsv({ delimiter: "nope" as never });
    expect(csv.startsWith("id;parentId;name;")).toBe(true);
  });

  it("prefixes a BOM only when requested", () => {
    booted = boot();
    expect(booted.service.exportCsv().charCodeAt(0)).not.toBe(0xfeff);
    expect(booted.service.exportCsv({ bom: true }).charCodeAt(0)).toBe(0xfeff);
  });

  // Review m1 — every facade member checks `ExportWiring.disposed()` at entry, the same guard the
  // image path (`../../src/index.ts`'s `begin()`) already enforces, so a call against a disposed
  // instance fails the same way regardless of which of the four areas answers it.
  it("throws the disposed-instance error once the plugin is torn down", () => {
    booted = boot();
    booted.dispose();
    expect(() => booted?.service.exportCsv()).toThrowError(DISPOSED_MESSAGE);
  });
});

describe("CSV tokenizer and cell parsing", () => {
  it("handles quotes, embedded delimiters/newlines and CRLF", () => {
    expect(parseCsvRows('a,"b,c","d""e"\r\n"f\ng",h')).toEqual([
      ["a", "b,c", 'd"e'],
      ["f\ng", "h"],
    ]);
  });

  it("parses epoch, ISO date (- and /) and Date.parse text; rejects garbage", () => {
    expect(parseDateCell("86400000")).toBe(DAY);
    expect(parseDateCell("1970-01-02")).toBe(DAY);
    expect(parseDateCell("1970/1/2")).toBe(DAY);
    expect(parseDateCell("nonsense")).toBeUndefined();
  });

  // §1.4 — a bare-integer cell outside the plausible 1970-01-01..2200-12-31 epoch-ms window (with
  // `0` itself the one exception) is rejected rather than silently landing as a bogus 1970 date.
  it("rejects a bare-integer cell in the implausible sub-day epoch-ms band (spreadsheet serial)", () => {
    // 45300 misread as raw epoch-ms is 1970-01-01T00:00:45.300Z — nonsense as a real date, and
    // exactly the magnitude a spreadsheet date serial (day-count since ~1900) lands in.
    expect(parseDateCell("45300")).toBeUndefined();
  });

  it("keeps 0 (exact 1970-01-01 midnight) and any full-day-or-later bare integer", () => {
    expect(parseDateCell("0")).toBe(0);
    expect(parseDateCell("86400000")).toBe(DAY);
    expect(parseDateCell(String(100 * DAY))).toBe(100 * DAY);
  });

  it("rejects a bare integer past the 2200-12-31 upper bound, and a negative one", () => {
    expect(parseDateCell("9999999999999")).toBeUndefined(); // year ~2286
    expect(parseDateCell("-1")).toBeUndefined();
  });

  it("parses fraction, percent-suffixed and 0..100 progress", () => {
    expect(parseProgressCell("0.4")).toBe(0.4);
    expect(parseProgressCell("40%")).toBe(0.4);
    expect(parseProgressCell("40")).toBe(0.4);
    expect(parseProgressCell("1")).toBe(1);
    expect(parseProgressCell("240")).toBeUndefined();
  });

  it("a % suffix always means percent, even at or below 1", () => {
    expect(parseProgressCell("0.5%")).toBe(0.005);
    expect(parseProgressCell("1%")).toBe(0.01);
    expect(parseProgressCell("100%")).toBe(1);
  });

  it("isoOrRaw falls back to the raw number outside Date's representable range", () => {
    expect(isoOrRaw(0)).toBe(new Date(0).toISOString());
    expect(isoOrRaw(1e16)).toBe("10000000000000000");
    expect(isoOrRaw(Number.NaN)).toBe("NaN");
  });
});

describe("CSV import (service)", () => {
  it("infers the mapping from common header aliases", () => {
    expect(inferMapping(["Task ID", "Task", "Start Date", "Finish", "% Complete", "Parent", "Type"])).toEqual([
      "id",
      "name",
      "start",
      "end",
      "progress",
      "parentId",
      "type",
    ]);
    // A header no alias matches, and a duplicate alias, both map to null.
    expect(inferMapping(["name", "title", "whatever"])).toEqual(["name", null, null]);
  });

  it("parses a CSV file into normalized tasks", () => {
    booted = boot();
    const result = booted.service.importCsv(
      "id,name,start,end,progress,parent\r\n" +
        "x,Root,1970-01-01,1970-01-11,,\r\n" +
        "x1,Child,1970-01-01,1970-01-04,40%,x\r\n",
      { dryRun: true },
    );
    expect(result.document.issues).toEqual([]);
    expect(result.document.tasks).toEqual([
      { id: "x", parentId: null, name: "Root", start: 0, end: 10 * DAY },
      { id: "x1", parentId: "x", name: "Child", start: 0, end: 3 * DAY, progress: 0.4 },
    ]);
    expect(result.document.mapping).toEqual(["id", "name", "start", "end", "progress", "parentId"]);
  });

  it("mints ids when no id column exists and flags bad rows without dropping the good ones", () => {
    booted = boot();
    const result = booted.service.importCsv(
      "name,start,end\n" +
        "Good,1970-01-01,1970-01-02\n" +
        ",1970-01-01,1970-01-02\n" + // missing name
        "BadDate,huh,1970-01-02\n" + // unreadable start
        "Backwards,1970-01-05,1970-01-02\n", // end before start
      { dryRun: true },
    );
    expect(result.document.tasks).toEqual([{ id: "import-1", parentId: null, name: "Good", start: 0, end: DAY }]);
    expect(result.document.issues.map((i) => i.code)).toEqual(["missing-field", "bad-date", "invalid-row"]);
  });

  it("flags a row whose start is a spreadsheet-serial-shaped bare integer as bad-date", () => {
    booted = boot();
    const result = booted.service.importCsv("name,start,end\nSuspect,45300,86400000\n", { dryRun: true });
    expect(result.document.tasks).toEqual([]);
    expect(result.document.issues).toEqual([{ code: "bad-date", field: "start", value: "45300", row: 1 }]);
  });

  it("keeps the first of duplicate ids and flags the rest", () => {
    booted = boot();
    const result = booted.service.importCsv("id,name,start,end\nd,First,0,86400000\nd,Second,0,86400000\n", {
      dryRun: true,
    });
    expect(result.document.tasks.map((t) => t.name)).toEqual(["First"]);
    expect(result.document.issues).toEqual([{ code: "duplicate-id", taskId: "d", row: 2 }]);
  });

  it("respects an explicit mapping over inference", () => {
    booted = boot();
    const result = booted.service.importCsv("col1,col2,col3\nTask A,0,86400000\n", {
      mapping: ["name", "start", "end"],
      dryRun: true,
    });
    expect(result.document.tasks).toEqual([{ id: "import-1", parentId: null, name: "Task A", start: 0, end: DAY }]);
  });

  it("round-trips its own export to an empty diff", () => {
    const { tasks } = sampleData();
    booted = boot({ tasks });
    const result = booted.service.importCsv(booted.service.exportCsv(), { dryRun: true });
    expect(result.document.issues).toEqual([]);
    expect(result.changes).toEqual([]);
  });

  it("round-trips at a non-default delimiter with quoted delimiter and CRLF in a cell", () => {
    booted = boot({ config: { importExport: { csvDelimiter: ";" } } });
    booted.dispatch("task/add", {
      task: { id: "tricky", parentId: null, name: 'A;B "quoted"\r\nsecond line', start: 0, end: DAY },
    });
    const result = booted.service.importCsv(booted.service.exportCsv(), { dryRun: true });
    expect(result.document.issues).toEqual([]);
    expect(result.document.tasks.find((t) => t.id === "tricky")?.name).toBe('A;B "quoted"\r\nsecond line');
    expect(result.changes).toEqual([]);
  });

  it("a non-string text argument yields an empty document", () => {
    booted = boot();
    const result = booted.service.importCsv(undefined as unknown as string, { dryRun: true });
    expect(result.document).toEqual({ format: "csv", tasks: [], links: [], resources: [], assignments: [], issues: [] });
  });
});

describe("parseCsvTasks (unit)", () => {
  it("an unusable mapping entry falls back to null for that column", () => {
    const parsed = parseCsvTasks("a,b\nx,y\n", ["name", "not-a-field" as never]);
    expect(parsed.mapping).toEqual(["name", null]);
  });
});

describe("serializeCsv (unit)", () => {
  it("falls back to all seven fields for an empty columns array", () => {
    const csv = serializeCsv([], { columns: [] });
    expect(csv.split("\r\n")[0]).toBe("id,parentId,name,start,end,progress,type");
  });
});
