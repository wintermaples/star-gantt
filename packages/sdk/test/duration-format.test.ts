/**
 * The shared duration display rule (docs/specs/sdk.md, Module: sdk/time): auto-magnitude text,
 * promotion at the unit boundaries, half-away-from-zero rounding, and no `Intl`.
 */
import { describe, expect, it } from "vitest";
import {
  MS_DAY,
  MS_HOUR,
  MS_MINUTE,
  MS_SECOND,
  durationUnitMs,
  durationUnits,
  formatDurationMs,
} from "../src/index";

describe("unit thresholds", () => {
  it("picks the unit from the magnitude", () => {
    expect(formatDurationMs(MS_DAY)).toBe("1d");
    expect(formatDurationMs(MS_HOUR)).toBe("1h");
    expect(formatDurationMs(MS_MINUTE)).toBe("1m");
    expect(formatDurationMs(MS_SECOND)).toBe("1s");
    expect(formatDurationMs(0)).toBe("0s");
    expect(formatDurationMs(1)).toBe("0s");
  });

  it("steps down a unit one millisecond below each threshold", () => {
    expect(formatDurationMs(MS_MINUTE - 1, { maxFractionDigits: 3 })).toBe("59.999s");
    expect(formatDurationMs(MS_HOUR - MS_MINUTE)).toBe("59m");
    expect(formatDurationMs(MS_DAY - MS_HOUR)).toBe("23h");
    expect(formatDurationMs(30 * MS_MINUTE)).toBe("30m");
    expect(formatDurationMs(4 * MS_HOUR)).toBe("4h");
    expect(formatDurationMs(1.5 * MS_DAY)).toBe("1.5d");
  });

  it("promotes a value that rounds onto the next unit's boundary", () => {
    expect(formatDurationMs(MS_DAY - 1)).toBe("1d");
    expect(formatDurationMs(MS_HOUR - 1)).toBe("1h");
    expect(formatDurationMs(MS_MINUTE - 1)).toBe("1m");
    expect(formatDurationMs(23.5 * MS_HOUR, { maxFractionDigits: 0 })).toBe("1d");
    expect(formatDurationMs(23.5 * MS_HOUR)).toBe("23.5h");
    expect(formatDurationMs(23.4 * MS_HOUR)).toBe("23.4h");
  });

  it("keeps the constants themselves in milliseconds", () => {
    expect([MS_DAY, MS_HOUR, MS_MINUTE, MS_SECOND]).toEqual([86_400_000, 3_600_000, 60_000, 1_000]);
  });
});

describe("the magnitude query", () => {
  it("answers the size of the unit the magnitude falls in", () => {
    expect(durationUnitMs(MS_DAY)).toBe(MS_DAY);
    expect(durationUnitMs(1.5 * MS_DAY)).toBe(MS_DAY);
    expect(durationUnitMs(MS_DAY - MS_HOUR)).toBe(MS_HOUR);
    expect(durationUnitMs(4 * MS_HOUR)).toBe(MS_HOUR);
    expect(durationUnitMs(30 * MS_MINUTE)).toBe(MS_MINUTE);
    expect(durationUnitMs(12 * MS_SECOND)).toBe(MS_SECOND);
    expect(durationUnitMs(0)).toBe(MS_SECOND);
    expect(durationUnitMs(1)).toBe(MS_SECOND);
  });

  it("ignores the sign, and answers the smallest unit for unusable input", () => {
    expect(durationUnitMs(-4 * MS_HOUR)).toBe(MS_HOUR);
    expect(durationUnitMs(-1.5 * MS_DAY)).toBe(MS_DAY);
    expect(durationUnitMs(Number.NaN)).toBe(MS_SECOND);
    expect(durationUnitMs("4" as unknown as number)).toBe(MS_SECOND);
  });

  // The point of exporting the query beside the formatter: one ladder, so a quantity's magnitude
  // and its printed suffix can never name different units.
  it("names the unit the formatter prints, suffix for suffix", () => {
    const suffix: Record<number, string> = {
      [MS_DAY]: "d",
      [MS_HOUR]: "h",
      [MS_MINUTE]: "m",
      [MS_SECOND]: "s",
    };
    const samples = [
      0,
      1,
      12 * MS_SECOND,
      30 * MS_MINUTE,
      4 * MS_HOUR,
      23.4 * MS_HOUR,
      MS_DAY,
      1.5 * MS_DAY,
      -2.25 * MS_DAY,
    ];
    for (const ms of samples) {
      expect(formatDurationMs(ms)).toMatch(new RegExp(`${suffix[durationUnitMs(ms)] as string}$`));
    }
  });
});

