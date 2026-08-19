/**
 * §4.1 save()/clear()/persisted()/available(), §4.2 restore(), and §4.3 the `storage/snapshot`
 * extension point.
 */
import { describe, expect, it } from "vitest";
import { boot, fakeIndexedDb, task } from "./_helpers";

describe("offline area — save() / clear() / persisted() / available() (§4.1)", () => {
  it("available() is true with a usable IndexedDB, constant for the instance's life", () => {
    const idb = fakeIndexedDb();
    const { ds } = boot({ offline: { indexedDB: idb.factory } });
    expect(ds.offline.available()).toBe(true);
  });

  it("available() is false, and every method resolves ok:false/persisted:false, with NO IndexedDB at all", async () => {
    // No `offline` nest at all AND no global `indexedDB` in this Node test environment.
    const { ds, collected } = boot();
    expect(ds.offline.available()).toBe(false);
    expect(await ds.offline.save()).toEqual({ ok: false });
    expect(await ds.offline.restore()).toEqual({ ok: false });
    expect(await ds.offline.clear()).toEqual({ ok: false });
    expect(await ds.offline.persisted()).toBe(false);
    expect(collected.errors).toEqual([]); // absent capability is degradation, not a fault
    expect(collected.activity.filter((e) => e.area === "offline")).toEqual([]);
  });

  it("a call after disposal resolves {ok:false, error} rather than reopening an unowned connection (§4.1 terminal close)", async () => {
    const idb = fakeIndexedDb();
    const { ds, host } = boot({ offline: { indexedDB: idb.factory } });
    host.dispose(); // closes the connection terminally via the plugin's ctx.own() disposable
    const saveResult = await ds.offline.save();
    expect(saveResult.ok).toBe(false);
    expect(saveResult.error).toBeDefined();
    const restoreResult = await ds.offline.restore();
    expect(restoreResult.ok).toBe(false);
    expect(restoreResult.error).toBeDefined();
    const clearResult = await ds.offline.clear();
    expect(clearResult.ok).toBe(false);
    expect(clearResult.error).toBeDefined();
  });

  it("save() snapshots toJSON(), writes under documentKey, and emits sync/offlineSaved", async () => {
    const idb = fakeIndexedDb();
    const { ds, host, collected } = boot({ offline: { indexedDB: idb.factory, documentKey: "doc-1" } });
    const data = host.host.service("stargantt.data");
    data.load({ tasks: [task("t1", 0, 1), task("t2", 1, 1)] });
    const result = await ds.offline.save();
    expect(result).toEqual({ ok: true, tasks: 2 });
    expect(collected.offlineSaved).toEqual([{ key: "doc-1", tasks: 2 }]);
    expect(idb.databases.get("stargantt-offline")?.get("documents")?.has("doc-1")).toBe(true);
  });

  it("save() overwrites any previous snapshot whole", async () => {
    const idb = fakeIndexedDb();
    const { ds, host } = boot({ offline: { indexedDB: idb.factory } });
    const data = host.host.service("stargantt.data");
    data.load({ tasks: [task("t1", 0, 1)] });
    await ds.offline.save();
    data.load({ tasks: [task("t2", 0, 1), task("t3", 0, 1)] });
    await ds.offline.save();
    expect(await ds.offline.persisted()).toBe(true);
    const restore = await ds.offline.restore();
    expect(restore.tasks).toBe(2);
  });

  it("clear() deletes the snapshot; a no-op delete still resolves ok:true and emits offlineCleared", async () => {
    const idb = fakeIndexedDb();
    const { ds, collected } = boot({ offline: { indexedDB: idb.factory } });
    expect(await ds.offline.clear()).toEqual({ ok: true }); // nothing persisted yet
    expect(collected.offlineCleared).toEqual([{ key: "default" }]);
  });

  it("persisted() resolves false (never rejects) when the read fails", async () => {
    const idb = fakeIndexedDb();
    idb.failReads = true;
    const { ds } = boot({ offline: { indexedDB: idb.factory } });
    await expect(ds.offline.persisted()).resolves.toBe(false);
  });

  it("a write failure surfaces {ok:false, error} and core/pluginError, resolves (never rejects)", async () => {
    const idb = fakeIndexedDb();
    idb.failWrites = true;
    const { ds, collected } = boot({ offline: { indexedDB: idb.factory } });
    const result = await ds.offline.save();
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(collected.errors.length).toBe(1);
  });

  it("the database connection opens lazily and is reused; a failed open is not cached", async () => {
    const idb = fakeIndexedDb();
    idb.blockOpen = true;
    const { ds } = boot({ offline: { indexedDB: idb.factory } });
    const first = await ds.offline.save();
    expect(first.ok).toBe(false);
    idb.blockOpen = false;
    const second = await ds.offline.save(); // retries the open
    expect(second.ok).toBe(true);
  });
});

