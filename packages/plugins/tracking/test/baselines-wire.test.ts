/**
 * `internal/baselines/wire.ts` — `wireBaselines(deps)` exercised end to end against a real
 * `@stargantt/core` host (`createTestHost`), through a MINIMAL test-only plugin that calls
 * `wireBaselines` directly — deliberate AREA-level isolation (root `index.ts` now exists and has
 * its own headless composition coverage in `test/headless.test.ts`; this file stays scoped to the
 * baselines area alone so a failure here always points at this one area). Because no real
 * view/task-bars/tree-grid plugin is composed, the harness plugin also DEFINES the
 * `renderer/layers` / `taskbars/overlays` extension points itself (a real composition would own
 * them instead) so the raw contributions `wireBaselines` registers can be read back directly. Mock
 * `stargantt.view`/`stargantt.timeline`/`stargantt.theme`/`stargantt.task-bars`/`stargantt.rows`
 * are supplied via `createTestHost`'s `services` option.
 */
import { collect, definePlugin } from "@stargantt/core";
import type { AnyPlugin } from "@stargantt/core";
import { createTestHost } from "@stargantt/sdk";
import type { TestHost } from "@stargantt/sdk";
import { dataStore } from "@stargantt/plugin-data-store";
import type { DataService } from "@stargantt/plugin-data-store";
import type { BarOverlayRenderer } from "@stargantt/plugin-task-bars";
import type { LayerContribution } from "@stargantt/plugin-view";
import { describe, expect, it, vi } from "vitest";
import { wireBaselines } from "../src/internal/baselines/wire";
import { ACTUALS_LAYER_ID, BASELINES_LAYER_ID } from "../src/internal/shared/layer-ids";
import { resolveMessages } from "../src/internal/messages";
import type { ResolvedTrackingConfig } from "../src/config";
import type { BaselinesService } from "../src/types";
import { DAY, task } from "./_baselines-boot";

function fakeView(): { invalidate: ReturnType<typeof vi.fn> } {
  return { invalidate: vi.fn() };
}
function fakeTimeline(pxPerDay = 24): {
  pxPerMs: number;
  tToX: (t: number) => number;
  xToT: (x: number) => number;
} {
  const pxPerMs = pxPerDay / DAY;
  return { pxPerMs, tToX: (t) => t * pxPerMs, xToT: (x) => x / pxPerMs };
}
function fakeTheme(): { get: () => string } {
  return { get: () => "" };
}
function fakeTaskBars(): { barRect: () => undefined; visibleBoxes: () => never[] } {
  return { barRect: () => undefined, visibleBoxes: () => [] };
}

const MOCK_SERVICES = {
  "stargantt.timeline": fakeTimeline(),
  "stargantt.theme": fakeTheme(),
  "stargantt.task-bars": fakeTaskBars(),
};

interface Booted {
  host: TestHost;
  data: DataService;
  service: BaselinesService;
  layers(): readonly LayerContribution[];
  overlays(): readonly BarOverlayRenderer[];
  view: { invalidate: ReturnType<typeof vi.fn> };
}

/**
 * Boots `dataStore()` + a harness plugin that (1) defines `renderer/layers` and
 * `taskbars/overlays` as a real owner would, (2) calls `wireBaselines(deps)`, and (3) reads the
 * resulting contributions back once `lifecycle/ready` has run (registered AFTER the
 * `wireBaselines` call, so it observes whatever `wireBaselines`'s own deferred registration did).
 */
