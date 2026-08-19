import { describe, expect, it } from "vitest";
import { MS_DAY } from "@stargantt/sdk";
import type { TimeRange } from "../src/internal/drag/gesture";
import { progressAt, proposeRange, resizeModeAt, sameRange } from "../src/internal/drag/gesture";

const origin: TimeRange = { start: 0, end: 4 * MS_DAY };
const none = (t: number): number => t;
// Rounding itself belongs to `stargantt.snap` and is tested there. What `proposeRange` owes is only
// that it applies whatever rounding it is handed to the moved edge, so a local day-rounder stands in
// for the service here.
const toDay = (t: number): number => {
  const low = Math.floor(t / MS_DAY) * MS_DAY;
  return t - low < low + MS_DAY - t ? low : low + MS_DAY;
};

describe("resizeModeAt", () => {
  it("grabs the end nearer the pointer", () => {
    expect(resizeModeAt(0.5 * MS_DAY, origin)).toBe("resize-start");
    expect(resizeModeAt(3.5 * MS_DAY, origin)).toBe("resize-end");
  });

  it("gives the middle of the task to the start handle", () => {
    expect(resizeModeAt(2 * MS_DAY, origin)).toBe("resize-start");
  });

  it("still picks an end for a task with no duration", () => {
    const point: TimeRange = { start: MS_DAY, end: MS_DAY };
    expect(resizeModeAt(MS_DAY, point)).toBe("resize-start");
    expect(resizeModeAt(2 * MS_DAY, point)).toBe("resize-end");
  });
});

describe("proposeRange: move", () => {
  it("shifts both ends and keeps the duration", () => {
    expect(proposeRange("move", origin, 2 * MS_DAY, none)).toEqual({
      start: 2 * MS_DAY,
      end: 6 * MS_DAY,
    });
  });

  it("moves backwards just as far", () => {
    expect(proposeRange("move", origin, -MS_DAY, none)).toEqual({
      start: -MS_DAY,
      end: 3 * MS_DAY,
    });
  });

  it("snaps the start and lets the end follow, so the duration survives snapping", () => {
    const range = proposeRange("move", { start: 0, end: 3 * MS_DAY }, 1.4 * MS_DAY, toDay);
    expect(range).toEqual({ start: MS_DAY, end: 4 * MS_DAY });
  });

  it("keeps an off-grid duration intact", () => {
    const odd: TimeRange = { start: 0, end: MS_DAY + 5 };
    expect(proposeRange("move", odd, 1.1 * MS_DAY, toDay)).toEqual({
      start: MS_DAY,
      end: 2 * MS_DAY + 5,
    });
  });

  it("returns the original dates for a drag of nothing", () => {
    expect(proposeRange("move", origin, 0, toDay)).toEqual(origin);
  });
});

describe("proposeRange: resize", () => {
  it("moves the start and leaves the end alone", () => {
    expect(proposeRange("resize-start", origin, MS_DAY, none)).toEqual({
      start: MS_DAY,
      end: 4 * MS_DAY,
    });
  });

  it("moves the end and leaves the start alone", () => {
    expect(proposeRange("resize-end", origin, MS_DAY, none)).toEqual({
      start: 0,
      end: 5 * MS_DAY,
    });
  });

  it("snaps the moved end", () => {
    expect(proposeRange("resize-end", origin, 1.4 * MS_DAY, toDay)).toEqual({
      start: 0,
      end: 5 * MS_DAY,
    });
  });

  it("never lets the start pass the end", () => {
    expect(proposeRange("resize-start", origin, 10 * MS_DAY, none)).toEqual({
      start: 4 * MS_DAY,
      end: 4 * MS_DAY,
    });
  });

  it("never lets the end pass the start", () => {
    expect(proposeRange("resize-end", origin, -10 * MS_DAY, none)).toEqual({
      start: 0,
      end: 0,
    });
  });
});

describe("sameRange", () => {
  it("compares both ends", () => {
    expect(sameRange(origin, { start: 0, end: 4 * MS_DAY })).toBe(true);
    expect(sameRange(origin, { start: 0, end: 5 * MS_DAY })).toBe(false);
    expect(sameRange(origin, { start: 1, end: 4 * MS_DAY })).toBe(false);
  });
});

// docs/specs/plugins/interaction.md §1.3 "Progress drag" — the ±3px progress hit strip.
describe("progressAt", () => {
  it("maps the pointer's position inside the bar to a fraction", () => {
    expect(progressAt(10, 0, 40)).toBeCloseTo(0.25, 12);
    expect(progressAt(30, 10, 40)).toBeCloseTo(0.5, 12);
  });

  it("clamps at both ends instead of running past them", () => {
    expect(progressAt(-100, 0, 40)).toBe(0);
    expect(progressAt(1000, 0, 40)).toBe(1);
    expect(progressAt(0, 0, 40)).toBe(0);
    expect(progressAt(40, 0, 40)).toBe(1);
  });

  it("reads a bar with no width as empty rather than dividing by zero", () => {
    expect(progressAt(5, 0, 0)).toBe(0);
    expect(progressAt(5, 0, Number.NaN)).toBe(0);
  });
});
