/**
 * Unit tests for the hostless shading helpers: config normalization, weekend arithmetic, the
 * minimum-band-width guard and hover row resolution. No host, no canvas.
 */
import { MS_DAY } from "@stargantt/sdk";
import { describe, expect, it } from "vitest";
import {
  MIN_BAND_PX,
  bandIsLegible,
  isWholeDayBand,
  isWithinOneUtcDay,
  normalizeNonWorkingDays,
  normalizeZones,
  rowAt,
  utcWeekday,
  weekendSpans,
} from "../../src/internal/grid-lines/shading";
import type { RowGeometry } from "../../src/internal/grid-lines/shading";

describe("normalizeNonWorkingDays", () => {
  it("maps true to the Sat/Sun default and no calendar", () => {
    expect(normalizeNonWorkingDays(true)).toEqual({ calendar: undefined, weekend: [0, 6] });
  });

  it("keeps a calendar id and a valid weekend list from the object form", () => {
    expect(normalizeNonWorkingDays({ calendar: "fr", weekend: [5, 6] })).toEqual({
      calendar: "fr",
      weekend: [5, 6],
    });
  });

  it("drops invalid weekend entries, dedupes and sorts", () => {
    expect(normalizeNonWorkingDays({ weekend: [6, 0, 6, 7, -1, 2.5, "x"] })?.weekend).toEqual([
      0, 6,
    ]);
  });

  it("keeps an explicitly empty weekend list (shade nothing without a calendar)", () => {
    expect(normalizeNonWorkingDays({ weekend: [] })?.weekend).toEqual([]);
  });

  it("disables on false, undefined, numbers, arrays and other junk", () => {
    for (const v of [false, undefined, null, 1, "yes", [0, 6]]) {
      expect(normalizeNonWorkingDays(v)).toBeUndefined();
    }
  });
});

describe("normalizeZones", () => {
  it("keeps finite positive spans and per-zone colors", () => {
    expect(
      normalizeZones([
        { start: 0, end: 10 },
        { start: 10, end: 20, color: "red" },
      ]),
    ).toEqual([
      { start: 0, end: 10, color: undefined },
      { start: 10, end: 20, color: "red" },
    ]);
  });

  it("drops empty, inverted, non-finite and malformed entries one by one", () => {
    expect(
      normalizeZones([
        { start: 5, end: 5 },
        { start: 9, end: 3 },
        { start: Number.NaN, end: 9 },
        { start: 0, end: Number.POSITIVE_INFINITY },
        { start: "0", end: 9 },
        null,
        { start: 1, end: 2, color: "" },
      ]),
    ).toEqual([{ start: 1, end: 2, color: undefined }]);
  });

  it("yields no zones for a non-array input", () => {
    expect(normalizeZones({ start: 0, end: 1 })).toEqual([]);
  });
});

describe("utcWeekday", () => {
  it("knows the epoch was a Thursday and handles pre-epoch instants", () => {
    expect(utcWeekday(0)).toBe(4);
    expect(utcWeekday(2 * MS_DAY)).toBe(6); // 1970-01-03, Saturday
    expect(utcWeekday(-MS_DAY)).toBe(3); // 1969-12-31, Wednesday
  });
});

describe("weekendSpans", () => {
  const bounds = [0, 1, 2, 3, 4, 5, 6, 7].map((d) => d * MS_DAY);

  it("merges adjacent weekend days into one span", () => {
    // Days 2 and 3 of Jan 1970 are Sat+Sun.
    expect(weekendSpans(bounds, [0, 6])).toEqual([{ start: 2 * MS_DAY, end: 4 * MS_DAY }]);
  });

  it("honors a custom weekend pattern", () => {
    // Friday-only weekend: only day 1 (Fri Jan 2) falls inside the enumerated days.
    expect(weekendSpans(bounds, [5])).toEqual([{ start: 1 * MS_DAY, end: 2 * MS_DAY }]);
  });

  it("returns nothing for an empty weekend or no boundaries", () => {
    expect(weekendSpans(bounds, [])).toEqual([]);
    expect(weekendSpans([], [0, 6])).toEqual([]);
  });

  it("extends one day left of the first boundary so a clipped weekend day still shades", () => {
    // First boundary is Sun Jan 4; the extension covers Sat Jan 3 and merges with Sunday.
    expect(weekendSpans([3 * MS_DAY, 4 * MS_DAY], [0, 6])).toEqual([
      { start: 2 * MS_DAY, end: 4 * MS_DAY },
    ]);
  });
});

// The guard's classification
// arithmetic. "A span is whole-day-aligned exactly when both ends fall on UTC midnights or on the
// query's own bounds", so each end is tested separately against those two admissible values.
describe("isWholeDayBand", () => {
  const FROM = 2 * MS_DAY + 9 * 3_600_000; // a mid-day query start
  const TO = 6 * MS_DAY + 15 * 3_600_000; // a mid-day query end

  it("accepts a band whose two ends are UTC midnights", () => {
    expect(isWholeDayBand({ start: 3 * MS_DAY, end: 5 * MS_DAY }, FROM, TO)).toBe(true);
  });

  it("rejects a band with an intra-day end", () => {
    const lunch = { start: 3 * MS_DAY + 12 * 3_600_000, end: 3 * MS_DAY + 13 * 3_600_000 };
    expect(isWholeDayBand(lunch, FROM, TO)).toBe(false);
  });

  // The clipped-edge exemption: the engine cuts the first and last band at the query's bounds,
  // so a partially visible non-working day loses its midnight alignment through clipping alone.
  it("exempts an end the query's own bounds cut", () => {
    expect(isWholeDayBand({ start: FROM, end: 3 * MS_DAY }, FROM, TO)).toBe(true);
    expect(isWholeDayBand({ start: 6 * MS_DAY, end: TO }, FROM, TO)).toBe(true);
  });

  it("still rejects a band clipped at one end whose other end is intra-day", () => {
    expect(isWholeDayBand({ start: FROM, end: 3 * MS_DAY + 60_000 }, FROM, TO)).toBe(false);
  });

  it("classifies a pre-1970 midnight correctly", () => {
    expect(isWholeDayBand({ start: -2 * MS_DAY, end: -MS_DAY }, FROM, TO)).toBe(true);
    expect(isWholeDayBand({ start: -2 * MS_DAY + 1, end: -MS_DAY }, FROM, TO)).toBe(false);
  });
});

