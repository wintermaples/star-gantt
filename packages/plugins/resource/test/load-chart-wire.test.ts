// @vitest-environment happy-dom
/**
 * The load-chart area's wiring (docs/specs/plugins/resource.md §3.6 / §4.2 / §1.2): the two
 * `view/bottomPanes` strips (`stargantt.load-chart:total` order 0, `stargantt.load-chart:lanes`
 * order 1), the §1.2 strip height-setter semantics `UtilizationService` forwards to this area's own
 * `setHeight` closure (non-finite/negative ignored, exactly 0 releases, restore-last-height vs the
 * roster formula), Σ mode's per-resource hook engagement, and the heatmap card's `overlay-corner`
 * claim — against a real `@stargantt/core` host and a real data store.
 *
 * The view plugin is stubbed rather than composed (the `view-wire.test.ts` convention, extended
 * here with the ThemeService/TimelineService members and the `ViewService.viewport`/
 * `chartPaneElement` load-chart itself reads): a stub keeps the seam honest, and the real
 * `ctx.claimSlot` arbitration runs unmodified against the real core host.
 */
import { collect, definePlugin } from "@stargantt/core";
import type { AnyPlugin, Disposable } from "@stargantt/core";
import { dataStore } from "@stargantt/plugin-data-store";
import type { Assignment, Task } from "@stargantt/plugin-data-store";
import type {
  BottomPaneContribution,
  BottomPaneElements,
  ThemeService,
  TimelineService,
  ViewService,
} from "@stargantt/plugin-view";
import { createTestHost } from "@stargantt/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { resource } from "../src/index";
import type { UtilizationService } from "../src/index";
import type { LoadChartConfig } from "../src/config";

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);
const TOTAL_ID = "stargantt.load-chart:total";
const LANES_ID = "stargantt.load-chart:lanes";

/** One frame of the SDK scheduler, awaited deterministically (never a fixed sleep). */
const frame = (): Promise<void> =>
  new Promise((done) => {
    globalThis.requestAnimationFrame(() => done());
  });

interface Strip {
  contribution: BottomPaneContribution;
  elements: BottomPaneElements;
  height: number;
}

interface Stubs {
  strips: Map<string, Strip>;
  scrollLeft: number;
  /** The visible chart width the load-chart area's `visibleSpan()` gates on. */
  viewportWidth: number;
  /** Every `--sg-load-*` / `--sg-rv-*` theme token the stub theme answers. */
  tokens: Record<string, string>;
  /** The chart pane element the heatmap card mounts against — set once `viewStub`'s own `setup()`
   *  runs (before any `lifecycle/ready` listener fires). */
  chartPane: HTMLElement;
}

function elementsFor(root: HTMLElement): BottomPaneElements {
  const make = (className: string): HTMLElement => {
    const e = root.ownerDocument.createElement("div");
    e.className = className;
    root.append(e);
    return e;
  };
  const pane = make("sg-bottom-pane");
  return {
    pane,
    gutter: make("sg-bottom-pane__gutter"),
    body: make("sg-bottom-pane__body"),
    trailing: make("sg-bottom-pane__trailing"),
  };
}

/**
 * Stands in for `stargantt.view`: the bottom region, the height command, the three services and the
 * chart pane element — everything `internal/load-chart/wire.ts` reads from `stargantt.view`.
 */
