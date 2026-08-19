// @vitest-environment happy-dom
/**
 * Wire-level integration tests for the `contextMenu` feature: what `wireContextMenu` actually does
 * once installed as `ArbiterContextMenu` behind a real gesture arbiter, over a real
 * `@stargantt/core` host. The built-in entries and insert-placement rules have their own hostless
 * unit tests (`context-menu-builtins.test.ts`); the widget's DOM/keyboard behavior has its own
 * `context-menu-menu.test.ts`; this file is about the wiring: opening per target kind through the
 * arbiter, native-menu suppression, outside-press close, `view/scrolled` and tasks-store freshness,
 * the `contextmenu/items` extension point, `insertMode`, and message overrides.
 *
 * docs/specs/plugins/interaction.md §6.5, §1.3 ("context" state).
 */
import { describe, expect, it } from "vitest";
import { createTestHost, mockStore } from "@stargantt/sdk";
import type { AnyPlugin, PluginContext } from "@stargantt/core";
import type { Task, TaskId } from "@stargantt/plugin-data-store";
import { interaction } from "../src/index";
import type { InteractionConfig } from "../src/index";

const TASKS: readonly Task[] = [
  { id: "a", parentId: null, name: "Alpha", start: 100, end: 200 },
  { id: "b", parentId: null, name: "Beta", start: 300, end: 400 },
];

function provider(id: string, services: Record<string, unknown>): AnyPlugin {
  return {
    meta: { id },
    setup(ctx): void {
      for (const [key, impl] of Object.entries(services)) ctx.provide(key as never, impl as never);
    },
  };
}

const rightPress = {
  pointerId: 1,
  clientX: 5,
  clientY: 5,
  buttons: 2,
  button: 2,
  ctrlKey: false,
  type: "pointerdown",
};

