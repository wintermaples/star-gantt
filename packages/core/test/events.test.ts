/**
 * Contract §1.3 (EventBus conventions) and §1.9 (`EventBus`, fault barrier).
 *
 * Synchronous publish/subscribe; `on()` always returns a `Disposable`;
 * re-emit during emit is allowed but the emit that would reach depth 32 throws; a throwing listener is isolated
 * and reported through `core/pluginError`.
 */
import { describe, expect, it } from "vitest";
import { Gantt } from "../src/index";
import type { Disposable } from "../src/index";
import { EventBusImpl } from "../src/internal/events";
import { fakeRoot, plug } from "./_keys";

describe("emit / on (§1.3)", () => {
  it("delivers synchronously with the exact payload", () => {
    const bus = new EventBusImpl();
    const seen: { v: string }[] = [];
    bus.on(null, "test/plain", (e) => void seen.push(e));
    const payload = { v: "hello" };
    bus.emit("test/plain", payload);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(payload);
  });

  it("delivers to every subscriber of the key", () => {
    const bus = new EventBusImpl();
    const hits: string[] = [];
    bus.on(null, "test/plain", () => void hits.push("a"));
    bus.on(null, "test/plain", () => void hits.push("b"));
    bus.emit("test/plain", { v: "x" });
    expect(hits.sort()).toEqual(["a", "b"]);
  });

  it("does not deliver to subscribers of a different key", () => {
    const bus = new EventBusImpl();
    let hit = 0;
    bus.on(null, "test/ping", () => void hit++);
    bus.emit("test/plain", { v: "x" });
    expect(hit).toBe(0);
  });

  it("emitting a key with no subscribers is a no-op", () => {
    const bus = new EventBusImpl();
    expect(() => bus.emit("test/plain", { v: "x" })).not.toThrow();
  });

  it("supports `void` payloads", () => {
    const bus = new EventBusImpl();
    let hit = 0;
    bus.on(null, "test/loop", () => void hit++);
    bus.emit("test/loop", undefined);
    expect(hit).toBe(1);
  });
});

describe("on() returns a Disposable (§1.3)", () => {
  it("stops delivery once disposed", () => {
    const bus = new EventBusImpl();
    let hits = 0;
    const d: Disposable = bus.on(null, "test/plain", () => void hits++);
    bus.emit("test/plain", { v: "1" });
    d.dispose();
    bus.emit("test/plain", { v: "2" });
    expect(hits).toBe(1);
  });

  it("disposing one subscription leaves the others intact", () => {
    const bus = new EventBusImpl();
    const hits: string[] = [];
    const a = bus.on(null, "test/plain", () => void hits.push("a"));
    bus.on(null, "test/plain", () => void hits.push("b"));
    a.dispose();
    bus.emit("test/plain", { v: "x" });
    expect(hits).toEqual(["b"]);
  });

  it("is also returned from gantt.on() (§1.8)", () => {
    const seen: { v: string }[] = [];
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.emitter", (ctx) => {
          ctx.registerCommand("test/noop", () => ctx.emit("test/plain", { v: "from-plugin" }));
        }),
      ],
    });

    const d: Disposable = g.on("test/plain", (e) => void seen.push(e));
    g.dispatch("test/noop", undefined);
    expect(seen).toEqual([{ v: "from-plugin" }]);

    d.dispose();
    g.dispatch("test/noop", undefined);
    expect(seen).toHaveLength(1);
    g.dispose();
  });

  it("is also returned from ctx.on() (§1.7)", () => {
    let d: Disposable | undefined;
    let hits = 0;
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.sub", (ctx) => {
          d = ctx.on("test/plain", () => void hits++);
        }),
      ],
    });
    expect(typeof d?.dispose).toBe("function");
    g.dispose();
    expect(hits).toBe(0);
  });
});

