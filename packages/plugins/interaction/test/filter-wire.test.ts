// @vitest-environment happy-dom
/**
 * `wireFilter` — the `stargantt.filter` service, its store's shape and effective-change
 * publication, the `rows/height` contribution, the `overlay-corner` slot claim and fallback, config
 * gating (§6.8 presence semantics), and the toolbar's `lifecycle/ready` mount. A real
 * `@stargantt/plugin-data-store` is composed (not a double) so `data.load()` / the `tasks` store
 * behave exactly as production; `view` / `timeline` / `theme` / `rows` / `grid` / `task-bars` — the
 * services `setup()` reads unconditionally but the filter feature never touches — are minimal
 * doubles, reusing `bars` / `rowsOf` from the shared `test/_fakes.ts`.
 *
 * `lifecycle/ready` fires synchronously inside `Gantt.create()` (core `host.ts`), after every
 * plugin's `setup()` has run — so by the time `createTestHost` / `boot()` below returns, a
 * `filterSearch` composition's toolbar (mounted from that same event) is already in the DOM; no
 * test needs to fire the event itself.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createTestHost, mockStore } from "@stargantt/sdk";
import type { AnyPlugin, PluginContext } from "@stargantt/core";
import { dataStore } from "@stargantt/plugin-data-store";
import type { Task } from "@stargantt/plugin-data-store";
import { interaction } from "../src/index";
import type { InteractionConfig } from "../src/index";
import type { FilterService, FilterState } from "../src/internal/filter/types";
import { bars, rowsOf } from "./_fakes";
import { filterSampleData } from "./_filter-fakes";

/**
 * A structural stand-in for one of `interaction`'s hard `dependsOn` plugin ids: `_resolve()`
 * requires an actual registered plugin under that id (independent of which plugin's `ctx.provide`
 * a service comes from), so the real service objects are supplied separately through
 * `createTestHost`'s `services` mock — its synthetic provider is auto-added to every plugin's
 * `dependsOn`, which is what lets `ctx.use()` resolve them.
 */
function stub(id: string): AnyPlugin {
  return { meta: { id }, setup(): void {} };
}

/** The service doubles every boot needs regardless of what the test itself exercises. */
function baseServices(pane: HTMLElement): Record<string, unknown> {
  return {
    "stargantt.view": {
      chartPaneElement: () => pane,
      invalidate: () => {},
      viewport: () => ({ scrollLeft: 0, scrollTop: 0, width: 800, height: 600 }),
      scrollTo: () => {},
    },
    "stargantt.timeline": {
      tToX: (t: number) => t,
      xToT: (x: number) => x,
      pxPerMs: 1,
      zoomLevel: mockStore({ id: "day", pxPerDay: 86.4, scales: [{ unit: "day", format: () => "" }] }),
      requestOriginExtension: () => {},
      releaseOriginExtension: () => {},
    },
    "stargantt.theme": { get: () => "" },
    "stargantt.rows": rowsOf({ order: [] }),
    "stargantt.grid": { setSelected: () => {} },
    "stargantt.task-bars": bars([]),
  };
}

type Recorder = { faults: unknown[]; rowsInvalidated: number };

