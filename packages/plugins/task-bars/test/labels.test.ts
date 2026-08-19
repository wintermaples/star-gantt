/**
 * `src/internal/labels.ts` — the `TaskBarsConfig.label` feature, without a host: off unless a
 * function was supplied, one token read per pass, and a latched fault barrier that cannot be
 * cleared.
 */
import { describe, expect, it, vi } from "vitest";
import { createLabelFeature, readableInsideColor } from "../src/internal/labels";
import {
  INSIDE_LABEL_COLOR,
  INSIDE_LABEL_TOKEN,
  LABEL_COLOR,
  LABEL_FONT,
  LABEL_FONT_TOKEN,
  LABEL_TOKEN,
} from "../src/internal/paint";
import { asHostLabel } from "../src/internal/options";
import type { BuiltinLabel } from "../src/internal/options";
import { themeOf, task } from "./_fakes";

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
    backdrop: { color: undefined, padding: undefined, radius: undefined },
  });
}

const noFault = (): void => {
  throw new Error("must not fault");
};
const plain = task({ id: "a", name: "Alpha" });

describe("createLabelFeature", () => {
  it("is off with no option, and off for anything that is not a function", () => {
    for (const option of [undefined, null, "text", 42, {}, []]) {
      const feature = makeLabels(option, themeOf(), noFault);
      expect(feature.enabled()).toBe(false);
      expect(feature.textOf(plain)).toBeUndefined();
    }
  });

  it("is on with a provider, and hands it the task", () => {
    const seen: unknown[] = [];
    const feature = makeLabels(
      (t: { name: string }) => {
        seen.push(t);
        return t.name;
      },
      themeOf(),
      noFault,
    );
    expect(feature.enabled()).toBe(true);
    expect(feature.textOf(plain)).toBe("Alpha");
    expect(seen).toEqual([plain]);
  });

  it("treats the empty string, undefined and a non-string result as no label", () => {
    const results: unknown[] = ["", undefined, 42, null, {}];
    const feature = makeLabels(() => results.shift(), themeOf(), noFault);
    for (let i = 0; i < 5; i += 1) expect(feature.textOf(plain)).toBeUndefined();
  });

  it("reads the colour and font tokens, falling back to the built-in values", () => {
    const themed = makeLabels(
      () => "x",
      themeOf({ [LABEL_TOKEN]: "#abcdef", [LABEL_FONT_TOKEN]: "12px serif" }),
      noFault,
    );
    expect(themed.color()).toBe("#abcdef");
    expect(themed.font()).toBe("12px serif");

    const bare = makeLabels(() => "x", themeOf(), noFault);
    expect(bare.color()).toBe(LABEL_COLOR);
    expect(bare.font()).toBe(LABEL_FONT);
  });

  it("never reads a token while the feature is off", () => {
    const reads: string[] = [];
    const feature = makeLabels(undefined, { get: (t) => (reads.push(t), "") }, noFault);
    expect(feature.enabled()).toBe(false);
    expect(feature.textOf(plain)).toBeUndefined();
    expect(reads).toEqual([]);
  });

  it("latches on a throw: reported once, and the feature is off for good", () => {
    const fault = vi.fn();
    let calls = 0;
    const feature = makeLabels(
      () => {
        calls += 1;
        throw new Error("boom");
      },
      themeOf(),
      fault,
    );
    expect(feature.enabled()).toBe(true);
    expect(feature.textOf(plain)).toBeUndefined();
    expect(feature.enabled()).toBe(false);
    expect(feature.textOf(plain)).toBeUndefined();
    expect(calls).toBe(1);
    expect(fault).toHaveBeenCalledTimes(1);
    expect((fault.mock.calls[0]?.[0] as Error).message).toBe("boom");
  });

  it("collects the host label, then the duration label, then the progress label", () => {
    const feature = makeLabels(() => "Host", themeOf(), noFault, {
      duration: { enabled: true, placement: undefined },
      progress: { enabled: true, placement: undefined },
    });
    const out = feature.collect(task({ id: "a", start: 0, end: 2 * 86_400_000, progress: 0.4 }), []);
    expect(out).toEqual([
      { text: "Host", placement: "right" },
      { text: "2d", placement: "right" },
      { text: "40%", placement: "inside" },
    ]);
  });
});

// The inside-label token is authored against the palette's ordinary bar fill; the bar under the
// label can be any colour.
describe("readableInsideColor", () => {
  it("keeps the token when it clears 4.5:1 on the bar", () => {
    expect(readableInsideColor("#ffffff", "#0f766e")).toBe("#ffffff");
    expect(readableInsideColor("#000000", "#6db3f2")).toBe("#000000");
  });

  it("flips to the readable extreme when the token vanishes into the bar", () => {
    // A palette whose inside-label token is black, on a summary bar the same palette paints black.
    expect(readableInsideColor("#000000", "#000000")).toBe("#ffffff");
    expect(readableInsideColor("#ffffff", "#ffffff")).toBe("#000000");
  });

  it("picks whichever extreme the bar carries better", () => {
    expect(readableInsideColor("#777777", "#111111")).toBe("#ffffff");
    expect(readableInsideColor("#777777", "#eeeeee")).toBe("#000000");
  });

  it("keeps the token when either colour cannot be measured", () => {
    expect(readableInsideColor("CanvasText", "#000000")).toBe("CanvasText");
    expect(readableInsideColor("#000000", "Highlight")).toBe("#000000");
  });
});

describe("insideColorOn", () => {
  // The pass resolves the token once and hands it in, so the feature reads no theme token per bar.
  const labels = makeLabels(() => "x", themeOf(), noFault);

  it("answers the token where it is readable and the extreme where it is not", () => {
    expect(labels.insideColorOn("#0f766e", "#ffffff")).toBe("#ffffff");
    expect(labels.insideColorOn("#ffffff", "#ffffff")).toBe("#000000");
  });

  it("takes the colour the pass resolved, reading no token of its own", () => {
    const reads: string[] = [];
    const feature = makeLabels(
      () => "x",
      { get: (token: string) => (reads.push(token), "") },
      noFault,
    );
    expect(feature.insideColorOn("#0f766e", INSIDE_LABEL_COLOR)).toBe(INSIDE_LABEL_COLOR);
    expect(reads).toEqual([]);
  });

  it("answers from the given token again when it changes, rather than from the cache", () => {
    // Both tokens are readable on this bar, so a stale cache would show up as the first answer
    // being repeated rather than as a flip to an extreme.
    expect(labels.insideColorOn("#111111", "#ffffff")).toBe("#ffffff");
    expect(labels.insideColorOn("#111111", "#cccccc")).toBe("#cccccc");
  });

  it("resolves the inside-label token from the theme once per pass", () => {
    const feature = makeLabels(() => "x", themeOf({ [INSIDE_LABEL_TOKEN]: "#101010" }), noFault);
    expect(feature.insideColor()).toBe("#101010");
  });
});
