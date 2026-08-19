/**
 * docs/specs/plugins/data-store.md — Store snapshot semantics / Notification order per apply /
 * Apply flow (the bulk-path variant).
 *
 * `DataService` publishes four per-entity `Store` properties (`tasks`, `links`, `resources`,
 * `assignments`). This file is the dedicated suite for that mechanism: one
 * transaction apply is one synchronous burst of `set()` calls — the domains a patch list actually
 * touched, in `links → resources → assignments` order, then `tasks` always last, even when no
 * task entry itself changed — and a command whose patch list is empty (the uniform
 * unusable-argument no-op) produces no burst at all.
 */
import { definePlugin } from "@stargantt/core";
import type { AnyPlugin, GanttInstance } from "@stargantt/core";
import { afterEach, describe, expect, it } from "vitest";
import type { DataService } from "../src/types";
import { createGantt, dataOf } from "./_helpers";

let gantt: GanttInstance | undefined;

afterEach(() => {
  gantt?.dispose();
  gantt = undefined;
});

/** Every store publish, in firing order, as its domain name. */
function watch(data: DataService): { log: string[] } {
  const log: string[] = [];
  data.links.subscribe(() => log.push("links"));
  data.resources.subscribe(() => log.push("resources"));
  data.assignments.subscribe(() => log.push("assignments"));
  data.tasks.subscribe(() => log.push("tasks"));
  return { log };
}

function boot(): { gantt: GanttInstance; data: DataService } {
  const g = createGantt();
  gantt = g;
  return { gantt: g, data: dataOf(g) };
}

describe("transaction burst order", () => {
  it("publishes only `tasks` for a task-only change", () => {
    const { gantt: g, data } = boot();
    data.load([{ id: "a", name: "A", start: 0, end: 10 }]);
    const { log } = watch(data);

    g.dispatch("task/move", { id: "a", start: 5, end: 15 });

    expect(log).toEqual(["tasks"]);
  });

  it("publishes `links` before `tasks` for a link change", () => {
    const { gantt: g, data } = boot();
    data.load([
      { id: "a", name: "A", start: 0, end: 10 },
      { id: "b", name: "B", start: 0, end: 10 },
    ]);
    const { log } = watch(data);

    g.dispatch("link/add", { sourceId: "a", targetId: "b", type: "FS" });

    expect(log).toEqual(["links", "tasks"]);
  });

  it("publishes `resources` before `tasks`, and never `links`/`assignments`, for a resource-only change", () => {
    const { gantt: g, data } = boot();
    data.load([{ id: "a", name: "A", start: 0, end: 10 }]);
    const { log } = watch(data);

    g.dispatch("resource/add", { resource: { name: "Ada" } });

    expect(log).toEqual(["resources", "tasks"]);
  });

  it("publishes `assignments` before `tasks` for an assignment change", () => {
    const { gantt: g, data } = boot();
    data.load([{ id: "a", name: "A", start: 0, end: 10 }]);
    g.dispatch("resource/add", { resource: { id: "r1", name: "Ada" } });
    const { log } = watch(data);

    g.dispatch("assignment/set", { taskId: "a", resourceId: "r1", units: 1 });

    expect(log).toEqual(["assignments", "tasks"]);
  });

  it("orders a task/remove cascade's touched domains (links, assignments), tasks last", () => {
    const { gantt: g, data } = boot();
    data.load([
      { id: "a", name: "A", start: 0, end: 10 },
      { id: "b", name: "B", start: 0, end: 10 },
    ]);
    g.dispatch("link/add", { sourceId: "a", targetId: "b", type: "FS" });
    g.dispatch("resource/add", { resource: { id: "r1", name: "Ada" } });
    g.dispatch("assignment/set", { taskId: "a", resourceId: "r1", units: 1 });
    const { log } = watch(data);

    // Removing "a" cascades, in one transaction, over its link and its assignment — no resource
    // is touched, so `resources` never fires.
    g.dispatch("task/remove", { ids: ["a"] });

    expect(log).toEqual(["links", "assignments", "tasks"]);
  });

  it("orders all three domains within one transaction, when all three are touched at once", () => {
    const { gantt: g, data } = boot();
    data.load([
      { id: "a", name: "A", start: 0, end: 10 },
      { id: "b", name: "B", start: 0, end: 10 },
    ]);
    const { log } = watch(data);

    // `history/apply` replays an already-built patch list as one transaction, exactly as given —
    // the batch-replay channel this suite uses to exercise a change no single command produces.
    g.dispatch("history/apply", {
      patches: [
        { op: "link/add", link: { id: "l1", sourceId: "a", targetId: "b", type: "FS" } },
        { op: "resource/add", resource: { id: "r1", name: "Ada" } },
        { op: "assignment/add", assignment: { taskId: "a", resourceId: "r1", units: 1 } },
      ],
    });

    expect(log).toEqual(["links", "resources", "assignments", "tasks"]);
  });

  it("`tasks` fires even when the change touched no task entry (resource-only)", () => {
    const { gantt: g, data } = boot();
    data.load([{ id: "a", name: "A", start: 0, end: 10 }]);
    const before = data.tasks.get();
    const { log } = watch(data);

    g.dispatch("resource/add", { resource: { name: "Ada" } });

    expect(log).toEqual(["resources", "tasks"]);
    // No equality gating anywhere in the chain: a fresh (but content-identical) map is published.
    const after = data.tasks.get();
    expect(after).not.toBe(before);
    expect([...after.keys()]).toEqual([...before.keys()]);
  });

  it("produces no burst at all for a command whose patch list is empty", () => {
    const { gantt: g, data } = boot();
    data.load([{ id: "a", name: "A", start: 0, end: 10 }]);
    const { log } = watch(data);

    g.dispatch("task/move", { id: "missing-task", start: 0, end: 1 });
    g.dispatch("link/remove", { ids: ["missing-link"] });
    g.dispatch("resource/remove", { ids: ["missing-resource"] });
    g.dispatch("assignment/remove", { taskId: "missing-task", resourceId: "missing-resource" });

    expect(log).toEqual([]);
  });

  it("produces no burst when the will-event cancels the transaction", () => {
    const { gantt: g, data } = boot();
    data.load([{ id: "a", name: "A", start: 0, end: 10 }]);
    g.on("data/willApplyTransaction", (e) => e.preventDefault());
    const { log } = watch(data);

    g.dispatch("task/move", { id: "a", start: 5, end: 15 });

    expect(log).toEqual([]);
  });
});

