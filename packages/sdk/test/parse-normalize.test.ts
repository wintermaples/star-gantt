/**
 * `parseIsoDateStrict` (docs/specs/sdk.md, Module: sdk/time) and `normalizeWheelDelta`
 * (docs/specs/sdk.md, Module: sdk/dom).
 */
import { describe, expect, it } from "vitest";
import { normalizeWheelDelta, parseIsoDateStrict } from "../src/index";

describe("parseIsoDateStrict", () => {
  it("parses a valid YYYY-MM-DD to UTC midnight", () => {
    expect(parseIsoDateStrict("2024-02-29")).toBe(Date.UTC(2024, 1, 29));
    expect(parseIsoDateStrict("1999-12-31")).toBe(Date.UTC(1999, 11, 31));
  });

  it("rejects calendar-invalid dates instead of rolling them over", () => {
    expect(parseIsoDateStrict("2024-02-30")).toBeUndefined();
    expect(parseIsoDateStrict("2023-02-29")).toBeUndefined();
    expect(parseIsoDateStrict("2024-13-01")).toBeUndefined();
    expect(parseIsoDateStrict("2024-04-31")).toBeUndefined();
    expect(parseIsoDateStrict("2024-00-10")).toBeUndefined();
    expect(parseIsoDateStrict("2024-01-00")).toBeUndefined();
  });

  it("rejects anything but the exact shape — no trimming, no time suffix", () => {
    expect(parseIsoDateStrict("")).toBeUndefined();
    expect(parseIsoDateStrict(" 2024-01-02")).toBeUndefined();
    expect(parseIsoDateStrict("2024-1-2")).toBeUndefined();
    expect(parseIsoDateStrict("2024-01-02T00:00:00Z")).toBeUndefined();
    expect(parseIsoDateStrict("2024/01/02")).toBeUndefined();
  });
});

describe("normalizeWheelDelta", () => {
  it("passes pixel-mode deltas through unchanged", () => {
    expect(normalizeWheelDelta({ deltaX: 3, deltaY: -120, deltaMode: 0 })).toEqual({
      dx: 3,
      dy: -120,
    });
  });

  it("scales line mode by a 16 px nominal line", () => {
    expect(normalizeWheelDelta({ deltaX: 0, deltaY: 3, deltaMode: 1 })).toEqual({ dx: 0, dy: 48 });
  });

  it("scales page mode by the given viewport height, or a nominal page without one", () => {
    expect(normalizeWheelDelta({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 540)).toEqual({
      dx: 0,
      dy: 540,
    });
    expect(normalizeWheelDelta({ deltaX: 0, deltaY: -1, deltaMode: 2 })).toEqual({
      dx: 0,
      dy: -800,
    });
  });

  it("falls back to the nominal page for a non-positive page size (pre-layout height 0)", () => {
    expect(normalizeWheelDelta({ deltaX: 0, deltaY: 1, deltaMode: 2 }, 0)).toEqual({
      dx: 0,
      dy: 800,
    });
  });

  it("treats an unknown mode as pixels", () => {
    expect(normalizeWheelDelta({ deltaX: 5, deltaY: 5, deltaMode: 9 })).toEqual({ dx: 5, dy: 5 });
  });
});
