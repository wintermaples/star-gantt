/**
 * Unit tests for `src/internal/tooltip/placement.ts` — the offset / flip / clamp arithmetic and the
 * clip walk, exercised directly with numbers and minimal element stand-ins, without booting a host
 * or a real DOM. Uses hand-rolled `ClipNode` / `ClipView` stand-ins — the same "stub DOM" style
 * already used by `test/drag-tooltip.test.ts`.
 *
 * docs/specs/plugins/interaction.md §6.4a.
 */
import { describe, expect, it } from "vitest";
import {
  OFFSET_X,
  OFFSET_Y,
  placeAxis,
  placePanel,
  visibleBounds,
} from "../src/internal/tooltip/placement";
import type { Bounds, ClipNode, ClipView } from "../src/internal/tooltip/placement";

/** A minimal clip-walk node: a rect plus overflow, chained to its parent. */
interface StubNode extends ClipNode {
  rect: { left: number; top: number; width: number; height: number };
  overflowX: string;
  overflowY: string;
}

/** A chain of nodes, innermost first, sharing one overflow lookup. */
function chain(depth: number): StubNode[] {
  const nodes: StubNode[] = [];
  let parent: StubNode | null = null;
  for (let i = 0; i < depth; i += 1) {
    const node: StubNode = {
      parentElement: parent,
      rect: { left: 0, top: 0, width: 0, height: 0 },
      overflowX: "visible",
      overflowY: "visible",
      getBoundingClientRect() {
        return {
          left: node.rect.left,
          top: node.rect.top,
          right: node.rect.left + node.rect.width,
          bottom: node.rect.top + node.rect.height,
        };
      },
    };
    parent = node;
    nodes.push(node);
  }
  return nodes.reverse(); // innermost first
}

/** A `ClipView` reporting fixed viewport dimensions and each node's own stubbed overflow. */
function fakeView(innerWidth: number, innerHeight: number): ClipView {
  return {
    innerWidth,
    innerHeight,
    getComputedStyle: (node) => {
      const n = node as StubNode;
      return { overflowX: n.overflowX, overflowY: n.overflowY };
    },
  };
}

function bounds(left: number, top: number, right: number, bottom: number): Bounds {
  return { left, top, right, bottom };
}

describe("the fixed offsets (§6.4a)", () => {
  // The spec fixes the gap at 8px minimum ("8px gap/flip placement"); the exact per-axis values
  // are internal, but they must be positive and comfortably above the 8px floor, or the panel would
  // sit on the bar it describes.
  it("are both positive and at least the spec's 8px gap", () => {
    expect(OFFSET_X).toBeGreaterThanOrEqual(8);
    expect(OFFSET_Y).toBeGreaterThanOrEqual(8);
  });
});

describe("placeAxis — offset, flip, clamp on one axis", () => {
  it("takes the offset side when the panel fits there", () => {
    expect(placeAxis(100, 12, 30, 0, 1000)).toBe(112);
  });

  it("treats landing exactly on the far edge as fitting", () => {
    // 100 + 12 + 30 = 142 === max: not an overflow, so no flip.
    expect(placeAxis(100, 12, 30, 0, 142)).toBe(112);
  });

  it("flips to the mirrored offset on the other side when the offset side overflows", () => {
    expect(placeAxis(100, 12, 30, 0, 141)).toBe(58); // 100 - 12 - 30
  });

  it("clamps to max - size when the flipped side does not fit either", () => {
    // Flipped would land at 20 - 12 - 30 = -22, left of min, so the panel is pushed inwards.
    expect(placeAxis(20, 12, 30, 0, 40)).toBe(10); // max(0, 40 - 30)
  });

  it("clamps to min when the panel is larger than the whole span", () => {
    // Neither side fits and max - size is negative: the near edge wins, so the panel's beginning
    // stays readable.
    expect(placeAxis(40, 12, 80, 0, 50)).toBe(0);
  });

  it("clamps a negative offset position up to min", () => {
    expect(placeAxis(-100, 12, 10, 0, 1000)).toBe(0);
  });

  it("measures min/max in the same space as the anchor, not from zero", () => {
    // A span that starts at 595 (a chart pane inset from the window edge): flipping lands left of
    // the pane, so the clamp answers to the pane's own left edge.
    expect(placeAxis(645, 12, 300, 595, 695)).toBe(595);
  });
});

