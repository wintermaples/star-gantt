/**
 * CHARACTERIZATION ONLY — the contract is SILENT on every behavior asserted in this file.
 *
 * These tests exist so that a future change to any of these under-specified corners is a
 * deliberate decision rather than a silent regression. They are NOT normative: if the spec is
 * ever extended, the spec wins and these expectations should be rewritten, not defended.
 *
 * Open points, each flagged to the architect:
 *  1. duplicate plugin id at register()          — contract §1.9 `PluginHost.register` says nothing
 *  2. duplicate ctx.provide() of the same key    — contract §1.7/§1.9 say nothing
 *  3. duplicate registerCommand() of the same key— contract §1.5/§1.9 say nothing
 *  4. dispatch() of an unregistered command      — contract §1.7/§1.9 say nothing
 *  5. self-consumption of a plugin's own service — contract §1.5-4 speaks only of dependencies
 *  6. useOptional() for a present but undeclared service
 *  7. double dispose() of an `on()` Disposable, and repeated gantt.dispose()
 *  8. subscribe/unsubscribe during an in-flight emit
 *  9. how often the reducer runs behind ExtensionPoint.get() — only the *reference stability* of
 *     the reduced value is normative (pinned in extension-points.test.ts); the reduction
 *     count and the retry-after-fault behavior below are not
 *
 * Formerly listed here and now normative: extension-point redefinition (pinned in
 * extension-points.test.ts).
 */
import { describe, expect, it } from "vitest";
import { Gantt, collect } from "../src/index";
import type { Disposable } from "../src/index";
import { CommandBusImpl } from "../src/internal/commands";
import { EventBusImpl } from "../src/internal/events";
import { PluginHostImpl } from "../src/internal/host";
import { fakeRoot, plug } from "./_keys";

describe("[contract-silent] duplicate registration", () => {
  it("register() rejects a duplicate plugin id", () => {
    const host = new PluginHostImpl(fakeRoot());
    host.register(plug("test.dup", () => {}));
    expect(() => host.register(plug("test.dup", () => {}))).toThrowError(/test\.dup/);
  });

  it("the second provide() of a service key wins (last-writer-wins)", () => {
    const first = { name: "first", ping: (): string => "1" };
    const second = { name: "second", ping: (): string => "2" };
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.p1", (ctx) => ctx.provide("test.alpha", first)),
        plug("test.p2", (ctx) => ctx.provide("test.alpha", second)),
      ],
    });
    expect(g.service("test.alpha")).toBe(second);
    g.dispose();
  });

  it("the second registerCommand() of a command key wins (last-writer-wins)", () => {
    const seen: string[] = [];
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.p1", (ctx) => ctx.registerCommand("test/noop", () => void seen.push("p1"))),
        plug("test.p2", (ctx) => ctx.registerCommand("test/noop", () => void seen.push("p2"))),
      ],
    });
    g.dispatch("test/noop", undefined);
    expect(seen).toEqual(["p2"]);
    g.dispose();
  });
});

describe("[contract-silent] unknown keys", () => {
  it("dispatching an unregistered command is a silent no-op", () => {
    const bus = new EventBusImpl();
    const commands = new CommandBusImpl(bus);
    const faults: unknown[] = [];
    bus.on(null, "core/pluginError", (e) => void faults.push(e));
    expect(() => commands.dispatch("test/unregistered", undefined)).not.toThrow();
    expect(faults).toEqual([]);
  });

  it("gantt.dispatch of an unregistered command is a silent no-op", () => {
    const g = Gantt.create({ element: fakeRoot(), plugins: [] });
    expect(() => g.dispatch("test/unregistered", undefined)).not.toThrow();
    g.dispose();
  });
});

describe("[contract-silent] service visibility corners", () => {
  it("a plugin may use() the service it provided itself", () => {
    let got: unknown;
    const impl = { name: "self", ping: (): string => "self" };
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.self", (ctx) => {
          ctx.provide("test.alpha", impl);
          got = ctx.use("test.alpha");
        }),
      ],
    });
    expect(got).toBe(impl);
    g.dispose();
  });

  it("useOptional() returns undefined for a present-but-undeclared service", () => {
    let got: unknown = "untouched";
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.provider", (ctx) => ctx.provide("test.alpha", { name: "x", ping: () => "x" })),
        plug("test.stranger", (ctx) => void (got = ctx.useOptional("test.alpha"))),
      ],
    });
    expect(got).toBeUndefined();
    g.dispose();
  });
});

