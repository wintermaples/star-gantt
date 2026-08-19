/**
 * Presets and runtime switching, and forced-colors, end-to-end through the real core with the
 * shared test-utils fake DOM.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILT_IN_PRESETS,
  FORCED_COLOR_TOKENS,
  HIGH_CONTRAST_DARK,
  HIGH_CONTRAST_LIGHT,
} from "../../src/internal/theme/index";
import { boot, probe } from "./_boot";
import type { Booted } from "./_boot";

let booted: Booted | null = null;

function start(...args: Parameters<typeof boot>): Booted {
  booted = boot(...args);
  return booted;
}

afterEach(() => {
  booted?.gantt.dispose();
  booted?.dom.restore();
  booted = null;
});

/**
 * Boots with a probe counting `tokens` store notifications — the replacement for the abolished
 * `theme/changed` event — and returns the count reader alongside the boot.
 */
function startCounting(config?: Parameters<typeof boot>[2], tokens: Record<string, string> = {}) {
  let changes = 0;
  const b = start(
    [probe((ctx) => void ctx.use("stargantt.theme").tokens.subscribe(() => void (changes += 1)))],
    { tokens },
    config,
  );
  return { b, changes: () => changes };
}

describe("preset listing", () => {
  it("bundles exactly the two high-contrast presets by default", () => {
    const b = start();
    const svc = b.gantt.service("stargantt.theme");
    expect([...svc.presets()].sort()).toEqual(["high-contrast", "high-contrast-dark"]);
    expect(svc.preset()).toBeNull();
    // A bundled preset carries the scheme it was designed for alongside its tokens, so the
    // tokens it does not set resolve on the matching half of the defaults instead of the OS's.
    expect(BUILT_IN_PRESETS["high-contrast"]).toEqual({
      colorScheme: "light",
      tokens: HIGH_CONTRAST_LIGHT,
    });
    expect(BUILT_IN_PRESETS["high-contrast-dark"]).toEqual({
      colorScheme: "dark",
      tokens: HIGH_CONTRAST_DARK,
    });
  });

  // Both link-highlight tokens inherit the palette's --sg-link-line value verbatim (a flat entry,
  // not a var() chain: presets are flat token maps), so a high-contrast palette collapses the
  // link family to one colour and the emphasis/driving distinction survives only through the
  // highlight's extra width.
  it("inherits --sg-link-line's value for --sg-link-emphasis and --sg-link-driving", () => {
    for (const palette of [HIGH_CONTRAST_LIGHT, HIGH_CONTRAST_DARK]) {
      expect(palette["--sg-link-emphasis"]).toBe(palette["--sg-link-line"]);
      expect(palette["--sg-link-driving"]).toBe(palette["--sg-link-line"]);
    }
  });

  it("merges config presets over the bundled ones and sanitizes unusable entries", () => {
    const b = start([], {}, {
      presets: {
        brand: { "--sg-bar-fill": "#123456", "not-a-token": "#fff", "--sg-empty": "  " },
        "high-contrast": { "--sg-bar-fill": "#000001" }, // replaces the bundled palette
        "": { "--sg-bar-fill": "#fff" }, // empty name dropped
        garbage: { "--sg-bar-fill": 5 as unknown as string }, // nothing survives → dropped
      },
    });
    const svc = b.gantt.service("stargantt.theme");
    expect([...svc.presets()].sort()).toEqual(["brand", "high-contrast", "high-contrast-dark"]);
    svc.setPreset("high-contrast");
    expect(svc.get("--sg-bar-fill")).toBe("#000001"); // the replacement, not the bundled value
    // The replaced bundled preset no longer sets --sg-fg, so the computed style answers.
    expect(svc.get("--sg-fg")).toBe("");
  });
});

