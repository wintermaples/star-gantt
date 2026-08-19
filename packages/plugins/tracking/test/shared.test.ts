// internal/shared/* — the foundation every area builds on (status date chain, snapshot series,
// meta-bag read/write, numeric validators, duration grammar, amount formatting).
import { describe, expect, it } from "vitest";
import {
  currentUtcDayStart,
  evmStatusDateResolver,
  finiteOr,
  startOfUtcDay,
  statusDateResolver,
} from "../src/internal/shared/status-date";
import {
  normalizeSeededSeries,
  normalizeSeededSeriesDedupeByDay,
  recordOrReplaceByDay,
} from "../src/internal/shared/snapshot-series";
import { buildBagWrite, buildScalarMetaWrite, readBag } from "../src/internal/shared/meta-bag";
import { clamp, finiteNonNegative, finitePositive, isFiniteNumber, trimmedNonEmpty } from "../src/internal/shared/numbers";
import { parseDurationInput } from "../src/internal/shared/duration-grammar";
import { formatAmount, formatIndex, formatPercent } from "../src/internal/shared/format";
import type { Task } from "@stargantt/plugin-data-store";

describe("status-date", () => {
  it("startOfUtcDay floors to the UTC day boundary", () => {
    const noon = Date.UTC(2024, 0, 15, 12, 30);
    expect(startOfUtcDay(noon)).toBe(Date.UTC(2024, 0, 15));
  });

  it("currentUtcDayStart uses the injected clock", () => {
    const noon = Date.UTC(2024, 0, 15, 12, 30);
    expect(currentUtcDayStart(() => noon)).toBe(Date.UTC(2024, 0, 15));
  });

  it("finiteOr falls back only for non-finite values", () => {
    expect(finiteOr(5, () => 9)).toBe(5);
    expect(finiteOr(undefined, () => 9)).toBe(9);
    expect(finiteOr(Number.NaN, () => 9)).toBe(9);
  });

  it("statusDateResolver: configured value wins, else the current UTC day", () => {
    const now = () => Date.UTC(2024, 0, 15, 8);
    expect(statusDateResolver(Date.UTC(2024, 0, 1), now)()).toBe(Date.UTC(2024, 0, 1));
    expect(statusDateResolver(undefined, now)()).toBe(Date.UTC(2024, 0, 15));
  });

  it("evmStatusDateResolver: own configured value, else the progress chain", () => {
    const progressStatusDate = () => Date.UTC(2024, 5, 1);
    expect(evmStatusDateResolver(Date.UTC(2024, 0, 1), progressStatusDate)()).toBe(
      Date.UTC(2024, 0, 1),
    );
    expect(evmStatusDateResolver(undefined, progressStatusDate)()).toBe(Date.UTC(2024, 5, 1));
  });
});

describe("snapshot-series", () => {
  interface Pt {
    date: number;
    v: number;
  }
  const dateOf = (p: Pt): number => p.date;
  const usable = (p: Pt): boolean => typeof p.v === "number" && Number.isFinite(p.v);
  const withDay = (p: Pt, day: number): Pt => ({ ...p, date: day });

  it("normalizeSeededSeries drops unusable entries and sorts ascending, no dedup", () => {
    const seed: Pt[] = [
      { date: Date.UTC(2024, 0, 3, 5), v: 1 },
      { date: Date.UTC(2024, 0, 1), v: 2 },
      { date: Number.NaN, v: 3 },
      { date: Date.UTC(2024, 0, 1, 20), v: Number.NaN },
    ];
    const out = normalizeSeededSeries(seed, dateOf, usable, withDay);
    expect(out.map((p) => p.date)).toEqual([Date.UTC(2024, 0, 1), Date.UTC(2024, 0, 3)]);
  });

  it("normalizeSeededSeriesDedupeByDay keeps the last entry per day", () => {
    const seed: Pt[] = [
      { date: Date.UTC(2024, 0, 1, 2), v: 1 },
      { date: Date.UTC(2024, 0, 1, 20), v: 2 },
    ];
    const out = normalizeSeededSeriesDedupeByDay(seed, dateOf, usable, withDay);
    expect(out).toHaveLength(1);
    expect(out[0]?.v).toBe(2);
  });

  it("recordOrReplaceByDay replaces a same-day point and keeps ascending order", () => {
    const day1 = Date.UTC(2024, 0, 1);
    const day2 = Date.UTC(2024, 0, 2);
    let series: Pt[] = [{ date: day1, v: 1 }];
    series = recordOrReplaceByDay(series, { date: day2, v: 2 }, dateOf);
    series = recordOrReplaceByDay(series, { date: day1, v: 9 }, dateOf);
    expect(series).toEqual([
      { date: day1, v: 9 },
      { date: day2, v: 2 },
    ]);
  });
});

