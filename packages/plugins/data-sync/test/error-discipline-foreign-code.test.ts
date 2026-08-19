/**
 * §1 "Error discipline": every async facade method resolves, NEVER rejects — including when the
 * store-application step runs directly over FOREIGN DATA that can throw (a `FieldMapping`
 * accessor function, a poisoned property getter on an adapter's reply row). Three guarded sites
 * (review round 1, MAJOR 1):
 *   - source `load()`/`sync()`'s full-snapshot path: `data.load(input, result.mapping)`
 *     (`internal/adapters/wire.ts`, `loadInternal`).
 *   - source `sync()`'s delta path: `planDelta` + the dispatch loop over `delta.changes` rows
 *     (`internal/adapters/wire.ts`, `sync`).
 *   - lazy `ensureRange()`'s page application: `applyPage` over `reply.tasks` rows
 *     (`internal/lazy/wire.ts`).
 * Each of these is reachable through an internal `void load()` / `void ensureRange()` call
 * (autoLoad, followFilter, viewport following/prefetch) with no caller to observe a rejection —
 * an unguarded throw there would be an unhandled promise rejection, not just a wrong return value.
 */
import { describe, expect, it } from "vitest";
import type { Task } from "@stargantt/plugin-data-store";
import { boot, scriptedAdapter, scriptedLazyAdapter, task } from "./_helpers";

/** A task-shaped object whose `id` getter throws on first access — the minimal "foreign poison". */
function poisonedRow(): Task {
  return {
    get id(): never {
      throw new Error("poisoned getter: id");
    },
    name: "poisoned",
    start: 0,
    end: 1,
  } as unknown as Task;
}

/**
 * Runs `run`, and reports any `unhandledRejection` that fires while it runs (plus one macrotask
 * of drain time afterward, so a same-tick `void somePromise()` rejection has a chance to surface).
 */
async function withUnhandledRejectionCapture<T>(run: () => Promise<T>): Promise<{ result: T; unhandled: unknown[] }> {
  const unhandled: unknown[] = [];
  const handler = (reason: unknown): void => void unhandled.push(reason);
  process.on("unhandledRejection", handler);
  try {
    const result = await run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { result, unhandled };
  } finally {
    process.off("unhandledRejection", handler);
  }
}

describe("source area — load()/sync() full-snapshot path resolves even when result.mapping throws", () => {
  it("a throwing FieldMapping accessor: load() resolves {ok:false} + exactly one core/pluginError, activity still brackets 1→0", async () => {
    const { ds, host, collected } = boot();
    const adapter = scriptedAdapter({ delta: false, push: false });
    adapter.nextFetch = {
      tasks: [{ id: "t1" }],
      mapping: {
        task: {
          name: () => {
            throw new Error("mapping accessor boom");
          },
        },
      },
    };
    ds.sources.register("a", adapter);
    ds.sources.activate("a");
    const result = await ds.load();
    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect(collected.errors).toHaveLength(1);
    expect(collected.errors[0]?.pluginId).toBe("stargantt.data-sync");
    const data = host.host.service("stargantt.data");
    expect(data.query().byId.size).toBe(0); // never partially adopted

    const activity = collected.activity.filter((e) => e.area === "source" && e.op === "load");
    expect(activity.map((e) => e.pending)).toEqual([1, 0]); // finally-decrement still fired
    // Ordering: core/pluginError precedes the decremented sync/activity event.
    const errorIndex = collected.sequence.indexOf("core/pluginError");
    const lastActivityIndex = collected.sequence.lastIndexOf("sync/activity");
    expect(errorIndex).toBeGreaterThanOrEqual(0);
    expect(errorIndex).toBeLessThan(lastActivityIndex);
  });

  it("fired-and-forgotten exactly like autoLoad's internal `void load()`: no unhandled promise rejection", async () => {
    // autoLoad, followFilter's reload, and (for the lazy area below) viewport following/prefetch
    // all call this facade through `void load()` / `void ensureRange()` — nothing awaits the
    // returned promise, so an unguarded throw would surface as an unhandled rejection rather than
    // a wrong return value. Reproduces that exact fire-and-forget shape directly.
    const throwingAdapter = scriptedAdapter({ delta: false, push: false });
    throwingAdapter.nextFetch = {
      tasks: [{ id: "t1" }],
      mapping: {
        task: {
          name: () => {
            throw new Error("mapping accessor boom (fire-and-forget path)");
          },
        },
      },
    };
    const { unhandled } = await withUnhandledRejectionCapture(async () => {
      const { ds } = boot();
      ds.sources.register("a", throwingAdapter);
      ds.sources.activate("a");
      void ds.load(); // fire-and-forget, exactly as autoLoad's internal call does
      await new Promise((resolve) => setTimeout(resolve, 0));
      return undefined;
    });
    expect(unhandled).toEqual([]);
  });
});

