/**
 * `src/internal/dom-walk.ts` — resolving an event target to the grid structure it landed in.
 *
 * The walk is structural, so these tests use plain objects rather than elements: that is exactly the
 * contract the module offers (an event target need not be an element at all).
 */
import { describe, expect, it } from "vitest";
import {
  isResizeHandle,
  locateCellIndex,
  locateHeaderColumn,
  locateRow,
} from "../src/internal/dom-walk";
import type { WalkNode } from "../src/internal/dom-walk";

/** A walkable node with the given class, attributes and parent. */
function node(
  className: string,
  attrs: Record<string, string> = {},
  parent: WalkNode | null = null,
): WalkNode {
  return {
    className,
    parentNode: parent,
    getAttribute: (name: string): string | null => attrs[name] ?? null,
  };
}

describe("locateRow", () => {
  it("finds the nearest ancestor carrying `data-row-index`", () => {
    const row = node("sg-grid-row", { "data-row-index": "7" });
    const cell = node("sg-grid-cell", {}, row);
    const inner = node("span", {}, cell);
    expect(locateRow(inner)).toEqual({ row: 7, toggle: false });
  });

  it("reports a walk that passed through the expand toggle", () => {
    const row = node("sg-grid-row", { "data-row-index": "2" });
    const toggle = node("sg-grid-toggle", {}, row);
    expect(locateRow(toggle)).toEqual({ row: 2, toggle: true });
  });

  it("treats a hidden slot's emptied `data-row-index` as no row", () => {
    expect(locateRow(node("sg-grid-row", { "data-row-index": "" }))).toBeUndefined();
  });

  it("declines a non-numeric `data-row-index`", () => {
    expect(locateRow(node("sg-grid-row", { "data-row-index": "nope" }))).toBeUndefined();
  });

  it("returns undefined for a target outside any row", () => {
    expect(locateRow(node("sg-grid-body"))).toBeUndefined();
  });

  it("returns undefined for a target that is not an object at all", () => {
    expect(locateRow(undefined)).toBeUndefined();
    expect(locateRow(null)).toBeUndefined();
    expect(locateRow("window")).toBeUndefined();
  });

  it("gives up rather than hanging on an over-deep (or cyclic) parent chain", () => {
    const row = node("sg-grid-row", { "data-row-index": "1" });
    let leaf: WalkNode = row;
    for (let i = 0; i < 40; i += 1) leaf = node("span", {}, leaf);
    expect(locateRow(leaf)).toBeUndefined();

    const cyclic: WalkNode = { className: "loop", getAttribute: () => null };
    cyclic.parentNode = cyclic;
    expect(locateRow(cyclic)).toBeUndefined();
  });
});

describe("locateCellIndex", () => {
  it("finds which of a row's cells the target sits in", () => {
    const cells = [node("a"), node("b"), node("c")] as unknown as HTMLElement[];
    const inner = node("span", {}, cells[1] as unknown as WalkNode);
    expect(locateCellIndex(inner, cells)).toBe(1);
    expect(locateCellIndex(cells[2], cells)).toBe(2);
  });

  it("returns undefined for a target in no cell of this row", () => {
    const cells = [node("a")] as unknown as HTMLElement[];
    expect(locateCellIndex(node("elsewhere"), cells)).toBeUndefined();
    expect(locateCellIndex(node("a"), [])).toBeUndefined();
  });
});

describe("locateHeaderColumn", () => {
  it("finds the nearest ancestor's `data-column-id`", () => {
    const cell = node("sg-grid-header-cell", { "data-column-id": "start" });
    const handle = node("sg-grid-header-resize-handle", {}, cell);
    expect(locateHeaderColumn(handle)).toBe("start");
  });

  it("returns undefined outside any header cell, and for an empty id", () => {
    expect(locateHeaderColumn(node("sg-grid-header"))).toBeUndefined();
    expect(locateHeaderColumn(node("x", { "data-column-id": "" }))).toBeUndefined();
  });

  // docs/specs/plugins/tree-grid.md § Internal modules — body cells carry `data-column-id` too
  // (so a host test can address a column by id), so this walk must not resolve one to a "header
  // column" just because the attribute is present.
  it("does not mistake a body cell carrying `data-column-id` for a header cell", () => {
    const bodyCell = node("sg-grid-cell", { "data-column-id": "start" });
    expect(locateHeaderColumn(bodyCell)).toBeUndefined();
    const inner = node("span", {}, bodyCell);
    expect(locateHeaderColumn(inner)).toBeUndefined();
  });
});

describe("isResizeHandle", () => {
  it("recognizes the handle itself only, not its ancestors", () => {
    const cell = node("sg-grid-cell sg-grid-header-cell", { "data-column-id": "name" });
    const handle = node("sg-grid-header-resize-handle", {}, cell);
    expect(isResizeHandle(handle)).toBe(true);
    expect(isResizeHandle(cell)).toBe(false);
    expect(isResizeHandle(null)).toBe(false);
  });
});
