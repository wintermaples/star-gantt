/**
 * `sdk/testing` (docs/specs/sdk.md, Module: sdk/testing): the plugin test harness's own
 * self-tests. `createTestHost` boots a real `@stargantt/core`, so these tests exercise the real
 * kernel end to end; `expectDepsConsistency` runs against its own mock environment.
 */
import { collect, definePlugin, first, reduce } from "@stargantt/core";
import type { AnyPlugin, ExtensionPointDecl, PluginContext } from "@stargantt/core";
import { describe, expect, it } from "vitest";
import { createTestHost, expectDepsConsistency, mockStore } from "../src/index";

declare module "@stargantt/core" {
  interface Services {
    "test.alpha": { name: string };
    "test.beta": { value: number };
    "test.data": { rows: unknown[] };
    "test.fields": { defs: unknown[] };
  }

  interface ExtensionPoints {
    "test/collect": ExtensionPointDecl<string, string[]>;
    "test/first": ExtensionPointDecl<
      (n: number) => string | undefined,
      (n: number) => string | undefined
    >;
    "test/reduce": ExtensionPointDecl<number, number>;
  }
}

describe("createTestHost", () => {
  it("boots headless when `element` is omitted, and disposes cleanly", () => {
    let ran = false;
    const plugin = definePlugin({
      meta: { id: "test.headless" },
      setup(ctx) {
        expect(ctx.root).toBeDefined();
        ran = true;
      },
    });
    const t = createTestHost({ plugins: [plugin] });
    expect(ran).toBe(true);
    expect(() => t.dispose()).not.toThrow();
    // Idempotent, like GanttInstance.dispose().
    expect(() => t.dispose()).not.toThrow();
  });

  it("uses the supplied element verbatim when one is given", () => {
    const element = { tagName: "DIV" } as unknown as HTMLElement;
    const plugin = definePlugin({ meta: { id: "test.rooted" }, setup() {} });
    const t = createTestHost({ plugins: [plugin], element });
    expect(t.ctxOf("test.rooted").root).toBe(element);
    t.dispose();
  });

  it("ctxOf returns the real PluginContext handed to a plugin's setup()", () => {
    let captured: PluginContext | undefined;
    const plugin = definePlugin({
      meta: { id: "test.ctx" },
      setup(ctx) {
        captured = ctx;
      },
    });
    const t = createTestHost({ plugins: [plugin] });
    expect(t.ctxOf("test.ctx")).toBe(captured);
    expect(t.ctxOf("test.ctx").locale).toBe("en");
    t.dispose();
  });

  it("ctxOf throws for a plugin id that was never registered", () => {
    const t = createTestHost({ plugins: [] });
    expect(() => t.ctxOf("nope")).toThrow(/nope/);
    t.dispose();
  });

  it("host is the real GanttInstance: dispatch/on/service/orders/dispose all work", () => {
    const plugin = definePlugin({
      meta: { id: "test.instance" },
      setup(ctx) {
        ctx.provide("test.alpha", { name: "a" });
      },
    });
    const t = createTestHost({ plugins: [plugin] });
    expect(t.host.service("test.alpha")).toEqual({ name: "a" });
    expect(t.host.getService("test.beta")).toBeUndefined();
    t.dispose();
  });

  it("services mock injection: a plugin sees a mocked service though it declares no dependsOn", () => {
    let seen: unknown;
    const plugin = definePlugin({
      meta: { id: "test.mockconsumer" },
      setup(ctx) {
        seen = ctx.use("test.alpha");
      },
    });
    const mockImpl = { name: "mocked" };
    const t = createTestHost({ plugins: [plugin], services: { "test.alpha": mockImpl } });
    expect(seen).toBe(mockImpl);
    t.dispose();
  });

  it("without a matching mock, a plugin using an undeclared service still throws (real core enforcement)", () => {
    const plugin = definePlugin({
      meta: { id: "test.sneaky" },
      setup(ctx) {
        ctx.use("test.alpha");
      },
    });
    expect(() => createTestHost({ plugins: [plugin] })).toThrow();
  });

  it("useOptional() also resolves a mocked service", () => {
    let seen: unknown;
    const plugin = definePlugin({
      meta: { id: "test.optionalmock" },
      setup(ctx) {
        seen = ctx.useOptional("test.alpha");
      },
    });
    const mockImpl = { name: "opt" };
    const t = createTestHost({ plugins: [plugin], services: { "test.alpha": mockImpl } });
    expect(seen).toBe(mockImpl);
    t.dispose();
  });

  it("a real provider registered alongside a mock for the same key wins (last write)", () => {
    // The consumer genuinely depends on the real provider (as production code would); the mock
    // injection is transparent on top of that, per the createTestHost doc comment's ordering
    // rule: mocks resolve first, so a real registered provider's later `ctx.provide()` overwrites.
    let seen: unknown;
    const provider = definePlugin({
      meta: { id: "test.real-provider" },
      setup(ctx) {
        ctx.provide("test.alpha", { name: "real" });
      },
    });
    const consumer = definePlugin({
      meta: { id: "test.override-consumer", dependsOn: ["test.real-provider"] },
      setup(ctx) {
        seen = ctx.use("test.alpha");
      },
    });
    const t = createTestHost({
      plugins: [provider, consumer],
      services: { "test.alpha": { name: "mock" } },
    });
    expect(seen).toEqual({ name: "real" });
    t.dispose();
  });

  it("mock injection does not perturb genuine plugin-to-plugin setup order", () => {
    const runOrder = (withMocks: boolean): string[] => {
      const order: string[] = [];
      const b = definePlugin({
        meta: { id: "test.order-b" },
        setup() {
          order.push("b");
        },
      });
      const a = definePlugin({
        meta: { id: "test.order-a", dependsOn: ["test.order-b"] },
        setup() {
          order.push("a");
        },
      });
      const t = withMocks
        ? createTestHost({ plugins: [a, b], services: { "test.unused": {} } })
        : createTestHost({ plugins: [a, b] });
      t.dispose();
      return order;
    };
    expect(runOrder(true)).toEqual(runOrder(false));
    expect(runOrder(false)).toEqual(["b", "a"]);
  });

  it("passes a plugin's own setup() teardown through to dispose()", () => {
    let torn = false;
    const plugin = definePlugin({
      meta: { id: "test.teardown" },
      setup() {
        return () => {
          torn = true;
        };
      },
    });
    const t = createTestHost({ plugins: [plugin] });
    expect(torn).toBe(false);
    t.dispose();
    expect(torn).toBe(true);
  });
});

