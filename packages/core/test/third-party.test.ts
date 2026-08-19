/**
 * docs/specs/architecture.md §1.3 / §8 — third parties use the same public API as official
 * plugins.
 *
 * The core restricts no event name, so a plugin nobody has heard of can emit and subscribe freely;
 * it can contribute to an extension point an official plugin owns; and when it claims a shared
 * token an official plugin already holds, the conflict is detected and attributed to it. The
 * declaration merging below is exactly what a third-party package would ship — the core has no
 * table of official names to check against.
 */
import { describe, expect, it } from "vitest";
import { Gantt, collect, createStore } from "../src/index";
import type { ExtensionPoint, ExtensionPointDecl, SlotGrant } from "../src/index";
import { fakeRoot, plug } from "./_keys";

declare module "../src/index" {
  interface Events {
    // Namespaced by plugin id, as the documentation convention recommends...
    "acme.widgets/pinged": { n: number };
    // ...and a name that follows no convention at all, which the core accepts just the same.
    "!! whatever ~ third party wants": void;
  }

  interface ExtensionPoints {
    "official/decorators": ExtensionPointDecl<string, string[]>;
  }
}

/** Stands in for an official plugin: same API, no privileges. */
const officialPoint = (
  handle: (p: ExtensionPoint<string, string[]>) => void,
): ReturnType<typeof plug> =>
  plug("stargantt.official", (ctx) => {
    handle(ctx.defineExtensionPoint("official/decorators", collect<string>()));
    ctx.contribute("official/decorators", "official-one");
  });

describe("third-party events (§1.3)", () => {
  it("lets an unknown plugin emit and observe any event name it likes", () => {
    const seen: unknown[] = [];
    Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("acme.watcher", (ctx) => {
          ctx.on("acme.widgets/pinged", (e) => void seen.push(e.n));
          ctx.on("!! whatever ~ third party wants", () => void seen.push("odd"));
        }),
        plug("acme.widgets", (ctx) => {
          ctx.on("lifecycle/ready", () => {
            ctx.emit("acme.widgets/pinged", { n: 7 });
            ctx.emit("!! whatever ~ third party wants", undefined);
          });
        }),
      ],
    });
    expect(seen).toEqual([7, "odd"]);
  });

  it("delivers an official event to a third-party listener and vice versa", () => {
    const seen: string[] = [];
    Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("stargantt.official", (ctx) => {
          ctx.on("acme.widgets/pinged", () => void seen.push("official heard third party"));
        }),
        plug("acme.widgets", (ctx) => {
          ctx.on("lifecycle/ready", () => {
            seen.push("third party heard official");
            ctx.emit("acme.widgets/pinged", { n: 1 });
          });
        }),
      ],
    });
    expect(seen).toEqual(["third party heard official", "official heard third party"]);
  });
});

describe("third-party extension-point contributions (§1.4)", () => {
  it("contributes to a point an official plugin owns, in startup order", () => {
    let point: ExtensionPoint<string, string[]> | undefined;
    Gantt.create({
      element: fakeRoot(),
      plugins: [
        officialPoint((p) => void (point = p)),
        plug("acme.widgets", (ctx) => ctx.contribute("official/decorators", "acme-one")),
      ],
    });
    expect(point!.get()).toEqual(["official-one", "acme-one"]);
  });

  it("accepts a contribution made before the owning plugin declares the point", () => {
    let point: ExtensionPoint<string, string[]> | undefined;
    Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("acme.widgets", (ctx) => ctx.contribute("official/decorators", "acme-early")),
        officialPoint((p) => void (point = p)),
      ],
    });
    expect(point!.get()).toEqual(["acme-early", "official-one"]);
  });
});