function boot(config: InteractionConfig = {}, extra: AnyPlugin[] = []) {
  const byId = new Map<TaskId, Task>(TASKS.map((t) => [t.id, t]));
  const tasksStore = mockStore<ReadonlyMap<TaskId, Task>>(new Map(byId));
  const links = new Map<string, unknown>();
  const linksStore = mockStore(new Map(links));

  const root = document.createElement("div");
  const overlay = document.createElement("div");
  overlay.className = "sg-dom-overlay";
  root.appendChild(overlay);
  const gridPane = document.createElement("div");
  gridPane.className = "sg-pane--grid";
  root.appendChild(gridPane);
  document.body.appendChild(root);

  const dispatched: { key: string; payload: unknown }[] = [];

  const dataStore = provider("stargantt.data-store", {
    "stargantt.data": {
      getTask: (id: TaskId) => byId.get(id),
      taskIds: () => byId.keys(),
      query: () => ({ byId, children: new Map([[null, [...byId.keys()]]]) }),
      tasks: tasksStore,
      links: linksStore,
    },
  });
  const view = provider("stargantt.view", {
    "stargantt.view": {
      invalidate: () => {},
      viewport: mockStore({ scrollLeft: 0, scrollTop: 0, width: 800, height: 600 }),
      scrollTo: () => {},
      chartPaneElement: () => root,
    },
    "stargantt.timeline": {
      tToX: (t: number) => t,
      xToT: (x: number) => x,
      pxPerMs: 1,
      zoomLevel: mockStore({ id: "day", pxPerDay: 86.4, scales: [{ unit: "day", format: () => "" }] }),
      requestOriginExtension: () => {},
      releaseOriginExtension: () => {},
      gridCellAt: (t: number) => {
        const DAY = 86_400_000;
        const start = Math.floor(t / DAY) * DAY;
        return { start, end: start + DAY };
      },
    },
    "stargantt.theme": { get: () => "" },
  });
  const treeGrid = provider("stargantt.tree-grid", {
    "stargantt.rows": {
      rowCount: () => 2,
      taskIdAt: (row: number) => ["a", "b"][row],
      rowOf: (id: TaskId) => (id === "a" ? 0 : id === "b" ? 1 : undefined),
      rowHeight: () => 24,
      yOf: (row: number) => row * 24,
      rowAtY: (y: number) => Math.min(1, Math.max(0, Math.floor(y / 24))),
      totalHeight: () => 48,
      isExpanded: () => true,
    },
    "stargantt.grid": { setSelected: () => {} },
  });
  const taskBars = provider("stargantt.task-bars", {
    "stargantt.task-bars": {
      barRect: () => undefined,
      barBoxOf: () => undefined,
      visibleBoxes: () => [],
      hasOwnBar: () => false,
    },
  });

  const commandProbe: AnyPlugin = {
    meta: { id: "test.probe" },
    setup(ctx): void {
      const record = (name: string) => (payload: unknown) => dispatched.push({ key: name, payload });
      ctx.registerCommand("task/move" as never, (() => {}) as never);
      ctx.registerCommand("task/setProgress" as never, (() => {}) as never);
      ctx.registerCommand("task/update" as never, (() => {}) as never);
      ctx.registerCommand("view/dropIndicator" as never, (() => {}) as never);
      ctx.registerCommand("task/add" as never, ((payload: { task: Partial<Task> & { name: string } }) => {
        const id = `new-${byId.size}`;
        const created: Task = {
          id,
          parentId: payload.task.parentId ?? null,
          name: payload.task.name,
          start: payload.task.start ?? 0,
          end: payload.task.end ?? 0,
          ...(payload.task.progress !== undefined ? { progress: payload.task.progress } : {}),
          ...(payload.task.type !== undefined ? { type: payload.task.type } : {}),
        };
        byId.set(id, created);
        tasksStore.set(new Map(byId));
        record("task/add")(payload);
      }) as never);
      ctx.registerCommand("task/remove" as never, ((payload: { ids: TaskId[] }) => {
        for (const id of payload.ids) byId.delete(id);
        tasksStore.set(new Map(byId));
        record("task/remove")(payload);
      }) as never);
      ctx.registerCommand("link/add" as never, ((payload: unknown) => {
        record("link/add")(payload);
      }) as never);
      ctx.registerCommand("view/rowToggle" as never, ((payload: unknown) => {
        record("view/rowToggle")(payload);
      }) as never);
      ctx.registerCommand("view/rowInsert" as never, ((payload: unknown) => {
        record("view/rowInsert")(payload);
      }) as never);
    },
  };

  // contextMenu is opt-in (disabled when the nest is omitted, §6): every test in this file wants
  // it enabled, so the caller's config gets a `contextMenu: {}` default unless it names one itself.
  const resolvedConfig: InteractionConfig = {
    ...config,
    contextMenu: config.contextMenu ?? {},
  };
  const plugins: AnyPlugin[] = [dataStore, view, treeGrid, taskBars, commandProbe, interaction(resolvedConfig), ...extra];
  const test = createTestHost({ element: root, plugins });
  const faults: { pluginId: string; error: unknown }[] = [];
  test.host.on("core/pluginError", (e) => faults.push(e));

  return {
    ctx: test.ctxOf("stargantt.interaction") as PluginContext,
    root,
    overlay,
    gridPane,
    faults,
    byId,
    tasksStore,
    dispatched,
    dispose: () => test.dispose(),
  };
}

function menuEl(root: HTMLElement): HTMLElement | null {
  return root.querySelector(".sg-context-menu");
}

function labels(root: HTMLElement): string[] {
  return [...root.querySelectorAll(".sg-context-menu-item")].map((e) => e.textContent);
}

/** A `PointerEvent` stand-in with a real, observable `preventDefault`/`defaultPrevented` pair. */
function fakePointerEvent(over: Record<string, unknown> = {}): PointerEvent {
  let defaultPrevented = false;
  return {
    ...rightPress,
    ...over,
    get defaultPrevented(): boolean {
      return defaultPrevented;
    },
    preventDefault(): void {
      defaultPrevented = true;
    },
  } as unknown as PointerEvent;
}

function rightDown(b: ReturnType<typeof boot>, id: TaskId | "background", kind = "bar"): PointerEvent {
  const event = fakePointerEvent();
  if (id === "background") {
    b.ctx.emit("pointer/background", { x: 5, y: 5, event });
  } else {
    b.ctx.emit("pointer/barDown", { hit: { kind, id, cursor: "default" }, x: 5, y: 5, event });
  }
  return event;
}

