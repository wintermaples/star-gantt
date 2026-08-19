/**
 * The row-drag arithmetic (docs/specs/plugins/interaction.md §1.3 "Row drag"): which gap a pointer
 * names, which store write a drop implies, and the fractional-key midpoint. Pure functions — no host
 * is booted.
 */
import { describe, expect, it } from "vitest";
import { midKey } from "@stargantt/plugin-data-store";
import {
  DEPTH_STEP_PX,
  ancestorAtDepth,
  depthFor,
  depthOf,
  depthRangeAt,
  keyBetween,
  rowDropAt,
  rowPlanFor,
} from "../src/internal/drag/row-drag";
import type { RowBox, RowLookup } from "../src/internal/drag/row-drag";

/** Three 28px rows: a, b, c, top to bottom. */
function rows(): RowBox[] {
  return [
    { id: "a", y: 4, height: 20 },
    { id: "b", y: 32, height: 20 },
    { id: "c", y: 60, height: 20 },
  ];
}

/** A flat root list with the given order keys. */
function flatLookup(keys: Record<string, string | undefined>): RowLookup {
  const order = Object.keys(keys);
  return {
    getTask: (id) => {
      const key = keys[String(id)];
      if (!(String(id) in keys)) return undefined;
      return key === undefined ? { parentId: null } : { parentId: null, orderKey: key };
    },
    childrenOf: (parent) => (parent === null ? order : []),
  };
}

describe("rowDropAt", () => {
  it("names the gap whose bracketing rows the pointer sits between", () => {
    const drop = rowDropAt(30, rows(), "c");
    expect(drop).toBeDefined();
    expect(drop?.beforeId).toBe("a");
    expect(drop?.afterId).toBe("b");
    // The line sits in the middle of the gap between a's bottom (24) and b's top (32).
    expect(drop?.lineY).toBe(28);
  });

  it("excludes the dragged row itself, so its own place is not a target", () => {
    // Pointer over b's own row while dragging b: the gap is between a and c.
    const drop = rowDropAt(40, rows(), "b");
    expect(drop?.beforeId).toBe("a");
    expect(drop?.afterId).toBe("c");
  });

  it("names the top gap above everything and the bottom gap below everything", () => {
    const top = rowDropAt(0, rows(), "c");
    expect(top?.beforeId).toBeUndefined();
    expect(top?.afterId).toBe("a");
    expect(top?.lineY).toBe(4);
    const bottom = rowDropAt(500, rows(), "a");
    expect(bottom?.beforeId).toBe("c");
    expect(bottom?.afterId).toBeUndefined();
    expect(bottom?.lineY).toBe(80);
  });

  it("answers undefined when no other rows exist", () => {
    expect(rowDropAt(10, [{ id: "only", y: 4, height: 20 }], "only")).toBeUndefined();
  });

  // A hidden-summary or filler row occupies space but carries no task id. It must bound the gap
  // geometrically without reading as "no row at all", which would misfile the drop as a first root
  // sibling.
  it("resolves anchors past taskless rows to the nearest id-carrying rows", () => {
    const boxes: RowBox[] = [
      { id: "a", y: 4, height: 20 },
      { id: undefined, y: 32, height: 20 },
      { id: "c", y: 60, height: 20 },
    ];
    // Pointer in the gap between the taskless row and c: the anchor above is a, not "nothing".
    const below = rowDropAt(58, boxes, "z");
    expect(below?.beforeId).toBe("a");
    expect(below?.afterId).toBe("c");
    // Pointer in the gap between a and the taskless row: the anchor below is c.
    const above = rowDropAt(30, boxes, "z");
    expect(above?.beforeId).toBe("a");
    expect(above?.afterId).toBe("c");
  });

  it("still reports no anchor at the extremes when only taskless rows bound the gap", () => {
    const boxes: RowBox[] = [
      { id: undefined, y: 4, height: 20 },
      { id: "b", y: 32, height: 20 },
    ];
    const top = rowDropAt(0, boxes, "z");
    expect(top?.beforeId).toBeUndefined();
    expect(top?.afterId).toBe("b");
  });
});

