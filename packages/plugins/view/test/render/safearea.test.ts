/**
 * The overlay safe area and the four `--sg-safe-*` custom properties the renderer
 * publishes on the chart pane.
 *
 * Two levels: the pure resolution and writer (hostless), and the values a corner-anchored overlay
 * actually reads off the pane in a real composition — at boot, when the bands move, with the
 * scrollbars switched off, and at the 720×540 viewport floor.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  SAFE_AREA_PROPERTIES,
  SCROLLBAR_RESERVATION,
  createSafeAreaWriter,
  resolveSafeArea,
} from "../../src/internal/render/safearea";
import { SCROLLBAR_EDGE_GAP, SCROLLBAR_TRACK_THICKNESS } from "../../src/internal/render/scrollbars";
import type { SafeArea } from "../../src/internal/render/safearea";
import { boot, probe } from "./_boot";
import type { Booted } from "./_boot";
import type { DomHarness, FakeElement } from "../_utils/index";
import type { InsetContribution, ResolvedInsets } from "../../src/internal/render/index";

let booted: Booted | null = null;

afterEach(() => {
  booted?.dom.restore();
  booted = null;
});

/* ------------------------------------------------------------------ *
 * §5.1 — the safe area itself
 * ------------------------------------------------------------------ */

const bands = (top: number, bottom: number): ResolvedInsets => ({ top, bottom });

