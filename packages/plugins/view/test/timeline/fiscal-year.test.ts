/**
 * Fiscal-year periods on the built-in levels.
 *
 * `fiscalYearStartMonth` reshapes
 * the year and quarter rows of the built-in `month` / `quarter` / `year` levels into stepped
 * month rows anchored on the fiscal start month; `ScaleRow.stepOffset` is the public anchoring
 * mechanism, shared with `unitBoundaries`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { defaultZoomLevels, normalizeFiscalStartMonth } from "../../src/internal/timeline/levels";
import { floorToStep, normalizeStepOffset, ticks } from "../../src/internal/timeline/scale";
import { boot } from "./_boot";
import type { Booted } from "./_boot";

let booted: Booted | null = null;

afterEach(() => {
  booted?.dom.restore();
  booted = null;
});

const APR_2026 = Date.UTC(2026, 3, 1);

describe("normalization", () => {
  it("accepts integers 2..12 and rejects 1 and everything unusable", () => {
    expect(normalizeFiscalStartMonth(4)).toBe(4);
    expect(normalizeFiscalStartMonth(12)).toBe(12);
    expect(normalizeFiscalStartMonth(1)).toBeUndefined();
    expect(normalizeFiscalStartMonth(0)).toBeUndefined();
    expect(normalizeFiscalStartMonth(13)).toBeUndefined();
    expect(normalizeFiscalStartMonth(4.5)).toBeUndefined();
    expect(normalizeFiscalStartMonth("4")).toBeUndefined();
    expect(normalizeFiscalStartMonth(undefined)).toBeUndefined();
  });

  it("reduces stepOffset modulo step and degrades unusable values to 0", () => {
    expect(normalizeStepOffset(3, 12)).toBe(3);
    expect(normalizeStepOffset(15, 12)).toBe(3);
    expect(normalizeStepOffset(-9, 12)).toBe(3);
    expect(normalizeStepOffset(Number.NaN, 12)).toBe(0);
    expect(normalizeStepOffset(undefined, 12)).toBe(0);
  });
});

describe("stepOffset anchoring in the calendar arithmetic", () => {
  it("anchors a step-12 month sequence on April with offset 3", () => {
    expect(floorToStep(Date.UTC(2026, 7, 15), "month", 12, 1, undefined, 3)).toBe(APR_2026);
    // February 2026 belongs to the fiscal year that started April 2025.
    expect(floorToStep(Date.UTC(2026, 1, 10), "month", 12, 1, undefined, 3)).toBe(
      Date.UTC(2025, 3, 1),
    );
  });

  it("enumerates April-start fiscal years across a span", () => {
    const out = ticks(Date.UTC(2025, 0, 1), Date.UTC(2027, 11, 31), "month", 12, 1, undefined, 3);
    expect(out).toEqual([
      Date.UTC(2024, 3, 1),
      Date.UTC(2025, 3, 1),
      Date.UTC(2026, 3, 1),
      Date.UTC(2027, 3, 1),
    ]);
  });
});

describe("built-in levels under a fiscal configuration", () => {
  it("keeps the exact pre-existing shapes when no fiscal month is set", () => {
    const year = defaultZoomLevels().find((l) => l.id === "year");
    expect(year?.scales.map((s) => s.unit)).toEqual(["year", "year"]);
  });

  it("turns the year rows of month/quarter/year levels into anchored month rows", () => {
    const levels = defaultZoomLevels({ fiscalYearStartMonth: 4 });
    const month = levels.find((l) => l.id === "month");
    const quarter = levels.find((l) => l.id === "quarter");
    const year = levels.find((l) => l.id === "year");
    expect(month?.scales[0]).toMatchObject({ unit: "month", step: 12, stepOffset: 3 });
    expect(quarter?.scales[1]).toMatchObject({ unit: "month", step: 3, stepOffset: 0 });
    expect(year?.scales[0]).toMatchObject({ unit: "month", step: 120, stepOffset: 3 });
    expect(year?.scales[1]).toMatchObject({ unit: "month", step: 12, stepOffset: 3 });
    // A May fiscal year has quarters at May/Aug/Nov/Feb: offset (5-1) % 3 = 1.
    const may = defaultZoomLevels({ fiscalYearStartMonth: 5 });
    expect(may.find((l) => l.id === "quarter")?.scales[1]).toMatchObject({
      unit: "month",
      step: 3,
      stepOffset: 1,
    });
  });

  it("keeps the day-grained levels on calendar months", () => {
    const levels = defaultZoomLevels({ fiscalYearStartMonth: 4 });
    const day = levels.find((l) => l.id === "day");
    expect(day?.scales[0]).toMatchObject({ unit: "month" });
    expect(day?.scales[0]?.step).toBeUndefined();
  });

  it("labels a fiscal-year boundary with the year the period starts in", () => {
    const year = defaultZoomLevels({ fiscalYearStartMonth: 4 }).find((l) => l.id === "year");
    expect(year?.scales[1]?.format(APR_2026, "en")).toBe("2026");
  });

  // the ten-fiscal-year coarse row
  // gets the same span treatment as its calendar counterpart.
  it("labels the ten-fiscal-year row with the range of fiscal years it covers", () => {
    const year = defaultZoomLevels({ fiscalYearStartMonth: 4 }).find((l) => l.id === "year");
    // April 2020 seeds a period running to March 2030, i.e. fiscal years 2020 through 2029 —
    // labelling its right bound with the calendar year the period *ends* in would read "2030".
    expect(year?.scales[0]?.format(Date.UTC(2020, 3, 1), "en")).toBe("2020–2029");
  });
});

describe("service integration", () => {
  it("unitBoundaries honors the stepOffset argument", () => {
    booted = boot([], {}, { origin: 0, fiscalYearStartMonth: 4 });
    const s = booted.gantt.service("stargantt.timeline");
    const out = s.unitBoundaries("month", Date.UTC(2025, 5, 1), Date.UTC(2027, 5, 1), 12, 3);
    expect(out).toEqual([APR_2026, Date.UTC(2027, 3, 1)]);
  });

  it("paints fiscal-year labels on the year level's header", () => {
    booted = boot([], {}, { origin: Date.UTC(2026, 0, 1), initialZoom: "year", fiscalYearStartMonth: 4 });
    booted.dom.flushFrames();
    const texts = booted.header.context.texts.map((t) => t.text);
    expect(texts.length).toBeGreaterThan(0);
    // Fiscal-year labels are plain year numbers on the fine row, which breaks on Aprils; the coarse
    // row spans ten fiscal years and reads as a range.
    expect(texts.every((t) => /^\d{4}(–\d{4})?$/.test(t))).toBe(true);
    expect(texts.some((t) => t.includes("–"))).toBe(true);
  });
});