function viewStub(state: Stubs): AnyPlugin {
  return definePlugin({
    meta: { id: "stargantt.view" },
    setup(ctx) {
      const chartPane = ctx.root.ownerDocument.createElement("div");
      chartPane.className = "sg-chart-pane";
      ctx.root.appendChild(chartPane);
      state.chartPane = chartPane;

      const point = ctx.defineExtensionPoint(
        "view/bottomPanes",
        collect<BottomPaneContribution>(),
      );
      const theme: ThemeService = {
        get: (token: string) => state.tokens[token] ?? "",
        // Load-chart subscribes to a theme switch (to drop its resolved colours/font); a Store
        // stand-in that never fires is enough — this suite never exercises a theme change.
        tokens: { subscribe: (): Disposable => ({ dispose: () => undefined }) },
      } as unknown as ThemeService;
      const timeline: TimelineService = {
        // One pixel (content x unit) per day from the anchor, both directions, so the load-chart's
        // own `xToT`/`tToX` round-trip is trivial to reason about.
        tToX: (t: number) => (t - T0) / DAY,
        xToT: (x: number) => T0 + x * DAY,
        firstDayOfWeek: () => 1,
        zoomLevel: { get: () => ({}), subscribe: (): Disposable => ({ dispose: () => undefined }) },
      } as unknown as TimelineService;
      const view: ViewService = {
        viewport: {
          get: () => ({
            scrollLeft: state.scrollLeft,
            scrollTop: 0,
            width: state.viewportWidth,
            height: 200,
          }),
          subscribe: (): Disposable => ({ dispose: () => undefined }),
        },
        chartPaneElement: () => state.chartPane,
        reducedMotion: () => false,
      } as unknown as ViewService;
      ctx.provide("stargantt.theme", theme);
      ctx.provide("stargantt.timeline", timeline);
      ctx.provide("stargantt.view", view);
      ctx.registerCommand("view/setBottomPaneHeight", ({ id, height }) => {
        const strip = state.strips.get(id);
        if (strip === undefined || strip.height === height) return;
        strip.height = height;
        strip.contribution.onResize?.(height);
      });
      ctx.on("lifecycle/ready", () => {
        for (const contribution of point.get()) {
          const elements = elementsFor(ctx.root);
          state.strips.set(contribution.id, { contribution, elements, height: contribution.height });
          contribution.mount(elements);
        }
      });
    },
  });
}

interface Booted {
  stubs: Stubs;
  host: ReturnType<typeof createTestHost>;
  strip(id: string): Strip;
  utilization: UtilizationService;
}

let booted: Booted[] = [];

afterEach(() => {
  for (const b of booted) b.host.dispose();
  booted = [];
  document.body.innerHTML = "";
});

function boot(
  loadChart: LoadChartConfig,
  data?: {
    tasks?: Task[];
    resources?: { id: string; name: string; capacity?: number }[];
    assignments?: Assignment[];
  },
  viewportWidth = 30,
): Booted {
  const stubs: Stubs = {
    strips: new Map(),
    scrollLeft: 0,
    viewportWidth,
    tokens: {},
    chartPane: null as unknown as HTMLElement,
  };
  const element = document.createElement("div");
  document.body.append(element);
  const host = createTestHost({
    element,
    plugins: [dataStore(), viewStub(stubs), resource({ loadChart })],
  });
  if (data !== undefined) {
    host.host.service("stargantt.data").load({
      tasks: data.tasks ?? [],
      resources: data.resources ?? [],
      assignments: data.assignments ?? [],
    });
  }
  const result: Booted = {
    stubs,
    host,
    strip: (id) => {
      const strip = stubs.strips.get(id);
      if (strip === undefined) throw new Error(`the "${id}" strip was never contributed`);
      return strip;
    },
    utilization: host.host.service("stargantt.utilization"),
  };
  booted.push(result);
  return result;
}

function task(id: string, from: number, to: number): Task {
  return { id, parentId: null, name: id, start: T0 + from * DAY, end: T0 + to * DAY };
}

/* ================================================================== *
 * the two strip contributions
 * ================================================================== */

