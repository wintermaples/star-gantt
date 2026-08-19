/**
 * The visible row set + row-index⇔TaskId cross-lookup, row height geometry.
 * Exercised directly against `RowModel`, which is pure logic (no core, no DOM).
 */
import { describe, expect, it } from "vitest";
import type { ResolvedRowHeight } from "../src/types";
import { DEFAULT_ROW_HEIGHT, RowModel, defaultRowHeightResolver } from "../src/internal/row-model";
import { fakeData, task } from "./_data";

const H = DEFAULT_ROW_HEIGHT;

function fixed(tasks: Parameters<typeof fakeData>[0]): RowModel {
  return new RowModel(fakeData(tasks), () => defaultRowHeightResolver);
}

function withHeights(tasks: Parameters<typeof fakeData>[0], fn: ResolvedRowHeight): RowModel {
  return new RowModel(fakeData(tasks), () => fn);
}

/** p0 > (c0, c1), p1 > (c2) */
const tree = [
  task("p0", null),
  task("c0", "p0"),
  task("c1", "p0"),
  task("p1", null),
  task("c2", "p1"),
];

describe("RowModel — flattening", () => {
  it("flattens the tree depth-first in child order", () => {
    const m = fixed(tree);
    expect(m.rowCount()).toBe(5);
    expect([0, 1, 2, 3, 4].map((r) => m.taskIdAt(r))).toEqual(["p0", "c0", "c1", "p1", "c2"]);
  });

  it("cross-looks up row index from task id and back", () => {
    const m = fixed(tree);
    expect(m.rowOf("c1")).toBe(2);
    expect(m.rowOf("p1")).toBe(3);
    expect(m.rowOf("nope")).toBeUndefined();
    expect(m.taskIdAt(-1)).toBeUndefined();
    expect(m.taskIdAt(5)).toBeUndefined();
  });

  it("records tree depth and which rows have children", () => {
    const m = fixed(tree);
    expect([0, 1, 2, 3, 4].map((r) => m.depthAt(r))).toEqual([0, 1, 1, 0, 1]);
    expect([0, 1, 2, 3, 4].map((r) => m.hasChildrenAt(r))).toEqual([true, false, false, true, false]);
  });

  it("is empty when there is no data", () => {
    const m = fixed([]);
    expect(m.rowCount()).toBe(0);
    expect(m.totalHeight()).toBe(0);
    expect(m.rowAtY(0)).toBe(0);
    expect(m.rowAtY(999)).toBe(0);
    expect(m.yOf(0)).toBe(0);
  });

  it("does not loop forever on a parentId cycle in malformed data", () => {
    // a → b → a, with no root at all: nothing is reachable, and the walk terminates.
    const m = fixed([task("a", "b"), task("b", "a")]);
    expect(m.rowCount()).toBe(0);
  });

  it("skips children whose task record is missing", () => {
    const m = fixed([task("p", null)]);
    const data = fakeData([task("p", null)]);
    // a dangling child id in `children` without a `byId` entry
    (data.query().children as Map<string, string[]>).set("p", ["ghost"]);
    const m2 = new RowModel(data, () => defaultRowHeightResolver);
    expect(m.rowCount()).toBe(1);
    expect(m2.rowCount()).toBe(1);
  });
});

describe("RowModel — expand/collapse", () => {
  it("defaults every row to expanded", () => {
    const m = fixed(tree);
    expect(m.isExpanded("p0")).toBe(true);
  });

  it("collapsing hides the subtree", () => {
    const m = fixed(tree);
    expect(m.setExpanded("p0", false)).toBe(true);
    expect(m.rowCount()).toBe(3);
    expect([0, 1, 2].map((r) => m.taskIdAt(r))).toEqual(["p0", "p1", "c2"]);
    expect(m.isExpanded("p0")).toBe(false);
  });

  it("an omitted `expanded` toggles", () => {
    const m = fixed(tree);
    m.setExpanded("p0");
    expect(m.rowCount()).toBe(3);
    m.setExpanded("p0");
    expect(m.rowCount()).toBe(5);
  });

  it("reports no change when the state already matches", () => {
    const m = fixed(tree);
    expect(m.setExpanded("p0", true)).toBe(false);
    expect(m.setExpanded("p0", false)).toBe(true);
    expect(m.setExpanded("p0", false)).toBe(false);
  });

  it("re-flattens after the underlying data changed", () => {
    const tasks = [task("a", null)];
    const data = fakeData(tasks);
    const m = new RowModel(data, () => defaultRowHeightResolver);
    expect(m.rowCount()).toBe(1);
    // mutate the double the way an applied transaction would
    (data.query().byId as Map<string, unknown>).set("b", task("b", null));
    (data.query().children as Map<string | null, string[]>).set(null, ["a", "b"]);
    expect(m.rowCount()).toBe(1); // still the cached flattening
    m.invalidate();
    expect(m.rowCount()).toBe(2);
  });
});

