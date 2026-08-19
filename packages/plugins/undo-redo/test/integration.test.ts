import type { GanttInstance } from "@stargantt/core";
import { afterEach, describe, expect, it } from "vitest";
import type { Harness } from "./_helpers";
import {
  allAssignments,
  allLinks,
  allResources,
  cancelerPlugin,
  makeTask,
  snapshot,
  start,
  updatePatch,
} from "./_helpers";

let open: GanttInstance | undefined;

afterEach(() => {
  open?.dispose();
  open = undefined;
});

function harness(limit?: number): Harness {
  const h = start(limit === undefined ? undefined : { limit });
  open = h.gantt;
  return h;
}

describe("history capture — docs/specs/plugins/undo-redo.md Recording", () => {
  it("records one entry per applied transaction", () => {
    const { gantt, history } = harness();
    expect(history.state.get().canUndo).toBe(false);
    gantt.dispatch("task/add", { task: { id: "a", name: "A", start: 0, end: 10 } });
    expect(history.state.get().canUndo).toBe(true);
  });

  it("does not record `load()`, which is a bootstrap and not a command", () => {
    const { data, history } = harness();
    data.load([makeTask("a"), makeTask("b")]);
    expect(history.state.get().canUndo).toBe(false);
  });

  it("does not record a command that produced no patches", () => {
    const { gantt, history } = harness();
    gantt.dispatch("task/move", { id: "missing", start: 0, end: 1 });
    expect(history.state.get().canUndo).toBe(false);
  });

  it("captures patches appended by `will` handlers into the same entry", () => {
    const { gantt, data, history } = harness();
    data.load([makeTask("a"), makeTask("b")]);

    // Stand-in for auto-schedule: append a follow-on patch during the will phase.
    const off = gantt.on("data/willApplyTransaction", (e) => {
      if (e.transaction.patches.some((p) => p.op === "task/update" && p.id === "b")) return;
      e.transaction.patches.push({
        op: "task/update",
        id: "b",
        before: { start: 0, end: 10 },
        after: { start: 100, end: 110 },
      });
    });

    gantt.dispatch("task/move", { id: "a", start: 50, end: 60 });
    off.dispose();

    expect(data.getTask("a")?.start).toBe(50);
    expect(data.getTask("b")?.start).toBe(100);

    // One undo reverts the user action *and* its automatic follow-on together.
    history.undo();
    expect(data.getTask("a")?.start).toBe(0);
    expect(data.getTask("b")?.start).toBe(0);
    expect(history.state.get().canUndo).toBe(false);
  });

  it("does not record a canceled transaction", () => {
    const { gantt, data, history } = harness();
    data.load([makeTask("a")]);
    const off = gantt.on("data/willApplyTransaction", (e) => {
      e.preventDefault();
    });
    gantt.dispatch("task/move", { id: "a", start: 50, end: 60 });
    off.dispose();
    expect(data.getTask("a")?.start).toBe(0);
    expect(history.state.get().canUndo).toBe(false);
  });
});

