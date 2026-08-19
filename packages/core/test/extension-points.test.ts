/**
 * Contract §1.4 (extension points, merge strategies, contribute-before-define buffering),
 * §1.7 (`defineExtensionPoint` / `contribute`), §1.9 (`ExtensionPointRegistry`, reducer fault
 * barrier, "the core never auto-invokes contributions").
 */
import { describe, expect, it } from "vitest";
import { Gantt, collect, first, reduce } from "../src/index";
import type { ExtensionPoint } from "../src/index";
import { PluginHostImpl } from "../src/internal/host";
import type { NumToString } from "./_keys";
import { fakeRoot, plug } from "./_keys";

describe("define + contribute + get (§1.4, §1.7)", () => {
  it("reduces the contributions through the owner's reduce function", () => {
    let point: ExtensionPoint<string, string[]> | undefined;
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.owner", (ctx) => {
          point = ctx.defineExtensionPoint("test/collect", collect<string>());
        }),
        plug("test.contrib", (ctx) => ctx.contribute("test/collect", "one"), {
          dependsOn: ["test.owner"],
        }),
      ],
    });
    expect(point?.get()).toEqual(["one"]);
    g.dispose();
  });

  it("exposes the point's key", () => {
    let point: ExtensionPoint<string, string[]> | undefined;
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.owner", (ctx) => {
          point = ctx.defineExtensionPoint("test/collect", collect<string>());
        }),
      ],
    });
    expect(point?.key).toBe("test/collect");
    g.dispose();
  });

  it("returns the reduced value of an empty point", () => {
    let point: ExtensionPoint<string, string[]> | undefined;
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.owner", (ctx) => {
          point = ctx.defineExtensionPoint("test/collect", collect<string>());
        }),
      ],
    });
    expect(point?.get()).toEqual([]);
    g.dispose();
  });

  it("orders contributions by startup order, not registration order", () => {
    let point: ExtensionPoint<string, string[]> | undefined;
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [
        // `late` is registered first but ordered last by the dependency edge + order hint.
        plug("test.late", (ctx) => ctx.contribute("test/collect", "late"), {
          dependsOn: ["test.early"],
        }),
        plug("test.early", (ctx) => ctx.contribute("test/collect", "early"), {
          order: "pre",
        }),
        plug("test.owner", (ctx) => {
          point = ctx.defineExtensionPoint("test/collect", collect<string>());
        }),
      ],
    });
    expect(point?.get()).toEqual(["early", "late"]);
    g.dispose();
  });

  it("reflects contributions made after get() was already called", () => {
    const host = new PluginHostImpl(fakeRoot());
    const p = host.points.define<string, string[]>("owner", "test/collect", collect<string>());
    host.points.contribute("test/collect", "a");
    expect(p.get()).toEqual(["a"]);
    host.points.contribute("test/collect", "b");
    expect(p.get()).toEqual(["a", "b"]);
  });
});

describe("contribute-before-define buffering (§1.4)", () => {
  it("buffers a contribution made before the point is defined and delivers it at define time", () => {
    let point: ExtensionPoint<string, string[]> | undefined;
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [
        // contributor starts FIRST and there is no dependency edge to the definer
        plug("test.contrib", (ctx) => ctx.contribute("test/buffered", "early-bird")),
        plug("test.owner", (ctx) => {
          point = ctx.defineExtensionPoint("test/buffered", collect<string>());
        }),
      ],
    });
    expect(point?.get()).toEqual(["early-bird"]);
    g.dispose();
  });

  it("delivers several buffered contributions in registration order", () => {
    const host = new PluginHostImpl(fakeRoot());
    host.points.contribute("test/buffered", "1");
    host.points.contribute("test/buffered", "2");
    host.points.contribute("test/buffered", "3");
    const p = host.points.define<string, string[]>("owner", "test/buffered", collect<string>());
    expect(p.get()).toEqual(["1", "2", "3"]);
  });

  it("keeps buffered contributions ahead of later ones", () => {
    const host = new PluginHostImpl(fakeRoot());
    host.points.contribute("test/buffered", "buffered");
    const p = host.points.define<string, string[]>("owner", "test/buffered", collect<string>());
    host.points.contribute("test/buffered", "after");
    expect(p.get()).toEqual(["buffered", "after"]);
  });

  it("leaves a never-defined key inert rather than raising an error", () => {
    expect(() =>
      Gantt.create({
        element: fakeRoot(),
        plugins: [plug("test.contrib", (ctx) => ctx.contribute("test/buffered", "orphan"))],
      }).dispose(),
    ).not.toThrow();
  });

  it("keeps buffers per key", () => {
    const host = new PluginHostImpl(fakeRoot());
    host.points.contribute("test/buffered", "b");
    host.points.contribute("test/collect", "c");
    const buffered = host.points.define<string, string[]>(
      "owner",
      "test/buffered",
      collect<string>(),
    );
    const collected = host.points.define<string, string[]>(
      "owner",
      "test/collect",
      collect<string>(),
    );
    expect(buffered.get()).toEqual(["b"]);
    expect(collected.get()).toEqual(["c"]);
  });
});

