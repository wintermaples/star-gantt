/**
 * The links area against a REAL `@stargantt/core` host (docs/specs/plugins/scheduling.md §5).
 *
 * `links-wire.test.ts` drives the area through a recording `PluginContext`; this file boots the
 * plugin the way a chart does — real core, real event bus, real command pipeline — with the chart
 * services (`stargantt.view` / `stargantt.timeline` / `stargantt.theme` / `stargantt.task-bars` /
 * `stargantt.rows`) mocked in through `createTestHost`. What is pinned here is the wiring nobody
 * can fake: the `renderer/layers` order claims land in the real order registry, and a port drag
 * over the public `pointer/*` stream (§4.3) creates a real link through the real `link/add`
 * command, cycle rejection and undo integration included.
 */
import { describe, expect, it } from "vitest";
import { collect, definePlugin } from "@stargantt/core";
import type { Plugin, PluginContext } from "@stargantt/core";
import { createTestHost, mockStore } from "@stargantt/sdk";
import { dataStore } from "@stargantt/plugin-data-store";
import type { DataService, Link, TaskId } from "@stargantt/plugin-data-store";
import type { BarBox } from "@stargantt/plugin-task-bars";
import type { LayerContribution, Viewport } from "@stargantt/plugin-view";
// Type-only: loads view's `declare module` so the probe below may emit the `pointer/*` stream.
import type {} from "@stargantt/plugin-view";
import { scheduling } from "../src/index";
import { portCentre } from "../src/internal/links/geometry";
import type { Rect } from "../src/internal/links/geometry";
import { fullViewport, rect, stubRows } from "./links-doubles";
import { fakeRoot } from "./_helpers";

const ROW_HEIGHT = 30;
const IDS: TaskId[] = ["t0", "t1"];
const BOXES = new Map<TaskId, Rect>(IDS.map((id, row) => [id, rect(row * 200, row * ROW_HEIGHT + 5)]));

/** A probe plugin that captures its own context, so a test can emit the public pointer stream. */
function probe(sink: { ctx?: PluginContext }): Plugin<void> {
  return definePlugin<void>({
    meta: { id: "test.pointer-probe" },
    setup: (ctx) => {
      sink.ctx = ctx;
    },
  });
}

function boot(): {
  host: ReturnType<typeof createTestHost>;
  emit: PluginContext;
  data: DataService;
} {
  const sink: { ctx?: PluginContext } = {};
  const host = createTestHost({
    element: fakeRoot(),
    plugins: [dataStore(), scheduling(), probe(sink)],
    services: {
      "stargantt.view": {
        invalidate: () => undefined,
        viewport: mockStore<Readonly<Viewport>>(fullViewport()),
      },
      "stargantt.timeline": { zoomLevel: mockStore({ id: "day" }) },
      "stargantt.theme": { get: () => "" },
      "stargantt.task-bars": {
        barRect: (id: TaskId) => BOXES.get(id) as BarBox | undefined,
        hasOwnBar: (id: TaskId) => BOXES.has(id),
      },
      "stargantt.rows": { ...stubRows(IDS, ROW_HEIGHT), rows: mockStore({ rows: [] }) },
    },
  });
  const data = host.host.service("stargantt.data");
  data.load([
    { id: "t0", name: "t0", start: 0, end: 86_400_000 },
    { id: "t1", name: "t1", start: 86_400_000, end: 2 * 86_400_000 },
  ]);
  return { host, emit: sink.ctx!, data };
}

function links(data: DataService): readonly Link[] {
  return [...data.links.get().values()];
}

