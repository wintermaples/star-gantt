/**
 * §4.2 autoSave (incl. the `debounceMs: 0` SAME-STACK case) + autoRestore (lifecycle/ready
 * timing), §4.4 the nest-gated read-only source adapter, and §6.2 `sync/activity` for
 * save/restore/clear.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boot, fakeIndexedDb, task } from "./_helpers";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("offline area — autoSave (§4.2)", () => {
  it("schedules one debounced save() per edit burst", async () => {
    const idb = fakeIndexedDb();
    const { host, collected } = boot({ offline: { indexedDB: idb.factory, autoSave: true, autoSaveDebounceMs: 50 } });
    const data = host.host.service("stargantt.data");
    data.load({ tasks: [task("t1", 0, 1)] });
    host.host.dispatch("task/update", { id: "t1", after: { name: "A" } });
    host.host.dispatch("task/update", { id: "t1", after: { name: "B" } }); // re-arms, does not double-save
    expect(collected.offlineSaved).toEqual([]);
    await vi.advanceTimersByTimeAsync(49);
    expect(collected.offlineSaved).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(collected.offlineSaved).toHaveLength(1);
  });

  it("disposal cancels an armed auto-save timer (§4.2, review round 2): the pending timer is actually cleared", async () => {
    // `host.dispose()` clears the ENTIRE event bus (core `PluginHostImpl.dispose()`, last step)
    // before returning, including this test's own collector subscriptions — so nothing emitted
    // afterward (a fault, an activity event) is observable, and the persisted document alone can't
    // discriminate either (this plugin ALSO closes the IndexedDB connection on disposal via a
    // SEPARATE ctx.own() disposable, so even an uncancelled timer's write would silently fail
    // closed and never land). The one signal that genuinely proves `clearTimeout` ran is the fake
    // timer queue itself.
    const idb = fakeIndexedDb();
    const { host } = boot({ offline: { indexedDB: idb.factory, autoSave: true, autoSaveDebounceMs: 50 } });
    const data = host.host.service("stargantt.data");
    data.load({ tasks: [task("t1", 0, 1)] }); // seed — schedules, then (debounce elapses) completes
    await vi.advanceTimersByTimeAsync(50);
    expect(vi.getTimerCount()).toBe(0); // no timer left pending after the seed's save completed

    host.host.dispatch("task/update", { id: "t1", after: { name: "Edited" } }); // arms a new timer
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    host.dispose(); // must cancel the armed timer via its ctx.own() disposable
    expect(vi.getTimerCount()).toBe(0); // actually cleared, not merely made irrelevant
  });

  it("debounceMs: 0 starts save() IMMEDIATELY, on the SAME STACK (distinct from followFilter's deviation)", () => {
    const idb = fakeIndexedDb();
    const { host, collected } = boot({ offline: { indexedDB: idb.factory, autoSave: true, autoSaveDebounceMs: 0 } });
    const data = host.host.service("stargantt.data");
    data.load({ tasks: [task("t1", 0, 1)] }); // itself one `data.tasks` notification (the bulk path)
    const before = collected.activity.filter((e) => e.area === "offline" && e.op === "save").length;
    // `sync/activity`'s pending-increment fires SYNCHRONOUSLY at `save()`'s entry, before any
    // `await` — so its presence right after the dispatch, with NO timer advance and NO microtask
    // flush, proves the call started on the SAME STACK (unlike followFilter's zero-delay-TIMER
    // deviation, §2.6, which schedules and returns before doing anything).
    host.host.dispatch("task/update", { id: "t1", after: { name: "Edited" } });
    const after = collected.activity.filter((e) => e.area === "offline" && e.op === "save").length;
    expect(after).toBeGreaterThan(before);
  });

  it("a restore() rewriting an identical document is an accepted idempotent write", async () => {
    const idb = fakeIndexedDb();
    const { ds, host, collected } = boot({ offline: { indexedDB: idb.factory, autoSave: true, autoSaveDebounceMs: 0 } });
    const data = host.host.service("stargantt.data");
    data.load({ tasks: [task("t1", 0, 1)] });
    host.host.dispatch("task/update", { id: "t1", after: { name: "A" } });
    await vi.advanceTimersByTimeAsync(0);
    const savesBefore = collected.offlineSaved.length;
    await ds.offline.restore(); // a bulk load — must NOT itself trigger another autoSave loop here
    expect(collected.offlineSaved.length).toBe(savesBefore);
  });
});

describe("offline area — autoRestore (§4.2, deferred to lifecycle/ready)", () => {
  it("runs one restore() on lifecycle/ready", async () => {
    const idb = fakeIndexedDb();
    const seed = boot({ offline: { indexedDB: idb.factory } });
    const data0 = seed.host.host.service("stargantt.data");
    data0.load({ tasks: [task("t1", 0, 1)] });
    await seed.ds.offline.save();

    const { host, collected } = boot({ offline: { indexedDB: idb.factory, autoRestore: true } });
    await vi.advanceTimersByTimeAsync(0);
    expect(collected.offlineRestored).toHaveLength(1);
    const data = host.host.service("stargantt.data");
    expect(data.getTask("t1")).toBeDefined();
  });
});

describe("offline area — the read-only source adapter, nest-gated (§4.4)", () => {
  it("with NO offline nest at all, sources.names() contains no \"offline\" entry", () => {
    const { ds } = boot();
    expect(ds.sources.names()).not.toContain("offline");
  });

  it("with an offline nest supplied (even {}), the adapter registers by default (registerSource: true)", () => {
    const idb = fakeIndexedDb();
    const { ds } = boot({ offline: { indexedDB: idb.factory } });
    expect(ds.sources.names()).toContain("offline");
  });

  it("registerSource: false suppresses registration even with the nest present", () => {
    const idb = fakeIndexedDb();
    const { ds } = boot({ offline: { indexedDB: idb.factory, registerSource: false } });
    expect(ds.sources.names()).not.toContain("offline");
  });

  it("a custom sourceName is honored", () => {
    const idb = fakeIndexedDb();
    const { ds } = boot({ offline: { indexedDB: idb.factory, sourceName: "cached" } });
    expect(ds.sources.names()).toContain("cached");
  });

  it("the registered adapter is read-only (no fetchDelta, no push) and serves the persisted snapshot", async () => {
    const idb = fakeIndexedDb();
    const { ds, host } = boot({ offline: { indexedDB: idb.factory } });
    const data = host.host.service("stargantt.data");
    data.load({ tasks: [task("t1", 0, 1)] });
    await ds.offline.save();
    ds.sources.activate("offline");
    const loadResult = await ds.load();
    expect(loadResult).toEqual({ ok: true, tasks: 1 });
  });

  it("registration alone changes nothing until the source is activated", () => {
    const idb = fakeIndexedDb();
    const { ds } = boot({ offline: { indexedDB: idb.factory } });
    expect(ds.sources.active()).toBeUndefined();
  });

  it("an empty task list is served when nothing is persisted yet", async () => {
    const idb = fakeIndexedDb();
    const { ds } = boot({ offline: { indexedDB: idb.factory } });
    ds.sources.activate("offline");
    expect(await ds.load()).toEqual({ ok: true, tasks: 0 });
  });
});

describe("offline area — sync/activity (§6.2)", () => {
  it("cause distinguishes manual service calls from the plugin's own auto operations", async () => {
    const idb = fakeIndexedDb();
    const { ds, host, collected } = boot({ offline: { indexedDB: idb.factory, autoSave: true, autoSaveDebounceMs: 0 } });
    const data = host.host.service("stargantt.data");
    // Both the seed `data.load()` (a bulk `data.tasks` notification) and the edit dispatch below
    // trigger one debounced (here: immediate, debounceMs 0) "auto" save each.
    data.load({ tasks: [task("t1", 0, 1)] });
    host.host.dispatch("task/update", { id: "t1", after: { name: "A" } });
    await vi.advanceTimersByTimeAsync(0);
    await ds.offline.save();
    const causes = collected.activity
      .filter((e) => e.area === "offline" && e.op === "save")
      .map((e) => (e as unknown as { cause: string }).cause);
    expect(causes).toEqual(["auto", "auto", "auto", "auto", "manual", "manual"]);
  });

  it("an absent IndexedDB capability performs no operation and emits nothing", async () => {
    const { ds, collected } = boot();
    await ds.offline.save();
    expect(collected.activity.filter((e) => e.area === "offline")).toEqual([]);
  });
});
