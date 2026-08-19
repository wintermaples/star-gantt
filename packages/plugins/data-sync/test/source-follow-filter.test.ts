/**
 * §2.6 server-side filter forwarding (`followFilter`), including explicit coverage that
 * `debounceMs: 0` is a ZERO-DELAY TIMER (recorded deviation), never a synchronous same-stack
 * reload — the trigger is a store notification, and store subscribers only schedule.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boot, filterStub, scriptedAdapter } from "./_helpers";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("source area — followFilter (§2.6)", () => {
  it("is inert without the stargantt.filter service (no crash, no reload)", async () => {
    const { ds } = boot({ followFilter: true });
    const adapter = scriptedAdapter();
    ds.sources.register("a", adapter);
    ds.sources.activate("a");
    await vi.runAllTimersAsync();
    expect(adapter.fetchCalls.length).toBe(0);
  });

  it("forwards query/criteria and reloads, debounced, on every filter.state notification", async () => {
    const filter = filterStub();
    const h = boot({ followFilter: true, followFilterDebounceMs: 50 }, { services: { "stargantt.filter": filter.service } });
    const adapter = scriptedAdapter();
    adapter.nextFetch = { tasks: [] };
    h.ds.sources.register("a", adapter);
    h.ds.sources.activate("a");
    await vi.advanceTimersByTimeAsync(0); // let lifecycle/ready's subscription land

    filter.set({ query: "foo" });
    expect(adapter.fetchCalls.length).toBe(0); // scheduled, not yet run
    await vi.advanceTimersByTimeAsync(49);
    expect(adapter.fetchCalls.length).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(adapter.fetchCalls.length).toBe(1);
    expect(adapter.fetchCalls[0]?.filter).toEqual({ query: "foo" });
    expect(h.ds.filter()).toEqual({ query: "foo" });
  });

  it("disposal cancels an armed debounce timer (§2.6, review round 2): the reload never fires", async () => {
    const filter = filterStub();
    const h = boot({ followFilter: true, followFilterDebounceMs: 50 }, { services: { "stargantt.filter": filter.service } });
    const adapter = scriptedAdapter();
    adapter.nextFetch = { tasks: [] };
    h.ds.sources.register("a", adapter);
    h.ds.sources.activate("a");
    await vi.advanceTimersByTimeAsync(0);

    filter.set({ query: "foo" }); // arms the debounce timer
    expect(adapter.fetchCalls.length).toBe(0);
    h.host.dispose(); // must cancel the armed timer via its ctx.own() disposable
    await vi.advanceTimersByTimeAsync(1000);
    expect(adapter.fetchCalls.length).toBe(0); // the reload never ran
  });

  it("debounceMs: 0 is a ZERO-DELAY TIMER, never a synchronous same-stack reload (recorded deviation)", async () => {
    const filter = filterStub();
    const h = boot({ followFilter: true, followFilterDebounceMs: 0 }, { services: { "stargantt.filter": filter.service } });
    const adapter = scriptedAdapter();
    adapter.nextFetch = { tasks: [] };
    h.ds.sources.register("a", adapter);
    h.ds.sources.activate("a");
    await vi.advanceTimersByTimeAsync(0);

    filter.set({ query: "bar" });
    // Still on the store's own dispatching stack: the reload must NOT have run synchronously.
    expect(adapter.fetchCalls.length).toBe(0);
    await vi.advanceTimersByTimeAsync(0); // the zero-delay timer's macrotask
    expect(adapter.fetchCalls.length).toBe(1);
  });

  it("does nothing while no source is active", async () => {
    const filter = filterStub();
    const h = boot({ followFilter: true }, { services: { "stargantt.filter": filter.service } });
    const adapter = scriptedAdapter();
    h.ds.sources.register("a", adapter); // registered, NOT activated
    await vi.advanceTimersByTimeAsync(0);
    filter.set({ query: "x" });
    await vi.runAllTimersAsync();
    expect(adapter.fetchCalls.length).toBe(0);
  });

  it("owns the filter slot wholesale: a direct setFilter() is overwritten on the next filter change", async () => {
    const filter = filterStub();
    const h = boot({ followFilter: true, followFilterDebounceMs: 10 }, { services: { "stargantt.filter": filter.service } });
    const adapter = scriptedAdapter();
    adapter.nextFetch = { tasks: [] };
    h.ds.sources.register("a", adapter);
    h.ds.sources.activate("a");
    await vi.advanceTimersByTimeAsync(0);

    h.ds.setFilter({ query: "manual" });
    expect(h.ds.filter()).toEqual({ query: "manual" });
    filter.set({ query: "from-filter" });
    await vi.advanceTimersByTimeAsync(10);
    expect(h.ds.filter()).toEqual({ query: "from-filter" }); // overwritten wholesale
  });

  it("seeds the store when the plugin boots without followFilter — no adapter calls at all", async () => {
    const { ds } = boot();
    const adapter = scriptedAdapter();
    ds.sources.register("a", adapter);
    ds.sources.activate("a");
    ds.setFilter({ query: "manual-only" });
    expect(ds.filter()).toEqual({ query: "manual-only" });
    expect(adapter.fetchCalls.length).toBe(0); // setFilter triggers no request itself
  });

  it("setFilter with a non-object argument counts as null", () => {
    const { ds } = boot();
    ds.setFilter({ query: "x" });
    // @ts-expect-error deliberately non-object for the test
    ds.setFilter("not-an-object");
    expect(ds.filter()).toBeNull();
  });
});
