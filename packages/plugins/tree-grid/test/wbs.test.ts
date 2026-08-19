/**
 * WBS code computation, their ordering, and the read-only numbering column the `wbs` option
 * prepends — including the brand that keeps the tree indentation off it. Pure logic.
 */
import { describe, expect, it } from "vitest";
import { compareWbsCodes, computeWbsCodes, wbsColumnDef } from "../src/internal/wbs";
import { isWbsColumn, markWbsColumn, treeColumnIndex } from "../src/internal/tree-column";
import type { ColumnDef } from "../src/types";
import { fakeData, task } from "./_data";

/** A minimal column, for the placement and branding assertions. */
function unitColumn(id: string, extra: Partial<ColumnDef> = {}): ColumnDef {
  return {
    id,
    header: id,
    render: () => {},
    getValue: () => id,
    ...extra,
  };
}

/** A stand-in for the cell element `render` writes into. */
function cellStub(): HTMLElement & { attributes: Record<string, string> } {
  const attributes: Record<string, string> = {};
  return {
    textContent: "",
    attributes,
    setAttribute(name: string, value: string): void {
      attributes[name] = value;
    },
  } as unknown as HTMLElement & { attributes: Record<string, string> };
}

describe("WBS codes", () => {
  it("numbers the tree 1-based per sibling group", () => {
    const view = fakeData([
      task("a", null),
      task("a1", "a"),
      task("a2", "a"),
      task("b", null),
      task("b1", "b"),
    ]).query();
    const codes = computeWbsCodes(view);
    expect(codes.get("a")).toBe("1");
    expect(codes.get("a1")).toBe("1.1");
    expect(codes.get("a2")).toBe("1.2");
    expect(codes.get("b")).toBe("2");
    expect(codes.get("b1")).toBe("2.1");
  });

  it("follows the data, not the view — depth is unbounded", () => {
    const view = fakeData([
      task("r", null),
      task("c", "r"),
      task("g", "c"),
      task("gg", "g"),
    ]).query();
    expect(computeWbsCodes(view).get("gg")).toBe("1.1.1.1");
  });

  it("is empty for an empty store", () => {
    expect(computeWbsCodes(fakeData([]).query()).size).toBe(0);
  });

  it("orders codes numerically per segment", () => {
    expect(compareWbsCodes("1.2", "1.10")).toBeLessThan(0);
    expect(compareWbsCodes("2", "1.10")).toBeGreaterThan(0);
    expect(compareWbsCodes("1.1", "1.1")).toBe(0);
    expect(compareWbsCodes("1", "1.1")).toBeLessThan(0);
  });
});

describe("the WBS column", () => {
  it("is read-only, 70 px wide and contributed at the built-in weight", () => {
    const column = wbsColumnDef("WBS", () => "1.1");
    expect(column.id).toBe("wbs");
    expect(column.header).toBe("WBS");
    expect(column.width).toBe(70);
    expect(column.weight).toBe(0);
    expect(column.setValue).toBeUndefined();
  });

  it("renders the code and carries the full code as a title", () => {
    const column = wbsColumnDef("WBS", () => "1.2.3");
    const cell = cellStub();
    column.render(cell, task("t", null));
    expect(cell.textContent).toBe("1.2.3");
    expect(cell.attributes["title"]).toBe("1.2.3");
  });

  it("sorts by the code, numerically per segment", () => {
    const codes = new Map([
      ["x", "1.10"],
      ["y", "1.2"],
    ]);
    const column = wbsColumnDef("WBS", (id) => codes.get(String(id)) ?? "");
    expect(column.compare?.(task("x", null), task("y", null))).toBeGreaterThan(0);
  });
});

describe("the WBS column brand", () => {
  it("marks the column the `wbs` option contributes, and nothing else", () => {
    expect(isWbsColumn(wbsColumnDef("WBS", () => "1.1"))).toBe(true);
    expect(isWbsColumn(unitColumn("name"))).toBe(false);
  });

  it("does not follow the id: a foreign column called `wbs` is ordinary", () => {
    expect(isWbsColumn(unitColumn("wbs", { width: 70 }))).toBe(false);
  });

  it("survives the object spread a cell-renderer override performs", () => {
    const wrapped = { ...wbsColumnDef("WBS", () => "1"), render: (): void => {} };
    expect(isWbsColumn(wrapped)).toBe(true);
  });

  it("returns the same object it branded", () => {
    const column = unitColumn("wbs");
    expect(markWbsColumn(column)).toBe(column);
  });

  it("keeps the tree indentation on the column after the numbering column", () => {
    const columns = [wbsColumnDef("WBS", () => "1"), unitColumn("name"), unitColumn("start")];
    expect(treeColumnIndex(columns)).toBe(1);
  });
});
