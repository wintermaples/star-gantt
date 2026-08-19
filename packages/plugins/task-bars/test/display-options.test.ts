/**
 * The display extensions of `TaskBarsConfig`, exercised hostlessly against the internal modules:
 * option normalization, the built-in label texts, the backdrop, the same-side label layout, the
 * milestone shapes / radius / patterns, the expanded hit zone, and the bar-end adornments.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@stargantt/plugin-data-store";
import {
  builtinPatternFor,
  resolveBevel,
  resolvePattern,
  resolveRadius,
  resolveShape,
  resolveStroke,
} from "../src/internal/decor";
import { MIN_HIT_SIZE, withinExpanded } from "../src/internal/geometry";
import { createLabelFeature, durationText, progressText } from "../src/internal/labels";
import type { PlacedLabel } from "../src/internal/labels";
import { asBackdrop, asHostLabel, latched, resolveBarOptions } from "../src/internal/options";
import type { BuiltinLabel } from "../src/internal/options";
import { INSIDE_LABEL_COLOR, paintBar } from "../src/internal/paint";
import {
  AVATAR_MIN_FONT_SCALE,
  LABEL_BACKDROP_COLOR,
  LABEL_BACKDROP_PADDING,
  LABEL_BACKDROP_RADIUS,
  LABEL_BACKDROP_TOKEN,
  LABEL_GAP,
  LABEL_GUTTER_MARGIN,
  drawAvatar,
  drawBarIcons,
  drawPlacedLabels,
  fitAvatarText,
  labelOffset,
  scaleFontSize,
} from "../src/internal/paint-text";
import { FakeContext2D, asContext } from "./_utils/canvas";
import { themeOf } from "./_fakes";

const MS_DAY = 86_400_000;
const BOX = { x: 100, y: 10, width: 80, height: 20 };

function task(over: Partial<Task> = {}): Task {
  return { id: "t", parentId: null, name: "t", start: 0, end: MS_DAY, ...over };
}

/**
 * Adapter for the raw option shape: `label` is resolved by `./options` into a
 * `{ provider, placement }` pair before the feature sees it, so these tests pass the raw option and
 * this puts it through the same normalisation `setup()` uses.
 */
function makeLabels(
  option: unknown,
  theme: Parameters<typeof createLabelFeature>[0],
  onFault: Parameters<typeof createLabelFeature>[1],
  extra: { duration?: BuiltinLabel; progress?: BuiltinLabel } = {},
): ReturnType<typeof createLabelFeature> {
  return createLabelFeature(theme, onFault, {
    host: asHostLabel(option),
    duration: extra.duration ?? { enabled: false, placement: undefined },
    progress: extra.progress ?? { enabled: false, placement: undefined },
    // The library default: `resolveBarOptions({})` resolves the backdrop on.
    backdrop: { color: undefined, padding: undefined, radius: undefined },
  });
}

let g: FakeContext2D;
beforeEach(() => {
  g = new FakeContext2D();
});

