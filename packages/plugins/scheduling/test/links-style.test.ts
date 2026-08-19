/**
 * docs/specs/plugins/scheduling.md §5.3 / §5.5 — stroke precedence, the dual-encoded cues, the
 * 0.35 dim, and the five theme tokens with their pinned fallbacks. Hostless.
 *
 * The `sanitizeLineStyle` / `sanitizeTypeColors` blocks are absent because this package resolves
 * those fields in `config.ts` (covered by `config.test.ts`), so what remains here is the decision
 * half plus the token table.
 */
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config";
import {
  BAND_COLOR,
  DRIVING_COLOR,
  EMPHASIS_COLOR,
  LINK_BAND_TOKEN,
  LINK_COLOR,
  LINK_DRIVING_TOKEN,
  LINK_EMPHASIS_TOKEN,
  LINK_LINE_TOKEN,
  LINK_PORT_TOKEN,
  LINK_WIDTH,
  PORT_COLOR,
  PORT_RING_RADIUS,
  PORT_RING_WIDTH,
} from "../src/internal/links/paint";
import { PORT_RADIUS } from "../src/internal/links/geometry";
import {
  CONFLICT_COLOR,
  CONFLICT_DASH,
  DIM_ALPHA,
  EMPHASIS_EXTRA_WIDTH,
  FULL_ALPHA,
  STRONG_EXTRA_WIDTH,
  linkStroke,
} from "../src/internal/links/style";
import type { ResolvedLineStyle, StrokeInputs } from "../src/internal/links/style";

/** The base style `config.ts` resolves when the host configures nothing. */
const DEFAULT_LINE_STYLE: ResolvedLineStyle = resolveConfig({}).dependencies.linkStyle;

function inputs(over: Partial<StrokeInputs> = {}): StrokeInputs {
  return {
    style: DEFAULT_LINE_STYLE,
    baseColor: "#base",
    typeColor: undefined,
    bandColor: "#band",
    emphasisColor: "#emph",
    drivingColor: "#driv",
    conflictColor: "#conf",
    conflicting: false,
    driving: false,
    emphasized: false,
    selected: false,
    dimmed: false,
    ...over,
  };
}

describe("the resolved default line style (§5.3)", () => {
  it("is a solid 1.5 px stroke with a filled arrowhead", () => {
    expect(DEFAULT_LINE_STYLE).toEqual({ width: 1.5, dash: undefined, arrowHead: "filled" });
    expect(LINK_WIDTH).toBe(1.5);
  });
});

