/**
 * Contract §1.1 / §1.7 / §1.8 / §1.9 — `ctx.own()` is the only sanctioned way to register
 * listeners, DOM and timers, and the core owns their disposal.
 * `gantt.dispose()` tears down in reverse startup order, then releases every `own()` registration.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Gantt } from "../src/index";
import type { Disposable } from "../src/index";
import { DisposableLedgerImpl } from "../src/internal/disposable";
import { PluginHostImpl } from "../src/internal/host";
import { fakeRoot, plug } from "./_keys";

afterEach(() => {
  vi.useRealTimers();
});

/** Records dispose() calls into `log`. */
const marker = (log: string[], name: string): Disposable => ({
  dispose: () => void log.push(name),
});

describe("ctx.own() on host dispose (§1.8)", () => {
  it("disposes every registered resource", () => {
    const log: string[] = [];
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.a", (ctx) => {
          ctx.own(marker(log, "a1"));
          ctx.own(marker(log, "a2"));
        }),
        plug("test.b", (ctx) => ctx.own(marker(log, "b1"))),
      ],
    });
    expect(log).toEqual([]);
    g.dispose();
    expect(log.sort()).toEqual(["a1", "a2", "b1"]);
  });

  it("disposes each resource exactly once", () => {
    const disposeSpy = vi.fn();
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [plug("test.a", (ctx) => ctx.own({ dispose: disposeSpy }))],
    });
    g.dispose();
    g.dispose();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it("runs all setup() teardown functions BEFORE releasing own() registrations (§1.8)", () => {
    const log: string[] = [];
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.a", (ctx) => {
          ctx.own(marker(log, "own:a"));
          return () => void log.push("teardown:a");
        }),
        plug("test.b", (ctx) => {
          ctx.own(marker(log, "own:b"));
          return () => void log.push("teardown:b");
        }),
      ],
    });
    g.dispose();
    expect(log.slice(0, 2)).toEqual(["teardown:b", "teardown:a"]);
    expect(log.slice(2).sort()).toEqual(["own:a", "own:b"]);
  });
});

describe("ctx.own() with real resources", () => {
  it("removes an event listener registered through own()", () => {
    const target = new EventTarget();
    let hits = 0;
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.listener", (ctx) => {
          const handler = (): void => void hits++;
          target.addEventListener("tick", handler);
          ctx.own({ dispose: () => target.removeEventListener("tick", handler) });
        }),
      ],
    });

    target.dispatchEvent(new Event("tick"));
    expect(hits).toBe(1);

    g.dispose();
    target.dispatchEvent(new Event("tick"));
    expect(hits).toBe(1);
  });

  it("clears a timer registered through own()", () => {
    vi.useFakeTimers();
    let ticks = 0;
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.timer", (ctx) => {
          const id = setInterval(() => void ticks++, 10);
          ctx.own({ dispose: () => clearInterval(id) });
        }),
      ],
    });

    vi.advanceTimersByTime(30);
    expect(ticks).toBe(3);

    g.dispose();
    vi.advanceTimersByTime(100);
    expect(ticks).toBe(3);
  });
});

describe("ctx.on() subscriptions are ledgered automatically (§1.3, §1.7)", () => {
  it("unsubscribes plugin listeners on dispose without an explicit own()", () => {
    const host = new PluginHostImpl(fakeRoot());
    let hits = 0;
    host.register(plug("test.sub", (ctx) => void ctx.on("test/plain", () => void hits++)));
    host.start();

    host.bus.emit("test/plain", { v: "1" });
    expect(hits).toBe(1);

    host.dispose();
    host.bus.emit("test/plain", { v: "2" });
    expect(hits).toBe(1);
  });

  it("disposing the returned Disposable early is compatible with the later ledger release", () => {
    const host = new PluginHostImpl(fakeRoot());
    let hits = 0;
    let sub: Disposable | undefined;
    host.register(plug("test.sub", (ctx) => void (sub = ctx.on("test/plain", () => void hits++))));
    host.start();

    sub?.dispose();
    host.bus.emit("test/plain", { v: "1" });
    expect(hits).toBe(0);
    expect(() => host.dispose()).not.toThrow();
  });
});

describe("DisposableLedger unit-level (§1.9)", () => {
  it("releases a plugin's resources in reverse registration order", () => {
    const log: string[] = [];
    const ledger = new DisposableLedgerImpl();
    ledger.own("p", marker(log, "1"));
    ledger.own("p", marker(log, "2"));
    ledger.own("p", marker(log, "3"));
    ledger.releaseAll("p");
    expect(log).toEqual(["3", "2", "1"]);
  });

  it("scopes registrations per plugin", () => {
    const log: string[] = [];
    const ledger = new DisposableLedgerImpl();
    ledger.own("p1", marker(log, "p1"));
    ledger.own("p2", marker(log, "p2"));
    ledger.releaseAll("p1");
    expect(log).toEqual(["p1"]);
    ledger.releaseAll("p2");
    expect(log).toEqual(["p1", "p2"]);
  });

  it("keeps releasing the remaining resources when one dispose() throws (§1.8 re-mount guarantee)", () => {
    const log: string[] = [];
    const errors: Array<{ owner: string; error: unknown }> = [];
    const ledger = new DisposableLedgerImpl((owner, error) => void errors.push({ owner, error }));
    ledger.own("p", marker(log, "a"));
    ledger.own("p", {
      dispose: () => {
        throw new Error("boom");
      },
    });
    ledger.own("p", marker(log, "c"));
    expect(() => ledger.releaseAll("p")).not.toThrow();
    expect(log).toEqual(["c", "a"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.owner).toBe("p");
  });

  it("reports a throwing dispose() as core/pluginError and still releases other plugins", () => {
    const log: string[] = [];
    const faults: string[] = [];
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.a", (ctx) => void ctx.own(marker(log, "a"))),
        plug("test.bad", (ctx) =>
          void ctx.own({
            dispose: () => {
              throw new Error("boom");
            },
          }),
        ),
      ],
    });
    g.on("core/pluginError", (e) => void faults.push(e.pluginId));
    expect(() => g.dispose()).not.toThrow();
    expect(log).toEqual(["a"]);
    expect(faults).toEqual(["test.bad"]);
  });

  it("is idempotent and safe for unknown owners", () => {
    const log: string[] = [];
    const ledger = new DisposableLedgerImpl();
    ledger.own("p", marker(log, "x"));
    ledger.releaseAll("p");
    ledger.releaseAll("p");
    ledger.releaseAll("never-registered");
    expect(log).toEqual(["x"]);
  });
});