describe("resolveBarOptions (unusable values are silently ignored)", () => {
  it("defaults every feature off", () => {
    const o = resolveBarOptions({});
    expect(o.label).toEqual({ provider: undefined, placement: "right" });
    expect(o.durationLabel.enabled).toBe(false);
    expect(o.progressLabel.enabled).toBe(false);
    expect(o.renderBar).toBeUndefined();
    expect(o.milestoneShape).toBeUndefined();
    expect(o.patternFill).toBeUndefined();
    expect(o.barRadius).toBeUndefined();
    expect(o.collapsedSummary).toBe("range");
    expect(o.expandedHitArea).toBe(false);
  });

  it("ignores unusable values", () => {
    const o = resolveBarOptions({
      label: "not a function",
      durationLabel: "yes",
      renderBar: 42,
      milestoneShape: "blob",
      patternFill: "diagonal",
      barRadius: -3,
      collapsedSummary: "maybe",
      expandedHitArea: "true",
    });
    expect(o).toEqual(resolveBarOptions({}));
  });

  it("accepts the documented forms", () => {
    const o = resolveBarOptions({
      durationLabel: true,
      progressLabel: { placement: "left" },
      milestoneShape: "star",
      patternFill: true,
      barRadius: 4,
      collapsedSummary: "split",
      expandedHitArea: true,
    });
    expect(o.durationLabel).toEqual({ enabled: true, placement: undefined });
    expect(o.progressLabel).toEqual({ enabled: true, placement: "left" });
    expect(o.milestoneShape).toBe("star");
    expect(o.patternFill).toBe("builtin");
    expect(o.barRadius).toBe(4);
    expect(o.collapsedSummary).toBe("split");
    expect(o.expandedHitArea).toBe(true);
  });

  // 0 is an explicit "square corners" that wins over the --sg-bar-radius token; only an absent or
  // unusable value falls through to it.
  it("keeps an explicit zero radius instead of falling through to the token", () => {
    expect(resolveBarOptions({ barRadius: 0 }).barRadius).toBe(0);
  });

  it("still ignores a negative or non-finite radius", () => {
    expect(resolveBarOptions({ barRadius: -4 }).barRadius).toBeUndefined();
    expect(resolveBarOptions({ barRadius: Number.NaN }).barRadius).toBeUndefined();
    expect(resolveBarOptions({ barRadius: "8" }).barRadius).toBeUndefined();
  });

  it("keeps the per-task provider forms as functions", () => {
    const shape = (): "star" => "star";
    const pattern = (): "dots" => "dots";
    const o = resolveBarOptions({ milestoneShape: shape, patternFill: pattern });
    expect(o.milestoneShape).toBe(shape);
    expect(o.patternFill).toBe(pattern);
  });
});

describe("latched barrier", () => {
  it("reports the first throw once and declines afterwards", () => {
    const fault = vi.fn();
    const fn = latched(() => {
      throw new Error("boom");
    }, fault);
    expect(fn()).toBeUndefined();
    expect(fn()).toBeUndefined();
    expect(fault).toHaveBeenCalledTimes(1);
  });
});

describe("built-in label texts", () => {
  it("rounds the duration to whole days with a floor of one", () => {
    expect(durationText(task())).toBe("1d");
    expect(durationText(task({ end: 3 * MS_DAY }))).toBe("3d");
    expect(durationText(task({ end: 1000 }))).toBe("1d");
    expect(durationText(task({ type: "milestone" }))).toBeUndefined();
  });

  it("rounds progress to whole percent, clamped", () => {
    expect(progressText(task({ progress: 0.404 }))).toBe("40%");
    expect(progressText(task())).toBe("0%");
    expect(progressText(task({ progress: 7 }))).toBe("100%");
    expect(progressText(task({ type: "summary" }))).toBeUndefined();
    expect(progressText(task({ type: "milestone" }))).toBeUndefined();
  });
});

describe("label collection and placement", () => {
  const out: PlacedLabel[] = [];

  it("collects host, duration and progress labels in order with their placements", () => {
    const labels = makeLabels({ text: (t: Task) => t.name, placement: "left" }, themeOf(), () => {}, {
      duration: { enabled: true, placement: undefined },
      progress: { enabled: true, placement: undefined },
    });
    expect(labels.collect(task({ progress: 0.5 }), out)).toEqual([
      { text: "t", placement: "left" },
      { text: "1d", placement: "right" },
      { text: "50%", placement: "inside" },
    ]);
  });

  // Placement is a chart-wide choice made in the option's object form. There is no per-task channel:
  // a provider returning an object returns a non-string, which draws nothing.
  it("takes the placement from the option's object form, for every task", () => {
    const labels = makeLabels({ text: () => "x", placement: "inside" }, themeOf(), () => {});
    expect(labels.collect(task(), out)).toEqual([{ text: "x", placement: "inside" }]);
    expect(labels.textOf(task())).toBe("x");
  });

  it("draws nothing for a provider that returns a { text, placement } object", () => {
    const labels = makeLabels(() => ({ text: "x", placement: "inside" }), themeOf(), () => {});
    expect(labels.collect(task(), out)).toEqual([]);
  });

  it("is enabled by a built-in label alone", () => {
    const labels = makeLabels(undefined, themeOf(), () => {}, {
      duration: { enabled: true, placement: undefined },
      progress: { enabled: false, placement: undefined },
    });
    expect(labels.enabled()).toBe(true);
    expect(labels.collect(task({ end: 2 * MS_DAY }), out)).toEqual([
      { text: "2d", placement: "right" },
    ]);
  });
});

