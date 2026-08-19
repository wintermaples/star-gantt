/** Unit tests for the internal canvas host helpers. */
import { describe, expect, it } from "vitest";
import {
  LAYER_ORDER,
  createChartDom,
  createOverlayHost,
  createOverlayItem,
  createScrollbar,
  get2d,
  layerOf,
  scrollbarAxisClass,
  sizeLayer,
} from "../../src/internal/render/dom";
import { FakeCanvas, FakeDocument } from "../_utils/index";
import type { FakeContext2D } from "../_utils/index";

const doc = (): Document => new FakeDocument() as unknown as Document;

describe("§3.1 chart DOM", () => {
  it("builds .sg-pane--chart with the three data-layer canvases plus .sg-dom-overlay", () => {
    const dom = createChartDom(doc());
    const pane = dom.pane as unknown as { className: string; children: FakeCanvas[] };

    expect(pane.className).toBe("sg-pane sg-pane--chart");
    expect(pane.children.map((c) => c.getAttribute("data-layer"))).toEqual([
      "background",
      "main",
      "overlay",
      null,
    ]);
    expect(pane.children.slice(0, 3).map((c) => c.className)).toEqual([
      "sg-layer",
      "sg-layer",
      "sg-layer",
    ]);
    expect(pane.children[3]?.className).toBe("sg-dom-overlay");
  });

  it("never makes the pane a native scroll container", () => {
    const dom = createChartDom(doc());
    expect(dom.pane.style.overflow).toBe("hidden");
    expect(dom.pane.style.position).toBe("relative");
  });

  // A canvas is not focusable, so without a tabindex
  // on the pane the `mousedown` default action cleared the focus to `<body>` right after a press,
  // and every focus-scoped keyboard binding went dead after a click on a bar. `-1`, not `0`: the
  // pane must not become a second tab stop beside keyboard-a11y's roving mirror row.
  it("makes the pane mouse-focusable without adding a tab stop", () => {
    const dom = createChartDom(doc());
    expect(dom.pane.getAttribute("tabindex")).toBe("-1");
  });

  it("exposes exactly the three layers, back to front", () => {
    expect([...LAYER_ORDER]).toEqual(["background", "main", "overlay"]);
  });
});

describe("§3.2-4 devicePixelRatio sizing", () => {
  it("sets the backing store to cssSize * dpr and scales the context", () => {
    const dom = createChartDom(doc());
    const canvas = dom.canvases.main;
    const g = get2d(canvas);
    sizeLayer(canvas, g, 800, 600, 2);

    expect(canvas.width).toBe(1600);
    expect(canvas.height).toBe(1200);
    expect(canvas.style.width).toBe("800px");
    expect(canvas.style.height).toBe("600px");

    const fake = g as unknown as FakeContext2D;
    expect(fake.calls("scale").map((o) => o.args)).toEqual([[2, 2]]);
    expect(fake.opNames()).toEqual(["setTransform", "scale"]);
  });

  it("rounds fractional DPR backing-store dimensions", () => {
    const dom = createChartDom(doc());
    const canvas = dom.canvases.background;
    sizeLayer(canvas, get2d(canvas), 801, 601, 1.25);
    expect(canvas.width).toBe(1001);
    expect(canvas.height).toBe(751);
  });

  it("resets the transform before scaling so repeated calls do not compound", () => {
    const dom = createChartDom(doc());
    const canvas = dom.canvases.overlay;
    const g = get2d(canvas);
    sizeLayer(canvas, g, 100, 100, 2);
    sizeLayer(canvas, g, 100, 100, 3);
    const fake = g as unknown as FakeContext2D;
    expect(fake.calls("scale").map((o) => o.args)).toEqual([
      [2, 2],
      [3, 3],
    ]);
    // The reset is what stops the second scale compounding: a real 2d transform after
    // `setTransform(1,0,0,1,0,0)` + `scale(3,3)` is 3x, not 6x. (The fork's `scale()` never touched
    // its transform, so it pinned the pre-scale identity — a fake artifact.)
    expect(fake.transform).toEqual([3, 0, 0, 3, 0, 0]);
  });
});

