/**
 * Sticky leading label.
 *
 * A header cell that straddles the surface's left edge — its own left edge negative, its right
 * edge inside the surface — draws its label pinned to the surface's own left edge plus
 * `headerLabelPadding`, bounded so the label never crosses into the following cell, and dropped
 * entirely (never truncated) when even the visible sliver cannot hold the whole string. Cells
 * fully inside the surface are unaffected.
 */
import { afterEach, describe, expect, it } from "vitest";
import { boot, wheelScroll } from "./_boot";
import type { Booted } from "./_boot";

let booted: Booted | null = null;

afterEach(() => {
  booted?.dom.restore();
  booted = null;
});

/** Boots at the default `day` level (origin 0, 40 px/day), scrolls, and settles one frame. */
function scrolled(px: number): Booted {
  const b = boot([], {}, { origin: 0 });
  booted = b;
  b.dom.flushFrames();
  b.header.context.reset();
  wheelScroll(b, px);
  b.dom.flushFrames();
  return b;
}

describe("a cell straddling the left edge", () => {
  it("sticks the day label to the surface's left edge instead of the cell's own (off-surface) one", () => {
    // scrollLeft 10: day 0's cell spans local x [-10, 30), straddling the left edge.
    const b = scrolled(10);
    const day0 = b.header.context.texts.find((t) => t.text === "1");
    expect(day0).toBeDefined();
    expect(day0?.x).toBe(4); // surface left edge (0) + the default 4 px padding
    expect(b.header.context.texts.map((t) => t.x)).not.toContain(-6); // the old, off-surface x
  });

  it("applies the same rule to every row, not only the top one", () => {
    const b = scrolled(10);
    // The month row's January cell also straddles at scrollLeft 10.
    const month = b.header.context.texts.find((t) => t.text === "January 1970");
    expect(month?.x).toBe(4);
  });

  it("bounds the label so it never crosses into the following cell", () => {
    // scrollLeft 39: day 0's cell spans local x [-39, 1) — a 1 px sliver, comfortably left of
    // day 1's own label region.
    const b = scrolled(39);
    const day0 = b.header.context.texts.find((t) => t.text === "1");
    // The sliver (1 px) cannot hold "1" (6 px) plus 2*4 px padding, so it is dropped rather than
    // drawn past the cell boundary.
    expect(day0).toBeUndefined();
  });

  it("drops the label entirely — never truncated — when the visible sliver cannot hold it", () => {
    // A narrow viewport keeps every visible day single-digit ("1".."9"), so every candidate's
    // measured width is the same and fit-based thinning never kicks in — isolating the
    // sticky-label drop from it.
    const b = boot([], { width: 300 }, { origin: 0 });
    booted = b;
    // Inflate every glyph's measured width *before* the first paint (so no narrower measurement
    // gets memoised first) so the day cell's own sliver (30 px after a 10 px scroll) cannot hold
    // "1" + 2*4px padding, while the day row's *un-clamped* cell width (40 px) still holds it.
    b.header.context.charWidth = 25;
    wheelScroll(b, 10);
    b.dom.flushFrames();
    expect(b.header.context.texts.some((t) => t.text === "1")).toBe(false);
    // A non-straddling day label is unaffected — the row itself did not need to thin.
    expect(b.header.context.texts.some((t) => t.text === "2")).toBe(true);
  });
});

describe("a cell fully inside the surface", () => {
  it("keeps the ordinary placement: cell's own left edge plus the padding", () => {
    const b = scrolled(10);
    const day1 = b.header.context.texts.find((t) => t.text === "2");
    // Day 1's boundary sits at local x = 40 - 10 = 30, unaffected by the sticky rule.
    expect(day1?.x).toBe(34);
  });
});