describe("[contract-silent] disposal corners", () => {
  it("disposing an `on()` Disposable twice is safe", () => {
    const bus = new EventBusImpl();
    let hits = 0;
    const d = bus.on(null, "test/plain", () => void hits++);
    d.dispose();
    expect(() => d.dispose()).not.toThrow();
    bus.emit("test/plain", { v: "x" });
    expect(hits).toBe(0);
  });

  it("gantt.dispose() is idempotent", () => {
    const log: string[] = [];
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [plug("test.a", () => () => void log.push("down"))],
    });
    g.dispose();
    g.dispose();
    expect(log).toEqual(["down"]);
  });
});

describe("[contract-silent] listener-set mutation during emit", () => {
  it("a listener added during an in-flight emit is not called for that emit", () => {
    const bus = new EventBusImpl();
    const hits: string[] = [];
    bus.on(null, "test/plain", () => {
      hits.push("outer");
      bus.on(null, "test/plain", () => void hits.push("added"));
    });
    bus.emit("test/plain", { v: "1" });
    expect(hits).toEqual(["outer"]);
    bus.emit("test/plain", { v: "2" });
    expect(hits).toEqual(["outer", "outer", "added"]);
  });

  it("a listener removed during an in-flight emit is not called for that emit", () => {
    const bus = new EventBusImpl();
    const hits: string[] = [];
    let later: Disposable | undefined;

    bus.on(null, "test/plain", () => {
      hits.push("first");
      later?.dispose();
    });
    later = bus.on(null, "test/plain", () => void hits.push("later"));

    bus.emit("test/plain", { v: "x" });
    expect(hits).toEqual(["first"]);
  });
});

describe("[contract-silent] ExtensionPoint.get() caching", () => {
  it("caches the reduced value until a new contribution arrives", () => {
    const host = new PluginHostImpl(fakeRoot());
    let reductions = 0;
    const point = host.points.define<string, string[]>("owner", "test/collect", (inputs) => {
      reductions++;
      return inputs.slice();
    });
    host.points.contribute("test/collect", "a");
    point.get();
    point.get();
    expect(reductions).toBe(1);
    host.points.contribute("test/collect", "b");
    point.get();
    expect(reductions).toBe(2);
  });

  it("does NOT cache a failed reduction — the reducer is retried on the next get()", () => {
    const host = new PluginHostImpl(fakeRoot());
    let attempts = 0;
    const point = host.points.define<string, string[]>("owner", "test/badReducer", () => {
      attempts++;
      throw new Error("boom");
    });
    expect(point.get()).toBeUndefined();
    expect(point.get()).toBeUndefined();
    expect(attempts).toBe(2);
  });

  it("recovers once the cause of the failure is gone", () => {
    const host = new PluginHostImpl(fakeRoot());
    const point = host.points.define<string, string[]>("owner", "test/badReducer", (inputs) => {
      if (inputs.length === 0) throw new Error("needs at least one contribution");
      return inputs.slice();
    });
    expect(point.get()).toBeUndefined();
    host.points.contribute("test/badReducer", "a");
    expect(point.get()).toEqual(["a"]);
  });

  it("reports a re-entrant get() from inside the reducer instead of recursing", () => {
    const host = new PluginHostImpl(fakeRoot());
    const faults: { pluginId: string; error: unknown }[] = [];
    host.bus.on(null, "core/pluginError", (e) => void faults.push(e));

    let inner: unknown = "untouched";
    let point: { get(): string[] } | undefined;
    point = host.points.define<string, string[]>("owner", "test/badReducer", (inputs) => {
      inner = point?.get();
      return inputs.slice();
    });

    expect(() => point?.get()).not.toThrow();
    expect(inner).toBeUndefined();
    expect(faults).toHaveLength(1);
    expect(faults[0]?.pluginId).toBe("owner");
    expect((faults[0]?.error as Error).message).toMatch(/re-entrant/);
  });
});