describe("recursion / loop detection (§1.3: loop-detection exception AT depth 32)", () => {
  it("allows re-emitting from within a listener", () => {
    const bus = new EventBusImpl();
    const seq: string[] = [];
    bus.on(null, "test/ping", (e) => {
      seq.push(`ping:${e.n}`);
      if (e.n < 3) bus.emit("test/ping", { n: e.n + 1 });
    });
    bus.emit("test/ping", { n: 1 });
    expect(seq).toEqual(["ping:1", "ping:2", "ping:3"]);
  });

  it("throws from the emit that would reach depth 32, so nesting never exceeds 31", () => {
    const bus = new EventBusImpl();
    let depth = 0;
    let maxDepth = 0;
    let captured: unknown;

    bus.on("test.looper", "test/loop", () => {
      depth++;
      maxDepth = Math.max(maxDepth, depth);
      try {
        bus.emit("test/loop", undefined);
      } catch (e) {
        captured = e;
      }
      depth--;
    });

    bus.emit("test/loop", undefined);

    // The 32nd nested emit is the one that throws, so 31 listener frames are ever in flight.
    expect(maxDepth).toBe(31);
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toContain("32");
    expect((captured as Error).message).toContain("test/loop");
  });

  it("resets the depth counter after a bounded emit completes", () => {
    const bus = new EventBusImpl();
    let runs = 0;
    bus.on("test.looper", "test/loop", () => {
      runs++;
      try {
        bus.emit("test/loop", undefined);
      } catch {
        /* bounded */
      }
    });
    bus.emit("test/loop", undefined);
    const first = runs;
    bus.emit("test/loop", undefined);
    expect(runs).toBe(first * 2);
    expect(first).toBe(31);
  });

  it("terminates a runaway loop instead of overflowing the stack, reporting it as a plugin fault", () => {
    // The recursion guard throws from inside a *listener* invocation, which §1.9 wraps:
    // "the only fatal case is a throw inside setup()". So the loop is stopped and surfaced
    // through `core/pluginError` rather than propagating to the original emitter.
    const bus = new EventBusImpl();
    const faults: { pluginId: string; error: unknown }[] = [];
    bus.on(null, "core/pluginError", (e) => void faults.push(e));
    bus.on("test.looper", "test/loop", () => bus.emit("test/loop", undefined));

    expect(() => bus.emit("test/loop", undefined)).not.toThrow();
    expect(faults).toHaveLength(1);
    expect(faults[0]?.pluginId).toBe("test.looper");
    expect((faults[0]?.error as Error).message).toContain("32");
  });
});

describe("fault barrier around listeners (§1.9)", () => {
  it("keeps running the remaining listeners after one throws", () => {
    const bus = new EventBusImpl();
    const hits: string[] = [];
    bus.on("test.good1", "test/plain", () => void hits.push("g1"));
    bus.on("test.bad", "test/plain", () => {
      throw new Error("listener exploded");
    });
    bus.on("test.good2", "test/plain", () => void hits.push("g2"));

    expect(() => bus.emit("test/plain", { v: "x" })).not.toThrow();
    expect(hits).toEqual(["g1", "g2"]);
  });

  it("emits core/pluginError carrying the offending plugin id and the original error", () => {
    const bus = new EventBusImpl();
    const faults: { pluginId: string; error: unknown }[] = [];
    const boom = new Error("boom");
    bus.on(null, "core/pluginError", (e) => void faults.push(e));
    bus.on("test.bad", "test/plain", () => {
      throw boom;
    });

    bus.emit("test/plain", { v: "x" });

    expect(faults).toEqual([{ pluginId: "test.bad", error: boom }]);
  });

  it("isolates a throwing plugin listener end-to-end through the public API", () => {
    const hits: string[] = [];
    const faults: { pluginId: string; error: unknown }[] = [];
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.bad", (ctx) =>
          void ctx.on("test/plain", () => {
            throw new Error("plugin listener failed");
          }),
        ),
        plug("test.good", (ctx) => void ctx.on("test/plain", () => void hits.push("good"))),
        plug("test.reporter", (ctx) => void ctx.on("core/pluginError", (e) => void faults.push(e))),
        plug("test.emitter", (ctx) =>
          void ctx.on("lifecycle/ready", () => ctx.emit("test/plain", { v: "go" })),
        ),
      ],
    });

    expect(hits).toEqual(["good"]);
    expect(faults).toHaveLength(1);
    expect(faults[0]?.pluginId).toBe("test.bad");
    g.dispose();
  });

  it("a throwing core/pluginError listener does not loop", () => {
    const bus = new EventBusImpl();
    let reports = 0;
    bus.on("test.reporter", "core/pluginError", () => {
      reports++;
      throw new Error("reporter also failed");
    });
    bus.on("test.bad", "test/plain", () => {
      throw new Error("boom");
    });

    expect(() => bus.emit("test/plain", { v: "x" })).not.toThrow();
    expect(reports).toBe(1);
  });
});
