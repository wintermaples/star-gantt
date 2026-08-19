/** Calendar-unit arithmetic behind the header rows. */
import { describe, expect, it } from "vitest";
import {
  MAX_TICKS,
  MS_DAY,
  MS_HOUR,
  MS_WEEK,
  advance,
  calendarIndex,
  floorTo,
  floorToStep,
  normalizeStep,
  ticks,
  unitBoundaries,
} from "../../src/internal/timeline/scale";
import type { ScaleUnit } from "../../src/internal/timeline/scale";

const T = (iso: string): number => Date.parse(iso);

describe("normalizeStep", () => {
  it("defaults an absent step to 1", () => {
    expect(normalizeStep(undefined)).toBe(1);
  });

  it("floors fractional steps and clamps anything below 1", () => {
    expect(normalizeStep(2.9)).toBe(2);
    expect(normalizeStep(0)).toBe(1);
    expect(normalizeStep(-5)).toBe(1);
    expect(normalizeStep(Number.NaN)).toBe(1);
  });
});

describe("floorTo (UTC)", () => {
  it("floors to the start of the UTC year", () => {
    expect(floorTo(T("2026-08-06T13:45:12.500Z"), "year")).toBe(T("2026-01-01T00:00:00Z"));
  });

  it("floors to the first of the UTC month", () => {
    expect(floorTo(T("2026-08-06T13:45:12.500Z"), "month")).toBe(T("2026-08-01T00:00:00Z"));
  });

  it("floors to UTC midnight", () => {
    expect(floorTo(T("2026-08-06T13:45:12.500Z"), "day")).toBe(T("2026-08-06T00:00:00Z"));
  });

  it("floors to the top of the UTC hour", () => {
    expect(floorTo(T("2026-08-06T13:45:12.500Z"), "hour")).toBe(T("2026-08-06T13:00:00Z"));
  });

  it("floors weeks to the preceding Monday (ISO-8601)", () => {
    // 2026-08-06 is a Thursday.
    expect(floorTo(T("2026-08-06T13:45:00Z"), "week")).toBe(T("2026-08-03T00:00:00Z"));
    // A Monday is already a boundary.
    expect(floorTo(T("2026-08-03T00:00:00Z"), "week")).toBe(T("2026-08-03T00:00:00Z"));
    // A Sunday belongs to the week that started six days earlier.
    expect(floorTo(T("2026-08-09T23:59:59Z"), "week")).toBe(T("2026-08-03T00:00:00Z"));
  });

  it("floors correctly before the epoch", () => {
    expect(floorTo(T("1969-07-20T20:17:00Z"), "day")).toBe(T("1969-07-20T00:00:00Z"));
  });
});

describe("advance", () => {
  it("moves whole calendar years and months, not fixed millisecond spans", () => {
    // 2024 is a leap year: a fixed +365d would land on 2024-12-31.
    expect(advance(T("2024-01-01T00:00:00Z"), "year", 1)).toBe(T("2025-01-01T00:00:00Z"));
    // February has 28 days in 2026: a fixed +31d would overshoot.
    expect(advance(T("2026-02-01T00:00:00Z"), "month", 1)).toBe(T("2026-03-01T00:00:00Z"));
    expect(advance(T("2026-11-01T00:00:00Z"), "month", 3)).toBe(T("2027-02-01T00:00:00Z"));
  });

  it("moves fixed spans for week / day / hour", () => {
    const t = T("2026-08-03T00:00:00Z");
    expect(advance(t, "week", 2)).toBe(t + 2 * MS_WEEK);
    expect(advance(t, "day", 3)).toBe(t + 3 * MS_DAY);
    expect(advance(t, "hour", 6)).toBe(t + 6 * MS_HOUR);
  });
});

