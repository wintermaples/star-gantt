/**
 * `src/internal/hit.ts` — the `renderer/hitTest` contribution, without a host: bars, their handles
 * and the progress strip, in viewport coordinates.
 */
import { describe, expect, it } from "vitest";
import {
  BAR_CURSOR,
  HANDLE_CURSOR,
  HANDLE_WIDTH,
  PROGRESS_CURSOR,
  PROGRESS_HIT_RADIUS,
} from "../src/internal/geometry";
import { createHitTester } from "../src/internal/hit";
import type { Task } from "@stargantt/plugin-data-store";
import { rowsOf, scaleOf, store, task } from "./_fakes";

const ROW = 20;
const BAR_TOP = 4;
const MID_Y = ROW / 2;

const tasks = [
  // 100 px wide, half done: boundary at x = 50.
  task({ id: "a", start: 0, end: 100_000, progress: 0.5 }),
  task({ id: "m", start: 200_000, end: 200_000, type: "milestone" }),
];

function tester(
  order: (string | undefined)[] = ["a", "m"],
  vp: { scrollLeft: number; scrollTop: number } = { scrollLeft: 0, scrollTop: 0 },
) {
  return createHitTester({
    rows: rowsOf({ order, rowHeight: ROW }),
    data: store(tasks),
    scale: scaleOf(),
    viewport: () => vp,
  });
}

describe("createHitTester", () => {
  it("reports the bar body with the move cursor", () => {
    expect(tester()(30, MID_Y)).toEqual({ kind: "bar", id: "a", cursor: BAR_CURSOR });
  });

  it("reports both resize handles, which win over the body", () => {
    const hit = tester();
    expect(hit(1, MID_Y)?.kind).toBe("handle");
    expect(hit(100 - HANDLE_WIDTH + 1, MID_Y)).toEqual({
      kind: "handle",
      id: "a",
      cursor: HANDLE_CURSOR,
    });
  });

  it("reports the progress strip around the fill boundary, which wins over the body", () => {
    const hit = tester();
    expect(hit(50, MID_Y)).toEqual({ kind: "progress", id: "a", cursor: PROGRESS_CURSOR });
    expect(hit(50 + PROGRESS_HIT_RADIUS, MID_Y)?.kind).toBe("progress");
    expect(hit(50 + PROGRESS_HIT_RADIUS + 1, MID_Y)?.kind).toBe("bar");
  });

  // The 24px-tall band hugging the bar's bottom edge answers below the bar too, as far as the row
  // the point is attributed to reaches.
  it("reports progress in the row inset below the bar, at the boundary x", () => {
    const hit = tester();
    // The bar spans y = 4..16 in the 20px row; y = 17..19 is below the bar but still row 0.
    expect(hit(50, ROW - BAR_TOP + 1)).toEqual({ kind: "progress", id: "a", cursor: PROGRESS_CURSOR });
    expect(hit(50, ROW - 1)?.kind).toBe("progress");
    expect(hit(50 + PROGRESS_HIT_RADIUS + 1, ROW - 1)).toBeUndefined();
  });

  it("answers for the diamond of a milestone, not for its box's empty corners", () => {
    const hit = tester();
    // Row 1 spans y = 20..40; the diamond's centre is x = 200.
    expect(hit(200, ROW + MID_Y)?.kind).toBe("bar");
    expect(hit(200 - 6, ROW + BAR_TOP + 1)).toBeUndefined();
  });

  it("converts the point through the viewport scroll offsets", () => {
    const hit = tester(["a", "m"], { scrollLeft: 40, scrollTop: 20 });
    // Content (30, 30) is row 1 in content space, i.e. the milestone row — and x = 30 misses it.
    expect(hit(-10, 10)).toBeUndefined();
    // Content (10, 10): inside the first bar, past its start handle.
    expect(hit(-30, -10)?.kind).toBe("bar");
  });

  it("misses above the content, past the last row, and off both bars", () => {
    const hit = tester();
    expect(hit(30, -1)).toBeUndefined();
    // `rowAtY` clamps, so a point below the last row must be rejected explicitly.
    expect(hit(30, ROW * 2 + 5)).toBeUndefined();
    expect(hit(500, MID_Y)).toBeUndefined();
  });

  it("misses a NaN coordinate rather than treating it as row 0", () => {
    expect(tester()(30, Number.NaN)).toBeUndefined();
  });

  it("misses while the chart has no rows, and on a row carrying no task", () => {
    expect(tester([])(0, 0)).toBeUndefined();
    expect(tester([undefined])(30, MID_Y)).toBeUndefined();
  });

  it("misses when the row's id is unknown to the store", () => {
    expect(tester(["ghost"])(30, MID_Y)).toBeUndefined();
  });

  it("hit-tests a non-default milestone shape as the full bounding square", () => {
    const deps = {
      rows: rowsOf({ order: ["m"], rowHeight: ROW }),
      data: store(tasks),
      scale: scaleOf(),
      viewport: () => ({ scrollLeft: 0, scrollTop: 0 }),
    };
    // The marker box spans x = 194..206, y = 4..16; its top-left corner is outside the diamond.
    const corner = [195, BAR_TOP + 1] as const;
    const square = createHitTester({ ...deps, shapeOf: () => "square" as const });
    expect(square(...corner)).toEqual({ kind: "bar", id: "m", cursor: BAR_CURSOR });
    const diamond = createHitTester({ ...deps, shapeOf: () => "diamond" as const });
    expect(diamond(...corner)).toBeUndefined();
    expect(diamond(200, MID_Y)?.kind).toBe("bar");
  });
});