describe("runtime switching", () => {
  it("layers the applied preset's values over the computed style and repaints once", () => {
    const { b, changes } = startCounting(undefined, { "--sg-bar-fill": "#4a7ebb", "--sg-custom": "x" });
    const svc = b.gantt.service("stargantt.theme");
    expect(svc.get("--sg-bar-fill")).toBe("#4a7ebb");
    b.invalidated.length = 0;

    svc.setPreset("high-contrast");
    expect(svc.preset()).toBe("high-contrast");
    expect(svc.get("--sg-bar-fill")).toBe(HIGH_CONTRAST_LIGHT["--sg-bar-fill"]);
    // A token the preset does not set keeps reading the computed style.
    expect(svc.get("--sg-custom")).toBe("x");
    expect(changes()).toBe(1);
    expect(b.invalidated).toEqual(["background", "main", "overlay"]);
  });

  it("setPreset(null) restores the computed style and repaints", () => {
    const { b, changes } = startCounting(undefined, { "--sg-bar-fill": "#4a7ebb" });
    const svc = b.gantt.service("stargantt.theme");
    svc.setPreset("high-contrast-dark");
    expect(svc.get("--sg-bar-fill")).toBe(HIGH_CONTRAST_DARK["--sg-bar-fill"]);
    svc.setPreset(null);
    expect(svc.preset()).toBeNull();
    expect(svc.get("--sg-bar-fill")).toBe("#4a7ebb");
    expect(changes()).toBe(2); // apply + clear, nothing else
  });

  it("ignores unknown names, re-applies and no-op clears silently", () => {
    const { b, changes } = startCounting();
    const svc = b.gantt.service("stargantt.theme");
    svc.setPreset(null); // nothing applied — no-op
    svc.setPreset("no-such-preset");
    svc.setPreset(42 as unknown as string);
    expect(svc.preset()).toBeNull();
    svc.setPreset("high-contrast");
    svc.setPreset("high-contrast"); // re-apply — no-op
    expect(changes()).toBe(1);
  });

  it("applies the config-selected preset at activation and ignores an unknown one", () => {
    const b = start([], {}, { preset: "high-contrast-dark" });
    const svc = b.gantt.service("stargantt.theme");
    expect(svc.preset()).toBe("high-contrast-dark");
    expect(svc.get("--sg-fg")).toBe(HIGH_CONTRAST_DARK["--sg-fg"]);
    booted?.gantt.dispose();
    booted?.dom.restore();

    const b2 = start([], {}, { preset: "nope" });
    expect(b2.gantt.service("stargantt.theme").preset()).toBeNull();
  });

  it("default config keeps the pre-preset behavior byte-identical for get()", () => {
    const b = start([], { tokens: { "--sg-today-line": "#f00" } });
    const svc = b.gantt.service("stargantt.theme");
    expect(svc.get("--sg-today-line")).toBe("#f00");
    expect(svc.get("--sg-unset")).toBe("");
    expect(b.invalidated).toEqual([]); // no repaint was triggered by merely booting
  });

  it("still refreshes preset-layered reads after a class-driven restyle", () => {
    const b = start([], { tokens: { "--sg-custom": "before" } });
    const svc = b.gantt.service("stargantt.theme");
    svc.setPreset("high-contrast");
    expect(svc.get("--sg-custom")).toBe("before");
    b.dom.tokens["--sg-custom"] = "after";
    b.dom.root.className = "dark";
    for (const rec of b.dom.mutationObservers()) rec.callback();
    expect(svc.get("--sg-custom")).toBe("after");
    // The preset layer survives the refresh untouched.
    expect(svc.get("--sg-bar-fill")).toBe(HIGH_CONTRAST_LIGHT["--sg-bar-fill"]);
  });
});

