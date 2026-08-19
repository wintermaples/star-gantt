/**
 * Hostless unit tests for the synthetic scrollbars: the pure thumb geometry, the
 * drag's inverse mapping, and the controller's drag machine driven against a fake pane.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SCROLLBAR_MIN_THUMB,
  createScrollbars,
  scrollFromThumb,
  thumbGeometry,
} from "../../src/internal/render/scrollbars";
import type { ScrollbarViewState } from "../../src/internal/render/scrollbars";
import { createPointerClaim } from "../../src/internal/render/pointer";
import type { ScrollbarAxis } from "../../src/internal/render/dom";
import { FakeDocument, asElement, pointerEvent } from "../_utils/index";
import type { FakeElement } from "../_utils/index";

describe("thumbGeometry", () => {
  it("hides the bar while the axis is not scrollable", () => {
    expect(thumbGeometry(400, 400, undefined, 0)).toBeNull();
    expect(thumbGeometry(400, 400, 200, 0)).toBeNull();
    expect(thumbGeometry(400, 400, 400, 0)).toBeNull();
  });

  it("sizes the thumb as track × view / content", () => {
    expect(thumbGeometry(400, 400, 1000, 0)).toEqual({
      trackSize: 400,
      thumbSize: 160,
      thumbOffset: 0,
      maxScroll: 600,
    });
  });

  it("offsets the thumb as (track − thumb) × scroll / maxScroll", () => {
    expect(thumbGeometry(400, 400, 1000, 300)?.thumbOffset).toBe(120);
    expect(thumbGeometry(400, 400, 1000, 600)?.thumbOffset).toBe(240);
  });

  it("keeps the thumb grabbable at a huge extent, without exceeding the track", () => {
    const huge = thumbGeometry(400, 400, 1_000_000, 0);
    expect(huge?.thumbSize).toBe(SCROLLBAR_MIN_THUMB);
    const tiny = thumbGeometry(10, 400, 1_000_000, 0);
    expect(tiny?.thumbSize).toBe(10);
  });

  it("keeps the thumb at the leading edge when the axis has no room to scroll", () => {
    // A content extent above the view with a zero-length scrollable range cannot divide.
    expect(thumbGeometry(0, 0, 10, 5)).toEqual({
      trackSize: 0,
      thumbSize: 0,
      thumbOffset: 0,
      maxScroll: 10,
    });
  });
});

describe("scrollFromThumb", () => {
  const geometry = thumbGeometry(400, 400, 1000, 0);

  it("is the exact inverse of the thumb offset", () => {
    if (geometry === null) throw new Error("expected a scrollable axis");
    // trackSize 400, thumbSize 160 → span 240; maxScroll 600.
    expect(scrollFromThumb(170, 50, geometry)).toBe(300);
    expect(scrollFromThumb(50, 50, geometry)).toBe(0);
  });

  it("maps past either end, leaving the clamp to the caller", () => {
    if (geometry === null) throw new Error("expected a scrollable axis");
    expect(scrollFromThumb(5_000, 0, geometry)).toBeGreaterThan(600);
    expect(scrollFromThumb(-100, 0, geometry)).toBeLessThan(0);
  });

  it("expresses no position when the thumb fills its track", () => {
    expect(
      scrollFromThumb(100, 0, { trackSize: 400, thumbSize: 400, thumbOffset: 0, maxScroll: 600 }),
    ).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * The controller: creation, per-frame update and the thumb drag
 * ------------------------------------------------------------------ */

interface Harness {
  /** The pane's owner document — where the drag's move/up/cancel listeners live. */
  doc: FakeDocument;
  pane: FakeElement;
  claim: ReturnType<typeof createPointerClaim>;
  bars: ReturnType<typeof createScrollbars>;
  state: {
    vp: { scrollTop: number; scrollLeft: number; width: number; height: number };
    content: { width?: number; height?: number };
  };
  scrolls: [ScrollbarAxis, number][];
  frames: number;
  disposals: (() => void)[];
  thumb(axis: ScrollbarAxis): FakeElement;
}

