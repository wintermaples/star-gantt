/**
 * Contract §1.8 / §4.2 — the published symbol set and the `Gantt` / `GanttInstance` entry points.
 */
import { describe, expect, it } from "vitest";
import * as core from "../src/index";
import { Gantt, definePlugin } from "../src/index";
import { fakeRoot, plug } from "./_keys";

describe("published surface (§1.8)", () => {
  it("exports exactly Gantt, definePlugin, collect, first, reduce, createStore as runtime values", () => {
    // The published runtime symbol set is exactly these; everything else the package publishes is
    // types. `createStore` is the store-shaped service foundation
    // (docs/specs/architecture.md §1.1).
    expect(Object.keys(core).sort()).toEqual([
      "Gantt",
      "collect",
      "createStore",
      "definePlugin",
      "first",
      "reduce",
    ]);
  });

  it("exposes no back-door kernel API from the entry module (§1.9)", () => {
    const names = Object.keys(core);
    for (const internal of [
      "PluginHost",
      "PluginHostImpl",
      "ServiceRegistry",
      "EventBus",
      "CommandBus",
      "ExtensionPointRegistry",
      "DisposableLedger",
    ]) {
      expect(names).not.toContain(internal);
    }
  });
});

describe("definePlugin (§1.6, §4.2)", () => {
  it("is an identity function with no runtime behavior", () => {
    const def = { meta: { id: "test.identity" }, setup(): void {} };
    expect(definePlugin(def)).toBe(def);
  });

  it("does not call setup() by itself", () => {
    let called = false;
    definePlugin({
      meta: { id: "test.lazy" },
      setup(): void {
        called = true;
      },
    });
    expect(called).toBe(false);
  });
});

describe("Gantt.create (§1.8)", () => {
  it("returns an instance exposing dispatch / on / service / getService / dispose", () => {
    const g = Gantt.create({ element: fakeRoot(), plugins: [] });
    expect(typeof g.dispatch).toBe("function");
    expect(typeof g.on).toBe("function");
    expect(typeof g.service).toBe("function");
    expect(typeof g.getService).toBe("function");
    expect(typeof g.dispose).toBe("function");
    g.dispose();
  });

  it("accepts an empty plugin list", () => {
    expect(() => Gantt.create({ element: fakeRoot(), plugins: [] }).dispose()).not.toThrow();
  });

  it("passes `element` through as `ctx.root` (§1.7)", () => {
    const el = fakeRoot();
    let seen: HTMLElement | undefined;
    const g = Gantt.create({
      element: el,
      plugins: [plug("test.root", (ctx) => void (seen = ctx.root))],
    });
    expect(seen).toBe(el);
    g.dispose();
  });

  it("runs setup() synchronously during create()", () => {
    const seq: string[] = [];
    seq.push("before");
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [plug("test.sync", () => void seq.push("setup"))],
    });
    seq.push("after");
    expect(seq).toEqual(["before", "setup", "after"]);
    g.dispose();
  });

  it("passes `undefined` as the plugin config — the Config channel is dormant with no config supplied", () => {
    let received: unknown = "untouched";
    const p = definePlugin<void>({
      meta: { id: "test.config" },
      setup(_ctx, config): void {
        received = config;
      },
    });
    const g = Gantt.create({ element: fakeRoot(), plugins: [p] });
    expect(received).toBeUndefined();
    g.dispose();
  });
});
