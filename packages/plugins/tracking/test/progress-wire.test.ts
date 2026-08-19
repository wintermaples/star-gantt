// Tests `wireProgress(deps)` — the area's entry point — at two levels, mirroring
// `@stargantt/plugin-scheduling`'s `test/links-wire.test.ts` (hostless, a recording `PluginContext`
// double) plus a real-host round-trip pass:
//
// 1. Hostless: service-always-built, layer-always-contributed, RAG contributions nest/field-gated,
//    the batch dispatch shape and its `data/willApplyTransaction` append.
// 2. Real host (`createTestHost` + `dataStore()` + `undoRedo()`): the actual data round-trip —
//    setRag/setProgressFieldsBatch/setRemainingWork/setRemainingDuration write through to the
//    store, and multi-task batches land as one undo entry.
import { describe, expect, it } from "vitest";
import { definePlugin } from "@stargantt/core";
import type { Plugin } from "@stargantt/core";
import { createTestHost } from "@stargantt/sdk";
import { dataStore } from "@stargantt/plugin-data-store";
import type { LayerContribution } from "@stargantt/plugin-view";
import type { BarOverlayRenderer, BarStyleProvider } from "@stargantt/plugin-task-bars";
import { resolveConfig } from "../src/config";
import type { TrackingConfig } from "../src/config";
import { resolveMessages } from "../src/internal/messages";
import type { TrackingAreaDeps } from "../src/internal/areas";
import { wireProgress } from "../src/internal/progress/wire";
import type { ProgressService } from "../src/types";
import { fakeDataService, recordingContext, stubTask } from "./progress-doubles";

const MS_DAY = 86_400_000;
const MS_HOUR = 3_600_000;

function makeDeps(
  rec: ReturnType<typeof recordingContext>,
  configOverride: TrackingConfig = {},
  data = fakeDataService([]),
): TrackingAreaDeps {
  return {
    ctx: rec.ctx,
    config: resolveConfig(configOverride),
    messages: resolveMessages(undefined, () => undefined),
    data,
    now: () => 0,
    reportError: () => undefined,
  };
}

/* ==================================================================== *
 * Hostless: wiring, layer registration, RAG gating, batch shape
 * ==================================================================== */