describe("the links area on a real host", () => {
  it("claims 69 and 110 in the real renderer/layers order registry", () => {
    const { host } = boot();
    try {
      const claims = host.host.orders("renderer/layers");
      expect(
        claims
          .filter((c) => c.pluginId === "stargantt.scheduling")
          .map((c) => [c.key, c.order]),
      ).toEqual([
        ["stargantt.scheduling:links", 69],
        ["stargantt.scheduling:ports", 110],
      ]);
    } finally {
      host.dispose();
    }
  });

  it("creates a real link from a port drag over the public pointer stream (§4.3 / §5.2)", () => {
    const { host, emit, data } = boot();
    try {
      const port = portCentre(BOXES.get("t0")!, "end");
      const event = (type: string): PointerEvent =>
        ({ type, pointerId: 1 }) as unknown as PointerEvent;
      emit.emit("pointer/barDown", {
        hit: { kind: "port", id: "t0", cursor: "crosshair" },
        x: port.x,
        y: port.y,
        event: event("pointerdown"),
      });
      emit.emit("pointer/barMove", { x: 150, y: 30, event: event("pointermove") });
      emit.emit("pointer/barUp", { x: 210, y: 45, event: event("pointerup") });

      const created = links(data);
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ sourceId: "t0", targetId: "t1", type: "FS" });
    } finally {
      host.dispose();
    }
  });

  it("creates nothing on a pointercancel release (§4.3)", () => {
    const { host, emit, data } = boot();
    try {
      const port = portCentre(BOXES.get("t0")!, "end");
      const event = (type: string): PointerEvent =>
        ({ type, pointerId: 1 }) as unknown as PointerEvent;
      emit.emit("pointer/barDown", {
        hit: { kind: "port", id: "t0", cursor: "crosshair" },
        x: port.x,
        y: port.y,
        event: event("pointerdown"),
      });
      emit.emit("pointer/barUp", { x: 210, y: 45, event: event("pointercancel") });
      expect(links(data)).toEqual([]);
    } finally {
      host.dispose();
    }
  });

  it("offers no second link over an ordered pair the store already holds one for (§5.2)", () => {
    const { host, emit, data } = boot();
    try {
      const port = portCentre(BOXES.get("t0")!, "end");
      const event = (type: string): PointerEvent =>
        ({ type, pointerId: 1 }) as unknown as PointerEvent;
      const drag = (): void => {
        emit.emit("pointer/barDown", {
          hit: { kind: "port", id: "t0", cursor: "crosshair" },
          x: port.x,
          y: port.y,
          event: event("pointerdown"),
        });
        emit.emit("pointer/barUp", { x: 210, y: 45, event: event("pointerup") });
      };
      drag();
      drag();
      expect(links(data)).toHaveLength(1);
    } finally {
      host.dispose();
    }
  });

  it("still claims its layer orders but stays otherwise inert when no chart surface is composed", () => {
    // No mocked services at all: `claimOrder`/`contribute` are timing-agnostic (§14) and always
    // register — only the DRAW/HIT bodies, which re-resolve `stargantt.view`/`stargantt.task-bars`
    // per call, go quiet. The plugin still starts, and the engine half is untouched — the
    // composition every engine suite in this package boots.
    const host = createTestHost({ element: fakeRoot(), plugins: [dataStore(), scheduling()] });
    try {
      expect(
        host.host
          .orders("renderer/layers")
          .filter((c) => c.pluginId === "stargantt.scheduling")
          .map((c) => [c.key, c.order]),
      ).toEqual([
        ["stargantt.scheduling:links", 69],
        ["stargantt.scheduling:ports", 110],
      ]);
      expect(() => host.ctxOf("stargantt.scheduling")).not.toThrow();
      expect(host.host.service("stargantt.scheduler")).toBeDefined();
    } finally {
      host.dispose();
    }
  });
});

/* ------------------------------------------------------------------ *
 * The discriminating case: REAL plugin tiers, not `createTestHost`'s mock-provider shortcut
 * ------------------------------------------------------------------ */
//
// `boot()` above injects its `services` map through `createTestHost`'s synthetic mock-provider
// plugin, which every other registered plugin (`scheduling()` included) is given a forced HARD
// `dependsOn` on (`@stargantt/sdk`'s `captureContext`) — so in that harness the chart services are
// ALWAYS resolvable at `scheduling()`'s own `setup()`, regardless of how this area reads them. That
// masks exactly the bug §14's review ruling fixes: in a REAL composition, `meta.optional` does not
// order startup — the core tiers plugins by `dependsOn` alone (architecture.md §1.4), and
// `stargantt.view` depends on nothing but the data store, the same tier `scheduling()` itself sits
// in (both `dependsOn: ["stargantt.data-store"]`), so registration order — not need — decides which
// of the two runs `setup()` first. The stub plugins below declare the SAME `dependsOn` their real
// counterparts do (`view.md` / `task-bars.md`), and are registered AFTER `scheduling()`, so
// `scheduling()`'s `setup()` provably runs before any of them have provided anything.

/**
 * A stub `stargantt.view` with the real plugin's `dependsOn` tier — data store only — that ALSO
 * defines the real `renderer/layers` extension point (`collect`), so a test can pull the links
 * area's own layer contributions back out and invoke `draw` for real, exactly as the real view
 * plugin's paint loop would.
 */
function stubView(
  vp: Viewport,
  sink: { layers?: () => readonly LayerContribution[] },
): Plugin<void> {
  return definePlugin<void>({
    meta: { id: "stargantt.view", dependsOn: ["stargantt.data-store"] },
    setup(ctx) {
      const point = ctx.defineExtensionPoint(
        "renderer/layers",
        collect<LayerContribution>(),
      );
      sink.layers = () => point.get();
      ctx.provide("stargantt.view", {
        invalidate: () => undefined,
        viewport: mockStore<Readonly<Viewport>>(vp),
      } as never);
      ctx.provide("stargantt.timeline", { zoomLevel: mockStore({ id: "day" }) } as never);
      ctx.provide("stargantt.theme", { get: () => "" } as never);
    },
  });
}

/** A stub `stargantt.tree-grid` with the real plugin's tier — data store + view. */
function stubTreeGrid(ids: TaskId[], rowHeight: number): Plugin<void> {
  return definePlugin<void>({
    meta: { id: "stargantt.tree-grid", dependsOn: ["stargantt.data-store", "stargantt.view"] },
    setup(ctx) {
      ctx.provide("stargantt.rows", {
        ...stubRows(ids, rowHeight),
        rows: mockStore({ rows: [] }),
      } as never);
    },
  });
}