// The halo behind an outside label. On by default, and only ever behind a label placed outside its
// bar.
describe("labelBackdrop", () => {
  it("is on by default and off only for false", () => {
    expect(resolveBarOptions({}).labelBackdrop).toEqual({
      color: undefined,
      padding: undefined,
      radius: undefined,
    });
    expect(resolveBarOptions({ labelBackdrop: false }).labelBackdrop).toBeUndefined();
    expect(resolveBarOptions({ labelBackdrop: true }).labelBackdrop).toEqual({
      color: undefined,
      padding: undefined,
      radius: undefined,
    });
  });

  it("takes the object form's fields and ignores unusable ones", () => {
    expect(asBackdrop({ color: "#123", padding: 6, radius: 0 })).toEqual({
      color: "#123",
      padding: 6,
      radius: 0,
    });
    expect(asBackdrop({ color: "", padding: -1, radius: Number.NaN })).toEqual({
      color: undefined,
      padding: undefined,
      radius: undefined,
    });
  });

  it("resolves the fill from the theme token, and the option's colour over it", () => {
    const themed = makeLabels(() => "x", themeOf({ [LABEL_BACKDROP_TOKEN]: "#abc" }), () => {});
    expect(themed.backdrop()).toEqual({
      color: "#abc",
      padding: LABEL_BACKDROP_PADDING,
      radius: LABEL_BACKDROP_RADIUS,
    });
    const bare = makeLabels(() => "x", themeOf(), () => {});
    expect(bare.backdrop()?.color).toBe(LABEL_BACKDROP_COLOR);
  });

  it("paints a rounded fill behind an outside label and none behind an inside one", () => {
    const backdrop = { color: "#fff", padding: 2, radius: 3 };
    drawPlacedLabels(
      asContext(g),
      BOX,
      [{ text: "hi", placement: "right", color: "#111" }],
      "10px sans-serif",
      backdrop,
    );
    const filled = g.calls("fill");
    expect(filled).toHaveLength(1);
    expect(filled[0]?.fill).toBe("#fff");

    g = new FakeContext2D();
    drawPlacedLabels(
      asContext(g),
      BOX,
      [{ text: "hi", placement: "inside", color: "#111" }],
      "10px sans-serif",
      backdrop,
    );
    expect(g.calls("fill")).toHaveLength(0);
  });

  it("paints nothing extra when the option is off", () => {
    drawPlacedLabels(
      asContext(g),
      BOX,
      [{ text: "hi", placement: "right", color: "#111" }],
      "10px sans-serif",
      undefined,
    );
    expect(g.calls("fill")).toHaveLength(0);
    expect(g.calls("fillRect")).toHaveLength(0);
  });
});