describe("the core never auto-invokes contributions", () => {
  it("passes a function-shaped contribution to the reducer verbatim", () => {
    let point: ExtensionPoint<NumToString, NumToString[]> | undefined;
    let invoked = 0;
    const tester: NumToString = (x) => {
      invoked++;
      return x > 0 ? "hit" : undefined;
    };
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.owner", (ctx) => {
          point = ctx.defineExtensionPoint("test/fnvalues", collect<NumToString>());
        }),
        plug("test.contrib", (ctx) => ctx.contribute("test/fnvalues", tester), {
          dependsOn: ["test.owner"],
        }),
      ],
    });
    const inputs = point?.get() ?? [];
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toBe(tester);
    expect(invoked).toBe(0);
    g.dispose();
  });
});

describe("the key space is closed over `keyof ExtensionPoints` (§1.2, §1.7)", () => {
  it("rejects an undeclared key at compile time, and a mistyped contribution for a declared one", () => {
    // These assertions are checked by `tsc --noEmit` over this package, not at runtime: each
    // `@ts-expect-error` fails the typecheck if the call it precedes stops being an error.
    // There is no "undeclared key degrades to `unknown`" escape hatch.
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.negative", (ctx) => {
          // @ts-expect-error — "test/undeclared" is not a key of `ExtensionPoints`.
          ctx.contribute("test/undeclared", "anything");
          // @ts-expect-error — same for defining a point on an undeclared key.
          ctx.defineExtensionPoint("test/undeclared", collect<string>());
          // @ts-expect-error — "test/collect" declares `string` contributions, not numbers.
          ctx.contribute("test/collect", 42);
        }),
      ],
    });
    expect(g).toBeDefined();
    g.dispose();
  });
});

describe("redefinition: last registration wins (§1.4)", () => {
  it("replaces the reducer and keeps the key's contributions", () => {
    const host = new PluginHostImpl(fakeRoot());
    host.points.define<string, string[]>("owner1", "test/collect", collect<string>());
    host.points.contribute("test/collect", "a");
    const second = host.points.define<string, string[]>("owner2", "test/collect", (inputs) =>
      inputs.map((s) => s.toUpperCase()),
    );
    expect(second.get()).toEqual(["A"]);
  });

  it("re-attributes reducer faults to the new owner", () => {
    const host = new PluginHostImpl(fakeRoot());
    const faults: { pluginId: string; error: unknown }[] = [];
    host.bus.on(null, "core/pluginError", (e) => void faults.push(e));

    host.points.define<string, string[]>("owner1", "test/badReducer", collect<string>());
    const second = host.points.define<string, string[]>("owner2", "test/badReducer", () => {
      throw new Error("boom");
    });
    second.get();
    expect(faults).toHaveLength(1);
    expect(faults[0]?.pluginId).toBe("owner2");
  });

  it("delivers buffered contributions to the redefinition exactly as to a first definition", () => {
    const host = new PluginHostImpl(fakeRoot());
    host.points.contribute("test/buffered", "buffered");
    host.points.define<string, string[]>("owner1", "test/buffered", collect<string>());
    const second = host.points.define<string, string[]>("owner2", "test/buffered", collect<string>());
    host.points.contribute("test/buffered", "after");
    expect(second.get()).toEqual(["buffered", "after"]);
  });

  it("keeps the first handle live — it reads through to the new definition", () => {
    const host = new PluginHostImpl(fakeRoot());
    const firstHandle = host.points.define<string, string[]>(
      "owner1",
      "test/collect",
      collect<string>(),
    );
    host.points.contribute("test/collect", "a");
    host.points.define<string, string[]>("owner2", "test/collect", (inputs) =>
      inputs.map((s) => s.toUpperCase()),
    );
    expect(firstHandle.get()).toEqual(["A"]);
  });
});

