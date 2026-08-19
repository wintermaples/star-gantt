// docs/specs/plugins/interaction.md §6.7 — the tab-separated cell encoding, hostless: no
// `Gantt.create()` or DOM involved. Covers encoding-only assertions (the paste-flow assertions
// are covered in `clipboard-wire.test.ts`, which exercises the wired feature end to end).
import { describe, expect, it } from "vitest";
import {
  DEFAULT_COLUMNS,
  parseRow,
  resolveColumns,
  serializeRows,
  splitTsv,
} from "../src/internal/clipboard/tsv";

const DAY = 86_400_000;

describe("resolveColumns", () => {
  it("keeps known columns and drops unknown ones", () => {
    expect(resolveColumns(["progress", "bogus", "name"])).toEqual(["progress", "name"]);
  });

  it("falls back to the default on an unusable or empty configuration", () => {
    expect(resolveColumns(undefined)).toEqual(DEFAULT_COLUMNS);
    expect(resolveColumns("name")).toEqual(DEFAULT_COLUMNS);
    expect(resolveColumns([])).toEqual(DEFAULT_COLUMNS);
    expect(resolveColumns(["bogus"])).toEqual(DEFAULT_COLUMNS);
  });
});

describe("serializeRows", () => {
  it("writes one TSV line per row in column order, dates as ISO UTC days", () => {
    const text = serializeRows(
      [{ name: "Alpha", start: 0, end: DAY, progress: 0.5 }],
      DEFAULT_COLUMNS,
    );
    expect(text).toBe("Alpha\t1970-01-01\t1970-01-02\t0.5");
  });

  it("leaves missing fields as an empty cell", () => {
    expect(serializeRows([{ name: "Only a name" }], DEFAULT_COLUMNS)).toBe("Only a name\t\t\t");
  });

  it("joins multiple rows with newlines", () => {
    const text = serializeRows(
      [{ name: "A" }, { name: "B" }],
      ["name"],
    );
    expect(text).toBe("A\nB");
  });
});

describe("splitTsv", () => {
  it("splits rows and cells, dropping one trailing blank line from a final newline", () => {
    expect(splitTsv("A\tB\nC\tD\n")).toEqual([
      ["A", "B"],
      ["C", "D"],
    ]);
  });

  it("keeps an interior blank line as an empty row", () => {
    expect(splitTsv("A\n\nB")).toEqual([["A"], [""], ["B"]]);
  });

  it("accepts CRLF and lone-CR line endings", () => {
    expect(splitTsv("A\r\nB\rC")).toEqual([["A"], ["B"], ["C"]]);
  });
});

describe("parseRow", () => {
  it("reads name/date/progress cells in column order", () => {
    const fields = parseRow(["Task", "1970-01-03", "1970-01-04", "0.25"], DEFAULT_COLUMNS);
    expect(fields).toEqual({ name: "Task", start: 2 * DAY, end: 3 * DAY, progress: 0.25 });
  });

  it("leaves empty and unusable cells alone", () => {
    expect(parseRow(["", "not-a-date", "", "not-a-number"], DEFAULT_COLUMNS)).toEqual({});
  });

  it("accepts a percent-suffixed or bare-percentage progress cell", () => {
    expect(parseRow(["", "", "", "75%"], DEFAULT_COLUMNS).progress).toBe(0.75);
    expect(parseRow(["", "", "", "40"], DEFAULT_COLUMNS).progress).toBe(0.4);
    expect(parseRow(["", "", "", "0.6"], DEFAULT_COLUMNS).progress).toBe(0.6);
  });

  it("rejects an out-of-range progress cell", () => {
    expect(parseRow(["", "", "", "150"], DEFAULT_COLUMNS).progress).toBeUndefined();
    expect(parseRow(["", "", "", "-1"], DEFAULT_COLUMNS).progress).toBeUndefined();
  });

  it("accepts any Date.parse-able string for a date cell, not only ISO UTC days", () => {
    const fields = parseRow(["", "2024-06-01T00:00:00Z"], ["name", "start"]);
    expect(fields.start).toBe(Date.parse("2024-06-01T00:00:00Z"));
  });

  it("trims cell whitespace before interpreting it", () => {
    expect(parseRow(["  Task  "], ["name"])).toEqual({ name: "Task" });
  });

  it("respects a configured column subset and order", () => {
    expect(parseRow(["0.9", "Task"], ["progress", "name"])).toEqual({ progress: 0.9, name: "Task" });
  });
});