describe("the two strip contributions (§3.4 / §4.2)", () => {
  it("contributes total (order 0) and lanes (order 1) with the catalog's divider labels", () => {
    const b = boot({ total: true, lanes: true });
    expect(b.stubs.strips.size).toBe(2);
    const total = b.strip(TOTAL_ID);
    const lanes = b.strip(LANES_ID);
    expect(total.contribution.order).toBe(0);
    expect(lanes.contribution.order).toBe(1);
    expect(typeof total.contribution.mount).toBe("function");
    expect(typeof lanes.contribution.mount).toBe("function");
    expect(total.contribution.resizable).toBe(true);
    expect(lanes.contribution.resizable).toBe(true);
    expect(total.contribution.label).toBe("Resize load chart band");
    expect(lanes.contribution.label).toBe("Resize resource lanes");
  });

  it("honours `resizable: false` on both strips", () => {
    const b = boot({ total: true, lanes: true, resizable: false });
    expect(b.strip(TOTAL_ID).contribution.resizable).toBe(false);
    expect(b.strip(LANES_ID).contribution.resizable).toBe(false);
  });
});

/* ================================================================== *
 * §1.2 — the height-setter semantics (the M3 fix)
 * ================================================================== */

describe("setBandHeight / setLanesHeight (§1.2 — non-finite or negative is ignored)", () => {
  it("ignores a negative, NaN or Infinite setBandHeight — the band's height is unchanged", () => {
    const b = boot({ total: true });
    const before = b.utilization.bandHeight();
    expect(before).toBe(64); // the --sg-load-chart-height fallback, no theme token supplied
    b.utilization.setBandHeight(-5);
    expect(b.utilization.bandHeight()).toBe(before);
    expect(b.utilization.bandVisible()).toBe(true);
    b.utilization.setBandHeight(Number.NaN);
    expect(b.utilization.bandHeight()).toBe(before);
    b.utilization.setBandHeight(Number.POSITIVE_INFINITY);
    expect(b.utilization.bandHeight()).toBe(before);
    expect(b.utilization.bandVisible()).toBe(true);
  });

  it("setBandHeight(0) releases the band — hidden, height 0, never confused with 'ignored'", () => {
    const b = boot({ total: true });
    b.utilization.setBandHeight(0);
    expect(b.utilization.bandVisible()).toBe(false);
    expect(b.utilization.bandHeight()).toBe(0);
  });

  it("setBandHeight(positive) shows a hidden band AT exactly that height", () => {
    const b = boot({ total: false });
    expect(b.utilization.bandVisible()).toBe(false);
    b.utilization.setBandHeight(80);
    expect(b.utilization.bandVisible()).toBe(true);
    expect(b.utilization.bandHeight()).toBe(80);
  });

  it("ignores a negative, NaN or Infinite setLanesHeight — the lanes' height is unchanged", () => {
    const b = boot({ lanes: true }, { resources: [{ id: "r1", name: "Ann" }] });
    // Self-derived from the roster formula on load: min(96, 1 * 28) = 28.
    const before = b.utilization.lanesHeight();
    expect(before).toBe(28);
    b.utilization.setLanesHeight(-5);
    expect(b.utilization.lanesHeight()).toBe(before);
    b.utilization.setLanesHeight(Number.NaN);
    expect(b.utilization.lanesHeight()).toBe(before);
    b.utilization.setLanesHeight(Number.POSITIVE_INFINITY);
    expect(b.utilization.lanesHeight()).toBe(before);
    expect(b.utilization.lanesVisible()).toBe(true);
  });

  it("setLanesHeight(0) releases the lanes strip", () => {
    const b = boot({ lanes: true }, { resources: [{ id: "r1", name: "Ann" }] });
    b.utilization.setLanesHeight(0);
    expect(b.utilization.lanesVisible()).toBe(false);
    expect(b.utilization.lanesHeight()).toBe(0);
  });

  it("setLanesHeight(positive) shows hidden lanes AT exactly that height", () => {
    const b = boot({ lanes: false }, { resources: [{ id: "r1", name: "Ann" }] });
    expect(b.utilization.lanesVisible()).toBe(false);
    b.utilization.setLanesHeight(50);
    expect(b.utilization.lanesVisible()).toBe(true);
    expect(b.utilization.lanesHeight()).toBe(50);
  });
});

