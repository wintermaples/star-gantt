/**
 * The axis in isolation: origin, level resolution and anchored zoom, with no host and no DOM.
 *
 * The chart-level behaviour these rules produce is covered against a real `Gantt.create()`
 * elsewhere; this file pins the arithmetic itself, which is where an anchoring sign error lives.
 */
import { describe, expect, it } from "vitest";
import type { ZoomLevel } from "../../src/internal/timeline/index";
import { MS_DAY } from "../../src/internal/timeline/scale";
import { createZoomAxis, startOfUtcDay, usableLevel } from "../../src/internal/timeline/zoom";
import type { ZoomAxis } from "../../src/internal/timeline/zoom";

const scales = [{ unit: "day" as const, format: () => "x" }];

function level(id: string, pxPerDay: number): ZoomLevel {
  return { id, pxPerDay, scales };
}

const LEVELS: ZoomLevel[] = [level("day", 40), level("week", 12), level("hour", 480)];

interface Harness {
  axis: ZoomAxis;
  /** Indices reported to `onZoomChanged`, in order. */
  changes: number[];
  /** Content-pixel shifts reported to `onOriginChanged`, in order. */
  shifts: number[];
  /** Content-pixel scroll deltas reported to `onAnchorScroll`, in order. */
  anchorScrolls: number[];
}

function axisOver(
  levels: ZoomLevel[],
  options: { origin?: number; initialZoom?: string } = {},
): Harness {
  const changes: number[] = [];
  const shifts: number[] = [];
  const anchorScrolls: number[] = [];
  const axis = createZoomAxis({
    pluginId: "test.axis",
    origin: options.origin,
    initialZoom: options.initialZoom,
    levels: () => levels,
    onZoomChanged: (index) => changes.push(index),
    onOriginChanged: (shiftPx) => shifts.push(shiftPx),
    onAnchorScroll: (deltaPx) => anchorScrolls.push(deltaPx),
  });
  return { axis, changes, shifts, anchorScrolls };
}