describe("keyBetween", () => {
  it("lands strictly between its neighbours, in the store's base-62 alphabet", () => {
    const cases: [string, string | undefined][] = [
      ["1", "2"],
      ["", "1"],
      ["2", undefined],
      ["A", "B"],
      ["1z", "2"],
    ];
    for (const [prev, next] of cases) {
      const key = keyBetween(prev, next);
      expect(key, `${prev}..${next ?? "∞"}`).toBeDefined();
      expect(key! > prev).toBe(true);
      if (next !== undefined) expect(key! < next).toBe(true);
      expect(/^[0-9A-Za-z]+$/.test(key!)).toBe(true);
    }
  });

  // The key is the store's own `midKey`, not a private copy of the fraction arithmetic; a
  // re-derivation that drifted would fail here.
  it("returns exactly the store's own midpoint wherever a gap exists", () => {
    const cases: [string, string | undefined][] = [
      ["1", "2"],
      ["", "1"],
      ["2", undefined],
      ["A", "B"],
      ["1z", "2"],
      ["", undefined],
    ];
    for (const [prev, next] of cases) {
      expect(keyBetween(prev, next), `${prev}..${next ?? "∞"}`).toBe(midKey(prev, next));
    }
  });

  it("refuses a gap that is no gap", () => {
    expect(keyBetween("5", "5")).toBeUndefined();
    // "1" and "10" are the same value in the store's fraction reading.
    expect(keyBetween("1", "10")).toBeUndefined();
  });
});

describe("rowPlanFor", () => {
  const boxes = rows();

  it("re-keys the dragged task between its new neighbours", () => {
    const lookup = flatLookup({ a: "1", b: "2", c: "3" });
    const drop = rowDropAt(58, boxes, "a"); // between b and c
    const plan = rowPlanFor(drop!, 0, "a", lookup);
    expect(plan).toBeDefined();
    expect(plan?.parentId).toBeNull();
    expect(plan!.orderKey > "2" && plan!.orderKey < "3").toBe(true);
  });

  it("declines the task's own current gap", () => {
    const lookup = flatLookup({ a: "1", b: "2", c: "3" });
    // Dragging b and dropping it right back between a and c's top half — its own place.
    const drop = { index: 1, lineY: 0, beforeId: "a", afterId: "c" };
    expect(rowPlanFor(drop, 0, "b", lookup)).toBeUndefined();
  });

  it("re-parents when the gap belongs to another parent", () => {
    // p is a summary with child c1; r is a root after it. Dropping r between p and c1 files r
    // under p.
    const lookup: RowLookup = {
      getTask: (id) =>
        id === "p"
          ? { parentId: null, orderKey: "1" }
          : id === "c1"
            ? { parentId: "p", orderKey: "1" }
            : id === "r"
              ? { parentId: null, orderKey: "2" }
              : undefined,
      childrenOf: (parent) => (parent === null ? ["p", "r"] : parent === "p" ? ["c1"] : []),
    };
    const drop = { index: 1, lineY: 0, beforeId: "p" as const, afterId: "c1" as const };
    const plan = rowPlanFor(drop, 1, "r", lookup);
    expect(plan?.parentId).toBe("p");
    expect(plan!.orderKey < "1").toBe(true);
  });

  it("refuses to file a branch inside itself", () => {
    const lookup: RowLookup = {
      getTask: (id) =>
        id === "p"
          ? { parentId: null, orderKey: "1" }
          : id === "c1"
            ? { parentId: "p", orderKey: "1" }
            : id === "c2"
              ? { parentId: "p", orderKey: "2" }
              : undefined,
      childrenOf: (parent) => (parent === null ? ["p"] : parent === "p" ? ["c1", "c2"] : []),
    };
    // Dropping p between its own children would make p its own descendant.
    const drop = { index: 1, lineY: 0, beforeId: "c1" as const, afterId: "c2" as const };
    expect(rowPlanFor(drop, 1, "p", lookup)).toBeUndefined();
  });

  it("refuses a drop whose bracketing sibling has no usable key", () => {
    const lookup = flatLookup({ a: "1", b: undefined, c: "3" });
    const drop = { index: 1, lineY: 0, beforeId: "a" as const, afterId: "b" as const };
    expect(rowPlanFor(drop, 0, "c", lookup)).toBeUndefined();
  });
});