describe("wireProgress — hostless wiring", () => {
  it("builds the service unconditionally when the progress nest is omitted", () => {
    const rec = recordingContext({});
    const service = wireProgress(makeDeps(rec, {}));
    expect(service.state.get()).toEqual({ progressLineVisible: false, snapshots: [] });
    expect(typeof service.statusDate()).toBe("number");
    expect(service.statusReport().taskCount).toBe(0);
  });

  it("registers the order-65 layer unconditionally, even with the nest dormant", () => {
    const rec = recordingContext({});
    wireProgress(makeDeps(rec, {}));
    const layers = rec.contributedTo<LayerContribution>("renderer/layers");
    expect(layers).toHaveLength(1);
    expect(layers[0]?.zIndex).toBe(65);
    expect(layers[0]?.id).toBe("stargantt.tracking:progress-line");
  });

  it("registers no RAG bar contributions while the nest is dormant", () => {
    const rec = recordingContext({});
    wireProgress(makeDeps(rec, {}));
    expect(rec.contributedTo<BarStyleProvider>("taskbars/style")).toHaveLength(0);
    expect(rec.contributedTo<BarOverlayRenderer>("taskbars/overlays")).toHaveLength(0);
  });

  it("colorBars gates taskbars/style independently of showRagOnBars gating taskbars/overlays", () => {
    const recA = recordingContext({});
    wireProgress(makeDeps(recA, { progress: { colorBars: true, showRagOnBars: false } }));
    expect(recA.contributedTo("taskbars/style")).toHaveLength(1);
    expect(recA.contributedTo("taskbars/overlays")).toHaveLength(0);

    const recB = recordingContext({});
    // Defaults: colorBars false, showRagOnBars true.
    wireProgress(makeDeps(recB, { progress: {} }));
    expect(recB.contributedTo("taskbars/style")).toHaveLength(0);
    expect(recB.contributedTo("taskbars/overlays")).toHaveLength(1);
  });

  it("the layer's draw never throws even when view/task-bars/timeline are unresolved", () => {
    const rec = recordingContext({});
    wireProgress(makeDeps(rec, { progress: { progressLine: true } }));
    const layer = rec.contributedTo<LayerContribution>("renderer/layers")[0];
    const g = new Proxy(
      {},
      { get: () => () => undefined, set: () => true },
    ) as unknown as CanvasRenderingContext2D;
    expect(() => layer?.draw(g, { scrollLeft: 0, scrollTop: 0, width: 100, height: 100 })).not.toThrow();
  });

  it("openBulkUpdatePanel / openTrendPanel report false without stargantt.view", () => {
    const rec = recordingContext({});
    const service = wireProgress(makeDeps(rec, { progress: {} }));
    expect(service.openBulkUpdatePanel()).toBe(false);
    expect(service.openTrendPanel()).toBe(false);
  });

  it("setProgressFieldsBatch dispatches one head command per-batch-uniquely-originated, appending the rest via data/willApplyTransaction", () => {
    const data = fakeDataService([stubTask("a", 0, MS_DAY), stubTask("b", 0, MS_DAY)]);
    const rec = recordingContext({});
    const service = wireProgress(makeDeps(rec, { progress: {} }, data));

    service.setProgressFieldsBatch([
      { id: "a", patch: { rag: "red" } },
      { id: "b", patch: { rag: "amber" } },
    ]);
    expect(rec.dispatched).toHaveLength(1);
    expect(rec.dispatched[0]?.key).toBe("task/update");
    const payload = rec.dispatched[0]?.payload as { origin: string };
    expect(payload.origin).toMatch(/^stargantt\.tracking\/progress-bulk#\d+$/);
    // The batcher's own `data/willApplyTransaction` handler appended the second task's patch onto
    // the head dispatch's transaction, synchronously, during the dispatch call.
    expect(rec.dispatched[0]?.transaction.patches).toHaveLength(1);

    // A second batch stamps a distinct origin (no adoption of stale pending patches).
    service.setProgressFieldsBatch([{ id: "a", patch: { rag: "green" } }]);
    const payload2 = rec.dispatched[1]?.payload as { origin: string };
    expect(payload2.origin).not.toBe(payload.origin);
  });

  it("an empty or all-skipped batch dispatches nothing", () => {
    const data = fakeDataService([stubTask("a", 0, MS_DAY)]);
    const rec = recordingContext({});
    const service = wireProgress(makeDeps(rec, { progress: {} }, data));
    service.setProgressFieldsBatch([]);
    expect(rec.dispatched).toHaveLength(0);
    service.setProgressFieldsBatch([{ id: "nope", patch: { rag: "red" } }]);
    expect(rec.dispatched).toHaveLength(0);
  });
});

/* ==================================================================== *
 * Real host: the actual data round-trip
 * ==================================================================== */

function probe(sink: { service?: ProgressService }, progress: TrackingConfig["progress"]): Plugin<void> {
  return definePlugin<void>({
    meta: { id: "test.progress-probe", dependsOn: ["stargantt.data-store"] },
    setup(ctx) {
      const deps: TrackingAreaDeps = {
        ctx,
        config: resolveConfig(progress === undefined ? {} : { progress }),
        messages: resolveMessages(undefined, () => undefined),
        data: ctx.use("stargantt.data"),
        now: () => Date.now(),
        reportError: () => undefined,
      };
      sink.service = wireProgress(deps);
    },
  });
}

function boot(progress: TrackingConfig["progress"] = {}) {
  const sink: { service?: ProgressService } = {};
  const host = createTestHost({ plugins: [dataStore(), probe(sink, progress)] });
  return { host, data: host.host.service("stargantt.data"), service: () => sink.service as ProgressService };
}

/**
 * Counts patches landed per `data/willApplyTransaction` firing — the "one transaction" proof
 * (no `@stargantt/plugin-undo-redo` devDependency needed: the real transaction pipeline itself
 * is the source of truth for "how many patches landed in one commit").
 *
 * ORDER DEPENDENCE (review minor): `transaction.patches` is one mutable array every handler of
 * this event shares, and the batcher's own `data/willApplyTransaction` subscription (installed by
 * `createTransactionBatcher` inside `wireProgress`, at `boot()`/`service()` time — i.e. strictly
 * BEFORE this function is ever called) is what appends the tail patches to it. Core dispatches to
 * subscribers in REGISTRATION order, so this listener — registered here, after `boot()` — always
 * runs AFTER the batcher's own handler has already finished appending, and therefore reads the
 * FINAL patch count for the whole batch. Registering it any earlier (or racing it ahead of the
 * batcher's subscription some other way) would read a partial, still-growing array instead — the
 * counts below are only meaningful because of this ordering, not a coincidence of array identity.
 */
function transactionSizes(host: ReturnType<typeof boot>["host"]): number[] {
  const sizes: number[] = [];
  host.host.on("data/willApplyTransaction", ((e: unknown) => {
    const transaction = (e as { transaction: { patches: readonly unknown[] } }).transaction;
    sizes.push(transaction.patches.length);
  }) as never);
  return sizes;
}

describe("wireProgress — real host round-trip", () => {
  it("setRag / ragOf round-trip; unusable values ignored; clearing empties the bag", () => {
    const { host, data, service } = boot();
    data.load([{ id: "a", parentId: null, name: "A", start: 0, end: MS_DAY }]);
    const svc = service();
    expect(svc.ragOf("a")).toBeUndefined();

    svc.setRag("a", "amber");
    expect(svc.ragOf("a")).toBe("amber");
    expect((data.getTask("a")?.meta as { progressTracking?: unknown })?.progressTracking).toEqual({ rag: "amber" });

    svc.setRag("a", "purple" as never);
    expect(svc.ragOf("a")).toBe("amber");

    svc.setRag("a", undefined);
    expect(svc.ragOf("a")).toBeUndefined();
    expect(data.getTask("a")?.meta).toBeUndefined();

    svc.setRag("nope", "red"); // unknown task: silent no-op
    host.dispose();
  });

  it("setProgressFieldsBatch writes N tasks as one transaction (one head + N-1 appended patches)", () => {
    const { host, data, service } = boot();
    data.load([
      { id: "a", parentId: null, name: "A", start: 0, end: MS_DAY },
      { id: "b", parentId: null, name: "B", start: 0, end: MS_DAY },
      { id: "c", parentId: null, name: "C", start: 0, end: MS_DAY },
    ]);
    const svc = service();
    const sizes = transactionSizes(host);

    svc.setProgressFieldsBatch([
      { id: "a", patch: { rag: "red" } },
      { id: "b", patch: { rag: "amber" } },
      { id: "c", patch: { rag: "green" } },
    ]);
    expect(svc.ragOf("a")).toBe("red");
    expect(svc.ragOf("b")).toBe("amber");
    expect(svc.ragOf("c")).toBe("green");
    // One transaction fired, carrying all 3 patches — not 3 separate transactions.
    expect(sizes).toEqual([3]);
    host.dispose();
  });

  it("setProgressFieldsBatch recomputes progress from remainingWork/totalWork within a batched entry", () => {
    const { host, data, service } = boot();
    data.load([{ id: "a", parentId: null, name: "A", start: 0, end: MS_DAY }]);
    const svc = service();
    svc.setProgressFieldsBatch([{ id: "a", patch: { totalWork: 40, remainingWork: 10 } }]);
    expect(data.getTask("a")?.progress).toBeCloseTo(0.75, 5);
    expect(svc.progressOf("a")).toEqual({ totalWork: 40, remainingWork: 10 });
    host.dispose();
  });

  it("merges same-task batch entries, later field wins; a later explicit undefined clears it", () => {
    const { host, data, service } = boot();
    data.load([{ id: "a", parentId: null, name: "A", start: 0, end: MS_DAY }]);
    const svc = service();
    svc.setProgressFieldsBatch([
      { id: "a", patch: { rag: "red", totalWork: 40 } },
      { id: "a", patch: { rag: "green" } },
    ]);
    expect(svc.progressOf("a")).toEqual({ rag: "green", totalWork: 40 });

    svc.setProgressFieldsBatch([
      { id: "a", patch: { rag: "red" } },
      { id: "a", patch: { rag: undefined } },
    ]);
    expect(svc.ragOf("a")).toBeUndefined();
    host.dispose();
  });

  it("skips an unknown task and a non-object patch individually; an all-skipped batch fires no transaction", () => {
    const { host, data, service } = boot();
    data.load([{ id: "a", parentId: null, name: "A", start: 0, end: MS_DAY }]);
    const svc = service();
    const sizes = transactionSizes(host);

    svc.setProgressFieldsBatch([
      { id: "nope", patch: { rag: "red" } },
      { id: "a", patch: "junk" as never },
      { id: "a", patch: { rag: "amber" } },
    ]);
    expect(svc.ragOf("a")).toBe("amber");
    expect(sizes).toEqual([1]); // only the one usable write landed

    svc.setProgressFieldsBatch([]);
    expect(sizes).toEqual([1]); // no further transaction fired
    host.dispose();
  });

  it("setRemainingWork recomputes progress in one write; unusable values ignored", () => {
    const { host, data, service } = boot();
    data.load([{ id: "a", parentId: null, name: "A", start: 0, end: MS_DAY }]);
    const svc = service();
    svc.setProgressFields("a", { totalWork: 40 * MS_HOUR });
    svc.setRemainingWork("a", 10 * MS_HOUR);
    expect(data.getTask("a")?.progress).toBeCloseTo(0.75, 5);
    expect(svc.progressOf("a")).toEqual({ totalWork: 40 * MS_HOUR, remainingWork: 10 * MS_HOUR });

    svc.setRemainingWork("a", 100 * MS_HOUR);
    expect(data.getTask("a")?.progress).toBe(0); // clamped

    svc.setRemainingWork("a", -1);
    svc.setRemainingWork("a", Number.NaN);
    expect(svc.progressOf("a").remainingWork).toBe(100 * MS_HOUR); // unchanged, unusable ignored
    host.dispose();
  });

  it("setPhysicalPercent clamps and never touches task.progress", () => {
    const { host, data, service } = boot();
    data.load([{ id: "a", parentId: null, name: "A", start: 0, end: MS_DAY, progress: 0.4 }]);
    const svc = service();
    svc.setPhysicalPercent("a", 130);
    expect(svc.progressOf("a")).toEqual({ physicalPercent: 100 });
    expect(data.getTask("a")?.progress).toBe(0.4);
    host.dispose();
  });

  it("setRemainingDuration moves end past the (configured) status date and sets the elapsed fraction", () => {
    const { host, data, service } = boot({ statusDate: 5 * MS_DAY });
    data.load([{ id: "a", parentId: null, name: "A", start: 0, end: 10 * MS_DAY }]);
    const svc = service();
    svc.setRemainingDuration("a", 5 * MS_DAY);
    expect(data.getTask("a")?.end).toBe(10 * MS_DAY);
    expect(data.getTask("a")?.progress).toBeCloseTo(0.5, 5);

    svc.setRemainingDuration("a", 0);
    expect(data.getTask("a")?.end).toBe(5 * MS_DAY);
    expect(data.getTask("a")?.progress).toBe(1);
    host.dispose();
  });

  it("statusReportText renders title, summary and late lines", () => {
    const { host, data, service } = boot({ statusDate: 10 * MS_DAY });
    data.load([
      { id: "done", parentId: null, name: "Done", start: 0, end: 5 * MS_DAY, progress: 1 },
      { id: "late", parentId: null, name: "Roofing", start: 0, end: 10 * MS_DAY, progress: 0.2 },
    ]);
    const svc = service();
    const text = svc.statusReportText();
    const lines = text.split("\n");
    expect(lines[0]).toBe("Status report — 1970-01-11");
    expect(lines).toContain("Roofing — 8d late");
    host.dispose();
  });

  it("recordSnapshot records into the state store; setProgressLineVisible toggles it", () => {
    const { host, data, service } = boot({ statusDate: 5 * MS_DAY });
    data.load([{ id: "a", parentId: null, name: "A", start: 0, end: 10 * MS_DAY, progress: 0.5 }]);
    const svc = service();
    expect(svc.state.get().snapshots).toEqual([]);
    const recorded = svc.recordSnapshot();
    expect(recorded.percentComplete).toBe(50);
    expect(svc.state.get().snapshots).toHaveLength(1);

    expect(svc.state.get().progressLineVisible).toBe(false);
    svc.setProgressLineVisible(true);
    expect(svc.state.get().progressLineVisible).toBe(true);
    svc.setProgressLineVisible(true); // no-op, same value
    svc.setProgressLineVisible("yes" as never); // unusable, ignored
    expect(svc.state.get().progressLineVisible).toBe(true);
    host.dispose();
  });
});
