/**
 * Contract §1.6 (lifecycle) + §1.9 `PluginHost` — registration, topological resolution,
 * pre/normal/post ordering, `lifecycle/ready`, state machine, reverse-order teardown.
 */
import { describe, expect, it } from "vitest";
import { Gantt } from "../src/index";
import { PluginHostImpl } from "../src/internal/host";
import { fakeRoot, plug } from "./_keys";

/** Runs the given plugins through a bare host and returns the setup() order. */
function startupOrder(plugins: ReturnType<typeof plug>[]): string[] {
  const seq: string[] = [];
  const host = new PluginHostImpl(fakeRoot());
  for (const p of plugins) {
    host.register(
      plug(p.meta.id, () => void seq.push(p.meta.id), {
        ...(p.meta.dependsOn ? { dependsOn: p.meta.dependsOn } : {}),
        ...(p.meta.optional ? { optional: p.meta.optional } : {}),
        ...(p.meta.order ? { order: p.meta.order } : {}),
      }),
    );
  }
  host.start();
  return seq;
}

describe("startup ordering (§1.6)", () => {
  it("runs setup() in registration order when there are no deps and no order hints", () => {
    expect(
      startupOrder([plug("c", () => {}), plug("a", () => {}), plug("b", () => {})]),
    ).toEqual(["c", "a", "b"]);
  });

  it("orders pre -> normal -> post inside the same topology tier", () => {
    expect(
      startupOrder([
        plug("n", () => {}, { order: "normal" }),
        plug("p", () => {}, { order: "post" }),
        plug("r", () => {}, { order: "pre" }),
      ]),
    ).toEqual(["r", "n", "p"]);
  });

  it("treats a missing `order` as `normal`", () => {
    expect(
      startupOrder([
        plug("plain", () => {}),
        plug("pre", () => {}, { order: "pre" }),
        plug("post", () => {}, { order: "post" }),
      ]),
    ).toEqual(["pre", "plain", "post"]);
  });

  it("breaks ties within the same order rank by registration order", () => {
    expect(
      startupOrder([
        plug("p3", () => {}, { order: "post" }),
        plug("p1", () => {}, { order: "post" }),
        plug("p2", () => {}, { order: "post" }),
      ]),
    ).toEqual(["p3", "p1", "p2"]);
  });

  it("topologically sorts dependsOn regardless of registration order", () => {
    expect(
      startupOrder([
        plug("c", () => {}, { dependsOn: ["b"] }),
        plug("b", () => {}, { dependsOn: ["a"] }),
        plug("a", () => {}),
      ]),
    ).toEqual(["a", "b", "c"]);
  });

  it("does not let an order hint override topology (hints apply within a tier only)", () => {
    // `a` asks for "post" but `b` depends on it, so `a` still runs first.
    expect(
      startupOrder([
        plug("b", () => {}, { dependsOn: ["a"], order: "pre" }),
        plug("a", () => {}, { order: "post" }),
      ]),
    ).toEqual(["a", "b"]);
  });

  it("applies pre/normal/post inside each tier independently", () => {
    expect(
      startupOrder([
        plug("t1post", () => {}, { order: "post" }),
        plug("t1pre", () => {}, { order: "pre" }),
        plug("t2post", () => {}, { dependsOn: ["t1pre"], order: "post" }),
        plug("t2pre", () => {}, { dependsOn: ["t1post"], order: "pre" }),
      ]),
    ).toEqual(["t1pre", "t1post", "t2pre", "t2post"]);
  });

  it("ignores `optional` deps for ordering purposes when the plugin is absent", () => {
    expect(
      startupOrder([plug("a", () => {}, { optional: ["nope"] }), plug("b", () => {})]),
    ).toEqual(["a", "b"]);
  });
});

