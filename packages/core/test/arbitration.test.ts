/**
 * docs/specs/architecture.md §1.2 — the three arbitration mechanisms.
 *
 * `claimOrder` (order-key registry), `claimKey` (key registry) and `claimSlot` (slot registry) are
 * namespaced token-ownership registries on `PluginContext`; `orders(scope)` is the introspection
 * surface on the public instance handle. All three are registration-time declarations: they detect
 * conflicts, they do not police access.
 */
import { describe, expect, it } from "vitest";
import { Gantt } from "../src/index";
import type { AnyPlugin, GanttInstance, PluginContext, SlotGrant } from "../src/index";
import { fakeRoot, plug } from "./_keys";

interface Fault {
  pluginId: string;
  error: unknown;
  level?: "warning";
}

/** Boots a chart whose first plugin records every `core/pluginError` report. */
function boot(...plugins: AnyPlugin[]): { gantt: GanttInstance; faults: Fault[] } {
  const faults: Fault[] = [];
  const gantt = Gantt.create({
    element: fakeRoot(),
    plugins: [
      plug("test.watch", (ctx) => {
        ctx.on("core/pluginError", (e) => void faults.push(e));
      }),
      ...plugins,
    ],
  });
  return { gantt, faults };
}

const messageOf = (error: unknown): string => (error as Error).message;

describe("claimOrder: registration and introspection (§1.2)", () => {
  it("records a claim and exposes it through orders(scope)", () => {
    const { gantt, faults } = boot(
      plug("test.bars", (ctx) => ctx.claimOrder("renderer/layers", "task-bars:bars", 60)),
    );
    expect(faults).toEqual([]);
    expect(gantt.orders("renderer/layers")).toEqual([
      { key: "task-bars:bars", order: 60, pluginId: "test.bars" },
    ]);
  });

  it("sorts orders(scope) ascending by order, not by registration", () => {
    const { gantt } = boot(
      plug("test.a", (ctx) => {
        ctx.claimOrder("renderer/layers", "a:late", 90);
        ctx.claimOrder("renderer/layers", "a:early", 10);
      }),
      plug("test.b", (ctx) => ctx.claimOrder("renderer/layers", "b:mid", 50)),
    );
    expect(gantt.orders("renderer/layers").map((e) => e.key)).toEqual([
      "a:early",
      "b:mid",
      "a:late",
    ]);
  });

  it("returns an empty array for an unknown scope", () => {
    const { gantt } = boot(plug("test.a", (ctx) => ctx.claimOrder("scope/a", "k", 1)));
    expect(gantt.orders("scope/nope")).toEqual([]);
  });

  it("keeps scopes independent", () => {
    const { gantt, faults } = boot(
      plug("test.a", (ctx) => {
        ctx.claimOrder("scope/a", "same-key", 10);
        ctx.claimOrder("scope/b", "same-key", 10);
      }),
    );
    expect(faults).toEqual([]);
    expect(gantt.orders("scope/a")).toHaveLength(1);
    expect(gantt.orders("scope/b")).toHaveLength(1);
  });

  it("returns a snapshot, not a live view", () => {
    let later: PluginContext | undefined;
    const { gantt } = boot(
      plug("test.a", (ctx) => {
        later = ctx;
        ctx.claimOrder("scope/a", "first", 10);
      }),
    );
    const snapshot = gantt.orders("scope/a");
    later!.claimOrder("scope/a", "second", 20);
    expect(snapshot).toHaveLength(1);
    expect(gantt.orders("scope/a")).toHaveLength(2);
  });
});

describe("claimOrder: collisions (§1.2)", () => {
  it("reports a duplicate (scope, order) against the later claimant and drops the claim", () => {
    const { gantt, faults } = boot(
      plug("test.a", (ctx) => ctx.claimOrder("renderer/layers", "a:bars", 60)),
      plug("test.b", (ctx) => ctx.claimOrder("renderer/layers", "b:bars", 60)),
    );
    expect(faults).toHaveLength(1);
    expect(faults[0]!.pluginId).toBe("test.b");
    expect(faults[0]!.level).toBeUndefined();
    expect(messageOf(faults[0]!.error)).toContain("60");
    expect(gantt.orders("renderer/layers")).toEqual([
      { key: "a:bars", order: 60, pluginId: "test.a" },
    ]);
  });

  it("reports a duplicate (scope, key) even at a different order", () => {
    const { gantt, faults } = boot(
      plug("test.a", (ctx) => ctx.claimOrder("renderer/layers", "shared", 10)),
      plug("test.b", (ctx) => ctx.claimOrder("renderer/layers", "shared", 20)),
    );
    expect(faults).toHaveLength(1);
    expect(faults[0]!.pluginId).toBe("test.b");
    expect(messageOf(faults[0]!.error)).toContain("shared");
    expect(gantt.orders("renderer/layers")).toEqual([
      { key: "shared", order: 10, pluginId: "test.a" },
    ]);
  });

  it("accepts several fresh (key, order) pairs from the same plugin in one scope", () => {
    const { gantt, faults } = boot(
      plug("test.a", (ctx) => {
        ctx.claimOrder("renderer/layers", "a:grid", 10);
        ctx.claimOrder("renderer/layers", "a:bars", 20);
        ctx.claimOrder("renderer/layers", "a:links", 30);
      }),
    );
    expect(faults).toEqual([]);
    expect(gantt.orders("renderer/layers")).toHaveLength(3);
  });
});