/** Boots a real core: the real data store, the interaction plugin, and doubles for the rest. */
function boot(
  config: InteractionConfig = {},
  extra: AnyPlugin[] = [],
): {
  host: ReturnType<typeof createTestHost>;
  ctx: PluginContext;
  pane: HTMLElement;
  rec: Recorder;
  /** The composed `rows/height` resolver, or `undefined` if nothing contributed it. */
  heightOf(id: string, defaultHeight?: number): number | undefined;
  loadSample(): void;
} {
  const pane = document.createElement("div");
  document.body.appendChild(pane);
  const rec: Recorder = { faults: [], rowsInvalidated: 0 };

  let heightResolver: ((task: Readonly<Task>, defaultHeight: number) => number) | undefined;
  // Stands in for tree-grid's own `rows/height` extension-point declaration (tree-grid itself is
  // not composed here), mirroring exactly its reduce semantics — each
  // contribution refines the height resolved so far, declining with `undefined`.
  const heightProbe: AnyPlugin = {
    meta: { id: "test.height-probe" },
    setup(ctx): void {
      const point = ctx.defineExtensionPoint("rows/height", (inputs) => (task, defaultHeight) =>
        inputs.reduce((h, fn) => fn(task, h) ?? h, defaultHeight),
      );
      heightResolver = (task, defaultHeight) => point.get()(task, defaultHeight);
      // Stands in for tree-grid's own `view/rowsInvalidate` command handler, so the filter
      // feature's dispatch of it is observable.
      ctx.registerCommand("view/rowsInvalidate", () => {
        rec.rowsInvalidated += 1;
      });
    },
  };

  const host = createTestHost({
    element: document.createElement("div"),
    plugins: [
      dataStore(),
      stub("stargantt.view"),
      stub("stargantt.tree-grid"),
      stub("stargantt.task-bars"),
      heightProbe,
      interaction(config),
      ...extra,
    ],
    services: baseServices(pane),
  });
  host.host.on("core/pluginError", (e) => rec.faults.push(e));

  return {
    host,
    ctx: host.ctxOf("stargantt.interaction"),
    pane,
    rec,
    heightOf: (id, defaultHeight = 28) => {
      const data = host.host.service("stargantt.data");
      const task = data.getTask(id);
      if (task === undefined || heightResolver === undefined) return undefined;
      return heightResolver(task, defaultHeight);
    },
    loadSample() {
      const data = host.host.service("stargantt.data");
      const { tasks, resources, assignments } = filterSampleData();
      data.load({
        tasks: [...tasks],
        resources: [...(resources ?? [])],
        assignments: [...(assignments ?? [])],
      });
    },
  };
}

let current: ReturnType<typeof boot> | undefined;
afterEach(() => {
  current?.host.dispose();
  current = undefined;
});

describe("config gating (§6.8 presence semantics)", () => {
  it("provides no `stargantt.filter` service when the nest is omitted", () => {
    current = boot();
    expect(current.host.host.getService("stargantt.filter")).toBeUndefined();
  });

  it("provides the service, inert, when the nest is present but empty", () => {
    current = boot({ filterSearch: {} });
    current.loadSample();
    const filter = current.host.host.service("stargantt.filter") as FilterService;
    expect(filter).toBeDefined();
    expect(filter.state.get()).toEqual({ query: "", criteria: null, active: false, matchCount: 0 });
    // Inert by default: no contribution hides anything.
    expect(current.heightOf("a1")).toBe(28);
  });

  it("mounts no toolbar DOM when searchBox/filterPanel are both left off", () => {
    current = boot({ filterSearch: {} });
    expect(current.pane.querySelector(".sg-filter-toolbar")).toBeNull();
  });
});

describe("the `stargantt.filter` store: shape and effective-change publication", () => {
  it("publishes query/criteria/active/matchCount, only on an effective setQuery", () => {
    current = boot({ filterSearch: {} });
    current.loadSample();
    const filter = current.host.host.service("stargantt.filter") as FilterService;
    const seen: FilterState[] = [];
    current.ctx.own(filter.state.subscribe((next) => seen.push(next)));

    filter.setQuery("   "); // whitespace-only, and the query is already "": no-op
    expect(seen).toHaveLength(0);

    filter.setQuery("wireframes");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ query: "wireframes", criteria: null, active: true, matchCount: 1 });

    filter.setQuery("wireframes"); // exact repeat: still a no-op
    expect(seen).toHaveLength(1);

    filter.clear();
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual({ query: "", criteria: null, active: false, matchCount: 6 });
  });

  it("always publishes on setCriteria, even to the same value", () => {
    current = boot({ filterSearch: {} });
    current.loadSample();
    const filter = current.host.host.service("stargantt.filter") as FilterService;
    let count = 0;
    current.ctx.own(filter.state.subscribe(() => (count += 1)));
    filter.setCriteria({ resources: ["r2"] });
    filter.setCriteria({ resources: ["r2"] });
    expect(count).toBe(2);
  });

  it("dispatches `view/rowsInvalidate` on every effective change, not on a no-op setQuery", () => {
    current = boot({ filterSearch: {} });
    current.loadSample();
    const filter = current.host.host.service("stargantt.filter") as FilterService;
    const before = current.rec.rowsInvalidated;
    filter.setQuery("wireframes");
    expect(current.rec.rowsInvalidated).toBe(before + 1);
    // The query is already "wireframes": whitespace normalizes to the same value, so this is a
    // no-op and must not dispatch again.
    filter.setQuery("wireframes  ");
    expect(current.rec.rowsInvalidated).toBe(before + 1);
  });
});