describe("RowModel — fixed row height (fast path)", () => {
  it("skips the Fenwick tree entirely when no contribution exists", () => {
    const m = fixed(tree);
    expect(m.isUniform()).toBe(true);
    expect(m.totalHeight()).toBe(5 * H);
    expect(m.rowHeight(0)).toBe(H);
    expect(m.yOf(3)).toBe(3 * H);
    expect(m.rowAtY(0)).toBe(0);
    expect(m.rowAtY(H)).toBe(1);
    expect(m.rowAtY(H * 2 - 1)).toBe(1);
  });

  it("also skips it when every contribution returns the default", () => {
    const m = withHeights(tree, (_t, d) => d);
    expect(m.isUniform()).toBe(true);
    expect(m.totalHeight()).toBe(5 * H);
  });

  it("clamps out-of-range queries", () => {
    const m = fixed(tree);
    expect(m.rowHeight(-1)).toBe(0);
    expect(m.rowHeight(5)).toBe(0);
    expect(m.yOf(-4)).toBe(0);
    expect(m.yOf(99)).toBe(5 * H);
    expect(m.rowAtY(-10)).toBe(0);
    expect(m.rowAtY(10_000)).toBe(4);
  });
});

describe("RowModel — variable row height (Fenwick path)", () => {
  const tall: ResolvedRowHeight = (t, d) => (t.id === "c0" ? 100 : d);

  it("builds the tree and reports per-row heights", () => {
    const m = withHeights(tree, tall);
    expect(m.isUniform()).toBe(false);
    expect(m.rowHeight(0)).toBe(H);
    expect(m.rowHeight(1)).toBe(100);
    expect(m.totalHeight()).toBe(4 * H + 100);
  });

  it("converts row index → y and y → row index consistently", () => {
    const m = withHeights(tree, tall);
    expect(m.yOf(0)).toBe(0);
    expect(m.yOf(1)).toBe(H);
    expect(m.yOf(2)).toBe(H + 100);
    expect(m.yOf(5)).toBe(4 * H + 100);

    expect(m.rowAtY(0)).toBe(0);
    expect(m.rowAtY(H)).toBe(1);
    expect(m.rowAtY(H + 99)).toBe(1);
    expect(m.rowAtY(H + 100)).toBe(2);
    expect(m.rowAtY(1_000_000)).toBe(4);
  });

  it("falls back to the current height when a contribution returns a non-finite value", () => {
    const m = withHeights(tree, (t) => (t.id === "c0" ? Number.NaN : 40));
    expect(m.rowHeight(1)).toBe(H);
    expect(m.rowHeight(0)).toBe(40);
    expect(Number.isFinite(m.totalHeight())).toBe(true);
  });

  it("falls back to the current height for a negative value", () => {
    const m = withHeights(tree, (t, d) => (t.id === "c0" ? -5 : d));
    expect(m.rowHeight(1)).toBe(H);
  });

  it("re-measures after collapse", () => {
    const m = withHeights(tree, tall);
    expect(m.totalHeight()).toBe(4 * H + 100);
    m.setExpanded("p0", false);
    // c0 (100px) and c1 are gone
    expect(m.totalHeight()).toBe(3 * H);
    expect(m.isUniform()).toBe(true);
  });
});

