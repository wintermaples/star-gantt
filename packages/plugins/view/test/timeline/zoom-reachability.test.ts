/**
 * The zoom path may not strand content behind an unreachable origin.
 *
 * Nothing scrolls left of content x = 0, so an
 * anchored zoom that moved the origin *later* put every earlier instant out of reach — and a
 * zoom-out, a scroll and a zoom-in walked it forward once per sweep and never back. These run the
 * whole gesture sequence against a real chart, because the fault is only visible once the scroll
 * position takes part.
 */
import { afterEach, describe, expect, it } from "vitest";
import { definePlugin } from "@stargantt/core";
import type { AnyPlugin, PluginContext } from "@stargantt/core";
import { bootWithStore } from "./_boot";
import type { BootedWithStore } from "./_boot";

let booted: BootedWithStore | null = null;

afterEach(() => {
  booted?.dom.restore();
  booted = null;
});

const JAN1 = Date.UTC(2026, 0, 1);
const FEB1 = Date.UTC(2026, 1, 1);

/** Fills the store during startup, so `lifecycle/ready` already sees the task. */
function seed(): AnyPlugin {
  return definePlugin({
    meta: { id: "test.seed", dependsOn: ["stargantt.data-store"] },
    setup: (ctx: PluginContext) =>
      void ctx.use("stargantt.data").load([{ id: "a", name: "A", start: JAN1, end: FEB1 }]),
  });
}

/**
 * Bounds the axis the way `stargantt.task-bars` does — the latest task instant plus one viewport
 * — without depending on that package for one test.
 */
function extentBound(): AnyPlugin {
  return definePlugin({
    // One plugin owns both services now, so one dependency covers both `ctx.use` calls below.
    meta: { id: "test.extent", dependsOn: ["stargantt.view"] },
    setup: (ctx: PluginContext) => {
      const renderer = ctx.use("stargantt.view");
      const scale = ctx.use("stargantt.timeline");
      ctx.contribute("renderer/contentExtent", {
        id: "test.extent",
        measure: () => ({ width: scale.tToX(FEB1) + renderer.viewport.get().width }),
      });
    },
  });
}

/** `year` is the coarsest built-in level and `day` the level the chart opens at. */
const TO_YEAR = 4;

describe("zoom reachability", () => {
  it("leaves the task reachable after zoom out → scroll away → zoom back in", () => {
    booted = bootWithStore({ origin: JAN1, initialZoom: "day" }, {}, [seed()]);
    const scale = booted.gantt.service("stargantt.timeline");

    for (let i = 0; i < TO_YEAR; i++) booted.gantt.dispatch("timeline/zoomOut", {});
    expect(scale.zoomLevel.get().id).toBe("year");

    // Scroll right until the task is off screen to the left. At 0.5 px/day this is years of slack.
    booted.renderer.scrollTo({ scrollLeft: 2000 });
    expect(booted.visibleRange().from).toBeGreaterThan(FEB1);

    for (let i = 0; i < TO_YEAR; i++) booted.gantt.dispatch("timeline/zoomIn", {});
    expect(scale.zoomLevel.get().id).toBe("day");

    // The task is still on the reachable side of the axis…
    expect(scale.tToX(JAN1)).toBeGreaterThanOrEqual(0);
    // …and scrolling back to the left edge actually reaches it.
    booted.renderer.scrollTo({ scrollLeft: 0 });
    expect(booted.visibleRange().from).toBeLessThanOrEqual(JAN1);
  });

  it("never walks the origin forward, however many sweeps the reader makes", () => {
    booted = bootWithStore({ origin: JAN1, initialZoom: "day" }, {}, [seed()]);
    const scale = booted.gantt.service("stargantt.timeline");

    for (let sweep = 0; sweep < 3; sweep++) {
      for (let i = 0; i < TO_YEAR; i++) booted.gantt.dispatch("timeline/zoomOut", {});
      booted.renderer.scrollTo({ scrollLeft: 2000 });
      for (let i = 0; i < TO_YEAR; i++) booted.gantt.dispatch("timeline/zoomIn", {});
      expect(scale.xToT(0)).toBeLessThanOrEqual(JAN1);
    }
  });

  // §1.18's other clamp end: the axis is bounded at the latest task instant plus one viewport,
  // so a zoom-in anchored past the data cannot follow its anchor into empty space.
  it("settles at the content's right edge when the anchor is past the data", () => {
    booted = bootWithStore({ origin: JAN1, initialZoom: "day" }, {}, [seed(), extentBound()]);
    const scale = booted.gantt.service("stargantt.timeline");

    for (let i = 0; i < TO_YEAR; i++) booted.gantt.dispatch("timeline/zoomOut", {});
    // Ask for far more scroll than exists; the clamp puts us at the axis's right edge.
    booted.renderer.scrollTo({ scrollLeft: 1e9 });
    const maxAtYear = booted.renderer.viewport.get().scrollLeft;
    expect(maxAtYear).toBeGreaterThan(0);

    for (let i = 0; i < TO_YEAR; i++) booted.gantt.dispatch("timeline/zoomIn", {});

    const vp = booted.renderer.viewport.get();
    // Still at the right edge — one viewport past the last task end, never beyond it.
    expect(vp.scrollLeft).toBeCloseTo(scale.tToX(FEB1), 6);
    // And the data is on screen rather than somewhere off to the left.
    expect(booted.visibleRange().to).toBeGreaterThan(FEB1);
  });

  it("holds the anchor on screen while zooming in, rather than in content coordinates", () => {
    booted = bootWithStore({ origin: JAN1, initialZoom: "week" }, {}, [seed()]);
    const scale = booted.gantt.service("stargantt.timeline");
    booted.renderer.scrollTo({ scrollLeft: 120 });
    const vp = booted.renderer.viewport.get();
    const centre = scale.xToT(vp.scrollLeft + vp.width / 2);

    booted.gantt.dispatch("timeline/zoomIn", {});
    expect(scale.zoomLevel.get().id).toBe("day");

    const after = booted.renderer.viewport.get();
    expect(scale.xToT(after.scrollLeft + after.width / 2)).toBeCloseTo(centre, 6);
    // The origin did not move, which is the whole point: it is what could not be undone.
    expect(scale.xToT(0)).toBe(JAN1);
  });
});
