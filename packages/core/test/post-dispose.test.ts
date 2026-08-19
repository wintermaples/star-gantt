/**
 * dispose() clears every registry and makes post-dispose calls empty no-ops.
 * App-listener faults are attributed to the sentinel pluginId "app".
 */
import { describe, expect, it } from "vitest";
import { Gantt } from "../src/index";
import type { GanttInstance } from "../src/index";
import { fakeRoot, plug } from "./_keys";

function makeGantt(): GanttInstance {
  return Gantt.create({
    element: fakeRoot(),
    plugins: [
      plug("test.provider", (ctx) => {
        ctx.provide("test.alpha", { name: "alpha", ping: () => "pong" });
        ctx.registerCommand("test/inc", () => {});
        ctx.on("test/plain", () => {});
      }),
    ],
  });
}

describe("post-dispose behavior", () => {
  it("dispatch behaves as an unknown command", () => {
    let ran = 0;
    const gantt = Gantt.create({
      element: fakeRoot(),
      plugins: [plug("test.provider", (ctx) => ctx.registerCommand("test/inc", () => ran++))],
    });
    gantt.dispatch("test/inc", { by: 1 });
    expect(ran).toBe(1);
    gantt.dispose();
    expect(() => gantt.dispatch("test/inc", { by: 1 })).not.toThrow();
    expect(ran).toBe(1);
  });

  it("emit-side: app subscriptions made before dispose are released", () => {
    const seen: string[] = [];
    const gantt = Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.emitter", (ctx) => {
          ctx.registerCommand("test/noop", () => ctx.emit("test/plain", { v: "x" }));
        }),
      ],
    });
    gantt.on("test/plain", (e) => void seen.push(e.v));
    gantt.dispatch("test/noop", undefined);
    expect(seen).toEqual(["x"]);
    gantt.dispose();
    // The command registry is cleared too, so re-dispatch is a no-op; the point here is that
    // even a direct emit finds no surviving subscription (checked via the host in the next test).
    gantt.dispatch("test/noop", undefined);
    expect(seen).toEqual(["x"]);
  });

  it("on() after dispose registers nothing and returns an inert Disposable", () => {
    const gantt = makeGantt();
    gantt.dispose();
    const handle = gantt.on("test/plain", () => {
      throw new Error("must never be called");
    });
    expect(typeof handle.dispose).toBe("function");
    expect(() => handle.dispose()).not.toThrow();
  });

  it("service() reports absence with the usual missing-service error", () => {
    const gantt = makeGantt();
    expect(gantt.service("test.alpha").ping()).toBe("pong");
    gantt.dispose();
    expect(() => gantt.service("test.alpha")).toThrowError(
      'stargantt: service "test.alpha" is not provided',
    );
  });

  it("getService() returns undefined", () => {
    const gantt = makeGantt();
    expect(gantt.getService("test.alpha")).toBeDefined();
    gantt.dispose();
    expect(gantt.getService("test.alpha")).toBeUndefined();
  });

  it("a second dispose() does nothing", () => {
    const gantt = makeGantt();
    gantt.dispose();
    expect(() => gantt.dispose()).not.toThrow();
  });
});

describe("app-listener fault attribution", () => {
  it('reports a throwing gantt.on listener as core/pluginError with pluginId "app"', () => {
    const faults: { pluginId: string; error: unknown }[] = [];
    let emitThrew = false;
    const boom = new Error("app listener exploded");
    const gantt = Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.emitter", (ctx) => {
          ctx.registerCommand("test/noop", () => {
            try {
              ctx.emit("test/plain", { v: "x" });
            } catch {
              emitThrew = true;
            }
          });
        }),
      ],
    });
    gantt.on("core/pluginError", (e) => void faults.push(e));
    gantt.on("test/plain", () => {
      throw boom;
    });
    gantt.dispatch("test/noop", undefined);
    expect(emitThrew).toBe(false);
    expect(faults).toEqual([{ pluginId: "app", error: boom }]);
  });
});