describe("linkStroke precedence (§5.3 / §5.5)", () => {
  it("defaults reproduce the plain look exactly", () => {
    expect(linkStroke(inputs())).toEqual({
      color: "#base",
      width: LINK_WIDTH,
      dash: undefined,
      arrowHead: "filled",
      alpha: FULL_ALPHA,
    });
  });

  it("type color overrides base; conflict overrides type; selected overrides conflict", () => {
    expect(linkStroke(inputs({ typeColor: "#type" })).color).toBe("#type");
    expect(linkStroke(inputs({ typeColor: "#type", conflicting: true })).color).toBe("#conf");
    expect(linkStroke(inputs({ typeColor: "#type", conflicting: true, selected: true })).color).toBe(
      "#band",
    );
  });

  // §5.3 — the whole chain, strongest first:
  // selected > conflicting > emphasized > driving > per-type > `--sg-link-line`.
  it("resolves the full color priority chain, each state beating the one below it", () => {
    const on: Partial<StrokeInputs> = { typeColor: "#type" };
    expect(linkStroke(inputs({ ...on, driving: true })).color).toBe("#driv");
    expect(linkStroke(inputs({ ...on, driving: true, emphasized: true })).color).toBe("#emph");
    expect(
      linkStroke(inputs({ ...on, driving: true, emphasized: true, conflicting: true })).color,
    ).toBe("#conf");
    expect(
      linkStroke(
        inputs({ ...on, driving: true, emphasized: true, conflicting: true, selected: true }),
      ).color,
    ).toBe("#band");
    // Each weaker state alone still shows through.
    expect(linkStroke(inputs({ emphasized: true })).color).toBe("#emph");
    expect(linkStroke(inputs({ driving: true })).color).toBe("#driv");
  });

  it("dims a non-emphasized link at 0.35, never a conflicting one", () => {
    expect(DIM_ALPHA).toBe(0.35);
    expect(linkStroke(inputs({ dimmed: true })).alpha).toBe(DIM_ALPHA);
    expect(linkStroke(inputs({ dimmed: true, conflicting: true })).alpha).toBe(FULL_ALPHA);
    expect(linkStroke(inputs({ dimmed: true, selected: true })).alpha).toBe(DIM_ALPHA);
    expect(linkStroke(inputs({ dimmed: false, emphasized: true })).alpha).toBe(FULL_ALPHA);
    // Dimming changes opacity only — the color chain and the width are untouched by it.
    const plain = linkStroke(inputs({ typeColor: "#type" }));
    const dim = linkStroke(inputs({ typeColor: "#type", dimmed: true }));
    expect({ ...dim, alpha: plain.alpha }).toEqual(plain);
  });

  it("gives emphasis the same 1.5 px the driving cue gets", () => {
    expect(EMPHASIS_EXTRA_WIDTH).toBe(1.5);
    expect(STRONG_EXTRA_WIDTH).toBe(1.5);
  });

  it("a conflicting link is dashed even when the base style is solid", () => {
    expect(linkStroke(inputs({ conflicting: true })).dash).toEqual(CONFLICT_DASH);
    expect(CONFLICT_DASH).toEqual([4, 3]);
  });

  it("a conflicting link's dash overrides a configured one", () => {
    const dashed: ResolvedLineStyle = { ...DEFAULT_LINE_STYLE, dash: [9, 9] };
    expect(linkStroke(inputs({ style: dashed })).dash).toEqual([9, 9]);
    expect(linkStroke(inputs({ style: dashed, conflicting: true })).dash).toEqual(CONFLICT_DASH);
  });

  it("widths add up across emphasis, driving and selection", () => {
    expect(linkStroke(inputs({ emphasized: true })).width).toBe(LINK_WIDTH + EMPHASIS_EXTRA_WIDTH);
    expect(linkStroke(inputs({ driving: true })).width).toBe(LINK_WIDTH + STRONG_EXTRA_WIDTH);
    expect(linkStroke(inputs({ emphasized: true, driving: true, selected: true })).width).toBe(
      LINK_WIDTH + EMPHASIS_EXTRA_WIDTH + STRONG_EXTRA_WIDTH * 2,
    );
  });

  it("carries the arrowhead through unchanged, so the head shares the line's colour", () => {
    const open: ResolvedLineStyle = { ...DEFAULT_LINE_STYLE, arrowHead: "open" };
    expect(linkStroke(inputs({ style: open })).arrowHead).toBe("open");
  });
});

// §5.3 — the five tokens and their fallbacks, plus the design note the fallbacks encode: emphasis
// and driving are deliberately distinct from the band colour, so an emphasized line never reads as
// a selected one; the line and port tokens stay separate even though their fallbacks coincide.
describe("theme tokens and fallbacks (§5.3)", () => {
  it("names the five tokens", () => {
    expect(LINK_LINE_TOKEN).toBe("--sg-link-line");
    expect(LINK_PORT_TOKEN).toBe("--sg-link-port");
    expect(LINK_BAND_TOKEN).toBe("--sg-link-band");
    expect(LINK_EMPHASIS_TOKEN).toBe("--sg-link-emphasis");
    expect(LINK_DRIVING_TOKEN).toBe("--sg-link-driving");
    expect(new Set([LINK_LINE_TOKEN, LINK_PORT_TOKEN])).toHaveProperty("size", 2);
  });

  it("pins each fallback colour", () => {
    expect(LINK_COLOR).toBe("#78716c");
    expect(PORT_COLOR).toBe("#78716c");
    expect(BAND_COLOR).toBe("#0f766e");
    expect(EMPHASIS_COLOR).toBe("#1d4ed8");
    expect(DRIVING_COLOR).toBe("#44403c");
    expect(CONFLICT_COLOR).toBe("#dc2626");
  });

  it("keeps the emphasis and driving fallbacks distinct from the band colour", () => {
    expect(EMPHASIS_COLOR).not.toBe(BAND_COLOR);
    expect(DRIVING_COLOR).not.toBe(BAND_COLOR);
    expect(EMPHASIS_COLOR).not.toBe(DRIVING_COLOR);
  });

  it("uses the configured conflict colour by default", () => {
    expect(resolveConfig({}).dependencies.conflictColor).toBe(CONFLICT_COLOR);
  });

  it("rings the drop candidate outside the disc, as a shape change and not only a colour one", () => {
    expect(PORT_RING_RADIUS).toBe(PORT_RADIUS + 3);
    expect(PORT_RING_WIDTH).toBe(2);
  });
});
