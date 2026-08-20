/**
 * The plugin's own wiring: headless composition (dataStore() + dataSync() alone), the
 * `dependsOn`/`ctx.use()` mechanical consistency check, config defaults/unusable-value fallbacks,
 * and cross-area `sync/activity` ordering guarantees (§6.2). Coverage for the root `index.ts`.
 */
import { expectDepsConsistency } from "@stargantt/sdk";
import { describe, expect, it } from "vitest";
import { dataSync } from "../src/index";
import { boot, fakeIndexedDb, scriptedAdapter } from "./_helpers";

describe("headless composition (no DOM, no view/interaction/tree-grid)", () => {
  it("provides stargantt.data-sync over dataStore() + dataSync() alone, every area present", () => {
    const { ds } = boot();
    expect(ds.sources).toBeDefined();
    expect(ds.lazy).toBeDefined();
    expect(ds.offline).toBeDefined();
    expect(ds.realtime).toBeDefined();
    expect(typeof ds.load).toBe("function");
    expect(typeof ds.rollback).toBe("function");
  });

  it("with no configured or registered source/transport/offline nest, the plugin does nothing", async () => {
    const { ds, collected } = boot();
    expect(ds.sources.names()).toEqual([]);
    expect(ds.lazy.sources.names()).toEqual([]);
    expect(ds.realtime.transports.names()).toEqual([]);
    expect(ds.offline.available()).toBe(false);
    expect(await ds.load()).toEqual({ ok: false });
    expect(collected.errors).toEqual([]);
    expect(collected.activity).toEqual([]);
  });
});

describe("declared dependencies", () => {
  it("dependsOn/ctx.use() match exactly (mechanical consistency check)", () => {
    expectDepsConsistency(dataSync(), { "stargantt.data": "stargantt.data-store" });
  });

  it("hard-depends on stargantt.data-store only; everything else is optional/inert", () => {
    expect(dataSync().meta.dependsOn).toEqual(["stargantt.data-store"]);
  });
});

describe("config resolution — unusable values silently fall back to defaults", () => {
  it("dataSync() ≡ dataSync({}); undefined and a non-object config are both treated as {}", () => {
    expect(dataSync().meta).toEqual(dataSync({}).meta);
    // @ts-expect-error deliberately non-object for the test
    expect(() => dataSync(null)).not.toThrow();
    const { ds } = boot(null as never);
    expect(ds.sources.names()).toEqual([]);
  });

  it("lazyLoad.pageSize falls back to 500 when unusable (non-integer, negative)", async () => {
    const { ds } = boot({ lazyLoad: { pageSize: -5 } });
    const adapter = { fetchRange: () => Promise.resolve({ tasks: [] }) };
    ds.lazy.sources.register("a", adapter);
    ds.lazy.sources.activate("a");
    const result = await ds.lazy.ensureRange(0, 1);
    expect(result.ok).toBe(true); // no crash; the default page size (500) is usable
  });

  it("offline.autoSaveDebounceMs falls back to 500 when unusable (negative); booting does not throw", () => {
    const idb = fakeIndexedDb();
    expect(() => boot({ offline: { indexedDB: idb.factory, autoSave: true, autoSaveDebounceMs: -1 } })).not.toThrow();
  });

  it("realtime.reconnectDelayMs/maxReconnectAttempts fall back when unusable (negative); booting does not throw", () => {
    expect(() => boot({ realtime: { reconnectDelayMs: -1, maxReconnectAttempts: -1 } })).not.toThrow();
  });
});

describe("cross-area sync/activity ordering (§6.2)", () => {
  it("the realtime area is excluded from the counter (no activity events for connect/applyMessage)", () => {
    const { ds, collected } = boot();
    ds.realtime.transports.register("ws", {
      connect: (h: { onOpen(): void }) => h.onOpen(),
      disconnect: () => {},
    } as never);
    ds.realtime.connect("ws");
    ds.realtime.applyMessage({ type: "changes", changes: [] });
    expect(collected.activity.filter((e) => e.area === "realtime")).toEqual([]);
  });

  it("multiple areas' activity counters are independent (source load + lazy fetch concurrently)", async () => {
    const { ds, collected } = boot({ lazyLoad: { pageSize: 10 } });
    const source = scriptedAdapter();
    let resolveSource: (() => void) | undefined;
    source.fetch = () => new Promise((resolve) => (resolveSource = () => resolve({ tasks: [] })));
    ds.sources.register("a", source);
    ds.sources.activate("a");

    const lazy = { fetchRange: () => new Promise<{ tasks: unknown[] }>(() => {}) };
    ds.lazy.sources.register("b", lazy as never);
    ds.lazy.sources.activate("b");

    const loadPromise = ds.load();
    void ds.lazy.ensureRange(0, 10); // never resolves — just needs to register as pending
    resolveSource?.();
    await loadPromise;

    const sourceActivity = collected.activity.filter((e) => e.area === "source");
    const lazyActivity = collected.activity.filter((e) => e.area === "lazy");
    expect(sourceActivity.map((e) => e.pending)).toEqual([1, 0]); // completed independently
    expect(lazyActivity.map((e) => e.pending)).toEqual([1]); // still pending, never decremented
  });
});
