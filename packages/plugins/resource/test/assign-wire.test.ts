// @vitest-environment happy-dom
/**
 * `internal/assign/wire.ts` — the assign area wired end-to-end over a real `@stargantt/core` host
 * (docs/specs/plugins/resource.md §3.3): dormancy (§6), the `grid/columns` contribution, click-to-
 * open/Apply/Cancel/Escape through the delegated root listeners, one undo step per commit
 * (`data/didApplyTransaction`), and chip drag-reassign between two cells.
 *
 * The tree-grid plugin itself is not composed (its full chart-layout stack is out of scope here);
 * instead a tiny local plugin declares the `grid/columns` extension point (as tree-grid itself
 * would) so the contributed `ColumnDef` can be captured and its `render`/`getValue` driven
 * directly — the same "drive the real ColumnDef, don't reach into wire.ts internals" approach the
 * earlier implementation's own interaction tests used. A mock `stargantt.grid` service satisfies
 * the area's `lifecycle/ready` presence gate (§9's optional-inert timing rule) so the delegated listeners
 * actually wire up.
 */
import { collect, definePlugin } from "@stargantt/core";
import type { Plugin } from "@stargantt/core";
import { dataStore } from "@stargantt/plugin-data-store";
import type { DataService } from "@stargantt/plugin-data-store";
import type { ColumnDef } from "@stargantt/plugin-tree-grid";
import { createTestHost } from "@stargantt/sdk";
import type { TestHost } from "@stargantt/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { resource } from "../src/index";
import type { ResourceConfig } from "../src/config";

// The `ColumnDef` type import above already pulls in tree-grid's own
// `declare module "@stargantt/core" { interface ExtensionPoints { "grid/columns": ... } }`
// augmentation, so `ctx.defineExtensionPoint("grid/columns", ...)` below type-checks without this
// file redeclaring it.

/** A stand-in for tree-grid's own `grid/columns` declaration, so contributions can be read back. */
function columnCapture(): { plugin: Plugin<void>; columns(): ColumnDef[] } {
  let read: (() => ColumnDef[]) | undefined;
  const plugin = definePlugin<void>({
    meta: { id: "test.column-capture" },
    setup(ctx) {
      const point = ctx.defineExtensionPoint("grid/columns", collect<ColumnDef>());
      read = () => point.get();
    },
  });
  return { plugin, columns: () => read?.() ?? [] };
}

let harness: TestHost | undefined;
afterEach(() => {
  harness?.dispose();
  harness = undefined;
  document.body.innerHTML = "";
});

function boot(config: ResourceConfig): { host: TestHost; root: HTMLElement; columns(): ColumnDef[] } {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const capture = columnCapture();
  harness = createTestHost({
    plugins: [dataStore(), capture.plugin, resource(config)],
    element: root,
    // Satisfies the area's `lifecycle/ready` presence gate on tree-grid's service without pulling
    // the whole chart-layout stack into this test.
    services: { "stargantt.grid": {} },
  });
  return { host: harness, root, columns: capture.columns };
}

function seed(data: DataService): void {
  data.load({
    tasks: [
      { id: "t1", name: "Alpha", start: 0, end: 86_400_000, parentId: null },
      { id: "t2", name: "Beta", start: 0, end: 86_400_000, parentId: null },
    ],
    resources: [{ id: "s1", name: "StoreOnly" }],
    assignments: [],
  });
}

function renderCell(columns: ColumnDef[], root: HTMLElement, taskId: string): HTMLElement {
  const column = columns.find((c) => c.id === "resource.resources");
  if (column === undefined) throw new Error("resource.resources column missing");
  const cell = document.createElement("div");
  root.appendChild(cell);
  column.render(cell, { id: taskId, name: taskId, start: 0, end: 1, parentId: null } as never);
  return cell;
}