// The gap says where between rows, the pointer's horizontal travel says how deep. Without this, a
// gap below a nested row always resolved to that row's parent, so a task dropped one level in could
// never be dropped back out at the same gap.
describe("drop depth", () => {
  /** p (root) with children c1, c2; r a root after p. */
  const tree: RowLookup = {
    getTask: (id) =>
      id === "p"
        ? { parentId: null, orderKey: "1" }
        : id === "c1"
          ? { parentId: "p", orderKey: "1" }
          : id === "c2"
            ? { parentId: "p", orderKey: "2" }
            : id === "r"
              ? { parentId: null, orderKey: "2" }
              : undefined,
    childrenOf: (parent) =>
      parent === null ? ["p", "r"] : parent === "p" ? ["c1", "c2"] : [],
  };

  it("reads a task's outline depth from its ancestor chain", () => {
    expect(depthOf("p", tree)).toBe(0);
    expect(depthOf("c1", tree)).toBe(1);
    expect(ancestorAtDepth("c1", 0, tree)).toBe("p");
    expect(ancestorAtDepth("c1", 1, tree)).toBe("c1");
    expect(ancestorAtDepth("p", 1, tree)).toBeUndefined();
  });

  it("admits everything from the row below's depth up to a child of the row above", () => {
    // Gap between c2 (depth 1, last child of p) and r (depth 0, a root).
    expect(depthRangeAt({ index: 0, lineY: 0, beforeId: "c2", afterId: "r" }, tree)).toEqual({
      min: 0,
      max: 2,
    });
    // The very last gap of the chart: nothing below, so the root level is admissible.
    expect(depthRangeAt({ index: 0, lineY: 0, beforeId: "c2", afterId: undefined }, tree)).toEqual({
      min: 0,
      max: 2,
    });
  });

  it("steps one level per indent step of horizontal travel, clamped to the range", () => {
    const gap = { index: 0, lineY: 0, beforeId: "c2" as const, afterId: undefined };
    // Dragging c1 straight down keeps its depth; dragging it left one step lifts it to the root.
    expect(depthFor(gap, 1, 0, tree)).toBe(1);
    expect(depthFor(gap, 1, -DEPTH_STEP_PX, tree)).toBe(0);
    // Further left cannot go below the root, further right cannot pass a child of the row above.
    expect(depthFor(gap, 1, -10 * DEPTH_STEP_PX, tree)).toBe(0);
    expect(depthFor(gap, 1, 10 * DEPTH_STEP_PX, tree)).toBe(2);
  });

  it("files a depth-0 drop at the root even below the last row of a branch", () => {
    const gap = { index: 0, lineY: 0, beforeId: "c2" as const, afterId: undefined };
    const plan = rowPlanFor(gap, 0, "c1", tree);
    expect(plan?.parentId).toBeNull();
    // The gap sits after p's whole subtree and before the root r, so c1 lands between them.
    expect(plan!.orderKey > "1" && plan!.orderKey < "2").toBe(true);
  });

  it("files a deeper drop under the ancestor of the row above the gap", () => {
    const gap = { index: 0, lineY: 0, beforeId: "c2" as const, afterId: "r" as const };
    expect(rowPlanFor(gap, 1, "r", tree)?.parentId).toBe("p");
    // One deeper still: r becomes c2's first child.
    expect(rowPlanFor(gap, 2, "r", tree)?.parentId).toBe("c2");
  });

  it("refuses a depth with no row above the gap to file under", () => {
    const top = { index: 0, lineY: 0, beforeId: undefined, afterId: "p" as const };
    expect(rowPlanFor(top, 1, "r", tree)).toBeUndefined();
    expect(rowPlanFor(top, 0, "r", tree)?.parentId).toBeNull();
  });
});