function harness(enabled = true, direction: "ltr" | "rtl" = "ltr"): Harness {
  const doc = new FakeDocument();
  const pane = doc.createElement("div");
  const claim = createPointerClaim();
  const state = {
    vp: { scrollTop: 0, scrollLeft: 0, width: 640, height: 400 },
    content: {} as { width?: number; height?: number },
  };
  const scrolls: [ScrollbarAxis, number][] = [];
  const disposals: (() => void)[] = [];
  const h = {
    doc,
    pane,
    claim,
    state,
    scrolls,
    frames: 0,
    disposals,
    thumb(axis: ScrollbarAxis): FakeElement {
      const track = pane.children.find((c) =>
        c.className.split(" ").includes(`sg-scrollbar--${axis}`),
      );
      const el = track?.children[0];
      if (el === undefined) throw new Error(`no ${axis} thumb`);
      return el;
    },
  } as Harness;
  h.bars = createScrollbars({
    pane: asElement(pane),
    enabled,
    direction,
    claim,
    viewState: (): ScrollbarViewState => ({
      vp: state.vp,
      insets: { top: 0, bottom: 0 },
      extent: { width: state.content.width, height: state.content.height },
    }),
    scrollAxisTo: (axis, offset) => scrolls.push([axis, offset]),
    scheduleFrame: () => {
      h.frames += 1;
    },
    listen: (el, type, fn) => {
      (el as unknown as FakeElement).addEventListener(type, fn as (e: never) => void);
    },
    own: (dispose) => disposals.push(dispose),
  });
  return h;
}

