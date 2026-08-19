/**
 * The row list the vertical gestures resolve against (docs/specs/plugins/interaction.md §1.3 "Row
 * drag"): rows come from the row model, so a `collapsedSummary: "split"` parent is one row
 * and one drop target however many bars it paints, and a task with no row of its own never forks a
 * gesture vertically.
 */
import { describe, expect, it } from "vitest";
import { hasOwnRow, viewportRows } from "../src/internal/drag/row-list";
import type { RowGeometry } from "../src/internal/drag/row-list";
import { rowDropAt } from "../src/internal/drag/row-drag";

/** A row model of uniform-height rows, `undefined` entries standing for task-less rows. */
function model(ids: (string | undefined)[], height = 20): RowGeometry {
  const heights = ids.map(() => height);
  const top = (row: number): number => heights.slice(0, row).reduce((a, b) => a + b, 0);
  return {
    rowCount: () => ids.length,
    taskIdAt: (row) => ids[row],
    rowOf: (id) => (ids.indexOf(id as string) < 0 ? undefined : ids.indexOf(id as string)),
    rowHeight: (row) => heights[row] ?? 0,
    yOf: top,
    rowAtY: (y) => Math.max(0, Math.floor(y / height)),
  };
}

describe("viewportRows", () => {
  it("lists every row of the band, in row order, viewport-local", () => {
    const rows = viewportRows(model(["a", "b", "c"]), { scrollTop: 0, height: 100 });
    expect(rows).toEqual([
      { id: "a", y: 0, height: 20 },
      { id: "b", y: 20, height: 20 },
      { id: "c", y: 40, height: 20 },
    ]);
  });

  it("subtracts the scroll offset and starts at the first row on screen", () => {
    const rows = viewportRows(model(["a", "b", "c", "d"]), { scrollTop: 40, height: 40 });
    expect(rows).toEqual([
      { id: "c", y: 0, height: 20 },
      { id: "d", y: 20, height: 20 },
    ]);
  });

  it("stops at the bottom of the band rather than walking the whole chart", () => {
    const many = model(Array.from({ length: 1000 }, (_, i) => `t${i}`));
    expect(viewportRows(many, { scrollTop: 0, height: 60 })).toHaveLength(3);
  });

  it("keeps a row whose task the model does not name — it still occupies space", () => {
    const rows = viewportRows(model(["a", undefined, "c"]), { scrollTop: 0, height: 100 });
    expect(rows.map((r) => r.id)).toEqual(["a", undefined, "c"]);
  });

  it("drops rows the model gives no height (filtered-out rows)", () => {
    const base = model(["a", "b", "c"]);
    const filtered: RowGeometry = { ...base, rowHeight: (row) => (row === 1 ? 0 : 20) };
    expect(viewportRows(filtered, { scrollTop: 0, height: 100 }).map((r) => r.id)).toEqual([
      "a",
      "c",
    ]);
  });

  it("answers nothing for an empty chart", () => {
    expect(viewportRows(model([]), { scrollTop: 0, height: 100 })).toEqual([]);
  });

  it("makes a split parent one drop target, where its children were several", () => {
    // The parent `p` owns the row; `c1` and `c2` are painted inside it and own no row.
    const rows = viewportRows(model(["p", "next"]), { scrollTop: 0, height: 100 });
    const drop = rowDropAt(15, rows, "next");
    // A point inside the parent's row names the gap below it — one gap, not one per child.
    expect(drop?.beforeId).toBe("p");
    expect(drop?.afterId).toBeUndefined();
    expect(drop?.lineY).toBe(20);
  });
});

describe("hasOwnRow", () => {
  const bars = { hasOwnBar: (id: string | number) => id === "painted" };

  it("is true for a task the row model places on a row", () => {
    expect(hasOwnRow(model(["a", "b"]), bars, "a")).toBe(true);
  });

  it("is false for an in-row child the row model does not place", () => {
    expect(hasOwnRow(model(["p"]), bars, "c1")).toBe(false);
  });

  it("falls back to the bar service when no row model is composed", () => {
    expect(hasOwnRow(undefined, bars, "painted")).toBe(true);
    expect(hasOwnRow(undefined, bars, "c1")).toBe(false);
  });
});
