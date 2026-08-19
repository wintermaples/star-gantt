/**
 * The band's step-first y scale (docs/specs/plugins/resource.md §3.6).
 *
 * The point of the step-first search is that every TICK is round by construction — the ceiling is
 * a consequence of the step, never an independently rounded number — and that the search is
 * monotonic: a larger peak can never be given a smaller step.
 */
import { describe, expect, it } from "vitest";
import { durationUnitMs, MS_HOUR } from "@stargantt/sdk";
import { AXIS_LABEL_HEIGHT, computeAxisScale, formatAxisValue, layoutAxisLabels } from "../src/internal/load-chart/axis";

describe("computeAxisScale (§3.6)", () => {
  it("has no scale for a non-positive or non-finite peak", () => {
    expect(computeAxisScale(0, 64)).toBeNull();
    expect(computeAxisScale(-3, 64)).toBeNull();
    expect(computeAxisScale(Number.NaN, 64)).toBeNull();
    expect(computeAxisScale(Number.POSITIVE_INFINITY, 64)).toBeNull();
  });

  it("picks a round step whose ceiling reaches the peak, with every tick a multiple of it", () => {
    const scale = computeAxisScale(7, 64);
    expect(scale).not.toBeNull();
    const { step, ceiling, ticks } = scale as NonNullable<typeof scale>;
    expect(ceiling).toBeGreaterThanOrEqual(7);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBe(ceiling);
    for (const [index, tick] of ticks.entries()) {
      expect(tick).toBeCloseTo(index * step, 10);
    }
  });

  it("keeps the tick count inside the [2, 5] window the plot height allows", () => {
    // A 24px plot holds the two-tick minimum; a tall plot never exceeds five.
    expect((computeAxisScale(9, 24) as { ticks: number[] }).ticks.length).toBeLessThanOrEqual(2);
    expect((computeAxisScale(9, 400) as { ticks: number[] }).ticks.length).toBeLessThanOrEqual(5);
    expect((computeAxisScale(9, 400) as { ticks: number[] }).ticks.length).toBeGreaterThanOrEqual(2);
  });

  it("is monotonic: a larger peak never gets a smaller step", () => {
    let previous = 0;
    for (const peak of [0.3, 1, 2, 5, 9, 17, 40, 99, 1000, 12_345]) {
      const step = (computeAxisScale(peak, 96) as { step: number }).step;
      expect(step).toBeGreaterThanOrEqual(previous);
      previous = step;
    }
  });

  it("chooses round DURATIONS when the magnitude query is the shared duration ladder", () => {
    // A 23h peak over two slots ceils into the next magnitude; re-running the search there is what
    // keeps the ceiling a round duration rather than "1.7d".
    const scale = computeAxisScale(23 * MS_HOUR, 48, durationUnitMs);
    expect(scale).not.toBeNull();
    const { ceiling, step } = scale as NonNullable<typeof scale>;
    const unit = durationUnitMs(ceiling);
    expect(ceiling / unit).toBeCloseTo(Math.round(ceiling / unit), 6);
    expect(step / unit).toBeGreaterThan(0);
  });
});

describe("layoutAxisLabels (§3.6)", () => {
  const yOf = (value: number): number => 100 - value * 10; // 0 → 100, 10 → 0

  it("bottom-anchors the zero label and centres the rest on their tick", () => {
    const boxes = layoutAxisLabels({ ticks: [0, 5, 10], yOf, height: 100 });
    const zero = boxes.find((b) => b.value === 0);
    expect(zero?.top).toBeNull();
    const middle = boxes.find((b) => b.value === 5);
    expect(middle?.top).toBeCloseTo(yOf(5) - AXIS_LABEL_HEIGHT / 2, 6);
  });

  it("emits from the ceiling downward and drops colliding labels, so the ceiling survives", () => {
    // A 20px-tall box cannot hold three 14px labels: the ceiling's is emitted first and kept.
    const boxes = layoutAxisLabels({ ticks: [0, 5, 10], yOf: (v) => 20 - v * 2, height: 20 });
    expect(boxes.length).toBeLessThan(3);
    expect(boxes[0]?.value).toBe(10);
  });

  it("renders tick text through the caller's own formatter when one is given", () => {
    const boxes = layoutAxisLabels({ ticks: [0, 10], yOf, height: 100, format: (v) => `${String(v)}u` });
    expect(boxes.map((b) => b.text)).toContain("10u");
  });

  it("formats a plain tick in its minimal decimal form", () => {
    expect(formatAxisValue(2.5)).toBe("2.5");
    expect(formatAxisValue(3)).toBe("3");
    expect(formatAxisValue(0.1 * 3)).toBe("0.3");
  });
});