describe("rounding and digits", () => {
  it("rounds half away from zero", () => {
    expect(formatDurationMs(2.25 * MS_DAY)).toBe("2.3d");
    expect(formatDurationMs(-2.25 * MS_DAY)).toBe("-2.3d");
    expect(formatDurationMs(2.5 * MS_DAY, { maxFractionDigits: 0 })).toBe("3d");
    expect(formatDurationMs(-2.5 * MS_DAY, { maxFractionDigits: 0 })).toBe("-3d");
  });

  it("strips trailing zeros and a bare decimal point", () => {
    expect(formatDurationMs(2 * MS_DAY)).toBe("2d");
    expect(formatDurationMs(2 * MS_DAY, { maxFractionDigits: 3 })).toBe("2d");
    expect(formatDurationMs(2.5 * MS_DAY, { maxFractionDigits: 3 })).toBe("2.5d");
  });

  it("honours maxFractionDigits and clamps it to 0–3", () => {
    const ms = 1.23456 * MS_DAY;
    expect(formatDurationMs(ms, { maxFractionDigits: 0 })).toBe("1d");
    expect(formatDurationMs(ms, { maxFractionDigits: 1 })).toBe("1.2d");
    expect(formatDurationMs(ms, { maxFractionDigits: 2 })).toBe("1.23d");
    expect(formatDurationMs(ms, { maxFractionDigits: 3 })).toBe("1.235d");
    expect(formatDurationMs(ms, { maxFractionDigits: 9 })).toBe("1.235d");
    expect(formatDurationMs(ms, { maxFractionDigits: -4 })).toBe("1d");
    expect(formatDurationMs(ms, { maxFractionDigits: Number.NaN })).toBe("1.2d");
  });
});

describe("sign", () => {
  it("always marks a negative duration and never a zero one", () => {
    expect(formatDurationMs(-3 * MS_DAY)).toBe("-3d");
    expect(formatDurationMs(-0)).toBe("0s");
    expect(formatDurationMs(0, { signed: true })).toBe("0s");
    expect(formatDurationMs(-0, { signed: true })).toBe("0s");
    expect(formatDurationMs(-100, { maxFractionDigits: 0, signed: true })).toBe("0s");
  });

  it("marks a positive duration only when asked", () => {
    expect(formatDurationMs(3 * MS_DAY, { signed: true })).toBe("+3d");
    expect(formatDurationMs(-2 * MS_DAY, { signed: true })).toBe("-2d");
    expect(formatDurationMs(3 * MS_DAY)).toBe("3d");
  });
});

describe("durationUnits() — the ladder itself", () => {
  it("is exactly the four rungs, largest first", () => {
    expect(durationUnits()).toEqual([
      [MS_DAY, "d"],
      [MS_HOUR, "h"],
      [MS_MINUTE, "m"],
      [MS_SECOND, "s"],
    ]);
  });

  it("hands back the one shared array rather than allocating a fresh one per call", () => {
    // The ladder never changes at runtime; a parser reading it on every keystroke should not pay
    // for a fresh array and four fresh tuples each time.
    expect(durationUnits()).toBe(durationUnits());
  });

  it("is frozen, top level and each pair", () => {
    const ladder = durationUnits();
    expect(Object.isFrozen(ladder)).toBe(true);
    for (const pair of ladder) expect(Object.isFrozen(pair)).toBe(true);
    expect(() => {
      (ladder as unknown as [number, string][]).push([1, "x"]);
    }).toThrow();
  });
});

describe("unusable input and locale posture", () => {
  it("renders anything that is not a finite number as the empty string", () => {
    expect(formatDurationMs(Number.NaN)).toBe("");
    expect(formatDurationMs(Number.POSITIVE_INFINITY)).toBe("");
    expect(formatDurationMs(Number.NEGATIVE_INFINITY)).toBe("");
    expect(formatDurationMs("3" as unknown as number)).toBe("");
    expect(formatDurationMs(undefined as unknown as number)).toBe("");
  });

  it("emits ASCII digits, a dot separator and single-letter suffixes", () => {
    for (const ms of [1.5 * MS_DAY, 4 * MS_HOUR, 30 * MS_MINUTE, 12 * MS_SECOND, -2.25 * MS_DAY]) {
      expect(formatDurationMs(ms)).toMatch(/^[-+]?\d+(\.\d+)?[dhms]$/);
    }
  });
});
