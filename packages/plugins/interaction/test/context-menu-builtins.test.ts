/**
 * Unit tests for `src/internal/context-menu/builtins.ts` — the built-in row actions (insert,
 * duplicate, delete, the two-step link pair) and the insert-placement rules, exercised directly
 * against plain object doubles with no host and no DOM.
 *
 * docs/specs/plugins/interaction.md §6.5, §6.5.1 (insert placement, the leaf-parent-span rule, the
 * grid-cell duration rule).
 */
import { describe, expect, it } from "vitest";
import type { Commands } from "@stargantt/core";
import type { DataService, Task, TaskId } from "@stargantt/plugin-data-store";
import type { GridCell, TimelineService, Viewport } from "@stargantt/plugin-view";
import type { RowsService } from "@stargantt/plugin-tree-grid";
import { DEFAULT_MESSAGES } from "../src/messages";
import {
  backgroundInsertTask,
  builtinItems,
  hitInsertTask,
} from "../src/internal/context-menu/builtins";
import type { BuiltinDeps, LinkSourceCell } from "../src/internal/context-menu/builtins";
import { createLinkSource } from "../src/internal/context-menu/link-source";
import type { ContextMenuTarget } from "../src/internal/context-menu/menu";

const DAY = 86_400_000;

function task(over: Partial<Task> & { id: TaskId }): Task {
  return { parentId: null, name: `task-${String(over.id)}`, start: 0, end: DAY, ...over };
}

function fakeData(tasks: readonly Task[]): DataService {
  const byId = new Map<TaskId, Task>(tasks.map((t) => [t.id, t]));
  const children = new Map<TaskId | null, TaskId[]>();
  for (const t of tasks) {
    const key = t.parentId ?? null;
    const list = children.get(key) ?? [];
    list.push(t.id);
    children.set(key, list);
  }
  return {
    getTask: (id: TaskId) => byId.get(id),
    taskIds: () => byId.keys(),
    query: () => ({ byId, children }) as never,
  } as unknown as DataService;
}

/** Uniform-height rows over a flat order, none collapsed unless named. */
function fakeRows(order: readonly TaskId[], rowHeight = 20, collapsed: TaskId[] = []): RowsService {
  const collapsedSet = new Set(collapsed);
  return {
    rowCount: () => order.length,
    taskIdAt: (row: number) => order[row],
    rowOf: (id: TaskId) => {
      const i = order.indexOf(id);
      return i === -1 ? undefined : i;
    },
    rowHeight: () => rowHeight,
    resolvedHeightOf: () => rowHeight,
    yOf: (row: number) => row * rowHeight,
    rowAtY: (y: number) => Math.min(order.length - 1, Math.max(0, Math.floor(y / rowHeight))),
    totalHeight: () => order.length * rowHeight,
    isExpanded: (id: TaskId) => !collapsedSet.has(id),
  } as unknown as RowsService;
}

/** A one-pixel-per-millisecond time axis with a fixed grid-cell size (default one day). */
function fakeScale(cellMs: number = DAY): Pick<TimelineService, "xToT" | "gridCellAt"> {
  return {
    xToT: (x: number) => x,
    gridCellAt: (t: number): GridCell => {
      const start = Math.floor(t / cellMs) * cellMs;
      return { start, end: start + cellMs };
    },
  };
}

function fakeViewport(over: Partial<Viewport> = {}): Viewport {
  return { scrollLeft: 0, scrollTop: 0, width: 800, height: 600, ...over };
}

interface DepsOverrides {
  data?: DataService | undefined;
  rows?: RowsService | undefined;
  scale?: Pick<TimelineService, "xToT" | "gridCellAt"> | undefined;
  viewport?: (() => Readonly<Viewport>) | undefined;
  insertMode?: "child" | "sibling";
  linkSource?: LinkSourceCell;
}

interface Dispatched {
  key: string;
  payload: unknown;
}

function fakeDeps(over: DepsOverrides = {}): { deps: BuiltinDeps; dispatched: Dispatched[] } {
  const dispatched: Dispatched[] = [];
  const deps: BuiltinDeps = {
    data: over.data,
    messages: DEFAULT_MESSAGES,
    dispatch: <K extends keyof Commands>(key: K, payload: Commands[K]) => {
      dispatched.push({ key: key as string, payload });
    },
    linkSource: over.linkSource ?? createLinkSource(),
    rows: over.rows,
    scale: over.scale,
    viewport: over.viewport,
    insertMode: over.insertMode ?? "child",
  };
  return { deps, dispatched };
}