describe("drawPlacedLabels", () => {
  const one = (text: string, placement: "left" | "right" | "inside", color = "#111") => [
    { text, placement, color },
  ];

  it("draws right-placement text at the historical offset", () => {
    drawPlacedLabels(asContext(g), BOX, one("hi", "right"), "10px sans-serif");
    expect(g.calls("fillText")[0]?.args).toEqual([BOX.x + BOX.width + LABEL_GAP, 20]);
  });

  it("draws left-placement text right-aligned before the bar", () => {
    drawPlacedLabels(asContext(g), BOX, one("hi", "left"), "10px sans-serif");
    expect(g.calls("fillText")[0]?.args).toEqual([BOX.x - LABEL_GAP, 20]);
  });

  // The offset clears the end's reserved gutter by LABEL_GUTTER_MARGIN, with the historical
  // LABEL_GAP as its floor, so a chart whose gutter is 17 px or less (the connector-port clearance,
  // and the gutter-free 0) labels exactly where it always did.
  it("keeps the historical offset while the reserved gutter fits inside it", () => {
    for (const gutterEnd of [0, 9, 17]) {
      g = new FakeContext2D();
      drawPlacedLabels(asContext(g), { ...BOX, gutterEnd }, one("hi", "right"), "10px sans-serif");
      expect(g.calls("fillText")[0]?.args).toEqual([BOX.x + BOX.width + LABEL_GAP, 20]);
    }
    expect(labelOffset(17)).toBe(LABEL_GAP);
  });

  it("pushes each side's first label past a gutter wider than that floor", () => {
    drawPlacedLabels(
      asContext(g),
      { ...BOX, gutterStart: 30, gutterEnd: 40 },
      [
        { text: "hi", placement: "right", color: "#111" },
        { text: "ho", placement: "left", color: "#111" },
      ],
      "10px sans-serif",
    );
    expect(g.texts.map((t) => t.x)).toEqual([
      BOX.x + BOX.width + 40 + LABEL_GUTTER_MARGIN,
      BOX.x - (30 + LABEL_GUTTER_MARGIN),
    ]);
  });

  it("clips inside-placement text to the bar box, centred as one label", () => {
    // Centred means the run's own midpoint sits on the box's: a single label starts half its own
    // measured width to the left of centre, which is where a centre-aligned draw put it.
    drawPlacedLabels(asContext(g), BOX, one("hi", "inside", "#fff"), "10px sans-serif");
    expect(g.calls("clip")).toHaveLength(1);
    const width = asContext(g).measureText("hi").width;
    expect(g.calls("fillText")[0]?.args).toEqual([BOX.x + BOX.width / 2 - width / 2, 20]);
  });

  // The three label sources can name one side, and the side is one anchor, so drawing them
  // independently printed them on top of each other.
  it("lays labels that share a side along it instead of stacking them", () => {
    const width = asContext(g).measureText("ab").width;
    drawPlacedLabels(
      asContext(g),
      BOX,
      [
        { text: "ab", placement: "right", color: "#111" },
        { text: "cd", placement: "right", color: "#222" },
      ],
      "10px sans-serif",
    );
    expect(g.texts.map((t) => t.x)).toEqual([
      BOX.x + BOX.width + LABEL_GAP,
      BOX.x + BOX.width + LABEL_GAP + width + LABEL_GAP,
    ]);
  });

  it("runs a shared left side outward from the bar's left edge", () => {
    const width = asContext(g).measureText("ab").width;
    drawPlacedLabels(
      asContext(g),
      BOX,
      [
        { text: "ab", placement: "left", color: "#111" },
        { text: "cd", placement: "left", color: "#222" },
      ],
      "10px sans-serif",
    );
    expect(g.texts.map((t) => t.x)).toEqual([
      BOX.x - LABEL_GAP,
      BOX.x - LABEL_GAP - width - LABEL_GAP,
    ]);
    expect(g.texts.map((t) => t.align)).toEqual(["right", "right"]);
  });

  it("centres a shared inside run as a whole and clips it once", () => {
    const width = asContext(g).measureText("ab").width;
    drawPlacedLabels(
      asContext(g),
      BOX,
      [
        { text: "ab", placement: "inside", color: "#111" },
        { text: "cd", placement: "inside", color: "#222" },
      ],
      "10px sans-serif",
    );
    const total = width * 2 + LABEL_GAP;
    expect(g.calls("clip")).toHaveLength(1);
    expect(g.texts.map((t) => t.x)).toEqual([
      BOX.x + BOX.width / 2 - total / 2,
      BOX.x + BOX.width / 2 - total / 2 + width + LABEL_GAP,
    ]);
  });

  it("keeps an outside label out of the inside run's clip whatever the order", () => {
    drawPlacedLabels(
      asContext(g),
      BOX,
      [
        { text: "in", placement: "inside", color: "#111" },
        { text: "out", placement: "right", color: "#222" },
      ],
      "10px sans-serif",
    );
    // The outside label is drawn first, so no `clip` precedes its `fillText`.
    const ops = g.ops.map((o) => o.op).filter((op) => op === "clip" || op === "fillText");
    expect(ops).toEqual(["fillText", "clip", "fillText"]);
    expect(g.texts.map((t) => t.text)).toEqual(["out", "in"]);
  });

  it("gives each label of a group its own colour", () => {
    drawPlacedLabels(
      asContext(g),
      BOX,
      [
        { text: "a", placement: "right", color: "#010203" },
        { text: "b", placement: "inside", color: "#040506" },
      ],
      "10px sans-serif",
    );
    expect(g.texts.map((t) => t.fill)).toEqual(["#010203", "#040506"]);
  });
});