describe("third-party claim collisions (§1.2)", () => {
  const faultsOf = (
    plugins: readonly ReturnType<typeof plug>[],
  ): { pluginId: string; error: unknown; level?: "warning" }[] => {
    const faults: { pluginId: string; error: unknown; level?: "warning" }[] = [];
    Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.watch", (ctx) => {
          ctx.on("core/pluginError", (e) => void faults.push(e));
        }),
        ...plugins,
      ],
    });
    return faults;
  };

  it("reports a third-party order claim that collides with an official one", () => {
    const faults = faultsOf([
      plug("stargantt.task-bars", (ctx) =>
        ctx.claimOrder("renderer/layers", "task-bars:bars", 60),
      ),
      plug("acme.widgets", (ctx) => ctx.claimOrder("renderer/layers", "acme:badge", 60)),
    ]);
    expect(faults).toHaveLength(1);
    expect(faults[0]!.pluginId).toBe("acme.widgets");
  });

  it("reports an official order claim that collides with a third-party one, symmetrically", () => {
    const faults = faultsOf([
      plug("acme.widgets", (ctx) => ctx.claimOrder("renderer/layers", "acme:badge", 60)),
      plug("stargantt.task-bars", (ctx) =>
        ctx.claimOrder("renderer/layers", "task-bars:bars", 60),
      ),
    ]);
    expect(faults).toHaveLength(1);
    expect(faults[0]!.pluginId).toBe("stargantt.task-bars");
  });

  it("reports a third-party meta-key claim that collides with an official one", () => {
    const faults = faultsOf([
      plug("stargantt.tree-grid", (ctx) => ctx.claimKey("task.meta", "taskFields")),
      plug("acme.widgets", (ctx) => ctx.claimKey("task.meta", "taskFields")),
    ]);
    expect(faults).toHaveLength(1);
    expect(faults[0]!.pluginId).toBe("acme.widgets");
    expect(faults[0]!.level).toBeUndefined();
  });

  it("lets a third party claim a meta key nobody official has taken", () => {
    const faults = faultsOf([
      plug("stargantt.tree-grid", (ctx) => ctx.claimKey("task.meta", "taskFields")),
      plug("acme.widgets", (ctx) => ctx.claimKey("task.meta", "acmeBadge")),
    ]);
    expect(faults).toEqual([]);
  });

  it("warns and proposes an alternative when a third party wants an occupied slot", () => {
    const corners = ["top-left", "top-right", "bottom-left", "bottom-right"];
    let grant: SlotGrant | undefined;
    const faults = faultsOf([
      plug("stargantt.view", (ctx) => void ctx.claimSlot("overlay-corner", "top-right", corners)),
      plug("acme.widgets", (ctx) => {
        grant = ctx.claimSlot("overlay-corner", "top-right", corners);
      }),
    ]);
    expect(grant).toEqual({ granted: false, alternative: "bottom-left" });
    expect(faults).toHaveLength(1);
    expect(faults[0]!.pluginId).toBe("acme.widgets");
    expect(faults[0]!.level).toBe("warning");
  });
});

describe("third-party stores (§1.1)", () => {
  it("subscribes to a store an official service exposes and is attributed on a fault", () => {
    const faults: { pluginId: string; error: unknown }[] = [];
    const official = createStore(0);
    const seen: number[] = [];
    const boom = new Error("acme boom");
    const gantt = Gantt.create({
      element: fakeRoot(),
      plugins: [
        plug("test.watch", (ctx) => {
          ctx.on("core/pluginError", (e) => void faults.push(e));
        }),
        plug("acme.widgets", (ctx) => {
          ctx.own(official.subscribe((n) => void seen.push(n)));
          ctx.own(
            official.subscribe(() => {
              throw boom;
            }),
          );
        }),
      ],
    });
    official.set(1);
    expect(seen).toEqual([1]);
    expect(faults).toEqual([{ pluginId: "acme.widgets", error: boom }]);

    // Disposing the chart releases the third party's subscriptions with everything else it owns.
    gantt.dispose();
    official.set(2);
    expect(seen).toEqual([1]);
  });
});
