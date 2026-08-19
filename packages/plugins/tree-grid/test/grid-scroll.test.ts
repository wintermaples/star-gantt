/**
 * `src/internal/grid-scroll.ts` — the virtual vertical offset shared with the chart pane, the
 * horizontal header/body lockstep, and scroll-into-view.
 */
import { describe, expect, it } from "vitest";
import { createGridScroll, mirrorScrollLeft } from "../src/internal/grid-scroll";
import { flatRows, unitModel } from "./_units";

const ROW_H = 28;
const VIEWPORT_H = 300;

interface Harness {
  scroll: ReturnType<typeof createGridScroll>;
  requested: number[];
  repaints(): number;
}

/** A scroll module over `rows` flat rows and a viewport of `viewportHeight` px. */
function harness(rows: number, viewportHeight = VIEWPORT_H, wheelSpeedFactor?: number): Harness {
  const requested: number[] = [];
  let repaints = 0;
  const scroll = createGridScroll({
    model: unitModel(flatRows(rows)),
    viewportHeight: () => viewportHeight,
    schedule: () => {
      repaints += 1;
    },
    requestScrollTop: (scrollTop) => requested.push(scrollTop),
    ...(wheelSpeedFactor === undefined ? {} : { wheelSpeedFactor: () => wheelSpeedFactor }),
  });
  return { scroll, requested, repaints: () => repaints };
}

/** A wheel event double; `deltaX`/`shiftKey` decide whether the grid consumes it at all. */
function wheel(
  init: Partial<{ deltaX: number; deltaY: number; deltaMode: number; shiftKey: boolean }>,
): {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  shiftKey: boolean;
  preventDefault(): void;
  prevented: boolean;
} {
  const e = {
    deltaX: init.deltaX ?? 0,
    deltaY: init.deltaY ?? 0,
    deltaMode: init.deltaMode ?? 0,
    shiftKey: init.shiftKey ?? false,
    prevented: false,
    preventDefault(): void {
      e.prevented = true;
    },
  };
  return e;
}

describe("createGridScroll — wheel", () => {
  it("consumes a vertical gesture, moving and publishing the virtual offset", () => {
    const h = harness(1000);
    const e = wheel({ deltaY: 100 });
    h.scroll.onWheel(e);
    expect(e.prevented).toBe(true);
    expect(h.scroll.top()).toBe(100);
    expect(h.requested).toEqual([100]);
    expect(h.repaints()).toBe(1);
  });

  it("clamps at the top and at the content bottom", () => {
    const h = harness(12); // 336 px of content, 300 px of viewport
    h.scroll.onWheel(wheel({ deltaY: 100_000 }));
    expect(h.scroll.top()).toBe(12 * ROW_H - VIEWPORT_H);
    h.scroll.onWheel(wheel({ deltaY: -100_000 }));
    expect(h.scroll.top()).toBe(0);
  });

  it("stays at zero when the content is shorter than the viewport", () => {
    const h = harness(3);
    h.scroll.onWheel(wheel({ deltaY: 500 }));
    expect(h.scroll.top()).toBe(0);
    expect(h.requested).toEqual([]);
  });

  it("publishes nothing when the offset does not actually change", () => {
    const h = harness(1000);
    h.scroll.onWheel(wheel({ deltaY: 0 }));
    expect(h.requested).toEqual([]);
    expect(h.repaints()).toBe(0);
  });

  it("normalizes a line-mode wheel to ~16px per line unit", () => {
    const h = harness(1000);
    h.scroll.onWheel(wheel({ deltaY: 1, deltaMode: 1 }));
    expect(h.scroll.top()).toBe(16);
  });

  it("applies the renderer's wheelSpeedFactor so both panes scroll at one speed", () => {
    const h = harness(1000, VIEWPORT_H, 2);
    h.scroll.onWheel(wheel({ deltaY: 100 }));
    expect(h.scroll.top()).toBe(200); // = the chart pane's own 100px notch under factor 2
    h.scroll.onWheel(wheel({ deltaY: 1, deltaMode: 1 }));
    expect(h.scroll.top()).toBe(200 + 16 * 2);
  });

  it("leaves a horizontal-dominant gesture to the body's native scroll container", () => {
    const h = harness(1000);
    const pan = wheel({ deltaX: 40, deltaY: 5 });
    h.scroll.onWheel(pan);
    expect(pan.prevented).toBe(false);
    expect(h.scroll.top()).toBe(0);

    const shifted = wheel({ deltaY: 40, shiftKey: true });
    h.scroll.onWheel(shifted);
    expect(shifted.prevented).toBe(false);
    expect(h.scroll.top()).toBe(0);
    expect(h.requested).toEqual([]);
  });
});