describe("opening (§1.3, §6.5)", () => {
  it("opens on a right-press on a bar with the built-in entries", () => {
    const b = boot();
    rightDown(b, "a");
    expect(menuEl(b.root)).not.toBeNull();
    expect(labels(b.root)).toEqual([
      "Insert task",
      "Duplicate task",
      "Delete task",
      "Start link from here",
      "Link here from source",
    ]);
    expect(menuEl(b.root)?.getAttribute("aria-label")).toBe("Context menu");
    b.dispose();
  });

  it("opens on a right-press on empty chart space with a single insert entry", () => {
    const b = boot();
    rightDown(b, "background");
    expect(labels(b.root)).toEqual(["Insert task"]);
    b.dispose();
  });

  it("does not open on a left press, and a left press closes an open menu", () => {
    const b = boot();
    b.ctx.emit("pointer/barDown", {
      hit: { kind: "bar", id: "a", cursor: "default" },
      x: 0,
      y: 0,
      event: { pointerId: 1, clientX: 0, clientY: 0, buttons: 1, button: 0, type: "pointerdown" } as unknown as PointerEvent,
    });
    expect(menuEl(b.root)).toBeNull();
    b.ctx.emit("pointer/barUp", {
      hit: { kind: "bar", id: "a", cursor: "default" },
      x: 0,
      y: 0,
      event: { pointerId: 1, clientX: 0, clientY: 0, buttons: 0, type: "pointerup" } as unknown as PointerEvent,
    });
    rightDown(b, "a");
    expect(menuEl(b.root)).not.toBeNull();
    b.ctx.emit("pointer/barDown", {
      hit: { kind: "bar", id: "b", cursor: "default" },
      x: 0,
      y: 0,
      event: { pointerId: 1, clientX: 0, clientY: 0, buttons: 1, button: 0, type: "pointerdown" } as unknown as PointerEvent,
    });
    expect(menuEl(b.root)).toBeNull();
    b.dispose();
  });

  it("a further right-press re-opens for the new target", () => {
    const b = boot();
    rightDown(b, "a");
    rightDown(b, "background");
    expect(labels(b.root)).toEqual(["Insert task"]);
    b.dispose();
  });

  it("Ctrl + primary press opens the menu like a right-press (§1.1 isMenuPress)", () => {
    const b = boot();
    const event = { pointerId: 1, clientX: 0, clientY: 0, buttons: 1, button: 0, ctrlKey: true, type: "pointerdown" };
    b.ctx.emit("pointer/barDown", {
      hit: { kind: "bar", id: "a", cursor: "default" },
      x: 0,
      y: 0,
      event: event as unknown as PointerEvent,
    });
    expect(menuEl(b.root)).not.toBeNull();
    b.dispose();
  });

  it("mounts in the DOM overlay for chart-pane targets, under the root when there is none", () => {
    const b = boot();
    rightDown(b, "a");
    expect(b.overlay.querySelector(".sg-context-menu")).not.toBeNull();
    b.dispose();
  });

  it("prevents the default of the opening pointerdown", () => {
    const b = boot();
    const event = rightDown(b, "a");
    expect(menuEl(b.root)).not.toBeNull();
    expect(event.defaultPrevented).toBe(true);
    b.dispose();
  });

  it("does not prevent the default of a right-press whose resolution is empty", () => {
    const b = boot();
    const event = fakePointerEvent();
    b.ctx.emit("pointer/barDown", {
      hit: { kind: "link", id: "x", cursor: "default" },
      x: 0,
      y: 0,
      event,
    });
    expect(menuEl(b.root)).toBeNull();
    expect(event.defaultPrevented).toBe(false);
    b.dispose();
  });

  it("with the store cleared (an unknown id), built-ins contribute nothing and the menu does not open", () => {
    // Review round 1 minor-6 rename: the interaction plugin always has a store (hard dependency), so
    // this cannot simulate "no store" — it clears every task instead, simulating "no usable data" for
    // the pressed id. The built-in provider still runs, but resolves nothing for an unknown id (a
    // background insert's row lookup is unaffected by this and still offers Insert). This exercises
    // the "hit resolves to nothing" branch instead.
    const b = boot();
    b.byId.clear();
    rightDown(b, "a");
    expect(menuEl(b.root)).toBeNull();
    b.dispose();
  });

  it("dispose removes an open menu", () => {
    const b = boot();
    rightDown(b, "a");
    expect(menuEl(b.root)).not.toBeNull();
    b.dispose();
    expect(b.root.querySelector(".sg-context-menu")).toBeNull();
  });
});

describe("native-menu suppression", () => {
  it("suppresses the native menu only while its own menu is open", () => {
    const b = boot();
    const nativeA = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    b.ctx.emit("pointer/barDown", {
      hit: { kind: "link", id: "x", cursor: "default" },
      x: 0,
      y: 0,
      event: fakePointerEvent(),
    });
    b.root.dispatchEvent(nativeA);
    expect(nativeA.defaultPrevented).toBe(false);

    rightDown(b, "a");
    const nativeB = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    b.root.dispatchEvent(nativeB);
    expect(nativeB.defaultPrevented).toBe(true);
    b.dispose();
  });
});