describe("undo / redo over reversible patches", () => {
  it("reverts and replays a task move", () => {
    const { gantt, data, history } = harness();
    data.load([makeTask("a")]);
    const before = snapshot(data);

    gantt.dispatch("task/move", { id: "a", start: 50, end: 60 });
    const after = snapshot(data);
    expect(after).not.toBe(before);

    history.undo();
    expect(snapshot(data)).toBe(before);
    expect(history.state.get().canUndo).toBe(false);
    expect(history.state.get().canRedo).toBe(true);

    history.redo();
    expect(snapshot(data)).toBe(after);
    expect(history.state.get().canUndo).toBe(true);
    expect(history.state.get().canRedo).toBe(false);
  });

  // docs/specs/plugins/data-store.md "Field deletion — clears" — undo of a `task/setProgress` that
  // introduced the field from unset must restore it to fully absent, not merely "unchanged from
  // empty".
  it("round-trips: undoing the first setProgress on a task restores `progress` to absent", () => {
    const { gantt, data, history } = harness();
    data.load([makeTask("a")]);
    expect(data.getTask("a")?.progress).toBeUndefined();

    gantt.dispatch("task/setProgress", { id: "a", progress: 0.4 });
    expect(data.getTask("a")?.progress).toBe(0.4);

    history.undo();
    expect(data.getTask("a")?.progress).toBeUndefined();
    expect("progress" in data.getTask("a")!).toBe(false);

    history.redo();
    expect(data.getTask("a")?.progress).toBe(0.4);

    history.undo();
    expect("progress" in data.getTask("a")!).toBe(false);
  });

  it("reverts a task/add by removing the task under its own id", () => {
    const { gantt, data, history } = harness();
    gantt.dispatch("task/add", { task: { id: "a", name: "A", start: 0, end: 10 } });
    expect(data.getTask("a")).toBeDefined();

    history.undo();
    expect(data.getTask("a")).toBeUndefined();

    history.redo();
    expect(data.getTask("a")?.name).toBe("A");
  });

  it("restores a removed task with its original id, parent and order", () => {
    const { gantt, data, history } = harness();
    data.load([makeTask("p"), makeTask("c1", { parentId: "p" }), makeTask("c2", { parentId: "p" })]);
    const before = snapshot(data);

    gantt.dispatch("task/remove", { ids: ["p"] });
    expect(data.toJSON().tasks).toHaveLength(0);

    history.undo();
    expect(snapshot(data)).toBe(before);
    expect(data.query().children.get("p")).toEqual(["c1", "c2"]);
  });

  it("undoes a multi-step history in reverse order", () => {
    const { gantt, data, history } = harness();
    data.load([makeTask("a")]);
    gantt.dispatch("task/move", { id: "a", start: 10, end: 20 });
    gantt.dispatch("task/move", { id: "a", start: 30, end: 40 });

    history.undo();
    expect(data.getTask("a")?.start).toBe(10);
    history.undo();
    expect(data.getTask("a")?.start).toBe(0);
    expect(history.state.get().canUndo).toBe(false);

    history.redo();
    expect(data.getTask("a")?.start).toBe(10);
    history.redo();
    expect(data.getTask("a")?.start).toBe(30);
  });

  it("replay is not recorded as new history", () => {
    const { gantt, data, history } = harness();
    data.load([makeTask("a")]);
    gantt.dispatch("task/move", { id: "a", start: 10, end: 20 });

    history.undo();
    history.redo();
    history.undo();
    expect(data.getTask("a")?.start).toBe(0);
    expect(history.state.get().canUndo).toBe(false);
  });

  it("records a foreign transaction dispatched synchronously during a replay", () => {
    const { gantt, data, history } = harness();
    data.load([makeTask("a"), makeTask("b")]);
    gantt.dispatch("task/move", { id: "a", start: 10, end: 20 });

    // A plugin reacting to the replay with a fresh user-origin command of its own: that
    // transaction is new history, not part of the replay, and must be recorded. Triggered from
    // the will-event (not a `data.tasks` store subscription): the outer replay's own `tasks`
    // burst has not fired yet at this point (docs/specs/plugins/data-store.md "Apply flow" runs
    // the will-event strictly before the atomic apply and the burst), so the nested dispatch's
    // own `tasks.set()` does not re-enter the store the outer replay will use
    // (docs/specs/architecture.md §1.1-2 — re-entrant `set()` always throws).
    let reacted = false;
    const offWill = gantt.on("data/willApplyTransaction", (e) => {
      if (reacted || e.transaction.origin !== "history") return;
      reacted = true;
      gantt.dispatch("task/move", { id: "b", start: 50, end: 60 });
    });

    history.undo();
    offWill.dispose();

    expect(reacted).toBe(true);
    expect(data.getTask("a")?.start).toBe(0);
    expect(data.getTask("b")?.start).toBe(50);
    // The foreign move is on the stack: one undo takes b back.
    expect(history.state.get().canUndo).toBe(true);
    history.undo();
    expect(data.getTask("b")?.start).toBe(0);
  });

  it("a new action after an undo clears the redo stack", () => {
    const { gantt, data, history } = harness();
    data.load([makeTask("a")]);
    gantt.dispatch("task/move", { id: "a", start: 10, end: 20 });
    history.undo();
    expect(history.state.get().canRedo).toBe(true);

    gantt.dispatch("task/move", { id: "a", start: 99, end: 100 });
    expect(history.state.get().canRedo).toBe(false);
  });

  it("undo / redo on an empty stack are no-ops", () => {
    const { data, history } = harness();
    data.load([makeTask("a")]);
    const before = snapshot(data);
    history.undo();
    history.redo();
    expect(snapshot(data)).toBe(before);
  });

  it("clear() drops the history without touching the data", () => {
    const { gantt, data, history } = harness();
    data.load([makeTask("a")]);
    gantt.dispatch("task/move", { id: "a", start: 10, end: 20 });
    history.clear();
    expect(history.state.get().canUndo).toBe(false);
    expect(history.state.get().canRedo).toBe(false);
    expect(data.getTask("a")?.start).toBe(10);
  });

  it("honours the configured limit", () => {
    const { gantt, data, history } = harness(2);
    data.load([makeTask("a")]);
    gantt.dispatch("task/move", { id: "a", start: 10, end: 20 });
    gantt.dispatch("task/move", { id: "a", start: 20, end: 30 });
    gantt.dispatch("task/move", { id: "a", start: 30, end: 40 });

    history.undo();
    history.undo();
    expect(history.state.get().canUndo).toBe(false);
    // The oldest entry fell off the stack, so `start` stops at 10, not 0.
    expect(data.getTask("a")?.start).toBe(10);
  });
});