describe("RowModel — by-task height resolution", () => {
  it("answers the default height for every task while no contribution exists", () => {
    const m = fixed(tree);
    expect(m.resolvedHeightOf("p0")).toBe(H);
    expect(m.resolvedHeightOf("c2")).toBe(H);
  });

  it("answers `undefined` for an id the store does not know", () => {
    expect(fixed(tree).resolvedHeightOf("nope")).toBeUndefined();
  });

  it("runs the reduction, and agrees with the visible row's own height", () => {
    const m = withHeights(tree, (t, d) => (t.id === "c0" ? 100 : d));
    expect(m.resolvedHeightOf("c0")).toBe(100);
    expect(m.rowHeight(m.rowOf("c0") ?? -1)).toBe(100);
    expect(m.resolvedHeightOf("c1")).toBe(H);
  });

  it("answers 0 for a task a contribution hid, even with no visible row of its own", () => {
    // The split-row case: `p0` is collapsed, so `c0` has no row at all, while a filter has reduced it
    // to height 0. A row-index lookup could not answer here; this resolution does.
    const m = withHeights(tree, (t, d) => (t.id === "c0" ? 0 : d));
    m.setExpanded("p0", false);
    expect(m.rowOf("c0")).toBeUndefined();
    expect(m.resolvedHeightOf("c0")).toBe(0);
    // A sibling of the same collapsed parent is unaffected.
    expect(m.resolvedHeightOf("c1")).toBe(H);
  });

  it("treats a non-finite or negative result as no override, as the row measurement does", () => {
    const m = withHeights(tree, (t) => (t.id === "c0" ? Number.NaN : -5));
    expect(m.resolvedHeightOf("c0")).toBe(H);
    expect(m.resolvedHeightOf("c1")).toBe(H);
  });
});

describe("RowModel — sort", () => {
  // p0 "B" > (c0 "z", c1 "a"), p1 "A" > (c2 "m")
  const named = [
    task("p0", null, "B"),
    task("c0", "p0", "z"),
    task("c1", "p0", "a"),
    task("p1", null, "A"),
    task("c2", "p1", "m"),
  ];
  const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name);

  it("leaves the store order untouched with no comparator set", () => {
    const m = fixed(named);
    expect([0, 1, 2, 3, 4].map((r) => m.taskIdAt(r))).toEqual(["p0", "c0", "c1", "p1", "c2"]);
  });

  it("orders each sibling group independently by the comparator", () => {
    const m = fixed(named);
    m.setSortComparator(byName);
    // Roots by name: p1 "A" < p0 "B" → p1 first. p0's children "a" < "z" → c1, c0.
    expect([0, 1, 2, 3, 4].map((r) => m.taskIdAt(r))).toEqual(["p1", "c2", "p0", "c1", "c0"]);
  });

  it("preserves the tree structure — children still follow their own parent", () => {
    const m = fixed(named);
    m.setSortComparator(byName);
    expect(m.depthAt(0)).toBe(0); // p1
    expect(m.depthAt(1)).toBe(1); // c2, p1's child
    expect(m.rowOf("c2")).toBe(1);
  });

  it("`null` restores the store's own order", () => {
    const m = fixed(named);
    m.setSortComparator(byName);
    m.setSortComparator(null);
    expect([0, 1, 2, 3, 4].map((r) => m.taskIdAt(r))).toEqual(["p0", "c0", "c1", "p1", "c2"]);
  });

  it("does not mutate the underlying data", () => {
    const data = fakeData(named);
    const m = new RowModel(data, () => defaultRowHeightResolver);
    m.setSortComparator(byName);
    m.rowCount(); // force the flattening
    expect(data.query().children.get(null)).toEqual(["p0", "p1"]);
  });
});

describe("RowModel — the published snapshot", () => {
  it("names the visible rows in row order, with the total content height", () => {
    const m = fixed(tree);
    expect(m.snapshot()).toEqual({
      taskIds: ["p0", "c0", "c1", "p1", "c2"],
      totalHeight: 5 * H,
    });
  });

  it("reflects a collapse in both members", () => {
    const m = fixed(tree);
    m.setExpanded("p0", false);
    expect(m.snapshot()).toEqual({ taskIds: ["p0", "p1", "c2"], totalHeight: 3 * H });
  });

  it("hands out a fresh array per flattening, so an older snapshot stays valid", () => {
    const m = fixed(tree);
    const before = m.snapshot();
    m.setExpanded("p0", false);
    const after = m.snapshot();
    expect(before.taskIds).toEqual(["p0", "c0", "c1", "p1", "c2"]);
    expect(after.taskIds).not.toBe(before.taskIds);
  });

  it("carries the variable-height total", () => {
    const m = withHeights(tree, (t) => (t.id === "c0" ? 50 : H));
    expect(m.snapshot().totalHeight).toBe(4 * H + 50);
  });
});