describe("zIndex → canvas mapping", () => {
  it("maps §4.1's todayLine (zIndex 55, invalidate(\"main\")) onto main", () => {
    expect(layerOf(55)).toBe("main");
  });

  it("bands low zIndex to background and high zIndex to overlay", () => {
    expect(layerOf(0)).toBe("background");
    expect(layerOf(49)).toBe("background");
    expect(layerOf(50)).toBe("main");
    expect(layerOf(99)).toBe("main");
    expect(layerOf(100)).toBe("overlay");
    expect(layerOf(1000)).toBe("overlay");
  });
});

describe("§4.2 DOM-overlay clip host and wrappers", () => {
  it("builds a clipping, inert .sg-dom-overlays host", () => {
    const host = createOverlayHost(doc());
    expect(host.className).toBe("sg-dom-overlays");
    expect(host.style.position).toBe("absolute");
    expect(host.style.left).toBe("0");
    expect(host.style.top).toBe("0");
    // §4.2-3: clipping to the viewport rectangle is what keeps overlay content out of the bands
    // reserved through `renderer/insets`.
    expect(host.style.overflow).toBe("hidden");
    // §4.2-5: inert by default, like `.sg-dom-overlay` itself.
    expect(host.style.pointerEvents).toBe("none");
  });

  it("builds a zero-size .sg-dom-overlay-item wrapper tagged with the contribution id", () => {
    const item = createOverlayItem(doc(), "acme.badge");
    expect(item.className).toBe("sg-dom-overlay-item");
    expect(item.getAttribute("data-overlay-id")).toBe("acme.badge");
    // §4.2-2: a containing block for absolutely positioned children that occupies no space itself.
    expect(item.style.position).toBe("absolute");
    expect(item.style.left).toBe("0");
    expect(item.style.top).toBe("0");
    expect(item.style.width).toBe("0");
    expect(item.style.height).toBe("0");
    expect(item.style.pointerEvents).toBe("none");
  });
});

describe("synthetic overlay scrollbar", () => {
  it("builds an inert .sg-scrollbar track with a .sg-scrollbar__thumb child", () => {
    const { track, thumb } = createScrollbar(doc(), "vertical");
    expect(track.className).toBe("sg-scrollbar sg-scrollbar--vertical");
    expect(track.style.position).toBe("absolute");
    expect(track.style.pointerEvents).toBe("none");
    expect(thumb.className).toBe("sg-scrollbar__thumb");
    expect(thumb.style.position).toBe("absolute");
    const parent = thumb as unknown as { parentNode: unknown };
    expect(parent.parentNode).toBe(track);
  });

  // The track stays inert, the thumb is grabbable.
  it("makes the thumb — and only the thumb — a pointer target", () => {
    const { track, thumb } = createScrollbar(doc(), "vertical");
    expect(track.style.pointerEvents).toBe("none");
    expect(thumb.style.pointerEvents).toBe("auto");
    expect(thumb.style.touchAction).toBe("none");
  });

  it("carries the axis modifier so the stylesheet can place each bar", () => {
    expect(createScrollbar(doc(), "horizontal").track.className).toBe(
      "sg-scrollbar sg-scrollbar--horizontal",
    );
    expect(scrollbarAxisClass("vertical")).toBe("sg-scrollbar--vertical");
    expect(scrollbarAxisClass("horizontal")).toBe("sg-scrollbar--horizontal");
  });
});

describe("2d context acquisition", () => {
  it("throws (fatal per §1.9) when no 2d context is available", () => {
    const canvas = { getContext: () => null } as unknown as HTMLCanvasElement;
    expect(() => get2d(canvas)).toThrow(/2d canvas context/);
  });
});
