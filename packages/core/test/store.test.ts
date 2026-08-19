/**
 * docs/specs/architecture.md §1.1 — store-shaped service foundation.
 *
 * The six normative semantics are pinned here, one describe() block each:
 *   1. synchronous notification, no coalescing, value committed before the first subscriber runs
 *   2. re-entrant set()/update() always throws (every build)
 *   3. subscriber exceptions are contained (fault channel when owned, console.error otherwise)
 *   4. unsubscribe via the returned Disposable (idempotent, honoured mid-dispatch)
 *   5. subscribe() during a dispatch is not called by that dispatch
 *   6. get() from inside a subscriber returns the new value
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Gantt, createStore } from "../src/index";
import type { Disposable } from "../src/index";
import { PluginHostImpl } from "../src/internal/host";
import { fakeRoot, plug } from "./_keys";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("store: get / set / update", () => {
  it("get() returns the initial value", () => {
    expect(createStore(1).get()).toBe(1);
  });

  it("set() replaces the value", () => {
    const s = createStore({ n: 1 });
    const next = { n: 2 };
    s.set(next);
    expect(s.get()).toBe(next);
  });

  it("update(fn) is exactly set(fn(get()))", () => {
    const s = createStore(1);
    const seen: number[] = [];
    s.subscribe((n, p) => void seen.push(n, p));
    s.update((prev) => prev + 1);
    expect(s.get()).toBe(2);
    expect(seen).toEqual([2, 1]);
  });
});

describe("store: synchronous notification, no coalescing (§1.1-1)", () => {
  it("notifies every subscriber with (next, prev) before set() returns", () => {
    const s = createStore("a");
    const calls: [string, string][] = [];
    s.subscribe((next, prev) => void calls.push([next, prev]));
    s.subscribe((next, prev) => void calls.push([next, prev]));
    s.set("b");
    expect(calls).toEqual([
      ["b", "a"],
      ["b", "a"],
    ]);
  });

  it("notifies once per set() even when the value is identical", () => {
    const same = { v: 1 };
    const s = createStore(same);
    let n = 0;
    s.subscribe(() => void n++);
    s.set(same);
    s.set(same);
    expect(n).toBe(2);
  });

  it("notifies in subscription order", () => {
    const s = createStore(0);
    const order: string[] = [];
    s.subscribe(() => void order.push("first"));
    s.subscribe(() => void order.push("second"));
    s.set(1);
    expect(order).toEqual(["first", "second"]);
  });
});

describe("store: get() inside a subscriber returns next (§1.1-1, §1.1-6)", () => {
  it("commits the value before the first subscriber runs", () => {
    const s = createStore(1);
    const seen: number[] = [];
    s.subscribe(() => void seen.push(s.get()));
    s.subscribe(() => void seen.push(s.get()));
    s.set(2);
    expect(seen).toEqual([2, 2]);
  });
});

describe("store: re-entrant set() throws in every build (§1.1-2)", () => {
  it("throws when a subscriber calls set() on the same store", () => {
    const s = createStore(0);
    let thrown: unknown;
    s.subscribe(() => {
      try {
        s.set(99);
      } catch (err) {
        thrown = err;
      }
    });
    s.set(1);
    expect(thrown).toBeInstanceOf(Error);
    expect(s.get()).toBe(1);
  });

  it("throws when a subscriber calls update() on the same store", () => {
    const s = createStore(0);
    let thrown: unknown;
    s.subscribe(() => {
      try {
        s.update((p) => p + 100);
      } catch (err) {
        thrown = err;
      }
    });
    s.set(1);
    expect(thrown).toBeInstanceOf(Error);
    expect(s.get()).toBe(1);
  });

  it("leaves the in-flight dispatch running with its original (next, prev)", () => {
    const s = createStore(0);
    const pairs: [number, number][] = [];
    s.subscribe(() => {
      try {
        s.set(99);
      } catch {
        /* contained by the test */
      }
    });
    s.subscribe((next, prev) => void pairs.push([next, prev]));
    s.set(1);
    expect(pairs).toEqual([[1, 0]]);
  });

  it("accepts set() again once the dispatch has finished", () => {
    const s = createStore(0);
    s.subscribe(() => {
      try {
        s.set(99);
      } catch {
        /* contained by the test */
      }
    });
    s.set(1);
    expect(() => s.set(2)).not.toThrow();
    expect(s.get()).toBe(2);
  });

  it("allows writing a different store from inside a subscriber", () => {
    const a = createStore(0);
    const b = createStore(0);
    a.subscribe((n) => b.set(n * 10));
    a.set(3);
    expect(b.get()).toBe(30);
  });
});