describe("offline area — restore() (§4.2)", () => {
  it("replaces store contents via DataService.load(); no snapshot resolves ok:false untouched", async () => {
    const idb = fakeIndexedDb();
    const { ds, host } = boot({ offline: { indexedDB: idb.factory } });
    const data = host.host.service("stargantt.data");
    data.load({ tasks: [task("seed", 0, 1)] });
    const result = await ds.offline.restore();
    expect(result).toEqual({ ok: false });
    expect(data.query().byId.size).toBe(1); // untouched
  });

  it("a record missing any of the five lists is treated exactly like no record", async () => {
    const idb = fakeIndexedDb();
    const { ds } = boot({ offline: { indexedDB: idb.factory } });
    const stores = idb.databases;
    // Write a foreign/corrupt record directly, bypassing the plugin.
    const bucket = new Map<string, Map<string, unknown>>();
    bucket.set("documents", new Map([["default", { tasks: [] /* missing links/resources/... */ }]]));
    stores.set("stargantt-offline", bucket);
    expect(await ds.offline.restore()).toEqual({ ok: false });
  });

  it("is a bulk replacement: clears the pending set and the lazy bookkeeping (§6.1)", async () => {
    const idb = fakeIndexedDb();
    const { ds, host } = boot({ offline: { indexedDB: idb.factory } });
    const data = host.host.service("stargantt.data");
    data.load({ tasks: [task("t1", 0, 1)] });
    await ds.offline.save();
    host.host.dispatch("task/update", { id: "t1", after: { name: "Edited" } });
    expect(ds.pending().updates).toBe(1);
    await ds.offline.restore();
    expect(ds.pending()).toEqual({ creates: 0, updates: 0, removes: 0 });
  });
});

describe("offline area — storage/snapshot extension point (§4.3)", () => {
  function contribution(id: string, value: unknown) {
    const applied: unknown[] = [];
    return {
      id,
      capture: () => value,
      apply: (state: unknown) => void applied.push(state),
      applied,
    };
  }

  it("captures at save time, applies after DataService.load() at restore time", async () => {
    const idb = fakeIndexedDb();
    const { ds, host } = boot({ offline: { indexedDB: idb.factory } });
    const c = contribution("plugin.x", { note: "hello" });
    host.ctxOf("stargantt.data-sync").contribute("storage/snapshot", c);
    const data = host.host.service("stargantt.data");
    data.load({ tasks: [task("t1", 0, 1)] });
    const saveResult = await ds.offline.save();
    expect(saveResult.ok).toBe(true);
    data.load({ tasks: [] }); // clear the store first
    const restoreResult = await ds.offline.restore();
    expect(restoreResult.restored).toEqual(["plugin.x"]);
    expect(c.applied).toEqual([{ note: "hello" }]);
  });

  it("capture() returning undefined omits the entry even if an earlier save stored one", async () => {
    const idb = fakeIndexedDb();
    const { ds, host } = boot({ offline: { indexedDB: idb.factory } });
    let value: unknown = { note: "first" };
    const c = { id: "plugin.x", capture: () => value, apply: () => {} };
    host.ctxOf("stargantt.data-sync").contribute("storage/snapshot", c);
    await ds.offline.save();
    value = undefined;
    await ds.offline.save();
    const restoreResult = await ds.offline.restore();
    expect(restoreResult.restored).toBeUndefined();
  });

  it("a throwing capture()/apply() is fault-isolated: the rest still runs, save()/restore() still succeed", async () => {
    const idb = fakeIndexedDb();
    const { ds, host, collected } = boot({ offline: { indexedDB: idb.factory } });
    const bad = {
      id: "bad",
      capture: () => {
        throw new Error("capture boom");
      },
      apply: () => {},
    };
    const good = contribution("good", { ok: true });
    host.ctxOf("stargantt.data-sync").contribute("storage/snapshot", bad);
    host.ctxOf("stargantt.data-sync").contribute("storage/snapshot", good);
    const saveResult = await ds.offline.save();
    expect(saveResult.ok).toBe(true);
    expect(collected.errors.length).toBe(1);
  });

  it("a duplicate contribution id: first wins, the rest are dropped and reported", async () => {
    const idb = fakeIndexedDb();
    const { ds, host, collected } = boot({ offline: { indexedDB: idb.factory } });
    const first = contribution("dup", { from: "first" });
    const second = contribution("dup", { from: "second" });
    host.ctxOf("stargantt.data-sync").contribute("storage/snapshot", first);
    host.ctxOf("stargantt.data-sync").contribute("storage/snapshot", second);
    await ds.offline.save();
    expect(collected.errors.some((e) => String((e.error as { where?: string })?.where ?? "").includes("snapshot"))).toBe(true);
  });

  it("an entry with no matching contribution at restore is silently left unapplied", async () => {
    const idb = fakeIndexedDb();
    const h1 = boot({ offline: { indexedDB: idb.factory } });
    const c = contribution("gone", { x: 1 });
    h1.host.ctxOf("stargantt.data-sync").contribute("storage/snapshot", c);
    await h1.ds.offline.save();
    // A second, independent host over the SAME fake database, with no contribution registered.
    const h2 = boot({ offline: { indexedDB: idb.factory } });
    const restoreResult = await h2.ds.offline.restore();
    expect(restoreResult.ok).toBe(true);
    expect(restoreResult.restored).toBeUndefined();
  });
});