describe("milestone shapes, radius and patterns", () => {
  const square = { x: 0, y: 0, width: 20, height: 20 };

  it("keeps the default paint free of paths for an ordinary bar", () => {
    paintBar(asContext(g), BOX, task(), "#123");
    expect(g.calls("arc")).toHaveLength(0);
    expect(g.calls("clip")).toHaveLength(0);
    expect(g.calls("fillRect")).toHaveLength(1);
  });

  // The progress fill traces its own rounded path rather than clipping to the bar's: `clip()` is one
  // of the members a vector export's recording proxy cannot transcribe, so clipping here would drop
  // the whole bar layer to a raster image in every vector export.
  it("paints a rounded bar and a rounded progress fill without clipping", () => {
    paintBar(asContext(g), BOX, task({ progress: 0.5 }), "#123", undefined, { radius: 4 });
    // Four arcs for the track's corners; two more for the fill's leading pair, since at 50% its
    // trailing edge is the progress boundary rather than the bar's own curve.
    expect(g.calls("arc")).toHaveLength(6);
    expect(g.calls("clip")).toHaveLength(0);
  });

  it("rounds the progress fill's trailing corners once it reaches the bar's own curve", () => {
    paintBar(asContext(g), BOX, task({ progress: 1 }), "#123", undefined, { radius: 4 });
    // A complete bar skips the track entirely and paints one fully rounded body.
    expect(g.calls("arc")).toHaveLength(4);
    expect(g.calls("clip")).toHaveLength(0);
  });

  it("chooses the milestone path by shape", () => {
    paintBar(asContext(g), square, task({ type: "milestone" }), "#123", undefined, {
      milestoneShape: "star",
    });
    // A five-point star traces ten vertices.
    expect(g.calls("lineTo").length).toBeGreaterThanOrEqual(9);
    g.reset();
    paintBar(asContext(g), square, task({ type: "milestone" }), "#123", undefined, {
      milestoneShape: "square",
    });
    expect(g.calls("rect")).toHaveLength(1);
  });

  it("strokes a clipped pattern over an ordinary bar", () => {
    paintBar(asContext(g), BOX, task(), "#123", undefined, { pattern: "diagonal" });
    expect(g.calls("clip")).toHaveLength(1);
    expect(g.calls("stroke")).toHaveLength(1);
  });

  it("maps the built-in pattern per type and lets a provider override it", () => {
    expect(builtinPatternFor(task())).toBe("diagonal");
    expect(builtinPatternFor(task({ type: "summary" }))).toBe("cross");
    expect(builtinPatternFor(task({ type: "milestone" }))).toBe("none");
    const opts = { patternFill: "builtin" as const };
    expect(resolvePattern(opts, () => "dots", task())).toBe("dots");
    expect(resolvePattern(opts, () => undefined, task())).toBe("diagonal");
    expect(resolvePattern({ patternFill: undefined }, undefined, task())).toBe("none");
  });

  it("prefers the config radius over the token, and the token over square corners", () => {
    expect(resolveRadius({ barRadius: 5 }, themeOf({ "--sg-bar-radius": "3px" }))).toBe(5);
    expect(resolveRadius({ barRadius: undefined }, themeOf({ "--sg-bar-radius": "3px" }))).toBe(3);
    expect(resolveRadius({ barRadius: undefined }, themeOf({ "--sg-bar-radius": "junk" }))).toBe(0);
    expect(resolveRadius({ barRadius: undefined }, themeOf())).toBe(0);
  });

  it("paints square corners for an explicit zero even when the token asks for rounding", () => {
    expect(resolveRadius({ barRadius: 0 }, themeOf({ "--sg-bar-radius": "6px" }))).toBe(0);
  });

  // Both decorations are theme-only and both must read as "off" for anything the theme cannot make
  // sense of, since the values arrive from host CSS.
  it("resolves the bar outline, treating an unusable width or colour as no outline", () => {
    expect(
      resolveStroke(themeOf({ "--sg-bar-stroke": "#1f3f63", "--sg-bar-stroke-width": "1px" })),
    ).toEqual({ color: "#1f3f63", width: 1 });
    // The token's own default paints nothing, so it must not cost a stroke call per bar.
    expect(
      resolveStroke(themeOf({ "--sg-bar-stroke": "transparent", "--sg-bar-stroke-width": "1px" })),
    ).toEqual({ color: "", width: 0 });
    expect(
      resolveStroke(themeOf({ "--sg-bar-stroke": "#000", "--sg-bar-stroke-width": "0px" })),
    ).toEqual({ color: "", width: 0 });
    expect(
      resolveStroke(themeOf({ "--sg-bar-stroke": "#000", "--sg-bar-stroke-width": "junk" })),
    ).toEqual({ color: "", width: 0 });
    expect(resolveStroke(themeOf())).toEqual({ color: "", width: 0 });
  });

  it("resolves the bevel strength, clamped to 0…1", () => {
    expect(resolveBevel(themeOf({ "--sg-bar-fill-bevel": "0.18" }))).toBe(0.18);
    expect(resolveBevel(themeOf({ "--sg-bar-fill-bevel": "4" }))).toBe(1);
    expect(resolveBevel(themeOf({ "--sg-bar-fill-bevel": "0" }))).toBe(0);
    expect(resolveBevel(themeOf({ "--sg-bar-fill-bevel": "-1" }))).toBe(0);
    expect(resolveBevel(themeOf({ "--sg-bar-fill-bevel": "junk" }))).toBe(0);
    expect(resolveBevel(themeOf())).toBe(0);
  });

  it("resolves the milestone shape from provider, then fixed config, then diamond", () => {
    expect(resolveShape({ milestoneShape: "square" }, () => "triangle", task())).toBe("triangle");
    expect(resolveShape({ milestoneShape: "square" }, () => undefined, task())).toBe("square");
    expect(resolveShape({ milestoneShape: undefined }, undefined, task())).toBe("diamond");
  });
});