describe("merge mode", () => {
  const base = { "--sg-bg": "#101010", "--sg-bar-fill": "#202020" };
  const accent = { "--sg-bar-fill": "#ff0000" };

  it("layers the named preset over what is already applied", () => {
    const b = start([], {}, { presets: { base, accent } });
    const svc = b.gantt.service("stargantt.theme");
    svc.setPreset("base");
    svc.setPreset("accent", { mode: "merge" });
    // The accent won where the two overlap; the base survives where it did not.
    expect(svc.get("--sg-bar-fill")).toBe("#ff0000");
    expect(svc.get("--sg-bg")).toBe("#101010");
    expect(svc.preset()).toBe("accent");
  });

  it("replaces by default, dropping the previous preset's tokens", () => {
    const b = start([], { tokens: { "--sg-bg": "#ffffff" } }, { presets: { base, accent } });
    const svc = b.gantt.service("stargantt.theme");
    svc.setPreset("base");
    svc.setPreset("accent");
    expect(svc.get("--sg-bar-fill")).toBe("#ff0000");
    expect(svc.get("--sg-bg")).toBe("#ffffff"); // back to the computed style
  });

  it("clears the whole accumulated set, whichever mode built it", () => {
    const b = start([], { tokens: { "--sg-bg": "#ffffff", "--sg-bar-fill": "#4a7ebb" } }, {
      presets: { base, accent },
    });
    const svc = b.gantt.service("stargantt.theme");
    svc.setPreset("base");
    svc.setPreset("accent", { mode: "merge" });
    svc.setPreset(null);
    expect(svc.get("--sg-bg")).toBe("#ffffff");
    expect(svc.get("--sg-bar-fill")).toBe("#4a7ebb");
  });

  it("re-applying the active preset in merge mode still yields the same token set", () => {
    const b = start([], {}, { presets: { base } });
    const svc = b.gantt.service("stargantt.theme");
    svc.setPreset("base");
    svc.setPreset("base", { mode: "merge" });
    expect(svc.get("--sg-bg")).toBe("#101010");
    expect(svc.preset()).toBe("base");
  });
});

describe("inline preset cleanup on dispose (§6.2, ctx.own)", () => {
  // The chart root is the host's own element and outlives the chart, so disposal removes the
  // applied preset's inline custom properties exactly as `setPreset(null)` would.
  it("removes the applied preset's inline custom properties when the chart is disposed", () => {
    const b = start();
    const inline = new Map<string, string>();
    const style = b.dom.root.style as unknown as Record<string, unknown>;
    style["setProperty"] = (name: string, value: string) => void inline.set(name, value);
    style["removeProperty"] = (name: string) => void inline.delete(name);
    const svc = b.gantt.service("stargantt.theme");
    svc.setPreset("high-contrast");
    expect(inline.get("--sg-bg")).toBe(HIGH_CONTRAST_LIGHT["--sg-bg"]);
    b.gantt.dispose();
    expect(inline.has("--sg-bg")).toBe(false);
    expect(inline.size).toBe(0);
  });
});

