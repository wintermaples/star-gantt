/**
 * The merged plugin itself: identity, the three published services, the nine extension points, the
 * five commands, the two order claims, and the `dependsOn` / `ctx.use()` consistency check every
 * official plugin's suite runs.
 *
 * The per-module suites next door cover behaviour; this file covers what only exists once the six
 * modules are wired together as `stargantt.view`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Gantt, definePlugin } from "@stargantt/core";
import type { AnyPlugin, GanttInstance } from "@stargantt/core";
import { expectDepsConsistency } from "@stargantt/sdk";
import { dataStore } from "@stargantt/plugin-data-store";
import { view } from "../src/index";
import type { ViewConfig } from "../src/index";
import { createZoomAxis } from "../src/internal/timeline/zoom";
import { defaultZoomLevels } from "../src/internal/timeline/levels";
import { asElement, installDom } from "./_utils/index";
import type { DomHarness, DomOptions } from "./_utils/index";

/**
 * The service-id → provider-plugin-id map `expectDepsConsistency` needs: `ctx.use()` names service
 * ids while `dependsOn` names provider plugin ids, and the core exposes no way to map one to the
 * other at runtime.
 */
const SERVICE_PROVIDERS = { "stargantt.data": "stargantt.data-store" };

let dom: DomHarness | null = null;
let gantt: GanttInstance | null = null;
/** Set while a test has swapped a fake `document` onto the global for the headless helpers. */
let restoreDocument: (() => void) | null = null;

afterEach(() => {
  gantt?.dispose();
  gantt = null;
  dom?.restore();
  dom = null;
  restoreDocument?.();
  restoreDocument = null;
});

function boot(config?: ViewConfig, extra: AnyPlugin[] = [], options: DomOptions = {}): GanttInstance {
  dom = installDom(options);
  gantt = Gantt.create({
    element: asElement(dom.root),
    plugins: [dataStore(), view(config), ...extra],
  });
  return gantt;
}

/**
 * Publishes a fake `document` on the global for the length of one test.
 *
 * `sdk/testing`'s headless root is `document.createElement("div")` when a `document` exists and an
 * untyped stand-in when none does. The view plugin builds canvases and asks them for a 2d context
 * at `setup()`, which neither an untyped stand-in nor `happy-dom` can answer — `happy-dom`'s
 * `getContext("2d")` returns `null`. The recording harness can, so it stands in as the ambient
 * document here.
 */
function withFakeDocument(harness: DomHarness): void {
  const g = globalThis as unknown as Record<string, unknown>;
  const had = "document" in g;
  const saved = g["document"];
  g["document"] = harness.document;
  restoreDocument = (): void => {
    if (had) g["document"] = saved;
    else delete g["document"];
  };
}

describe("plugin identity", () => {
  it("is `stargantt.view` and hard-depends on the data store alone", () => {
    expect(view().meta.id).toBe("stargantt.view");
    expect(view().meta.dependsOn).toEqual(["stargantt.data-store"]);
    expect(view().meta.optional ?? []).toEqual([]);
  });

  it("is a factory: each call is a fresh plugin with the same id", () => {
    const a = view();
    const b = view({});
    expect(a).not.toBe(b);
    expect(a.meta.id).toBe(b.meta.id);
  });

  // docs/specs/architecture.md ch. 7 — the mechanical dependsOn / ctx.use() cross-check.
  //
  // The mock context this runs against records contributions, which this plugin needs: it seeds
  // the published zoom-level store from the `timeline/zoomLevels` point it both owns and
  // contributes the built-in ladder to, during `setup()`.
  it("declares exactly the dependencies its `ctx.use()` calls imply", () => {
    dom = installDom();
    withFakeDocument(dom);
    expectDepsConsistency(view(), SERVICE_PROVIDERS);
  });

  // The same property, proven against the real core instead of the mock context: the one service
  // the plugin uses is the one its `dependsOn` names, and dropping that provider is fatal rather
  // than silently degrading.
  it("cannot start without the provider its `dependsOn` names", () => {
    expect(Object.values(SERVICE_PROVIDERS)).toEqual(view().meta.dependsOn);
    dom = installDom();
    expect(() =>
      Gantt.create({ element: asElement(dom!.root), plugins: [view()] }),
    ).toThrow(/stargantt\.data-store/);
  });
});