describe("commands", () => {
  it("`history/undo` and `history/redo` drive the service", () => {
    const { gantt, data, history } = harness();
    data.load([makeTask("a")]);
    gantt.dispatch("task/move", { id: "a", start: 10, end: 20 });

    gantt.dispatch("history/undo", undefined);
    expect(data.getTask("a")?.start).toBe(0);
    expect(history.state.get().canRedo).toBe(true);

    gantt.dispatch("history/redo", undefined);
    expect(data.getTask("a")?.start).toBe(10);
  });
});

describe("teardown", () => {
  it("dispose() resets the history (observed live, not through the now-stale store)", () => {
    // `history.reset()` — the teardown path — deliberately does not publish `state` (see the
    // dedicated "does not set the history store again" test below): the composition is
    // half-torn-down by dispose time, so `state.get()` legitimately keeps its last live value.
    // `peekUndo()`/`undoLabels()` read the underlying stacks directly, live, so they are what
    // proves the reset actually happened.
    const h = harness();
    h.data.load([makeTask("a")]);
    h.gantt.dispatch("task/move", { id: "a", start: 10, end: 20 });
    expect(h.history.peekUndo()).toBeDefined();

    h.gantt.dispose();
    open = undefined;
    expect(h.history.peekUndo()).toBeUndefined();
    expect(h.history.undoLabels()).toEqual([]);
  });

  it("dispose() does not set the history store again", () => {
    const h = harness();
    h.data.load([makeTask("a")]);
    h.gantt.dispatch("task/move", { id: "a", start: 10, end: 20 });

    let calls = 0;
    const off = h.history.state.subscribe(() => {
      calls++;
    });
    h.gantt.dispose();
    off.dispose();
    open = undefined;
    expect(calls).toBe(0);
  });
});

describe("what never becomes a history entry", () => {
  it("does not record a cancelled transaction when a later load happens to fire", () => {
    const { gantt, data, history } = harness();
    data.load([makeTask("a")]);

    const off = gantt.on("data/willApplyTransaction", (e) => {
      e.preventDefault();
    });
    gantt.dispatch("task/move", { id: "a", start: 50, end: 60 });
    off.dispose();
    expect(history.state.get().canUndo).toBe(false);

    // The bootstrap path announces changes without a transaction; a rejected action must not be
    // able to ride in on it.
    data.load([makeTask("a")]);
    expect(history.state.get().canUndo).toBe(false);
  });

  it("does not record a duplicate-id task/add", () => {
    const { gantt, data, history } = harness();
    data.load([makeTask("a")]);

    // Adding a task under an id that already exists builds an empty patch list
    // (docs/specs/plugins/data-store.md — the uniform unusable-argument no-op), so the command
    // creates no transaction at all: no will-event fires, nothing is ever remembered.
    gantt.dispatch("task/add", { task: { id: "a", name: "duplicate" } });
    expect(history.state.get().canUndo).toBe(false);

    data.load([makeTask("a")]);
    expect(history.state.get().canUndo).toBe(false);
  });

  // Recording consumes only `data/didApplyTransaction`, the settle signal that
  // never fires for a transaction whose atomic apply throws — a genuine throwing apply, as
  // opposed to the uniform no-op above (which never reaches the store at all).
  it("does not record a transaction whose atomic apply throws, even across a later load()", () => {
    const { gantt, data, history } = harness();
    data.load([makeTask("a")]);

    // A raw `task/add` patch appended in the will phase bypasses `task/add`'s own duplicate-id
    // guard and reaches the store directly, which throws.
    const off = gantt.on("data/willApplyTransaction", (e) => {
      e.transaction.patches.push({
        op: "task/add",
        task: { id: "a", parentId: null, name: "dup", start: 0, end: 1 },
      });
    });
    gantt.dispatch("task/move", { id: "a", start: 50, end: 60 });
    off.dispose();

    // The whole transaction — the leading task/move patch included — is atomic: the throw aborts
    // it before anything commits.
    expect(data.getTask("a")?.start).toBe(0);
    expect(history.state.get().depth).toBe(0);

    data.load([makeTask("a")]);
    expect(history.state.get().depth).toBe(0);
  });

  // A handler that cancels the transaction, registered *before* undo-redo is even
  // composed, is indistinguishable from one registered after — recording never listens to
  // `data/willApplyTransaction` at all, so registration order relative to undo-redo cannot matter.
  it("does not record a transaction cancelled by a handler registered before undo-redo, even across a later load()", () => {
    const { gantt, data, history } = start(undefined, [], [cancelerPlugin()]);
    open = gantt;

    data.load([makeTask("a")]);
    gantt.dispatch("task/move", { id: "a", start: 50, end: 60 });
    expect(data.getTask("a")?.start).toBe(0);
    expect(history.state.get().depth).toBe(0);

    data.load([makeTask("a")]);
    expect(history.state.get().depth).toBe(0);
  });

  // Nested dispatches settle inner-first (docs/specs/plugins/data-store.md "Apply flow"), so the
  // outer transaction — the one the will-handler was reacting to — is recorded *after* the inner
  // one it triggered, and is therefore undone first.
  it("records a nested dispatch from a will-handler as its own entry, undoing the outer transaction first", () => {
    const { gantt, data, history } = harness();
    data.load([makeTask("a"), makeTask("b")]);

    let nested = false;
    const off = gantt.on("data/willApplyTransaction", (e) => {
      if (nested || e.transaction.label !== "Move task") return;
      nested = true;
      gantt.dispatch("task/setProgress", { id: "b", progress: 0.5 });
    });
    gantt.dispatch("task/move", { id: "a", start: 10, end: 20 });
    off.dispose();

    expect(history.state.get().depth).toBe(2);
    history.undo();
    expect(data.getTask("a")?.start).toBe(0);
    expect(data.getTask("b")?.progress).toBe(0.5);
    history.undo();
    expect(data.getTask("b")?.progress).toBeUndefined();
  });
});

