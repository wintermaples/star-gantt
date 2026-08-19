// @vitest-environment happy-dom
// docs/specs/plugins/a11y.md § Mirror generation rules.
/**
 * `internal/mirror.ts` mounted directly against a bare root and plain row/data doubles — no core,
 * no plugin. This is the only way to exercise the "no selection information available" state at
 * all: the mirror never reads `stargantt.selection` itself, so a caller that has nothing to report
 * simply never calls `setSelected`, and every row's `aria-selected` stays absent rather than being
 * written as `"false"`.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Disposable, PluginContext } from "@stargantt/core";
import type { ReadonlyDataView, Task, TaskId } from "@stargantt/plugin-data-store";
import { mountMirror } from "../src/internal/mirror";
import type { Mirror } from "../src/internal/mirror";

interface Fixture {
  mirror: Mirror;
  root: HTMLElement;
  rows(): HTMLElement[];
  /** Focus placements reported through `onFocusChanged`, in order. */
  changes: (TaskId | undefined)[];
  dispose(): void;
}

function tasks(n: number): Task[] {
  const out: Task[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push({ id: `t${i}`, parentId: null, name: `t${i}`, start: 0, end: 86_400_000 });
  }
  return out;
}

let current: Fixture | undefined;

afterEach(() => {
  current?.dispose();
  current = undefined;
});

function fixture(count = 3, rootHeight = 300): Fixture {
  const doc = globalThis.document;
  const root = doc.createElement("div");
  root.getBoundingClientRect = (() => ({ height: rootHeight, width: 400 })) as never;
  doc.body.appendChild(root);
  const owned: Disposable[] = [];
  const ctx = {
    root,
    own: (d: Disposable) => owned.push(d),
  } as unknown as PluginContext;

  const list = tasks(count);
  const byId = new Map<TaskId, Task>(list.map((t) => [t.id, t]));
  const order = list.map((t) => t.id);
  const changes: (TaskId | undefined)[] = [];

  const view: ReadonlyDataView = {
    byId,
    children: new Map<TaskId | null, readonly TaskId[]>([[null, order]]),
    linksByTask: new Map(),
    calendars: new Map(),
    resources: new Map(),
    assignmentsByTask: new Map(),
  };

  const mirror = mountMirror(ctx, {
    rows: {
      rowCount: () => order.length,
      taskIdAt: (row: number) => order[row],
      rowOf: (id: TaskId) => {
        const i = order.indexOf(id);
        return i < 0 ? undefined : i;
      },
      rowHeight: () => 24,
      resolvedHeightOf: () => 24,
      yOf: (row: number) => row * 24,
      rowAtY: (y: number) => Math.max(0, Math.min(order.length - 1, Math.floor(y / 24))),
      totalHeight: () => order.length * 24,
      isExpanded: () => true,
      rows: { get: () => ({ taskIds: order, totalHeight: order.length * 24 }), subscribe: () => ({ dispose: () => {} }) },
    } as never,
    data: {
      getTask: (id: TaskId) => byId.get(id),
      query: () => view,
    } as never,
    onFocus: () => {},
    onFocusChanged: (id) => changes.push(id),
    onFocusVisibility: () => {},
    rowText: (parts) => parts.name,
  });
  mirror.render();

  const f: Fixture = {
    mirror,
    root,
    changes,
    rows: () => [...root.querySelectorAll(".sg-a11y-row")] as HTMLElement[],
    dispose: () => {
      for (let i = owned.length - 1; i >= 0; i -= 1) owned[i]?.dispose();
      root.remove();
    },
  };
  current = f;
  return f;
}

describe("aria-selected without any selection information", () => {
  it("leaves the attribute off every row until `setSelected` is ever called", () => {
    const f = fixture();
    for (const row of f.rows()) expect(row.getAttribute("aria-selected")).toBeNull();
  });

  it("writes an explicit true/false on every row once a selection is reported", () => {
    const f = fixture();
    f.mirror.setSelected(new Set<TaskId>(["t1"]));
    expect(f.rows().map((r) => r.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
  });

  it("clears the attribute again when the caller reports no information", () => {
    const f = fixture();
    f.mirror.setSelected(new Set<TaskId>(["t1"]));
    f.mirror.setSelected(undefined);
    for (const row of f.rows()) expect(row.getAttribute("aria-selected")).toBeNull();
  });

  it("keeps a row materialized later in step with the last reported selection", () => {
    const f = fixture(60);
    f.mirror.setSelected(new Set<TaskId>(["t50"]));
    expect(f.rows().some((r) => r.getAttribute("aria-rowindex") === "51")).toBe(false);
    f.mirror.focusTask("t50", "api");
    const row = f.rows().find((r) => r.getAttribute("aria-rowindex") === "51");
    expect(row?.getAttribute("aria-selected")).toBe("true");
  });
});

describe("aria-multiselectable", () => {
  it("is absent until a resolved service reports the mode", () => {
    const f = fixture();
    const grid = f.root.querySelector(".sg-a11y");
    expect(grid?.getAttribute("aria-multiselectable")).toBeNull();
    f.mirror.setMultiselectable(true);
    expect(grid?.getAttribute("aria-multiselectable")).toBe("true");
    f.mirror.setMultiselectable(false);
    expect(grid?.getAttribute("aria-multiselectable")).toBeNull();
  });
});

describe("the mirror's structure", () => {
  it("gives each row exactly one gridcell and no column metadata", () => {
    const f = fixture();
    const grid = f.root.querySelector(".sg-a11y") as HTMLElement;
    expect(grid.getAttribute("role")).toBe("treegrid");
    expect(grid.getAttribute("aria-colcount")).toBeNull();
    for (const row of f.rows()) {
      expect(row.getAttribute("role")).toBe("row");
      expect(row.querySelectorAll("[role='gridcell']").length).toBe(1);
      expect(row.querySelectorAll("[role='columnheader']").length).toBe(0);
    }
  });

  it("reports a focus placement exactly once, and only after a real placement", () => {
    const f = fixture();
    expect(f.changes).toEqual([]);
    f.mirror.focusTask("t1", "api");
    expect(f.changes).toEqual(["t1"]);
    f.mirror.focusTask("t1", "api"); // the same row again is no effective change
    expect(f.changes).toEqual(["t1"]);
  });

  it("keeps a focused row outside the window in the DOM with its true row index", () => {
    const f = fixture(200);
    f.mirror.focusTask("t150", "api");
    f.mirror.setViewportStart(0);
    f.mirror.render();
    const focusedRow = f.rows().find((r) => r.getAttribute("tabindex") === "0");
    expect(focusedRow?.getAttribute("aria-rowindex")).toBe("151");
    // …while the window itself still shows the top of the list.
    expect(f.rows()[0]?.getAttribute("aria-rowindex")).toBe("1");
  });

  it("announces through the live region", () => {
    const f = fixture();
    f.mirror.announce("three selected");
    expect(f.root.querySelector(".sg-a11y-live")?.textContent).toBe("three selected");
  });
});
