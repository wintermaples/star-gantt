/**
 * Contract §3.13 (`@stargantt/plugin-theme`) end-to-end through the real core:
 * the `stargantt.theme` service, the bulk-cached `getComputedStyle` read, re-read +
 * all-layers-dirty on `class` / `prefers-color-scheme` change, and disposal.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createThemeModule } from "../../src/internal/theme/index";
import type { ThemeService } from "../../src/internal/theme/index";
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

describe("plugin metadata", () => {
  // The theme layer used to ship as its own plugin, with its own `meta.id` ("stargantt.theme")
  // and its own hard dependency on the renderer plugin. The six formerly-separate modules have
  // since merged into one (`stargantt.view`), and `createThemeModule` is a plain factory function
  // `wiring.ts` calls
  // directly with the render module already in hand — there is no longer a separate plugin
  // identity or dependency edge to assert. `stargantt.view`'s own id/dependsOn is covered by
  // `test/render/renderer.test.ts`, so these two are skipped rather than reasserted against an
  // unrelated fact (the merged plugin depends on `stargantt.data-store`, not the render module).
  it.skip("has id `stargantt.theme` — no longer a separate plugin, see comment above", () => {});
  it.skip(
    "declares `stargantt.renderer` as a hard dependency — no longer a separate plugin",
    () => {},
  );
});

describe("module factory", () => {
  // The check that `theme()` is a factory rather than a shared plugin const is expressed as:
  // `createThemeModule` is an ordinary function, and two calls (as two independent chart boots
  // make) produce independent `ThemeService` instances with independent state — no config or
  // service object is memoized or shared across charts.
  it("is a factory function producing an independent service per call, not a singleton", () => {
    expect(typeof createThemeModule).toBe("function");

    const a = start([], { tokens: {} });
    const svcA = a.gantt.service("stargantt.theme");
    a.gantt.dispose();
    a.dom.restore();

    const b = start([], { tokens: {} });
    const svcB = b.gantt.service("stargantt.theme");

    expect(svcA).not.toBe(svcB);
    // Mutating one chart's theme state must not leak into the other's.
    svcB.setColorScheme("dark");
    expect(svcB.colorScheme()).toBe("dark");
    expect(svcA.colorScheme()).toBe("auto");
  });
});

describe("service surface", () => {
  it("boots and provides `stargantt.theme` with nothing else contributed", () => {
    const b = start([], { tokens: {} });
    expect(b.gantt.service("stargantt.theme")).toBeDefined();
  });
});

describe("ThemeService.get", () => {
  it("provides `stargantt.theme` to application code and to dependent plugins", () => {
    let fromPlugin: ThemeService | null = null;
    const b = start([probe((ctx) => void (fromPlugin = ctx.use("stargantt.theme")))], {
      tokens: { "--sg-today-line": "#f00" },
    });
    const fromApp = b.gantt.service("stargantt.theme");
    expect(fromApp).toBe(fromPlugin);
    expect(fromApp.get("--sg-today-line")).toBe("#f00");
  });

  it("reads CSS custom properties from the root element and trims the value", () => {
    const b = start([], { tokens: { "--sg-bar-bg": "  rgb(1, 2, 3)  " } });
    expect(b.gantt.service("stargantt.theme").get("--sg-bar-bg")).toBe("rgb(1, 2, 3)");
  });

  it("returns an empty string for an undefined token", () => {
    const b = start([], { tokens: {} });
    expect(b.gantt.service("stargantt.theme").get("--sg-nope")).toBe("");
  });

  it("returns an empty string when `getComputedStyle` is unavailable", () => {
    const b = start([], { noComputedStyle: true });
    expect(b.gantt.service("stargantt.theme").get("--sg-grid-line")).toBe("");
  });

  it("reads `getComputedStyle` in bulk: many token reads, one call", () => {
    const b = start([], {
      tokens: { "--sg-bar-bg": "#111", "--sg-grid-line": "#222", "--sg-row-hover": "#333" },
    });
    const t = b.gantt.service("stargantt.theme");
    // The `tokens` store's initial value is snapshotted at the end of setup — the one bulk read
    // that seeds the cache, so a subscriber's first read is already the palette the chart paints
    // with. Nothing past that adds a second call, however many tokens are read.
    expect(b.dom.computedStyleCalls()).toBe(1);
    t.get("--sg-bar-bg");
    t.get("--sg-grid-line");
    t.get("--sg-row-hover");
    t.get("--sg-bar-bg");
    expect(b.dom.computedStyleCalls()).toBe(1);
  });
});

describe("non-color tokens", () => {
  it("returns a font token's value verbatim, for direct use as a canvas 2D context `font`", () => {
    const b = start([], { tokens: { "--sg-header-font": "12px \"Segoe UI\", sans-serif" } });
    expect(b.gantt.service("stargantt.theme").get("--sg-header-font")).toBe(
      '12px "Segoe UI", sans-serif',
    );
  });

  it("returns a numeric px token's value as text, parseable by the caller with parseFloat", () => {
    const b = start([], { tokens: { "--sg-selection-line-width": "3px" } });
    const raw = b.gantt.service("stargantt.theme").get("--sg-selection-line-width");
    expect(raw).toBe("3px");
    expect(parseFloat(raw)).toBe(3);
  });

  it("shares the same bulk-read cache across colour, font and numeric tokens", () => {
    const b = start([], {
      tokens: {
        "--sg-bar-fill": "#4a7ebb",
        "--sg-bar-label-font": "11px sans-serif",
        "--sg-selection-outset": "4px",
      },
    });
    const t = b.gantt.service("stargantt.theme");
    // As above: the `tokens` store's initial snapshot is the one bulk read.
    expect(b.dom.computedStyleCalls()).toBe(1);
    t.get("--sg-bar-fill");
    t.get("--sg-bar-label-font");
    t.get("--sg-selection-outset");
    expect(b.dom.computedStyleCalls()).toBe(1);
  });

  it("re-reads font and numeric tokens on a theme change, like colour tokens", () => {
    const b = start([], { tokens: { "--sg-header-font": "10px sans-serif" } });
    const t = b.gantt.service("stargantt.theme");
    expect(t.get("--sg-header-font")).toBe("10px sans-serif");

    b.dom.tokens["--sg-header-font"] = "14px monospace";
    expect(t.get("--sg-header-font")).toBe("10px sans-serif"); // still cached

    b.dom.root.setAttribute("class", "sg-dark");
    expect(t.get("--sg-header-font")).toBe("14px monospace");
  });

  it("returns an empty string for an unset numeric token, letting the caller fall back", () => {
    const b = start([], { tokens: {} });
    const raw = b.gantt.service("stargantt.theme").get("--sg-selection-line-width");
    expect(raw).toBe("");
    expect(Number.isFinite(parseFloat(raw))).toBe(false);
  });
});

describe("theme change detection", () => {
  it("re-reads the tokens on a `class` change", () => {
    const b = start([], { tokens: { "--sg-bar-bg": "#fff" } });
    const t = b.gantt.service("stargantt.theme");
    expect(t.get("--sg-bar-bg")).toBe("#fff");

    b.dom.tokens["--sg-bar-bg"] = "#000";
    expect(t.get("--sg-bar-bg")).toBe("#fff"); // still cached

    b.dom.root.setAttribute("class", "sg-dark");
    expect(t.get("--sg-bar-bg")).toBe("#000");
    expect(b.dom.computedStyleCalls()).toBe(2);
  });

  it("marks all three layers dirty on a `class` change", () => {
    const b = start([], { tokens: {} });
    expect(b.invalidated).toEqual([]);
    b.dom.root.setAttribute("class", "sg-dark");
    expect(b.invalidated).toEqual(["background", "main", "overlay"]);
  });

  it("observes exactly the `class` and `data-theme` attributes of the root element", () => {
    const b = start([], { tokens: {} });
    expect(b.dom.mutationObservers()).toHaveLength(1);
    const o = b.dom.mutationObservers()[0];
    expect(o?.target).toBe(b.dom.root);
    expect(o?.filter).toEqual(["class", "data-theme"]);
  });

  it("re-reads the tokens on a `data-theme` change", () => {
    const b = start([], { tokens: { "--sg-bar-bg": "#fff" } });
    const t = b.gantt.service("stargantt.theme");
    expect(t.get("--sg-bar-bg")).toBe("#fff");

    b.dom.tokens["--sg-bar-bg"] = "#000";
    expect(t.get("--sg-bar-bg")).toBe("#fff"); // still cached

    b.dom.root.setAttribute("data-theme", "dark");
    expect(t.get("--sg-bar-bg")).toBe("#000");
    expect(b.dom.computedStyleCalls()).toBe(2);
  });

  it("marks all three layers dirty on a `data-theme` change", () => {
    const b = start([], { tokens: {} });
    expect(b.invalidated).toEqual([]);
    b.dom.root.setAttribute("data-theme", "dark");
    expect(b.invalidated).toEqual(["background", "main", "overlay"]);
  });

  // Neither the old nor the new attribute value is inspected — any mutation of either observed
  // name is an equal trigger, including one that sets a value the plugin cannot interpret.
  it("refreshes on any `data-theme` value, and again when it is switched back", () => {
    const b = start([], { tokens: {} });
    b.dom.root.setAttribute("data-theme", "not-a-known-scheme");
    b.dom.root.setAttribute("data-theme", "light");
    expect(b.invalidated).toEqual([
      "background",
      "main",
      "overlay",
      "background",
      "main",
      "overlay",
    ]);
  });

  it("ignores a mutation of an unobserved attribute", () => {
    const b = start([], { tokens: { "--sg-bar-bg": "#fff" } });
    const t = b.gantt.service("stargantt.theme");
    expect(t.get("--sg-bar-bg")).toBe("#fff");

    b.dom.tokens["--sg-bar-bg"] = "#000";
    b.dom.root.setAttribute("style", "color: red");

    expect(b.invalidated).toEqual([]);
    expect(t.get("--sg-bar-bg")).toBe("#fff");
  });

  it("notifies the tokens store on a `data-theme` change too", () => {
    const seen: string[] = [];
    const b = start(
      [
        probe((ctx) => {
          const svc = ctx.use("stargantt.theme");
          svc.tokens.subscribe(() => seen.push(svc.get("--sg-bar-bg")));
        }),
      ],
      { tokens: { "--sg-bar-bg": "#fff" } },
    );

    b.dom.tokens["--sg-bar-bg"] = "#333";
    b.dom.root.setAttribute("data-theme", "dark");
    expect(seen).toEqual(["#333"]);
  });

  it("stops refreshing on `data-theme` after disposal", () => {
    const b = start([], { tokens: {} });
    b.gantt.dispose();
    b.dom.root.setAttribute("data-theme", "dark");
    expect(b.invalidated).toEqual([]);
    b.dom.restore();
    booted = null;
  });

  it("re-reads and marks all layers dirty on a `prefers-color-scheme` change", () => {
    const b = start([], { tokens: { "--sg-bar-bg": "#fff" } });
    const t = b.gantt.service("stargantt.theme");
    expect(t.get("--sg-bar-bg")).toBe("#fff");

    b.dom.tokens["--sg-bar-bg"] = "#000";
    b.dom.fireMediaChange();

    expect(t.get("--sg-bar-bg")).toBe("#000");
    expect(b.invalidated).toEqual(["background", "main", "overlay"]);
  });

  it("watches the `prefers-color-scheme` media query", () => {
    const b = start([], { tokens: {} });
    expect(b.dom.mediaQueries().map((m) => m.media)).toEqual(["(prefers-color-scheme: dark)"]);
    expect(b.dom.mediaQueries()[0]?.listeners.size).toBe(1);
  });

  it("supports the legacy `addListener` MediaQueryList", () => {
    const b = start([], { tokens: {}, legacyMediaQuery: true });
    expect(b.dom.mediaQueries()[0]?.listeners.size).toBe(1);
    b.dom.fireMediaChange();
    expect(b.invalidated).toEqual(["background", "main", "overlay"]);
  });

  // `invalidate` reaches only the renderer's layers, so canvases owned by other plugins (the
  // timeline header) repaint on this store notification instead.
  it("notifies the tokens store after the cache is re-read, on both change channels", () => {
    const seen: string[] = [];
    const b = start(
      [
        probe((ctx) => {
          // Recording the token value at notification time proves subscribers already see fresh
          // tokens: the store is set after the cache is re-read and the layers are marked dirty.
          const svc = ctx.use("stargantt.theme");
          svc.tokens.subscribe(() => seen.push(svc.get("--sg-bar-bg")));
        }),
      ],
      { tokens: { "--sg-bar-bg": "#fff" } },
    );
    expect(seen).toEqual([]);

    b.dom.tokens["--sg-bar-bg"] = "#111";
    b.dom.fireMediaChange();
    expect(seen).toEqual(["#111"]);

    b.dom.tokens["--sg-bar-bg"] = "#222";
    b.dom.root.setAttribute("class", "sg-dark");
    expect(seen).toEqual(["#111", "#222"]);
  });
});

describe("refresh() — the host's escape hatch", () => {
  it("get() stays stale when a token changes with no watched trigger firing", () => {
    const b = start([], { tokens: { "--sg-bar-bg": "#fff" } });
    const t = b.gantt.service("stargantt.theme");
    expect(t.get("--sg-bar-bg")).toBe("#fff");

    // Simulates a host that changed something outside the chart element (e.g. `data-theme` on
    // `<html>`): the computed style has new values, but no observed attribute of the chart root
    // moved, so nothing here should invalidate the cache on its own.
    b.dom.tokens["--sg-bar-bg"] = "#000";
    expect(t.get("--sg-bar-bg")).toBe("#fff"); // still stale
    expect(b.invalidated).toEqual([]); // no layer marked dirty either
  });

  it("refresh() re-reads the tokens and marks all three layers dirty", () => {
    const b = start([], { tokens: { "--sg-bar-bg": "#fff" } });
    const t = b.gantt.service("stargantt.theme");
    expect(t.get("--sg-bar-bg")).toBe("#fff");

    b.dom.tokens["--sg-bar-bg"] = "#000";
    t.refresh();

    expect(t.get("--sg-bar-bg")).toBe("#000");
    expect(b.invalidated).toEqual(["background", "main", "overlay"]);
  });

  it("notifies the tokens store exactly once per call, with fresh tokens already visible", () => {
    const seen: string[] = [];
    const b = start(
      [
        probe((ctx) => {
          const svc = ctx.use("stargantt.theme");
          svc.tokens.subscribe(() => seen.push(svc.get("--sg-bar-bg")));
        }),
      ],
      { tokens: { "--sg-bar-bg": "#fff" } },
    );
    const t = b.gantt.service("stargantt.theme");

    b.dom.tokens["--sg-bar-bg"] = "#111";
    t.refresh();
    expect(seen).toEqual(["#111"]);

    b.dom.tokens["--sg-bar-bg"] = "#222";
    t.refresh();
    expect(seen).toEqual(["#111", "#222"]);
  });

  it("is harmless when nothing changed: still re-reads and still notifies once", () => {
    const seen: string[] = [];
    const b = start(
      [probe((ctx) => void ctx.use("stargantt.theme").tokens.subscribe(() => seen.push("fired")))],
      { tokens: { "--sg-bar-bg": "#fff" } },
    );
    const t = b.gantt.service("stargantt.theme");
    expect(t.get("--sg-bar-bg")).toBe("#fff");

    t.refresh();

    expect(t.get("--sg-bar-bg")).toBe("#fff");
    expect(seen).toEqual(["fired"]);
    expect(b.invalidated).toEqual(["background", "main", "overlay"]);
  });

  it("stops being reachable after disposal like every other service method", () => {
    const b = start([], { tokens: {} });
    const t = b.gantt.service("stargantt.theme");
    b.gantt.dispose();
    expect(() => t.refresh()).not.toThrow();
    booted = null;
    b.dom.restore();
  });
});

describe("degraded environments", () => {
  it("boots without `MutationObserver`", () => {
    const b = start([], { tokens: { "--sg-bar-bg": "#abc" }, noMutationObserver: true });
    expect(b.dom.mutationObservers()).toEqual([]);
    expect(b.gantt.service("stargantt.theme").get("--sg-bar-bg")).toBe("#abc");
  });

  it("boots without `matchMedia`", () => {
    const b = start([], { tokens: { "--sg-bar-bg": "#abc" }, noMatchMedia: true });
    expect(b.dom.mediaQueries()).toEqual([]);
    expect(b.gantt.service("stargantt.theme").get("--sg-bar-bg")).toBe("#abc");
  });
});

describe("disposal (§1.7, CLAUDE.md constraint)", () => {
  it("disconnects the MutationObserver and removes the media-query listener", () => {
    const b = start([], { tokens: {} });
    b.gantt.dispose();

    b.dom.root.setAttribute("class", "sg-dark");
    b.dom.fireMediaChange();
    expect(b.invalidated).toEqual([]);
    expect(b.dom.mediaQueries()[0]?.listeners.size).toBe(0);
    expect(b.dom.mutationObservers()[0]?.connected).toBe(false);

    b.dom.restore();
    booted = null;
  });
});