/* ================================================================== *
 * restore-last-height
 * ================================================================== */

describe("restore-last-height across a hide/show cycle", () => {
  it("band: the READER's last height is restored, not the token default", () => {
    const b = boot({ total: true });
    expect(b.utilization.bandHeight()).toBe(64); // the derived default, nobody's chosen height yet
    b.utilization.setBandHeight(120); // a reader-driven resize
    expect(b.utilization.bandHeight()).toBe(120);
    b.utilization.setBandVisible(false);
    expect(b.utilization.bandVisible()).toBe(false);
    expect(b.utilization.bandHeight()).toBe(0);
    b.utilization.setBandVisible(true);
    // Restored to the reader's 120 — not back to the 64px token default.
    expect(b.utilization.bandHeight()).toBe(120);
  });

  it("lanes: a NEVER manually-sized strip re-derives from the roster formula on every show", () => {
    const b = boot(
      { lanes: false },
      {
        resources: [
          { id: "r1", name: "A" },
          { id: "r2", name: "B" },
          { id: "r3", name: "C" },
        ],
      },
    );
    expect(b.utilization.lanesVisible()).toBe(false);
    // No explicit height set — `setLanesVisible(true)` alone lets the roster formula derive it:
    // min(96, 3 * 28) = 84.
    b.utilization.setLanesVisible(true);
    expect(b.utilization.lanesHeight()).toBe(84);
    b.utilization.setLanesVisible(false);
    expect(b.utilization.lanesHeight()).toBe(0);
    // Grow the roster while the lanes are hidden.
    b.host.host.dispatch("resource/add", { resource: { id: "r4", name: "D" } });
    b.utilization.setLanesVisible(true);
    // RE-derived against the new roster — min(96, 4 * 28) = 96 — never the stale 84: a
    // never-manually-sized strip is not "reader-sized" and so is not covered by restore-last-height.
    expect(b.utilization.lanesHeight()).toBe(96);
  });

  it("lanes: setLanesHeight is a manual resize that outlives the roster formula", () => {
    const b = boot(
      { lanes: true },
      {
        resources: [
          { id: "r1", name: "A" },
          { id: "r2", name: "B" },
          { id: "r3", name: "C" },
        ],
      },
    );
    expect(b.utilization.lanesHeight()).toBe(84); // self-derived on load, not yet manual
    b.utilization.setLanesHeight(50); // an explicit/reader-driven size
    expect(b.utilization.lanesHeight()).toBe(50);
    b.utilization.setLanesVisible(false);
    expect(b.utilization.lanesHeight()).toBe(0);
    // The roster formula would now derive 96 (min(96, 4 * 28)) were the strip not manually sized.
    b.host.host.dispatch("resource/add", { resource: { id: "r4", name: "D" } });
    b.utilization.setLanesVisible(true);
    // The manual 50 is restored verbatim — afterwards the roster formula never re-derives the
    // strip's height again.
    expect(b.utilization.lanesHeight()).toBe(50);
  });
});

/* ================================================================== *
 * Σ mode — a per-resource hook engages the sum-of-matrix band
 * ================================================================== */

describe("Σ mode (§3.6 — `resourceLoad`/`resourceCapacity` triggers the per-resource matrix band)", () => {
  it("labels the band with a duration-formatted peak, not a bare unit count", async () => {
    let calls = 0;
    const b = boot(
      {
        total: true,
        resourceLoad: (input) => {
          calls += 1;
          return input.allocated * 2;
        },
      },
      {
        resources: [{ id: "r1", name: "Ann" }],
        tasks: [task("t1", 0, 4)],
        assignments: [{ taskId: "t1", resourceId: "r1", units: 1 }],
      },
    );
    await frame();
    expect(calls).toBeGreaterThan(0);
    const band = b.strip(TOTAL_ID).elements.body.querySelector(".sg-load-chart");
    const label = band?.getAttribute("aria-label") ?? "";
    // valueKind: "durationMs" only under Σ mode — the built-in `bandLabel` prints the peak through
    // the `duration` catalog member ("1.5d", "4h", "30m", …), never as a bare number.
    expect(label).toMatch(/peak load \d+(\.\d+)?[dhms]\b/);
  });
});

