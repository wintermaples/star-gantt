/**
 * Contract §1.5 (`CommandRunner`), §1.7 (`registerCommand` / `dispatch`),
 * §1.8 (`gantt.dispatch`) and §1.9 (`CommandBus`, fault barrier).
 */
import { describe, expect, it } from "vitest";
import { Gantt } from "../src/index";
import { CommandBusImpl } from "../src/internal/commands";
import { EventBusImpl } from "../src/internal/events";
import { fakeRoot, plug } from "./_keys";

describe("registerCommand / dispatch (§1.7)", () => {
  it("runs the registered runner with the dispatched payload", () => {
    const seen: { by: number }[] = [];
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.owner", (ctx) => ctx.registerCommand("test/inc", (p) => void seen.push(p))),
        plug("test.caller", (ctx) => ctx.dispatch("test/inc", { by: 3 })),
      ],
    });
    expect(seen).toEqual([{ by: 3 }]);
    g.dispose();
  });

  it("dispatches synchronously", () => {
    const seq: string[] = [];
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.owner", (ctx) =>
          ctx.registerCommand("test/noop", () => void seq.push("ran")),
        ),
        plug("test.caller", (ctx) => {
          seq.push("before");
          ctx.dispatch("test/noop", undefined);
          seq.push("after");
        }),
      ],
    });
    expect(seq).toEqual(["before", "ran", "after"]);
    g.dispose();
  });

  it("does not require the dispatcher to declare the owner as a dependency", () => {
    // §1.5-4's declared-dependency rule is stated for services only.
    let ran = 0;
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.owner", (ctx) => ctx.registerCommand("test/noop", () => void ran++)),
        plug("test.caller", (ctx) => ctx.dispatch("test/noop", undefined)),
      ],
    });
    expect(ran).toBe(1);
    g.dispose();
  });
});

describe("gantt.dispatch — application-code entry point (§1.8)", () => {
  it("reaches a plugin-registered runner", () => {
    const seen: { by: number }[] = [];
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.owner", (ctx) => ctx.registerCommand("test/inc", (p) => void seen.push(p))),
      ],
    });
    g.dispatch("test/inc", { by: 7 });
    expect(seen).toEqual([{ by: 7 }]);
    g.dispose();
  });
});

describe("fault barrier around command runners (§1.9)", () => {
  it("reports a throwing runner via core/pluginError instead of propagating", () => {
    const bus = new EventBusImpl();
    const commands = new CommandBusImpl(bus);
    const faults: { pluginId: string; error: unknown }[] = [];
    const boom = new Error("runner exploded");
    bus.on(null, "core/pluginError", (e) => void faults.push(e));
    commands.register("test.owner", "test/boom", () => {
      throw boom;
    });

    expect(() => commands.dispatch("test/boom", undefined)).not.toThrow();
    expect(faults).toEqual([{ pluginId: "test.owner", error: boom }]);
  });

  it("attributes the fault to the registering plugin, not the dispatcher", () => {
    const faults: { pluginId: string; error: unknown }[] = [];
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.reporter", (ctx) => void ctx.on("core/pluginError", (e) => void faults.push(e))),
        plug("test.owner", (ctx) =>
          ctx.registerCommand("test/boom", () => {
            throw new Error("boom");
          }),
        ),
        plug("test.caller", (ctx) => ctx.dispatch("test/boom", undefined)),
      ],
    });
    expect(faults).toHaveLength(1);
    expect(faults[0]?.pluginId).toBe("test.owner");
    g.dispose();
  });

  it("a throwing runner does not abort the rest of startup", () => {
    const seq: string[] = [];
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.owner", (ctx) =>
          ctx.registerCommand("test/boom", () => {
            throw new Error("boom");
          }),
        ),
        plug("test.caller", (ctx) => {
          ctx.dispatch("test/boom", undefined);
          seq.push("caller-continued");
        }),
        plug("test.later", () => void seq.push("later-started")),
      ],
    });
    expect(seq).toEqual(["caller-continued", "later-started"]);
    g.dispose();
  });
});
