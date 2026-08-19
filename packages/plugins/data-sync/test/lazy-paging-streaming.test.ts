/**
 * §3.1 `ensureRange` (pages/dedup/cursors/total) and §3.2 `applyChanges` (minimal merge).
 */
import { describe, expect, it } from "vitest";
import { boot, scriptedLazyAdapter, task } from "./_helpers";

describe("lazy area — ensureRange (§3.1)", () => {
  it("no active source resolves ok:false", async () => {
    const { ds } = boot();
    expect(await ds.lazy.ensureRange(0, 10)).toEqual({ ok: false });
  });

  it("unusable arguments resolve {ok:true, pages:0} without a request", async () => {
    const { ds } = boot();
    const adapter = scriptedLazyAdapter();
    ds.lazy.sources.register("a", adapter);
    ds.lazy.sources.activate("a");
    expect(await ds.lazy.ensureRange(Number.NaN, 10)).toEqual({ ok: true, pages: 0 });
    expect(await ds.lazy.ensureRange(-5, 10)).toEqual({ ok: true, pages: 0 });
    expect(await ds.lazy.ensureRange(0, 0)).toEqual({ ok: true, pages: 0 });
    expect(adapter.calls).toHaveLength(0);
  });

  it("fetches the missing pages sequentially, ascending order, dedup on overlap", async () => {
    const { ds, collected } = boot({ lazyLoad: { pageSize: 10 } });
    const adapter = scriptedLazyAdapter();
    adapter.replies.set(0, { tasks: [task("a", 0, 1)], total: 25 });
    adapter.replies.set(10, { tasks: [task("b", 0, 1)] });
    ds.lazy.sources.register("a", adapter);
    ds.lazy.sources.activate("a");
    const result = await ds.lazy.ensureRange(0, 15); // pages 0 and 1
    expect(result).toEqual({ ok: true, pages: 2 });
    expect(adapter.calls.map((c) => c.offset)).toEqual([0, 10]);
    expect(collected.lazyRangeLoaded).toHaveLength(2);
    expect(ds.lazy.total()).toBe(25);
    expect(ds.lazy.loadedPages()).toBe(2);

    // Re-fetching an overlapping range dedups already-loaded pages.
    await ds.lazy.ensureRange(0, 15);
    expect(adapter.calls).toHaveLength(2); // no new calls
  });

  it("cursor-based paging: page n+1's request carries page n's returned cursor", async () => {
    const { ds } = boot({ lazyLoad: { pageSize: 10 } });
    const adapter = scriptedLazyAdapter();
    adapter.replies.set(0, { tasks: [task("a", 0, 1)], cursor: "cur-1" });
    adapter.replies.set(10, { tasks: [task("b", 0, 1)] });
    ds.lazy.sources.register("a", adapter);
    ds.lazy.sources.activate("a");
    await ds.lazy.ensureRange(0, 15);
    expect(adapter.calls[0]!.cursor).toBeUndefined();
    expect(adapter.calls[1]!.cursor).toBe("cur-1");
  });

  it("a range entirely beyond a known total resolves {ok:true, pages:0}", async () => {
    const { ds } = boot({ lazyLoad: { pageSize: 10 } });
    const adapter = scriptedLazyAdapter();
    adapter.replies.set(0, { tasks: [task("a", 0, 1)], total: 5 });
    ds.lazy.sources.register("a", adapter);
    ds.lazy.sources.activate("a");
    await ds.lazy.ensureRange(0, 10);
    expect(await ds.lazy.ensureRange(100, 10)).toEqual({ ok: true, pages: 0 });
  });

  it("isRangeLoaded agrees with ensureRange at every boundary, incl. the dataset tail", async () => {
    const { ds } = boot({ lazyLoad: { pageSize: 10 } });
    const adapter = scriptedLazyAdapter();
    adapter.replies.set(0, { tasks: [task("a", 0, 1)], total: 5 });
    ds.lazy.sources.register("a", adapter);
    ds.lazy.sources.activate("a");
    expect(ds.lazy.isRangeLoaded(0, 10)).toBe(false);
    await ds.lazy.ensureRange(0, 10);
    expect(ds.lazy.isRangeLoaded(0, 10)).toBe(true);
    expect(ds.lazy.isRangeLoaded(100, 10)).toBe(true); // at/beyond total
    expect(ds.lazy.isRangeLoaded(Number.NaN, 10)).toBe(false); // unusable
  });

  it("page application is add-only: an existing id is skipped, never clobbered", async () => {
    const { ds, host } = boot({ lazyLoad: { pageSize: 10 } });
    const data = host.host.service("stargantt.data");
    data.load({ tasks: [task("dup", 0, 1, { name: "Local" })] });
    const adapter = scriptedLazyAdapter();
    adapter.replies.set(0, { tasks: [{ ...task("dup", 5, 1, { name: "Remote" }) }, task("new", 0, 1)] });
    ds.lazy.sources.register("a", adapter);
    ds.lazy.sources.activate("a");
    await ds.lazy.ensureRange(0, 10);
    expect(data.getTask("dup")?.name).toBe("Local"); // untouched
    expect(data.getTask("new")).toBeDefined();
  });

  it("a malformed reply (no tasks array) fails the whole call; already-applied pages stay applied", async () => {
    const { ds } = boot({ lazyLoad: { pageSize: 10 } });
    const adapter = scriptedLazyAdapter();
    adapter.replies.set(0, { tasks: [task("a", 0, 1)] });
    // @ts-expect-error deliberately malformed
    adapter.replies.set(10, { notTasks: [] });
    ds.lazy.sources.register("a", adapter);
    ds.lazy.sources.activate("a");
    const result = await ds.lazy.ensureRange(0, 20);
    expect(result.ok).toBe(false);
    expect(result.pages).toBe(1); // page 0 succeeded before page 1 failed
    expect(ds.lazy.isRangeLoaded(0, 10)).toBe(true);
  });

  it("activate() to a different source resets bookkeeping; reset() does too", async () => {
    const { ds } = boot({ lazyLoad: { pageSize: 10 } });
    const a = scriptedLazyAdapter();
    a.replies.set(0, { tasks: [task("a", 0, 1)], total: 5 });
    ds.lazy.sources.register("a", a);
    ds.lazy.sources.activate("a");
    await ds.lazy.ensureRange(0, 10);
    expect(ds.lazy.total()).toBe(5);

    const b = scriptedLazyAdapter();
    ds.lazy.sources.register("b", b);
    ds.lazy.sources.activate("b");
    expect(ds.lazy.total()).toBeUndefined();
    expect(ds.lazy.loadedPages()).toBe(0);

    ds.lazy.sources.activate("a");
    await ds.lazy.ensureRange(0, 10); // re-fetches, since bookkeeping was reset
    expect(a.calls).toHaveLength(2);
    ds.lazy.reset();
    expect(ds.lazy.loadedPages()).toBe(0);
  });
});

