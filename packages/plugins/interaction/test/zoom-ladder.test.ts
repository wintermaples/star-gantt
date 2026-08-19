// docs/specs/plugins/interaction.md §6.6 — the ladder module in isolation, hostless: no
// `Gantt.create()` or DOM involved. Adapted to the store-shaped `TimelineService.zoomLevel`.
import { describe, expect, it } from "vitest";
import { createLadder, normalizeLevels, DEFAULT_LEVELS } from "../src/internal/zoom/ladder";
import type { LadderTimeline } from "../src/internal/zoom/ladder";

const IDS = ["year", "month", "day"];

function fakeTimeline(overrides: Partial<LadderTimeline> = {}): LadderTimeline & { calls: string[] } {
  const calls: string[] = [];
  let current = { id: "day", pxPerDay: 24 };
  return {
    zoomLevel: { get: () => current },
    setZoomLevel: (id: string) => {
      calls.push(id);
      const known = ["year", "month", "day"].includes(id);
      if (!known) throw new Error(`unknown level "${id}"`);
      current = { id, pxPerDay: current.pxPerDay };
    },
    levelMetrics: () => [
      { id: "year", pxPerDay: 0.1 },
      { id: "month", pxPerDay: 1.2 },
      { id: "day", pxPerDay: 24 },
    ],
    calls,
    ...overrides,
  };
}

describe("normalizeLevels", () => {
  it("keeps non-empty strings, drops duplicates, falls back on nothing usable", () => {
    expect(normalizeLevels(["year", "year", "month", "", 42, "day"])).toEqual(["year", "month", "day"]);
    expect(normalizeLevels(undefined)).toEqual(DEFAULT_LEVELS);
    expect(normalizeLevels([])).toEqual(DEFAULT_LEVELS);
    expect(normalizeLevels(["", 1, null])).toEqual(DEFAULT_LEVELS);
  });

  it("the built-in default is coarsest-first: year, quarter, month, week, day, hour", () => {
    expect(DEFAULT_LEVELS).toEqual(["year", "quarter", "month", "week", "day", "hour"]);
  });
});

describe("ladder.step", () => {
  it("steps one ladder position finer or coarser, anchored", () => {
    const timeline = fakeTimeline();
    const ladder = createLadder(IDS, timeline);
    ladder.step(-1, 999);
    expect(timeline.zoomLevel.get().id).toBe("month");
    expect(timeline.calls).toEqual(["month"]);
    ladder.step(-1, 999);
    expect(timeline.zoomLevel.get().id).toBe("year");
  });

  it("does nothing at either end of the ladder", () => {
    const timeline = fakeTimeline();
    const ladder = createLadder(IDS, timeline);
    ladder.step(1, 0); // already at "day", the finest
    expect(timeline.calls).toEqual([]);
    expect(timeline.zoomLevel.get().id).toBe("day");
  });

  it("picks the nearest strictly denser/sparser entry when the active level is off-ladder", () => {
    const timeline = fakeTimeline({
      zoomLevel: { get: () => ({ id: "week", pxPerDay: 6 }) },
    });
    const ladder = createLadder(IDS, timeline);
    ladder.step(1, 0); // denser than 6: month (1.2) is sparser, day (24) is the nearest denser
    expect(timeline.calls).toEqual(["day"]);
  });
});

describe("ladder.setIndex", () => {
  it("activates the id at a valid index, anchored", () => {
    const timeline = fakeTimeline();
    const ladder = createLadder(IDS, timeline);
    ladder.setIndex(1, 12345);
    expect(timeline.zoomLevel.get().id).toBe("month");
  });

  it("is a no-op for an out-of-range index, including -1 (unknown/off-ladder state)", () => {
    const timeline = fakeTimeline();
    const ladder = createLadder(IDS, timeline);
    ladder.setIndex(-1, 0);
    expect(timeline.calls).toEqual([]);
    ladder.setIndex(99, 0);
    expect(timeline.calls).toEqual([]);
    expect(timeline.zoomLevel.get().id).toBe("day"); // untouched
  });
});

describe("ladder.activateUnanchored", () => {
  it("activates the id without an anchor argument", () => {
    const timeline = fakeTimeline();
    const ladder = createLadder(IDS, timeline);
    ladder.activateUnanchored("month");
    expect(timeline.calls).toEqual(["month"]);
    expect(timeline.zoomLevel.get().id).toBe("month");
  });

  it("swallows a rejection instead of throwing, matching the ladder's other activations", () => {
    const timeline = fakeTimeline();
    const ladder = createLadder(IDS, timeline);
    expect(() => ladder.activateUnanchored("fortnight")).not.toThrow();
    expect(timeline.zoomLevel.get().id).toBe("day"); // unchanged
  });
});

describe("ladder.fitEntry", () => {
  it("picks the densest entry whose span fits, or the coarsest when none fits", () => {
    const timeline = fakeTimeline();
    const ladder = createLadder(IDS, timeline);
    // 10 days at 1.2 px/day = 12px, fits comfortably in 800; day (24 px/day) needs 240 — also fits.
    expect(ladder.fitEntry(10 * 86_400_000, 800)?.id).toBe("day");
    // A huge span that outruns every entry falls back to the coarsest (year).
    expect(ladder.fitEntry(1_000_000 * 86_400_000, 10)?.id).toBe("year");
  });

  it("is undefined when no ladder id exists in the composition", () => {
    const timeline = fakeTimeline({ levelMetrics: () => [] });
    const ladder = createLadder(IDS, timeline);
    expect(ladder.fitEntry(86_400_000, 800)).toBeUndefined();
  });

  it("ignores unusable metrics entries (non-positive density, empty id)", () => {
    const timeline = fakeTimeline({
      levelMetrics: () => [
        { id: "year", pxPerDay: 0 },
        { id: "month", pxPerDay: -1 },
        { id: "day", pxPerDay: 24 },
      ],
    });
    const ladder = createLadder(IDS, timeline);
    expect(ladder.fitEntry(1 * 86_400_000, 800)?.id).toBe("day");
  });
});