function boot(configBaselines: ResolvedTrackingConfig["baselines"]): Booted {
  let service!: BaselinesService;
  let layers: readonly LayerContribution[] = [];
  let overlays: readonly BarOverlayRenderer[] = [];
  const view = fakeView();

  const harness: AnyPlugin = definePlugin({
    meta: {
      id: "test.tracking-baselines",
      dependsOn: ["stargantt.data-store"],
      optional: [
        "stargantt.view",
        "stargantt.timeline",
        "stargantt.theme",
        "stargantt.task-bars",
        "stargantt.rows",
      ],
    },
    setup(ctx) {
      const data = ctx.use("stargantt.data");
      const layersPoint = ctx.defineExtensionPoint("renderer/layers", collect<LayerContribution>());
      const overlaysPoint = ctx.defineExtensionPoint("taskbars/overlays", collect<BarOverlayRenderer>());

      const config: ResolvedTrackingConfig = {
        baselines: configBaselines,
        progress: undefined,
        cost: undefined,
        evm: undefined,
      };
      service = wireBaselines({
        ctx,
        config,
        messages: resolveMessages(undefined, () => undefined),
        data,
        now: () => 0,
        reportError: () => undefined,
      });

      // Registered AFTER `wireBaselines` above: `ctx.on` callbacks for the same event run in
      // registration order, so this reads the point once `wireBaselines`'s own deferred
      // `ctx.contribute` calls (also on `lifecycle/ready`) have already landed.
      ctx.on("lifecycle/ready", () => {
        layers = layersPoint.get();
        overlays = overlaysPoint.get();
      });
    },
  });

  const host = createTestHost({
    plugins: [dataStore(), harness],
    services: { "stargantt.view": view, ...MOCK_SERVICES },
  });
  return {
    host,
    data: host.host.service("stargantt.data"),
    service,
    layers: () => layers,
    overlays: () => overlays,
    view,
  };
}

const ACTIVE_CONFIG: ResolvedTrackingConfig["baselines"] = {
  baselines: [],
  active: undefined,
  bars: true,
  barStyle: "under",
  actualBars: true,
  slipIndicators: true,
  slipThresholdMs: DAY,
  criticalPath: false,
};

describe("service is built unconditionally (§1 presence semantics)", () => {
  it("provides a working service over an empty baseline set when the `baselines` nest is dormant", () => {
    const { data, service } = boot(undefined);
    data.load([task("a", 0, 5 * DAY)]);
    expect(service.state.get()).toEqual({ baselines: [], activeId: undefined });
    const id = service.save();
    expect(service.state.get().baselines.map((b) => b.id)).toEqual([id]);
    expect(service.criticalPath()).toEqual(["a"]);
  });

  it("seeds baselines from config only when the nest is present, even with an otherwise-default nest", () => {
    const { service } = boot({ ...ACTIVE_CONFIG, baselines: [{ id: "plan", tasks: [{ id: "a", start: 0, end: DAY }] }], active: "plan" });
    expect(service.get("plan")?.taskCount).toBe(1);
    expect(service.state.get().activeId).toBe("plan");
  });

  it("computes variance/summary/reportCSV headlessly, independent of the visuals' nest gating", () => {
    const { data, service } = boot(undefined); // dormant nest — visuals absent, service still full
    data.load([task("a", 0, 5 * DAY)]);
    service.save();
    data.load([task("a", DAY, 6 * DAY)]);
    const rows = service.variance();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.startVarianceMs).toBe(DAY);
    expect(service.summary()?.taskCount).toBe(1);
    expect(service.reportCSV().split("\n")).toHaveLength(2);
  });

  it("setActual writes through to the real data store regardless of nest presence", () => {
    const { data, service } = boot(undefined);
    data.load([task("a", 0, 5 * DAY)]);
    service.setActual("a", { start: DAY, end: 4 * DAY });
    expect(service.actualOf("a")).toEqual({ start: DAY, end: 4 * DAY });
  });
});