describe("published services", () => {
  it("provides the view, timeline and theme services", () => {
    const host = boot();
    for (const key of ["stargantt.view", "stargantt.timeline", "stargantt.theme"] as const) {
      expect(host.getService(key)).toBeDefined();
    }
  });

  it("publishes the viewport, viewMode, zoomLevel and token stores", () => {
    const host = boot();
    const stores = [
      host.service("stargantt.view").viewport,
      host.service("stargantt.view").viewMode,
      host.service("stargantt.timeline").zoomLevel,
      host.service("stargantt.theme").tokens,
    ];
    for (const store of stores) {
      expect(typeof store.get).toBe("function");
      expect(typeof store.subscribe).toBe("function");
    }
  });

  it("reports the pane size as the viewport once the chart has laid out", () => {
    const host = boot(undefined, [], { width: 720, height: 540 });
    dom?.flushFrames();
    const vp = host.service("stargantt.view").viewport.get();
    expect(vp.width).toBe(720);
    expect(vp.scrollLeft).toBe(0);
    // The timeline header reserves a top band, so the paintable height is short of the pane's.
    expect(vp.height).toBeLessThan(540);
    expect(vp.height).toBeGreaterThan(0);
  });
});

describe("extension points", () => {
  // docs/specs/plugins/view.md — the nine points this plugin defines. Contributing to a key the
  // owner never defined would be buffered forever, so a contribution that reaches its consumer is
  // what proves the point exists.
  const POINTS = [
    "renderer/layers",
    "renderer/hitTest",
    "renderer/insets",
    "renderer/domOverlays",
    "renderer/contentExtent",
    "renderer/rowGeometry",
    "view/panes",
    "view/bottomPanes",
    "timeline/zoomLevels",
  ] as const;

  it("defines all nine, and every one accepts a third-party contribution", () => {
    expect(POINTS).toHaveLength(9);
    const contributed: string[] = [];
    const probe = definePlugin({
      meta: { id: "test.contributor", dependsOn: ["stargantt.view"] },
      setup(ctx) {
        ctx.contribute("renderer/layers", { id: "t", zIndex: 1000, draw: () => {} });
        ctx.contribute("renderer/hitTest", () => undefined);
        ctx.contribute("renderer/insets", { side: "bottom", order: 0, size: 12 });
        ctx.contribute("renderer/domOverlays", { id: "t", mount: () => {} });
        ctx.contribute("renderer/contentExtent", { id: "t", measure: () => ({ width: 1000 }) });
        ctx.contribute("renderer/rowGeometry", {
          rowCount: () => 3,
          rowAtY: (y) => Math.max(0, Math.min(2, Math.floor(y / 24))),
          yOf: (row) => row * 24,
          rowHeight: () => 24,
        });
        ctx.contribute("view/panes", {
          id: "t",
          side: "left",
          order: 0,
          initialWidth: 120,
          mount: () => contributed.push("view/panes"),
        });
        ctx.contribute("view/bottomPanes", {
          id: "t",
          order: 0,
          initialHeight: 40,
          mount: () => contributed.push("view/bottomPanes"),
        });
        ctx.contribute("timeline/zoomLevels", {
          id: "test-level",
          pxPerDay: 12,
          scales: [{ unit: "day", format: () => "d" }],
        });
      },
    });

    const host = boot(undefined, [probe]);
    dom?.flushFrames();

    // The two mount-on-ready points ran their contributions.
    expect(contributed).toEqual(["view/panes", "view/bottomPanes"]);
    // The contributed zoom level joined the composed ladder.
    expect(host.service("stargantt.timeline").levelMetrics().map((m) => m.id)).toContain(
      "test-level",
    );
    // The contributed content extent widened the scrollable range.
    host.service("stargantt.view").scrollTo({ scrollLeft: 100 });
    expect(host.service("stargantt.view").viewport.get().scrollLeft).toBeGreaterThan(0);
  });
});

