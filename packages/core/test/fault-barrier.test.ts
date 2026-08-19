/**
 * Contract §1.9 — "the core wraps event-listener, extension-point and command-runner invocations
 * in try/catch, emits `core/pluginError` with the plugin ID, and continues. The *only* fatal case
 * is a throw inside `setup()`, which fails the whole `Gantt.create()`."
 *
 * This file pins the boundary: what the barrier covers, and what it must NOT swallow.
 */
import { describe, expect, it } from "vitest";
import { Gantt, collect } from "../src/index";
import { PluginHostImpl } from "../src/internal/host";
import { fakeRoot, plug } from "./_keys";

describe("setup() throws is fatal (§1.9)", () => {
  it("propagates the original error out of Gantt.create()", () => {
    const boom = new Error("setup exploded");
    expect(() =>
      Gantt.create({
        element: fakeRoot(),
        plugins: [
          plug("test.bad", () => {
            throw boom;
          }),
        ],
      }),
    ).toThrowError(boom);
  });

  it("is NOT converted into core/pluginError", () => {
    const host = new PluginHostImpl(fakeRoot());
    const faults: unknown[] = [];
    host.bus.on(null, "core/pluginError", (e) => void faults.push(e));
    host.register(
      plug("test.bad", () => {
        throw new Error("setup exploded");
      }),
    );
    expect(() => host.start()).toThrow();
    expect(faults).toEqual([]);
  });

  it("stops the remaining plugins from starting", () => {
    const started: string[] = [];
    expect(() =>
      Gantt.create({
        element: fakeRoot(),
        plugins: [
          plug("test.a", () => void started.push("a")),
          plug("test.bad", () => {
            throw new Error("setup exploded");
          }),
          plug("test.c", () => void started.push("c")),
        ],
      }),
    ).toThrow();
    expect(started).toEqual(["a"]);
  });

  it("releases the ctx.own() registrations of the plugins that already started (§1.1, §1.8)", () => {
    const log: string[] = [];
    expect(() =>
      Gantt.create({
        element: fakeRoot(),
        plugins: [
          plug("test.a", (ctx) => {
            ctx.own({ dispose: () => void log.push("own:a") });
          }),
          plug("test.b", (ctx) => {
            ctx.own({ dispose: () => void log.push("own:b") });
          }),
          plug("test.bad", () => {
            throw new Error("setup exploded");
          }),
        ],
      }),
    ).toThrow();
    expect(log.sort()).toEqual(["own:a", "own:b"]);
  });

  it("releases the partial registrations of the plugin that threw", () => {
    const log: string[] = [];
    expect(() =>
      Gantt.create({
        element: fakeRoot(),
        plugins: [
          plug("test.bad", (ctx) => {
            ctx.own({ dispose: () => void log.push("own:bad") });
            throw new Error("setup exploded");
          }),
        ],
      }),
    ).toThrow();
    expect(log).toEqual(["own:bad"]);
  });

  it("runs the already-started plugins' teardown functions in reverse startup order", () => {
    const log: string[] = [];
    expect(() =>
      Gantt.create({
        element: fakeRoot(),
        plugins: [
          plug("test.a", () => () => void log.push("down:a")),
          plug("test.b", () => () => void log.push("down:b")),
          plug("test.bad", () => {
            throw new Error("setup exploded");
          }),
        ],
      }),
    ).toThrow();
    expect(log).toEqual(["down:b", "down:a"]);
  });

  it("unsubscribes the ctx.on() listeners of the plugins that already started", () => {
    const host = new PluginHostImpl(fakeRoot());
    let hits = 0;
    host.register(plug("test.sub", (ctx) => void ctx.on("test/plain", () => void hits++)));
    host.register(
      plug("test.bad", () => {
        throw new Error("setup exploded");
      }),
    );
    expect(() => host.start()).toThrow();

    host.bus.emit("test/plain", { v: "x" });
    expect(hits).toBe(0);
  });

  it("leaves every plugin in the `disposed` state", () => {
    const host = new PluginHostImpl(fakeRoot());
    host.register(plug("test.a", () => {}));
    host.register(
      plug("test.bad", () => {
        throw new Error("setup exploded");
      }),
    );
    host.register(plug("test.c", () => {}));
    expect(() => host.start()).toThrow();

    expect(host.stateOf("test.a")).toBe("disposed");
    expect(host.stateOf("test.bad")).toBe("disposed");
    expect(host.stateOf("test.c")).toBe("disposed");
  });

  it("does not fire lifecycle/ready", () => {
    const host = new PluginHostImpl(fakeRoot());
    let ready = 0;
    host.bus.on(null, "lifecycle/ready", () => void ready++);
    host.register(plug("test.a", () => {}));
    host.register(
      plug("test.bad", () => {
        throw new Error("setup exploded");
      }),
    );
    expect(() => host.start()).toThrow();
    expect(ready).toBe(0);
  });
});

