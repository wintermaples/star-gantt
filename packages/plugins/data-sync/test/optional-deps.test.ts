/**
 * `meta.optional` must name PROVIDING PLUGIN ids, not service ids: the core's declared-dependency
 * check (`ServiceRegistryImpl._declared`, `packages/core/src/internal/services.ts`) tests the
 * consumer's `meta.optional` set against `e.provider` — the plugin id `ctx.provide()` was called
 * under — not the service key string. `stargantt.filter` is a SERVICE id provided by the
 * `stargantt.interaction` PLUGIN; `stargantt.rows` is provided by the `stargantt.tree-grid`
 * plugin. `stargantt.view`'s plugin id and service id happen to coincide. A service-id entry here
 * would silently never resolve via `ctx.useOptional` — exactly the failure class this test guards
 * against.
 *
 * These tests deliberately do NOT use `boot()`'s `services` mock-injection option: `createTestHost`
 * forcibly hard-`dependsOn`s a synthetic provider for every plugin when `services` is used, which
 * bypasses the `meta.optional`/soft-dependency check path entirely and would mask exactly this
 * bug. Real (if minimal) provider plugins via `extraPlugins`, real `dependsOn`/`optional`
 * declarations, real core.
 */
import { definePlugin } from "@stargantt/core";
import type { AnyPlugin, PluginContext } from "@stargantt/core";
import { describe, expect, it, vi } from "vitest";
import { dataSync } from "../src/index";
import { boot, filterStub, rowsStub, viewStub } from "./_helpers";

describe("meta.optional names providing PLUGIN ids (not service ids)", () => {
  it("declares exactly the three provider plugin ids", () => {
    expect(dataSync().meta.optional).toEqual(["stargantt.interaction", "stargantt.view", "stargantt.tree-grid"]);
  });

  it("followFilter resolves stargantt.filter when the PROVIDER PLUGIN id is stargantt.interaction (positive control)", async () => {
    vi.useFakeTimers();
    try {
      const filter = filterStub();
      const provider: AnyPlugin = definePlugin({
        meta: { id: "stargantt.interaction" },
        setup(ctx: PluginContext): void {
          ctx.provide("stargantt.filter", filter.service);
        },
      });
      const { ds } = boot({ followFilter: true, followFilterDebounceMs: 10 }, { extraPlugins: [provider] });
      ds.sources.register("a", { fetch: () => Promise.resolve({ tasks: [] }) });
      ds.sources.activate("a");
      filter.set({ query: "resolved" });
      await vi.advanceTimersByTimeAsync(10);
      expect(ds.filter()).toEqual({ query: "resolved" }); // the optional lookup DID resolve
    } finally {
      vi.useRealTimers();
    }
  });

  it("a WRONG provider id (the service id itself) leaves followFilter permanently inert (negative control)", async () => {
    vi.useFakeTimers();
    try {
      const filter = filterStub();
      // Deliberately wrong: what a service-id-based `meta.optional` entry would have looked for.
      const wrongIdProvider: AnyPlugin = definePlugin({
        meta: { id: "stargantt.filter" },
        setup(ctx: PluginContext): void {
          ctx.provide("stargantt.filter", filter.service);
        },
      });
      const { ds } = boot({ followFilter: true, followFilterDebounceMs: 10 }, { extraPlugins: [wrongIdProvider] });
      ds.sources.register("a", { fetch: () => Promise.resolve({ tasks: [] }) });
      ds.sources.activate("a");
      filter.set({ query: "never-applied" });
      await vi.advanceTimersByTimeAsync(1000);
      expect(ds.filter()).toBeNull(); // useOptional("stargantt.filter") returned undefined, forever
    } finally {
      vi.useRealTimers();
    }
  });

  it("lazy viewport following resolves stargantt.view/stargantt.rows via the stargantt.view/stargantt.tree-grid providers", async () => {
    const view = viewStub({ scrollTop: 0, scrollLeft: 0, width: 720, height: 240 });
    const rows = rowsStub(1000);
    const viewProvider: AnyPlugin = definePlugin({
      meta: { id: "stargantt.view" },
      setup(ctx: PluginContext): void {
        ctx.provide("stargantt.view", view.service);
      },
    });
    const rowsProvider: AnyPlugin = definePlugin({
      meta: { id: "stargantt.tree-grid" },
      setup(ctx: PluginContext): void {
        ctx.provide("stargantt.rows", rows);
      },
    });
    const { ds, emit } = boot(
      { lazyLoad: { followViewport: true, pageSize: 50 } },
      { extraPlugins: [viewProvider, rowsProvider] },
    );
    const calls: unknown[] = [];
    const adapter = { fetchRange: (r: unknown) => (calls.push(r), Promise.resolve({ tasks: [] })) };
    ds.lazy.sources.register("a", adapter as never);
    ds.lazy.sources.activate("a");
    emit("view/scrolled", { scrollTop: 0, scrollLeft: 0 });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.length).toBeGreaterThan(0); // the optional lookups DID resolve
  });

  it("with a WRONG provider id for rows (the service id itself), viewport following is permanently inert (negative control)", async () => {
    const view = viewStub({ scrollTop: 0, scrollLeft: 0, width: 720, height: 240 });
    const rows = rowsStub(1000);
    const viewProvider: AnyPlugin = definePlugin({
      meta: { id: "stargantt.view" },
      setup(ctx: PluginContext): void {
        ctx.provide("stargantt.view", view.service);
      },
    });
    // Deliberately wrong: the SERVICE id as the plugin id (what a service-id-based `meta.optional`
    // entry would have looked for).
    const wrongRowsProvider: AnyPlugin = definePlugin({
      meta: { id: "stargantt.rows" }, // NOT "stargantt.tree-grid"
      setup(ctx: PluginContext): void {
        ctx.provide("stargantt.rows", rows);
      },
    });
    const { ds, emit } = boot(
      { lazyLoad: { followViewport: true, pageSize: 50 } },
      { extraPlugins: [viewProvider, wrongRowsProvider] },
    );
    const calls: unknown[] = [];
    const adapter = { fetchRange: (r: unknown) => (calls.push(r), Promise.resolve({ tasks: [] })) };
    ds.lazy.sources.register("a", adapter as never);
    ds.lazy.sources.activate("a");
    emit("view/scrolled", { scrollTop: 0, scrollLeft: 0 });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls.length).toBe(0); // silently inert — the wrong ids never resolve
  });
});
