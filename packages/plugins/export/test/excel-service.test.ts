// @vitest-environment happy-dom
// docs/specs/plugins/export.md §1.8 — the `toXlsx` facade member. `downloadXlsx` is not part of
// the surface (§1.9's fold map), so those cases are dropped rather than adapted.
import { afterEach, describe, expect, it } from "vitest";
import { DISPOSED_MESSAGE } from "../src/internal/wiring";
import { boot, sampleData } from "./_boot";
import type { Booted } from "./_boot";
import { sheetGrid, sheetNameOf } from "./_unzip";

let booted: Booted | undefined;
afterEach(() => {
  booted?.dispose();
  booted = undefined;
});

describe("toXlsx", () => {
  it("writes one header row plus one row per task, in store insertion order", () => {
    const { tasks, resources, assignments } = sampleData();
    booted = boot({ tasks, resources, assignments });
    const bytes = booted.service.toXlsx();
    expect(sheetNameOf(bytes)).toBe("Tasks");
    const rows = sheetGrid(bytes);
    expect(rows[0]).toEqual(["id", "parentId", "name", "start", "end", "progress", "type"]);
    expect(rows).toHaveLength(5);
    // Trailing empty cells are not written, so the row ends at its last non-empty column.
    expect(rows[2]).toEqual(["a1", "a", "Wireframes", "1970-01-01T00:00:00.000Z", "1970-01-04T00:00:00.000Z", "1"]);
    // Quotes survive the XML round trip.
    expect(rows[3]).toEqual([
      "a2",
      "a",
      'Visual, "final" design',
      "1970-01-04T00:00:00.000Z",
      "1970-01-09T00:00:00.000Z",
      "0.4",
    ]);
    expect(booted.errors).toEqual([]);
  });

  it("honors column selection and per-call sheet name, falling back on unusable values", () => {
    const { tasks } = sampleData();
    booted = boot({ tasks, config: { excel: { sheetName: "Plan" } } });
    const picked = booted.service.toXlsx({ columns: ["name", "start", "end"], sheetName: "Q1: []" });
    expect(sheetNameOf(picked)).toBe("Q1"); // sanitized per-call name wins
    expect(sheetGrid(picked)[0]).toEqual(["name", "start", "end"]);

    const fallback = booted.service.toXlsx({ columns: [], sheetName: "///" });
    expect(sheetNameOf(fallback)).toBe("Plan"); // unusable per-call name → factory sheetName
    expect(sheetGrid(fallback)[0]).toHaveLength(7);
  });

  it("is deterministic and exports an empty store as a lone header row", () => {
    booted = boot();
    const first = booted.service.toXlsx();
    expect(sheetGrid(first)).toEqual([["id", "parentId", "name", "start", "end", "progress", "type"]]);
    // Identical store state → byte-identical output (no timestamps in the package).
    expect(new Uint8Array(first)).toEqual(new Uint8Array(booted.service.toXlsx()));
  });

  it("consumes formats' guarded cell-text builder: an out-of-Date-range date exports as raw text instead of throwing", () => {
    booted = boot({ tasks: [{ id: "x", parentId: null, name: "Far", start: 1e16, end: 1e16 }] });
    expect(() => booted?.service.toXlsx()).not.toThrow();
    // Trailing empty cells (progress, type) are not written, so the row ends at "end".
    expect(sheetGrid(booted.service.toXlsx())[1]).toEqual(["x", "", "Far", "10000000000000000", "10000000000000000"]);
  });

  // Review m1 — every facade member checks `ExportWiring.disposed()` at entry, the same guard the
  // image path (`../../src/index.ts`'s `begin()`) already enforces.
  it("throws the disposed-instance error once the plugin is torn down", () => {
    booted = boot();
    booted.dispose();
    expect(() => booted?.service.toXlsx()).toThrowError(DISPOSED_MESSAGE);
  });
});
