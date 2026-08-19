// @vitest-environment happy-dom
/**
 * The resource-view area's wiring (docs/specs/plugins/resource.md §3.4 / §4.2 / §5): the one
 * `view/bottomPanes` strip and its id / order / divider label, the boot height and the
 * `resourceView/toggled` edge, the `drag/lanes` contribution, and the one-transaction lane-drop
 * write path — against a real `@stargantt/core` host and a real data store.
 *
 * The view and interaction plugins are stubbed rather than composed: this suite is about what THIS
 * plugin contributes and dispatches, and a stub keeps the seam honest (only the declared
 * contribution shape is available to it).
 */
import { collect, definePlugin } from "@stargantt/core";
import type { AnyPlugin, Disposable } from "@stargantt/core";
import { dataStore } from "@stargantt/plugin-data-store";
import type { Assignment, Task } from "@stargantt/plugin-data-store";
import type { LaneDragProvider } from "@stargantt/plugin-interaction";
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
import type { ResourceViewConfig } from "../src/config";

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);
const PANE_ID = "stargantt.resource-view:panel";

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
  lanes(): LaneDragProvider | undefined;
  scrollLeft: number;
  /** Every `--sg-rv-*` token the stub theme answers. */
  tokens: Record<string, string>;
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

/** Stands in for `stargantt.view`: the bottom region, the height command and the three services. */
function viewStub(state: Stubs): AnyPlugin {
  return definePlugin({
    meta: { id: "stargantt.view" },
    setup(ctx) {
      const point = ctx.defineExtensionPoint(
        "view/bottomPanes",
        collect<BottomPaneContribution>(),
      );
      const theme: ThemeService = {
        get: (token: string) => state.tokens[token] ?? "",
      } as unknown as ThemeService;
      const timeline: TimelineService = {
        // One pixel per day from the anchor, so a segment's x is readable at a glance.
        tToX: (t: number) => (t - T0) / DAY,
        zoomLevel: { get: () => ({}), subscribe: (): Disposable => ({ dispose: () => undefined }) },
      } as unknown as TimelineService;
      const view: ViewService = {
        viewport: {
          get: () => ({ scrollLeft: state.scrollLeft, scrollTop: 0, width: 0, height: 0 }),
          subscribe: (): Disposable => ({ dispose: () => undefined }),
        },
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

/** Stands in for `stargantt.interaction`: the `first`-reduced `drag/lanes` point. */
function interactionStub(state: Stubs): AnyPlugin {
  return definePlugin({
    meta: { id: "stargantt.interaction" },
    setup(ctx) {
      const point = ctx.defineExtensionPoint<"drag/lanes">(
        "drag/lanes",
        (inputs) => inputs[0],
      );
      state.lanes = (): LaneDragProvider | undefined => point.get();
    },
  });
}

interface Booted {
  stubs: Stubs;
  host: ReturnType<typeof createTestHost>;
  strip(): Strip;
  toggles: { open: boolean; cause: string }[];
  transactions: { origin: string | undefined; ops: string[] }[];
}

let booted: Booted[] = [];

afterEach(() => {
  for (const b of booted) b.host.dispose();
  booted = [];
  document.body.innerHTML = "";
});

function boot(
  view: ResourceViewConfig | undefined,
  data?: { tasks?: Task[]; resources?: { id: string; name: string; capacity?: number }[]; assignments?: Assignment[] },
  poolResources?: { id: string; name: string; capacity?: number }[],
): Booted {
  const stubs: Stubs = {
    strips: new Map(),
    lanes: () => undefined,
    scrollLeft: 0,
    tokens: {},
  };
  const element = document.createElement("div");
  document.body.append(element);
  const host = createTestHost({
    element,
    plugins: [
      dataStore(),
      viewStub(stubs),
      interactionStub(stubs),
      resource({
        ...(view === undefined ? {} : { view }),
        pool: { resources: poolResources ?? [] },
      }),
    ],
  });
  const toggles: { open: boolean; cause: string }[] = [];
  host.host.on("resourceView/toggled", (e) => toggles.push(e));
  const transactions: { origin: string | undefined; ops: string[] }[] = [];
  host.host.on("data/didApplyTransaction", (e) => {
    transactions.push({
      origin: e.transaction.origin,
      ops: e.transaction.patches.map((p) => p.op),
    });
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
    strip: () => {
      const strip = stubs.strips.get(PANE_ID);
      if (strip === undefined) throw new Error("the resource-view strip was never contributed");
      return strip;
    },
    toggles,
    transactions,
  };
  booted.push(result);
  return result;
}

function task(id: string, from: number, to: number): Task {
  return { id, parentId: null, name: id, start: T0 + from * DAY, end: T0 + to * DAY };
}

/* ================================================================== *
 * presence and the strip contribution
 * ================================================================== */

describe("presence (§6 — an omitted nest is dormant)", () => {
  it("contributes no strip and no lane provider without the `view` nest", () => {
    const b = boot(undefined);
    expect(b.stubs.strips.has(PANE_ID)).toBe(false);
    expect(b.stubs.lanes()).toBeUndefined();
  });

  it("contributes both with the nest present, even an empty one", () => {
    const b = boot({});
    expect(b.stubs.strips.has(PANE_ID)).toBe(true);
    expect(b.stubs.lanes()).toBeDefined();
  });
});

describe("the strip (§3.4 / §4.2)", () => {
  it("is contributed at order -1 with the catalog's divider label", () => {
    const b = boot({});
    const { contribution } = b.strip();
    expect(contribution.id).toBe(PANE_ID);
    expect(contribution.order).toBe(-1);
    expect(contribution.label).toBe("Resize resource view");
    expect(contribution.resizable).toBe(true);
  });

  it("honours `resizable: false`", () => {
    expect(boot({ resizable: false }).strip().contribution.resizable).toBe(false);
  });

  it("boots released — height 0, no reserved pixel — unless startOpen", () => {
    expect(boot({}).strip().contribution.height).toBe(0);
    expect(boot({ startOpen: true }).strip().contribution.height).toBe(200);
  });

  it("derives the open height from --sg-rv-height at the moment it is asked for", () => {
    const stubs: Stubs = { strips: new Map(), lanes: () => undefined, scrollLeft: 0, tokens: {} };
    const element = document.createElement("div");
    document.body.append(element);
    const host = createTestHost({
      element,
      plugins: [
        dataStore(),
        definePlugin({
          meta: { id: "token-writer" },
          setup: () => {
            stubs.tokens["--sg-rv-height"] = "320px";
          },
        }),
        viewStub(stubs),
        interactionStub(stubs),
        resource({ view: { startOpen: true }, pool: {} }),
      ],
    });
    booted.push({
      stubs,
      host,
      strip: () => stubs.strips.get(PANE_ID) as Strip,
      toggles: [],
      transactions: [],
    });
    expect(stubs.strips.get(PANE_ID)?.contribution.height).toBe(320);
  });

  it("names itself as a region once mounted", () => {
    const b = boot({ startOpen: true });
    expect(b.strip().elements.pane.getAttribute("role")).toBe("region");
    expect(b.strip().elements.pane.getAttribute("aria-label")).toBe("Resource view");
  });
});

/* ================================================================== *
 * toggling
 * ================================================================== */

describe("toggling and resourceView/toggled (§3.4 / §5)", () => {
  it("emits nothing for the boot state, open or closed", () => {
    expect(boot({}).toggles).toEqual([]);
    expect(boot({ startOpen: true }).toggles).toEqual([]);
  });

  it("reports the shown edge when a host dispatches a positive height", () => {
    const b = boot({});
    b.host.host.dispatch("view/setBottomPaneHeight", { id: PANE_ID, height: 140 });
    expect(b.toggles).toEqual([{ open: true, cause: "api" }]);
  });

  it("reports the hidden edge when the strip is released at 0", () => {
    const b = boot({ startOpen: true });
    b.host.host.dispatch("view/setBottomPaneHeight", { id: PANE_ID, height: 0 });
    expect(b.toggles).toEqual([{ open: false, cause: "api" }]);
  });

  it("emits once per crossing, never per applied height", () => {
    const b = boot({ startOpen: true });
    b.host.host.dispatch("view/setBottomPaneHeight", { id: PANE_ID, height: 120 });
    b.host.host.dispatch("view/setBottomPaneHeight", { id: PANE_ID, height: 90 });
    expect(b.toggles).toEqual([]);
    b.host.host.dispatch("view/setBottomPaneHeight", { id: PANE_ID, height: 0 });
    b.host.host.dispatch("view/setBottomPaneHeight", { id: PANE_ID, height: 90 });
    expect(b.toggles).toEqual([
      { open: false, cause: "api" },
      { open: true, cause: "api" },
    ]);
  });

  it("empties the strip and forgets lane geometry on hide", async () => {
    const b = boot(
      { startOpen: true },
      {
        tasks: [task("t1", 0, 5)],
        resources: [{ id: "r1", name: "Ann" }],
        assignments: [{ taskId: "t1", resourceId: "r1", units: 1 }],
      },
    );
    await frame();
    const body = b.strip().elements.body;
    expect(body.querySelectorAll(".sg-resource-view__row")).toHaveLength(1);
    b.host.host.dispatch("view/setBottomPaneHeight", { id: PANE_ID, height: 0 });
    expect(body.querySelectorAll(".sg-resource-view__row")).toHaveLength(0);
    expect(b.stubs.lanes()?.laneAt(0)).toBeUndefined();
  });
});

/* ================================================================== *
 * painting
 * ================================================================== */

describe("painting (§3.4)", () => {
  const scenario = {
    tasks: [task("t1", 0, 4), task("t2", 2, 6)],
    resources: [
      { id: "r1", name: "Ann", capacity: 1 },
      { id: "r2", name: "Bob", capacity: 1 },
    ],
    assignments: [
      { taskId: "t1", resourceId: "r1", units: 1 },
      { taskId: "t2", resourceId: "r1", units: 1 },
      { taskId: "t2", resourceId: "r2", units: 0.5 },
    ] as Assignment[],
  };

  it("paints nothing while the strip is released", async () => {
    const b = boot({}, scenario);
    await frame();
    expect(b.strip().elements.body.querySelectorAll(".sg-resource-view__row")).toHaveLength(0);
  });

  it("paints one row per resource, with the overallocated one marked in text and data", async () => {
    const b = boot({ startOpen: true }, scenario);
    await frame();
    const body = b.strip().elements.body;
    const labels = [...body.querySelectorAll(".sg-resource-view__label")];
    expect(labels.map((e) => e.textContent)).toEqual(["Ann (overallocated)", "Bob"]);
    expect(labels[0]?.getAttribute("data-over")).toBe("true");
    expect(labels[1]?.getAttribute("data-over")).toBeNull();
  });

  it("places segments at tToX minus the chart's horizontal scroll", async () => {
    const b = boot({ startOpen: true }, scenario);
    b.stubs.scrollLeft = 1;
    await frame();
    const first = b.strip().elements.body.querySelector(".sg-resource-view__seg");
    expect((first as HTMLElement | null)?.style.left).toBe("-1px");
  });

  it("repaints after a data change, without the caller asking", async () => {
    const b = boot({ startOpen: true }, scenario);
    await frame();
    b.host.host.dispatch("resource/add", { resource: { id: "r3", name: "Cid" } });
    await frame();
    const labels = [...b.strip().elements.body.querySelectorAll(".sg-resource-view__label")];
    expect(labels.map((e) => e.textContent)).toEqual(["Ann (overallocated)", "Bob", "Cid"]);
  });

  it("lists pool-only resources too, ahead of the store's own", async () => {
    const b = boot({ startOpen: true }, scenario, [{ id: "p1", name: "Pooled", capacity: 2 }]);
    await frame();
    const labels = [...b.strip().elements.body.querySelectorAll(".sg-resource-view__label")];
    expect(labels.map((e) => e.textContent)).toEqual(["Pooled", "Ann (overallocated)", "Bob"]);
  });

  it("groups rows under the configured teams", async () => {
    const b = boot({ startOpen: true, teams: [{ name: "Core", members: ["r1"] }] }, scenario);
    await frame();
    const bands = [...b.strip().elements.body.querySelectorAll(".sg-resource-view__team")];
    expect(bands.map((e) => e.textContent?.split(":")[0])).toEqual(["Core", "Other resources"]);
  });

  it("reports a throwing projectOf once and falls back for the rest of the instance's life", async () => {
    const errors: unknown[] = [];
    const stubs: Stubs = { strips: new Map(), lanes: () => undefined, scrollLeft: 0, tokens: {} };
    const element = document.createElement("div");
    document.body.append(element);
    let calls = 0;
    const host = createTestHost({
      element,
      plugins: [
        dataStore(),
        viewStub(stubs),
        interactionStub(stubs),
        resource({
          pool: {},
          view: {
            startOpen: true,
            projectOf: () => {
              calls += 1;
              throw new Error("boom");
            },
          },
        }),
      ],
    });
    booted.push({
      stubs,
      host,
      strip: () => stubs.strips.get(PANE_ID) as Strip,
      toggles: [],
      transactions: [],
    });
    host.host.on("core/pluginError", (e) => errors.push(e));
    host.host.service("stargantt.data").load({
      tasks: [task("t1", 0, 4)],
      resources: [{ id: "r1", name: "Ann" }],
      assignments: [{ taskId: "t1", resourceId: "r1", units: 1 }],
    });
    await frame();
    // A second model build must not report again — and must not call the broken seam at all.
    host.host.dispatch("resource/add", { resource: { id: "r2", name: "Bob" } });
    await frame();
    expect(errors).toHaveLength(1);
    expect(calls).toBe(1);
    const segs = stubs.strips.get(PANE_ID)?.elements.body.querySelectorAll(".sg-resource-view__seg");
    // The strip still paints; the segment simply carries no project attribution.
    expect(segs?.[0]?.textContent).toBe("t1");
  });
});

/* ================================================================== *
 * the lane seam
 * ================================================================== */

describe("the drag/lanes provider (§4.2)", () => {
  const scenario = {
    tasks: [task("t1", 0, 4), task("shared", 0, 4)],
    resources: [
      { id: "r1", name: "Ann" },
      { id: "r2", name: "Bob" },
    ],
    assignments: [
      { taskId: "t1", resourceId: "r1", units: 0.5 },
      { taskId: "shared", resourceId: "r1", units: 0.5 },
      { taskId: "shared", resourceId: "r2", units: 0.5 },
    ] as Assignment[],
  };

  it("carries all four members, so interaction admits it", () => {
    const provider = boot({}).stubs.lanes();
    expect(typeof provider?.laneAt).toBe("function");
    expect(typeof provider?.reassign).toBe("function");
    expect(typeof provider?.highlightLane).toBe("function");
    expect(typeof provider?.laneOfTask).toBe("function");
  });

  it("answers undefined for laneAt while nothing has painted", () => {
    expect(boot({}, scenario).stubs.lanes()?.laneAt(10)).toBeUndefined();
  });

  it("declines laneOfTask for a task on no lane and for one on two", async () => {
    const b = boot({ startOpen: true }, scenario);
    await frame();
    expect(b.stubs.lanes()?.laneOfTask?.("shared")).toBeUndefined();
    expect(b.stubs.lanes()?.laneOfTask?.("nobody")).toBeUndefined();
  });

  it("marks and clears the drop-target lane", async () => {
    const b = boot({ startOpen: true }, scenario);
    await frame();
    const body = b.strip().elements.body;
    b.stubs.lanes()?.highlightLane?.("r2");
    expect(body.querySelectorAll("[data-target]").length).toBeGreaterThan(0);
    b.stubs.lanes()?.highlightLane?.(null);
    expect(body.querySelectorAll("[data-target]")).toHaveLength(0);
  });
});

/* ================================================================== *
 * the write path
 * ================================================================== */

describe("reassign (§3.4 — one lane drop, one undo step)", () => {
  const base = {
    tasks: [task("t1", 0, 4)],
    resources: [
      { id: "r1", name: "Ann" },
      { id: "r2", name: "Bob" },
    ],
    assignments: [{ taskId: "t1", resourceId: "r1", units: 0.5 }] as Assignment[],
  };

  const assignmentsOf = (b: Booted): readonly Assignment[] =>
    b.host.host.service("stargantt.data").query().assignmentsByTask.get("t1") ?? [];

  it("moves the assignment with its rate, in one transaction", () => {
    const b = boot({}, base);
    b.transactions.length = 0;
    b.stubs.lanes()?.reassign("t1", "r1", "r2");
    expect(assignmentsOf(b)).toEqual([{ taskId: "t1", resourceId: "r2", units: 0.5 }]);
    expect(b.transactions).toHaveLength(1);
    expect(b.transactions[0]?.ops).toEqual(["assignment/add", "assignment/remove"]);
    expect(b.transactions[0]?.origin).toMatch(/^stargantt\.resource\/reassign#/);
  });

  it("works while the strip is released — the write path reads the model, not the DOM", () => {
    const b = boot({}, base);
    expect(b.strip().height).toBe(0);
    b.stubs.lanes()?.reassign("t1", "r1", "r2");
    expect(assignmentsOf(b).map((a) => a.resourceId)).toEqual(["r2"]);
  });

  it("mirrors a pool-only target into the store inside the same transaction", () => {
    const b = boot({}, base, [{ id: "p1", name: "Pooled", capacity: 2 }]);
    b.transactions.length = 0;
    b.stubs.lanes()?.reassign("t1", "r1", "p1");
    expect(b.transactions).toHaveLength(1);
    expect(b.transactions[0]?.ops).toEqual([
      "resource/add",
      "assignment/add",
      "assignment/remove",
    ]);
    const stored = b.host.host.service("stargantt.data").query().resources.get("p1");
    expect(stored).toEqual({ id: "p1", name: "Pooled", capacity: 2 });
  });

  it("drops the source alone when the target already carries the moved rate", () => {
    const b = boot({}, {
      ...base,
      assignments: [
        { taskId: "t1", resourceId: "r1", units: 0.5 },
        { taskId: "t1", resourceId: "r2", units: 0.5 },
      ],
    });
    b.transactions.length = 0;
    b.stubs.lanes()?.reassign("t1", "r1", "r2");
    expect(b.transactions).toHaveLength(1);
    expect(b.transactions[0]?.ops).toEqual(["assignment/remove"]);
    expect(assignmentsOf(b)).toEqual([{ taskId: "t1", resourceId: "r2", units: 0.5 }]);
  });

  it("writes nothing for a same, unknown or unassigned move", () => {
    const b = boot({}, base);
    b.transactions.length = 0;
    b.stubs.lanes()?.reassign("t1", "r1", "r1");
    b.stubs.lanes()?.reassign("t1", "r1", "ghost");
    b.stubs.lanes()?.reassign("t1", "ghost", "r2");
    b.stubs.lanes()?.reassign("t1", "r2", "r1");
    expect(b.transactions).toEqual([]);
    expect(assignmentsOf(b)).toEqual([{ taskId: "t1", resourceId: "r1", units: 0.5 }]);
  });

  it("lands as exactly one undo step", () => {
    const b = boot({}, base);
    b.transactions.length = 0;
    b.stubs.lanes()?.reassign("t1", "r1", "r2");
    const recorded = b.transactions[0];
    expect(recorded?.ops).toHaveLength(2);
    // One transaction carrying both patches is what undo-redo records as one entry.
    expect(b.transactions).toHaveLength(1);
  });
});
