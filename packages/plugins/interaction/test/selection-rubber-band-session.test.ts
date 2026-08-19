// The rubber-band gesture as one state machine, exercised directly (no host, no renderer).
import { describe, expect, it } from "vitest";
import type { BarBox } from "@stargantt/plugin-task-bars";
import { createRubberBandSession } from "../src/internal/selection/rubber-band-session";
import { normalizeRect, rectsIntersect } from "../src/internal/selection/rubberband";

// `internal/selection/rubberband.ts` gets its own direct coverage here even though it is also
// exercised indirectly through the session above (the session tests still cover the integration).
describe("normalizeRect", () => {
  it("normalizes every drag direction to a non-negative rectangle", () => {
    expect(normalizeRect({ originX: 10, originY: 10, curX: 50, curY: 40 })).toEqual({
      x: 10,
      y: 10,
      width: 40,
      height: 30,
    });
    expect(normalizeRect({ originX: 50, originY: 40, curX: 10, curY: 10 })).toEqual({
      x: 10,
      y: 10,
      width: 40,
      height: 30,
    });
  });

  it("produces a zero-size rectangle at the origin point", () => {
    expect(normalizeRect({ originX: 5, originY: 5, curX: 5, curY: 5 })).toEqual({
      x: 5,
      y: 5,
      width: 0,
      height: 0,
    });
  });
});

describe("rectsIntersect", () => {
  it("is true for overlapping rectangles", () => {
    expect(rectsIntersect({ x: 0, y: 0, width: 20, height: 20 }, { x: 10, y: 10, width: 20, height: 20 })).toBe(
      true,
    );
  });

  it("is false for touching-but-not-overlapping edges", () => {
    expect(rectsIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 })).toBe(
      false,
    );
  });

  it("is false for disjoint rectangles", () => {
    expect(rectsIntersect({ x: 0, y: 0, width: 10, height: 10 }, { x: 100, y: 100, width: 10, height: 10 })).toBe(
      false,
    );
  });

  it("is true when one rectangle wholly contains the other", () => {
    expect(rectsIntersect({ x: 0, y: 0, width: 100, height: 100 }, { x: 10, y: 10, width: 5, height: 5 })).toBe(
      true,
    );
  });
});

function box(id: string, x: number, y: number): BarBox {
  return { id, x, y, width: 40, height: 20, gutterStart: 0, gutterEnd: 0 };
}

function session(boxes: BarBox[] = []): {
  s: ReturnType<typeof createRubberBandSession>;
  repaints: () => number;
} {
  let repaints = 0;
  const s = createRubberBandSession({
    geometry: {
      barBoxOf: (id) => boxes.find((b) => b.id === id),
      visibleBoxes: () => boxes.slice(),
    },
    invalidate: () => {
      repaints += 1;
    },
  });
  return { s, repaints: () => repaints };
}

describe("rubber-band session", () => {
  it("is inert until a gesture begins", () => {
    const { s, repaints } = session();
    expect(s.active()).toBe(false);
    expect(s.rect()).toBeUndefined();
    s.move(10, 10);
    expect(s.end(10, 10, {})).toBeUndefined();
    expect(s.cancel()).toBe(false);
    expect(repaints()).toBe(0);
  });

  it("tracks a drag as a normalized rectangle and repaints on every change", () => {
    const { s, repaints } = session();
    s.begin(80, 60);
    expect(s.active()).toBe(true);
    expect(s.rect()).toEqual({ x: 80, y: 60, width: 0, height: 0 });
    s.move(20, 10); // dragged up and to the left
    expect(s.rect()).toEqual({ x: 20, y: 10, width: 60, height: 50 });
    expect(repaints()).toBe(2);
  });

  it("reports the bars the rectangle caught, in row order, and ends the gesture", () => {
    const boxes = [box("a", 0, 0), box("b", 0, 30), box("c", 0, 60)];
    const { s } = session(boxes);
    s.begin(5, 5);
    s.move(20, 20);
    expect(s.end(20, 45, {})).toEqual({ ids: ["a", "b"], additive: false });
    expect(s.active()).toBe(false);
    expect(s.rect()).toBeUndefined();
  });

  it("finalizes on the up event's own position, not the last move", () => {
    const boxes = [box("a", 0, 0), box("b", 0, 30)];
    const { s } = session(boxes);
    s.begin(5, 5);
    s.move(20, 10); // would catch only "a"
    expect(s.end(20, 45, {})).toEqual({ ids: ["a", "b"], additive: false });
  });

  it("marks a Ctrl/Cmd release as additive", () => {
    const boxes = [box("a", 0, 0)];
    const ctrl = session(boxes);
    ctrl.s.begin(0, 0);
    expect(ctrl.s.end(20, 20, { ctrlKey: true })?.additive).toBe(true);
    const meta = session(boxes);
    meta.s.begin(0, 0);
    expect(meta.s.end(20, 20, { metaKey: true })?.additive).toBe(true);
  });

  it("abandons the gesture on a cancelled capture and on cancel(), catching nothing", () => {
    const boxes = [box("a", 0, 0)];
    const cancelled = session(boxes);
    cancelled.s.begin(0, 0);
    expect(cancelled.s.end(20, 20, { cancelled: true })).toBeUndefined();
    expect(cancelled.s.active()).toBe(false);

    const escaped = session(boxes);
    escaped.s.begin(0, 0);
    expect(escaped.s.cancel()).toBe(true);
    expect(escaped.s.active()).toBe(false);
    // The rectangle is gone, so the release that eventually arrives is a no-op.
    expect(escaped.s.end(20, 20, {})).toBeUndefined();
  });
});
