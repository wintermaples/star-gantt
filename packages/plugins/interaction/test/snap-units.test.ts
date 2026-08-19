/**
 * The pure arithmetic behind `stargantt.snap`: the boundary table, the upward tie rule and the
 * signed calendar step.
 *
 * The arithmetic itself is unchanged (docs/specs/plugins/interaction.md §2.2). Two things moved:
 * `isSnapUnit` now lives on `../src/config`, not alongside the arithmetic, and `MS_HOUR` is no
 * longer re-exported from the units module — both are imported from their current homes below.
 */
import { describe, expect, it } from "vitest";
import { MS_DAY, MS_HOUR } from "@stargantt/sdk";
import { MS_WEEK, floorTo, next, roundTo, unitStep } from "../src/internal/snap/units";
import { isSnapUnit } from "../src/config";

/** Epoch ms of a UTC wall-clock time. */
function utc(y: number, m: number, d: number, h = 0, min = 0, s = 0, ms = 0): number {
  return Date.UTC(y, m - 1, d, h, min, s, ms);
}

describe("floorTo", () => {
  it("floors to the start of the UTC year", () => {
    expect(floorTo(utc(2024, 7, 15, 13, 45), "year")).toBe(utc(2024, 1, 1));
    expect(floorTo(utc(2024, 1, 1), "year")).toBe(utc(2024, 1, 1));
  });

  it("floors to the 1st of the UTC month", () => {
    expect(floorTo(utc(2024, 2, 29, 23, 59, 59, 999), "month")).toBe(utc(2024, 2, 1));
    expect(floorTo(utc(2024, 12, 31), "month")).toBe(utc(2024, 12, 1));
  });

  it("floors to Monday for ISO weeks", () => {
    // 2024-03-14 is a Thursday; the ISO week starts Monday 2024-03-11.
    expect(floorTo(utc(2024, 3, 14, 5), "week")).toBe(utc(2024, 3, 11));
    // Sunday belongs to the week that began the previous Monday, not the next one.
    expect(floorTo(utc(2024, 3, 17, 23, 59), "week")).toBe(utc(2024, 3, 11));
    // A Monday at midnight is already a boundary.
    expect(floorTo(utc(2024, 3, 11), "week")).toBe(utc(2024, 3, 11));
  });

  it("floors weeks before the epoch too", () => {
    // 1969-12-29 is the Monday of the week containing the epoch (a Thursday).
    expect(floorTo(0, "week")).toBe(utc(1969, 12, 29));
    expect(floorTo(-1, "week")).toBe(utc(1969, 12, 29));
  });

  it("floors to UTC midnight and to the hour", () => {
    expect(floorTo(utc(2024, 3, 14, 5, 30), "day")).toBe(utc(2024, 3, 14));
    expect(floorTo(utc(2024, 3, 14, 5, 30, 12, 3), "hour")).toBe(utc(2024, 3, 14, 5));
  });

  it("floors negative instants downward, not toward zero", () => {
    expect(floorTo(-1, "day")).toBe(-MS_DAY);
    expect(floorTo(-1, "hour")).toBe(-MS_HOUR);
  });

  it("floors a millisecond grid to multiples measured from the epoch", () => {
    expect(floorTo(2_500, 1_000)).toBe(2_000);
    expect(floorTo(2_000, 1_000)).toBe(2_000);
    expect(floorTo(-2_500, 1_000)).toBe(-3_000);
  });
});

describe("next", () => {
  it("advances one calendar unit from a boundary", () => {
    expect(next(utc(2024, 1, 1), "year")).toBe(utc(2025, 1, 1));
    expect(next(utc(2024, 12, 1), "month")).toBe(utc(2025, 1, 1));
    expect(next(utc(2024, 2, 1), "month")).toBe(utc(2024, 3, 1));
    expect(next(utc(2024, 3, 11), "week")).toBe(utc(2024, 3, 18));
    expect(next(utc(2024, 3, 11), "day")).toBe(utc(2024, 3, 12));
    expect(next(utc(2024, 3, 11, 5), "hour")).toBe(utc(2024, 3, 11, 6));
  });

  it("advances a millisecond grid by its size", () => {
    expect(next(2_000, 1_000)).toBe(3_000);
  });
});