function target(over: Partial<ContextMenuTarget> & { kind: ContextMenuTarget["kind"] }): ContextMenuTarget {
  return { x: 0, y: 0, ...over } as ContextMenuTarget;
}

describe("builtinItems — without a store", () => {
  it("contributes nothing at all", () => {
    const { deps } = fakeDeps({ data: undefined });
    expect(builtinItems(deps, target({ kind: "background" }))).toBeUndefined();
  });
});

describe("builtinItems — background target", () => {
  it("offers a single insert entry", () => {
    const { deps } = fakeDeps({ data: fakeData([]) });
    const items = builtinItems(deps, target({ kind: "background", x: 0, y: 0 }));
    expect(items?.map((i) => i.id)).toEqual(["insert"]);
    expect(items?.[0]?.label).toBe("Insert task");
  });

  it("dispatches task/add on activation, placed by backgroundInsertTask", () => {
    const { deps, dispatched } = fakeDeps({
      data: fakeData([task({ id: "a", start: 0, end: DAY })]),
      rows: fakeRows(["a"]),
      scale: fakeScale(),
      viewport: () => fakeViewport(),
    });
    const t = target({ kind: "background", x: 2 * DAY, y: 200 }); // below the last row
    const items = builtinItems(deps, t);
    items?.[0]?.run(t);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.key).toBe("task/add");
    // Review round 1 minor-6: the test name claims the payload is "placed by backgroundInsertTask"
    // — inspect it instead of only the command name. `y: 200` is below the single fake row's total
    // height (20), so `rowTaskAt` resolves no row and the task carries no `parentId` at all; `x`
    // maps straight through `fakeScale`'s identity `xToT` into the one-day grid cell it lands in.
    expect(dispatched[0]?.payload).toEqual({
      task: { name: "New task", start: 2 * DAY, end: 3 * DAY },
    });
  });

  it("adds a Cancel link entry, separatorBefore, only while a source is pending", () => {
    const linkSource = createLinkSource();
    const { deps } = fakeDeps({ data: fakeData([]), linkSource });
    expect(builtinItems(deps, target({ kind: "background" }))?.map((i) => i.id)).toEqual(["insert"]);
    linkSource.beginInvocation();
    linkSource.set("a");
    linkSource.endInvocation();
    const items = builtinItems(deps, target({ kind: "background" }));
    expect(items?.map((i) => i.id)).toEqual(["insert", "cancel-link"]);
    expect(items?.[1]?.separatorBefore).toBe(true);
  });
});

describe("builtinItems — gridBackground target", () => {
  it("offers a single insert entry that dispatches view/rowInsert named by the catalog", () => {
    const { deps, dispatched } = fakeDeps({ data: fakeData([]) });
    const t = target({ kind: "gridBackground", x: 0, y: 0 });
    const items = builtinItems(deps, t);
    expect(items?.map((i) => i.id)).toEqual(["insert"]);
    items?.[0]?.run(t);
    expect(dispatched).toEqual([{ key: "view/rowInsert", payload: { name: "New task" } }]);
  });
});