describe("reference-stable results (§1.4)", () => {
  it("collect: repeated get() returns the same reference while the contribution set is unchanged", () => {
    const host = new PluginHostImpl(fakeRoot());
    const point = host.points.define<string, string[]>("owner", "test/collect", collect<string>());
    host.points.contribute("test/collect", "a");
    const firstRead = point.get();
    expect(point.get()).toBe(firstRead);
    expect(point.get()).toBe(firstRead);
  });

  it("collect: a new contribution produces a fresh value", () => {
    const host = new PluginHostImpl(fakeRoot());
    const point = host.points.define<string, string[]>("owner", "test/collect", collect<string>());
    host.points.contribute("test/collect", "a");
    const before = point.get();
    host.points.contribute("test/collect", "b");
    const after = point.get();
    expect(after).not.toBe(before);
    expect(after).toEqual(["a", "b"]);
    // …and the fresh value is itself stable again.
    expect(point.get()).toBe(after);
  });

  it("reduce: repeated get() returns the same reference, a new contribution a fresh one", () => {
    const host = new PluginHostImpl(fakeRoot());
    const fold = reduce<string, { names: string[] }>(
      (acc, name) => ({ names: [...acc.names, name] }),
      { names: [] },
    );
    const point = host.points.define<string, { names: string[] }>("owner", "test/collect", fold);
    host.points.contribute("test/collect", "a");
    const before = point.get();
    expect(point.get()).toBe(before);
    host.points.contribute("test/collect", "b");
    const after = point.get();
    expect(after).not.toBe(before);
    expect(point.get()).toBe(after);
  });

  it("survives the public ctx path end to end", () => {
    let point: ExtensionPoint<string, string[]> | undefined;
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.owner", (ctx) => {
          point = ctx.defineExtensionPoint("test/collect", collect<string>());
        }),
        plug("test.c1", (ctx) => ctx.contribute("test/collect", "a"), {
          dependsOn: ["test.owner"],
        }),
      ],
    });
    const firstRead = point?.get();
    expect(point?.get()).toBe(firstRead);
    g.dispose();
  });
});

describe("the three strategies through defineExtensionPoint (§1.4)", () => {
  it("collect: all contributions as an array in startup order", () => {
    let point: ExtensionPoint<string, string[]> | undefined;
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.owner", (ctx) => {
          point = ctx.defineExtensionPoint("test/collect", collect<string>());
        }),
        plug("test.c1", (ctx) => ctx.contribute("test/collect", "a"), {
          dependsOn: ["test.owner"],
        }),
        plug("test.c2", (ctx) => ctx.contribute("test/collect", "b"), {
          dependsOn: ["test.c1"],
        }),
      ],
    });
    expect(point?.get()).toEqual(["a", "b"]);
    g.dispose();
  });

  it("first: composite invokes contributions until one returns non-undefined", () => {
    let point: ExtensionPoint<NumToString, NumToString> | undefined;
    const big: NumToString = (x) => (x > 10 ? "big" : undefined);
    const fallback: NumToString = () => "fallback";
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.owner", (ctx) => {
          point = ctx.defineExtensionPoint("test/first", first<[number], string>());
        }),
        plug("test.c1", (ctx) => ctx.contribute("test/first", big), {
          dependsOn: ["test.owner"],
        }),
        plug("test.c2", (ctx) => ctx.contribute("test/first", fallback), {
          dependsOn: ["test.c1"],
        }),
      ],
    });
    const composed = point?.get();
    expect(composed?.(50)).toBe("big");
    expect(composed?.(1)).toBe("fallback");
    g.dispose();
  });

  it("reduce: arbitrary fold to a single value", () => {
    let point: ExtensionPoint<number, number> | undefined;
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.owner", (ctx) => {
          point = ctx.defineExtensionPoint(
            "test/reduce",
            reduce<number, number>((acc, n) => Math.max(acc, n), 0),
          );
        }),
        plug("test.c1", (ctx) => ctx.contribute("test/reduce", 24), {
          dependsOn: ["test.owner"],
        }),
        plug("test.c2", (ctx) => ctx.contribute("test/reduce", 40), {
          dependsOn: ["test.c1"],
        }),
      ],
    });
    expect(point?.get()).toBe(40);
    g.dispose();
  });
});

describe("fault barrier around the reducer (§1.9)", () => {
  it("reports a throwing reducer as core/pluginError attributed to the point owner", () => {
    const host = new PluginHostImpl(fakeRoot());
    const faults: { pluginId: string; error: unknown }[] = [];
    const boom = new Error("reducer exploded");
    host.bus.on(null, "core/pluginError", (e) => void faults.push(e));

    const p = host.points.define<string, string[]>("test.owner", "test/badReducer", () => {
      throw boom;
    });
    host.points.contribute("test/badReducer", "x");

    expect(() => p.get()).not.toThrow();
    expect(faults).toEqual([{ pluginId: "test.owner", error: boom }]);
  });

  it("does not abort the plugin that called get()", () => {
    const host = new PluginHostImpl(fakeRoot());
    const seq: string[] = [];
    const p = host.points.define<string, string[]>("test.owner", "test/badReducer", () => {
      throw new Error("boom");
    });
    seq.push("before");
    p.get();
    seq.push("after");
    expect(seq).toEqual(["before", "after"]);
  });
});