describe("store: subscriber exceptions are contained (§1.1-3)", () => {
  it("keeps running the remaining subscribers and returns normally", () => {
    const s = createStore(0);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: number[] = [];
    s.subscribe(() => {
      throw new Error("boom");
    });
    s.subscribe((n) => void seen.push(n));
    expect(() => s.set(1)).not.toThrow();
    expect(seen).toEqual([1]);
    expect(errSpy).toHaveBeenCalledTimes(1);
  });

  it("reports through console.error when no plugin context ever owned the subscription", () => {
    const s = createStore(0);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error("app-owned boom");
    s.subscribe(() => {
      throw boom;
    });
    s.set(1);
    expect(errSpy).toHaveBeenCalledWith(boom);
  });

  it("reports core/pluginError with the owner id once the subscription is ctx.own()ed", () => {
    const host = new PluginHostImpl(fakeRoot());
    const faults: { pluginId: string; error: unknown }[] = [];
    host.bus.on(null, "core/pluginError", (e) => void faults.push(e));
    const s = createStore(0);
    const boom = new Error("plugin boom");
    host.register(
      plug("test.owner", (ctx) => {
        ctx.own(
          s.subscribe(() => {
            throw boom;
          }),
        );
      }),
    );
    host.start();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    s.set(1);
    expect(faults).toEqual([{ pluginId: "test.owner", error: boom }]);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("attributes the fault to the first ctx.own() that received the Disposable", () => {
    const faults: { pluginId: string; error: unknown }[] = [];
    const s = createStore(0);
    const boom = new Error("first-owner boom");
    let sub: Disposable | undefined;
    Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.watch", (ctx) => {
          ctx.on("core/pluginError", (e) => void faults.push(e));
        }),
        plug("test.first", (ctx) => {
          sub = s.subscribe(() => {
            throw boom;
          });
          ctx.own(sub);
        }),
        plug("test.second", (ctx) => {
          ctx.own(sub!);
        }),
      ],
    });
    s.set(1);
    expect(faults).toEqual([{ pluginId: "test.first", error: boom }]);
  });

  it("does not let a throwing core/pluginError listener loop", () => {
    const host = new PluginHostImpl(fakeRoot());
    let reports = 0;
    host.bus.on(null, "core/pluginError", () => {
      reports++;
      throw new Error("reporter boom");
    });
    const s = createStore(0);
    host.register(
      plug("test.owner", (ctx) => {
        ctx.own(
          s.subscribe(() => {
            throw new Error("boom");
          }),
        );
      }),
    );
    host.start();
    expect(() => s.set(1)).not.toThrow();
    expect(reports).toBe(1);
  });
});

describe("store: unsubscribe (§1.1-4)", () => {
  it("stops notifying after dispose() and is idempotent", () => {
    const s = createStore(0);
    let n = 0;
    const d = s.subscribe(() => void n++);
    s.set(1);
    d.dispose();
    d.dispose();
    s.set(2);
    expect(n).toBe(1);
  });

  it("skips a subscriber disposed by an earlier subscriber in the same dispatch", () => {
    const s = createStore(0);
    const seen: string[] = [];
    let second: Disposable | undefined;
    s.subscribe(() => {
      seen.push("first");
      second?.dispose();
    });
    second = s.subscribe(() => void seen.push("second"));
    s.set(1);
    expect(seen).toEqual(["first"]);
  });

  it("releases the subscription when the owning plugin is disposed", () => {
    const s = createStore(0);
    let n = 0;
    const gantt = Gantt.create({
      element: fakeRoot(),
      plugins: [plug("test.owner", (ctx) => ctx.own(s.subscribe(() => void n++)))],
    });
    s.set(1);
    gantt.dispose();
    s.set(2);
    expect(n).toBe(1);
  });
});

describe("store: subscribe() during a dispatch (§1.1-4)", () => {
  it("does not call the new subscriber for the in-flight dispatch", () => {
    const s = createStore(0);
    const late: number[] = [];
    s.subscribe(() => {
      s.subscribe((n) => void late.push(n));
    });
    s.set(1);
    expect(late).toEqual([]);
    s.set(2);
    expect(late).toEqual([2]);
  });
});
