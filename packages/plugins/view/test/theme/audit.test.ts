/**
 * The audit is the repository's own contrast discipline turned into an API, so what matters is
 * that it measures rather than assumes: a pair it cannot parse must be absent from the result, not
 * present and passing, and a translucent value must be measured as it composites.
 */
import { describe, expect, it } from "vitest";
import { composite, contrastRatio, parseColor } from "@stargantt/sdk";
import { auditPalette } from "../../src/internal/theme/audit";
import { CANVAS_READ_TOKENS, NON_COLOR_CANVAS_TOKENS } from "../../src/internal/theme/registry";
import { FORCED_COLOR_TOKENS } from "../../src/internal/theme/forced-colors";

/** A reader over a fixed palette; anything unset reads as the empty string, as `get` does. */
function reader(palette: Record<string, string>): (token: string) => string {
  return (token) => palette[token] ?? "";
}

describe("parseColor", () => {
  it("reads the shapes getComputedStyle and a stylesheet actually produce", () => {
    expect(parseColor("rgb(255, 0, 0)")).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(parseColor("rgba(0, 0, 0, 0.5)")).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
    expect(parseColor("rgb(1 2 3 / 40%)")).toEqual({ r: 1, g: 2, b: 3, a: 0.4 });
    expect(parseColor("#ffffff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("#0f0")).toEqual({ r: 0, g: 255, b: 0, a: 1 });
    expect(parseColor("transparent")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it("returns null for anything it cannot measure, rather than guessing", () => {
    // A system colour is what forced-colors mode resolves tokens to; a named colour and a
    // colour-function are shapes this parser deliberately does not cover.
    expect(parseColor("CanvasText")).toBeNull();
    expect(parseColor("rebeccapurple")).toBeNull();
    expect(parseColor("color(srgb 1 0 0)")).toBeNull();
    expect(parseColor("")).toBeNull();
  });
});

describe("contrastRatio", () => {
  it("agrees with the reference ratios the contract's comments record", () => {
    const white = parseColor("#ffffff")!;
    const black = parseColor("#000000")!;
    expect(contrastRatio(black, white)).toBeCloseTo(21, 5);
    // #0f766e on #ffffff is the default light bar fill against the chart background.
    expect(contrastRatio(parseColor("#0f766e")!, white)).toBeGreaterThan(4.5);
  });

  it("composites a translucent foreground before measuring", () => {
    const white = parseColor("#ffffff")!;
    const halfBlack = parseColor("rgba(0, 0, 0, 0.5)")!;
    // Measured as it paints: 50% black over white is mid-grey, nowhere near black's 21:1.
    expect(contrastRatio(halfBlack, white)).toBeLessThan(21);
    expect(contrastRatio(halfBlack, white)).toBeCloseTo(
      contrastRatio(composite(halfBlack, white), white),
      5,
    );
  });
});

describe("auditPalette", () => {
  const healthy: Record<string, string> = {
    "--sg-bg": "#ffffff",
    "--sg-fg": "#000000",
    "--sg-bar-fill": "#00497e",
    "--sg-row-stripe-bg": "#f7f7f7",
    "--sg-row-hover-bg": "#ededed",
    "--sg-row-selected-bg": "#cfe0f5",
  };

  it("reports a pair it could measure, with the floor it is held to", () => {
    const entries = auditPalette(reader(healthy));
    const fg = entries.find((e) => e.id === "fg/bg");
    expect(fg).toEqual({
      id: "fg/bg",
      kind: "contrast",
      tokens: ["--sg-fg", "--sg-bg"],
      measured: 21,
      min: 4.5,
      ok: true,
    });
  });

  it("omits a pair whose tokens are unset rather than passing it", () => {
    const entries = auditPalette(reader(healthy));
    // Nothing in the palette sets the tooltip pair, so no verdict may be reported for it.
    expect(entries.some((e) => e.id === "tooltip-fg/tooltip-bg")).toBe(false);
  });

  it("fails a pair that does not clear its floor", () => {
    const entries = auditPalette(reader({ ...healthy, "--sg-bar-fill": "#e8f0fa" }));
    const bar = entries.find((e) => e.id === "bar-fill/bg");
    expect(bar?.ok).toBe(false);
    expect(bar?.min).toBe(3);
  });

  it("passes the row-state ordering when each state steps further from the background", () => {
    const order = auditPalette(reader(healthy)).find((e) => e.id === "row-state-order");
    expect(order).toMatchObject({ kind: "order", measured: 0, min: 0, ok: true });
  });

  it("counts a hover fill fainter than the stripe it paints over as a violation", () => {
    const inverted = { ...healthy, "--sg-row-stripe-bg": "#d0d0d0", "--sg-row-hover-bg": "#fafafa" };
    const order = auditPalette(reader(inverted)).find((e) => e.id === "row-state-order");
    expect(order?.measured).toBeGreaterThan(0);
    expect(order?.ok).toBe(false);
  });
});

describe("the canvas-read token registry", () => {
  it("is the forced-colors colours followed by the non-colour tokens, with no duplicates", () => {
    expect(CANVAS_READ_TOKENS).toEqual([
      ...Object.keys(FORCED_COLOR_TOKENS),
      ...NON_COLOR_CANVAS_TOKENS,
    ]);
    expect(new Set(CANVAS_READ_TOKENS).size).toBe(CANVAS_READ_TOKENS.length);
  });

  it("keeps colours and non-colours disjoint — a token is one or the other", () => {
    const colours = new Set(Object.keys(FORCED_COLOR_TOKENS));
    expect(NON_COLOR_CANVAS_TOKENS.filter((t) => colours.has(t))).toEqual([]);
  });
});
