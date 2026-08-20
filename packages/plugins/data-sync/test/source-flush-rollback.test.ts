/**
 * §2.4 `flush()` (optimistic write-back + rollback), §2.5 `rollback()` (explicit revert), and the
 * §1 "superseded flush drops the taken batch WITHOUT rollback" rule, including coverage for
 * `rollback()` and the superseded-flush-no-rollback case.
 */
import { describe, expect, it } from "vitest";
import { boot, scriptedAdapter, task } from "./_helpers";

async function seeded() {
  const h = boot();
  const adapter = scriptedAdapter();
  adapter.nextFetch = { tasks: [task("t1", 0, 1)], syncToken: "tok-0" };
  h.ds.sources.register("a", adapter);
  h.ds.sources.activate("a");
  await h.ds.load();
  return { ...h, adapter };
}

describe("source area — flush()", () => {
  it("resolves ok:true with zero counts and calls nothing when nothing is pending", async () => {
    const { ds, adapter } = await seeded();
    const result = await ds.flush();
    expect(result).toEqual({ ok: true, sent: { creates: 0, updates: 0, removes: 0 } });
    expect(adapter.pushCalls.length).toBe(0);
  });

  it("resolves ok:false when no source is active or the active adapter has no push", async () => {
    const { ds } = boot();
    expect(await ds.flush()).toEqual({ ok: false });
    const readOnly = scriptedAdapter({ push: false });
    ds.sources.register("ro", readOnly);
    ds.sources.activate("ro");
    expect(await ds.flush()).toEqual({ ok: false });
  });

  it("pushes the coalesced pending batch and advances the sync token on success", async () => {
    const { ds, host, adapter } = await seeded();
    host.host.dispatch("task/update", { id: "t1", after: { name: "Renamed" } });
    host.host.dispatch("task/add", { task: { name: "New" } });
    adapter.nextPush = { syncToken: "tok-1" };
    const result = await ds.flush();
    expect(result.ok).toBe(true);
    expect(result.sent).toEqual({ creates: 1, updates: 1, removes: 0 });
    expect(adapter.pushCalls.length).toBe(1);
    expect(ds.pending()).toEqual({ creates: 0, updates: 0, removes: 0 });

    // The advanced token is used on the next delta sync.
    adapter.nextDelta = { syncToken: "tok-2", changes: [] };
    await ds.sync();
    expect(adapter.deltaCalls[0]?.syncToken).toBe("tok-1");
  });

  it("rolls back a rejected batch by default (rollbackOnError: true)", async () => {
    const { ds, host, adapter, collected } = await seeded();
    host.host.dispatch("task/update", { id: "t1", after: { name: "Renamed" } });
    adapter.pushError = new Error("rejected");
    const result = await ds.flush();
    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(true);
    const data = host.host.service("stargantt.data");
    expect(data.getTask("t1")?.name).toBe("Task t1"); // reverted
    expect(collected.rolledBack).toEqual([{ source: "a", tasks: 1, cause: "flush" }]);
    expect(collected.errors.length).toBe(1);
  });

  it("rollbackOnError: false leaves local changes in place, no longer pending", async () => {
    const h = boot({ rollbackOnError: false });
    const adapter = scriptedAdapter();
    adapter.nextFetch = { tasks: [task("t1", 0, 1)], syncToken: "tok-0" };
    h.ds.sources.register("a", adapter);
    h.ds.sources.activate("a");
    await h.ds.load();
    h.host.host.dispatch("task/update", { id: "t1", after: { name: "Renamed" } });
    adapter.pushError = new Error("rejected");
    const result = await h.ds.flush();
    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBeUndefined();
    const data = h.host.host.service("stargantt.data");
    expect(data.getTask("t1")?.name).toBe("Renamed"); // NOT reverted
    expect(h.ds.pending()).toEqual({ creates: 0, updates: 0, removes: 0 }); // no longer pending
  });

  it("skips mid-flight re-edited ids on rollback: reverts only ids with no new pending entry", async () => {
    const { ds, host, adapter } = await seeded();
    host.host.dispatch("task/update", { id: "t1", after: { name: "First edit" } });
    let resolvePush: (() => void) | undefined;
    adapter.push = () =>
      new Promise((_resolve, reject) => {
        resolvePush = () => reject(new Error("rejected"));
      });
    const flushPromise = ds.flush();
    // A second edit lands while the push is in flight — this id must NOT be reverted.
    host.host.dispatch("task/update", { id: "t1", after: { name: "Mid-flight edit" } });
    resolvePush?.();
    const result = await flushPromise;
    expect(result.rolledBack).toBe(true);
    const data = host.host.service("stargantt.data");
    expect(data.getTask("t1")?.name).toBe("Mid-flight edit"); // untouched by the rollback
  });

  it("a superseded flush (activate() elsewhere while in flight) drops the batch WITHOUT rollback", async () => {
    const { ds, host, adapter } = await seeded();
    host.host.dispatch("task/update", { id: "t1", after: { name: "Renamed" } });
    let rejectPush: ((e: unknown) => void) | undefined;
    adapter.push = () => new Promise((_resolve, reject) => (rejectPush = reject));
    const other = scriptedAdapter();
    ds.sources.register("other", other);
    const flushPromise = ds.flush();
    ds.sources.activate("other"); // supersedes the in-flight flush's generation
    rejectPush?.(new Error("rejected"));
    const result = await flushPromise;
    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBeUndefined(); // NOT rolled back
    const data = host.host.service("stargantt.data");
    // The superseding activate() already cleared pending/reset baseline; the reverted value must
    // not have been written back either way.
    expect(data.getTask("t1")?.name).toBe("Renamed");
  });
});

describe("source area — rollback() (explicit, §2.5)", () => {
  it("reverts the current pending set synchronously and returns the touched count", async () => {
    const { ds, host, collected } = await seeded();
    host.host.dispatch("task/update", { id: "t1", after: { name: "Renamed" } });
    const result = ds.rollback();
    expect(result).toEqual({ ok: true, tasks: 1 });
    const data = host.host.service("stargantt.data");
    expect(data.getTask("t1")?.name).toBe("Task t1");
    expect(collected.rolledBack).toEqual([{ source: "a", tasks: 1, cause: "api" }]);
    expect(ds.pending()).toEqual({ creates: 0, updates: 0, removes: 0 });
  });

  it("an empty pending set resolves {ok:true, tasks:0} and emits nothing", async () => {
    const { ds, collected } = await seeded();
    const result = ds.rollback();
    expect(result).toEqual({ ok: true, tasks: 0 });
    expect(collected.rolledBack).toEqual([]);
  });

  it("omits `source` when no source is active", () => {
    const { ds, host, collected } = boot();
    const data = host.host.service("stargantt.data");
    data.load({ tasks: [task("t1", 0, 1)] });
    host.host.dispatch("task/update", { id: "t1", after: { name: "Renamed" } });
    const result = ds.rollback();
    expect(result).toEqual({ ok: true, tasks: 1 });
    expect(collected.rolledBack).toEqual([{ tasks: 1, cause: "api" }]);
  });

  it("touches no sync token and no backend", async () => {
    const { ds, host, adapter } = await seeded();
    host.host.dispatch("task/update", { id: "t1", after: { name: "Renamed" } });
    ds.rollback();
    expect(adapter.pushCalls.length).toBe(0);
    // sync() still uses the token load() established (untouched by rollback()).
    adapter.nextDelta = { syncToken: "tok-1", changes: [] };
    await ds.sync();
    expect(adapter.deltaCalls[0]?.syncToken).toBe("tok-0");
  });
});
