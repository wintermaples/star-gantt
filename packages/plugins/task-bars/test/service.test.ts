/**
 * `src/internal/service.ts` — the geometry service and the composite snapshot, without a host.
 *
 * The two composite members answer from the latest committed pass in viewport-local pixels, while
 * `barRect` computes content coordinates on demand for any task occupying a row.
 */
import { describe, expect, it } from "vitest";
import type { BarBox, CollapsedSummary } from "../src/index";
import { BAR_INSET, MIN_BAR_HEIGHT, MIN_BAR_WIDTH } from "../src/internal/geometry";
import { createBarGeometry } from "../src/internal/service";
import { rowsOf, scaleOf, store, task } from "./_fakes";

const tasks = [
  task({ id: "a", start: 0, end: 10_000 }),
  task({ id: "b", start: 20_000, end: 30_000 }),
  task({ id: "m", start: 40_000, end: 40_000, type: "milestone" }),
];

function geometry(order: (string | undefined)[] = ["a", "b", "m"], hidden: string[] = []) {
  return createBarGeometry({
    rows: rowsOf({ order, rowHeight: 20, hidden }),
    data: store(tasks),
    scale: scaleOf(),
    expand: { isExpanded: () => true },
    collapsedSummary: "range",
  });
}

describe("barRect / contentBoxOf (content coordinates)", () => {
  it("follows the bar-geometry rule: inset per side, centred in the row band", () => {
    const box = geometry().service.barRect("b");
    // Row 1 spans y = 20..40, so the box sits one inset below the band's top edge.
    expect(box).toEqual({
      id: "b",
      x: 20,
      y: 20 + BAR_INSET,
      width: 10,
      height: 20 - BAR_INSET * 2,
      gutterStart: 0,
      gutterEnd: 0,
    });
  });

  it("is scroll-independent — the committed snapshot does not affect it", () => {
    const g = geometry();
    g.commit([], new Map());
    expect(g.service.barRect("a")?.x).toBe(0);
    expect(g.service.barBoxOf("a")).toBeUndefined();
  });

  it("gives a milestone a square box of the bar height, centred on its start", () => {
    const box = geometry().service.barRect("m");
    const height = 20 - BAR_INSET * 2;
    // The milestone is row 2, i.e. the band y = 40..60.
    expect(box).toEqual({
      id: "m",
      x: 40 - height / 2,
      y: 40 + BAR_INSET,
      width: height,
      height,
      gutterStart: 0,
      gutterEnd: 0,
    });
  });

  it("keeps a zero-duration ordinary task visible at the minimum width", () => {
    const g = createBarGeometry({
      rows: rowsOf({ order: ["z"] }),
      data: store([task({ id: "z", start: 5_000, end: 5_000 })]),
      scale: scaleOf(),
      expand: { isExpanded: () => true },
      collapsedSummary: "range",
    });
    expect(g.service.barRect("z")?.width).toBe(MIN_BAR_WIDTH);
  });

  it("keeps the minimum bar height in a row shorter than twice the inset", () => {
    const g = createBarGeometry({
      rows: rowsOf({ order: ["a"], rowHeight: 8 }),
      data: store(tasks),
      scale: scaleOf(),
      expand: { isExpanded: () => true },
      collapsedSummary: "range",
    });
    expect(g.service.barRect("a")?.height).toBe(MIN_BAR_HEIGHT);
  });

  it("answers undefined for an unknown id and for a task hidden in a collapsed branch", () => {
    expect(geometry().service.barRect("nope")).toBeUndefined();
    expect(geometry(["a", "b", "m"], ["b"]).service.barRect("b")).toBeUndefined();
  });

  // The resolved end gutter is published on every box the service reports.
  it("publishes the resolved end gutter on the box", () => {
    const g = createBarGeometry({
      rows: rowsOf({ order: ["a"], rowHeight: 20 }),
      data: store(tasks),
      scale: scaleOf(),
      expand: { isExpanded: () => true },
      collapsedSummary: "range",
      gutter: { current: () => ({ start: 4, end: 17 }) },
    });
    expect(g.service.barRect("a")).toMatchObject({ gutterStart: 4, gutterEnd: 17 });
    expect(g.placedBarAt(0, { scrollLeft: 0, scrollTop: 0 })?.box).toMatchObject({
      gutterStart: 4,
      gutterEnd: 17,
    });
  });
});