describe("builtinItems — hit target", () => {
  const alpha = task({ id: "a", name: "Alpha", start: 100, end: 200 });
  const beta = task({ id: "b", name: "Beta", start: 300, end: 400 });

  it("answers for bar, handle and row hit kinds identically", () => {
    const data = fakeData([alpha]);
    const { deps } = fakeDeps({ data });
    for (const hitKind of ["bar", "handle", "row"] as const) {
      const items = builtinItems(deps, target({ kind: "hit", hitKind, id: "a" }));
      expect(items?.map((i) => i.id)).toEqual(["insert", "duplicate", "delete", "link-from", "link-to"]);
    }
  });

  it("declines link and other third-party hit kinds", () => {
    const { deps } = fakeDeps({ data: fakeData([alpha]) });
    expect(builtinItems(deps, target({ kind: "hit", hitKind: "link", id: "l1" }))).toBeUndefined();
  });

  it("declines an unknown task id", () => {
    const { deps } = fakeDeps({ data: fakeData([alpha]) });
    expect(builtinItems(deps, target({ kind: "hit", hitKind: "bar", id: "unknown" }))).toBeUndefined();
  });

  it("duplicate copies name, dates, progress and type, never the id or orderKey", () => {
    const rich = task({ id: "a", name: "Alpha", start: 100, end: 200, progress: 0.5, type: "milestone" });
    const { deps, dispatched } = fakeDeps({ data: fakeData([rich]) });
    const t = target({ kind: "hit", hitKind: "bar", id: "a" });
    builtinItems(deps, t)?.find((i) => i.id === "duplicate")?.run(t);
    expect(dispatched).toEqual([
      {
        key: "task/add",
        payload: {
          task: { name: "Alpha", parentId: null, start: 100, end: 200, progress: 0.5, type: "milestone" },
        },
      },
    ]);
  });

  it("delete dispatches task/remove for the hit task only", () => {
    const { deps, dispatched } = fakeDeps({ data: fakeData([alpha, beta]) });
    const t = target({ kind: "hit", hitKind: "bar", id: "b" });
    builtinItems(deps, t)?.find((i) => i.id === "delete")?.run(t);
    expect(dispatched).toEqual([{ key: "task/remove", payload: { ids: ["b"] } }]);
  });

  it("link-from arms the pending source without dispatching a command", () => {
    const linkSource = createLinkSource();
    const { deps, dispatched } = fakeDeps({ data: fakeData([alpha]), linkSource });
    linkSource.beginInvocation();
    const t = target({ kind: "hit", hitKind: "bar", id: "a" });
    builtinItems(deps, t)?.find((i) => i.id === "link-from")?.run(t);
    linkSource.endInvocation();
    expect(dispatched).toEqual([]);
    expect(linkSource.get()).toBe("a");
  });

  it("link-to is disabled with no armed source, on the source task itself, or a vanished source", () => {
    const linkSource = createLinkSource();
    const { deps } = fakeDeps({ data: fakeData([alpha, beta]), linkSource });
    // Unarmed.
    expect(
      builtinItems(deps, target({ kind: "hit", hitKind: "bar", id: "a" }))?.find((i) => i.id === "link-to")
        ?.disabled,
    ).toBe(true);
    // Armed on the same task being viewed.
    linkSource.beginInvocation();
    linkSource.set("a");
    linkSource.endInvocation();
    expect(
      builtinItems(deps, target({ kind: "hit", hitKind: "bar", id: "a" }))?.find((i) => i.id === "link-to")
        ?.disabled,
    ).toBe(true);
    // Armed on a different, existing task: enabled.
    expect(
      builtinItems(deps, target({ kind: "hit", hitKind: "bar", id: "b" }))?.find((i) => i.id === "link-to")
        ?.disabled,
    ).toBe(false);
  });

  it("link-to dispatches link/add and consumes the source", () => {
    const linkSource = createLinkSource();
    linkSource.beginInvocation();
    linkSource.set("a");
    linkSource.endInvocation();
    const { deps, dispatched } = fakeDeps({ data: fakeData([alpha, beta]), linkSource });
    const t = target({ kind: "hit", hitKind: "bar", id: "b" });
    builtinItems(deps, t)?.find((i) => i.id === "link-to")?.run(t);
    expect(dispatched).toEqual([
      { key: "link/add", payload: { sourceId: "a", targetId: "b", type: "FS" } },
    ]);
    expect(linkSource.get()).toBeUndefined();
  });
});