describe("row hiding through `rows/height`", () => {
  it("declines every row while inactive", () => {
    current = boot({ filterSearch: {} });
    current.loadSample();
    for (const id of ["a", "a1", "a2", "b", "b1", "b2"]) {
      expect(current.heightOf(id)).toBe(28);
    }
  });

  it("hides non-matching rows (height 0) and keeps ancestors of matches", () => {
    current = boot({ filterSearch: {} });
    current.loadSample();
    const filter = current.host.host.service("stargantt.filter") as FilterService;
    filter.setQuery("wireframes");
    expect(current.heightOf("a1")).toBe(28);
    expect(current.heightOf("a")).toBe(28); // ancestor kept for context
    expect(current.heightOf("a2")).toBe(0);
    expect(current.heightOf("b")).toBe(0);
  });

  it("recomputes matchCount and re-hides after a data change", () => {
    current = boot({ filterSearch: {} });
    current.loadSample();
    const filter = current.host.host.service("stargantt.filter") as FilterService;
    filter.setQuery("wireframes");
    expect(filter.state.get().matchCount).toBe(1);
    current.host.host.dispatch("task/update", { id: "b1", after: { name: "API wireframes" } });
    expect(filter.state.get().matchCount).toBe(2);
    expect(current.heightOf("b1")).toBe(28);
  });

  it("applies a query set before the first data.load()", () => {
    current = boot({ filterSearch: {} });
    const filter = current.host.host.service("stargantt.filter") as FilterService;
    filter.setQuery("wireframes");
    expect(filter.state.get().matchCount).toBe(0);
    current.loadSample();
    expect(filter.state.get().active).toBe(true);
    expect(filter.state.get().matchCount).toBe(1);
    expect(current.heightOf("a1")).toBe(28);
    expect(current.heightOf("b1")).toBe(0);
  });
});