describe("expanded hit zones", () => {
  it("widens a thin box to the minimum target size around its centre", () => {
    const thin = { x: 100, y: 10, width: 2, height: 20 };
    expect(withinExpanded(thin, 100 + 1 + MIN_HIT_SIZE / 2 - 1, 20)).toBe(true);
    expect(withinExpanded(thin, 100 + 1 + MIN_HIT_SIZE / 2 + 1, 20)).toBe(false);
    expect(withinExpanded(thin, 101, 10 - 1)).toBe(true);
  });

  it("leaves an already-large box unchanged", () => {
    expect(withinExpanded(BOX, BOX.x - 1, 20)).toBe(false);
    expect(withinExpanded(BOX, BOX.x + 1, 20)).toBe(true);
  });
});

describe("icons and avatars", () => {
  it("draws end icons centred inside the two ends", () => {
    drawBarIcons(asContext(g), BOX, "!", "?", "#fff", "10px sans-serif");
    const texts = g.calls("fillText");
    expect(texts).toHaveLength(2);
    expect(texts[0]?.args).toEqual([BOX.x + 10, 20]);
    expect(texts[1]?.args).toEqual([BOX.x + BOX.width - 10, 20]);
  });

  it("skips icons on a bar too narrow to carry them", () => {
    drawBarIcons(asContext(g), { ...BOX, width: 30 }, "!", "?", "#fff", "10px sans-serif");
    expect(g.calls("fillText")).toHaveLength(0);
  });

  it("draws the avatar circle at the bar's right end with initials", () => {
    drawAvatar(asContext(g), BOX, { initials: "AB", color: "#800" }, "", "10px sans-serif");
    expect(g.calls("arc")).toHaveLength(1);
    expect(g.calls("arc")[0]?.args?.slice(0, 3)).toEqual([BOX.x + BOX.width - 10, 20, 9]);
    const text = g.calls("fillText")[0];
    expect(text?.fill).toBe(INSIDE_LABEL_COLOR);
  });

  // Initials follow the theme's `--sg-bar-inside-label-fg`, like icons do; white is only the
  // missing-token fallback.
  it("draws the avatar initials in the theme's inside-label foreground", () => {
    drawAvatar(asContext(g), BOX, { initials: "AB", color: "#800" }, "#14181d", "10px sans-serif");
    const text = g.calls("fillText")[0];
    expect(text?.fill).toBe("#14181d");
  });

  it("shrinks long initials rather than painting them past the badge", () => {
    drawAvatar(asContext(g), BOX, { initials: "ABC" }, "#fff", "10px sans-serif");
    expect(g.texts[0]?.text).toBe("ABC");
    expect(g.texts[0]?.font).toBe("8px sans-serif");
  });

  it("truncates initials that cannot be shrunk enough", () => {
    drawAvatar(asContext(g), BOX, { initials: "ABCDE" }, "#fff", "10px sans-serif");
    expect(g.texts[0]?.text).toBe("ABCD");
    expect(g.texts[0]?.font).toBe("6px sans-serif");
  });

  it("paints the circle but no text when the badge is too small for one cluster", () => {
    drawAvatar(asContext(g), { ...BOX, height: 4 }, { initials: "A" }, "#fff", "10px sans-serif");
    expect(g.calls("arc")).toHaveLength(1);
    expect(g.calls("fillText")).toHaveLength(0);
  });
});