/* ================================================================== *
 * the heatmap card — the overlay-corner claim
 * ================================================================== */

describe("the heatmap card (§3.6 / §4.2 — the `overlay-corner` claim)", () => {
  it("mounts uncontested, as a region card inside the chart pane", () => {
    const b = boot({ total: true, heatmap: true });
    const card = b.stubs.chartPane.querySelector(".sg-load-heatmap") as HTMLElement | null;
    expect(card).not.toBeNull();
    expect(card?.getAttribute("role")).toBe("region");
    expect(card?.getAttribute("aria-label")).toBe("Load heatmap");
    expect(card?.parentElement).toBe(b.stubs.chartPane);
  });

  it("wins the requested top-right corner outright, proven via the real core arbitration registry", () => {
    // happy-dom's CSSStyleDeclaration silently drops any length-valued property whose value
    // contains `var(...)` — confirmed empirically: `el.style.top = "calc(var(--x, 0px) + 8px)"`
    // (and the `setProperty`/`cssText` equivalents) all no-op, so the card's own inline `top`/
    // `right` cannot be read back in this test environment. `slotStyles()`'s exact per-corner
    // output (the top/right pair for "top-right", nothing for bottom/left) is already unit-tested
    // byte-for-byte in `load-chart-heatmap.test.ts`, independent of any DOM.
    //
    // What THIS suite proves instead is the seam that pure-function test can't reach: that this
    // instance's own `ctx.claimSlot("overlay-corner", "top-right", …)` call (`wire.ts`) actually
    // WINS the requested corner when nothing else competes. Verified by making a second,
    // independent claim against the SAME real core arbitration registry from a probe plugin
    // composed alongside it: the registry grants a slot to whoever asks first and reports
    // `granted: false` plus the lexicographically-smallest still-free corner to anyone asking
    // after (`packages/core/src/internal/arbitration.ts`'s `claimSlot`) — so a `granted: false`
    // here is only possible if the load-chart area's own claim already took "top-right" first.
    let probeGrant: { granted: boolean; alternative?: string } | undefined;
    const probe = definePlugin({
      // A hard dependency on the resource plugin's own id, so this probe's `setup()` — and so its
      // claim — runs strictly AFTER `wireLoadChart`'s own `ctx.claimSlot` call (topological order;
      // registration order alone does not guarantee this, since `stargantt.resource` and a
      // zero-dependency plugin can land in the same tier).
      meta: { id: "overlay-corner-probe", dependsOn: ["stargantt.resource"] },
      setup(ctx) {
        probeGrant = ctx.claimSlot("overlay-corner", "top-right", [
          "top-left",
          "top-right",
          "bottom-left",
          "bottom-right",
        ]);
      },
    });
    const stubs: Stubs = {
      strips: new Map(),
      scrollLeft: 0,
      viewportWidth: 30,
      tokens: {},
      chartPane: null as unknown as HTMLElement,
    };
    const element = document.createElement("div");
    document.body.append(element);
    const host = createTestHost({
      element,
      plugins: [
        dataStore(),
        viewStub(stubs),
        resource({ loadChart: { total: true, heatmap: true } }),
        probe,
      ],
    });
    booted.push({
      stubs,
      host,
      strip: () => {
        throw new Error("not used by this test");
      },
      utilization: host.host.service("stargantt.utilization"),
    });

    expect(probeGrant?.granted).toBe(false);
    expect(probeGrant?.alternative).toBe("bottom-left");
  });
});