describe("undo / redo over link patches", () => {
  function seedPair(data: ReturnType<typeof harness>["data"]): void {
    data.load([makeTask("a"), makeTask("b")]);
  }

  it("reverts a link/add by deleting the link it created", () => {
    const { gantt, data, history } = harness();
    seedPair(data);
    const before = snapshot(data);

    gantt.dispatch("link/add", { sourceId: "a", targetId: "b", type: "FS", lag: 250 });
    expect(allLinks(data)).toHaveLength(1);

    history.undo();
    expect(allLinks(data)).toEqual([]);
    expect(snapshot(data)).toBe(before);
  });

  it("replays a link/add under the same identity, so undo stays available", () => {
    const { gantt, data, history } = harness();
    seedPair(data);
    gantt.dispatch("link/add", { sourceId: "a", targetId: "b", type: "SS", lag: 250 });
    const added = snapshot(data);

    history.undo();
    history.redo();
    expect(snapshot(data)).toBe(added);

    history.undo();
    expect(allLinks(data)).toEqual([]);
  });

  // docs/specs/plugins/data-store.md — a retype / re-lag is one `link/update` transaction, so it
  // is exactly one undo step and both sides replay through the same command.
  it("takes a link retype and re-lag back in one step, and replays it", () => {
    const { gantt, data, history } = harness();
    seedPair(data);
    gantt.dispatch("link/add", { sourceId: "a", targetId: "b", type: "FS", lag: 250 });
    const before = snapshot(data);

    gantt.dispatch("link/update", { id: allLinks(data)[0]?.id ?? "", type: "SS", lag: 500 });
    const updated = snapshot(data);
    expect(allLinks(data)[0]).toMatchObject({ type: "SS", lag: 500 });

    history.undo();
    expect(snapshot(data)).toBe(before);
    expect(allLinks(data)[0]).toMatchObject({ type: "FS", lag: 250 });

    history.redo();
    expect(snapshot(data)).toBe(updated);
  });

  it("restores a link that had no lag rather than leaving the lag it gained", () => {
    const { gantt, data, history } = harness();
    seedPair(data);
    gantt.dispatch("link/add", { sourceId: "a", targetId: "b", type: "FS" });
    const before = snapshot(data);

    gantt.dispatch("link/update", { id: allLinks(data)[0]?.id ?? "", lag: 1000 });
    history.undo();

    expect(allLinks(data)[0]?.lag).toBeUndefined();
    expect(snapshot(data)).toBe(before);
  });

  it("restores the links a removed subtree took with it", () => {
    const { gantt, data, history } = harness();
    data.load([makeTask("p"), makeTask("c", { parentId: "p" }), makeTask("other")]);
    gantt.dispatch("link/add", { sourceId: "c", targetId: "other", type: "FS" });
    const before = snapshot(data);

    gantt.dispatch("task/remove", { ids: ["p"] });
    expect(allLinks(data)).toEqual([]);

    history.undo();
    expect(snapshot(data)).toBe(before);
    expect(allLinks(data)).toHaveLength(1);
  });

  it("reverts a link/add that a follow-on task move came with, links and dates together", () => {
    const { gantt, data, history } = harness();
    seedPair(data);
    const before = snapshot(data);

    // Stand-in for auto-schedule: a link addition drags its target into place in the same
    // transaction, which is what makes the entry mix link and task patches.
    const off = gantt.on("data/willApplyTransaction", (e) => {
      if (!e.transaction.patches.some((p) => p.op === "link/add")) return;
      e.transaction.patches.push(updatePatch("b", { start: 0, end: 10 }, { start: 10, end: 20 }));
    });
    gantt.dispatch("link/add", { sourceId: "a", targetId: "b", type: "FS" });
    off.dispose();

    expect(data.getTask("b")?.start).toBe(10);
    expect(allLinks(data)).toHaveLength(1);

    history.undo();
    expect(snapshot(data)).toBe(before);
  });
});

