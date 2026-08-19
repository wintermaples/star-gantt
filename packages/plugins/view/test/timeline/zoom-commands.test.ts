/**
 * The `timeline/zoomIn` / `timeline/zoomOut` commands.
 *
 * one density step per dispatch,
 * the same ladder the Ctrl+wheel gesture climbs; anchored at the given instant, or at the middle
 * of the visible chart area when none is given; a silent no-op at either end of the ladder.
 */
import { afterEach, describe, expect, it } from "vitest";
import { boot, watchZoom } from "./_boot";
import type { Booted } from "./_boot";

let booted: Booted | null = null;

afterEach(() => {
  booted?.dom.restore();
  booted = null;
});

function service(b: Booted) {
  return b.gantt.service("stargantt.timeline");
}

describe("timeline/zoomIn and timeline/zoomOut", () => {
  it("zoomIn steps to the next finer level by density (day -> hour)", () => {
    booted = boot();
    booted.gantt.dispatch("timeline/zoomIn", {});
    expect(service(booted).zoomLevel.get().id).toBe("hour");
  });

  it("zoomOut steps to the next coarser level by density (day -> week -> month)", () => {
    booted = boot();
    booted.gantt.dispatch("timeline/zoomOut", {});
    expect(service(booted).zoomLevel.get().id).toBe("week");
    booted.gantt.dispatch("timeline/zoomOut", {});
    expect(service(booted).zoomLevel.get().id).toBe("month");
  });

  it("is a silent no-op at the finest level", () => {
    booted = boot([], {}, { origin: 0, initialZoom: "hour" });
    const notices = watchZoom(booted);
    booted.gantt.dispatch("timeline/zoomIn", {});
    expect(service(booted).zoomLevel.get().id).toBe("hour");
    expect(notices).toEqual([]);
  });

  it("is a silent no-op at the coarsest level", () => {
    booted = boot([], {}, { origin: 0, initialZoom: "year" });
    const notices = watchZoom(booted);
    booted.gantt.dispatch("timeline/zoomOut", {});
    expect(service(booted).zoomLevel.get().id).toBe("year");
    expect(notices).toEqual([]);
  });

  it("publishes the new level on the `zoomLevel` store", () => {
    booted = boot();
    const notices = watchZoom(booted);
    booted.gantt.dispatch("timeline/zoomIn", {});
    // "hour" is the third contributed built-in level, and the change is a zoom rather than an
    // origin move because the published level carries a different id.
    expect(notices).toEqual([{ level: 2, cause: "zoom" }]);
  });

  // asserted on the *visible* position: the anchor is
  // held by the scroll, so its content x is expected to change while its place on screen is not.
  // Scrolled away from the left edge first, so the clamp has room to give.
  it("keeps an explicit anchorTime under the same point of the chart area", () => {
    booted = boot();
    const s = service(booted);
    const renderer = booted.gantt.service("stargantt.view");
    renderer.scrollTo({ scrollLeft: 60 * 40 });
    const anchor = s.xToT(renderer.viewport.get().scrollLeft + 300);
    const originBefore = s.xToT(0);
    booted.gantt.dispatch("timeline/zoomOut", { anchorTime: anchor });
    expect(s.zoomLevel.get().id).toBe("week");
    expect(s.tToX(anchor) - renderer.viewport.get().scrollLeft).toBeCloseTo(300, 6);
    expect(s.xToT(0)).toBe(originBefore);
  });

  it("anchors at the middle of the visible chart area when no anchorTime is given", () => {
    booted = boot();
    const s = service(booted);
    const renderer = booted.gantt.service("stargantt.view");
    renderer.scrollTo({ scrollLeft: 60 * 40 });
    const vp = renderer.viewport.get();
    const centerT = s.xToT(vp.scrollLeft + vp.width / 2);
    const originBefore = s.xToT(0);
    booted.gantt.dispatch("timeline/zoomOut", {});
    const after = renderer.viewport.get();
    expect(s.xToT(after.scrollLeft + after.width / 2)).toBeCloseTo(centerT, 6);
    expect(s.xToT(0)).toBe(originBefore);
  });

  it("stops at the axis's left edge when the anchor cannot be held", () => {
    booted = boot();
    const s = service(booted);
    const renderer = booted.gantt.service("stargantt.view");
    const originBefore = s.xToT(0);
    // `scrollLeft` is already 0, so holding the anchor across a zoom-out would need a negative
    // scroll. The clamp wins and the axis stays exactly where it was — it does not invent content
    // before the origin to keep the anchor in place.
    booted.gantt.dispatch("timeline/zoomOut", {});
    expect(renderer.viewport.get().scrollLeft).toBe(0);
    expect(s.xToT(0)).toBe(originBefore);
  });

  // asserted on the *visible* position, not on
  // content x: zooming in holds the anchor by scrolling rather than by moving the origin, so the
  // anchor's content x is expected to change while its place on screen is not.
  it("ignores a non-finite anchorTime and anchors at the viewport middle instead", () => {
    booted = boot();
    const s = service(booted);
    const renderer = booted.gantt.service("stargantt.view");
    const vp = renderer.viewport.get();
    const centerT = s.xToT(vp.scrollLeft + vp.width / 2);
    booted.gantt.dispatch("timeline/zoomIn", { anchorTime: Number.NaN });
    expect(s.zoomLevel.get().id).toBe("hour");
    const after = renderer.viewport.get();
    expect(s.xToT(after.scrollLeft + after.width / 2)).toBeCloseTo(centerT, 6);
  });
});
