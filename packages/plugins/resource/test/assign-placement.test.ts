/**
 * `internal/assign/placement.ts` — hostless unit tests of the editor's placement math:
 * fits-below unchanged, flip-above, and clamped fully inside the root's box on both axes.
 */
import { describe, expect, it } from "vitest";
import { placeEditor } from "../src/internal/assign/placement";

describe("placeEditor", () => {
  it("keeps the position unchanged when the editor already fits below its cell", () => {
    const anchor = { left: 50, top: 100, width: 120, height: 24 };
    const root = { left: 0, top: 0, width: 800, height: 600 };
    const size = { width: 220, height: 150 };
    expect(placeEditor(anchor, root, size)).toEqual({ left: 50, top: 124, maxHeight: 584 });
  });

  it("flips above the cell when the space below cannot fit it and there is more room above", () => {
    const anchor = { left: 50, top: 500, width: 120, height: 28 };
    const root = { left: 0, top: 0, width: 800, height: 540 };
    const size = { width: 220, height: 200 };
    const placement = placeEditor(anchor, root, size);
    expect(placement.top + size.height).toBe(anchor.top);
    expect(placement.top).toBe(300);
    expect(placement.top).toBeGreaterThanOrEqual(0);
  });

  it("clamps top to 0 and caps maxHeight to the root's height (minus margin) when the editor is taller than the root", () => {
    const anchor = { left: 10, top: 0, width: 100, height: 28 };
    const root = { left: 0, top: 0, width: 800, height: 540 };
    const size = { width: 220, height: 2000 };
    const placement = placeEditor(anchor, root, size);
    expect(placement.top).toBe(0);
    expect(placement.maxHeight).toBe(524);
    expect(placement.maxHeight).toBeLessThan(root.height);
  });

  it("clamps left so the editor's right edge stays inside the root", () => {
    const anchor = { left: 700, top: 100, width: 80, height: 24 };
    const root = { left: 0, top: 0, width: 800, height: 600 };
    const size = { width: 220, height: 150 };
    const placement = placeEditor(anchor, root, size);
    expect(placement.left).toBe(580);
    expect(placement.left + size.width).toBeLessThanOrEqual(root.width);
  });

  it("clamps left to 0 (min wins) when the editor is wider than the root itself", () => {
    const anchor = { left: 10, top: 100, width: 80, height: 24 };
    const root = { left: 0, top: 0, width: 300, height: 600 };
    const size = { width: 400, height: 150 };
    expect(placeEditor(anchor, root, size).left).toBe(0);
  });

  it("accounts for a non-zero root origin (root not anchored at the viewport's 0,0)", () => {
    const anchor = { left: 340, top: 220, width: 120, height: 24 };
    const root = { left: 300, top: 100, width: 800, height: 600 };
    const size = { width: 220, height: 150 };
    const placement = placeEditor(anchor, root, size);
    expect(placement.left).toBe(40);
    expect(placement.top).toBe(144);
  });

  it("folds the root's own scroll offset and border into left/top", () => {
    const anchor = { left: 100, top: 200, width: 120, height: 24 };
    const root = {
      left: 0,
      top: 0,
      width: 800,
      height: 600,
      scrollLeft: 30,
      scrollTop: 50,
      clientLeft: 2,
      clientTop: 2,
    };
    const size = { width: 220, height: 100 };
    const placement = placeEditor(anchor, root, size);
    expect(placement.left).toBe(128);
    expect(placement.top).toBe(272);
  });

  it("treats a root with no scroll/border fields the same as an all-zero one (default 0)", () => {
    const anchor = { left: 100, top: 200, width: 120, height: 24 };
    const rootPlain = { left: 0, top: 0, width: 800, height: 600 };
    const rootZeroed = { ...rootPlain, scrollLeft: 0, scrollTop: 0, clientLeft: 0, clientTop: 0 };
    const size = { width: 220, height: 100 };
    expect(placeEditor(anchor, rootPlain, size)).toEqual(placeEditor(anchor, rootZeroed, size));
  });
});