describe("ticks", () => {
  it("starts at the boundary at or before `from` so the leading cell keeps its label", () => {
    const from = T("2026-08-06T13:00:00Z");
    const to = T("2026-08-09T00:00:00Z");
    expect(ticks(from, to, "day")).toEqual([
      T("2026-08-06T00:00:00Z"),
      T("2026-08-07T00:00:00Z"),
      T("2026-08-08T00:00:00Z"),
    ]);
  });

  it("honours `step`", () => {
    const from = T("2026-01-01T00:00:00Z");
    const to = T("2026-01-07T00:00:00Z");
    expect(ticks(from, to, "day", 3)).toEqual([
      T("2026-01-01T00:00:00Z"),
      T("2026-01-04T00:00:00Z"),
    ]);
  });

  it("returns nothing for an empty or inverted range", () => {
    const t = T("2026-08-06T00:00:00Z");
    expect(ticks(t, t, "day")).toEqual([]);
    expect(ticks(t, t - MS_DAY, "day")).toEqual([]);
  });

  it("returns nothing for a non-finite range (a zero-density zoom level)", () => {
    expect(ticks(0, Number.POSITIVE_INFINITY, "day")).toEqual([]);
    expect(ticks(Number.NaN, 1, "day")).toEqual([]);
  });

  it("anchors a `step` row on the calendar, not on `from`", () => {
    // The built-in `quarter` level's fine row: a 3-month row, which §1.5 defines as quarters.
    const quarters = (from: string): string[] =>
      ticks(T(from), T("2027-01-01T00:00:00Z"), "month", 3).map((t) => new Date(t).toISOString());
    const expected = [
      "2026-01-01T00:00:00.000Z",
      "2026-04-01T00:00:00.000Z",
      "2026-07-01T00:00:00.000Z",
      "2026-10-01T00:00:00.000Z",
    ];
    // Scrolling the range's left edge through the quarter must not move the boundaries.
    expect(quarters("2026-01-15T00:00:00Z")).toEqual(expected);
    expect(quarters("2026-02-15T00:00:00Z")).toEqual(expected);
    expect(quarters("2026-03-31T23:59:59Z")).toEqual(expected);
  });

  it("starts the built-in `year` level's decade row on a decade", () => {
    expect(ticks(T("2026-08-06T00:00:00Z"), T("2031-01-01T00:00:00Z"), "year", 10)).toEqual([
      T("2020-01-01T00:00:00Z"),
      T("2030-01-01T00:00:00Z"),
    ]);
  });

  it("keeps a `step` sequence stable across a range that slides forward one unit at a time", () => {
    const units: ScaleUnit[] = ["hour", "day", "week", "month", "year"];
    const spans: Record<ScaleUnit, number> = {
      hour: MS_HOUR,
      day: MS_DAY,
      week: MS_WEEK,
      month: 31 * MS_DAY,
      year: 366 * MS_DAY,
    };
    for (const unit of units) {
      const span = spans[unit];
      const start = T("2026-08-06T13:45:00Z");
      const reference = ticks(start, start + 40 * span, unit, 4);
      for (let shift = 1; shift <= 8; shift++) {
        const shifted = ticks(start + shift * span, start + 40 * span, unit, 4);
        // Every boundary the shifted range still covers is the very same instant.
        expect(shifted).toEqual(reference.filter((t) => t >= shifted[0]!));
      }
    }
  });

  it("leaves every `step: 1` row identical to a plain unit floor", () => {
    const units: ScaleUnit[] = ["hour", "day", "week", "month", "year"];
    for (const unit of units) {
      for (const step of [undefined, 1, 0, -3, Number.NaN]) {
        const from = T("2026-08-06T13:45:12.500Z");
        expect(ticks(from, from + 90 * MS_DAY, unit, step)).toEqual(
          ticks(from, from + 90 * MS_DAY, unit),
        );
        expect(floorToStep(from, unit, step)).toBe(floorTo(from, unit));
      }
    }
  });

  it("aligns a `step` row before the epoch too", () => {
    // Month index of 1969-11 is negative relative to nothing in particular, but the quarter it
    // belongs to is still the calendar's: October 1969.
    expect(floorToStep(T("1969-11-20T20:17:00Z"), "month", 3)).toBe(T("1969-10-01T00:00:00Z"));
    expect(floorToStep(T("1965-07-20T20:17:00Z"), "year", 10)).toBe(T("1960-01-01T00:00:00Z"));
    // Day index −5 belongs to the 4-day cell starting at index −8; a plain `%` would have picked
    // −4, which lies *after* the instant.
    expect(floorToStep(-5 * MS_DAY + MS_HOUR, "day", 4)).toBe(-8 * MS_DAY);
    expect(calendarIndex(-8 * MS_DAY, "day")).toBe(-8);
  });

  it("caps output rather than materialising an unbounded array", () => {
    const from = T("2000-01-01T00:00:00Z");
    const list = ticks(from, from + 1000 * 365 * MS_DAY, "hour");
    expect(list.length).toBe(MAX_TICKS);
  });
});