describe("mockStore", () => {
  it("is a real store: synchronous notification, get/set/update", () => {
    const store = mockStore({ n: 0 });
    const seen: Array<[{ n: number }, { n: number }]> = [];
    const d = store.subscribe((next, prev) => seen.push([next, prev]));
    store.set({ n: 1 });
    expect(store.get()).toEqual({ n: 1 });
    expect(seen).toEqual([[{ n: 1 }, { n: 0 }]]);
    store.update((prev) => ({ n: prev.n + 1 }));
    expect(store.get()).toEqual({ n: 2 });
    d.dispose();
    store.set({ n: 3 });
    expect(seen.length).toBe(2);
  });

  it("re-entrant set() throws, matching the real store contract", () => {
    const store = mockStore({ n: 0 });
    let reentrantThrew = false;
    store.subscribe(() => {
      try {
        store.set({ n: 99 });
      } catch {
        reentrantThrew = true;
      }
    });
    store.set({ n: 1 });
    expect(reentrantThrew).toBe(true);
    // The in-flight dispatch's own commit is unaffected by the rejected re-entrant call.
    expect(store.get()).toEqual({ n: 1 });
  });
});

describe("expectDepsConsistency", () => {
  it("passes when declared dependsOn exactly matches the ctx.use() keys", () => {
    const plugin: AnyPlugin = definePlugin({
      meta: { id: "test.consistent", dependsOn: ["test.alpha", "test.beta"] },
      setup(ctx) {
        ctx.use("test.alpha");
        ctx.use("test.beta");
      },
    });
    expect(() => expectDepsConsistency(plugin)).not.toThrow();
  });

  it("detects a declaration gap: used but not declared", () => {
    const plugin: AnyPlugin = definePlugin({
      meta: { id: "test.gap" },
      setup(ctx) {
        ctx.use("test.alpha");
      },
    });
    expect(() => expectDepsConsistency(plugin)).toThrowError(
      /used but not declared: test\.alpha/,
    );
  });

  it("detects over-declaration: declared but not used", () => {
    const plugin: AnyPlugin = definePlugin({
      meta: { id: "test.over", dependsOn: ["test.alpha", "test.beta"] },
      setup(ctx) {
        ctx.use("test.alpha");
      },
    });
    expect(() => expectDepsConsistency(plugin)).toThrowError(
      /declared but not used: test\.beta/,
    );
  });

  it("does not count useOptional() calls toward the used set", () => {
    const plugin: AnyPlugin = definePlugin({
      meta: { id: "test.optional" },
      setup(ctx) {
        ctx.useOptional("test.alpha");
      },
    });
    expect(() => expectDepsConsistency(plugin)).not.toThrow();
  });

  it("tolerates setup() chaining off the stubbed service without crashing", () => {
    const plugin: AnyPlugin = definePlugin({
      meta: { id: "test.chained", dependsOn: ["test.alpha"] },
      setup(ctx) {
        (
          ctx.use("test.alpha") as unknown as { state: { subscribe: (fn: () => void) => void } }
        ).state.subscribe(() => {});
      },
    });
    expect(() => expectDepsConsistency(plugin)).not.toThrow();
  });

  it("regression: the stubbed use() value survives template-literal and arithmetic coercion", () => {
    // Before the Symbol.toPrimitive trap, both of these threw
    // "Cannot convert object to primitive value" instead of letting setup() finish.
    const plugin: AnyPlugin = definePlugin({
      meta: { id: "test.coerce", dependsOn: ["test.alpha"] },
      setup(ctx) {
        const svc = ctx.use("test.alpha");
        const asString = `stub: ${svc}`;
        const asNumber = Number(svc) + 1;
        void asString;
        void asNumber;
      },
    });
    expect(() => expectDepsConsistency(plugin)).not.toThrow();
  });

  describe("serviceProviders mapping", () => {
    const map = { "test.data": "test.data-store", "test.fields": "test.data-store" };

    it("passes when the mapped provider set matches dependsOn", () => {
      const plugin: AnyPlugin = definePlugin({
        meta: { id: "test.mapped-ok", dependsOn: ["test.data-store"] },
        setup(ctx) {
          ctx.use("test.data");
        },
      });
      expect(() => expectDepsConsistency(plugin, map)).not.toThrow();
    });

    it("reports both directions using provider plugin ids, not raw service ids", () => {
      const plugin: AnyPlugin = definePlugin({
        meta: { id: "test.mapped-mismatch", dependsOn: ["test.other-provider"] },
        setup(ctx) {
          ctx.use("test.data");
        },
      });
      let error: unknown;
      try {
        expectDepsConsistency(plugin, map);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(Error);
      const lines = (error as Error).message.split("\n");
      // Both directions are reported in terms of provider plugin ids, not the raw service id.
      expect(lines).toContain("  used but not declared: test.data-store");
      expect(lines).toContain("  declared but not used: test.other-provider");
    });

    it("dedupes two services from the same provider to one dependsOn entry", () => {
      const plugin: AnyPlugin = definePlugin({
        meta: { id: "test.mapped-dedupe", dependsOn: ["test.data-store"] },
        setup(ctx) {
          ctx.use("test.data");
          ctx.use("test.fields");
        },
      });
      expect(() => expectDepsConsistency(plugin, map)).not.toThrow();
    });
  });

  describe("self-defined extension points", () => {
    // A plugin that both defines an extension point and contributes to it during its own setup()
    // (e.g. view seeding a store from its own zoomLevels point) needs `.get()` to reflect those
    // contributions, not always answer empty, or its own setup() invariants fail before the deps
    // diff ever runs.

    it("collect: .get() returns exactly what was contributed, in order", () => {
      const plugin: AnyPlugin = definePlugin({
        meta: { id: "test.selfcollect" },
        setup(ctx) {
          const point = ctx.defineExtensionPoint("test/collect", collect<string>());
          ctx.contribute("test/collect", "a");
          ctx.contribute("test/collect", "b");
          const values = point.get();
          if (values.length !== 2 || values[0] !== "a" || values[1] !== "b") {
            throw new Error(`expected ["a", "b"], got ${JSON.stringify(values)}`);
          }
        },
      });
      expect(() => expectDepsConsistency(plugin)).not.toThrow();
    });

    it("first: .get() composites over what was contributed", () => {
      const plugin: AnyPlugin = definePlugin({
        meta: { id: "test.selffirst" },
        setup(ctx) {
          const point = ctx.defineExtensionPoint(
            "test/first",
            first<[number], string | undefined>(),
          );
          ctx.contribute("test/first", (n: number) => (n > 0 ? `pos:${n}` : undefined));
          const fn = point.get();
          const result = fn(5);
          if (result !== "pos:5") throw new Error(`unexpected result: ${result}`);
        },
      });
      expect(() => expectDepsConsistency(plugin)).not.toThrow();
    });

    it("reduce: .get() folds what was contributed over the seed", () => {
      const plugin: AnyPlugin = definePlugin({
        meta: { id: "test.selfreduce" },
        setup(ctx) {
          const point = ctx.defineExtensionPoint(
            "test/reduce",
            reduce<number, number>((acc, n) => acc + n, 0),
          );
          ctx.contribute("test/reduce", 2);
          ctx.contribute("test/reduce", 3);
          const total = point.get();
          if (total !== 5) throw new Error(`unexpected total: ${total}`);
        },
      });
      expect(() => expectDepsConsistency(plugin)).not.toThrow();
    });

    it("a contribution to a point never defined in-mock stays recorded but inert", () => {
      // No defineExtensionPoint call for "test/collect" in this plugin's own setup() — contribute()
      // still must not throw, and there is nothing to read back.
      const plugin: AnyPlugin = definePlugin({
        meta: { id: "test.contributeonly" },
        setup(ctx) {
          ctx.contribute("test/collect", "orphaned");
        },
      });
      expect(() => expectDepsConsistency(plugin)).not.toThrow();
    });
  });
});