/** A stub `stargantt.task-bars` with the real plugin's tier — data store + view + tree-grid. */
function stubTaskBars(boxes: ReadonlyMap<TaskId, Rect>, ownBars: ReadonlySet<TaskId>): Plugin<void> {
  return definePlugin<void>({
    meta: {
      id: "stargantt.task-bars",
      dependsOn: ["stargantt.data-store", "stargantt.view", "stargantt.tree-grid"],
    },
    setup(ctx) {
      ctx.provide("stargantt.task-bars", {
        barRect: (id: TaskId) => boxes.get(id) as BarBox | undefined,
        hasOwnBar: (id: TaskId) => ownBars.has(id),
      } as never);
    },
  });
}

describe("the links area under REAL plugin tiers (discriminating case)", () => {
  it("claims 69/110, paints real ports and creates a real link via a port drag", () => {
    const pointerSink: { ctx?: PluginContext } = {};
    const probeStub: Plugin<void> = definePlugin<void>({
      meta: { id: "test.pointer-probe" },
      setup: (ctx) => {
        pointerSink.ctx = ctx;
      },
    });
    const layerSink: { layers?: () => readonly LayerContribution[] } = {};
    // Registration order deliberately puts `scheduling()` BEFORE the view/tree-grid/task-bars
    // stubs: within the shared tier 1 (`scheduling`/`stargantt.view` both depend on the data store
    // alone), the core breaks ties by registration index, so this ordering is the one that would
    // run `scheduling()`'s `setup()` first even if the tiers happened to coincide exactly.
    const host = createTestHost({
      element: fakeRoot(),
      plugins: [
        dataStore(),
        scheduling(),
        stubView(fullViewport(), layerSink),
        stubTreeGrid(IDS, ROW_HEIGHT),
        stubTaskBars(BOXES, new Set(IDS)),
        probeStub,
      ],
    });
    try {
      // The claims land regardless of registration order — `claimOrder` is timing-agnostic (§14).
      const claims = host.host
        .orders("renderer/layers")
        .filter((c) => c.pluginId === "stargantt.scheduling")
        .map((c) => [c.key, c.order]);
      expect(claims).toEqual([
        ["stargantt.scheduling:links", 69],
        ["stargantt.scheduling:ports", 110],
      ]);

      const data = host.host.service("stargantt.data") as DataService;
      data.load([
        { id: "t0", name: "t0", start: 0, end: 86_400_000 },
        { id: "t1", name: "t1", start: 86_400_000, end: 2 * 86_400_000 },
      ]);

      // Painting works: pulled straight from the (stub) view's own `renderer/layers` extension
      // point — not reconstructed by the test — the port layer's `draw`, resolved per call rather
      // than latched at `scheduling()`'s own (earlier-running) `setup()`, paints both ports of
      // `t0`'s bar without throwing, proving `stargantt.task-bars` genuinely resolved.
      const portLayer = layerSink.layers!().find((l) => l.id === "stargantt.scheduling:ports");
      expect(portLayer).toBeDefined();
      let arcs = 0;
      const recordingCtx = {
        save: () => undefined,
        restore: () => undefined,
        beginPath: () => undefined,
        closePath: () => undefined,
        moveTo: () => undefined,
        lineTo: () => undefined,
        stroke: () => undefined,
        fill: () => undefined,
        arc: () => {
          arcs += 1;
        },
        set fillStyle(_v: string) {},
        set strokeStyle(_v: string) {},
        set lineWidth(_v: number) {},
        set globalAlpha(_v: number) {},
      } as unknown as CanvasRenderingContext2D;
      portLayer!.draw(recordingCtx, fullViewport());
      expect(arcs).toBe(4); // both ports of both t0's and t1's bars — both rows fit the 300px viewport

      // The port drag itself is the strongest end-to-end proof: it depends on `stargantt.view`
      // (viewport + invalidate) and `stargantt.task-bars` (bar geometry) both resolving correctly
      // through the per-use / lifecycle-deferred lookups this fix introduces.
      const port = portCentre(BOXES.get("t0")!, "end");
      const emit = pointerSink.ctx!;
      const event = (type: string): PointerEvent => ({ type, pointerId: 1 }) as unknown as PointerEvent;
      emit.emit("pointer/barDown", {
        hit: { kind: "port", id: "t0", cursor: "crosshair" },
        x: port.x,
        y: port.y,
        event: event("pointerdown"),
      });
      emit.emit("pointer/barMove", { x: 150, y: 30, event: event("pointermove") });
      emit.emit("pointer/barUp", { x: 210, y: 45, event: event("pointerup") });

      const created = [...data.links.get().values()];
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({ sourceId: "t0", targetId: "t1", type: "FS" });
    } finally {
      host.dispose();
    }
  });
});