describe("outside-press close", () => {
  it("closes on a document pointerdown outside the menu, not on one inside", () => {
    const b = boot();
    rightDown(b, "a");
    const entry = b.root.querySelector<HTMLElement>(".sg-context-menu-item")!;
    // A press inside the menu (dispatched on an entry, bubbling to document) must not close it.
    entry.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(menuEl(b.root)).not.toBeNull();
    b.root.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(menuEl(b.root)).toBeNull();
    b.dispose();
  });
});

describe("Escape (via the arbiter and the widget)", () => {
  it("closes the menu and leaves the arbiter's context state (a fresh press reopens cleanly)", () => {
    const b = boot();
    rightDown(b, "a");
    expect(menuEl(b.root)).not.toBeNull();
    b.root.ownerDocument.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menuEl(b.root)).toBeNull();
    // The arbiter must have left `context`: a plain bar press now selects instead of being eaten.
    rightDown(b, "b");
    expect(labels(b.root)).toEqual([
      "Insert task",
      "Duplicate task",
      "Delete task",
      "Start link from here",
      "Link here from source",
    ]);
    b.dispose();
  });
});

describe("view/scrolled and freshness close the menu", () => {
  it("closes on scroll", () => {
    const b = boot();
    rightDown(b, "a");
    b.ctx.emit("view/scrolled", { scrollTop: 5, scrollLeft: 0 });
    expect(menuEl(b.root)).toBeNull();
    b.dispose();
  });

  it("closes on a tasks store change", () => {
    const b = boot();
    rightDown(b, "a");
    b.tasksStore.set(new Map(b.byId));
    expect(menuEl(b.root)).toBeNull();
    b.dispose();
  });

  it("drops a pending link source whose task disappears", () => {
    const b = boot();
    rightDown(b, "a");
    const from = [...b.root.querySelectorAll(".sg-context-menu-item")].find(
      (e) => e.textContent === "Start link from here",
    )!;
    from.dispatchEvent(new Event("click", { bubbles: true }));
    b.byId.delete("a");
    b.tasksStore.set(new Map(b.byId));
    rightDown(b, "b");
    const linkTo = [...b.root.querySelectorAll(".sg-context-menu-item")].find(
      (e) => e.textContent === "Link here from source",
    );
    expect(linkTo?.getAttribute("aria-disabled")).toBe("true");
    b.dispose();
  });
});

// The pending link-source invocation must expire when a LATER, untouched menu invocation closes —
// regardless of which of the four close paths drives that close. `beginInvocation()` (inside
// `openWith()`) resets
// the "touched" flag on every actual open; each scenario below arms the source from task "a", opens
// a second, untouched menu on task "b", closes it via one specific path, then re-opens on "b" to
// check the source expired: "Cancel link" is gone and "Link here from source" is disabled again.
describe("link-source invocation lifetime across every close path (B1)", () => {
  function armFromA(b: ReturnType<typeof boot>): void {
    rightDown(b, "a");
    const from = [...b.root.querySelectorAll(".sg-context-menu-item")].find(
      (e) => e.textContent === "Start link from here",
    )!;
    from.dispatchEvent(new Event("click", { bubbles: true }));
  }

  function expectExpired(b: ReturnType<typeof boot>): void {
    rightDown(b, "b");
    expect(labels(b.root)).not.toContain("Cancel link");
    const linkTo = [...b.root.querySelectorAll(".sg-context-menu-item")].find(
      (e) => e.textContent === "Link here from source",
    );
    expect(linkTo?.getAttribute("aria-disabled")).toBe("true");
  }

  it("expires across an outside-press close that never re-touches it", () => {
    const b = boot();
    armFromA(b);
    rightDown(b, "b"); // a second, untouched invocation
    b.root.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expectExpired(b);
    b.dispose();
  });

  it("expires across a view/scrolled close that never re-touches it", () => {
    const b = boot();
    armFromA(b);
    rightDown(b, "b");
    b.ctx.emit("view/scrolled", { scrollTop: 5, scrollLeft: 0 });
    expectExpired(b);
    b.dispose();
  });

  it("expires across a tasks-freshness close that never re-touches it", () => {
    const b = boot();
    armFromA(b);
    rightDown(b, "b");
    b.tasksStore.set(new Map(b.byId));
    expectExpired(b);
    b.dispose();
  });

  it("expires across an arbiter-driven close (Escape) that never re-touches it", () => {
    const b = boot();
    armFromA(b);
    rightDown(b, "b");
    b.root.ownerDocument.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expectExpired(b);
    b.dispose();
  });

  it("stays armed when the later invocation re-touches it", () => {
    const b = boot();
    armFromA(b); // armed on "a"
    rightDown(b, "b");
    const from = [...b.root.querySelectorAll(".sg-context-menu-item")].find(
      (e) => e.textContent === "Start link from here",
    )!;
    from.dispatchEvent(new Event("click", { bubbles: true })); // re-arms on "b"
    rightDown(b, "a");
    const linkTo = [...b.root.querySelectorAll(".sg-context-menu-item")].find(
      (e) => e.textContent === "Link here from source",
    );
    // `aria-disabled` is only ever set to `"true"` (menu.ts) — an enabled entry carries no such
    // attribute at all, never `"false"`.
    expect(linkTo?.getAttribute("aria-disabled")).toBeNull();
    b.dispose();
  });
});