describe("forced-colors", () => {
  it("is fully off by default: no forced-colors media query is even created", () => {
    const b = start();
    const media = b.dom.mediaQueries().map((q) => q.media);
    expect(media).not.toContain("(forced-colors: active)");
    // Mapped tokens read the computed style as always.
    expect(b.gantt.service("stargantt.theme").get("--sg-bar-fill")).toBe("");
  });

  it("maps canvas-read tokens to system colors while active, ahead of preset and computed", () => {
    // The fake matchMedia double reports matches: true, so forced colors are active at boot.
    const b = start([], { tokens: { "--sg-bar-fill": "#4a7ebb" } }, { forcedColors: true });
    const svc = b.gantt.service("stargantt.theme");
    expect(svc.get("--sg-bar-fill")).toBe("Highlight");
    expect(svc.get("--sg-fg")).toBe("CanvasText");
    expect(svc.get("--sg-drag-ghost-fill")).toBe("transparent");
    svc.setPreset("high-contrast");
    expect(svc.get("--sg-bar-fill")).toBe("Highlight"); // forced palette outranks the preset
    // Unmapped tokens (fonts, lengths) keep reading normally even while active.
    expect(FORCED_COLOR_TOKENS["--sg-header-font"]).toBeUndefined();
    expect(svc.get("--sg-header-font")).toBe("");
  });

  it("repaints and returns to CSS-driven colors when the forced-colors state flips off", () => {
    const { b, changes } = startCounting({ forcedColors: true }, { "--sg-bar-fill": "#4a7ebb" });
    const svc = b.gantt.service("stargantt.theme");
    expect(svc.get("--sg-bar-fill")).toBe("Highlight");
    const forced = b.dom.mediaQueries().find((q) => q.media === "(forced-colors: active)");
    expect(forced).toBeDefined();
    if (forced === undefined) return;
    forced.matches = false;
    for (const fn of forced.listeners) fn();
    expect(svc.get("--sg-bar-fill")).toBe("#4a7ebb");
    expect(changes()).toBe(1);
    // Flipping back on repaints again.
    forced.matches = true;
    for (const fn of forced.listeners) fn();
    expect(svc.get("--sg-bar-fill")).toBe("Highlight");
    expect(changes()).toBe(2);
  });

  // Every canvas-read color token registered by the batch that added grid shading, the status
  // line and inside labels is in the map, so a forced palette drops the author colors on those
  // surfaces too.
  it("maps the grid shading, status-line and inside-label tokens", () => {
    expect(FORCED_COLOR_TOKENS["--sg-grid-nonworking"]).toBe("transparent");
    expect(FORCED_COLOR_TOKENS["--sg-grid-offhours"]).toBe("transparent");
    expect(FORCED_COLOR_TOKENS["--sg-grid-zone"]).toBe("transparent");
    expect(FORCED_COLOR_TOKENS["--sg-status-line"]).toBe("Highlight");
    expect(FORCED_COLOR_TOKENS["--sg-bar-inside-label-fg"]).toBe("HighlightText");
  });

  // The dependency-highlight tokens keep the emphasized/driving distinction under a system
  // palette: emphasis is the emphasized figure (Highlight), driving is the ordinary link colour
  // (CanvasText), so the extra width the highlight style adds is what still tells them apart once
  // the hues collapse.
  it("maps the dependency-highlight emphasis/driving tokens", () => {
    expect(FORCED_COLOR_TOKENS["--sg-link-emphasis"]).toBe("Highlight");
    expect(FORCED_COLOR_TOKENS["--sg-link-driving"]).toBe("CanvasText");
  });

  // Inside-bar text (HighlightText) paints on top of the bar. Under the track/fill model the
  // whole bar is one colour (Highlight)
  // at two opacities, so there is no second surface that could collide with the text: the check
  // that used to guard the progress overlay now guards the only fill there is. A future token
  // painted *under* inside-bar text must not resolve to the same system colour as the text.
  it("never paints inside-bar text on a same-color surface", () => {
    expect(FORCED_COLOR_TOKENS["--sg-progress-fill"]).toBeUndefined();
    const insideText = FORCED_COLOR_TOKENS["--sg-bar-inside-label-fg"];
    expect(FORCED_COLOR_TOKENS["--sg-bar-fill"]).not.toBe(insideText);
  });

  it("detaches its media listener on dispose", () => {
    const b = start([], {}, { forcedColors: true });
    expect(b.dom.liveMediaListeners()).toBe(2); // color-scheme + forced-colors
    b.gantt.dispose();
    expect(b.dom.liveMediaListeners()).toBe(0);
  });
});

describe("config sanitization", () => {
  // There is no intermediate "construct then boot" step — `createThemeModule(ctx, config, render)`
  // reads the config while it builds the service, so "accepts an unusable config" can only be
  // observed by booting, which the assertions below do.
  it("accepts and ignores an entirely unusable config", () => {
    const b = start([], {}, { preset: 7 as unknown as string, forcedColors: "yes" as never });
    const svc = b.gantt.service("stargantt.theme");
    expect(svc.preset()).toBeNull();
    expect(b.dom.mediaQueries().map((q) => q.media)).not.toContain("(forced-colors: active)");
  });
});