describe("undo / redo over resource and assignment patches", () => {
  function seedResources(h: Harness): void {
    h.data.load({
      tasks: [makeTask("a"), makeTask("b")],
      resources: [{ id: "x", name: "Alice", capacity: 2 }],
      assignments: [{ taskId: "a", resourceId: "x", units: 1 }],
    });
  }

  it("round-trips resource/add, resource/update and assignment/set", () => {
    const h = harness();
    const { gantt, data, history } = h;
    seedResources(h);

    gantt.dispatch("resource/add", { resource: { id: "y", name: "Bob" } });
    gantt.dispatch("resource/update", { id: "x", after: { capacity: 3 } });
    gantt.dispatch("assignment/set", { taskId: "b", resourceId: "y", units: 0.5 });
    gantt.dispatch("assignment/set", { taskId: "a", resourceId: "x", units: 0.25 });

    const after = data.toJSON();

    history.undo(); // assignment/update
    expect(allAssignments(data)).toContainEqual({ taskId: "a", resourceId: "x", units: 1 });
    history.undo(); // assignment/add
    expect(data.query().assignmentsByTask.get("b")).toBeUndefined();
    history.undo(); // resource/update
    expect(data.query().resources.get("x")?.capacity).toBe(2);
    history.undo(); // resource/add
    expect(data.query().resources.get("y")).toBeUndefined();

    history.redo();
    history.redo();
    history.redo();
    history.redo();
    expect(data.toJSON()).toEqual(after);
  });

  it("one undo restores a removed resource together with its assignments", () => {
    const h = harness();
    const { gantt, data, history } = h;
    seedResources(h);
    const before = data.toJSON();

    gantt.dispatch("resource/remove", { ids: ["x"] });
    expect(allResources(data)).toEqual([]);
    expect(allAssignments(data)).toEqual([]);

    history.undo();
    expect(data.toJSON()).toEqual(before);

    history.redo();
    expect(allResources(data)).toEqual([]);
    expect(allAssignments(data)).toEqual([]);
  });

  it("one undo restores a removed task together with its assignments", () => {
    const h = harness();
    const { gantt, data, history } = h;
    seedResources(h);
    const before = data.toJSON();

    gantt.dispatch("task/remove", { ids: ["a"] });
    expect(data.getTask("a")).toBeUndefined();
    expect(allAssignments(data)).toEqual([]);

    history.undo();
    // `toJSON().tasks` follows insertion order and the restored task re-enters last, so compare
    // the task list order-insensitively.
    const restored = data.toJSON();
    const byId = (a: { id: unknown }, b: { id: unknown }): number =>
      String(a.id) < String(b.id) ? -1 : 1;
    expect({ ...restored, tasks: [...restored.tasks].sort(byId) }).toEqual({
      ...before,
      tasks: [...before.tasks].sort(byId),
    });
  });
});

