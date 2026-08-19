/**
 * §1 lazy-area generation-counter staleness + disposal, and §6.2 `sync/activity` for `fetchRange`.
 */
import { describe, expect, it } from "vitest";
import { boot, scriptedLazyAdapter, task } from "./_helpers";

describe("lazy area — disposal and generation staleness (§1)", () => {
  it("a page fetch in flight at disposal never marks the page loaded or touches the store", async () => {
    const { ds, host } = boot({ lazyLoad: { pageSize: 10 } });
    const adapter = scriptedLazyAdapter();
    let resolveFetch: (() => void) | undefined;
    adapter.fetchRange = () =>
      new Promise((resolve) => {
        resolveFetch = () => resolve({ tasks: [task("t1", 0, 1)] });
      });
    ds.lazy.sources.register("a", adapter);
    ds.lazy.sources.activate("a");
    const ensurePromise = ds.lazy.ensureRange(0, 10);
    host.dispose();
    resolveFetch?.();
    const result = await ensurePromise;
    expect(result.ok).toBe(false);
    expect(ds.lazy.loadedPages()).toBe(0);
  });

  it("activate() to a different source supersedes a page fetch in flight against the old one", async () => {
    const { ds } = boot({ lazyLoad: { pageSize: 10 } });
    const a = scriptedLazyAdapter();
    let resolveA: (() => void) | undefined;
    a.fetchRange = () =>
      new Promise((resolve) => {
        resolveA = () => resolve({ tasks: [task("stale", 0, 1)] });
      });
    ds.lazy.sources.register("a", a);
    ds.lazy.sources.activate("a");
    const first = ds.lazy.ensureRange(0, 10);

    const b = scriptedLazyAdapter();
    b.replies.set(0, { tasks: [task("fresh", 0, 1)] });
    ds.lazy.sources.register("b", b);
    ds.lazy.sources.activate("b"); // resets bookkeeping, bumps generation
    await ds.lazy.ensureRange(0, 10);
    expect(ds.lazy.loadedPages()).toBe(1); // page 0 from "b"

    resolveA?.(); // settles after the supersede
    const result = await first;
    expect(result.ok).toBe(false);
    // Still exactly 1 loaded page — the stale reply from "a" never touched "b"'s bookkeeping.
    expect(ds.lazy.loadedPages()).toBe(1);
  });

  it("reset() supersedes any in-flight ensureRange call", async () => {
    const { ds } = boot({ lazyLoad: { pageSize: 10 } });
    const adapter = scriptedLazyAdapter();
    let resolveFetch: (() => void) | undefined;
    adapter.fetchRange = () =>
      new Promise((resolve) => {
        resolveFetch = () => resolve({ tasks: [task("t1", 0, 1)] });
      });
    ds.lazy.sources.register("a", adapter);
    ds.lazy.sources.activate("a");
    const ensurePromise = ds.lazy.ensureRange(0, 10);
    ds.lazy.reset();
    resolveFetch?.();
    const result = await ensurePromise;
    expect(result.ok).toBe(false);
    expect(ds.lazy.loadedPages()).toBe(0);
  });

  it("a bulk store replacement supersedes an in-flight page fetch (§6.1)", async () => {
    const { ds, host } = boot({ lazyLoad: { pageSize: 10 } });
    const adapter = scriptedLazyAdapter();
    let resolveFetch: (() => void) | undefined;
    adapter.fetchRange = () =>
      new Promise((resolve) => {
        resolveFetch = () => resolve({ tasks: [task("t1", 0, 1)] });
      });
    ds.lazy.sources.register("a", adapter);
    ds.lazy.sources.activate("a");
    const ensurePromise = ds.lazy.ensureRange(0, 10);
    const data = host.host.service("stargantt.data");
    data.load({ tasks: [task("bulk", 0, 1)] }); // bulk replacement, no transaction
    resolveFetch?.();
    const result = await ensurePromise;
    expect(result.ok).toBe(false);
    expect(ds.lazy.loadedPages()).toBe(0);
  });
});

describe("lazy area — sync/activity (§6.2)", () => {
  it("brackets a fetching ensureRange call with pending 1 then 0", async () => {
    const { ds, collected } = boot({ lazyLoad: { pageSize: 10 } });
    const adapter = scriptedLazyAdapter();
    adapter.replies.set(0, { tasks: [] });
    ds.lazy.sources.register("a", adapter);
    ds.lazy.sources.activate("a");
    await ds.lazy.ensureRange(0, 10);
    const activity = collected.activity.filter((e) => e.area === "lazy");
    expect(activity.map((e) => e.pending)).toEqual([1, 0]);
  });

  it("a call satisfied without any request (fully covered) emits nothing", async () => {
    const { ds, collected } = boot({ lazyLoad: { pageSize: 10 } });
    const adapter = scriptedLazyAdapter();
    adapter.replies.set(0, { tasks: [] });
    ds.lazy.sources.register("a", adapter);
    ds.lazy.sources.activate("a");
    await ds.lazy.ensureRange(0, 10);
    collected.activity.length = 0;
    await ds.lazy.ensureRange(0, 10); // already loaded — no request
    expect(collected.activity).toEqual([]);
  });

  it("no active source never touches the counter", async () => {
    const { ds, collected } = boot();
    await ds.lazy.ensureRange(0, 10);
    expect(collected.activity).toEqual([]);
  });
});