// What a collapsed summary presents decides whether anything may be anchored to it. `barRect`
// cannot answer that: it reports the rolled-up span whatever the mode, because a dependency line
// into a folded branch needs an anchor.
describe("hasOwnBar", () => {
  const tree = [
    task({ id: "p", start: 0, end: 30_000, type: "summary" }),
    task({ id: "c", parentId: "p", start: 0, end: 10_000 }),
  ];

  function withMode(collapsedSummary: CollapsedSummary, expanded: boolean) {
    return createBarGeometry({
      rows: rowsOf({ order: ["p", "c"], rowHeight: 20 }),
      data: store(tree),
      scale: scaleOf(),
      expand: { isExpanded: () => expanded },
      collapsedSummary,
    });
  }

  it("is true for an ordinary task and false for an unknown id", () => {
    expect(geometry().service.hasOwnBar("a")).toBe(true);
    expect(geometry().service.hasOwnBar("nope")).toBe(false);
  });

  it("is false for a task hidden inside a collapsed branch", () => {
    expect(geometry(["a", "b", "m"], ["b"]).service.hasOwnBar("b")).toBe(false);
  });

  it("is true for a collapsed summary that still paints its own span", () => {
    expect(withMode("range", false).service.hasOwnBar("p")).toBe(true);
  });

  it("is false for a collapsed summary that paints nothing", () => {
    expect(withMode("hidden", false).service.hasOwnBar("p")).toBe(false);
  });

  it("is false for a collapsed summary that paints its children instead", () => {
    expect(withMode("split", false).service.hasOwnBar("p")).toBe(false);
  });

  it("is true for an expanded summary whatever the mode", () => {
    expect(withMode("split", true).service.hasOwnBar("p")).toBe(true);
    expect(withMode("hidden", true).service.hasOwnBar("p")).toBe(true);
  });

  it("is true for an ordinary child even while the chart splits collapsed summaries", () => {
    expect(withMode("split", false).service.hasOwnBar("c")).toBe(true);
  });
});

describe("placedBarAt (viewport-local coordinates)", () => {
  it("subtracts the viewport scroll offsets from the content box", () => {
    const g = geometry();
    const placed = g.placedBarAt(1, { scrollLeft: 5, scrollTop: 20 });
    const content = g.service.barRect("b");
    expect(placed?.task.id).toBe("b");
    expect(placed?.box).toEqual({
      id: "b",
      x: (content?.x ?? 0) - 5,
      y: (content?.y ?? 0) - 20,
      width: content?.width,
      height: content?.height,
      gutterStart: 0,
      gutterEnd: 0,
    });
  });

  it("yields null for a row carrying no task and for an id the store does not know", () => {
    const vp = { scrollLeft: 0, scrollTop: 0 };
    expect(geometry([undefined]).placedBarAt(0, vp)).toBeNull();
    expect(geometry(["ghost"]).placedBarAt(0, vp)).toBeNull();
  });

  it("still places a task the row model hides, since the row is what it is asked about", () => {
    // `placedBarAt` is driven by the visible row range the pass walks, so the `rowOf` hiding that
    // `barRect` honours is not consulted here.
    expect(geometry(["b"], ["b"]).placedBarAt(0, { scrollLeft: 0, scrollTop: 0 })).not.toBeNull();
  });
});

// A row a `rows/height` contribution reduced to 0 is hidden, and hidden means the service has
// nothing to say about it. The bar itself paints nothing either way (its height is 0), so what this
// guards is the consumers that draw from the *box*: without it, dependency routing reads a
// zero-height box for a filtered-out task and draws its links collapsed onto the row below.
describe("a zero-height row", () => {
  const zero = (): ReturnType<typeof createBarGeometry> =>
    createBarGeometry({
      rows: rowsOf({ order: ["a", "b", "m"], rowHeight: 20, zeroHeight: ["b"] }),
      data: store(tasks),
      scale: scaleOf(),
      expand: { isExpanded: () => true },
      collapsedSummary: "range",
    });

  it("has no content box, the same answer an unknown or collapsed task gets", () => {
    expect(zero().service.barRect("b")).toBeUndefined();
    // Its neighbours are unaffected, and they move up by the space it no longer occupies.
    expect(zero().service.barRect("a")).toBeDefined();
    expect(zero().service.barRect("m")?.y).toBe(20 + BAR_INSET);
  });

  it("is not placed by the paint pass, so it never enters the geometry snapshot", () => {
    expect(zero().placedBarAt(1, { scrollLeft: 0, scrollTop: 0 })).toBeNull();
    expect(zero().placedBarAt(0, { scrollLeft: 0, scrollTop: 0 })).not.toBeNull();
  });
});

describe("the committed composite", () => {
  const boxes: BarBox[] = [
    { id: "a", x: 1, y: 2, width: 3, height: 4, gutterStart: 0, gutterEnd: 0 },
    { id: "b", x: 5, y: 6, width: 7, height: 8, gutterStart: 0, gutterEnd: 0 },
  ];

  it("starts empty, before any pass has run", () => {
    const g = geometry();
    expect(g.service.visibleBoxes()).toEqual([]);
    expect(g.service.barBoxOf("a")).toBeUndefined();
  });

  it("answers barBoxOf and visibleBoxes from the latest committed pass, in row order", () => {
    const g = geometry();
    g.commit(boxes.slice(), new Map(boxes.map((b) => [b.id, b])));
    expect(g.service.visibleBoxes().map((b) => b.id)).toEqual(["a", "b"]);
    expect(g.service.barBoxOf("b")).toEqual(boxes[1]);
    expect(g.service.barBoxOf("m")).toBeUndefined();
  });

  it("hands out a fresh array per call, so a caller may keep it across passes", () => {
    const g = geometry();
    g.commit(boxes.slice(), new Map(boxes.map((b) => [b.id, b])));
    const kept = g.service.visibleBoxes();
    expect(g.service.visibleBoxes()).not.toBe(kept);
    g.commit([], new Map());
    expect(kept).toHaveLength(2);
    expect(g.service.visibleBoxes()).toEqual([]);
  });
});