describe("hitInsertTask (§6.5.1)", () => {
  it("makes a child by default, one grid cell long from the hit task's start", () => {
    const { deps } = fakeDeps({ data: fakeData([]), scale: fakeScale() });
    const hitTask = task({ id: "a", start: 5 * DAY, end: 6 * DAY });
    expect(hitInsertTask(deps, hitTask)).toEqual({
      name: "New task",
      parentId: "a",
      start: 5 * DAY,
      end: 6 * DAY,
    });
  });

  it("makes a sibling under insertMode: sibling", () => {
    const { deps } = fakeDeps({ data: fakeData([]), scale: fakeScale(), insertMode: "sibling" });
    const hitTask = task({ id: "a", parentId: "p", start: 0, end: DAY });
    expect(hitInsertTask(deps, hitTask).parentId).toBe("p");
  });

  it("copies a leaf parent's whole span instead of one cell, leaving it unmoved", () => {
    const { deps } = fakeDeps({ data: fakeData([]), scale: fakeScale() });
    const leaf = task({ id: "a", start: 100, end: 200 });
    expect(hitInsertTask(deps, leaf)).toMatchObject({ parentId: "a", start: 100, end: 200 });
  });

  it("uses one grid cell for a parent that is already a summary", () => {
    const summary = task({ id: "p", start: 0, end: 10 * DAY });
    const { deps } = fakeDeps({ data: fakeData([summary, task({ id: "k", parentId: "p" })]), scale: fakeScale() });
    expect(hitInsertTask(deps, summary)).toMatchObject({ parentId: "p", start: 0, end: DAY });
  });

  it("falls back to one day with no time axis composed", () => {
    // The row's task is already a summary, which is the branch the one-cell rule still governs:
    // the leaf exception would otherwise hand the new child the parent's whole span and this would
    // stop measuring the no-axis fallback at all.
    const summary = task({ id: "p", start: 100, end: 200 });
    const { deps } = fakeDeps({
      data: fakeData([summary, task({ id: "k", parentId: "p" })]),
      scale: undefined,
    });
    expect(hitInsertTask(deps, summary)).toMatchObject({ parentId: "p", start: 100, end: 100 + DAY });
  });
});

describe("backgroundInsertTask (§6.5.1)", () => {
  it("places at the pressed cell and row when both a scale and a row model resolve", () => {
    const beta = task({ id: "b", start: 0, end: DAY });
    const { deps } = fakeDeps({
      data: fakeData([task({ id: "a", start: 0, end: DAY }), beta]),
      rows: fakeRows(["a", "b"]),
      scale: fakeScale(),
      viewport: () => fakeViewport(),
    });
    // y = 25 lands in row 1 ("b"); x = 2*DAY lands in the third day's cell.
    const t = target({ kind: "background", x: 2 * DAY, y: 25 });
    expect(backgroundInsertTask(deps, t)).toMatchObject({ parentId: "b", start: 0, end: DAY });
  });

  it("makes a top-level task for a press below the last row", () => {
    const { deps } = fakeDeps({
      data: fakeData([task({ id: "a", start: 0, end: DAY })]),
      rows: fakeRows(["a"]),
      scale: fakeScale(),
      viewport: () => fakeViewport(),
    });
    const t = target({ kind: "background", x: DAY, y: 999 });
    const result = backgroundInsertTask(deps, t);
    expect(result.parentId).toBeUndefined();
    expect(result.start).toBe(DAY);
  });

  it("makes a sibling under insertMode: sibling", () => {
    const beta = task({ id: "b", parentId: null, start: 0, end: DAY });
    const { deps } = fakeDeps({
      data: fakeData([beta]),
      rows: fakeRows(["b"]),
      scale: fakeScale(),
      viewport: () => fakeViewport(),
      insertMode: "sibling",
    });
    const t = target({ kind: "background", x: DAY, y: 5 });
    expect(backgroundInsertTask(deps, t)).toMatchObject({ parentId: null, start: DAY, end: 2 * DAY });
  });

  it("falls back to the row's own start with no time axis", () => {
    const summary = task({ id: "a", start: 100, end: 200 });
    const { deps } = fakeDeps({
      data: fakeData([summary, task({ id: "k", parentId: "a" })]),
      rows: fakeRows(["a"]),
      viewport: () => fakeViewport(),
      scale: undefined,
    });
    const t = target({ kind: "background", x: 50, y: 5 });
    expect(backgroundInsertTask(deps, t)).toMatchObject({ parentId: "a", start: 100, end: 100 + DAY });
  });

  it("without a row model or viewport, places only by date when a scale is present", () => {
    const { deps } = fakeDeps({ data: fakeData([]), scale: fakeScale() });
    const t = target({ kind: "background", x: 3 * DAY, y: 5 });
    const result = backgroundInsertTask(deps, t);
    expect(result.parentId).toBeUndefined();
    expect(result.start).toBeUndefined(); // no viewport → no x→time mapping either
  });
});