describe("createZoomAxis", () => {
  it("maps time to content x through the active level's density", () => {
    const { axis } = axisOver(LEVELS, { origin: 0 });
    expect(axis.pxPerMs()).toBe(40 / MS_DAY);
    expect(axis.tToX(0)).toBe(0);
    expect(axis.tToX(2 * MS_DAY)).toBe(80);
    expect(axis.xToT(80)).toBe(2 * MS_DAY);
  });

  it("counts x from the configured origin", () => {
    const origin = Date.UTC(2026, 0, 5);
    const { axis } = axisOver(LEVELS, { origin });
    expect(axis.tToX(origin)).toBe(0);
    expect(axis.tToX(origin + MS_DAY)).toBe(40);
  });

  it("defaults the origin to the start of the current UTC day", () => {
    const { axis } = axisOver(LEVELS);
    expect(axis.xToT(0)).toBe(startOfUtcDay(Date.now()));
  });

  it("ignores a non-finite configured origin", () => {
    const { axis } = axisOver(LEVELS, { origin: Number.NaN });
    expect(axis.xToT(0)).toBe(startOfUtcDay(Date.now()));
  });

  it("starts at the first level when `initialZoom` is omitted", () => {
    expect(axisOver(LEVELS).axis.currentLevel().id).toBe("day");
  });

  it("starts at the named level, and silently falls back to the first for an unknown id", () => {
    expect(axisOver(LEVELS, { initialZoom: "hour" }).axis.currentLevel().id).toBe("hour");
    expect(axisOver(LEVELS, { initialZoom: "decade" }).axis.currentLevel().id).toBe("day");
  });

  it("resolves `initialZoom` against the list as it reads on the first use, once", () => {
    // A level another plugin contributes only becomes visible after this plugin's own setup, which
    // is why resolution is deferred to the first read rather than done up front.
    const levels: ZoomLevel[] = [level("day", 40)];
    const changes: number[] = [];
    const axis = createZoomAxis({
      pluginId: "test.axis",
      origin: 0,
      initialZoom: "third-party",
      levels: () => levels,
      onZoomChanged: (index) => changes.push(index),
      onOriginChanged: () => undefined,
      onAnchorScroll: () => undefined,
    });
    levels.push(level("third-party", 100));
    expect(axis.currentLevel().id).toBe("third-party");
    // Resolved once: a later list change does not re-run it.
    levels.unshift(level("earlier", 7));
    expect(axis.currentLevel().id).toBe("third-party");
  });

  it("reports the new level's index in the composed list on every change", () => {
    const { axis, changes } = axisOver(LEVELS, { origin: 0 });
    axis.setZoomLevel("hour");
    axis.setZoomLevel("week");
    expect(changes).toEqual([2, 1]);
  });

  it("is a no-op when the level is already active", () => {
    const { axis, changes } = axisOver(LEVELS, { origin: 0 });
    axis.setZoomLevel("day");
    expect(changes).toEqual([]);
  });

  it("throws on an unknown level id", () => {
    const { axis } = axisOver(LEVELS, { origin: 0 });
    expect(() => axis.setZoomLevel("decade")).toThrow(/unknown zoom level/);
  });

  it("throws when no level is registered at all", () => {
    const { axis } = axisOver([], { origin: 0 });
    expect(() => axis.currentLevel()).toThrow(/no zoom levels are registered/);
  });

  // the anchor is held by the scroll in both
  // directions. Letting the origin hold it instead either stranded earlier content (moving later)
  // or accumulated unbounded dead space (moving earlier, never recovered).
  it("holds a zoom-in anchor with the scroll, the origin taking no part", () => {
    const { axis, anchorScrolls } = axisOver(LEVELS, { origin: 0 });
    const anchor = 10 * MS_DAY;
    const before = axis.tToX(anchor);
    axis.setZoomLevel("hour", anchor);
    expect(axis.pxPerMs()).toBe(480 / MS_DAY);
    expect(axis.origin()).toBe(0);
    // The anchor's content x grew by exactly the reported scroll, so applying it puts the anchor
    // back under the same point of the chart area.
    expect(anchorScrolls).toHaveLength(1);
    expect(axis.tToX(anchor) - before).toBeCloseTo(anchorScrolls[0] ?? Number.NaN, 6);
  });

  it("never moves the origin, however far a zoom sweep is anchored ahead", () => {
    const { axis } = axisOver(LEVELS, { origin: 0 });
    // The anchor sits 4000 days out — the "scrolled far past the data, then zoomed back in" case
    // that used to walk the origin forward once per sweep and never back.
    const anchor = 4000 * MS_DAY;
    axis.setZoomLevel("week", anchor);
    axis.setZoomLevel("day", anchor);
    axis.setZoomLevel("hour", anchor);
    expect(axis.origin()).toBe(0);
    expect(axis.tToX(0)).toBe(0);
  });

  it("makes a zoom sweep exactly reversible, at the axis and at the scroll", () => {
    const { axis, anchorScrolls } = axisOver(LEVELS, { origin: 0 });
    // Repeated out/in cycles must not accumulate anything: neither an origin walking away from the
    // data, nor a scroll offset that never comes back.
    const anchor = 9 * MS_DAY;
    for (let i = 0; i < 10; i++) {
      axis.setZoomLevel("week", anchor);
      axis.setZoomLevel("day", anchor);
    }
    expect(axis.origin()).toBe(0);
    // Each cycle asks for a move out and the exactly opposite move back, so they sum to zero.
    expect(anchorScrolls).toHaveLength(20);
    expect(anchorScrolls.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 6);
  });

  it("holds an anchor before the origin too, with both signs inverted", () => {
    const { axis, anchorScrolls } = axisOver(LEVELS, { origin: 0 });
    // Only reachable through the explicit `anchorTime` API — no viewport-derived anchor precedes the
    // origin — but the formula must still hold it rather than assume a sign.
    const anchor = -5 * MS_DAY;
    const before = axis.tToX(anchor);
    axis.setZoomLevel("hour", anchor);
    expect(axis.origin()).toBe(0);
    expect(anchorScrolls).toHaveLength(1);
    // Zooming *in* on an anchor left of the origin drives it further left, so the scroll goes back.
    expect(anchorScrolls[0]).toBeLessThan(0);
    expect(axis.tToX(anchor) - before).toBeCloseTo(anchorScrolls[0] ?? Number.NaN, 6);
  });

  it("asks the scroll to move back, not the origin, when zooming out", () => {
    const { axis, anchorScrolls } = axisOver(LEVELS, { origin: 0 });
    const anchor = 3 * MS_DAY;
    const before = axis.tToX(anchor);
    axis.setZoomLevel("week", anchor);
    // The origin is untouched, so at a coarser density the anchor's content x shrank — and the
    // reported scroll is exactly that shrinkage, hence negative.
    expect(axis.xToT(0)).toBe(0);
    expect(anchorScrolls).toHaveLength(1);
    expect(anchorScrolls[0]).toBeLessThan(0);
    expect(axis.tToX(anchor) - before).toBeCloseTo(anchorScrolls[0] ?? Number.NaN, 9);
  });

  it("leaves the origin alone when no usable anchor is given", () => {
    const { axis } = axisOver(LEVELS, { origin: 0 });
    axis.setZoomLevel("week");
    expect(axis.xToT(0)).toBe(0);
    axis.setZoomLevel("hour", Number.NaN);
    expect(axis.xToT(0)).toBe(0);
  });

  // the origin became settable at runtime.
  it("moves the instant at content x = 0", () => {
    const { axis } = axisOver(LEVELS, { origin: 0 });
    axis.setOrigin(-5 * MS_DAY);
    expect(axis.origin()).toBe(-5 * MS_DAY);
    expect(axis.xToT(0)).toBe(-5 * MS_DAY);
    // What used to sit at x = 0 is now five days' worth of pixels to the right.
    expect(axis.tToX(0)).toBe(5 * 40);
  });

  it("reports the content shift every x grew by, signed", () => {
    const { axis, shifts } = axisOver(LEVELS, { origin: 0 });
    // Earlier origin ⇒ content grows to the right ⇒ positive shift.
    axis.setOrigin(-5 * MS_DAY);
    // Later origin ⇒ content shrinks ⇒ negative shift.
    axis.setOrigin(-3 * MS_DAY);
    expect(shifts).toEqual([200, -80]);
  });

  it("scales the reported shift by the active level's density", () => {
    const { axis, shifts } = axisOver(LEVELS, { origin: 0 });
    axis.setZoomLevel("week"); // 12 px/day
    axis.setOrigin(-10 * MS_DAY);
    expect(shifts).toHaveLength(1);
    expect(shifts[0]).toBeCloseTo(120, 9);
  });

  it("ignores a non-finite origin and a value that changes nothing", () => {
    const { axis, shifts } = axisOver(LEVELS, { origin: 0 });
    axis.setOrigin(Number.NaN);
    axis.setOrigin(Number.POSITIVE_INFINITY);
    axis.setOrigin(0);
    expect(axis.origin()).toBe(0);
    expect(shifts).toEqual([]);
  });

  it("reports no origin shift for the anchored zoom, which does not move the origin", () => {
    const { axis, shifts } = axisOver(LEVELS, { origin: 0 });
    axis.setZoomLevel("week", 3 * MS_DAY);
    // `onOriginChanged` means "the axis moved, compensate the view". A zoom is the other way round.
    expect(axis.origin()).toBe(0);
    expect(shifts).toEqual([]);
  });

  it("steps by density, not by contribution order, on a wheel notch", () => {
    // The list is contributed day (40) → week (12) → hour (480); zooming in has to reach `hour`.
    const { axis } = axisOver(LEVELS, { origin: 0 });
    axis.zoomByWheel(-1, () => 0);
    expect(axis.currentLevel().id).toBe("hour");
    axis.zoomByWheel(1, () => 0);
    expect(axis.currentLevel().id).toBe("day");
    axis.zoomByWheel(1, () => 0);
    expect(axis.currentLevel().id).toBe("week");
  });

  it("anchors a wheel notch on the instant under the pointer", () => {
    const { axis, anchorScrolls } = axisOver(LEVELS, { origin: 0 });
    const pointerX = 137;
    const under = axis.xToT(pointerX);
    axis.zoomByWheel(-1, () => pointerX);
    // A notch inwards takes the scroll branch: the pointer's content x moved by the
    // reported distance, so scrolling by it leaves the same instant under the pointer.
    expect(anchorScrolls).toHaveLength(1);
    expect(axis.xToT(pointerX + (anchorScrolls[0] ?? Number.NaN))).toBeCloseTo(under, 6);
  });

  it("anchors an outward wheel notch by scrolling back, leaving the origin alone", () => {
    const { axis, anchorScrolls } = axisOver(LEVELS, { origin: 0 });
    const pointerX = 137;
    const under = axis.xToT(pointerX);
    axis.zoomByWheel(1, () => pointerX);
    expect(axis.origin()).toBe(0);
    expect(anchorScrolls).toHaveLength(1);
    expect(anchorScrolls[0]).toBeLessThan(0);
    expect(axis.xToT(pointerX + (anchorScrolls[0] ?? Number.NaN))).toBeCloseTo(under, 6);
  });

  it("does nothing at either end of the range, and asks for no pointer position there", () => {
    const { axis, changes } = axisOver(LEVELS, { origin: 0 });
    let asked = 0;
    const pointer = (): number => {
      asked++;
      return 0;
    };
    axis.setZoomLevel("hour");
    axis.zoomByWheel(-1, pointer);
    expect(axis.currentLevel().id).toBe("hour");
    axis.setZoomLevel("week");
    axis.zoomByWheel(1, pointer);
    expect(axis.currentLevel().id).toBe("week");
    expect(asked).toBe(0);
    expect(changes).toEqual([2, 1]);
  });
});

describe("usableLevel", () => {
  it("accepts a level with an id, a positive finite density and at least one row", () => {
    expect(usableLevel(level("ok", 1))).toBe(true);
  });

  it.each([
    ["null", null],
    ["a non-object", 7],
    ["an empty id", { id: "", pxPerDay: 4, scales }],
    ["a missing id", { pxPerDay: 4, scales }],
    ["a zero density", { id: "a", pxPerDay: 0, scales }],
    ["a negative density", { id: "a", pxPerDay: -4, scales }],
    ["a non-finite density", { id: "a", pxPerDay: Number.POSITIVE_INFINITY, scales }],
    ["no rows", { id: "a", pxPerDay: 4, scales: [] }],
    ["a non-array `scales`", { id: "a", pxPerDay: 4, scales: "day" }],
  ])("rejects %s", (_label, value) => {
    expect(usableLevel(value)).toBe(false);
  });
});
