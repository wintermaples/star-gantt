/**
 * Header geometry and the header label font.
 *
 * All three defaults reproduce the previous output byte-for-byte: an even 50/50 row split, 4 px of
 * label padding, and the `10px sans-serif` the canvas was already using implicitly.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { TimelineConfig } from "../../src/config";
import {
  DEFAULT_HEADER_HEIGHT,
  FALLBACK_FONT,
  normalizeLabelPadding,
  normalizeRowRatio,
} from "../../src/internal/timeline/header";
import { boot } from "./_boot";
import type { Booted } from "./_boot";

let booted: Booted | null = null;

afterEach(() => {
  booted?.dom.restore();
  booted = null;
});

/**
 * Boots, paints one frame and hands back the header context.
 *
 * `tokens` are the CSS custom properties `stargantt.theme` will read; they go through the shared
 * harness (which owns `globalThis.getComputedStyle`) rather than a hand-rolled stub, which the
 * harness install would overwrite. Absent names read as the empty string.
 */
function painted(
  config: TimelineConfig = {},
  tokens: Record<string, string> = {},
): Booted {
  const b = boot([], { tokens }, { origin: 0, ...config });
  booted = b;
  b.dom.flushFrames();
  return b;
}

/** The y coordinates of the painted labels, deduplicated and ascending — one per header row. */
function labelYs(b: Booted): number[] {
  return [...new Set(b.header.context.texts.map((t) => t.y))].sort((a, c) => a - c);
}

describe("headerRowRatio", () => {
  it("splits the header height evenly by default", () => {
    const half = DEFAULT_HEADER_HEIGHT / 2;
    expect(labelYs(painted())).toEqual([half / 2, half + half / 2]);
  });

  it("gives the top row the configured share", () => {
    // 44 px total: a quarter is 11 px on top and 33 px below, so the label baselines are the
    // midpoints 5.5 and 27.5.
    expect(labelYs(painted({ headerRowRatio: 0.25 }))).toEqual([5.5, 27.5]);
  });

  it("draws the row separator at the same split", () => {
    const b = painted({ headerRowRatio: 0.25 });
    const horizontals = b.header.context
      .lines()
      .filter((l) => l.y1 === l.y2)
      .map((l) => l.y1);
    expect(horizontals).toContain(11);
    expect(horizontals).toContain(DEFAULT_HEADER_HEIGHT);
  });

  // the coarse tier's cell separators keep the
  // figure-weight tick colour; the fine tier's day ticks drop to the body grid's coarse weight,
  // because ruling every day column at figure weight is what turned the header into a mesh. The
  // row rule under each tier stays figure: it is the band's own structural edge.
  it("paints the fine tier's cell separators lighter than the coarse tier's", () => {
    const b = painted({}, { "--sg-header-tick": "#111111", "--sg-grid-line-major": "#eeeeee" });
    const verticals = b.header.context.lines().filter((l) => l.x1 === l.x2);
    const horizontals = b.header.context.lines().filter((l) => l.y1 === l.y2);

    // The coarse row occupies the top half of the 44px band, the fine row the bottom half.
    const coarse = verticals.filter((l) => l.y2 <= DEFAULT_HEADER_HEIGHT / 2);
    const fine = verticals.filter((l) => l.y1 >= DEFAULT_HEADER_HEIGHT / 2);
    expect(fine.length).toBeGreaterThan(0);
    expect(new Set(fine.map((l) => l.stroke))).toEqual(new Set(["#eeeeee"]));
    if (coarse.length > 0) expect(new Set(coarse.map((l) => l.stroke))).toEqual(new Set(["#111111"]));
    expect(new Set(horizontals.map((l) => l.stroke))).toEqual(new Set(["#111111"]));
  });

  it("ignores an unusable ratio", () => {
    const even = [DEFAULT_HEADER_HEIGHT / 4, (DEFAULT_HEADER_HEIGHT * 3) / 4];
    for (const bad of [0, 1, -0.5, 2, Number.NaN]) {
      const b = painted({ headerRowRatio: bad });
      expect(labelYs(b)).toEqual(even);
      b.dom.restore();
      booted = null;
    }
  });

  it("normalizes to the even split for anything outside the open range", () => {
    expect(normalizeRowRatio(0.25)).toBe(0.25);
    for (const bad of [0, 1, -1, 1.5, Number.NaN, "0.5", null, undefined]) {
      expect(normalizeRowRatio(bad)).toBe(0.5);
    }
  });
});

describe("headerLabelPadding", () => {
  /** x offsets of the labels relative to their boundary's vertical rule. */
  function firstLabelX(b: Booted): number {
    const x = b.header.context.texts[0]?.x;
    if (x === undefined) throw new Error("no label was painted");
    return x;
  }

  it("insets labels by 4 px by default", () => {
    // `origin: 0` puts the first boundary's rule at x = 0, so the label x *is* the padding.
    expect(firstLabelX(painted())).toBe(4);
  });

  it("applies the configured padding", () => {
    expect(firstLabelX(painted({ headerLabelPadding: 12 }))).toBe(12);
  });

  it("accepts zero", () => {
    expect(firstLabelX(painted({ headerLabelPadding: 0 }))).toBe(0);
  });

  it("ignores an unusable padding", () => {
    expect(firstLabelX(painted({ headerLabelPadding: -3 }))).toBe(4);
  });

  it("normalizes to 4 for anything that is not a finite number of at least zero", () => {
    expect(normalizeLabelPadding(0)).toBe(0);
    expect(normalizeLabelPadding(12.5)).toBe(12.5);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, "4", null, undefined]) {
      expect(normalizeLabelPadding(bad)).toBe(4);
    }
  });
});

describe("header font", () => {
  /** The fonts the header's labels were actually painted in, coarse tier first. */
  function paintedFonts(b: ReturnType<typeof painted>): string[] {
    return b.header.context.texts.map((t) => t.font);
  }

  it("paints in the built-in default when the token is unset", () => {
    expect(new Set(paintedFonts(painted()))).toEqual(new Set([FALLBACK_FONT]));
    expect(FALLBACK_FONT).toBe("12px system-ui, sans-serif");
  });

  it("paints in the `--sg-header-font` token when the host sets one", () => {
    const fonts = new Set(paintedFonts(painted({}, { "--sg-header-font": "bold 14px Inter" })));
    expect(fonts).toEqual(new Set(["bold 14px Inter"]));
  });

  // The coarse tier takes its own token, and falls back to the fine tier's font — so a
  // host that overrides only `--sg-header-font` still gets one consistent header.
  it("paints the coarse tier in `--sg-header-major-font` when the host sets one", () => {
    const b = painted(
      {},
      { "--sg-header-font": "12px serif", "--sg-header-major-font": "600 12px serif" },
    );
    const fonts = paintedFonts(b);
    // The default two-row levels label the coarse row first, then the fine row.
    expect(fonts[0]).toBe("600 12px serif");
    expect(fonts.at(-1)).toBe("12px serif");
  });

  it("keeps reading the header height from its own token", () => {
    const b = painted({}, { "--sg-header-height": "60px", "--sg-header-font": "12px serif" });
    expect(b.header.height).toBe(60);
    expect(paintedFonts(b).at(-1)).toBe("12px serif");
  });
});

describe("the geometry options are read once at setup", () => {
  it("ignores a mutation of the config object made after startup", () => {
    const config: TimelineConfig = { origin: 0, headerLabelPadding: 12 };
    const b = boot([], {}, config);
    booted = b;
    config.headerLabelPadding = 30;
    b.dom.flushFrames();
    expect(b.header.context.texts[0]?.x).toBe(12);
  });
});