describe("source area — sync()'s delta path resolves even when a changed row's getter throws", () => {
  it("a poisoned delta change.task: sync() resolves {ok:false, mode:'delta'} + one core/pluginError", async () => {
    const { ds, host, collected } = boot();
    const adapter = scriptedAdapter();
    adapter.nextFetch = { tasks: [task("t1", 0, 1)], syncToken: "tok-0" };
    ds.sources.register("a", adapter);
    ds.sources.activate("a");
    await ds.load();

    adapter.nextDelta = { syncToken: "tok-1", changes: [{ type: "upsert", task: poisonedRow() }] };
    const result = await ds.sync();
    expect(result).toMatchObject({ ok: false, mode: "delta" });
    expect(result.error).toBeInstanceOf(Error);
    expect(collected.errors).toHaveLength(1);
    const data = host.host.service("stargantt.data");
    expect(data.query().byId.size).toBe(1); // untouched by the poisoned entry

    const activity = collected.activity.filter((e) => e.area === "source" && e.op === "sync");
    expect(activity.map((e) => e.pending)).toEqual([1, 0]);
    const errorIndex = collected.sequence.indexOf("core/pluginError");
    const lastActivityIndex = collected.sequence.lastIndexOf("sync/activity");
    expect(errorIndex).toBeGreaterThanOrEqual(0);
    expect(errorIndex).toBeLessThan(lastActivityIndex);
  });

  it("does not advance the held sync token past the delta it could not fully apply", async () => {
    const { ds } = boot();
    const adapter = scriptedAdapter();
    adapter.nextFetch = { tasks: [task("t1", 0, 1)], syncToken: "tok-0" };
    ds.sources.register("a", adapter);
    ds.sources.activate("a");
    await ds.load();
    adapter.nextDelta = { syncToken: "tok-1", changes: [{ type: "upsert", task: poisonedRow() }] };
    await ds.sync();
    adapter.nextDelta = { syncToken: "tok-2", changes: [] };
    await ds.sync();
    expect(adapter.deltaCalls.at(-1)?.syncToken).toBe("tok-0"); // still the pre-failure token
  });
});

describe("lazy area — ensureRange() resolves even when a page row's getter throws", () => {
  it("a poisoned page row: ensureRange() resolves {ok:false} + one core/pluginError", async () => {
    const { ds, collected } = boot({ lazyLoad: { pageSize: 10 } });
    const adapter = scriptedLazyAdapter();
    adapter.replies.set(0, { tasks: [poisonedRow()] });
    ds.lazy.sources.register("a", adapter);
    ds.lazy.sources.activate("a");
    const result = await ds.lazy.ensureRange(0, 10);
    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect(collected.errors).toHaveLength(1);

    const activity = collected.activity.filter((e) => e.area === "lazy");
    expect(activity.map((e) => e.pending)).toEqual([1, 0]); // finally-decrement still fired
    const errorIndex = collected.sequence.indexOf("core/pluginError");
    const lastActivityIndex = collected.sequence.lastIndexOf("sync/activity");
    expect(errorIndex).toBeGreaterThanOrEqual(0);
    expect(errorIndex).toBeLessThan(lastActivityIndex);
  });

  it("a poisoned page's row-application throw does NOT leave the page marked loaded (review round 2): isRangeLoaded stays false, loadedPages() unchanged, and a clean retry loads it", async () => {
    const { ds } = boot({ lazyLoad: { pageSize: 10 } });
    const adapter = scriptedLazyAdapter();
    adapter.replies.set(0, { tasks: [poisonedRow()] });
    ds.lazy.sources.register("a", adapter);
    ds.lazy.sources.activate("a");

    const failed = await ds.lazy.ensureRange(0, 10);
    expect(failed.ok).toBe(false);
    // `applyPage` calls `pager.markLoaded()` BEFORE the row loop that throws — without un-marking
    // it in the catch, the page would incorrectly read as loaded even though no row was added.
    expect(ds.lazy.isRangeLoaded(0, 10)).toBe(false);
    expect(ds.lazy.loadedPages()).toBe(0);

    // Positive control: a clean retry (the adapter now returns a usable row) actually re-fetches
    // and loads the page — proving it was genuinely un-marked, not just reported inconsistently.
    adapter.replies.set(0, { tasks: [task("t1", 0, 1)] });
    const retried = await ds.lazy.ensureRange(0, 10);
    expect(retried).toEqual({ ok: true, pages: 1 });
    expect(adapter.calls.filter((c) => c.offset === 0)).toHaveLength(2); // genuinely re-fetched
    expect(ds.lazy.isRangeLoaded(0, 10)).toBe(true);
    expect(ds.lazy.loadedPages()).toBe(1);
  });

  it("fired-and-forgotten exactly like autoLoad/viewport-following's internal `void ensureRange()`: no unhandled promise rejection", async () => {
    const { unhandled } = await withUnhandledRejectionCapture(async () => {
      const adapter = scriptedLazyAdapter();
      adapter.replies.set(0, { tasks: [poisonedRow()] });
      const { ds } = boot({ lazyLoad: { pageSize: 10 } });
      ds.lazy.sources.register("a", adapter);
      ds.lazy.sources.activate("a");
      void ds.lazy.ensureRange(0, 10); // fire-and-forget, exactly as autoLoad's internal call does
      await new Promise((resolve) => setTimeout(resolve, 0));
      return undefined;
    });
    expect(unhandled).toEqual([]);
  });
});
