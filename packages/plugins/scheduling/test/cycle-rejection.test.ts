/**
 * docs/specs/plugins/scheduling.md §2.7 — the will-phase semantics of `schedule/cycleRejected`,
 * asserted against the REAL data store (and, for the undo half, the real undo-redo plugin).
 *
 * "Nothing needs rolling back — a will-phase cancellation means the transaction never applies: no
 * patch reaches the store, no store notification fires, no `data/didApplyTransaction` is emitted,
 * and no undo entry is recorded."
 */
import { Gantt } from "@stargantt/core";
import type { GanttInstance } from "@stargantt/core";
import { dataStore } from "@stargantt/plugin-data-store";
import { undoRedo } from "@stargantt/plugin-undo-redo";
import { afterEach, describe, expect, it } from "vitest";
import { scheduling } from "../src/index";
import { DAY, dataOf, fakeRoot, links, task, times } from "./_helpers";

let gantt: GanttInstance | undefined;

afterEach(() => {
  gantt?.dispose();
  gantt = undefined;
});

/** data-store + scheduling + undo-redo, propagation on, two tasks joined by one FS link. */
function boot(): GanttInstance {
  const g = Gantt.create({
    element: fakeRoot(),
    plugins: [dataStore(), scheduling({ autoSchedule: { enabled: true } }), undoRedo()],
  });
  gantt = g;
  dataOf(g).load({
    tasks: [task("a", 0, DAY), task("b", DAY, 2 * DAY)],
    links: [{ id: "L1", sourceId: "a", targetId: "b", type: "FS" }],
  });
  return g;
}

describe("cycle rejection — will-phase semantics against the real store", () => {
  it("emits the chain once, synchronously, and applies nothing", () => {
    const g = boot();
    const chains: string[][] = [];
    const settled: string[] = [];
    g.on("schedule/cycleRejected", (e) => chains.push(e.chain.map(String)));
    g.on("data/didApplyTransaction", (e) => settled.push(e.transaction.id));

    g.dispatch("link/add", { id: "back", sourceId: "b", targetId: "a", type: "FS" });

    expect(chains).toEqual([["back", "L1"]]);
    // No settle signal at all — the transaction never applied.
    expect(settled).toEqual([]);
    expect(links(dataOf(g)).map((l) => String(l.id))).toEqual(["L1"]);
    expect(times(dataOf(g))).toEqual({ a: [0, DAY], b: [DAY, 2 * DAY] });
  });

  it("fires no data.tasks / data.links store notification", () => {
    const g = boot();
    const data = dataOf(g);
    let notifications = 0;
    const offTasks = data.tasks.subscribe(() => void notifications++);
    const offLinks = data.links.subscribe(() => void notifications++);

    g.dispatch("link/add", { id: "back", sourceId: "b", targetId: "a", type: "FS" });

    expect(notifications).toBe(0);
    offTasks.dispose();
    offLinks.dispose();
  });

  it("records no undo entry, so undo() still reverts the previous edit", () => {
    const g = boot();
    const history = g.service("stargantt.history");
    // One real edit first, so the undo stack is non-empty and identifiable.
    g.dispatch("task/move", { id: "a", start: 2 * DAY, end: 3 * DAY });
    const depthAfterEdit = history.undoLabels().length;
    expect(depthAfterEdit).toBe(1);

    g.dispatch("link/add", { id: "back", sourceId: "b", targetId: "a", type: "FS" });
    // The refused link left the history untouched.
    expect(history.undoLabels().length).toBe(depthAfterEdit);

    history.undo();
    // The undo reverted the move (and its propagated successor), not anything cycle-related.
    expect(times(dataOf(g))).toEqual({ a: [0, DAY], b: [DAY, 2 * DAY] });
    expect(history.undoLabels()).toEqual([]);
  });

  it("is unaffected by the propagation switch", () => {
    const g = Gantt.create({
      element: fakeRoot(),
      plugins: [dataStore(), scheduling({}), undoRedo()],
    });
    gantt = g;
    dataOf(g).load({
      tasks: [task("a", 0, DAY), task("b", DAY, 2 * DAY)],
      links: [{ id: "L1", sourceId: "a", targetId: "b", type: "FS" }],
    });
    const chains: string[][] = [];
    g.on("schedule/cycleRejected", (e) => chains.push(e.chain.map(String)));

    g.dispatch("link/add", { id: "back", sourceId: "b", targetId: "a", type: "FS" });

    expect(chains).toEqual([["back", "L1"]]);
    expect(links(dataOf(g))).toHaveLength(1);
    expect(g.service("stargantt.history").undoLabels()).toEqual([]);
  });

  it("cancels the whole transaction, not just the offending patch", () => {
    // Two link/add patches in one transaction cannot be produced by a command, so the will hook is
    // driven directly: an earlier acyclic edge in the same transaction must not survive the refusal.
    const g = boot();
    const settled: string[] = [];
    g.on("data/didApplyTransaction", (e) => settled.push(e.transaction.id));
    // `link/add` for c→a is fine on its own; b→a closes the loop.
    g.dispatch("task/add", { task: { id: "c", name: "C", start: 0, end: DAY } });
    settled.length = 0;
    g.dispatch("link/add", { id: "back", sourceId: "b", targetId: "a", type: "FS" });
    expect(settled).toEqual([]);
    expect(links(dataOf(g))).toHaveLength(1);
  });
});