describe("dormancy (§6)", () => {
  it("contributes no column and boots without throwing when `assign` is omitted", () => {
    const b = boot({ pool: { resources: [{ id: "p1", name: "Ana" }] } });
    expect(b.columns().find((c) => c.id === "resource.resources")).toBeUndefined();
  });

  it("does not throw in a headless composition with no `element` at all", () => {
    const capture = columnCapture();
    const h = createTestHost({
      plugins: [dataStore(), capture.plugin, resource({ assign: {} })],
      // No `element`: falls back to a Node-only stand-in with no DOM API — the delegated listener
      // wiring must not run synchronously against it.
    });
    expect(() => h.host).not.toThrow();
    h.dispose();
  });
});

describe("the grid/columns contribution", () => {
  it("contributes id `resource.resources` with the configured header/width", () => {
    const b = boot({ assign: { columnWidth: 200 } });
    const column = b.columns().find((c) => c.id === "resource.resources");
    expect(column).toBeDefined();
    expect(column?.header).toBe("Resources");
    expect(column?.width).toBe(200);
    expect(column?.setValue).toBeUndefined();
    expect(column?.editor).toBeUndefined();
  });

  it("renders the cell's chips and matches getValue's comma-joined text as its title", () => {
    const b = boot({ assign: {} });
    const data = b.host.host.service("stargantt.data");
    seed(data);
    data.load({
      tasks: [{ id: "t1", name: "Alpha", start: 0, end: 1, parentId: null }],
      resources: [{ id: "s1", name: "StoreOnly" }],
      assignments: [{ taskId: "t1", resourceId: "s1", units: 0.5 }],
    });
    const cell = renderCell(b.columns(), b.root, "t1");
    expect(cell.querySelectorAll(".sg-ra-chip")).toHaveLength(1);
    expect(cell.getAttribute("title")).toBe("StoreOnly 50%");
    const column = b.columns().find((c) => c.id === "resource.resources")!;
    expect(column.getValue({ id: "t1" } as never)).toBe("StoreOnly 50%");
  });
});

describe("editor open/apply/cancel through the delegated listeners", () => {
  it("opens the editor on cell click, applies the diff as one undo step, and closes", () => {
    const b = boot({ assign: {}, pool: { resources: [{ id: "p1", name: "Ana" }] } });
    const data = b.host.host.service("stargantt.data");
    seed(data);
    const cell = renderCell(b.columns(), b.root, "t1");

    let transactions = 0;
    const origins: string[] = [];
    b.host.host.on("data/didApplyTransaction", (e) => {
      transactions += 1;
      origins.push(e.transaction.origin);
    });

    cell.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const dialog = b.root.querySelector<HTMLElement>(".sg-ra-editor");
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("role")).toBe("dialog");

    // Assign the pool-only resource Ana at 25% — requires a resource/add mirror plus assignment/set.
    const row = dialog!.querySelectorAll(".sg-ra-row")[0]!;
    (row.querySelector('input[type="checkbox"]') as HTMLInputElement).checked = true;
    (row.querySelector(".sg-ra-units") as HTMLInputElement).value = "25";
    dialog!.querySelector<HTMLButtonElement>(".sg-ra-apply")!.click();

    expect(b.root.querySelector(".sg-ra-editor")).toBeNull();
    expect(transactions).toBe(1); // one undo step for the mirror + the assignment together
    expect(origins[0]).toMatch(/^stargantt\.resource\/assign-apply#/);
    expect(data.query().assignmentsByTask.get("t1")).toMatchObject([{ resourceId: "p1", units: 0.25 }]);
    expect(data.query().resources.has("p1")).toBe(true);
  });

  it("commits nothing on Cancel or Escape", () => {
    const b = boot({ assign: {} });
    const data = b.host.host.service("stargantt.data");
    seed(data);
    const cell = renderCell(b.columns(), b.root, "t1");
    let transactions = 0;
    b.host.host.on("data/didApplyTransaction", () => {
      transactions += 1;
    });

    cell.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    b.root.querySelector<HTMLButtonElement>(".sg-ra-cancel")?.click();
    expect(b.root.querySelector(".sg-ra-editor")).toBeNull();

    cell.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const dialog = b.root.querySelector<HTMLElement>(".sg-ra-editor")!;
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(b.root.querySelector(".sg-ra-editor")).toBeNull();
    expect(transactions).toBe(0);
  });

  it("cancels on a pointerdown outside the editor card, committing nothing", () => {
    const b = boot({ assign: {} });
    const data = b.host.host.service("stargantt.data");
    seed(data);
    const cell = renderCell(b.columns(), b.root, "t1");
    cell.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(b.root.querySelector(".sg-ra-editor")).not.toBeNull();

    document.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(b.root.querySelector(".sg-ra-editor")).toBeNull();
  });
});

