/**
 * docs/specs/plugins/data-store.md — Apply flow: the unconditional summary-promotion invariant —
 * a task that has children has `type: "summary"`.
 */
import { Gantt } from "@stargantt/core";
import type { GanttInstance } from "@stargantt/core";
import { afterEach, describe, expect, it } from "vitest";
import { invertPatches } from "../src/patch";
import { dataStore } from "../src/index";
import type { DataService, Transaction } from "../src/types";
import { fakeRoot } from "./_helpers";

let gantt: GanttInstance | undefined;

afterEach(() => {
  gantt?.dispose();
  gantt = undefined;
});

interface Booted {
  data: DataService;
  dispatch: GanttInstance["dispatch"];
  transactions: Transaction[];
}

function boot(): Booted {
  const transactions: Transaction[] = [];
  const g = Gantt.create({ element: fakeRoot(), plugins: [dataStore()] });
  gantt = g;
  // `willApplyTransaction` carries the same mutable `Transaction` object the store finishes
  // building (summary-promotion patches included) before `dispatch()` returns, so reading
  // `.patches` afterwards sees the final list — the store itself carries no per-apply event.
  g.on("data/willApplyTransaction", (e: { transaction: Transaction }) => {
    transactions.push(e.transaction);
  });
  g.service("stargantt.data").load([
    { id: "p", name: "P", start: 0, end: 10 },
    { id: "s", name: "S", start: 0, end: 10, type: "summary" },
    { id: "m", name: "M", start: 0, end: 0, type: "milestone" },
  ]);
  return { data: g.service("stargantt.data"), dispatch: g.dispatch, transactions };
}

describe("summary promotion", () => {
  it("promotes a plain parent to summary in the same transaction", () => {
    const b = boot();
    b.dispatch("task/add", { task: { id: "c", name: "C", parentId: "p" } });
    expect(b.data.getTask("p")?.type).toBe("summary");
    expect(b.transactions).toHaveLength(1);
    expect(b.transactions[0]?.patches).toContainEqual({
      op: "task/update",
      id: "p",
      before: {},
      after: { type: "summary" },
    });
  });

  it("promotes on reparenting an existing task under a plain parent", () => {
    const b = boot();
    b.dispatch("task/add", { task: { id: "c", name: "C" } });
    expect(b.data.getTask("p")?.type).toBeUndefined();
    b.dispatch("task/update", { id: "c", after: { parentId: "p" } });
    expect(b.data.getTask("p")?.type).toBe("summary");
  });

  it("promotes a milestone that gains a child", () => {
    const b = boot();
    b.dispatch("task/add", { task: { id: "c", name: "C", parentId: "m" } });
    expect(b.data.getTask("m")?.type).toBe("summary");
    expect(b.transactions[0]?.patches).toContainEqual({
      op: "task/update",
      id: "m",
      before: { type: "milestone" },
      after: { type: "summary" },
    });
  });

  it("leaves a parent that is already a summary alone", () => {
    const b = boot();
    b.dispatch("task/add", { task: { id: "c", name: "C", parentId: "s" } });
    expect(b.data.getTask("s")?.type).toBe("summary");
    expect(b.transactions[0]?.patches).toHaveLength(1);
  });

  it("promotes an explicit type:'task' parent, capturing the previous type", () => {
    const b = boot();
    b.dispatch("task/update", { id: "p", after: { type: "task" } });
    b.dispatch("task/add", { task: { id: "c", name: "C", parentId: "p" } });
    expect(b.data.getTask("p")?.type).toBe("summary");
    expect(b.transactions[1]?.patches).toContainEqual({
      op: "task/update",
      id: "p",
      before: { type: "task" },
      after: { type: "summary" },
    });
  });

  it("undo (inverse patches) demotes back to the unset type", () => {
    const b = boot();
    b.dispatch("task/add", { task: { id: "c", name: "C", parentId: "p" } });
    const tx = b.transactions[0] as Transaction;
    // The inverse undo-redo would replay must restore `type` to absent, not leave a value behind.
    const inverse = invertPatches(tx.patches);
    expect(inverse).toContainEqual({
      op: "task/update",
      id: "p",
      before: { type: "summary" },
      after: {},
      clears: ["type"],
    });
  });

  it("promotes a parent added in the same transaction as its child", () => {
    const b = boot();
    // task/add of the parent, with a will-handler appending the child in the same transaction.
    const g = gantt as GanttInstance;
    g.on("data/willApplyTransaction", (e: { transaction: Transaction }) => {
      if (e.transaction.patches.some((p) => p.op === "task/add" && p.task.id === "np")) {
        e.transaction.patches.push({
          op: "task/add",
          task: { id: "nc", parentId: "np", name: "NC", start: 0, end: 1, orderKey: "5" },
        });
      }
    });
    b.dispatch("task/add", { task: { id: "np", name: "NP" } });
    expect(b.data.getTask("np")?.type).toBe("summary");
    expect(b.data.getTask("nc")?.parentId).toBe("np");
  });

  it("does not promote when the gained child is removed again in the same transaction", () => {
    const b = boot();
    const g = gantt as GanttInstance;
    g.on("data/willApplyTransaction", (e: { transaction: Transaction }) => {
      const add = e.transaction.patches.find((p) => p.op === "task/add");
      if (add && add.op === "task/add" && add.task.id === "c") {
        e.transaction.patches.push({ op: "task/remove", task: add.task });
      }
    });
    b.dispatch("task/add", { task: { id: "c", name: "C", parentId: "p" } });
    expect(b.data.getTask("p")?.type).toBeUndefined();
    expect(b.data.getTask("c")).toBeUndefined();
  });

  it("does not demote a summary that loses its last child", () => {
    const b = boot();
    b.dispatch("task/add", { task: { id: "c", name: "C", parentId: "p" } });
    b.dispatch("task/remove", { ids: ["c"] });
    expect(b.data.getTask("p")?.type).toBe("summary");
  });

  it("promotes on load(), not only inside a transaction", () => {
    const b = boot();
    b.data.load([
      { id: "a", name: "A", start: 0, end: 10 },
      { id: "b", name: "B", parentId: "a", start: 0, end: 5 },
      { id: "k", name: "K", type: "milestone", start: 0, end: 0 },
      { id: "kc", name: "KC", parentId: "k", start: 0, end: 1 },
    ]);
    expect(b.data.getTask("a")?.type).toBe("summary");
    expect(b.data.getTask("k")?.type).toBe("summary");
    // A childless authored type is left exactly as it was.
    expect(b.data.getTask("b")?.type).toBeUndefined();
  });

  it("promotes a parent whose children are materialized later", () => {
    const b = boot();
    b.data.load({
      tasks: [{ id: "a", name: "A", start: 0, end: 10 }],
      deferredTasks: [{ parentId: "a", rows: [{ id: "b", name: "B", start: 0, end: 5 }] }],
    });
    expect(b.data.getTask("a")?.type).toBeUndefined();
    b.data.materializeChildren("a");
    expect(b.data.getTask("a")?.type).toBe("summary");
  });
});