// The badge is a fixed-size circle, so the initials are fitted to it: shrink first, then drop
// trailing grapheme clusters, and paint no text at all when even one cluster cannot fit.
describe("avatar text fitting", () => {
  // The recording context measures 6 CSS px per character, so widths below are `length * 6`.
  const measure = (s: string): number => s.length * 6;

  it("leaves text that already fits alone", () => {
    expect(fitAvatarText(measure, "AB", 14.4)).toEqual({ text: "AB", scale: 1 });
  });

  it("shrinks the font until the text fits", () => {
    // "ABC" is 18 wide against 14.4 usable — 0.8 of full size, above the floor.
    expect(fitAvatarText(measure, "ABC", 14.4)).toEqual({ text: "ABC", scale: 0.8 });
  });

  it("drops trailing grapheme clusters once the font hits its floor", () => {
    // "ABCDE" is 30 wide; 0.6 of that is 18, still over 14.4, so clusters go until 14.4 fits.
    expect(fitAvatarText(measure, "ABCDE", 14.4)).toEqual({
      text: "ABCD",
      scale: AVATAR_MIN_FONT_SCALE,
    });
  });

  it("keeps a multi-code-point grapheme whole", () => {
    // One family emoji is one cluster: it either fits or the badge carries no text.
    expect(fitAvatarText(measure, "👩‍👩‍👧", 4)).toBeUndefined();
  });

  it("declines when a single cluster cannot fit", () => {
    expect(fitAvatarText(measure, "A", 1.6)).toBeUndefined();
  });

  it("scales only the px size of a font shorthand", () => {
    expect(scaleFontSize("12px system-ui, sans-serif", 0.5)).toBe("6px system-ui, sans-serif");
    expect(scaleFontSize("12px system-ui, sans-serif", 1)).toBe("12px system-ui, sans-serif");
  });
});
