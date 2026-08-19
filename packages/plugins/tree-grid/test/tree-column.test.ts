/**
 * `src/internal/tree-column.ts` — which column hosts the tree indentation, how far the indent may
 * grow before it saturates, and the minimum width a column keeps.
 *
 * docs/specs/plugins/tree-grid.md § Config — tree indentation and header parity.
 */
import { describe, expect, it } from "vitest";
import {
  MIN_CONTENT_WIDTH,
  minColumnWidth,
  treeColumnIndex,
  treeInset,
} from "../src/internal/tree-column";
import { wbsColumnDef } from "../src/internal/wbs";
import { unitColumn } from "./_units";

/** The stylesheet's own default `--sg-treegrid-cell-padding`. */
const PADDING = 8;

describe("treeColumnIndex", () => {
  const wbs = wbsColumnDef("WBS", () => "1");

  it("is the first displayed column when there is no WBS column", () => {
    expect(treeColumnIndex([unitColumn("name"), unitColumn("start")])).toBe(0);
  });

  it("skips the WBS numbering column, whatever its position", () => {
    expect(treeColumnIndex([wbs, unitColumn("name"), unitColumn("start")])).toBe(1);
    expect(treeColumnIndex([unitColumn("name"), wbs])).toBe(0);
  });

  it("falls back to the WBS column when that is all there is", () => {
    expect(treeColumnIndex([wbs])).toBe(0);
  });

  it("reports no tree column at all when no column is displayed", () => {
    expect(treeColumnIndex([])).toBe(-1);
  });
});

describe("minColumnWidth", () => {
  it("is 24 px of content box plus both cell paddings", () => {
    expect(MIN_CONTENT_WIDTH).toBe(24);
    expect(minColumnWidth(PADDING)).toBe(40);
    expect(minColumnWidth(0)).toBe(24);
    expect(minColumnWidth(12)).toBe(48);
  });
});

describe("treeInset", () => {
  it("is depth x indent while the column can afford it", () => {
    expect(treeInset(0, 16, 220, PADDING)).toBe(0);
    expect(treeInset(1, 16, 220, PADDING)).toBe(16);
    expect(treeInset(5, 16, 220, PADDING)).toBe(80);
    expect(treeInset(2, 24, 220, PADDING)).toBe(48);
  });

  it("saturates at the inset that still leaves a 24 px content box", () => {
    // 220 - (24 + 2x8) = 180: from depth 12 (192) on, the inset stops growing.
    expect(treeInset(11, 16, 220, PADDING)).toBe(176);
    expect(treeInset(12, 16, 220, PADDING)).toBe(180);
    expect(treeInset(40, 16, 220, PADDING)).toBe(180);
  });

  it("offers no inset at all on a column already at or below the floor", () => {
    expect(treeInset(3, 16, 40, PADDING)).toBe(0);
    expect(treeInset(3, 16, 24, PADDING)).toBe(0);
  });

  it("leaves the raw inset when the column has no width to saturate against", () => {
    expect(treeInset(3, 16, undefined, PADDING)).toBe(48);
  });

  it("never insets a root row, whatever the indent", () => {
    expect(treeInset(0, 999, 220, PADDING)).toBe(0);
    expect(treeInset(9, 0, 220, PADDING)).toBe(0);
  });
});