/** A harness whose vertical axis overflows: track 400, thumb 160, span 240, maxScroll 600. */
function overflowing(): Harness {
  const h = harness();
  h.state.content.height = 1000;
  h.bars.update();
  return h;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createScrollbars", () => {
  it("creates one bar per axis, appended to the pane, and nothing when disabled", () => {
    expect(harness().pane.children.map((c) => c.className)).toEqual([
      "sg-scrollbar sg-scrollbar--vertical",
      "sg-scrollbar sg-scrollbar--horizontal",
    ]);
    expect(harness(false).pane.children).toEqual([]);
  });

  it("hides a bar whose axis is not scrollable and shows it once it overflows", () => {
    const h = harness();
    h.bars.update();
    const track = h.pane.children[0];
    expect(track?.style["display"]).toBe("none");

    h.state.content.height = 1000;
    h.bars.update();
    expect(track?.style["display"]).toBe("block");
    expect(track?.style["height"]).toBe("400px");
    expect(h.thumb("vertical").style["height"]).toBe("160px");
  });

  it("maps a drag back through the inverse formula, keeping the grab offset", () => {
    const h = overflowing();
    const thumb = h.thumb("vertical");

    thumb.fire("pointerdown", pointerEvent(600, 50));
    h.doc.fire("pointermove", pointerEvent(600, 170));
    expect(h.scrolls).toEqual([["vertical", 300]]);
    expect(h.claim.holder()).toBe("thumb");
    expect(thumb.captured).toEqual([1]);
  });

  // Renderer-owned chrome mirrors in RTL.
  describe("RTL mirroring", () => {
    function rtlOverflowingX(): Harness {
      const h = harness(true, "rtl");
      h.state.content.width = 1280; // trackSize 640, thumbSize 320, maxScroll 640
      h.bars.update();
      return h;
    }

    it("places the vertical bar at the left edge", () => {
      const h = harness(true, "rtl");
      h.state.content.height = 1000;
      h.bars.update();
      const track = h.pane.children[0];
      expect(track?.style["left"]).toBe("2px");
      expect(track?.style["right"]).toBe("auto");
    });

    it("mirrors the horizontal thumb: scroll 0 shows it at the right end of the track", () => {
      const h = rtlOverflowingX();
      expect(h.thumb("horizontal").style["left"]).toBe("320px");
      h.state.vp.scrollLeft = 640;
      h.bars.update();
      expect(h.thumb("horizontal").style["left"]).toBe("0px");
    });

    it("maps a horizontal drag from the right-leading edge", () => {
      const h = rtlOverflowingX();
      const track = h.pane.children[1]!;
      track.rect = { left: 0, top: 0, width: 640, height: 8 };
      const thumb = h.thumb("horizontal");
      thumb.fire("pointerdown", pointerEvent(600, 500));
      h.doc.fire("pointermove", pointerEvent(400, 500));
      expect(h.scrolls).toEqual([["horizontal", 400]]);
    });

    it("leaves the LTR geometry untouched by default", () => {
      const h = harness();
      h.state.content.width = 1280;
      h.bars.update();
      expect(h.thumb("horizontal").style["left"]).toBe("0px");
      expect(h.pane.children[0]?.style["left"]).toBeUndefined();
    });
  });

  it("consumes the press and starts nothing on a hidden bar", () => {
    const h = harness();
    h.bars.update();
    const press = pointerEvent(600, 50);
    h.thumb("vertical").fire("pointerdown", press);

    expect((press as unknown as { propagationStopped: boolean }).propagationStopped).toBe(true);
    expect(h.claim.holder()).toBeNull();
    expect(h.thumb("vertical").captured).toEqual([]);
  });

  it("refuses the drag while another machine holds the pointer claim", () => {
    const h = overflowing();
    h.claim.claim("gesture");
    const thumb = h.thumb("vertical");

    thumb.fire("pointerdown", pointerEvent(600, 50));
    h.doc.fire("pointermove", pointerEvent(600, 170));
    expect(h.scrolls).toEqual([]);
    expect(thumb.captured).toEqual([]);
  });

  it("releases the claim, the capture and a paint pass when the drag ends", () => {
    for (const type of ["pointerup", "pointercancel"] as const) {
      const h = overflowing();
      const thumb = h.thumb("vertical");
      thumb.fire("pointerdown", pointerEvent(600, 50, { pointerId: 4 }));
      const before = h.frames;

      h.doc.fire(type, pointerEvent(600, 50, { pointerId: 4 }));
      expect(h.claim.holder()).toBeNull();
      expect(thumb.captured).toEqual([]);
      // A hover recorded before the press is resolved in a paint pass, so one is asked for.
      expect(h.frames).toBe(before + 1);

      h.doc.fire("pointermove", pointerEvent(600, 300, { pointerId: 4 }));
      expect(h.scrolls).toHaveLength(0);
    }
  });

  it("ignores a move or an end that belongs to another pointer", () => {
    const h = overflowing();
    const thumb = h.thumb("vertical");
    thumb.fire("pointerdown", pointerEvent(600, 50, { pointerId: 1 }));
    h.doc.fire("pointermove", pointerEvent(600, 170, { pointerId: 2 }));
    h.doc.fire("pointerup", pointerEvent(600, 170, { pointerId: 2 }));
    expect(h.scrolls).toEqual([]);
    expect(h.claim.holder()).toBe("thumb");
  });

  it("holds the active style for the whole drag and drops it after the linger", () => {
    vi.useFakeTimers();
    const h = overflowing();
    const track = h.pane.children[0];
    const thumb = h.thumb("vertical");

    thumb.fire("pointerdown", pointerEvent(600, 50));
    expect(track?.className).toContain("sg-scrollbar--active");
    vi.advanceTimersByTime(1_000);
    expect(track?.className).toContain("sg-scrollbar--active");

    h.doc.fire("pointerup", pointerEvent(600, 50));
    vi.advanceTimersByTime(300);
    expect(track?.className).toBe("sg-scrollbar sg-scrollbar--vertical");
  });

  it("re-arms the linger by swapping one timer, and clears it on disposal", () => {
    vi.useFakeTimers();
    const h = overflowing();
    const track = h.pane.children[0];

    h.bars.noteActivity();
    vi.advanceTimersByTime(200);
    h.bars.noteActivity();
    vi.advanceTimersByTime(200);
    h.bars.update();
    expect(track?.className).toContain("sg-scrollbar--active");

    for (const dispose of h.disposals) dispose();
    expect(h.claim.holder()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(h.pane.children).toEqual([]);
  });
});