// docs/specs/plugins/interaction.md `coalesceKey` merging, driven end to end through
// the command bus.
describe("coalescing by coalesceKey", () => {
  it("merges consecutive task/move commands that share a coalesceKey into one undo step", () => {
    const { gantt, data, history } = harness();
    data.load([makeTask("a", { start: 0, end: 10 })]);

    gantt.dispatch("task/move", { id: "a", start: 10, end: 20, coalesceKey: "drag-1" });
    gantt.dispatch("task/move", { id: "a", start: 20, end: 30, coalesceKey: "drag-1" });
    gantt.dispatch("task/move", { id: "a", start: 30, end: 40, coalesceKey: "drag-1" });

    expect(history.undoLabels()).toHaveLength(1);
    expect(data.getTask("a")?.start).toBe(30);

    // One undo reverts the entire gesture in one step.
    history.undo();
    expect(data.getTask("a")?.start).toBe(0);
    expect(history.state.get().canUndo).toBe(false);
  });

  it("does not merge across a coalesceKey boundary (a new gesture is a new undo step)", () => {
    const { gantt, data, history } = harness();
    data.load([makeTask("a", { start: 0, end: 10 })]);

    gantt.dispatch("task/move", { id: "a", start: 10, end: 20, coalesceKey: "drag-1" });
    gantt.dispatch("task/move", { id: "a", start: 20, end: 30, coalesceKey: "drag-2" });

    expect(history.undoLabels()).toHaveLength(2);

    history.undo();
    expect(data.getTask("a")?.start).toBe(10);
    history.undo();
    expect(data.getTask("a")?.start).toBe(0);
  });

  it("does not merge commands without a coalesceKey", () => {
    const { gantt, data, history } = harness();
    data.load([makeTask("a", { start: 0, end: 10 })]);

    gantt.dispatch("task/move", { id: "a", start: 10, end: 20 });
    gantt.dispatch("task/move", { id: "a", start: 20, end: 30 });

    expect(history.undoLabels()).toHaveLength(2);
  });

  // docs/specs/plugins/data-store.md — `task/update`'s `clears` field-deletion list. Undoing the
  // first `task/setProgress` of a merged run (starting from an unset `progress`) dispatches
  // `task/update` with an explicit `clears: ["progress"]`, so the field is deleted outright
  // instead of the undo being a no-op `after: {}` patch.
  it("also coalesces task/setProgress by coalesceKey", () => {
    const { gantt, data, history } = harness();
    data.load([makeTask("a", { start: 0, end: 10 })]);

    gantt.dispatch("task/setProgress", { id: "a", progress: 0.2, coalesceKey: "drag-p" });
    gantt.dispatch("task/setProgress", { id: "a", progress: 0.5, coalesceKey: "drag-p" });

    expect(history.undoLabels()).toHaveLength(1);
    history.undo();
    // Undo of the merged entry should restore the task to its state before either setProgress
    // call, i.e. progress unset.
    expect(data.getTask("a")?.progress).toBeUndefined();
  });
});

// docs/specs/plugins/undo-redo.md "Service" — the state store and the label read methods.
describe("history.state — store-shaped canUndo/canRedo/depth", () => {
  it("reflects push, undo, redo and clear", () => {
    const { gantt, data, history } = harness();
    data.load([makeTask("a")]);
    expect(history.state.get()).toEqual({ canUndo: false, canRedo: false, depth: 0 });

    gantt.dispatch("task/move", { id: "a", start: 10, end: 20 });
    expect(history.state.get()).toEqual({ canUndo: true, canRedo: false, depth: 1 });

    history.undo();
    expect(history.state.get()).toEqual({ canUndo: false, canRedo: true, depth: 0 });

    history.redo();
    expect(history.state.get()).toEqual({ canUndo: true, canRedo: false, depth: 1 });

    history.clear();
    expect(history.state.get()).toEqual({ canUndo: false, canRedo: false, depth: 0 });
  });

  it("sets the store exactly once per mutation, including a coalescing merge", () => {
    const { gantt, data, history } = harness();
    data.load([makeTask("a")]);
    let calls = 0;
    const off = history.state.subscribe(() => {
      calls++;
    });
    gantt.dispatch("task/move", { id: "a", start: 10, end: 20, coalesceKey: "drag-1" });
    expect(calls).toBe(1);
    gantt.dispatch("task/move", { id: "a", start: 20, end: 30, coalesceKey: "drag-1" });
    expect(calls).toBe(2);
    off.dispose();
  });

  it("does not set the store for a command that produced no patches", () => {
    const { gantt, history } = harness();
    let calls = 0;
    const off = history.state.subscribe(() => {
      calls++;
    });
    gantt.dispatch("task/move", { id: "missing", start: 0, end: 1 });
    off.dispose();
    expect(calls).toBe(0);
    expect(history.state.get().canUndo).toBe(false);
  });

  it("depth reflects eviction at the configured limit", () => {
    const { gantt, data, history } = harness(2);
    data.load([makeTask("a")]);
    gantt.dispatch("task/move", { id: "a", start: 10, end: 20 });
    gantt.dispatch("task/move", { id: "a", start: 20, end: 30 });
    gantt.dispatch("task/move", { id: "a", start: 30, end: 40 });
    expect(history.state.get().depth).toBe(2);
  });

  it("peekUndo/peekRedo and undoLabels/redoLabels reflect the live stacks", () => {
    const { gantt, data, history } = harness();
    data.load([makeTask("a")]);

    expect(history.peekUndo()).toBeUndefined();
    expect(history.peekRedo()).toBeUndefined();

    gantt.dispatch("task/move", { id: "a", start: 10, end: 20 });
    expect(history.peekUndo()).toBe(history.undoLabels()[0]);
    expect(history.undoLabels()).toHaveLength(1);
    expect(history.redoLabels()).toEqual([]);

    history.undo();
    expect(history.peekUndo()).toBeUndefined();
    expect(history.peekRedo()).toBe(history.redoLabels()[0]);
    expect(history.redoLabels()).toHaveLength(1);
  });
});