// The corner→CSS mapping (`slotStyles`) and the grant→corner decision (`resolveCorner`) are
// covered as pure data in `filter-toolbar.test.ts` — asserting on the mounted element's resolved
// `.style.top`/`.style.right` here would depend on the test DOM's CSSOM accepting
// `calc(var(--x, 0px) + 8px)` for offset properties, which the pinned happy-dom (20.11.2) silently
// drops (confirmed directly: `el.style.top = "calc(var(--x) + 8px)"` leaves `el.style.top === ""`
// and `el.style.cssText`/`getAttribute("style")` never see it either) — a real browser has no such
// issue. What is proven here instead is that the *claim itself* happens, for the right group/slot,
// by having a plugin registered to run strictly after interaction (a `dependsOn` edge) attempt the
// same claim from its own `lifecycle/ready` listener and observing the registry's own refusal.
describe("the corner slot claim", () => {
  it("mounts the toolbar's DOM when the nest requests it", () => {
    current = boot({ filterSearch: { searchBox: true } });
    expect(current.pane.querySelector(".sg-filter-toolbar")).not.toBeNull();
  });

  it("claims the top-right overlay-corner slot: a later claimant is refused with the bottom-left alternative", () => {
    let grant: import("@stargantt/core").SlotGrant | undefined;
    const lateClaimant: AnyPlugin = {
      meta: { id: "test.late-claimant", dependsOn: ["stargantt.interaction"] },
      setup(ctx): void {
        // Runs from its own `lifecycle/ready` listener too, so registration order (both plugins'
        // listeners fire during the same, single, synchronous `lifecycle/ready` emit) decides who
        // claims first — and this plugin's `setup()`, hence its listener registration, is forced to
        // run after interaction's by the `dependsOn` edge above.
        ctx.on("lifecycle/ready", () => {
          grant = ctx.claimSlot("overlay-corner", "top-right", [
            "top-left",
            "top-right",
            "bottom-left",
            "bottom-right",
          ]);
        });
      },
    };
    current = boot({ filterSearch: { searchBox: true } }, [lateClaimant]);
    expect(grant?.granted).toBe(false);
    expect(grant?.alternative).toBe("bottom-left");
  });

  it("claims the slot during setup(), before lifecycle/ready (major M2 fix)", () => {
    // Unlike the test above (whose late claimant also defers to its own `lifecycle/ready`, so
    // `dependsOn`-forced *listener registration* order alone already decided the winner even before
    // the M2 fix), this plugin claims directly inside its own `setup()` — no `lifecycle/ready` at
    // all. `dependsOn` only forces this plugin's whole `setup()` to run strictly after
    // interaction's `setup()` returns, which is still well before the single, later `lifecycle/ready`
    // emission every plugin's listener fires on. Before the fix — the claim deferred to interaction's
    // own `lifecycle/ready` listener — this setup()-time claim would run FIRST and win; after the
    // fix, interaction has already claimed the slot inside its own `setup()`, so this one loses.
    let grant: import("@stargantt/core").SlotGrant | undefined;
    const laterPlugin: AnyPlugin = {
      meta: { id: "test.later-plugin", dependsOn: ["stargantt.interaction"] },
      setup(ctx): void {
        grant = ctx.claimSlot("overlay-corner", "top-right", [
          "top-left",
          "top-right",
          "bottom-left",
          "bottom-right",
        ]);
      },
    };
    current = boot({ filterSearch: { searchBox: true } }, [laterPlugin]);
    expect(grant?.granted).toBe(false);
    expect(grant?.alternative).toBe("bottom-left");
  });

  it("claims nothing when the toolbar is not composed", () => {
    let grant: import("@stargantt/core").SlotGrant | undefined;
    const lateClaimant: AnyPlugin = {
      meta: { id: "test.late-claimant", dependsOn: ["stargantt.interaction"] },
      setup(ctx): void {
        ctx.on("lifecycle/ready", () => {
          grant = ctx.claimSlot("overlay-corner", "top-right", ["top-left", "top-right"]);
        });
      },
    };
    // No `searchBox` / `filterPanel`: the toolbar never mounts, so it never claims the slot.
    current = boot({ filterSearch: {} }, [lateClaimant]);
    expect(grant?.granted).toBe(true);
  });
});

describe("config: fields and views (§6.8)", () => {
  it("replaces the built-in fields when `fields` is usable", () => {
    current = boot({
      filterSearch: {
        filterPanel: true,
        fields: [{ id: "phase", label: "Phase", value: (t: Readonly<Task>) => String(t.id) }],
      },
    });
    current.loadSample();
    const button = current.pane.querySelector<HTMLElement>(".sg-filter-button");
    button?.dispatchEvent(new Event("click"));
    const sections = [...current.pane.querySelectorAll<HTMLElement>(".sg-filter-panel-section")];
    expect(sections.map((s) => s.getAttribute("data-field-id"))).toEqual(["phase"]);
  });

  it("seeds initial named views from config", () => {
    current = boot({ filterSearch: { views: { bob: { criteria: { resources: ["r2"] } } } } });
    current.loadSample();
    const filter = current.host.host.service("stargantt.filter") as FilterService;
    expect(filter.applyView("bob")).toBe(true);
    expect(filter.state.get().matchCount).toBe(1);
  });
});

describe("faults", () => {
  it("reports a throwing predicate against this plugin's id, latched after one report", () => {
    current = boot({ filterSearch: {} });
    current.loadSample();
    const filter = current.host.host.service("stargantt.filter") as FilterService;
    filter.setCriteria({
      predicate: () => {
        throw new Error("boom");
      },
    });
    expect(filter.state.get().matchCount).toBe(6); // the throwing predicate is dropped
    const faults = current.rec.faults as { pluginId: string }[];
    expect(faults.some((f) => f.pluginId === "stargantt.interaction")).toBe(true);
  });
});