describe("resolution failures (§1.6)", () => {
  it("throws on an unresolved hard dependency, naming the missing plugin", () => {
    expect(() =>
      Gantt.create({
        element: fakeRoot(),
        plugins: [plug("test.needs", () => {}, { dependsOn: ["test.missing"] })],
      }),
    ).toThrowError(/test\.missing/);
  });

  it("does not throw for an unresolved `optional` dependency", () => {
    expect(() =>
      Gantt.create({
        element: fakeRoot(),
        plugins: [plug("test.soft", () => {}, { optional: ["test.missing"] })],
      }).dispose(),
    ).not.toThrow();
  });

  it("throws on a dependency cycle with the offending plugin-ID chain in the message", () => {
    let message = "";
    try {
      Gantt.create({
        element: fakeRoot(),
        plugins: [
          plug("test.x", () => {}, { dependsOn: ["test.y"] }),
          plug("test.y", () => {}, { dependsOn: ["test.x"] }),
        ],
      });
      expect.unreachable("expected a cycle error");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/cycle/i);
    expect(message).toContain("test.x");
    expect(message).toContain("test.y");
  });

  it("includes every member of a longer cycle in the chain", () => {
    let message = "";
    try {
      Gantt.create({
        element: fakeRoot(),
        plugins: [
          plug("test.a", () => {}, { dependsOn: ["test.c"] }),
          plug("test.b", () => {}, { dependsOn: ["test.a"] }),
          plug("test.c", () => {}, { dependsOn: ["test.b"] }),
        ],
      });
      expect.unreachable("expected a cycle error");
    } catch (e) {
      message = (e as Error).message;
    }
    for (const id of ["test.a", "test.b", "test.c"]) expect(message).toContain(id);
  });

  it("does not run any setup() when resolution fails", () => {
    let ran = false;
    expect(() =>
      Gantt.create({
        element: fakeRoot(),
        plugins: [
          plug("test.ok", () => void (ran = true)),
          plug("test.broken", () => {}, { dependsOn: ["test.absent"] }),
        ],
      }),
    ).toThrow();
    expect(ran).toBe(false);
  });
});

describe("lifecycle/ready (§1.2 Events)", () => {
  it("fires once, after every plugin's setup() has completed", () => {
    const seq: string[] = [];
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.first", (ctx) => {
          seq.push("setup:first");
          ctx.on("lifecycle/ready", () => void seq.push("ready:first"));
        }),
        plug("test.second", (ctx) => {
          seq.push("setup:second");
          ctx.on("lifecycle/ready", () => void seq.push("ready:second"));
        }),
      ],
    });
    expect(seq).toEqual(["setup:first", "setup:second", "ready:first", "ready:second"]);
    g.dispose();
  });

  it("has already fired by the time create() returns", () => {
    let count = 0;
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [plug("test.ready", (ctx) => void ctx.on("lifecycle/ready", () => void count++))],
    });
    expect(count).toBe(1);
    g.dispose();
  });
});

describe("plugin state machine (§1.6: registered -> resolved -> active -> disposed)", () => {
  it("walks every state in order", () => {
    const host = new PluginHostImpl(fakeRoot());
    const observed: (string | undefined)[] = [];

    host.register(
      plug("test.a", () => {
        // During its own setup, `a` is resolved but not yet active,
        // and the not-yet-started `b` is resolved too.
        observed.push(host.stateOf("test.a"));
        observed.push(host.stateOf("test.b"));
      }),
    );
    host.register(plug("test.b", () => {}, { dependsOn: ["test.a"] }));

    expect(host.stateOf("test.a")).toBe("registered");
    expect(host.stateOf("test.b")).toBe("registered");

    host.start();
    expect(observed).toEqual(["resolved", "resolved"]);
    expect(host.stateOf("test.a")).toBe("active");
    expect(host.stateOf("test.b")).toBe("active");

    host.dispose();
    expect(host.stateOf("test.a")).toBe("disposed");
    expect(host.stateOf("test.b")).toBe("disposed");
  });

  it("reports `undefined` for an unknown plugin id", () => {
    const host = new PluginHostImpl(fakeRoot());
    expect(host.stateOf("test.nobody")).toBeUndefined();
  });

  it("marks an earlier plugin active while a later one is still resolved", () => {
    const host = new PluginHostImpl(fakeRoot());
    const observed: (string | undefined)[] = [];
    host.register(plug("test.a", () => {}));
    host.register(
      plug("test.b", () => {
        observed.push(host.stateOf("test.a"));
        observed.push(host.stateOf("test.b"));
      }),
    );
    host.start();
    expect(observed).toEqual(["active", "resolved"]);
    host.dispose();
  });
});

describe("teardown (§1.6)", () => {
  it("runs setup()'s returned teardown functions in reverse startup order", () => {
    const seq: string[] = [];
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.a", () => () => void seq.push("down:a")),
        plug("test.b", () => () => void seq.push("down:b"), { dependsOn: ["test.a"] }),
        plug("test.c", () => () => void seq.push("down:c"), { dependsOn: ["test.b"] }),
      ],
    });
    expect(seq).toEqual([]);
    g.dispose();
    expect(seq).toEqual(["down:c", "down:b", "down:a"]);
  });

  it("tolerates plugins that return no teardown function", () => {
    const seq: string[] = [];
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.a", () => () => void seq.push("down:a")),
        plug("test.b", () => {}),
        plug("test.c", () => () => void seq.push("down:c")),
      ],
    });
    g.dispose();
    expect(seq).toEqual(["down:c", "down:a"]);
  });
});