describe("bulk-path bursts (load / materializeChildren)", () => {
  it("load() publishes only the domains it actually loaded, tasks always last", () => {
    const { data } = boot();
    const { log } = watch(data);

    data.load({
      tasks: [{ id: "a", name: "A", start: 0, end: 10 }],
      resources: [{ id: "r1", name: "Ada" }],
      assignments: [{ taskId: "a", resourceId: "r1", units: 1 }],
    });

    expect(log).toEqual(["resources", "assignments", "tasks"]);
  });

  it("load() with tasks only publishes exactly `tasks`", () => {
    const { data } = boot();
    const { log } = watch(data);

    data.load([{ id: "a", name: "A", start: 0, end: 10 }]);

    expect(log).toEqual(["tasks"]);
  });

  it("load() publishes `tasks` even on an empty load — the unconditional bootstrap signal", () => {
    const { data } = boot();
    const { log } = watch(data);

    data.load([]);

    expect(log).toEqual(["tasks"]);
  });

  it("materializeChildren() that builds rows publishes exactly `tasks`", () => {
    const { data } = boot();
    data.load({
      tasks: [{ id: "p", name: "P", start: 0, end: 10 }],
      deferredTasks: [{ parentId: "p", rows: [{ id: "c", name: "C", start: 0, end: 1 }] }],
    });
    const { log } = watch(data);

    data.materializeChildren("p");

    expect(log).toEqual(["tasks"]);
  });

  it("materializeChildren() that materializes nothing sets no store at all", () => {
    const { data } = boot();
    data.load([{ id: "p", name: "P", start: 0, end: 10 }]);
    const { log } = watch(data);

    // No bucket pending for "p" at all.
    data.materializeChildren("p");
    expect(log).toEqual([]);

    // Names no stored task.
    data.materializeChildren("does-not-exist");
    expect(log).toEqual([]);
  });

  it("a bucket whose parent does not exist yet materializes nothing", () => {
    const { data } = boot();
    data.load({
      tasks: [{ id: "p", name: "P", start: 0, end: 10 }],
      deferredTasks: [
        { parentId: "p", rows: [{ id: "c1", name: "C1", start: 0, end: 1 }] },
        { parentId: "c1", rows: [{ id: "g1", name: "G1", start: 0, end: 1 }] },
      ],
    });
    const { log } = watch(data);

    // "c1" is itself still deferred — its bucket cannot build until "c1" is materialized first.
    data.materializeChildren("c1");

    expect(log).toEqual([]);
    expect(data.getTask("g1")).toBeUndefined();
  });
});

