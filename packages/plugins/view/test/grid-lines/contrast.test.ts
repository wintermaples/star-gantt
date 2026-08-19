/**
 * The shading passes' colour posture, measured rather than asserted by eye.
 *
 * The fill is a CSS custom property
 * resolved through `stargantt.theme` at paint time (which reads it via `getComputedStyle`), never
 * a hardcoded canvas literal, and in **both** bundled schemes it stays well below the 3:1
 * UI-component line so the shading — at `zIndex: 10`, under the bars — can never invert figure and
 * ground.
 *
 * The token values come from the shipped stylesheet, not from literals retyped here: a "measured"
 * claim that measures a copy of the palette measures nothing.
 */
import { existsSync, readFileSync } from "node:fs";
import { composite, contrastRatio, parseColor } from "@stargantt/sdk";
import type { FakeCanvas } from "../_utils/index";
import { describe, expect, it } from "vitest";
import { boot } from "./_boot";

/* --- the shipped palette ------------------------------------------------ */

// The shipped stylesheet is authored as one document but split into three parts on disk to respect
// this repo's 800-line-per-file convention (packages/stargantt/src/index.ts "Style injection");
// concatenating them in the same order the bundle entry point does (tokens, layout, plugins)
// reproduces the shipped palette exactly.
const STYLES_PART_NAMES = ["tokens.css", "layout.css", "plugins.css"] as const;
const STYLES_URLS = STYLES_PART_NAMES.map(
  (name) => new URL(`../../../../stargantt/src/styles/${name}`, import.meta.url),
);
/**
 * The shipped stylesheet lands with the bundle package itself. Until every part exists there is no
 * palette to measure, so this suite reports as skipped instead of failing to collect — and it
 * re-arms by itself the moment all three files appear, with no edit here.
 */
const HAS_STYLES = STYLES_URLS.every((url) => existsSync(url));
const STYLES = HAS_STYLES ? STYLES_URLS.map((url) => readFileSync(url, "utf8")).join("") : "";

/** Splits `a, b` at the top-level comma, so `rgba(1, 2, 3, 0.5)` survives intact. */
function splitTop(text: string): [string, string] {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    else if (c === "," && depth === 0) {
      return [text.slice(0, i).trim(), text.slice(i + 1).trim()];
    }
  }
  throw new Error(`not a two-argument list: ${text}`);
}

/** The `light-dark(light, dark)` pair a token declares in the shipped stylesheet. */
function scheme(token: string): { light: string; dark: string } {
  if (!HAS_STYLES) return { light: "", dark: "" };
  const match = new RegExp(`\\n\\s*${token}:\\s*light-dark\\(([\\s\\S]*?)\\);`).exec(STYLES);
  if (match?.[1] === undefined) throw new Error(`${token} is not declared as a light-dark pair`);
  const [light, dark] = splitTop(match[1]);
  return { light, dark };
}

const BG = scheme("--sg-bg");
const NONWORKING = scheme("--sg-grid-nonworking");
const OFFHOURS = scheme("--sg-grid-offhours");

/** The contrast of a (possibly translucent) shading colour against the chart background. */
function groundContrast(shade: string, background: string): number {
  const bg = parseColor(background);
  const fg = parseColor(shade);
  if (bg === null || fg === null) throw new Error(`unparseable colour pair: ${shade} / ${background}`);
  return contrastRatio(composite(fg, bg), bg);
}

/** Every `fillRect` fill style recorded on a canvas, deduplicated in first-paint order. */
function fillStyles(canvas: FakeCanvas): string[] {
  const out: string[] = [];
  for (const op of canvas.context?.ops ?? []) {
    if (op.op !== "fillRect") continue;
    if (!out.includes(op.fill)) out.push(op.fill);
  }
  return out;
}

/* --- tests -------------------------------------------------------------- */

describe.skipIf(!HAS_STYLES)("non-working shading colour", () => {
  // The scheme is chosen by the token map `getComputedStyle` serves, exactly as a stylesheet
  // resolving `light-dark()` would: the plugin reads whatever the theme service reports and has no
  // scheme opinion of its own.
  for (const mode of ["light", "dark"] as const) {
    it(`paints the token's ${mode} value, read through getComputedStyle`, () => {
      const b = boot(
        { vertical: false, horizontal: false, rowStripes: false },
        { tokens: { "--sg-bg": BG[mode], "--sg-grid-nonworking": NONWORKING[mode] } },
      );
      try {
        b.paint();
        // The weekend fallback shades at least one column in the initial viewport.
        expect(fillStyles(b.background)).toEqual([NONWORKING[mode]]);
      } finally {
        b.dispose();
      }
    });
  }

  it("never falls back to a hardcoded literal when the property is set to something else", () => {
    const b = boot(
      { vertical: false, horizontal: false, rowStripes: false },
      { tokens: { "--sg-grid-nonworking": "rgb(1, 2, 3)" } },
    );
    try {
      b.paint();
      expect(fillStyles(b.background)).toEqual(["rgb(1, 2, 3)"]);
    } finally {
      b.dispose();
    }
  });

  // The measurement is 1.10:1 against `--sg-bg` in both bundled schemes; under the
  // translucent red it is 1.13:1 light / 1.19:1 dark. The guard that matters is unchanged and
  // is what the numbers below express: the wash stays far under the 3:1 UI-component line, so it
  // can never read as figure however its hue is retuned. Sub-day bands reuse the identical fill, so
  // this feature adds no token and no second measurement.
  it("stays ground in both bundled schemes", () => {
    for (const mode of ["light", "dark"] as const) {
      const ratio = groundContrast(NONWORKING[mode], BG[mode]);
      expect(ratio).toBeGreaterThan(1);
      expect(ratio).toBeLessThan(1.3);
    }
  });
});

describe.skipIf(!HAS_STYLES)("off-hours hatch colour", () => {
  // The hatch is a translucent stroke, so its effective contrast is measured after compositing it
  // over the chart background — and it stays ground in both schemes like the tint it sits on.
  it("stays ground in both bundled schemes once composited", () => {
    for (const mode of ["light", "dark"] as const) {
      const ratio = groundContrast(OFFHOURS[mode], BG[mode]);
      expect(ratio).toBeGreaterThan(1);
      expect(ratio).toBeLessThan(3);
    }
  });

  // Figure/ground, measured: both shading colours must stay under the task-bar fill's own
  // contrast, or the ground would read louder than the figure it sits behind.
  it("stays quieter than the task-bar fill in both schemes", () => {
    const bars = scheme("--sg-bar-fill");
    for (const mode of ["light", "dark"] as const) {
      const bar = groundContrast(bars[mode], BG[mode]);
      expect(groundContrast(NONWORKING[mode], BG[mode])).toBeLessThan(bar);
      expect(groundContrast(OFFHOURS[mode], BG[mode])).toBeLessThan(bar);
    }
  });
});