describe("built-in entries and activation", () => {
  it("delete removes the hit task and closes the menu", () => {
    const b = boot();
    rightDown(b, "b");
    const del = [...b.root.querySelectorAll(".sg-context-menu-item")].find((e) => e.textContent === "Delete task")!;
    del.dispatchEvent(new Event("click", { bubbles: true }));
    expect(menuEl(b.root)).toBeNull();
    expect(b.byId.has("b")).toBe(false);
    b.dispose();
  });

  it("insert on the background creates a top-level task via task/add", () => {
    const b = boot();
    rightDown(b, "background");
    const insert = [...b.root.querySelectorAll(".sg-context-menu-item")].find((e) => e.textContent === "Insert task")!;
    insert.dispatchEvent(new Event("click", { bubbles: true }));
    expect(b.dispatched.some((d) => d.key === "task/add")).toBe(true);
    b.dispose();
  });

  it("creates an FS link with the two-step gesture", () => {
    const b = boot();
    rightDown(b, "a");
    const start = [...b.root.querySelectorAll(".sg-context-menu-item")].find(
      (e) => e.textContent === "Start link from here",
    )!;
    start.dispatchEvent(new Event("click", { bubbles: true }));
    rightDown(b, "b");
    const linkTo = [...b.root.querySelectorAll(".sg-context-menu-item")].find(
      (e) => e.textContent === "Link here from source",
    )!;
    linkTo.dispatchEvent(new Event("click", { bubbles: true }));
    expect(b.dispatched).toContainEqual({
      key: "link/add",
      payload: { sourceId: "a", targetId: "b", type: "FS" },
    });
    b.dispose();
  });
});

describe("insertMode config (§6.5)", () => {
  it("child by default", () => {
    const b = boot();
    rightDown(b, "a");
    const insert = [...b.root.querySelectorAll(".sg-context-menu-item")].find((e) => e.textContent === "Insert task")!;
    insert.dispatchEvent(new Event("click", { bubbles: true }));
    const add = b.dispatched.find((d) => d.key === "task/add");
    expect((add?.payload as { task: { parentId: unknown } }).task.parentId).toBe("a");
    b.dispose();
  });

  it("sibling when configured", () => {
    const b = boot({ contextMenu: { insertMode: "sibling" } });
    rightDown(b, "a");
    const insert = [...b.root.querySelectorAll(".sg-context-menu-item")].find((e) => e.textContent === "Insert task")!;
    insert.dispatchEvent(new Event("click", { bubbles: true }));
    const add = b.dispatched.find((d) => d.key === "task/add");
    expect((add?.payload as { task: { parentId: unknown } }).task.parentId).toBeNull();
    b.dispose();
  });
});

describe("ContextMenuConfig.items (§6.5)", () => {
  it("a function replaces the built-ins", () => {
    const b = boot({ contextMenu: { items: () => [{ id: "mine", label: "Custom", run: () => {} }] } });
    rightDown(b, "a");
    expect(labels(b.root)).toEqual(["Custom"]);
    b.dispose();
  });

  it("null removes the built-ins entirely", () => {
    const b = boot({ contextMenu: { items: null } });
    rightDown(b, "a");
    expect(menuEl(b.root)).toBeNull();
    b.dispose();
  });
});