describe("lazy area — applyChanges (§3.2, minimal merge)", () => {
  it("upsert of an unknown id becomes task/add; known id becomes task/update with MINIMAL merge", () => {
    const { ds, host, collected } = boot();
    const data = host.host.service("stargantt.data");
    data.load({ tasks: [task("t1", 0, 1, { progress: 0.5 })] });
    const applied = ds.lazy.applyChanges([
      { type: "upsert", task: task("new", 5, 1) },
      { type: "upsert", task: { id: "t1", parentId: null, name: "Renamed", start: 0, end: 86_400_000 } },
    ]);
    expect(applied).toEqual({ added: 1, updated: 1, removed: 0 });
    expect(data.getTask("new")).toBeDefined();
    expect(data.getTask("t1")?.name).toBe("Renamed");
    // Minimal merge: `progress` was NOT in the incoming row, so it survives (unlike sync()'s
    // converge-exactly rule, which would have cleared it — §3.2 is deliberately weaker).
    expect(data.getTask("t1")?.progress).toBe(0.5);
    expect(collected.lazyChangesApplied).toEqual([{ applied }]);
  });

  it("a batch with every count zero emits nothing", () => {
    const { ds, collected } = boot();
    const applied = ds.lazy.applyChanges([{ type: "remove", id: "unknown" }]);
    expect(applied).toEqual({ added: 0, updated: 0, removed: 0 });
    expect(collected.lazyChangesApplied).toEqual([]);
  });

  it("removes a known id, ignores an unknown one; unusable input counts as an empty batch", () => {
    const { ds, host } = boot();
    const data = host.host.service("stargantt.data");
    data.load({ tasks: [task("t1", 0, 1)] });
    const applied = ds.lazy.applyChanges([{ type: "remove", id: "t1" }]);
    expect(applied).toEqual({ added: 0, updated: 0, removed: 1 });
    expect(data.getTask("t1")).toBeUndefined();
    // @ts-expect-error deliberately unusable
    expect(ds.lazy.applyChanges(null)).toEqual({ added: 0, updated: 0, removed: 0 });
  });

  it("a StreamChange (= DeltaChange) can feed both sync()'s and applyChanges()'s planners, with DIFFERENT results", () => {
    const { ds, host } = boot();
    const data = host.host.service("stargantt.data");
    data.load({ tasks: [task("t1", 0, 1, { progress: 0.5 })] });
    const change = { type: "upsert" as const, task: { id: "t1", parentId: null, name: "Renamed", start: 0, end: 86_400_000 } };
    ds.lazy.applyChanges([change]);
    // Minimal merge: progress survives via the lazy path.
    expect(data.getTask("t1")?.progress).toBe(0.5);
  });
});
