/**
 * `src/internal/geometry.ts` — the contractual bar-geometry rule and the hit classification.
 */
import { describe, expect, it } from "vitest";
import type { Task } from "@stargantt/plugin-data-store";
import {
  BAR_INSET,
  HANDLE_WIDTH,
  MIN_BAR_HEIGHT,
  MIN_BAR_WIDTH,
  MIN_HANDLED_BAR_WIDTH,
  PROGRESS_BAND_HALF,
  PROGRESS_HIT_RADIUS,
  barRect,
  clampProgress,
  handleRect,
  hasHandles,
  hitKind,
  isMilestone,
  isSummary,
  progressBoundaryX,
} from "../src/internal/geometry";

const DAY = 86_400_000;
/** The default `"day"` zoom level: 40px per day, origin at epoch 0. */
const tToX = (t: number): number => (t / DAY) * 40;

function task(over: Partial<Task> = {}): Task {
  return { id: "t", parentId: null, name: "t", start: 0, end: DAY, ...over };
}

describe("type predicates", () => {
  it("classifies by the task type field, defaulting to a plain bar", () => {
    expect(isMilestone(task({ type: "milestone" }))).toBe(true);
    expect(isSummary(task({ type: "summary" }))).toBe(true);
    expect(isMilestone(task())).toBe(false);
    expect(isSummary(task())).toBe(false);
    expect(isMilestone(task({ type: "task" }))).toBe(false);
  });
});

