/**
 * Contract §1.8 / §1.9 — dispose() fault barrier around setup-returned teardowns, and the
 * host lifecycle guards (no register()/start() once started or disposed).
 */
import { describe, expect, it } from "vitest";
import { PluginHostImpl } from "../src/internal/host";
import { fakeRoot, plug } from "./_keys";

describe("dispose() fault barrier around teardowns (§1.8, §1.9)", () => {
  it("keeps running remaining teardowns and the ledger sweep when a teardown throws", () => {
    const host = new PluginHostImpl(fakeRoot());
    const seq: string[] = [];
    host.register(
      plug("test.a", (ctx) => {
        ctx.own({ dispose: () => void seq.push("a-owned") });
        return () => void seq.push("a-teardown");
      }),
    );
    host.register(
      plug("test.b", (ctx) => {
        ctx.own({ dispose: () => void seq.push("b-owned") });
        return () => {
          seq.push("b-teardown");
          throw new Error("teardown boom");
        };
      }),
    );
    host.start();

    const faults: { pluginId: string; error: unknown }[] = [];
    host.bus.on(null, "core/pluginError", (e) => faults.push(e));

    expect(() => host.dispose()).not.toThrow();
    // Reverse startup order: b's teardown throws, a's teardown still runs, then the ledger
    // sweep (also reverse) still releases both plugins' owned resources.
    expect(seq).toEqual(["b-teardown", "a-teardown", "b-owned", "a-owned"]);
    expect(faults).toHaveLength(1);
    expect(faults[0]!.pluginId).toBe("test.b");
    expect((faults[0]!.error as Error).message).toBe("teardown boom");
  });
});

describe("dispose() releases plugin/teardown references", () => {
  it("clears _recs/_byId while stateOf() still answers 'disposed' for known ids", () => {
    const host = new PluginHostImpl(fakeRoot());
    host.register(plug("test.a", () => {}));
    host.start();

    host.dispose();

    expect(host.stateOf("test.a")).toBe("disposed");
    expect(host.stateOf("test.unknown")).toBeUndefined();
    // Structural: the internal plugin-object/teardown-closure holders are emptied so the
    // disposed instance retains no plugin graph or app closures.
    const internals = host as unknown as { _recs: unknown[]; _byId: Map<string, unknown> };
    expect(internals._recs).toHaveLength(0);
    expect(internals._byId.size).toBe(0);
  });
});

describe("host lifecycle guards", () => {
  it("throws on register() after start()", () => {
    const host = new PluginHostImpl(fakeRoot());
    host.start();
    expect(() => host.register(plug("test.late", () => {}))).toThrow(/after start\(\)$/);
  });

  it("throws on start() after start()", () => {
    const host = new PluginHostImpl(fakeRoot());
    host.start();
    expect(() => host.start()).toThrow(/after start\(\)$/);
  });

  it("throws on register() and start() after dispose()", () => {
    const host = new PluginHostImpl(fakeRoot());
    host.dispose();
    expect(() => host.register(plug("test.late", () => {}))).toThrow(/after dispose\(\)$/);
    expect(() => host.start()).toThrow(/after dispose\(\)$/);
  });
});
