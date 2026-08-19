// docs/specs/plugins/interaction.md §4 — capture, paste planning, targets/anchor resolution, and
// the sibling-order-key minting, hostless: no `Gantt.create()` or DOM involved.
import { midKey } from "@stargantt/plugin-data-store";
import type { ReadonlyDataView, Task, TaskId } from "@stargantt/plugin-data-store";
import { describe, expect, it } from "vitest";
import {
  capture,
  existingLinkIds,
  idMinter,
  keysBetween,
  payloadRows,
  planCellPaste,
  planStructuredPaste,
} from "../src/internal/clipboard/transfer";
import { orderIds, siblingTarget, walkTargets } from "../src/internal/clipboard/targets";
import type { RowOrder } from "../src/internal/clipboard/targets";

const DAY = 86_400_000;

/** One task, with the two required dates defaulted. */
function task(over: Partial<Task> & { id: TaskId }): Task {
  return { parentId: null, name: `task-${String(over.id)}`, start: 0, end: DAY, orderKey: "V", ...over };
}

/** A `ReadonlyDataView` over a flat task list (tree shape from `parentId`), with no links unless given. */
function view(
  tasks: readonly Task[],
  links: readonly { source: TaskId; target: TaskId; type: "FS" | "SS" | "FF" | "SF" }[] = [],
): ReadonlyDataView {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const children = new Map<TaskId | null, TaskId[]>();
  for (const t of tasks) {
    const list = children.get(t.parentId) ?? [];
    list.push(t.id);
    children.set(t.parentId, list);
  }
  const linksByTask = new Map<TaskId, { in: never[]; out: { id: string; sourceId: TaskId; targetId: TaskId; type: string }[] }>();
  for (const l of links) {
    const linkId = `l-${String(l.source)}-${String(l.target)}`;
    const bucket = linksByTask.get(l.source) ?? { in: [], out: [] };
    bucket.out.push({ id: linkId, sourceId: l.source, targetId: l.target, type: l.type });
    linksByTask.set(l.source, bucket as never);
  }
  return {
    byId,
    children,
    linksByTask,
    calendars: new Map(),
    resources: new Map(),
    assignmentsByTask: new Map(),
  } as unknown as ReadonlyDataView;
}

/** A minimal `RowOrder` double over an explicit id sequence. */
function rowsOf(order: readonly TaskId[]): RowOrder {
  return {
    rowOf: (id) => {
      const i = order.indexOf(id);
      return i === -1 ? undefined : i;
    },
    taskIdAt: (row) => order[row],
    rowCount: () => order.length,
  };
}

describe("midKey (re-exported from @stargantt/plugin-data-store)", () => {
  it("produces a key strictly between its neighbours", () => {
    const cases: [string, string | undefined][] = [
      ["", undefined],
      ["", "V"],
      ["0001", "0002"],
      ["A", "B"],
    ];
    for (const [prev, next] of cases) {
      const key = midKey(prev, next);
      expect(key > prev).toBe(true);
      if (next !== undefined) expect(key < next).toBe(true);
    }
  });
});

describe("keysBetween", () => {
  it("returns an increasing run inside the gap", () => {
    const keys = keysBetween("0001", "0002", 8);
    expect(keys).toHaveLength(8);
    let last = "0001";
    for (const key of keys) {
      expect(key > last).toBe(true);
      expect(key < "0002").toBe(true);
      last = key;
    }
  });

  it("keeps increasing with an open upper bound", () => {
    const keys = keysBetween("zz", undefined, 5);
    let last = "zz";
    for (const key of keys) {
      expect(key > last).toBe(true);
      last = key;
    }
  });
});

describe("idMinter / existingLinkIds", () => {
  it("mints ids skipped past everything already used", () => {
    const mint = idMinter("c", new Set(["c1", "c2"]));
    expect(mint()).toBe("c3");
    expect(mint()).toBe("c4");
  });

  it("collects every outgoing link id in the view", () => {
    const v = view(
      [task({ id: "a" }), task({ id: "b" })],
      [{ source: "a", target: "b", type: "FS" }],
    );
    expect([...existingLinkIds(v)]).toEqual(["l-a-b"]);
  });
});