// What makes a band *off-hours* rather
// than non-working time at large: it is contained within a single UTC day. The classifier is
// query-independent, unlike `isWholeDayBand`.
describe("isWithinOneUtcDay", () => {
  const h = (n: number): number => n * 3_600_000;

  it("accepts a gap between one day's working windows", () => {
    expect(isWithinOneUtcDay({ start: 3 * MS_DAY + h(12), end: 3 * MS_DAY + h(13) })).toBe(true);
  });

  it("accepts a gap touching either midnight of its day", () => {
    expect(isWithinOneUtcDay({ start: 3 * MS_DAY, end: 3 * MS_DAY + h(9) })).toBe(true);
    expect(isWithinOneUtcDay({ start: 3 * MS_DAY + h(17), end: 4 * MS_DAY })).toBe(true);
  });

  it("rejects an overnight gap, which crosses one midnight", () => {
    expect(isWithinOneUtcDay({ start: 3 * MS_DAY + h(17), end: 4 * MS_DAY + 1 })).toBe(false);
  });

  // The band the defect painted over: Friday evening, the weekend and Monday morning, merged by
  // the engine into one unaligned span that the tint conveys on its own.
  it("rejects a band merged across a weekend", () => {
    expect(isWithinOneUtcDay({ start: 1 * MS_DAY + h(17), end: 4 * MS_DAY + h(9) })).toBe(false);
  });

  it("classifies a pre-1970 day correctly", () => {
    expect(isWithinOneUtcDay({ start: -2 * MS_DAY + h(17), end: -MS_DAY })).toBe(true);
    expect(isWithinOneUtcDay({ start: -2 * MS_DAY + h(17), end: -MS_DAY + h(9) })).toBe(false);
  });
});

// §4.1 gate 2 — an intra-day band is drawn only while it is at least MIN_BAND_PX wide on screen;
// a whole-day band is never subject to the width test (gate 3's degrade target).
describe("bandIsLegible", () => {
  const FROM = 0;
  const TO = 10 * MS_DAY;
  /** px per ms at a zoom of `pxPerDay` CSS px per day column. */
  const zoom = (pxPerDay: number): number => pxPerDay / MS_DAY;

  it("admits a whole-day band at any zoom the pass gate allows", () => {
    const day = { start: MS_DAY, end: 2 * MS_DAY };
    expect(bandIsLegible(day, FROM, TO, zoom(3))).toBe(true);
    expect(bandIsLegible(day, FROM, TO, zoom(240))).toBe(true);
  });

  it("admits an intra-day band exactly at the threshold and rejects it below", () => {
    // One hour wide. At 72 px/day an hour is 3 px — exactly MIN_BAND_PX; at 71 px/day it is
    // 2.958 px, under it.
    const hour = { start: MS_DAY + 3_600_000, end: MS_DAY + 7_200_000 };
    expect(zoom(72) * (hour.end - hour.start)).toBe(MIN_BAND_PX);
    expect(bandIsLegible(hour, FROM, TO, zoom(72))).toBe(true);
    expect(bandIsLegible(hour, FROM, TO, zoom(71))).toBe(false);
  });

  it("admits a clipped edge band regardless of how narrow it is", () => {
    // The viewport's left edge falls one minute before a Sunday's midnight, so the engine hands
    // back a one-minute sliver of the non-working Saturday. It is whole-day by the clipped-edge
    // exemption (start = the query's `from`, end = a UTC midnight), so the guard may not suppress
    // it: the day-granular picture painted that sliver.
    const edgeFrom = MS_DAY - 60_000;
    const sliver = { start: edgeFrom, end: MS_DAY };
    expect(zoom(24) * (sliver.end - sliver.start)).toBeLessThan(MIN_BAND_PX);
    expect(bandIsLegible(sliver, edgeFrom, TO, zoom(24))).toBe(true);
  });
});

describe("rowAt", () => {
  const rows: RowGeometry = {
    rowCount: () => 3,
    rowAtY: (y) => Math.min(2, Math.max(0, Math.floor(y / 30))),
    yOf: (row) => row * 30,
    rowHeight: () => 30,
  };

  it("resolves a y inside a row and rejects the clamped out-of-range answers", () => {
    expect(rowAt(rows, 0)).toBe(0);
    expect(rowAt(rows, 59)).toBe(1);
    expect(rowAt(rows, 90)).toBeUndefined(); // past the last row, despite rowAtY clamping
    expect(rowAt(rows, -1)).toBeUndefined();
  });

  it("returns undefined for an empty row model", () => {
    expect(rowAt({ ...rows, rowCount: () => 0 }, 10)).toBeUndefined();
  });
});
