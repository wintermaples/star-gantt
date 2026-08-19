/**
 * Colour arithmetic (docs/specs/sdk.md, Module: sdk/color): parsing every form
 * `getComputedStyle` can hand back, alpha compositing, and WCAG contrast.
 */
import { describe, expect, it } from "vitest";
import { composite, contrastRatio, parseColor, relativeLuminance } from "../src/index";

describe("parseColor: forms", () => {
  it("parses #rrggbb and #rrggbbaa", () => {
    expect(parseColor("#1c1917")).toEqual({ r: 0x1c, g: 0x19, b: 0x17, a: 1 });
    expect(parseColor("#ffffff80")).toEqual({ r: 255, g: 255, b: 255, a: 0x80 / 255 });
  });

  it("parses #rgb and #rgba by digit duplication", () => {
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("#0af")).toEqual({ r: 0x00, g: 0xaa, b: 0xff, a: 1 });
    expect(parseColor("#0af8")).toEqual({ r: 0x00, g: 0xaa, b: 0xff, a: 0x88 / 255 });
  });

  it("parses rgb()/rgba() with comma or space+slash separators", () => {
    expect(parseColor("rgb(28, 25, 23)")).toEqual({ r: 28, g: 25, b: 23, a: 1 });
    expect(parseColor("rgba(28, 25, 23, 0.4)")).toEqual({ r: 28, g: 25, b: 23, a: 0.4 });
    expect(parseColor("rgb(28 25 23 / 40%)")).toEqual({ r: 28, g: 25, b: 23, a: 0.4 });
  });

  it("accepts a percentage on the alpha, as getComputedStyle sometimes reports it", () => {
    expect(parseColor("rgba(0, 0, 0, 50%)")).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
  });

  it("treats transparent and case/whitespace variance uniformly", () => {
    expect(parseColor("transparent")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(parseColor("  #FFF  ")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("RGB(1,2,3)")).toEqual({ r: 1, g: 2, b: 3, a: 1 });
  });
});

describe("parseColor: rejects", () => {
  it("returns null for a value it does not recognize", () => {
    expect(parseColor("")).toBeNull();
    expect(parseColor("red")).toBeNull();
    expect(parseColor("color(display-p3 1 0 0)")).toBeNull();
    expect(parseColor("hsl(0, 100%, 50%)")).toBeNull();
    expect(parseColor("#12345")).toBeNull();
    expect(parseColor("rgb(1, 2)")).toBeNull();
    expect(parseColor("rgb(1, 2, notanumber)")).toBeNull();
    expect(parseColor("rgba(1, 2, 3, notanumber)")).toBeNull();
  });
});

describe("parseColor: out-of-range clamp", () => {
  it("clamps rgb() channels to 0–255, like the alpha", () => {
    expect(parseColor("rgb(-10, 300, 128)")).toEqual({ r: 0, g: 255, b: 128, a: 1 });
    expect(parseColor("rgba(-1, 256, 128, 1)")).toEqual({ r: 0, g: 255, b: 128, a: 1 });
  });

  it("still clamps alpha to 0–1", () => {
    expect(parseColor("rgba(0, 0, 0, 4)")).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(parseColor("rgba(0, 0, 0, -4)")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it("leaves an already-legal colour untouched", () => {
    expect(parseColor("rgb(0, 128, 255)")).toEqual({ r: 0, g: 128, b: 255, a: 1 });
  });
});

describe("composite", () => {
  it("is a no-op over an opaque top colour", () => {
    const top = { r: 10, g: 20, b: 30, a: 1 };
    const bottom = { r: 200, g: 200, b: 200, a: 1 };
    expect(composite(top, bottom)).toEqual({ r: 10, g: 20, b: 30, a: 1 });
  });

  it("is the bottom colour when the top is fully transparent", () => {
    const top = { r: 10, g: 20, b: 30, a: 0 };
    const bottom = { r: 200, g: 100, b: 50, a: 1 };
    expect(composite(top, bottom)).toEqual({ r: 200, g: 100, b: 50, a: 1 });
  });

  it("blends proportionally to alpha, and always answers opaque", () => {
    const top = { r: 255, g: 0, b: 0, a: 0.5 };
    const bottom = { r: 0, g: 0, b: 0, a: 1 };
    expect(composite(top, bottom)).toEqual({ r: 127.5, g: 0, b: 0, a: 1 });
  });
});

describe("contrastRatio", () => {
  it("is 21:1 for black on white, either direction", () => {
    const black = { r: 0, g: 0, b: 0, a: 1 };
    const white = { r: 255, g: 255, b: 255, a: 1 };
    expect(contrastRatio(black, white)).toBeCloseTo(21, 1);
    expect(contrastRatio(white, black)).toBeCloseTo(21, 1);
  });

  it("is 1:1 for a colour against itself", () => {
    const grey = { r: 128, g: 128, b: 128, a: 1 };
    expect(contrastRatio(grey, grey)).toBeCloseTo(1, 10);
  });

  it("composites a translucent foreground over the background before measuring", () => {
    const halfBlack = { r: 0, g: 0, b: 0, a: 0.5 };
    const white = { r: 255, g: 255, b: 255, a: 1 };
    const direct = contrastRatio(composite(halfBlack, white), white);
    expect(contrastRatio(halfBlack, white)).toBeCloseTo(direct, 10);
    // Strictly between the no-contrast (1:1) and full-black (21:1) extremes.
    expect(contrastRatio(halfBlack, white)).toBeGreaterThan(1);
    expect(contrastRatio(halfBlack, white)).toBeLessThan(21);
  });

  it("composites a translucent background over white, the documented approximation", () => {
    const black = { r: 0, g: 0, b: 0, a: 1 };
    const halfWhite = { r: 255, g: 255, b: 255, a: 0.5 };
    expect(contrastRatio(black, halfWhite)).toBeCloseTo(contrastRatio(black, { r: 255, g: 255, b: 255, a: 1 }), 10);
  });
});

describe("relativeLuminance", () => {
  it("is 0 for black and 1 for white", () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0, a: 1 })).toBe(0);
    expect(relativeLuminance({ r: 255, g: 255, b: 255, a: 1 })).toBeCloseTo(1, 10);
  });

  it("orders greys monotonically", () => {
    const l1 = relativeLuminance({ r: 64, g: 64, b: 64, a: 1 });
    const l2 = relativeLuminance({ r: 128, g: 128, b: 128, a: 1 });
    const l3 = relativeLuminance({ r: 192, g: 192, b: 192, a: 1 });
    expect(l1).toBeLessThan(l2);
    expect(l2).toBeLessThan(l3);
  });
});