describe("contextmenu/items extension point (§3, collect)", () => {
  function contributor(f: () => Array<{ id: string; label: string; run(): void }>, id = "test.c1"): AnyPlugin {
    return {
      meta: { id, dependsOn: ["stargantt.interaction"] },
      setup(ctx): void {
        ctx.contribute("contextmenu/items" as never, f as never);
      },
    };
  }

  it("appends contributed entries after the built-ins", () => {
    const b = boot({}, [contributor(() => [{ id: "x", label: "Extra", run: () => {} }])]);
    rightDown(b, "a");
    expect(labels(b.root).at(-1)).toBe("Extra");
    b.dispose();
  });

  it("guards a throwing provider: reports a fault under the plugin's id, other entries survive", () => {
    const b = boot({}, [
      contributor(() => {
        throw new Error("boom");
      }, "test.bad"),
    ]);
    rightDown(b, "a");
    expect(labels(b.root)).toContain("Insert task"); // built-ins survive
    expect(b.faults).toHaveLength(1);
    expect(b.faults[0]?.pluginId).toBe("stargantt.interaction");
    b.dispose();
  });
});

describe("messages (§8)", () => {
  it("replaces a label, keeping other defaults", () => {
    const b = boot({ messages: { insertTask: "Neu" } });
    rightDown(b, "background");
    expect(labels(b.root)).toEqual(["Neu"]);
    b.dispose();
  });
});

describe("the grid-row menu (§1.3, §6.5)", () => {
  it("opens on a grid row with the same entries a bar gives, mounted in the grid pane", () => {
    const b = boot();
    b.ctx.emit("grid/rowContextMenu", { id: "a", row: 0, x: 10, y: 10 });
    expect(b.gridPane.querySelector(".sg-context-menu")).not.toBeNull();
    expect(b.overlay.querySelector(".sg-context-menu")).toBeNull();
    expect(labels(b.root)).toEqual([
      "Insert task",
      "Duplicate task",
      "Delete task",
      "Start link from here",
      "Link here from source",
    ]);
    b.dispose();
  });

  it("acts on the row's own task", () => {
    const b = boot();
    b.ctx.emit("grid/rowContextMenu", { id: "b", row: 1, x: 0, y: 0 });
    const del = [...b.root.querySelectorAll(".sg-context-menu-item")].find((e) => e.textContent === "Delete task")!;
    del.dispatchEvent(new Event("click", { bubbles: true }));
    expect(b.byId.has("b")).toBe(false);
    b.dispose();
  });

  it("opens nothing for a row whose task has left the store", () => {
    const b = boot();
    b.byId.delete("a");
    b.ctx.emit("grid/rowContextMenu", { id: "a", row: 0, x: 0, y: 0 });
    expect(menuEl(b.root)).toBeNull();
    b.dispose();
  });
});

describe("the grid blank-area menu (§1.3, §6.5)", () => {
  it("opens with a single insert entry, mounted in the grid pane", () => {
    const b = boot();
    b.ctx.emit("grid/backgroundContextMenu", { x: 30, y: 90 });
    expect(menuEl(b.root)).not.toBeNull();
    expect(labels(b.root)).toEqual(["Insert task"]);
    expect(b.gridPane.querySelector(".sg-context-menu")).not.toBeNull();
    b.dispose();
  });

  it("activating insert dispatches view/rowInsert named by the newTaskName catalog default", () => {
    const b = boot();
    b.ctx.emit("grid/backgroundContextMenu", { x: 0, y: 0 });
    const insert = [...b.root.querySelectorAll(".sg-context-menu-item")].find((e) => e.textContent === "Insert task")!;
    insert.dispatchEvent(new Event("click", { bubbles: true }));
    expect(b.dispatched).toContainEqual({ key: "view/rowInsert", payload: { name: "New task" } });
    b.dispose();
  });

  it("re-opens for the row menu after the grid-background menu was open (§1.3 context re-entry)", () => {
    const b = boot();
    b.ctx.emit("grid/backgroundContextMenu", { x: 0, y: 0 });
    expect(labels(b.root)).toEqual(["Insert task"]);
    b.ctx.emit("grid/rowContextMenu", { id: "a", row: 0, x: 0, y: 0 });
    expect(labels(b.root)).toEqual([
      "Insert task",
      "Duplicate task",
      "Delete task",
      "Start link from here",
      "Link here from source",
    ]);
    b.dispose();
  });
});
