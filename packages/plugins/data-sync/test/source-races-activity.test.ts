/**
 * §1 disposal + async generation-counter staleness (source area), and §6.2 `sync/activity` for
 * `load`/`sync`/`flush`.
 */
import { describe, expect, it } from "vitest";
import { boot, scriptedAdapter, task } from "./_helpers";

describe("source area — disposal and generation staleness (§1)", () => {
  it("a load() in flight at disposal never touches the store", async () => {
    const { ds, host } = boot();
    const adapter = scriptedAdapter();
    let resolveFetch: (() => void) | undefined;
    adapter.fetch = () =>
      new Promise((resolve) => {
        resolveFetch = () => resolve({ tasks: [task("t1", 0, 1)] });
      });
    ds.sources.register("a", adapter);
    ds.sources.activate("a");
    const loadPromise = ds.load();
    host.dispose();
    resolveFetch?.();
    const result = await loadPromise;
    expect(result).toEqual({ ok: false });
  });

  it("activate() to a different source supersedes a load() still in flight against the old one", async () => {
    const { ds, host } = boot();
    const adapter = scriptedAdapter();
    let resolveFetch: (() => void) | undefined;
    adapter.fetch = () =>
      new Promise((resolve) => {
        resolveFetch = () => resolve({ tasks: [task("stale", 0, 1)] });
      });
    ds.sources.register("a", adapter);
    ds.sources.activate("a");
    const loadPromise = ds.load();

    const other = scriptedAdapter();
    other.nextFetch = { tasks: [task("fresh", 0, 1)] };
    ds.sources.register("other", other);
    ds.sources.activate("other");
    await ds.load(); // this one wins

    resolveFetch?.(); // the stale one settles after
    await loadPromise;

    const data = host.host.service("stargantt.data");
    expect(data.getTask("stale")).toBeUndefined();
    expect(data.getTask("fresh")).toBeDefined();
  });

  it("an adapter error on a superseded call is swallowed (no core/pluginError, no stale write)", async () => {
    const { ds, collected } = boot();
    const adapter = scriptedAdapter();
    let rejectFetch: ((e: unknown) => void) | undefined;
    adapter.fetch = () => new Promise((_resolve, reject) => (rejectFetch = reject));
    ds.sources.register("a", adapter);
    ds.sources.activate("a");
    const loadPromise = ds.load();
    ds.sources.activate("a"); // no-op (same name) — use a real supersede instead:
    const other = scriptedAdapter();
    ds.sources.register("other", other);
    ds.sources.activate("other");
    rejectFetch?.(new Error("late failure"));
    const result = await loadPromise;
    expect(result).toEqual({ ok: false });
    expect(collected.errors).toEqual([]);
  });
});

describe("source area — sync/activity (§6.2)", () => {
  it("brackets load() with pending 1 then 0, and fires the terminal event first", async () => {
    const { ds, collected } = boot();
    const adapter = scriptedAdapter();
    adapter.nextFetch = { tasks: [] };
    ds.sources.register("a", adapter);
    ds.sources.activate("a");
    await ds.load();
    const activity = collected.activity.filter((e) => e.area === "source" && e.op === "load");
    expect(activity.map((e) => e.pending)).toEqual([1, 0]);
    // Ordering (§6.2): the terminal event (sourceSynced) precedes the decremented activity event.
    const syncedIndex = collected.sequence.indexOf("sync/sourceSynced");
    const lastActivityIndex = collected.sequence.lastIndexOf("sync/activity");
    expect(syncedIndex).toBeGreaterThanOrEqual(0);
    expect(syncedIndex).toBeLessThan(lastActivityIndex);
  });

  it("FAILURE ordering: core/pluginError precedes the decremented sync/activity (positive control for the success-path ordering above)", async () => {
    const { ds, collected } = boot();
    const adapter = scriptedAdapter();
    adapter.fetch = () => Promise.reject(new Error("adapter boom"));
    ds.sources.register("a", adapter);
    ds.sources.activate("a");
    const result = await ds.load();
    expect(result.ok).toBe(false);
    const activity = collected.activity.filter((e) => e.area === "source" && e.op === "load");
    expect(activity.map((e) => e.pending)).toEqual([1, 0]); // finally-decrement still fired
    const errorIndex = collected.sequence.indexOf("core/pluginError");
    const lastActivityIndex = collected.sequence.lastIndexOf("sync/activity");
    expect(errorIndex).toBeGreaterThanOrEqual(0);
    expect(errorIndex).toBeLessThan(lastActivityIndex);
    // And, unlike the success path, sync/sourceSynced never fires at all.
    expect(collected.synced).toEqual([]);
  });

  it("a flush() with nothing pending never touches the counter", async () => {
    const { ds, collected } = boot();
    const adapter = scriptedAdapter();
    adapter.nextFetch = { tasks: [task("t1", 0, 1)], syncToken: "tok" };
    ds.sources.register("a", adapter);
    ds.sources.activate("a");
    await ds.load();
    await ds.flush(); // nothing pending
    expect(collected.activity.filter((e) => e.op === "flush")).toEqual([]);
  });

  it("a load()/sync() with no active source never touches the counter", async () => {
    const { ds, collected } = boot();
    await ds.load();
    await ds.sync();
    expect(collected.activity).toEqual([]);
  });

  it("two overlapping load() calls produce 1→2→1→0 (the counter, not a single call, is bracketed)", async () => {
    const { ds, collected } = boot();
    const a = scriptedAdapter();
    const resolvers: (() => void)[] = [];
    a.fetch = () =>
      new Promise((resolve) => {
        resolvers.push(() => resolve({ tasks: [] }));
      });
    ds.sources.register("a", a);
    ds.sources.activate("a");

    const first = ds.load();
    const second = ds.load(); // overlaps: both against the same active source
    expect(resolvers).toHaveLength(2);
    resolvers[0]!();
    await first;
    resolvers[1]!();
    await second;

    const pendings = collected.activity.filter((e) => e.op === "load").map((e) => e.pending);
    expect(pendings).toEqual([1, 2, 1, 0]);
  });
});