describe("clampProgress", () => {
  it("maps anything unusable — missing, NaN, infinite or negative — to 0, and clamps the rest into 0..1", () => {
    expect(clampProgress(undefined)).toBe(0);
    expect(clampProgress(Number.NaN)).toBe(0);
    expect(clampProgress(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampProgress(-0.5)).toBe(0);
    expect(clampProgress(0)).toBe(0);
    expect(clampProgress(0.4)).toBe(0.4);
    expect(clampProgress(1)).toBe(1);
    expect(clampProgress(2)).toBe(1);
  });
});

describe("barRect", () => {
  it("spans start to end and is inset vertically inside the row", () => {
    const box = barRect(task({ start: 0, end: 2 * DAY }), 56, 28, tToX);
    expect(box).toEqual({ x: 0, y: 56 + BAR_INSET, width: 80, height: 28 - BAR_INSET * 2 });
  });

  it("offsets by the row top, not by the row index", () => {
    const a = barRect(task(), 0, 28, tToX);
    const b = barRect(task(), 140, 28, tToX);
    expect(b.y - a.y).toBe(140);
    expect(b.height).toBe(a.height);
  });

  it("keeps a zero-duration ordinary task visible", () => {
    const box = barRect(task({ start: DAY, end: DAY }), 0, 28, tToX);
    expect(box.x).toBe(40);
    expect(box.width).toBe(MIN_BAR_WIDTH);
  });

  it("orders reversed dates rather than producing a negative width", () => {
    const box = barRect(task({ start: 2 * DAY, end: 0 }), 0, 28, tToX);
    expect(box.x).toBe(0);
    expect(box.width).toBe(80);
  });

  it("centres a milestone square on its start time", () => {
    const box = barRect(task({ type: "milestone", start: DAY, end: DAY }), 0, 28, tToX);
    expect(box.height).toBe(20);
    expect(box.width).toBe(20);
    expect(box.x + box.width / 2).toBe(40);
  });

  it("ignores a milestone's end date", () => {
    const a = barRect(task({ type: "milestone", start: DAY, end: DAY }), 0, 28, tToX);
    const b = barRect(task({ type: "milestone", start: DAY, end: 9 * DAY }), 0, 28, tToX);
    expect(b).toEqual(a);
  });

  it("never grows the bar beyond the row and never shrinks it below the minimum", () => {
    expect(barRect(task(), 0, 4, tToX).height).toBe(4);
    expect(barRect(task(), 0, 10, tToX).height).toBe(MIN_BAR_HEIGHT);
    expect(barRect(task(), 0, 100, tToX).height).toBe(100 - BAR_INSET * 2);
  });
});

describe("handles", () => {
  it("appear only once the bar is wide enough to still be grabbable in the middle", () => {
    const wide = barRect(task({ start: 0, end: DAY }), 0, 28, tToX);
    expect(wide.width).toBeGreaterThanOrEqual(MIN_HANDLED_BAR_WIDTH);
    expect(hasHandles(task(), wide)).toBe(true);

    const narrow = { x: 0, y: 0, width: MIN_HANDLED_BAR_WIDTH - 1, height: 20 };
    expect(hasHandles(task(), narrow)).toBe(false);
  });

  it("never appear on a milestone", () => {
    const box = barRect(task({ type: "milestone" }), 0, 28, tToX);
    expect(hasHandles(task({ type: "milestone" }), box)).toBe(false);
  });

  it("sit inside each end of the bar", () => {
    const box = { x: 100, y: 10, width: 80, height: 20 };
    expect(handleRect(box, "start")).toEqual({ x: 100, y: 10, width: HANDLE_WIDTH, height: 20 });
    expect(handleRect(box, "end")).toEqual({
      x: 180 - HANDLE_WIDTH,
      y: 10,
      width: HANDLE_WIDTH,
      height: 20,
    });
  });
});

describe("progressBoundaryX", () => {
  const box = { x: 100, y: 10, width: 80, height: 20 };

  it("sits where the progress fill stops", () => {
    expect(progressBoundaryX(task({ progress: 0.25 }), box)).toBe(120);
    expect(progressBoundaryX(task({ progress: 1 }), box)).toBe(180);
    expect(progressBoundaryX(task({ progress: 2 }), box)).toBe(180);
  });

  it("does not exist without a progress fill to bound", () => {
    expect(progressBoundaryX(task(), box)).toBeUndefined();
    expect(progressBoundaryX(task({ progress: 0 }), box)).toBeUndefined();
    expect(progressBoundaryX(task({ progress: -1 }), box)).toBeUndefined();
    expect(progressBoundaryX(task({ progress: Number.NaN }), box)).toBeUndefined();
  });

  it("does not exist on a summary or a milestone, which paint no progress fill", () => {
    expect(progressBoundaryX(task({ type: "summary", progress: 0.5 }), box)).toBeUndefined();
    expect(progressBoundaryX(task({ type: "milestone", progress: 0.5 }), box)).toBeUndefined();
  });
});

describe("hitKind", () => {
  const box = { x: 100, y: 10, width: 80, height: 20 };

  it("reports a handle at either end and the bar in between", () => {
    expect(hitKind(task(), box, 101, 20)).toBe("handle");
    expect(hitKind(task(), box, 179, 20)).toBe("handle");
    expect(hitKind(task(), box, 140, 20)).toBe("bar");
  });

  it("puts the handle boundary exactly one handle width in from each edge", () => {
    expect(hitKind(task(), box, 100 + HANDLE_WIDTH - 1, 20)).toBe("handle");
    expect(hitKind(task(), box, 100 + HANDLE_WIDTH, 20)).toBe("bar");
    expect(hitKind(task(), box, 180 - HANDLE_WIDTH - 1, 20)).toBe("bar");
    expect(hitKind(task(), box, 180 - HANDLE_WIDTH, 20)).toBe("handle");
  });

  it("misses outside the box, with the right edge exclusive", () => {
    expect(hitKind(task(), box, 99, 20)).toBeUndefined();
    expect(hitKind(task(), box, 180, 20)).toBeUndefined();
    expect(hitKind(task(), box, 140, 9)).toBeUndefined();
    expect(hitKind(task(), box, 140, 30)).toBeUndefined();
  });

  it("reports the whole of a bar too narrow for handles as the bar body", () => {
    const narrow = { x: 0, y: 0, width: 4, height: 20 };
    expect(hitKind(task(), narrow, 0, 10)).toBe("bar");
    expect(hitKind(task(), narrow, 3, 10)).toBe("bar");
  });

  it("matches the milestone diamond, not the empty corners of its box", () => {
    const diamond = { x: 0, y: 0, width: 20, height: 20 };
    const milestone = task({ type: "milestone" });
    expect(hitKind(milestone, diamond, 10, 10)).toBe("bar");
    expect(hitKind(milestone, diamond, 10, 1)).toBe("bar");
    expect(hitKind(milestone, diamond, 1, 1)).toBeUndefined();
    expect(hitKind(milestone, diamond, 19, 19)).toBeUndefined();
  });

  it("never reports a handle for a milestone", () => {
    const diamond = { x: 0, y: 0, width: 20, height: 20 };
    const milestone = task({ type: "milestone" });
    for (let x = 0; x < 20; x += 1) {
      for (let y = 0; y < 20; y += 1) {
        expect(hitKind(milestone, diamond, x, y)).not.toBe("handle");
      }
    }
  });

  it("treats a summary like an ordinary bar", () => {
    const summary = task({ type: "summary" });
    expect(hitKind(summary, box, 101, 20)).toBe("handle");
    expect(hitKind(summary, box, 140, 20)).toBe("bar");
  });

  describe("the progress strip", () => {
    const half = task({ progress: 0.5 });

    it("wins over the bar body within ±3px of the boundary", () => {
      expect(PROGRESS_HIT_RADIUS).toBe(3);
      expect(hitKind(half, box, 140, 20)).toBe("progress");
      expect(hitKind(half, box, 140 - PROGRESS_HIT_RADIUS, 20)).toBe("progress");
      expect(hitKind(half, box, 140 + PROGRESS_HIT_RADIUS, 20)).toBe("progress");
      expect(hitKind(half, box, 140 - PROGRESS_HIT_RADIUS - 1, 20)).toBe("bar");
      expect(hitKind(half, box, 140 + PROGRESS_HIT_RADIUS + 1, 20)).toBe("bar");
    });

    // The 24px-tall WCAG 2.2 §2.5.8 band hugging the bar's bottom edge.
    it("reaches 12px below the bar's bottom edge, but not above the bar", () => {
      expect(PROGRESS_BAND_HALF).toBe(12);
      expect(hitKind(half, box, 140, 9)).toBeUndefined(); // above the bar
      expect(hitKind(half, box, 140, 10)).toBe("progress"); // bar top: the in-bar strip survives
      expect(hitKind(half, box, 140, 30)).toBe("progress"); // just below the bar (bottom = 30)
      expect(hitKind(half, box, 140, 30 + PROGRESS_BAND_HALF)).toBe("progress"); // 12px below
      expect(hitKind(half, box, 140, 30 + PROGRESS_BAND_HALF + 1)).toBeUndefined();
      // Horizontally the band keeps the strip's own ±3px reach.
      expect(hitKind(half, box, 140 + PROGRESS_HIT_RADIUS + 1, 35)).toBeUndefined();
      expect(hitKind(half, box, 140 - PROGRESS_HIT_RADIUS, 35)).toBe("progress");
    });

    it("loses to a resize handle where the two overlap", () => {
      // 2.5% of an 80px bar puts the boundary at x = 102, inside the start handle.
      const nearlyNone = task({ progress: 0.025 });
      for (let x = 100; x < 100 + HANDLE_WIDTH; x += 1) {
        expect(hitKind(nearlyNone, box, x, 20)).toBe("handle");
      }
      // ...and a full bar's boundary (x = 180) falls inside the end handle, which keeps every
      // pixel of that handle even where the strip reaches into it.
      const done = task({ progress: 1 });
      for (let x = 180 - HANDLE_WIDTH; x < 180; x += 1) {
        expect(hitKind(done, box, x, 20)).toBe("handle");
      }
      // Just left of the handle the strip is already out of reach (7px from the boundary).
      expect(hitKind(done, box, 180 - HANDLE_WIDTH - 1, 20)).toBe("bar");
    });

    it("never appears on a summary or a milestone", () => {
      const summary = task({ type: "summary", progress: 0.5 });
      expect(hitKind(summary, box, 140, 20)).toBe("bar");
      const diamond = { x: 0, y: 0, width: 20, height: 20 };
      const milestone = task({ type: "milestone", progress: 0.5 });
      for (let x = 0; x < 20; x += 1) {
        expect(hitKind(milestone, diamond, x, 10)).not.toBe("progress");
      }
    });

    it("never appears on a bar with no progress", () => {
      for (let x = 100; x < 180; x += 1) expect(hitKind(task(), box, x, 20)).not.toBe("progress");
    });
  });
});