// docs/specs/plugins/undo-redo.md "Snapshot serialize/restore"
describe("history snapshot round trip", () => {
  it("carries an undo entry from a disposed instance into a fresh one, and undoes through it", () => {
    const first = start();
    first.data.load([makeTask("a", { start: 0, end: 10 })]);
    first.gantt.dispatch("task/move", { id: "a", start: 50, end: 60 });
    expect(first.data.getTask("a")?.start).toBe(50);

    // Simulates carrying the snapshot through `localStorage` between the dispose and the recreate.
    const wire = JSON.stringify(first.history.serialize());
    const expectedLabel = first.history.peekUndo();
    first.gantt.dispose();

    const second = start();
    open = second.gantt;
    second.data.load([makeTask("a", { start: 0, end: 10 })]);
    expect(second.history.state.get().canUndo).toBe(false);

    let changed = 0;
    const off = second.history.state.subscribe(() => {
      changed++;
    });
    const ok = second.history.restore(JSON.parse(wire) as unknown);
    off.dispose();

    expect(ok).toBe(true);
    expect(changed).toBe(1);
    expect(second.history.state.get().canUndo).toBe(true);
    expect(second.history.peekUndo()).toBe(expectedLabel);

    second.history.undo();
    expect(second.data.getTask("a")?.start).toBe(0);
  });

  it("carries redo entries too, and re-applying one changes the store", () => {
    const first = start();
    first.data.load([makeTask("a", { start: 0, end: 10 })]);
    first.gantt.dispatch("task/move", { id: "a", start: 50, end: 60 });
    first.history.undo();
    expect(first.history.state.get().canRedo).toBe(true);

    const wire = JSON.stringify(first.history.serialize());
    first.gantt.dispose();

    const second = start();
    open = second.gantt;
    second.data.load([makeTask("a", { start: 0, end: 10 })]);
    expect(second.history.restore(JSON.parse(wire) as unknown)).toBe(true);
    expect(second.history.state.get().canRedo).toBe(true);

    second.history.redo();
    expect(second.data.getTask("a")?.start).toBe(50);
  });

  it("rejects a foreign value and leaves the live history untouched and usable", () => {
    const { gantt, data, history } = harness();
    data.load([makeTask("a")]);
    gantt.dispatch("task/move", { id: "a", start: 10, end: 20 });

    expect(history.restore({ not: "a snapshot" })).toBe(false);
    expect(history.restore(null)).toBe(false);
    expect(history.state.get().canUndo).toBe(true);

    history.undo();
    expect(data.getTask("a")?.start).toBe(0);
  });
});