describe("claimKey (§1.2)", () => {
  it("records the first claim of a (bag, key) pair silently", () => {
    const { faults } = boot(plug("test.a", (ctx) => ctx.claimKey("task.meta", "taskFields")));
    expect(faults).toEqual([]);
  });

  it("keeps bags independent", () => {
    const { faults } = boot(
      plug("test.a", (ctx) => {
        ctx.claimKey("task.meta", "shared");
        ctx.claimKey("row.meta", "shared");
      }),
    );
    expect(faults).toEqual([]);
  });

  it("reports a duplicate (bag, key) against the later claimant", () => {
    const { faults } = boot(
      plug("test.a", (ctx) => ctx.claimKey("task.meta", "taskFields")),
      plug("test.b", (ctx) => ctx.claimKey("task.meta", "taskFields")),
    );
    expect(faults).toHaveLength(1);
    expect(faults[0]!.pluginId).toBe("test.b");
    expect(faults[0]!.level).toBeUndefined();
    expect(messageOf(faults[0]!.error)).toContain("taskFields");
  });

  it("reports a plugin that claims the same (bag, key) twice", () => {
    const { faults } = boot(
      plug("test.a", (ctx) => {
        ctx.claimKey("task.meta", "taskFields");
        ctx.claimKey("task.meta", "taskFields");
      }),
    );
    expect(faults).toHaveLength(1);
    expect(faults[0]!.pluginId).toBe("test.a");
  });
});

describe("claimSlot (§1.2)", () => {
  const CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;

  it("grants a free slot", () => {
    let grant: SlotGrant | undefined;
    const { faults } = boot(
      plug("test.a", (ctx) => {
        grant = ctx.claimSlot("overlay-corner", "top-right", CORNERS);
      }),
    );
    expect(faults).toEqual([]);
    expect(grant).toEqual({ granted: true });
  });

  it("refuses an occupied slot and proposes the lexicographically smallest free known slot", () => {
    let grant: SlotGrant | undefined;
    const { faults } = boot(
      plug("test.a", (ctx) => void ctx.claimSlot("overlay-corner", "top-right", CORNERS)),
      plug("test.b", (ctx) => {
        grant = ctx.claimSlot("overlay-corner", "top-right", CORNERS);
      }),
    );
    expect(grant).toEqual({ granted: false, alternative: "bottom-left" });
    expect(faults).toHaveLength(1);
    expect(faults[0]!.pluginId).toBe("test.b");
    expect(faults[0]!.level).toBe("warning");
    expect(messageOf(faults[0]!.error)).toContain("top-right");
  });

  it("leaves occupancy with the first claimant", () => {
    let second: SlotGrant | undefined;
    let third: SlotGrant | undefined;
    boot(
      plug("test.a", (ctx) => void ctx.claimSlot("overlay-corner", "top-right", CORNERS)),
      plug("test.b", (ctx) => {
        second = ctx.claimSlot("overlay-corner", "top-right", CORNERS);
      }),
      plug("test.c", (ctx) => {
        third = ctx.claimSlot("overlay-corner", "bottom-left", CORNERS);
      }),
    );
    expect(second!.granted).toBe(false);
    expect(third).toEqual({ granted: true });
  });

  it("unions claimed, requested and candidate names across every call in the group", () => {
    let grant: SlotGrant | undefined;
    boot(
      plug("test.a", (ctx) => void ctx.claimSlot("g", "one", ["one", "zeta"])),
      plug("test.b", (ctx) => void ctx.claimSlot("g", "two", ["mid"])),
      plug("test.c", (ctx) => {
        grant = ctx.claimSlot("g", "one");
      }),
    );
    // known = {one, zeta} u {two, mid}; occupied = {one, two}; smallest free = "mid".
    expect(grant).toEqual({ granted: false, alternative: "mid" });
  });

  it("remembers candidate names from an earlier call in the same group", () => {
    let grant: SlotGrant | undefined;
    boot(
      plug("test.a", (ctx) => void ctx.claimSlot("overlay-corner", "top-right", CORNERS)),
      plug("test.b", (ctx) => {
        grant = ctx.claimSlot("overlay-corner", "top-right");
      }),
    );
    expect(grant).toEqual({ granted: false, alternative: "bottom-left" });
  });

  it("keeps groups independent", () => {
    let grant: SlotGrant | undefined;
    const { faults } = boot(
      plug("test.a", (ctx) => void ctx.claimSlot("group/a", "slot", CORNERS)),
      plug("test.b", (ctx) => {
        grant = ctx.claimSlot("group/b", "slot", CORNERS);
      }),
    );
    expect(faults).toEqual([]);
    expect(grant).toEqual({ granted: true });
  });

  it("omits alternative when every known slot is occupied", () => {
    let grant: SlotGrant | undefined;
    boot(
      plug("test.a", (ctx) => {
        ctx.claimSlot("pair", "left");
        ctx.claimSlot("pair", "right");
      }),
      plug("test.b", (ctx) => {
        grant = ctx.claimSlot("pair", "left");
      }),
    );
    expect(grant).toEqual({ granted: false });
    expect("alternative" in grant!).toBe(false);
  });

  it("orders candidates by UTF-16 code units, so uppercase sorts before lowercase", () => {
    let grant: SlotGrant | undefined;
    boot(
      plug("test.a", (ctx) => void ctx.claimSlot("g", "taken", ["alpha", "Zulu"])),
      plug("test.b", (ctx) => {
        grant = ctx.claimSlot("g", "taken");
      }),
    );
    expect(grant).toEqual({ granted: false, alternative: "Zulu" });
  });
});

describe("arbitration and disposal", () => {
  it("orders(scope) is empty after dispose()", () => {
    const { gantt } = boot(plug("test.a", (ctx) => ctx.claimOrder("scope/a", "k", 1)));
    expect(gantt.orders("scope/a")).toHaveLength(1);
    gantt.dispose();
    expect(gantt.orders("scope/a")).toEqual([]);
  });
});