describe("drag reassign", () => {
  function dragEvent(type: string): Event {
    const evt = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(evt, "dataTransfer", { value: { setData: () => undefined }, configurable: true });
    return evt;
  }

  it("moves the assignment to the drop target's task, keeping units, as one undo step", () => {
    const b = boot({ assign: {} });
    const data = b.host.host.service("stargantt.data");
    seed(data);
    data.load({
      tasks: [
        { id: "t1", name: "Alpha", start: 0, end: 1, parentId: null },
        { id: "t2", name: "Beta", start: 0, end: 1, parentId: null },
      ],
      resources: [{ id: "s1", name: "StoreOnly" }],
      assignments: [{ taskId: "t1", resourceId: "s1", units: 0.6 }],
    });
    const c1 = renderCell(b.columns(), b.root, "t1");
    const c2 = renderCell(b.columns(), b.root, "t2");
    const chip = c1.querySelector<HTMLElement>(".sg-ra-chip")!;

    let transactions = 0;
    b.host.host.on("data/didApplyTransaction", () => {
      transactions += 1;
    });

    chip.dispatchEvent(dragEvent("dragstart"));
    c2.dispatchEvent(dragEvent("dragover"));
    c2.dispatchEvent(dragEvent("drop"));
    c2.dispatchEvent(dragEvent("dragend"));

    expect(data.query().assignmentsByTask.get("t1")).toBeUndefined();
    expect(data.query().assignmentsByTask.get("t2")).toMatchObject([{ resourceId: "s1", units: 0.6 }]);
    expect(transactions).toBe(1);
  });

  it("does nothing when the drag ends without a drop", () => {
    const b = boot({ assign: {} });
    const data = b.host.host.service("stargantt.data");
    seed(data);
    data.load({
      tasks: [
        { id: "t1", name: "Alpha", start: 0, end: 1, parentId: null },
        { id: "t2", name: "Beta", start: 0, end: 1, parentId: null },
      ],
      resources: [{ id: "s1", name: "StoreOnly" }],
      assignments: [{ taskId: "t1", resourceId: "s1", units: 0.6 }],
    });
    const c1 = renderCell(b.columns(), b.root, "t1");
    renderCell(b.columns(), b.root, "t2");
    const chip = c1.querySelector<HTMLElement>(".sg-ra-chip")!;
    chip.dispatchEvent(dragEvent("dragstart"));
    chip.dispatchEvent(dragEvent("dragend"));
    expect(data.query().assignmentsByTask.get("t1")).toMatchObject([{ resourceId: "s1", units: 0.6 }]);
  });

  it("is fully disabled (no chip attribute, no move) when `dragReassign: false`", () => {
    const b = boot({ assign: { dragReassign: false } });
    const data = b.host.host.service("stargantt.data");
    data.load({
      tasks: [
        { id: "t1", name: "Alpha", start: 0, end: 1, parentId: null },
        { id: "t2", name: "Beta", start: 0, end: 1, parentId: null },
      ],
      resources: [{ id: "s1", name: "StoreOnly" }],
      assignments: [{ taskId: "t1", resourceId: "s1", units: 0.6 }],
    });
    const c1 = renderCell(b.columns(), b.root, "t1");
    const c2 = renderCell(b.columns(), b.root, "t2");
    const chip = c1.querySelector<HTMLElement>(".sg-ra-chip")!;
    expect(chip.getAttribute("draggable")).toBeNull();

    chip.dispatchEvent(dragEvent("dragstart"));
    c2.dispatchEvent(dragEvent("drop"));
    expect(data.query().assignmentsByTask.get("t1")).toMatchObject([{ resourceId: "s1", units: 0.6 }]);
  });
});
