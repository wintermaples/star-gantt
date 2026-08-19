/**
 * docs/specs/plugins/data-store.md — Messages: the transaction-label catalog.
 */
import { Gantt } from "@stargantt/core";
import type { GanttInstance } from "@stargantt/core";
import { afterEach, describe, expect, it } from "vitest";
import { dataStore } from "../src/index";
import type { DataStoreConfig, DataStoreMessages } from "../src/index";
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
  /** Labels of every transaction applied so far, in order. */
  labels: string[];
}

function boot(config?: DataStoreConfig): Booted {
  const labels: string[] = [];
  const g = Gantt.create({ element: fakeRoot(), plugins: [dataStore(config)] });
  gantt = g;
  g.on("data/willApplyTransaction", (e: { transaction: Transaction }) => {
    labels.push(e.transaction.label);
  });
  return { data: g.service("stargantt.data"), dispatch: g.dispatch, labels };
}

/** Dispatches one command of every kind the store owns, in catalog order. */
function exerciseAll(b: Booted): void {
  b.data.load([
    { id: "a", name: "A", start: 0, end: 10 },
    { id: "b", name: "B", start: 0, end: 10 },
  ]);
  b.dispatch("task/move", { id: "a", start: 5, end: 15 });
  b.dispatch("task/setProgress", { id: "a", progress: 0.5 });
  b.dispatch("task/add", { task: { id: "c", name: "C" } });
  b.dispatch("task/update", { id: "c", after: { name: "C2" } });
  b.dispatch("link/add", { id: "l1", sourceId: "a", targetId: "b", type: "FS" });
  b.dispatch("link/update", { id: "l1", type: "SS" });
  b.dispatch("link/remove", { ids: ["l1"] });
  b.dispatch("resource/add", { resource: { id: "r1", name: "R" } });
  b.dispatch("resource/update", { id: "r1", after: { name: "R2" } });
  b.dispatch("assignment/set", { taskId: "a", resourceId: "r1", units: 1 });
  b.dispatch("assignment/remove", { taskId: "a", resourceId: "r1" });
  b.dispatch("resource/remove", { ids: ["r1"] });
  b.dispatch("task/remove", { ids: ["c"] });
}

const DEFAULT_LABELS = [
  "Move task",
  "Set progress",
  "Add task",
  "Update task",
  "Add link",
  "Update link",
  "Remove link",
  "Add resource",
  "Update resource",
  "Assign resource",
  "Remove assignment",
  "Remove resource",
  "Remove task",
];

describe("DataStoreMessages defaults", () => {
  it("stamps the built-in English labels when no catalog is supplied", () => {
    const b = boot();
    exerciseAll(b);
    expect(b.labels).toEqual(DEFAULT_LABELS);
  });

  it("reproduces the same labels for an empty config and an empty catalog", () => {
    const omitted = boot();
    exerciseAll(omitted);
    const empty = boot({ messages: {} });
    exerciseAll(empty);
    expect(empty.labels).toEqual(omitted.labels);
  });
});

describe("DataStoreMessages overrides", () => {
  it("replaces a supplied key and keeps every other default (per-key shallow merge)", () => {
    const b = boot({ messages: { taskMove: "Verschieben", linkAdd: "Verknüpfen" } });
    exerciseAll(b);
    expect(b.labels[0]).toBe("Verschieben");
    expect(b.labels[4]).toBe("Verknüpfen");
    expect(b.labels[1]).toBe("Set progress");
    expect(b.labels[12]).toBe("Remove task");
  });

  it("replaces every key when the whole catalog is supplied", () => {
    const all: DataStoreMessages = {
      taskMove: "1",
      taskSetProgress: "2",
      taskAdd: "3",
      taskUpdate: "4",
      linkAdd: "5",
      linkUpdate: "6",
      linkRemove: "7",
      resourceAdd: "8",
      resourceUpdate: "9",
      assignmentSet: "10",
      assignmentRemove: "11",
      resourceRemove: "12",
      taskRemove: "13",
      historyApply: "14",
    };
    const b = boot({ messages: all });
    exerciseAll(b);
    expect(b.labels).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
      "11",
      "12",
      "13",
    ]);
  });

  it("takes the empty string verbatim", () => {
    const b = boot({ messages: { taskMove: "" } });
    exerciseAll(b);
    expect(b.labels[0]).toBe("");
  });

  it("ignores an unusable member and uses its default", () => {
    // A member present but `undefined` counts as absent; a non-string is unusable. Both cases are
    // written as a cast because the declared type forbids them, which is the point of the test.
    const messages = {
      taskMove: undefined,
      taskSetProgress: 7,
      taskAdd: () => "x",
    } as unknown as Partial<DataStoreMessages>;
    const b = boot({ messages });
    exerciseAll(b);
    expect(b.labels.slice(0, 3)).toEqual(["Move task", "Set progress", "Add task"]);
  });

  it("ignores a non-object `messages`", () => {
    const b = boot({ messages: "nope" as unknown as Partial<DataStoreMessages> });
    exerciseAll(b);
    expect(b.labels).toEqual(DEFAULT_LABELS);
  });

  it("resolves once at setup: mutating the catalog afterwards has no effect", () => {
    const messages: Partial<DataStoreMessages> = { taskMove: "first" };
    const b = boot({ messages });
    messages.taskMove = "second";
    exerciseAll(b);
    expect(b.labels[0]).toBe("first");
  });
});