describe("meta-bag", () => {
  it("readBag defensively yields {} for a missing or non-object bag", () => {
    expect(readBag(undefined, "progressTracking")).toEqual({});
    expect(readBag({ id: 1, meta: {} } as unknown as Task, "progressTracking")).toEqual({});
    expect(
      readBag({ id: 1, meta: { progressTracking: "nope" } } as unknown as Task, "progressTracking"),
    ).toEqual({});
    expect(
      readBag(
        { id: 1, meta: { progressTracking: { rag: "red" } } } as unknown as Task,
        "progressTracking",
      ),
    ).toEqual({ rag: "red" });
  });

  it("buildBagWrite preserves sibling meta keys and drops an emptied bag", () => {
    const task = { id: 1, meta: { other: 1, progressTracking: { rag: "red" } } } as unknown as Task;
    const patch = buildBagWrite(task, "progressTracking", { rag: "green" });
    expect(patch).toEqual({ after: { meta: { other: 1, progressTracking: { rag: "green" } } } });

    const cleared = buildBagWrite(task, "progressTracking", undefined);
    expect(cleared).toEqual({ after: { meta: { other: 1 } } });
  });

  it("buildBagWrite clears meta entirely via `clears` when nothing is left", () => {
    const task = { id: 1, meta: { progressTracking: { rag: "red" } } } as unknown as Task;
    const patch = buildBagWrite(task, "progressTracking", undefined);
    expect(patch).toEqual({ after: {}, clears: ["meta"] });
  });

  it("buildScalarMetaWrite sets / keeps / clears independently per key", () => {
    const task = { id: 1, meta: { actualStart: 1, actualEnd: 2 } } as unknown as Task;
    const patch = buildScalarMetaWrite(task, { actualStart: 5, actualEnd: undefined });
    expect(patch).toEqual({ after: { meta: { actualStart: 5, actualEnd: 2 } } });

    const clearedOne = buildScalarMetaWrite(task, { actualStart: null });
    expect(clearedOne).toEqual({ after: { meta: { actualEnd: 2 } } });

    const clearedAll = buildScalarMetaWrite(task, { actualStart: null, actualEnd: null });
    expect(clearedAll).toEqual({ after: {}, clears: ["meta"] });

    const noop = buildScalarMetaWrite(task, { actualStart: Number.NaN });
    expect(noop).toEqual({ after: { meta: { actualStart: 1, actualEnd: 2 } } });
  });
});

describe("numbers", () => {
  it("validates finite / non-negative / positive numbers", () => {
    expect(isFiniteNumber(5)).toBe(true);
    expect(isFiniteNumber(Number.NaN)).toBe(false);
    expect(finiteNonNegative(-1)).toBeUndefined();
    expect(finiteNonNegative(0)).toBe(0);
    expect(finitePositive(0)).toBeUndefined();
    expect(finitePositive(1)).toBe(1);
  });

  it("clamps into range, falling back to min on a non-finite value", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
    expect(clamp(Number.NaN, 2, 10)).toBe(2);
  });

  it("trims non-empty strings and rejects blanks", () => {
    expect(trimmedNonEmpty("  hi  ")).toBe("hi");
    expect(trimmedNonEmpty("   ")).toBeUndefined();
    expect(trimmedNonEmpty(5)).toBeUndefined();
  });
});

describe("duration-grammar", () => {
  it("parses a bare number as days", () => {
    expect(parseDurationInput("2")).toBe(2 * 86_400_000);
    expect(parseDurationInput("1.5")).toBe(1.5 * 86_400_000);
  });

  it("parses d/h/m/s suffixes with optional whitespace", () => {
    expect(parseDurationInput("4h")).toBe(4 * 3_600_000);
    expect(parseDurationInput("  30 m")).toBe(30 * 60_000);
    expect(parseDurationInput("12s")).toBe(12_000);
  });

  it("returns undefined for unparsable text", () => {
    expect(parseDurationInput("abc")).toBeUndefined();
    expect(parseDurationInput("")).toBeUndefined();
    expect(parseDurationInput("5x")).toBeUndefined();
  });
});

describe("format", () => {
  it("formats amounts rounded, indices to two decimals, percents rounded", () => {
    expect(formatAmount(1234.6)).toBe("1,235");
    expect(formatAmount(Number.NaN)).toBe("0");
    expect(formatIndex(1.005)).toBe("1.01");
    expect(formatIndex(undefined)).toBe("—");
    expect(formatPercent(33.4)).toBe("33");
  });

  // Review minor: pin the rounding rule at zero fraction digits and the deliberate divergence it
  // produces from a plain `Math.round` implementation. `Intl.NumberFormat` (used here) rounds a
  // negative half-magnitude AWAY from zero: -0.5 -> -1, -1.5 -> -2. `Math.round` instead rounds
  // ties toward +Infinity: -0.5 -> -0 (prints "0"), -1.5 -> -1 (prints "-1") — genuinely different
  // text at these two exact boundaries, the one accepted divergence the cost area's report records
  // (chosen so panel figures match the message-catalog builders exactly, §6). Every other input
  // agrees with `Math.round` byte-for-byte. A magnitude that rounds to negative zero is additionally
  // clamped so it never prints "-0".
  it("pins the negative half-magnitude rounding rule (a deliberate Math.round divergence) and the -0 clamp", () => {
    expect(formatAmount(-0.5)).toBe("-1"); // Math.round(-0.5) === -0, prints "0"
    expect(formatAmount(-1.5)).toBe("-2"); // Math.round(-1.5) === -1, prints "-1"
    expect(formatAmount(-0.4)).toBe("0"); // rounds to -0 internally; clamped to "0", never "-0"
    expect(formatAmount(-0)).toBe("0");
    expect(formatPercent(-0.4)).toBe("0");
  });
});