describe("core invariant violations are not swallowed", () => {
  it("an undeclared ctx.use() inside setup() fails create()", () => {
    expect(() =>
      Gantt.create({
        element: fakeRoot(),
        plugins: [
          plug("test.provider", (ctx) => ctx.provide("test.alpha", { name: "a", ping: () => "p" })),
          plug("test.sneaky", (ctx) => void ctx.use("test.alpha")),
        ],
      }),
    ).toThrowError(/dependsOn/);
  });

  it("a missing service inside setup() fails create()", () => {
    expect(() =>
      Gantt.create({
        element: fakeRoot(),
        plugins: [plug("test.consumer", (ctx) => void ctx.use("test.alpha"))],
      }),
    ).toThrowError(/test\.alpha/);
  });

  it("a dependency cycle fails create()", () => {
    expect(() =>
      Gantt.create({
        element: fakeRoot(),
        plugins: [
          plug("test.x", () => {}, { dependsOn: ["test.y"] }),
          plug("test.y", () => {}, { dependsOn: ["test.x"] }),
        ],
      }),
    ).toThrowError(/cycle/i);
  });

  it("an unresolved dependency fails create()", () => {
    expect(() =>
      Gantt.create({
        element: fakeRoot(),
        plugins: [plug("test.a", () => {}, { dependsOn: ["test.ghost"] })],
      }),
    ).toThrow();
  });

  it("a resolution failure never reports core/pluginError", () => {
    const host = new PluginHostImpl(fakeRoot());
    const faults: unknown[] = [];
    host.bus.on(null, "core/pluginError", (e) => void faults.push(e));
    host.register(plug("test.a", () => {}, { dependsOn: ["test.ghost"] }));
    expect(() => host.start()).toThrow();
    expect(faults).toEqual([]);
  });
});

describe("everything else keeps running (§1.9)", () => {
  it("a throwing lifecycle/ready listener does not fail create()", () => {
    const faults: { pluginId: string; error: unknown }[] = [];
    let g: ReturnType<typeof Gantt.create> | undefined;
    expect(() => {
      g = Gantt.create({
        element: fakeRoot(),
        plugins: [
          plug("test.reporter", (ctx) => void ctx.on("core/pluginError", (e) => void faults.push(e))),
          plug("test.bad", (ctx) =>
            void ctx.on("lifecycle/ready", () => {
              throw new Error("first paint failed");
            }),
          ),
        ],
      });
    }).not.toThrow();
    expect(faults).toHaveLength(1);
    expect(faults[0]?.pluginId).toBe("test.bad");
    g?.dispose();
  });

  it("covers all three call sites the core makes: listener, command runner, reducer", () => {
    const host = new PluginHostImpl(fakeRoot());
    const faults: { pluginId: string; error: unknown }[] = [];
    host.bus.on(null, "core/pluginError", (e) => void faults.push(e));

    host.bus.on("test.listener", "test/plain", () => {
      throw new Error("listener");
    });
    host.commands.register("test.runner", "test/boom", () => {
      throw new Error("runner");
    });
    const point = host.points.define<string, string[]>("test.reducer", "test/badReducer", () => {
      throw new Error("reducer");
    });

    host.bus.emit("test/plain", { v: "x" });
    host.commands.dispatch("test/boom", undefined);
    point.get();

    expect(faults.map((f) => f.pluginId)).toEqual(["test.listener", "test.runner", "test.reducer"]);
    expect(faults.map((f) => (f.error as Error).message)).toEqual([
      "listener",
      "runner",
      "reducer",
    ]);
  });

  it("does not wrap the plugin's own call of a function-shaped contribution (§1.9)", () => {
    // Contributions that are themselves functions are invoked by the point-OWNING plugin,
    // which is responsible for guarding them — the core does not.
    const host = new PluginHostImpl(fakeRoot());
    const faults: unknown[] = [];
    host.bus.on(null, "core/pluginError", (e) => void faults.push(e));

    const point = host.points.define<() => string, (() => string)[]>(
      "test.owner",
      "test/fnvalues",
      collect<() => string>(),
    );
    host.points.contribute("test/fnvalues", () => {
      throw new Error("contribution failed");
    });

    const inputs = point.get();
    expect(faults).toEqual([]);
    expect(() => inputs[0]?.()).toThrowError(/contribution failed/);
  });
});