describe("createGridScroll — the shared viewport", () => {
  it("mirrors an incoming vertical offset and repaints", () => {
    const h = harness(1000);
    h.scroll.onViewportScrollTop(56);
    expect(h.scroll.top()).toBe(56);
    expect(h.repaints()).toBe(1);
    // Mirroring never re-publishes — that is what stops the round trip recursing.
    expect(h.requested).toEqual([]);
  });

  it("clamps the offset into the current content range on demand", () => {
    // A shrinking row set (a collapse, a delete) can leave the mirrored offset past the content.
    const h = harness(12); // 336 px of content, 300 px of viewport
    h.scroll.onViewportScrollTop(10_000);
    h.scroll.clamp();
    expect(h.scroll.top()).toBe(12 * ROW_H - VIEWPORT_H);

    h.scroll.onViewportScrollTop(-50);
    h.scroll.clamp();
    expect(h.scroll.top()).toBe(0);
  });
});

describe("createGridScroll — scrollRowIntoView", () => {
  it("scrolls down by the minimum amount to reveal a row below the viewport", () => {
    const h = harness(1000);
    h.scroll.scrollRowIntoView("t20");
    // Row 20 spans [560, 588): the minimum move puts its bottom edge on the viewport bottom.
    expect(h.scroll.top()).toBe(20 * ROW_H + ROW_H - VIEWPORT_H);
    expect(h.requested).toEqual([h.scroll.top()]);
  });

  it("scrolls up so a row above the viewport sits at the top edge", () => {
    const h = harness(1000);
    h.scroll.onViewportScrollTop(1000);
    h.scroll.scrollRowIntoView("t5");
    expect(h.scroll.top()).toBe(5 * ROW_H);
  });

  it("does nothing for a row that is already fully visible", () => {
    const h = harness(1000);
    h.scroll.scrollRowIntoView("t3");
    expect(h.scroll.top()).toBe(0);
    expect(h.requested).toEqual([]);
  });

  it("does nothing for a task that is not a visible row", () => {
    const h = harness(10);
    h.scroll.scrollRowIntoView("missing");
    expect(h.scroll.top()).toBe(0);
    expect(h.requested).toEqual([]);
  });

  it("stays inside the content range", () => {
    const h = harness(12);
    h.scroll.scrollRowIntoView("t11");
    expect(h.scroll.top()).toBe(12 * ROW_H - VIEWPORT_H);
  });
});

describe("mirrorScrollLeft", () => {
  it("copies the source's offset onto the target", () => {
    const source = { scrollLeft: 0 } as unknown as HTMLElement;
    const target = { scrollLeft: 0 } as unknown as HTMLElement;
    const sync = mirrorScrollLeft(source, target);
    source.scrollLeft = 120;
    sync();
    expect(target.scrollLeft).toBe(120);
  });

  it("writes nothing when the two already agree, so the pair cannot re-trigger each other", () => {
    const source = { scrollLeft: 40 } as unknown as HTMLElement;
    const target = {} as unknown as HTMLElement;
    let writes = 0;
    Object.defineProperty(target, "scrollLeft", {
      get: () => 40,
      set: () => {
        writes += 1;
      },
    });
    mirrorScrollLeft(source, target)();
    expect(writes).toBe(0);
  });
});
