// Hostless unit tests for the ghost's geometry (`src/internal/gesture/ghost.ts`): the rectangles a
// drag paints, computed from the drawn bar and the projection alone — no canvas, no host.
import { describe, expect, it } from "vitest";
import { MIN_GHOST_WIDTH, ghostRectFor, ghostRectsFor, onScreen } from "../src/internal/gesture/ghost";
import type { GhostViewport, Projection } from "../src/internal/gesture/ghost";
import type { DateGesture } from "../src/internal/drag/pointer-gesture";

/** One millisecond is one pixel, with time 0 at content x 0. */
const projection: Projection = { tToX: (t) => t };

const VIEW: GhostViewport = { scrollLeft: 0, scrollTop: 0, width: 2_000 };
const ORIGIN = { start: 1_000, end: 1_200 };

/**
 * A drawn bar, with the two offsets the press computes: the box's edges against the content x of the
 * bar's own dates. Zero for a bar drawn exactly on its dates, negative on the right for a milestone
 * whose box is narrower than its period.
 */
function placement(
  box: { left: number; top: number; width: number; height: number },
  range = ORIGIN,
  projection_ = projection,
) {
  return {
    ...box,
    startOffset: box.left - projection_.tToX(range.start),
    endOffset: box.left + box.width - projection_.tToX(range.end),
  };
}

const BAR = placement({ left: 1_000, top: 40, width: 200, height: 20 });

/** A date gesture already under way, with the proposal the test wants. */
function dragging(overrides: Partial<DateGesture> = {}): DateGesture {
  return {
    kind: "date",
    id: "t1",
    pointerId: 1,
    coalesceKey: "k",
    bar: BAR,
    clientX: 0,
    clientY: 0,
    dragging: true,
    mode: "move",
    origin: ORIGIN,
    range: ORIGIN,
    commit: ORIGIN,
    rounded: false,
    dispatched: ORIGIN,
    ...overrides,
  };
}

describe("ghostRectFor", () => {
  it("puts an undisplaced ghost exactly on the drawn bar", () => {
    expect(ghostRectFor(BAR, ORIGIN, projection, VIEW)).toEqual({
      x: 1_000,
      y: 40,
      width: 200,
      height: 20,
    });
  });

  it("slides the bar rigidly for a move, keeping its drawn width", () => {
    const moved = { start: 1_050, end: 1_250 };
    expect(ghostRectFor(BAR, moved, projection, VIEW)).toEqual({
      x: 1_050,
      y: 40,
      width: 200,
      height: 20,
    });
  });

  it("drags one edge for a resize, leaving the other where it was", () => {
    const longer = { start: 1_000, end: 1_350 };
    expect(ghostRectFor(BAR, longer, projection, VIEW)).toMatchObject({
      x: 1_000,
      width: 350,
    });
    const shorter = { start: 1_120, end: 1_200 };
    expect(ghostRectFor(BAR, shorter, projection, VIEW)).toMatchObject({
      x: 1_120,
      width: 80,
    });
  });

  it("keeps a minimum width, so a milestone still shows a ghost", () => {
    const zeroWidthBar = placement({ left: 1_000, top: 40, width: 0, height: 20 });
    const rect = ghostRectFor(zeroWidthBar, ORIGIN, projection, VIEW);
    expect(rect.width).toBe(MIN_GHOST_WIDTH);
  });

  it("subtracts the scroll offsets, since a layer paints in viewport-local pixels", () => {
    const scrolled: GhostViewport = { scrollLeft: 300, scrollTop: 25, width: 800 };
    expect(ghostRectFor(BAR, ORIGIN, projection, scrolled)).toMatchObject({
      x: 700,
      y: 15,
    });
  });

  // The regression this exists for: the band used to be placed against the box's captured *content*
  // x, which every origin move invalidates, so a drag that extended the axis drew its ghost the
  // whole extension too far left (off screen, at a coarse enough zoom, after only a few days).
  it("stays where the drag is when the origin moves underneath it", () => {
    // The axis begins five "days" earlier: every content x, the bar's included, grew by 5.
    const shifted: Projection = { tToX: (t) => t + 5 };
    const captured = placement({ left: 1_000, top: 40, width: 200, height: 20 });

    // Same proposal, same scroll compensation — the band must land on the same content x it had.
    const before = ghostRectFor(captured, ORIGIN, projection, VIEW);
    const after = ghostRectFor(captured, ORIGIN, shifted, { ...VIEW, scrollLeft: 5 });

    expect(after).toEqual(before);
  });

  it("normalises an inverted band, so a crossed-over drag still has a positive width", () => {
    const inverted = { start: 1_400, end: 1_100 };
    const rect = ghostRectFor(BAR, inverted, projection, VIEW);
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.x).toBe(1_100);
  });
});

describe("onScreen", () => {
  const strip: GhostViewport = { scrollLeft: 0, scrollTop: 0, width: 800 };

  it("keeps a band that touches either edge of the visible strip", () => {
    expect(onScreen({ x: 0, y: 0, width: 10, height: 10 }, strip)).toBe(true);
    expect(onScreen({ x: -10, y: 0, width: 10, height: 10 }, strip)).toBe(true);
    expect(onScreen({ x: 800, y: 0, width: 10, height: 10 }, strip)).toBe(true);
  });

  it("drops a band entirely outside it", () => {
    expect(onScreen({ x: -100, y: 0, width: 10, height: 10 }, strip)).toBe(false);
    expect(onScreen({ x: 900, y: 0, width: 10, height: 10 }, strip)).toBe(false);
  });
});

describe("ghostRectsFor", () => {
  it("draws the band alone when nothing is being rounded", () => {
    const rects = ghostRectsFor(dragging({ range: { start: 1_050, end: 1_250 } }), projection, VIEW);
    expect(rects.band).toMatchObject({ x: 1_050, width: 200 });
    expect(rects.target).toBeUndefined();
  });

  it("adds the commit target when rounding lands somewhere else", () => {
    const rects = ghostRectsFor(
      dragging({
        range: { start: 1_123, end: 1_323 },
        commit: { start: 1_100, end: 1_300 },
        rounded: true,
      }),
      projection,
      VIEW,
    );
    expect(rects.band).toMatchObject({ x: 1_123 });
    expect(rects.target).toMatchObject({ x: 1_100, width: 200 });
    // Same row, same height as the band.
    expect(rects.target?.y).toBe(rects.band?.y);
    expect(rects.target?.height).toBe(rects.band?.height);
  });

  it("omits the commit target when it coincides with the band", () => {
    const range = { start: 1_100, end: 1_300 };
    const rects = ghostRectsFor(dragging({ range, commit: range, rounded: true }), projection, VIEW);
    expect(rects.band).toMatchObject({ x: 1_100 });
    expect(rects.target).toBeUndefined();
  });

  it("leaves out whichever band has scrolled out of sight", () => {
    // The unsnapped band is far to the right of the strip; the rounded target is inside it.
    const rects = ghostRectsFor(
      dragging({
        range: { start: 5_000, end: 5_200 },
        commit: { start: 1_100, end: 1_300 },
        rounded: true,
      }),
      projection,
      { scrollLeft: 1_000, scrollTop: 0, width: 400 },
    );
    expect(rects.band).toBeUndefined();
    expect(rects.target).toMatchObject({ x: 100 });
  });
});
