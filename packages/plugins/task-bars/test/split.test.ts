/**
 * `src/internal/split.ts` — which children a split row shows.
 *
 * A child whose own row the `rows/height` reduction put at 0 is hidden and is excluded from the
 * split row outright, while a child with no row of its own — what every child of a collapsed
 * summary looks like — is exactly what the row draws.
 */
import { describe, expect, it } from "vitest";
import type { TaskId } from "@stargantt/plugin-data-store";
import type { TaskTreeReader } from "../src/internal/deps";
import { childIdsOf, isRowHidden, visibleChildIdsOf } from "../src/internal/split";
import { rowsOf } from "./_fakes";

/** A child index over one parent, as the store's `query().children` exposes it. */
function tree(children: readonly TaskId[]): TaskTreeReader {
  return { query: () => ({ children: new Map([["p", children]]) }) as never };
}

describe("childIdsOf", () => {
  it("answers the direct children in store order, and an empty list for a leaf", () => {
    expect(childIdsOf(tree(["a", "b"]), "p")).toEqual(["a", "b"]);
    expect(childIdsOf(tree(["a", "b"]), "a")).toEqual([]);
  });
});

describe("isRowHidden", () => {
  const rows = rowsOf({ order: ["p", "a", "b"], zeroHeight: ["b"] });

  it("is false for a task with a row of its own space", () => {
    expect(isRowHidden(rows, "a")).toBe(false);
  });

  it("is true for a task whose row was reduced to height 0", () => {
    expect(isRowHidden(rows, "b")).toBe(true);
  });

  it("is false for a task the row model does not know at all", () => {
    expect(isRowHidden(rows, "elsewhere")).toBe(false);
  });

  it("asks by task, so a child with no visible row still answers", () => {
    // What a split row actually draws: children inside a collapsed parent, which hold no row index
    // — one of them filtered out. The height resolution answers for both regardless.
    const collapsed = rowsOf({ order: ["p"], hidden: ["a", "b"], zeroHeight: ["b"] });
    expect(isRowHidden(collapsed, "a")).toBe(false);
    expect(isRowHidden(collapsed, "b")).toBe(true);
  });
});

describe("visibleChildIdsOf", () => {
  it("keeps every child, and the list itself, while none is hidden", () => {
    const data = tree(["a", "b"]);
    const rows = rowsOf({ order: ["p"] });
    const all = childIdsOf(data, "p");
    // The common case allocates nothing: the store's own list is handed straight back.
    expect(visibleChildIdsOf(data, rows, "p")).toBe(all);
  });

  it("drops a child whose own row is hidden and keeps store order for the rest", () => {
    const data = tree(["a", "b", "c"]);
    const rows = rowsOf({ order: ["p", "b"], zeroHeight: ["b"] });
    expect(visibleChildIdsOf(data, rows, "p")).toEqual(["a", "c"]);
  });

  it("drops a hidden child of a collapsed parent, which holds no row index of its own", () => {
    // The case the split row is actually made of: `p` is collapsed, so none of its children has a
    // row, and a filter has reduced `b` to height 0.
    const data = tree(["a", "b", "c"]);
    const rows = rowsOf({ order: ["p"], hidden: ["a", "b", "c"], zeroHeight: ["b"] });
    expect(visibleChildIdsOf(data, rows, "p")).toEqual(["a", "c"]);
  });

  it("answers an empty list when every child is hidden", () => {
    const data = tree(["a", "b"]);
    const rows = rowsOf({ order: ["p", "a", "b"], zeroHeight: ["a", "b"] });
    expect(visibleChildIdsOf(data, rows, "p")).toEqual([]);
  });
});