// The widened target answers only for the bar body: the handles and the progress strip keep their
// exact zones, so switching the option on never steals their affordances.
describe("createHitTester with expandedHitArea", () => {
  // A zero-duration ordinary task paints MIN_BAR_WIDTH (2px) wide at x = 0.
  const hairline = [task({ id: "z", start: 0, end: 0 })];

  function zeroWidthTester(expandedHitArea: boolean) {
    return createHitTester({
      rows: rowsOf({ order: ["z"], rowHeight: ROW }),
      data: store(hairline),
      scale: scaleOf(),
      viewport: () => ({ scrollLeft: 0, scrollTop: 0 }),
      options: { expandedHitArea },
    });
  }

  it("answers the bar body beside a hairline bar only while the option is on", () => {
    expect(zeroWidthTester(false)(8, MID_Y)).toBeUndefined();
    expect(zeroWidthTester(true)(8, MID_Y)).toEqual({ kind: "bar", id: "z", cursor: BAR_CURSOR });
  });

  it("never steals the resize handles' or the progress strip's zones", () => {
    const wide = createHitTester({
      rows: rowsOf({ order: ["a"], rowHeight: ROW }),
      data: store(tasks),
      scale: scaleOf(),
      viewport: () => ({ scrollLeft: 0, scrollTop: 0 }),
      options: { expandedHitArea: true },
    });
    expect(wide(2, MID_Y)?.kind).toBe("handle");
    expect(wide(50, MID_Y)?.kind).toBe("progress");
  });
});

// An in-row child of a split row is an ordinary editing surface, and overlapping children resolve
// in reverse paint order.
describe("createHitTester over a split row", () => {
  const parent = task({ id: "p", start: 0, end: 200_000, type: "summary" });
  const childA = task({ id: "a", parentId: "p", start: 0, end: 60_000, progress: 0.5 });
  const childB = task({ id: "b", parentId: "p", start: 100_000, end: 160_000 });

  function splitTester(children: readonly Task[] = [childA, childB]) {
    const all = [parent, ...children];
    return createHitTester({
      rows: rowsOf({ order: ["p"], rowHeight: ROW }),
      data: store(all),
      scale: scaleOf(),
      viewport: () => ({ scrollLeft: 0, scrollTop: 0 }),
      expand: { isExpanded: () => false },
      tree: {
        query: () => ({ children: new Map([["p", children.map((c) => c.id)]]) }) as never,
      },
      options: { collapsedSummary: "split" },
    });
  }

  it("answers the left resize handle of an in-row child", () => {
    expect(splitTester()(1, MID_Y)).toEqual({ kind: "handle", id: "a", cursor: HANDLE_CURSOR });
  });

  it("answers the progress strip of an in-row child", () => {
    // Child `a` spans 0..60 px and is half done, so its progress boundary sits at x = 30.
    expect(splitTester()(30, MID_Y)).toEqual({ kind: "progress", id: "a", cursor: PROGRESS_CURSOR });
  });

  it("answers the bar body away from the child's handles and strip", () => {
    expect(splitTester()(120, MID_Y)).toEqual({ kind: "bar", id: "b", cursor: BAR_CURSOR });
  });

  it("prefers the later child where two overlap", () => {
    const over = task({ id: "b", parentId: "p", start: 30_000, end: 90_000 });
    // x = 50 is inside both `a` (0..60) and `b` (30..90); `b` paints last, so it is on top.
    expect(splitTester([childA, over])(50, MID_Y)?.id).toBe("b");
  });

  it("answers nothing between children", () => {
    expect(splitTester()(80, MID_Y)).toBeUndefined();
  });

  // The hit test walks the same filtered child list the paint pass draws, so a child hidden by the
  // row-height reduction cannot be grabbed through the split row either.
  it("answers nothing for a child whose own row is hidden", () => {
    const children = [childA, childB];
    const hidden = createHitTester({
      // The row model gave `b` a row of height 0 — what a filtered-out task looks like.
      rows: rowsOf({ order: ["p", "b"], rowHeight: ROW, zeroHeight: ["b"] }),
      data: store([parent, ...children]),
      scale: scaleOf(),
      viewport: () => ({ scrollLeft: 0, scrollTop: 0 }),
      expand: { isExpanded: () => false },
      tree: {
        query: () => ({ children: new Map([["p", children.map((c) => c.id)]]) }) as never,
      },
      options: { collapsedSummary: "split" },
    });
    expect(hidden(120, MID_Y)).toBeUndefined();
    expect(hidden(50, MID_Y)?.id).toBe("a");
  });

  it("answers the parent's own bar once expanded", () => {
    const hit = createHitTester({
      rows: rowsOf({ order: ["p"], rowHeight: ROW }),
      data: store([parent, childA, childB]),
      scale: scaleOf(),
      viewport: () => ({ scrollLeft: 0, scrollTop: 0 }),
      expand: { isExpanded: () => true },
      tree: { query: () => ({ children: new Map() }) as never },
      options: { collapsedSummary: "split" },
    });
    expect(hit(120, MID_Y)?.id).toBe("p");
  });
});