// docs/specs/plugins/data-store.md — the batch replay channel: undo/redo of
// a multi-patch entry replays through one `history/apply` transaction, not one dispatch per patch.
describe("batch replay", () => {
  it("undo of a multi-patch entry is one transaction — one tasks burst", () => {
    const { gantt, data, history } = harness();
    data.load([makeTask("p")]);

    // One will-handler appends `task/add` "c" onto the transaction started by "b", producing a
    // single multi-patch entry ("one undo reverts the action and its automatic follow-on").
    const offAppend = gantt.on("data/willApplyTransaction", (e) => {
      if (e.transaction.patches.some((p) => p.op === "task/add" && p.task.id === "b")) {
        e.transaction.patches.push({
          op: "task/add",
          task: { id: "c", parentId: null, name: "C", start: 0, end: 5 },
        });
      }
    });
    gantt.dispatch("task/add", { task: { id: "b", parentId: null, name: "B", start: 0, end: 5 } });
    offAppend.dispose();

    const seen: { patches: readonly unknown[] }[] = [];
    const offWill = gantt.on("data/willApplyTransaction", (e) => seen.push(e.transaction));
    let bursts = 0;
    const offBurst = data.tasks.subscribe(() => {
      bursts++;
    });

    history.undo();
    offBurst.dispose();
    offWill.dispose();

    expect(bursts).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.patches).toHaveLength(2);
    expect(data.getTask("b")).toBeUndefined();
    expect(data.getTask("c")).toBeUndefined();
    expect(data.getTask("p")).toBeDefined();
  });

  it("undoes patches in reverse order — a later patch is inverted first", () => {
    const { gantt, data, history } = harness();
    data.load([makeTask("a", { start: 0, end: 10 })]);
    gantt.dispatch("task/move", { id: "a", start: 10, end: 20, coalesceKey: "drag" });
    gantt.dispatch("task/move", { id: "a", start: 20, end: 30, coalesceKey: "drag" });
    // One merged entry with two `task/update` patches, applied in gesture order. Undoing must
    // apply the later one's inverse first, restoring straight to the pre-gesture value in one
    // step.
    history.undo();
    expect(data.getTask("a")?.start).toBe(0);
    expect(data.getTask("a")?.end).toBe(10);
  });

  it("undoes a sparse entry (a hole in `patches`) without a hole reaching `history/apply`", () => {
    // `Array.prototype.every` — what `isHistorySnapshot`'s validation walks — skips holes, so a
    // restored entry can carry a genuinely sparse `patches` array. `undo()` must push-compact
    // around the hole rather than leave `undefined` in the inverted list it dispatches, which
    // `history/apply` would choke on mid-transaction.
    const { gantt, data, history } = harness();
    data.load([makeTask("a", { start: 0, end: 10 })]);

    const patches: unknown[] = [updatePatch("a", { start: 0 }, { start: 10 })];
    patches[2] = updatePatch("a", { end: 10 }, { end: 20 });
    // Index 1 is left unset: patches.length is 3 with a real hole at index 1.
    expect(1 in patches).toBe(false);

    const snap = {
      version: 1,
      undo: [{ id: "sparse", label: "sparse", patches }],
      redo: [],
    };
    expect(history.restore(snap)).toBe(true);

    let bursts = 0;
    const off = data.tasks.subscribe(() => {
      bursts++;
    });
    expect(() => history.undo()).not.toThrow();
    off.dispose();

    expect(bursts).toBe(1);
    expect(data.getTask("a")?.start).toBe(0);
    expect(data.getTask("a")?.end).toBe(10);
  });

  it("a foreign-origin transaction dispatched independently is still recorded as its own entry", () => {
    const { gantt, data, history } = harness();
    data.load([makeTask("a"), makeTask("b")]);
    gantt.dispatch("task/move", { id: "a", start: 10, end: 20 });
    gantt.dispatch("task/move", { id: "b", start: 5, end: 15 });

    expect(history.undoLabels()).toHaveLength(2);
    history.undo();
    expect(data.getTask("b")?.start).toBe(0);
    expect(data.getTask("a")?.start).toBe(10);
    history.undo();
    expect(data.getTask("a")?.start).toBe(0);
  });

  it("big-entry smoke: undo and redo of a 1000-patch entry round-trips the store", () => {
    const { gantt, data, history } = harness();
    data.load([makeTask("root")]);

    const off = gantt.on("data/willApplyTransaction", (e) => {
      if (e.transaction.patches[0]?.op !== "task/add") return;
      for (let i = 1; i < 1000; i++) {
        e.transaction.patches.push({
          op: "task/add",
          task: { id: `t${String(i)}`, parentId: null, name: `T${String(i)}`, start: i, end: i + 1 },
        });
      }
    });
    gantt.dispatch("task/add", {
      task: { id: "t0", parentId: null, name: "T0", start: 0, end: 1 },
    });
    off.dispose();

    expect([...data.taskIds()]).toHaveLength(1001);
    history.undo();
    expect([...data.taskIds()]).toEqual(["root"]);
    history.redo();
    expect([...data.taskIds()]).toHaveLength(1001);
  });
});

// Explicit round-trip property the plugin's contract rests on: undoing back to a point, redoing
// forward, and undoing again must reproduce byte-identical data at every matching depth — not just
// "some" data, since a lossy inverse would still look plausible on a single undo/redo pair.
describe("round-trip property: undo → redo → undo", () => {
  it("reproduces identical data at every matching depth across a mixed sequence", () => {
    const { gantt, data, history } = harness();
    data.load({
      tasks: [makeTask("a"), makeTask("b")],
      resources: [{ id: "x", name: "Alice" }],
    });

    const snapshots: string[] = [snapshot(data)];
    gantt.dispatch("task/move", { id: "a", start: 10, end: 20 });
    snapshots.push(snapshot(data));
    gantt.dispatch("link/add", { sourceId: "a", targetId: "b", type: "FS" });
    snapshots.push(snapshot(data));
    gantt.dispatch("assignment/set", { taskId: "b", resourceId: "x", units: 1 });
    snapshots.push(snapshot(data));
    gantt.dispatch("task/setProgress", { id: "a", progress: 0.5 });
    snapshots.push(snapshot(data));

    const steps = snapshots.length - 1;

    // Undo all the way back to the start.
    for (let i = 0; i < steps; i++) history.undo();
    expect(snapshot(data)).toBe(snapshots[0]);
    expect(history.state.get().canUndo).toBe(false);

    // Redo all the way forward again.
    for (let i = 0; i < steps; i++) history.redo();
    expect(snapshot(data)).toBe(snapshots[steps]);
    expect(history.state.get().canRedo).toBe(false);

    // Undo again: every intermediate snapshot must match exactly, not merely "look close".
    for (let i = steps - 1; i >= 0; i--) {
      history.undo();
      expect(snapshot(data)).toBe(snapshots[i]);
    }

    // toJSON()'s full structural equality too, not just the tasks/links the string snapshot covers.
    expect(data.toJSON().assignments).toEqual([]);
  });
});