// the engine behind the public
// `TimelineService.unitBoundaries`: the same calendar as `ticks`, half-open on both ends.
describe("unitBoundaries", () => {
  it("enumerates the day boundaries inside the span, dropping the one before `from`", () => {
    const from = T("2026-08-06T13:00:00Z");
    const to = T("2026-08-09T00:00:00Z");
    expect(unitBoundaries(from, to, "day")).toEqual([
      T("2026-08-07T00:00:00Z"),
      T("2026-08-08T00:00:00Z"),
    ]);
  });

  it("keeps a boundary that coincides with `from` and drops one that coincides with `to`", () => {
    const from = T("2026-08-06T00:00:00Z");
    expect(unitBoundaries(from, from + 2 * MS_DAY, "day")).toEqual([from, from + MS_DAY]);
  });

  it("enumerates hours from the UTC hour boundary", () => {
    const from = T("2026-08-06T13:20:00Z");
    expect(unitBoundaries(from, T("2026-08-06T15:00:00Z"), "hour")).toEqual([
      T("2026-08-06T14:00:00Z"),
    ]);
  });

  it("starts weeks on the configured weekday", () => {
    const from = T("2026-08-03T00:00:00Z"); // a Monday
    const to = T("2026-08-24T00:00:00Z");
    expect(unitBoundaries(from, to, "week")).toEqual([
      T("2026-08-03T00:00:00Z"),
      T("2026-08-10T00:00:00Z"),
      T("2026-08-17T00:00:00Z"),
    ]);
    // Sunday-first weeks land on the Sundays of the same span.
    expect(unitBoundaries(from, to, "week", 1, 0)).toEqual([
      T("2026-08-09T00:00:00Z"),
      T("2026-08-16T00:00:00Z"),
      T("2026-08-23T00:00:00Z"),
    ]);
  });

  it("anchors month and year boundaries on the calendar", () => {
    expect(unitBoundaries(T("2026-02-10T00:00:00Z"), T("2026-05-02T00:00:00Z"), "month")).toEqual([
      T("2026-03-01T00:00:00Z"),
      T("2026-04-01T00:00:00Z"),
      T("2026-05-01T00:00:00Z"),
    ]);
    expect(unitBoundaries(T("2026-06-01T00:00:00Z"), T("2029-01-02T00:00:00Z"), "year")).toEqual([
      T("2027-01-01T00:00:00Z"),
      T("2028-01-01T00:00:00Z"),
      T("2029-01-01T00:00:00Z"),
    ]);
  });

  it("steps on the calendar, not on `from` — quarters break at Jan/Apr/Jul/Oct", () => {
    expect(unitBoundaries(T("2026-02-15T00:00:00Z"), T("2027-01-01T00:00:00Z"), "month", 3)).toEqual(
      [
        T("2026-04-01T00:00:00Z"),
        T("2026-07-01T00:00:00Z"),
        T("2026-10-01T00:00:00Z"),
      ],
    );
    expect(unitBoundaries(T("2026-08-06T00:00:00Z"), T("2041-01-01T00:00:00Z"), "year", 10)).toEqual(
      [T("2030-01-01T00:00:00Z"), T("2040-01-01T00:00:00Z")],
    );
  });

  it("treats an unusable step as 1, exactly as a header row's own step is treated", () => {
    const from = T("2026-08-06T00:00:00Z");
    const to = from + 4 * MS_DAY;
    for (const step of [undefined, 1, 0, -3, Number.NaN]) {
      expect(unitBoundaries(from, to, "day", step)).toEqual(unitBoundaries(from, to, "day"));
    }
  });

  it("agrees with the header's own tick set on every boundary inside the span", () => {
    const units: ScaleUnit[] = ["hour", "day", "week", "month", "year"];
    const from = T("2026-08-06T13:45:12.500Z");
    // Short enough that neither enumeration reaches the shared 4096 cap, where the leading
    // boundary `ticks` reports and this one drops would shift the two sets against each other.
    const to = from + 40 * MS_DAY;
    for (const unit of units) {
      for (const step of [1, 3]) {
        expect(unitBoundaries(from, to, unit, step)).toEqual(
          ticks(from, to, unit, step).filter((t) => t >= from),
        );
      }
    }
  });

  it("returns nothing for an empty, inverted or non-finite span", () => {
    const t = T("2026-08-06T00:00:00Z");
    expect(unitBoundaries(t, t, "day")).toEqual([]);
    expect(unitBoundaries(t, t - MS_DAY, "day")).toEqual([]);
    expect(unitBoundaries(0, Number.POSITIVE_INFINITY, "day")).toEqual([]);
    expect(unitBoundaries(Number.NaN, 1, "day")).toEqual([]);
  });

  it("caps output at the header's own limit rather than growing unbounded", () => {
    const from = T("2000-01-01T00:00:00Z");
    expect(unitBoundaries(from, from + 1000 * 365 * MS_DAY, "hour").length).toBe(MAX_TICKS);
  });
});