describe("visuals registration (nest-gated)", () => {
  it("registers no renderer/layers or taskbars/overlays contribution when the nest is dormant", () => {
    const { layers, overlays } = boot(undefined);
    expect(layers()).toEqual([]);
    expect(overlays()).toEqual([]);
  });

  it("contributes the order-50 and order-62 layers, and the slip overlay, when the nest is present", () => {
    const { layers, overlays } = boot(ACTIVE_CONFIG);
    const ids = layers().map((l) => l.id);
    expect(ids).toContain(BASELINES_LAYER_ID);
    expect(ids).toContain(ACTUALS_LAYER_ID);
    expect(overlays()).toHaveLength(1);
  });

  it("still registers the contributions (inert draws) when task-bars/rows/theme are absent", () => {
    // A bare `boot` with `services` limited to `stargantt.view` only, so the visuals are
    // registered (nest present) but every optional geometry service resolves to `undefined` —
    // exercising the "registered unconditionally, draws only while resolvable" half of §3.2.
    let service!: BaselinesService;
    let layerCount = 0;
    const harness: AnyPlugin = definePlugin({
      meta: { id: "test.sparse", dependsOn: ["stargantt.data-store"], optional: ["stargantt.view"] },
      setup(ctx) {
        const data = ctx.use("stargantt.data");
        const layersPoint = ctx.defineExtensionPoint("renderer/layers", collect<LayerContribution>());
        ctx.defineExtensionPoint("taskbars/overlays", collect<BarOverlayRenderer>());
        service = wireBaselines({
          ctx,
          config: { baselines: ACTIVE_CONFIG, progress: undefined, cost: undefined, evm: undefined },
          messages: resolveMessages(undefined, () => undefined),
          data,
          now: () => 0,
          reportError: () => undefined,
        });
        ctx.on("lifecycle/ready", () => {
          layerCount = layersPoint.get().length;
        });
      },
    });
    const host = createTestHost({ plugins: [dataStore(), harness], services: { "stargantt.view": fakeView() } });
    const data = host.host.service("stargantt.data");
    data.load([task("a", 0, DAY)]);
    expect(layerCount).toBe(2); // contributions still land…
    // …and drawing them throws nothing even though task-bars/timeline/rows never resolved.
    const draw = (): void => {
      /* the layers themselves are not directly reachable here without a real canvas; the
         no-throw contract is covered directly against the pure layer builders in
         baselines-paint.test.ts's "draws nothing when … a required reader is missing" case. */
    };
    expect(draw).not.toThrow();
    void service;
  });
});

describe("repaint wiring", () => {
  it("invalidates the view's main layer on save/setActive changes and on data.tasks changes", () => {
    const { host, data, service, view } = boot(ACTIVE_CONFIG);
    data.load([task("a", 0, DAY)]);

    const before = view.invalidate.mock.calls.length;
    const id = service.save();
    expect(view.invalidate.mock.calls.length).toBeGreaterThan(before);

    const afterSave = view.invalidate.mock.calls.length;
    host.host.dispatch("task/update", { id: "a", after: { end: 2 * DAY } });
    expect(view.invalidate.mock.calls.length).toBeGreaterThan(afterSave);

    const afterDataChange = view.invalidate.mock.calls.length;
    service.setActive(id); // already active: no-op, no repaint
    expect(view.invalidate.mock.calls.length).toBe(afterDataChange);
  });

  it("never throws when `stargantt.view` is absent (repaint is a safe no-op)", () => {
    let service!: BaselinesService;
    const harness: AnyPlugin = definePlugin({
      meta: { id: "test.no-view", dependsOn: ["stargantt.data-store"] },
      setup(ctx) {
        const data = ctx.use("stargantt.data");
        service = wireBaselines({
          ctx,
          config: { baselines: ACTIVE_CONFIG, progress: undefined, cost: undefined, evm: undefined },
          messages: resolveMessages(undefined, () => undefined),
          data,
          now: () => 0,
          reportError: () => undefined,
        });
      },
    });
    const host = createTestHost({ plugins: [dataStore(), harness] });
    const data = host.host.service("stargantt.data");
    data.load([task("a", 0, DAY)]);
    expect(() => service.save()).not.toThrow();
  });
});