describe("orderIds", () => {
  it("sorts by row order when a row model resolves", () => {
    expect(orderIds(["b", "a"], rowsOf(["a", "b"]))).toEqual(["a", "b"]);
  });

  it("keeps the given order without a row model", () => {
    expect(orderIds(["b", "a"], undefined)).toEqual(["b", "a"]);
  });

  it("puts ids the row model does not know last", () => {
    expect(orderIds(["x", "a"], rowsOf(["a"]))).toEqual(["a", "x"]);
  });
});

describe("siblingTarget", () => {
  it("appends at the root level with no usable anchor", () => {
    const v = view([task({ id: "a" }), task({ id: "b" })]);
    expect(siblingTarget(v, undefined)).toEqual({ parentId: null, index: 2 });
    expect(siblingTarget(v, "unknown")).toEqual({ parentId: null, index: 2 });
  });

  it("targets directly after the anchor among its own siblings", () => {
    const v = view([task({ id: "a" }), task({ id: "b" }), task({ id: "c" })]);
    expect(siblingTarget(v, "a")).toEqual({ parentId: null, index: 1 });
    expect(siblingTarget(v, "c")).toEqual({ parentId: null, index: 3 });
  });
});

describe("capture", () => {
  it("captures a subtree in pre-order with parent indexes", () => {
    const v = view([
      task({ id: "a" }),
      task({ id: "k", parentId: "a" }),
      task({ id: "b" }),
    ]);
    const payload = capture(["a"], v)!;
    expect(payload.tasks.map((t) => t.fields.name)).toEqual(["task-a", "task-k"]);
    expect(payload.tasks[1]?.parent).toBe(0);
    expect(payload.rootIds).toEqual(["a"]);
  });

  it("captures a selected descendant of a selected ancestor only once", () => {
    const v = view([task({ id: "a" }), task({ id: "k", parentId: "a" })]);
    const payload = capture(["a", "k"], v)!;
    expect(payload.tasks).toHaveLength(2);
    expect(payload.rootIds).toEqual(["a"]);
  });

  it("collects only links wholly inside the captured set", () => {
    const v = view(
      [task({ id: "a" }), task({ id: "b" }), task({ id: "c" })],
      [
        { source: "a", target: "b", type: "FS" },
        { source: "a", target: "c", type: "FS" },
      ],
    );
    const payload = capture(["a", "b"], v)!;
    expect(payload.links).toHaveLength(1);
    expect(payload.links[0]).toMatchObject({ source: 0, target: 1, type: "FS" });
  });

  it("returns undefined when nothing usable was named", () => {
    const v = view([task({ id: "a" })]);
    expect(capture(["unknown"], v)).toBeUndefined();
    expect(capture([], v)).toBeUndefined();
  });

  it("payloadRows exposes the captured tasks' fields in pre-order", () => {
    const v = view([task({ id: "a", name: "Alpha" })]);
    const payload = capture(["a"], v)!;
    expect(payloadRows(payload)).toEqual([{ name: "Alpha", start: 0, end: DAY }]);
  });
});

