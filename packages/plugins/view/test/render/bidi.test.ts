/** Hostless unit tests for the bidi label helpers (contract §6.9). */
import { describe, expect, it } from "vitest";
import { bidiIsolate, hasRtl, isMixedDirection } from "../../src/internal/render/bidi";

const LRI = "\u2066";
const RLI = "\u2067";
const FSI = "\u2068";
const PDI = "\u2069";

const HEBREW = "משימה"; // "task" in Hebrew letters
const ARABIC = "مهمة";

describe("hasRtl / isMixedDirection", () => {
  it("detects Hebrew and Arabic strong characters", () => {
    expect(hasRtl(HEBREW)).toBe(true);
    expect(hasRtl(ARABIC)).toBe(true);
    expect(hasRtl("plain latin 123")).toBe(false);
  });

  it("calls a string mixed only when RTL meets LTR letters or digits", () => {
    expect(isMixedDirection(`${HEBREW} A1`)).toBe(true);
    expect(isMixedDirection(`${ARABIC} 42`)).toBe(true);
    expect(isMixedDirection(HEBREW)).toBe(false);
    expect(isMixedDirection("Latin only")).toBe(false);
  });
});

describe("bidiIsolate", () => {
  it("wraps a mixed-direction label in the base direction's isolate pair", () => {
    const mixed = `${HEBREW} T-42`;
    expect(bidiIsolate(mixed, "rtl")).toBe(`${RLI}${mixed}${PDI}`);
    expect(bidiIsolate(mixed, "ltr")).toBe(`${LRI}${mixed}${PDI}`);
  });

  it("uses a first-strong isolate when no base is given", () => {
    const mixed = `${ARABIC} 7`;
    expect(bidiIsolate(mixed)).toBe(`${FSI}${mixed}${PDI}`);
  });

  it("returns one-directional strings unchanged", () => {
    expect(bidiIsolate("Design review", "rtl")).toBe("Design review");
    expect(bidiIsolate(HEBREW, "rtl")).toBe(HEBREW);
  });

  it("never double-wraps an already isolated string", () => {
    const once = bidiIsolate(`${HEBREW} A1`, "rtl");
    expect(bidiIsolate(once, "rtl")).toBe(once);
  });

  it("yields an empty string for non-string input", () => {
    expect(bidiIsolate(undefined as unknown as string)).toBe("");
  });
});