describe("roundTo", () => {
  it("rounds to the nearer boundary", () => {
    expect(roundTo(utc(2024, 3, 14, 5), "day")).toBe(utc(2024, 3, 14));
    expect(roundTo(utc(2024, 3, 14, 19), "day")).toBe(utc(2024, 3, 15));
  });

  it("resolves an exact tie upward", () => {
    expect(roundTo(utc(2024, 3, 14, 12), "day")).toBe(utc(2024, 3, 15));
    expect(roundTo(utc(2024, 3, 14, 5, 30), "hour")).toBe(utc(2024, 3, 14, 6));
    // Half a 1000 ms grid cell.
    expect(roundTo(2_500, 1_000)).toBe(3_000);
  });

  it("rounds a tie upward for irregular units too", () => {
    // A 30-day June: the midpoint is the 16th at 00:00.
    expect(roundTo(utc(2024, 6, 16), "month")).toBe(utc(2024, 7, 1));
    expect(roundTo(utc(2024, 6, 15, 23, 59, 59, 999), "month")).toBe(utc(2024, 6, 1));
    // Thursday noon is the midpoint of an ISO week starting Monday.
    expect(roundTo(utc(2024, 3, 14, 12), "week")).toBe(utc(2024, 3, 18));
    expect(roundTo(utc(2024, 3, 14, 11, 59), "week")).toBe(utc(2024, 3, 11));
  });

  it("keeps an instant that is already a boundary", () => {
    for (const unit of ["year", "month", "week", "day", "hour"] as const) {
      const b = floorTo(utc(2024, 3, 14, 5, 30), unit);
      expect(roundTo(b, unit)).toBe(b);
    }
  });

  it("rounds a leap-day February by its own length", () => {
    // February 2024 has 29 days, so its midpoint is the 15th at 12:00.
    expect(roundTo(utc(2024, 2, 15, 12), "month")).toBe(utc(2024, 3, 1));
    expect(roundTo(utc(2024, 2, 15, 11, 59), "month")).toBe(utc(2024, 2, 1));
  });

  it("returns a non-finite instant unchanged", () => {
    expect(roundTo(Number.NaN, "day")).toBeNaN();
    expect(roundTo(Number.POSITIVE_INFINITY, "day")).toBe(Number.POSITIVE_INFINITY);
    expect(roundTo(Number.NEGATIVE_INFINITY, "day")).toBe(Number.NEGATIVE_INFINITY);
  });
});

describe("unitStep", () => {
  it("steps forward by the length of the unit containing the instant", () => {
    expect(unitStep(utc(2024, 3, 14, 5), "day", 1)).toBe(MS_DAY);
    expect(unitStep(utc(2024, 3, 14, 5), "hour", 1)).toBe(MS_HOUR);
    expect(unitStep(utc(2024, 3, 14, 5), "week", 1)).toBe(MS_WEEK);
    // February 2024 — 29 days.
    expect(unitStep(utc(2024, 2, 10), "month", 1)).toBe(29 * MS_DAY);
    // A leap year — 366 days.
    expect(unitStep(utc(2024, 5, 1), "year", 1)).toBe(366 * MS_DAY);
    expect(unitStep(utc(2023, 5, 1), "year", 1)).toBe(365 * MS_DAY);
  });

  it("steps backward by the length of the preceding unit", () => {
    // The month before February 2024 is January — 31 days.
    expect(unitStep(utc(2024, 2, 10), "month", -1)).toBe(-31 * MS_DAY);
    // The year before 2024 is 2023 — 365 days.
    expect(unitStep(utc(2024, 5, 1), "year", -1)).toBe(-365 * MS_DAY);
    expect(unitStep(utc(2024, 3, 14, 5), "day", -1)).toBe(-MS_DAY);
  });

  it("returns to the instant's own boundary after a forward and a backward step", () => {
    for (const unit of ["year", "month", "week", "day", "hour"] as const) {
      const t = utc(2024, 3, 14, 5, 30);
      const forward = t + unitStep(t, unit, 1);
      const back = forward + unitStep(forward, unit, -1);
      expect(back).toBe(t);
    }
  });

  it("steps a millisecond grid by its size in both directions", () => {
    expect(unitStep(2_500, 1_000, 1)).toBe(1_000);
    expect(unitStep(2_500, 1_000, -1)).toBe(-1_000);
  });
});

describe("isSnapUnit", () => {
  it("accepts exactly the five calendar units", () => {
    for (const unit of ["year", "month", "week", "day", "hour"]) {
      expect(isSnapUnit(unit)).toBe(true);
    }
    for (const other of ["scale", "minute", "", undefined, 5, null, {}]) {
      expect(isSnapUnit(other)).toBe(false);
    }
  });
});
