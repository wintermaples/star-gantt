/**
 * `src/internal/column-track.ts` — the one source of truth for which columns the grid shows and how
 * wide each one is, including its resize overrides.
 */
import { describe, expect, it } from "vitest";
import type { ColumnDef } from "../src/types";
import { createColumnTrack } from "../src/internal/column-track";
import { asElement } from "./_harness/index";
import { unitColumn } from "./_units";
import { unitDoc } from "./_units-dom";

describe("createColumnTrack — composition", () => {
  it("adopts the reduction on first refresh and reports the change", () => {
    const columns = [unitColumn("name"), unitColumn("start")];
    const track = createColumnTrack(() => columns);
    expect(track.list()).toEqual([]);
    expect(track.refresh()).toBe(true);
    expect(track.list().map((c) => c.id)).toEqual(["name", "start"]);
  });

  it("reports no change while the reduction keeps returning the same array", () => {
    const columns = [unitColumn("name")];
    const track = createColumnTrack(() => columns);
    track.refresh();
    expect(track.refresh()).toBe(false);
    expect(track.refresh()).toBe(false);
  });

  it("reports a change when the reduction yields a different array", () => {
    let columns = [unitColumn("name")];
    const track = createColumnTrack(() => columns);
    track.refresh();
    columns = [unitColumn("name"), unitColumn("end")];
    expect(track.refresh()).toBe(true);
    expect(track.list().map((c) => c.id)).toEqual(["name", "end"]);
  });

  it("keeps its own copy, so mutating the contributed array in place changes nothing", () => {
    const columns = [unitColumn("name")];
    const track = createColumnTrack(() => columns);
    track.refresh();
    columns.push(unitColumn("sneaky"));
    expect(track.list().map((c) => c.id)).toEqual(["name"]);
  });

  it("treats a non-array reduction as no columns", () => {
    const track = createColumnTrack(() => undefined as unknown as ColumnDef[]);
    expect(track.refresh()).toBe(true);
    expect(track.list()).toEqual([]);
  });

  it("answers `find` / `indexOf` off the composed order", () => {
    const track = createColumnTrack(() => [unitColumn("name"), unitColumn("end")]);
    track.refresh();
    expect(track.find("end")?.header).toBe("END");
    expect(track.indexOf("end")).toBe(1);
    expect(track.find("nope")).toBeUndefined();
    expect(track.indexOf("nope")).toBe(-1);
  });
});

describe("createColumnTrack — widths", () => {
  it("prefers a resize override over the declared `ColumnDef.width`", () => {
    const column = unitColumn("name", { width: 220 });
    const track = createColumnTrack(() => [column]);
    track.refresh();
    expect(track.widthOf(column)).toBe(220);
    track.setWidth("name", 300);
    expect(track.widthOf(column)).toBe(300);
    // The `ColumnDef` object itself is never mutated.
    expect(column.width).toBe(220);
  });

  it("reports no width for a column that declares none and has no override", () => {
    const column = unitColumn("name");
    const track = createColumnTrack(() => [column]);
    track.refresh();
    expect(track.widthOf(column)).toBeUndefined();
  });

  it("measures a laid-out width off the registered header cell", () => {
    const doc = unitDoc();
    const track = createColumnTrack(() => [unitColumn("name")]);
    track.refresh();
    const cell = doc.createElement("div");
    cell.rect = { left: 0, top: 0, width: 137, height: 24 };
    track.setHeaderCell("name", asElement(cell));
    expect(track.measuredWidthOf("name")).toBe(137);
    expect(track.headerCell("name")).toBe(asElement(cell));
  });

  it("reports no measured width before the header is laid out, and never a zero-width guess", () => {
    const doc = unitDoc();
    const track = createColumnTrack(() => [unitColumn("name")]);
    track.refresh();
    expect(track.measuredWidthOf("name")).toBeUndefined();

    const cell = doc.createElement("div");
    cell.rect = { left: 0, top: 0, width: 0, height: 0 };
    track.setHeaderCell("name", asElement(cell));
    expect(track.measuredWidthOf("name")).toBeUndefined();
  });

  it("forgets every header cell on `clearHeaderCells`, keeping the width overrides", () => {
    const doc = unitDoc();
    const column = unitColumn("name");
    const track = createColumnTrack(() => [column]);
    track.refresh();
    const cell = doc.createElement("div");
    cell.rect = { left: 0, top: 0, width: 90, height: 24 };
    track.setHeaderCell("name", asElement(cell));
    track.setWidth("name", 111);

    track.clearHeaderCells();
    expect([...track.headerCells()]).toEqual([]);
    expect(track.measuredWidthOf("name")).toBeUndefined();
    expect(track.widthOf(column)).toBe(111);
  });

  it("enumerates the header cells in registration order", () => {
    const doc = unitDoc();
    const track = createColumnTrack(() => [unitColumn("a"), unitColumn("b")]);
    track.refresh();
    track.setHeaderCell("a", asElement(doc.createElement("div")));
    track.setHeaderCell("b", asElement(doc.createElement("div")));
    expect([...track.headerCells()].map(([id]) => id)).toEqual(["a", "b"]);
  });

  it("reports only the declared widths before any header cell is registered", () => {
    const track = createColumnTrack(() => [
      unitColumn("name", { width: 220 }),
      unitColumn("end"),
    ]);
    track.refresh();
    expect(track.widths()).toEqual(new Map([["name", 220]]));
  });

  it("prefers a resize override over the declared width in `widths()` too", () => {
    const column = unitColumn("name", { width: 220 });
    const track = createColumnTrack(() => [column]);
    track.refresh();
    track.setWidth("name", 300);
    expect(track.widths()).toEqual(new Map([["name", 300]]));
  });

  it("adds a width-less column to `widths()` only once its header cell measures non-zero", () => {
    const doc = unitDoc();
    const track = createColumnTrack(() => [unitColumn("name")]);
    track.refresh();
    expect(track.widths()).toEqual(new Map());

    const cell = doc.createElement("div");
    cell.rect = { left: 0, top: 0, width: 0, height: 0 };
    track.setHeaderCell("name", asElement(cell));
    expect(track.widths()).toEqual(new Map());

    cell.rect = { left: 0, top: 0, width: 137, height: 24 };
    expect(track.widths()).toEqual(new Map([["name", 137]]));
  });
});