describe("store snapshot identity", () => {
  it("`get()` and `query().byId` observe the same committed state, at all times", () => {
    const { gantt: g, data } = boot();
    data.load([{ id: "a", name: "A", start: 0, end: 10 }]);
    g.dispatch("task/move", { id: "a", start: 5, end: 15 });

    expect(data.tasks.get().get("a")).toBe(data.query().byId.get("a"));
    expect(data.tasks.get().get("a")).toBe(data.getTask("a"));
  });

  it("assignments are grouped by task, task-insertion order — the `assignmentsByTask` shape", () => {
    const { gantt: g, data } = boot();
    data.load([
      { id: "a", name: "A", start: 0, end: 10 },
      { id: "b", name: "B", start: 0, end: 10 },
    ]);
    g.dispatch("resource/add", { resource: { id: "r1", name: "Ada" } });
    g.dispatch("assignment/set", { taskId: "b", resourceId: "r1", units: 1 });
    g.dispatch("assignment/set", { taskId: "a", resourceId: "r1", units: 0.5 });

    expect([...data.assignments.get().keys()]).toEqual(["b", "a"]);
    expect(data.assignments.get().get("a")).toEqual([{ taskId: "a", resourceId: "r1", units: 0.5 }]);
  });
});

// docs/specs/architecture.md — Store semantics, rule 2 (re-entrant `set()` always throws) and
// rule 3 (a thrown subscriber exception is contained: the dispatch that triggered it continues
// and returns normally, and — for a subscription owned by a plugin via `ctx.own()` — the error is
// reported as `core/pluginError` attributed to that plugin, through the host's fault barrier).
// This plugin knows no Gantt concept of its own; the mechanism it regresses belongs to the core,
// but a `tasks` subscriber dispatching a mutating command is the paradigm case the data-store spec
// warns about ("Re-entrancy consequence" — mutations triggered by data changes must be deferred),
// so the regression lives with the store this plugin publishes.
describe("re-entrant store set() from inside a tasks subscription", () => {
  it("is contained and reported as core/pluginError, without the outer dispatch throwing", () => {
    const REENTRANT_PLUGIN_ID = "test.reentrant-subscriber";
    const reentrant: AnyPlugin = definePlugin({
      meta: { id: REENTRANT_PLUGIN_ID, dependsOn: ["stargantt.data-store"] },
      setup(ctx) {
        const data = ctx.use("stargantt.data");
        ctx.own(
          data.tasks.subscribe(() => {
            // The `tasks` store is still notifying (this very callback) when this fires — a
            // second `set()` on the same store is re-entrant and always throws.
            ctx.dispatch("task/move", { id: "a", start: 999, end: 1000 });
          }),
        );
      },
    });

    const g = createGantt([reentrant]);
    gantt = g;
    const data = dataOf(g);
    data.load([{ id: "a", name: "A", start: 0, end: 10 }]);

    const errors: { pluginId: string; error: unknown }[] = [];
    g.on("core/pluginError", (e) => errors.push({ pluginId: e.pluginId, error: e.error }));

    // The re-entrant throw is contained inside the subscriber; it must never reach the caller of
    // the outer `dispatch()`.
    expect(() => g.dispatch("task/move", { id: "a", start: 5, end: 15 })).not.toThrow();

    expect(errors).toHaveLength(1);
    // The throw happens while the *inner* `task/move` command's own runner is executing (inside
    // `dataStore`'s `run()`, mid-`publishChanges`), so the innermost fault boundary to see it is
    // the CommandBus's own barrier around command-runner invocation — it attributes the fault to
    // whichever plugin registered "task/move" (data-store), the same containment `ctx.dispatch()`
    // gives any command runner that throws, regardless of who called it. The error therefore never
    // reaches the *outer* `tasks` store's own subscriber-fault reporting at all: the inner
    // `ctx.dispatch()` call the subscriber made returns normally (its exception already reported),
    // so the outer store's `sub.fn()` call the subscriber runs inside likewise returns normally.
    expect(errors[0]?.pluginId).toBe("stargantt.data-store");
    expect(errors[0]?.error).toBeInstanceOf(Error);
    expect((errors[0]?.error as Error).message).toBe(
      "stargantt: re-entrant store set() during notification",
    );
  });
});