describe("commands", () => {
  // docs/specs/plugins/view.md — the five commands, none of them undoable. An unregistered command
  // is a silent no-op in the core, so each is proven by its effect rather than by its presence.
  it("registers the two zoom commands", () => {
    const host = boot();
    const timeline = host.service("stargantt.timeline");
    const coarsest = timeline.levelMetrics().reduce((a, b) => (a.pxPerDay < b.pxPerDay ? a : b));
    timeline.setZoomLevel(coarsest.id);
    const before = timeline.zoomLevel.get().id;
    host.dispatch("timeline/zoomIn", {});
    expect(timeline.zoomLevel.get().id).not.toBe(before);
    host.dispatch("timeline/zoomOut", {});
    expect(timeline.zoomLevel.get().id).toBe(before);
  });

  it("registers the view-mode command and publishes the change through the store", () => {
    const seen: string[] = [];
    const pane = definePlugin({
      meta: { id: "test.pane", dependsOn: ["stargantt.view"] },
      setup(ctx) {
        ctx.contribute("view/panes", {
          id: "left",
          side: "left",
          order: 0,
          initialWidth: 200,
          mount: () => {},
        });
      },
    });
    const host = boot(undefined, [pane]);
    host.service("stargantt.view").viewMode.subscribe((next) => seen.push(next));

    host.dispatch("view/setViewMode", { mode: "grid" });
    host.dispatch("view/setViewMode", { mode: "grid" }); // already in effect: no notification
    host.dispatch("view/setViewMode", { mode: "gantt" });
    expect(seen).toEqual(["grid", "gantt"]);
    expect(host.service("stargantt.view").viewMode.get()).toBe("gantt");
  });

  it("registers the pane-toggle and bottom-pane-height commands as no-ops on unknown ids", () => {
    const host = boot();
    expect(() => host.dispatch("view/paneToggle", { id: "nope" })).not.toThrow();
    expect(() => host.dispatch("view/setBottomPaneHeight", { id: "nope", height: 80 })).not.toThrow();
  });
});

describe("claimOrder registrations", () => {
  // docs/specs/plugins/view.md — the two internalized line passes claim their render order in code.
  it("claims 10 for the grid lines and 55 for the today line", () => {
    const host = boot();
    const orders = host.orders("renderer/layers");
    expect(orders).toEqual([
      { key: "view:grid-lines", order: 10, pluginId: "stargantt.view" },
      { key: "view:today-line", order: 55, pluginId: "stargantt.view" },
    ]);
  });

  it("claims nothing for the today line when the pass is switched off", () => {
    const host = boot({ todayLine: false });
    expect(host.orders("renderer/layers").map((o) => o.key)).toEqual(["view:grid-lines"]);
  });

  it("claims nothing for the grid lines when every one of its passes is off", () => {
    const host = boot({
      gridLines: {
        vertical: "none",
        horizontal: false,
        rowStripes: false,
        nonWorkingDays: false,
        nonWorkingHours: false,
        zones: [],
        rowHover: false,
      },
      todayLine: false,
    });
    expect(host.orders("renderer/layers")).toEqual([]);
  });
});

// docs/specs/plugins/view.md — the time axis is host-free: `createZoomAxis` is the whole t↔x
// mapping and the whole zoom ladder, so both are pinned here with no DOM, no core and no plugin.
describe("headless time axis", () => {
  const ORIGIN = Date.UTC(2026, 0, 1);
  const levels = defaultZoomLevels();

  function axis(initialZoom?: string): ReturnType<typeof createZoomAxis> {
    return createZoomAxis({
      pluginId: "stargantt.view",
      origin: ORIGIN,
      ...(initialZoom === undefined ? {} : { initialZoom }),
      levels: () => levels,
      onZoomChanged: () => {},
      onAnchorScroll: () => {},
      onOriginChanged: () => {},
    });
  }

  it("maps t to x and back around the origin", () => {
    const a = axis("day");
    expect(a.tToX(ORIGIN)).toBe(0);
    expect(a.xToT(0)).toBe(ORIGIN);
    const oneDay = 86_400_000;
    expect(a.tToX(ORIGIN + oneDay)).toBeCloseTo(a.currentLevel().pxPerDay, 6);
    expect(a.xToT(a.tToX(ORIGIN + 3 * oneDay))).toBeCloseTo(ORIGIN + 3 * oneDay, 3);
  });

  it("stops at the ladder's two ends rather than running off it", () => {
    const byDensity = [...levels].sort((x, y) => x.pxPerDay - y.pxPerDay);
    const coarsest = byDensity[0]!;
    const finest = byDensity[byDensity.length - 1]!;

    const low = axis(coarsest.id);
    low.stepZoom("out", ORIGIN);
    expect(low.currentLevel().id).toBe(coarsest.id);

    const high = axis(finest.id);
    high.stepZoom("in", ORIGIN);
    expect(high.currentLevel().id).toBe(finest.id);
  });

  it("degrades an unknown initial zoom to the first registered level", () => {
    expect(axis("no-such-level").currentLevel().id).toBe(levels[0]!.id);
  });
});