describe("planStructuredPaste", () => {
  it("mints fresh ids, rewrites parents, and keys top-level tasks between the target's neighbours", () => {
    const v = view([
      task({ id: "a", orderKey: "A" }),
      task({ id: "k", parentId: "a", orderKey: "A" }),
      task({ id: "b", orderKey: "B" }),
    ]);
    const payload = capture(["a"], v)!;
    const plan = planStructuredPaste(payload, v, { parentId: null, index: 1 })!;
    expect(plan.count).toBe(2);
    expect(plan.newTopIds).toHaveLength(1);
    expect(plan.first.command).toBe("task/add");
    if (plan.first.command === "task/add") {
      expect(plan.first.task.orderKey! > "A").toBe(true);
      expect(plan.first.task.orderKey! < "B").toBe(true);
    }
    // The child's `task/add` patch rides in `rest`, with its parent rewritten to the fresh id.
    expect(plan.rest).toHaveLength(1);
    const childPatch = plan.rest[0]!;
    expect(childPatch.op).toBe("task/add");
    if (childPatch.op === "task/add") {
      expect(childPatch.task.parentId).not.toBe("a");
      expect(childPatch.task.name).toBe("task-k");
    }
  });

  it("re-creates links with both endpoints remapped to the fresh ids", () => {
    const v = view(
      [task({ id: "a" }), task({ id: "b" })],
      [{ source: "a", target: "b", type: "FS" }],
    );
    const payload = capture(["a", "b"], v)!;
    const plan = planStructuredPaste(payload, v, { parentId: null, index: 2 })!;
    const linkPatch = plan.rest.find((p) => p.op === "link/add");
    expect(linkPatch).toBeDefined();
    if (linkPatch?.op === "link/add") {
      expect(linkPatch.link.sourceId).not.toBe("a");
      expect(linkPatch.link.targetId).not.toBe("b");
      expect(linkPatch.link.type).toBe("FS");
    }
  });

  it("returns undefined for an empty payload", () => {
    const v = view([task({ id: "a" })]);
    expect(planStructuredPaste({ tasks: [], links: [], rootIds: [] }, v, { parentId: null, index: 0 })).toBeUndefined();
  });
});

describe("walkTargets", () => {
  it("walks visible rows downward from the anchor, in row order", () => {
    const v = view([task({ id: "a" }), task({ id: "b" }), task({ id: "c" })]);
    const targets = walkTargets(v, "b", 2, rowsOf(["a", "b", "c"]), () => v.byId.keys());
    expect(targets.map((t) => t.id)).toEqual(["b", "c"]);
  });

  it("skips summary rows without consuming a slot", () => {
    const v = view([
      task({ id: "a", type: "summary" }),
      task({ id: "k" }),
      task({ id: "b" }),
    ]);
    const targets = walkTargets(v, "a", 2, rowsOf(["a", "k", "b"]), () => v.byId.keys());
    expect(targets.map((t) => t.id)).toEqual(["k", "b"]);
  });

  it("is empty with no anchor or an anchor the store does not know", () => {
    const v = view([task({ id: "a" })]);
    expect(walkTargets(v, undefined, 2, rowsOf(["a"]), () => v.byId.keys())).toEqual([]);
    expect(walkTargets(v, "ghost", 2, rowsOf(["a"]), () => v.byId.keys())).toEqual([]);
  });

  it("falls back to store iteration order without a row model", () => {
    const v = view([task({ id: "a" }), task({ id: "b" }), task({ id: "c" })]);
    const targets = walkTargets(v, "b", 2, undefined, () => v.byId.keys());
    expect(targets.map((t) => t.id)).toEqual(["b", "c"]);
  });
});

describe("planCellPaste", () => {
  it("updates targets one to one and creates overflow rows as new roots", () => {
    const v = view([task({ id: "a" }), task({ id: "b" })]);
    const targets = [v.byId.get("a")!, v.byId.get("b")!];
    const plan = planCellPaste(
      [{ name: "Renamed" }, { name: "Also" }, { name: "Overflow" }],
      targets,
      v,
    )!;
    expect(plan.count).toBe(3); // 2 updates + 1 created
    expect(plan.newTopIds).toHaveLength(1);
  });

  it("returns undefined when nothing would change", () => {
    const v = view([task({ id: "a", name: "Alpha" })]);
    expect(planCellPaste([{ name: "Alpha" }], [v.byId.get("a")!], v)).toBeUndefined();
  });

  it("field-less overflow rows create no junk root tasks", () => {
    const v = view([task({ id: "a" })]);
    const plan = planCellPaste([{}, {}], [], v);
    expect(plan).toBeUndefined();
  });
});