describe("resolveSafeArea", () => {
  it("keeps the header band and both scrollbar strips out of the default composition's corners", () => {
    // The default composition reserves one 44px top strip (the timeline header) and no bottom one.
    expect(resolveSafeArea(bands(44, 0), true, "ltr")).toEqual({
      top: 44,
      right: SCROLLBAR_RESERVATION,
      bottom: SCROLLBAR_RESERVATION,
      left: 0,
    });
  });

  // §6.1 mirrors the vertical bar to the pane's inline-end edge, which is the left edge in RTL
  // (`scrollbars.ts` overrides the stylesheet's physical `right` with `left: 2px` there). The
  // reservation follows the bar rather than the physical edge, so the same overlay declaration
  // clears it in both directions.
  it("moves the vertical bar's reservation to the left edge in RTL", () => {
    expect(resolveSafeArea(bands(44, 0), true, "rtl")).toEqual({
      top: 44,
      right: 0,
      bottom: SCROLLBAR_RESERVATION,
      left: SCROLLBAR_RESERVATION,
    });
  });

  it("keeps the bottom bar's reservation on the bottom edge in both directions", () => {
    for (const direction of ["ltr", "rtl"] as const) {
      expect(resolveSafeArea(bands(44, 20), true, direction).bottom).toBe(
        20 + SCROLLBAR_RESERVATION,
      );
      expect(resolveSafeArea(bands(44, 20), true, direction).top).toBe(44);
    }
  });

  it("reserves the bar's edge gap plus its track thickness — 10 CSS px", () => {
    expect(SCROLLBAR_RESERVATION).toBe(SCROLLBAR_EDGE_GAP + SCROLLBAR_TRACK_THICKNESS);
    expect(SCROLLBAR_RESERVATION).toBe(10);
  });

  // Publishing the bars' thickness and edge gap as theme tokens was ruled out (a registry token
  // is a host-writable *input*, and the bars' pointer geometry cannot be re-derived from one), so
  // the two numbers are mirrored between the stylesheet, which sizes the bars, and the constants
  // above, which the safe area adds up. This is the conformance check that keeps the mirror
  // honest: it reads the declarations, not the code, and it is the whole reason the reservation is
  // not simply hardcoded as 10.
  //
  // The shipped stylesheet is authored as one document but split into three parts on disk to
  // respect this repo's 800-line-per-file convention (packages/stargantt/src/index.ts "Style
  // injection"); concatenating them in the same order the bundle entry point does (tokens, layout,
  // plugins) reproduces the shipped palette exactly. The check reports as skipped until every part
  // exists — and re-arms by itself the moment all three files appear, with no edit here. Skipping
  // beats deleting: these reservation constants are exactly what would drift unnoticed without it.
  const STYLES_DIR = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "..",
    "stargantt",
    "src",
    "styles",
  );
  const STYLES_PARTS = ["tokens.css", "layout.css", "plugins.css"].map((name) =>
    resolve(STYLES_DIR, name),
  );

  describe.skipIf(!STYLES_PARTS.every((path) => existsSync(path)))(
    "the reservation matches the bars the bundled stylesheet paints",
    () => {

    /** The px value one rule declares for one property. */
    const declared = (selector: string, property: string): number => {
      const css = STYLES_PARTS.map((path) => readFileSync(path, "utf8"))
        .join("")
        .replace(/\/\*[\s\S]*?\*\//g, "");
      const rule = new RegExp(`\\.${selector}\\s*\\{([^}]*)\\}`).exec(css)?.[1];
      if (rule === undefined)
        throw new Error(`no .${selector} rule in stargantt/src/styles/{tokens,layout,plugins}.css`);
      const value = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([\\d.]+)px`).exec(rule)?.[1];
      if (value === undefined) throw new Error(`.${selector} declares no ${property}`);
      return Number.parseFloat(value);
    };

    it("uses the vertical bar's own width and right offset", () => {
      expect(declared("sg-scrollbar--vertical", "width")).toBe(SCROLLBAR_TRACK_THICKNESS);
      expect(declared("sg-scrollbar--vertical", "right")).toBe(SCROLLBAR_EDGE_GAP);
    });

    it("uses the horizontal bar's own height and bottom offset", () => {
      expect(declared("sg-scrollbar--horizontal", "height")).toBe(SCROLLBAR_TRACK_THICKNESS);
      expect(declared("sg-scrollbar--horizontal", "bottom")).toBe(SCROLLBAR_EDGE_GAP);
    });
    },
  );

  it("reserves nothing for the bars when they are switched off, in either direction", () => {
    for (const direction of ["ltr", "rtl"] as const) {
      expect(resolveSafeArea(bands(44, 0), false, direction)).toEqual({
        top: 44,
        right: 0,
        bottom: 0,
        left: 0,
      });
    }
  });

  it("stacks the bottom band and the bottom bar's strip", () => {
    expect(resolveSafeArea(bands(44, 60), true, "ltr").bottom).toBe(70);
    expect(resolveSafeArea(bands(44, 60), false, "ltr").bottom).toBe(60);
  });

  it("publishes zero for a band that is absent, negative or non-finite", () => {
    expect(resolveSafeArea(bands(0, 0), false, "ltr")).toEqual({
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    });
    expect(resolveSafeArea(bands(Number.NaN, -5), false, "ltr").top).toBe(0);
    expect(resolveSafeArea(bands(Number.NaN, -5), false, "ltr").bottom).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * §5.2 — the writer
 * ------------------------------------------------------------------ */

/** A style stand-in that records every `setProperty` call, in order. */
function styleSpy(): { writes: [string, string][]; setProperty(name: string, value: string): void } {
  const writes: [string, string][] = [];
  return {
    writes,
    setProperty(name, value) {
      writes.push([name, value]);
    },
  };
}

const area = (top: number, right: number, bottom: number, left: number): SafeArea => ({
  top,
  right,
  bottom,
  left,
});

describe("createSafeAreaWriter", () => {
  it("writes all four lengths, including the zero ones", () => {
    const style = styleSpy();
    createSafeAreaWriter(style).write(area(44, 10, 10, 0));
    expect(style.writes).toEqual([
      ["--sg-safe-top", "44px"],
      ["--sg-safe-right", "10px"],
      ["--sg-safe-bottom", "10px"],
      ["--sg-safe-left", "0px"],
    ]);
  });

  it("rewrites only the values that changed", () => {
    const style = styleSpy();
    const writer = createSafeAreaWriter(style);
    writer.write(area(44, 10, 10, 0));
    style.writes.length = 0;

    writer.write(area(44, 10, 10, 0));
    expect(style.writes).toEqual([]);

    writer.write(area(64, 10, 10, 0));
    expect(style.writes).toEqual([["--sg-safe-top", "64px"]]);
  });

  it("publishes nothing rather than throwing on a style object without `setProperty`", () => {
    const writer = createSafeAreaWriter({});
    expect(() => writer.write(area(44, 10, 10, 0))).not.toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * §5.2 — what an overlay reads off the pane
 * ------------------------------------------------------------------ */

/**
 * Teaches the fake DOM's style objects `setProperty`, which the harness's plain record does not
 * have, and logs every write (the theme plugin's preset test shims the same member the same way).
 * Installed before `Gantt.create()`, because the renderer creates its pane — and publishes the safe
 * area for the first time — inside `setup()`.
 */
function instrumentInlineProperties(dom: DomHarness): { writes: [FakeElement, string, string][] } {
  const writes: [FakeElement, string, string][] = [];
  const create = dom.document.createElement.bind(dom.document);
  dom.document.createElement = (tag: string): FakeElement => {
    const element = create(tag);
    const style = element.style as unknown as Record<string, unknown>;
    style["setProperty"] = (name: string, value: string): void => {
      writes.push([element, name, value]);
      (element.style as Record<string, string>)[name] = value;
    };
    return element;
  };
  return { writes };
}

/** The four published lengths, as an overlay's `var()` would resolve them. */
function published(pane: FakeElement): Record<string, string | undefined> {
  const style = pane.style as Record<string, string | undefined>;
  return {
    top: style[SAFE_AREA_PROPERTIES.top],
    right: style[SAFE_AREA_PROPERTIES.right],
    bottom: style[SAFE_AREA_PROPERTIES.bottom],
    left: style[SAFE_AREA_PROPERTIES.left],
  };
}

/** The timeline header band of the default composition, as a strip whose size a test can move. */
const header = (box: { size: number }): InsetContribution => ({
  side: "top",
  order: 0,
  get size() {
    return box.size;
  },
});

function start(...args: Parameters<typeof boot>): Booted {
  booted = boot(...args);
  return booted;
}

describe("the pane's published `--sg-safe-*`", () => {
  it("publishes the four lengths before the first paint pass", () => {
    const log = { writes: [] as [FakeElement, string, string][] };
    const { pane, dom } = start(
      [probe((ctx) => ctx.contribute("renderer/insets", header({ size: 44 })))],
      { width: 1440, height: 900 },
      undefined,
      (harness) => {
        log.writes = instrumentInlineProperties(harness).writes;
      },
    );

    // No frame has run yet: the values are already there for an overlay mounted in the same pass.
    expect(dom.pendingFrames()).toBeGreaterThan(0);
    expect(published(pane)).toEqual({ top: "44px", right: "10px", bottom: "10px", left: "0px" });
    // All four are written when the pane is laid out for the first time — the renderer's own
    // `setup()`, before the contributing plugin has even started — and the band the header then
    // reserves rewrites that one property alone.
    expect(log.writes.filter(([element]) => element === pane).map(([, name]) => name)).toEqual([
      "--sg-safe-top",
      "--sg-safe-right",
      "--sg-safe-bottom",
      "--sg-safe-left",
      "--sg-safe-top",
    ]);
  });

  it("moves with the header band as it appears and then resizes", () => {
    const box = { size: 0 };
    const { pane, gantt, dom } = start(
      [probe((ctx) => ctx.contribute("renderer/insets", header(box)))],
      { width: 1440, height: 900 },
      undefined,
      instrumentInlineProperties,
    );
    dom.flushFrames();
    expect(published(pane).top).toBe("0px");

    // The header band appears (a timeline scale that only knows its height once it has measured).
    box.size = 44;
    gantt.service("stargantt.view").refreshInsets();
    expect(published(pane).top).toBe("44px");

    // …and then grows a second row of scale labels.
    box.size = 64;
    gantt.service("stargantt.view").refreshInsets();
    expect(published(pane)).toEqual({ top: "64px", right: "10px", bottom: "10px", left: "0px" });
  });

  it("adds a bottom strip to the bottom bar's reservation", () => {
    const { pane, dom } = start(
      [
        probe((ctx) => {
          ctx.contribute("renderer/insets", header({ size: 44 }));
          ctx.contribute("renderer/insets", { side: "bottom", order: 0, size: 60 });
        }),
      ],
      { width: 1440, height: 900 },
      undefined,
      instrumentInlineProperties,
    );
    dom.flushFrames();
    expect(published(pane)).toEqual({ top: "44px", right: "10px", bottom: "70px", left: "0px" });
  });

  it("holds the scrollbar reservation while the content fits and no bar is showing", () => {
    // The reservation is static, so an overlay is not jumped on the moment content
    // starts to overflow.
    const { pane, dom } = start(
      [
        probe((ctx) => {
          ctx.contribute("renderer/insets", header({ size: 44 }));
          ctx.contribute("renderer/contentExtent", {
            id: "test.fits",
            measure: () => ({ width: 100, height: 100 }),
          });
        }),
      ],
      { width: 1440, height: 900 },
      undefined,
      instrumentInlineProperties,
    );
    dom.flushFrames();

    const bars = pane.children.filter((c) => c.className.includes("sg-scrollbar"));
    expect(bars).toHaveLength(2);
    expect(bars.map((bar) => bar.style["display"])).toEqual(["none", "none"]);
    expect(published(pane)).toEqual({ top: "44px", right: "10px", bottom: "10px", left: "0px" });
  });

  it("publishes the reservation on the left in an RTL composition, where the bar hugs that edge", () => {
    const { pane, dom } = start(
      [
        probe((ctx) => {
          ctx.contribute("renderer/insets", header({ size: 44 }));
          // Enough content to show the vertical bar, so the mirrored placement is observable.
          ctx.contribute("renderer/contentExtent", {
            id: "test.tall",
            measure: () => ({ height: 5000 }),
          });
        }),
      ],
      { width: 1440, height: 900 },
      { direction: "rtl" },
      instrumentInlineProperties,
    );
    dom.flushFrames();
    expect(published(pane)).toEqual({ top: "44px", right: "0px", bottom: "10px", left: "10px" });

    // The bar really is on that edge: §6.1 overrides the stylesheet's physical `right` inline.
    const vertical = pane.children.find((c) => c.className.includes("sg-scrollbar--vertical"));
    expect(vertical?.style["display"]).toBe("block");
    expect(vertical?.style["left"]).toBe("2px");
    expect(vertical?.style["right"]).toBe("auto");
  });

  it("reserves nothing for the bars with `scrollbar: false` under RTL either", () => {
    const { pane, dom } = start(
      [probe((ctx) => ctx.contribute("renderer/insets", header({ size: 44 })))],
      { width: 1440, height: 900 },
      { direction: "rtl", scrollbar: false },
      instrumentInlineProperties,
    );
    dom.flushFrames();
    expect(published(pane)).toEqual({ top: "44px", right: "0px", bottom: "0px", left: "0px" });
  });

  it("publishes the RTL lengths unchanged at the 720×540 viewport floor", () => {
    const { pane, dom } = start(
      [probe((ctx) => ctx.contribute("renderer/insets", header({ size: 44 })))],
      { width: 720, height: 540 },
      { direction: "rtl" },
      instrumentInlineProperties,
    );
    dom.flushFrames();
    expect(published(pane)).toEqual({ top: "44px", right: "0px", bottom: "10px", left: "10px" });
  });

  it("pins the direction at creation: the service reports it and offers no way to change it", () => {
    // §6.1 — `direction` is construction-time only, which is what lets the safe area read it from
    // the options object instead of tracking it. A host that wants to flip it re-creates the chart.
    const { gantt, dom, pane } = start(
      [probe((ctx) => ctx.contribute("renderer/insets", header({ size: 44 })))],
      { width: 1440, height: 900 },
      { direction: "rtl" },
      instrumentInlineProperties,
    );
    dom.flushFrames();
    const service = gantt.service("stargantt.view");
    expect(service.direction()).toBe("rtl");
    expect(Object.keys(service)).not.toContain("setDirection");

    // Anything that re-lays out the pane republishes the same direction-dependent values.
    service.refreshInsets();
    pane.rect = { left: 0, top: 0, width: 900, height: 700 };
    dom.triggerResizeObservers();
    dom.flushFrames();
    expect(published(pane)).toEqual({ top: "44px", right: "0px", bottom: "10px", left: "10px" });
  });

  it("reserves nothing for the bars with `scrollbar: false`", () => {
    const { pane, dom } = start(
      [probe((ctx) => ctx.contribute("renderer/insets", header({ size: 44 })))],
      { width: 1440, height: 900 },
      { scrollbar: false },
      instrumentInlineProperties,
    );
    dom.flushFrames();
    expect(published(pane)).toEqual({ top: "44px", right: "0px", bottom: "0px", left: "0px" });
  });

  it("publishes the same lengths at the 720×540 viewport floor, leaving a 486px-tall safe area", () => {
    const { pane, dom } = start(
      [probe((ctx) => ctx.contribute("renderer/insets", header({ size: 44 })))],
      { width: 720, height: 540 },
      undefined,
      instrumentInlineProperties,
    );
    dom.flushFrames();

    const values = published(pane);
    expect(values).toEqual({ top: "44px", right: "10px", bottom: "10px", left: "0px" });
    // What §5.1's floor rule promises an overlay: 540 − 44 header − 10 reservation.
    expect(540 - Number.parseFloat(values.top ?? "") - Number.parseFloat(values.bottom ?? "")).toBe(
      486,
    );
  });

  it("does not depend on the pane's width, which the chart-pane minimum can clamp", () => {
    const { pane, dom } = start(
      [probe((ctx) => ctx.contribute("renderer/insets", header({ size: 44 })))],
      { width: 720, height: 540 },
      undefined,
      instrumentInlineProperties,
    );
    dom.flushFrames();
    const before = published(pane);

    // The pane squeezed down to `--sg-chart-min-width`.
    pane.rect = { left: 0, top: 0, width: 240, height: 540 };
    dom.triggerResizeObservers();
    expect(published(pane)).toEqual(before);
  });

  it("rewrites nothing on a resize that leaves the bands where they were", () => {
    const log = { writes: [] as [FakeElement, string, string][] };
    const { pane, dom } = start(
      [probe((ctx) => ctx.contribute("renderer/insets", header({ size: 44 })))],
      { width: 1440, height: 900 },
      undefined,
      (harness) => {
        log.writes = instrumentInlineProperties(harness).writes;
      },
    );
    dom.flushFrames();
    const before = log.writes.length;

    pane.rect = { left: 0, top: 0, width: 1200, height: 700 };
    dom.triggerResizeObservers();
    dom.flushFrames();
    expect(log.writes.length).toBe(before);
    expect(published(pane).top).toBe("44px");
  });

  it("lives on the chart pane, not on the chart root that `ThemeService.get` reads", () => {
    // These are outputs of the renderer's layout, not theme tokens — a host reading the
    // root's computed style (which is what the theme service does) must not find them.
    const { pane, dom } = start(
      [probe((ctx) => ctx.contribute("renderer/insets", header({ size: 44 })))],
      { width: 1440, height: 900 },
      undefined,
      instrumentInlineProperties,
    );
    dom.flushFrames();

    expect(published(pane).top).toBe("44px");
    const root = dom.root.style as Record<string, string | undefined>;
    for (const name of Object.values(SAFE_AREA_PROPERTIES)) {
      expect(root[name]).toBeUndefined();
    }
  });
});