describe("placePanel — the two axes decided independently", () => {
  it("applies the below-right offset with no bounds at all", () => {
    expect(placePanel(500, 500, { width: 10, height: 10 }, null)).toEqual({
      left: 500 + OFFSET_X,
      top: 500 + OFFSET_Y,
    });
  });

  it("ignores the panel size entirely when there are no bounds", () => {
    expect(placePanel(0, 0, { width: 10_000, height: 10_000 }, null)).toEqual({
      left: OFFSET_X,
      top: OFFSET_Y,
    });
  });

  it("keeps the offset placement when it fits the bounds", () => {
    expect(placePanel(10, 10, { width: 30, height: 20 }, bounds(0, 0, 1000, 1000))).toEqual({
      left: 10 + OFFSET_X,
      top: 10 + OFFSET_Y,
    });
  });

  it("flips only the axis that overflows", () => {
    // Horizontally cramped, vertically roomy.
    expect(placePanel(90, 10, { width: 30, height: 10 }, bounds(0, 0, 100, 200))).toEqual({
      left: 90 - OFFSET_X - 30,
      top: 10 + OFFSET_Y,
    });
    // And the mirror image.
    expect(placePanel(10, 90, { width: 10, height: 30 }, bounds(0, 0, 200, 100))).toEqual({
      left: 10 + OFFSET_X,
      top: 90 - OFFSET_Y - 30,
    });
  });

  it("flips both axes in a corner", () => {
    expect(placePanel(95, 95, { width: 30, height: 30 }, bounds(0, 0, 100, 100))).toEqual({
      left: 95 - OFFSET_X - 30,
      top: 95 - OFFSET_Y - 30,
    });
  });

  it("clamps to the bounds' own origin when the panel is bigger than the bounds", () => {
    expect(placePanel(40, 40, { width: 80, height: 80 }, bounds(0, 0, 50, 50))).toEqual({
      left: 0,
      top: 0,
    });
  });
});

describe("visibleBounds — the window narrowed by every clipping ancestor", () => {
  it("is the window itself when nothing clips", () => {
    const [inner] = chain(3);
    expect(visibleBounds(inner!, fakeView(800, 600))).toEqual(bounds(0, 0, 800, 600));
  });

  it("is the window itself for a detached panel with no ancestors", () => {
    expect(visibleBounds(null, fakeView(800, 600))).toEqual(bounds(0, 0, 800, 600));
  });

  it("narrows to a clipping ancestor's box", () => {
    const [inner, outer] = chain(2);
    outer!.rect.left = 100;
    outer!.rect.top = 50;
    outer!.rect.width = 300;
    outer!.rect.height = 200;
    outer!.overflowX = "hidden";
    outer!.overflowY = "hidden";
    expect(visibleBounds(inner!, fakeView(800, 600))).toEqual(bounds(100, 50, 400, 250));
  });

  it("clips only the axis whose overflow is not visible", () => {
    const [inner, outer] = chain(2);
    outer!.rect.left = 100;
    outer!.rect.top = 50;
    outer!.rect.width = 300;
    outer!.rect.height = 200;
    outer!.overflowX = "auto";
    expect(visibleBounds(inner!, fakeView(800, 600))).toEqual(bounds(100, 0, 400, 600));
  });

  it("intersects several clipping ancestors, keeping the tightest edge of each", () => {
    const [inner, middle, outer] = chain(3);
    outer!.rect.left = 0;
    outer!.rect.top = 0;
    outer!.rect.width = 500;
    outer!.rect.height = 500;
    outer!.overflowX = "hidden";
    outer!.overflowY = "hidden";
    middle!.rect.left = 100;
    middle!.rect.top = 100;
    middle!.rect.width = 1000; // wider than its own parent
    middle!.rect.height = 100;
    middle!.overflowX = "hidden";
    middle!.overflowY = "hidden";
    expect(visibleBounds(inner!, fakeView(800, 600))).toEqual(bounds(100, 100, 500, 200));
  });

  it("never widens past the window, however large a clipping ancestor is", () => {
    const [inner, outer] = chain(2);
    outer!.rect.left = -1000;
    outer!.rect.top = -1000;
    outer!.rect.width = 5000;
    outer!.rect.height = 5000;
    outer!.overflowX = "hidden";
    outer!.overflowY = "hidden";
    expect(visibleBounds(inner!, fakeView(800, 600))).toEqual(bounds(0, 0, 800, 600));
  });

  it("includes the starting node itself when it clips", () => {
    const [inner] = chain(1);
    inner!.rect.left = 10;
    inner!.rect.top = 20;
    inner!.rect.width = 100;
    inner!.rect.height = 100;
    inner!.overflowX = "hidden";
    inner!.overflowY = "hidden";
    expect(visibleBounds(inner!, fakeView(800, 600))).toEqual(bounds(10, 20, 110, 120));
  });
});

describe("placement composed the way the panel composes it", () => {
  // The two halves together: a pane inset from the window's left edge with room to spare in the
  // window but not in the pane.
  it("flips at a clipping pane's right edge even though the window has room", () => {
    const [inner, outer] = chain(2);
    outer!.rect.left = 595;
    outer!.rect.width = 1034;
    outer!.rect.height = 900;
    outer!.overflowX = "hidden";
    outer!.overflowY = "hidden";
    const clip = visibleBounds(inner!, fakeView(1900, 900));
    expect(clip.right).toBe(1629);
    const at = placePanel(1624, 100, { width: 233, height: 40 }, clip);
    expect(at.left).toBe(1624 - OFFSET_X - 233);
    expect(at.left + 233).toBeLessThanOrEqual(clip.right);
  });
});
