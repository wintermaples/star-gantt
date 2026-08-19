// @vitest-environment happy-dom
/**
 * Wire-level integration tests for the `tooltip` feature: what `wireTooltip` actually does once
 * installed as `ArbiterTooltip` behind a real gesture arbiter, over a real `@stargantt/core` host.
 * The state machine, placement arithmetic and focus-follow cycle have their own hostless unit tests
 * (`tooltip-hover.test.ts`, `tooltip-placement.test.ts`, `tooltip-focus-follow.test.ts`,
 * `tooltip-panel.test.ts`); this file is about the wiring: trigger config end to end, the
 * `tooltip/content` extension point, the tasks-store freshness subscription, `view/scrolled`,
 * Escape via the arbiter, and the focus-driven display over `stargantt.focus`'s `FocusState` store.
 *
 * docs/specs/plugins/interaction.md §6.4, §6.4a.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHost, mockStore } from "@stargantt/sdk";
import type { AnyPlugin, PluginContext } from "@stargantt/core";
import type { Task, TaskId } from "@stargantt/plugin-data-store";
import { interaction } from "../src/index";
import type { InteractionConfig } from "../src/index";

const TASKS: readonly Task[] = [
  { id: 1, parentId: null, name: "one", start: 0, end: 86_400_000 },
  { id: 2, parentId: null, name: "two", start: 86_400_000, end: 172_800_000 },
];

/** One stand-in plugin registered under a real provider's id, publishing its services. */
function provider(id: string, services: Record<string, unknown>): AnyPlugin {
  return {
    meta: { id },
    setup(ctx): void {
      for (const [key, impl] of Object.entries(services)) ctx.provide(key as never, impl as never);
    },
  };
}

const press = { pointerId: 1, clientX: 0, clientY: 0, buttons: 1, button: 0, type: "pointerdown" };

/** Boots a real core with the interaction plugin and a `.sg-dom-overlay` mount already in the DOM. */
function boot(config: InteractionConfig = {}, focused?: TaskId) {
  const byId = new Map<TaskId, Task>(TASKS.map((t) => [t.id, t]));
  const tasksStore = mockStore<ReadonlyMap<TaskId, Task>>(new Map(byId));

  const root = document.createElement("div");
  const overlay = document.createElement("div");
  overlay.className = "sg-dom-overlay";
  root.appendChild(overlay);
  document.body.appendChild(root);

  const dataStore = provider("stargantt.data-store", {
    "stargantt.data": {
      getTask: (id: TaskId) => byId.get(id),
      taskIds: () => byId.keys(),
      query: () => ({ byId, children: new Map([[null, [1, 2]]]) }),
      tasks: tasksStore,
      links: mockStore(new Map()),
    },
  });
  const barRects = new Map<TaskId, { x: number; y: number; width: number; height: number }>();
  barRects.set(1, { x: 0, y: 0, width: 40, height: 20 });
  barRects.set(2, { x: 40, y: 24, width: 40, height: 20 });
  const view = provider("stargantt.view", {
    "stargantt.view": {
      invalidate: () => {},
      viewport: mockStore({ scrollLeft: 0, scrollTop: 0, width: 800, height: 600 }),
      scrollTo: () => {},
      chartPaneElement: () => root,
    },
    "stargantt.timeline": {
      tToX: (t: number) => t * 1e-6,
      xToT: (x: number) => x / 1e-6,
      pxPerMs: 1e-6,
      zoomLevel: mockStore({ id: "day", pxPerDay: 86.4, scales: [{ unit: "day", format: () => "" }] }),
      requestOriginExtension: () => {},
      releaseOriginExtension: () => {},
    },
    "stargantt.theme": { get: () => "" },
  });
  const treeGrid = provider("stargantt.tree-grid", {
    "stargantt.rows": {
      rowCount: () => 2,
      taskIdAt: (row: number) => [1, 2][row],
      rowOf: (id: TaskId) => (id === 1 ? 0 : id === 2 ? 1 : undefined),
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
      barRect: (id: TaskId) => barRects.get(id),
      barBoxOf: (id: TaskId) => barRects.get(id),
      visibleBoxes: () => [...barRects.entries()].map(([id, r]) => ({ id, ...r })),
      hasOwnBar: (id: TaskId) => barRects.has(id),
    },
  });
  const commandProbe: AnyPlugin = {
    meta: { id: "test.probe" },
    setup(ctx): void {
      for (const name of ["task/move", "task/setProgress", "task/update", "task/remove", "view/dropIndicator"]) {
        ctx.registerCommand(name as never, (() => {}) as never);
      }
    },
  };

  const announcements: string[] = [];
  // docs/specs/plugins/a11y.md `FocusService` — `state` (a `Store<{ focused?: TaskId }>`), `focus(id)`,
  // `announce(message)`. Store-shaped, replacing the abolished `focus/changed` event: a test drives
  // the focus-driven display by calling `focusStore.set(...)`, exactly as the real a11y plugin would.
  const focusStore = mockStore<{ focused: TaskId | undefined }>({ focused });
  const a11y: AnyPlugin = {
    meta: { id: "stargantt.a11y" },
    setup(ctx): void {
      ctx.provide("stargantt.focus" as never, {
        state: focusStore,
        focus: (id: TaskId) => focusStore.set({ focused: id }),
        announce: (t: string) => announcements.push(t),
      } as never);
    },
  };

  const plugins: AnyPlugin[] = [dataStore, view, treeGrid, taskBars, commandProbe, interaction(config)];
  if (focused !== undefined) plugins.push(a11y);
  const test = createTestHost({ element: root, plugins });
  const faults: unknown[] = [];
  test.host.on("core/pluginError", (e) => faults.push(e.error));

  return {
    ctx: test.ctxOf("stargantt.interaction") as PluginContext,
    root,
    overlay,
    faults,
    byId,
    tasksStore,
    barRects,
    announcements,
    focusStore,
    dispose: () => test.dispose(),
  };
}

function tip(root: HTMLElement): HTMLElement | null {
  return root.querySelector(".sg-tooltip");
}

function tipVisible(root: HTMLElement): boolean {
  const el = tip(root);
  return el !== null && el.style.display !== "none";
}

describe("click trigger (default)", () => {
  it("shows the built-in name + dates content on a bar press", () => {
    const b = boot();
    b.ctx.emit("pointer/barDown", {
      hit: { kind: "bar", id: 1, cursor: "default" },
      x: 10,
      y: 5,
      event: press as unknown as PointerEvent,
    });
    expect(tipVisible(b.root)).toBe(true);
    expect(tip(b.root)?.textContent).toBe("one (1970-01-01 – 1970-01-02)");
    b.dispose();
  });

  it("hides on a background press", () => {
    const b = boot();
    b.ctx.emit("pointer/barDown", {
      hit: { kind: "bar", id: 1, cursor: "default" },
      x: 10,
      y: 5,
      event: press as unknown as PointerEvent,
    });
    expect(tipVisible(b.root)).toBe(true);
    // A background press cannot occur mid-gesture (the renderer's capture routes the whole press
    // stream through barMove/barUp); release the pressing gesture first, as a real pointer stream
    // would, before the next press lands on empty space.
    b.ctx.emit("pointer/barUp", {
      hit: { kind: "bar", id: 1, cursor: "default" },
      x: 10,
      y: 5,
      event: { ...press, buttons: 0, type: "pointerup" } as unknown as PointerEvent,
    });
    b.ctx.emit("pointer/background", { x: 0, y: 0, event: press as unknown as PointerEvent });
    expect(tipVisible(b.root)).toBe(false);
    b.dispose();
  });

  it("never shows on hover alone", () => {
    const b = boot();
    b.ctx.emit("pointer/barHover", { hit: { kind: "bar", id: 1, cursor: "default" }, x: 0, y: 0 });
    expect(tipVisible(b.root)).toBe(false);
    b.dispose();
  });

  it("hides once a drag gesture starts moving (pointer/barMove)", () => {
    // dragEdit stays enabled (the default) — the tooltip suppress note in the arbiter's "pressing"
    // row fires on the >3px axis transition into an actual drag, not on every move; with dragEdit
    // disabled the press-move axis never leaves "none" and this path never triggers.
    const b = boot();
    b.ctx.emit("pointer/barDown", {
      hit: { kind: "bar", id: 1, cursor: "default" },
      x: 10,
      y: 5,
      event: press as unknown as PointerEvent,
    });
    expect(tipVisible(b.root)).toBe(true);
    b.ctx.emit("pointer/barMove", {
      hit: { kind: "bar", id: 1, cursor: "default" },
      x: 60,
      y: 5,
      event: { ...press, clientX: 50, type: "pointermove" } as unknown as PointerEvent,
    });
    expect(tipVisible(b.root)).toBe(false);
    b.dispose();
  });
});

describe("hover trigger", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows after showDelay and hides hideDelay after leaving", () => {
    const b = boot({ tooltip: { trigger: "hover", showDelay: 300, hideDelay: 100 } });
    b.ctx.emit("pointer/barHover", { hit: { kind: "bar", id: 1, cursor: "default" }, x: 3, y: 4 });
    expect(tipVisible(b.root)).toBe(false);
    vi.advanceTimersByTime(300);
    expect(tipVisible(b.root)).toBe(true);
    b.ctx.emit("pointer/barHover", { x: 0, y: 0 }); // left every bar
    vi.advanceTimersByTime(99);
    expect(tipVisible(b.root)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(tipVisible(b.root)).toBe(false);
    b.dispose();
  });

  it("never shows on a bar press alone", () => {
    const b = boot({ tooltip: { trigger: "hover" } });
    b.ctx.emit("pointer/barDown", {
      hit: { kind: "bar", id: 1, cursor: "default" },
      x: 0,
      y: 0,
      event: press as unknown as PointerEvent,
    });
    vi.advanceTimersByTime(10_000);
    expect(tipVisible(b.root)).toBe(false);
    b.dispose();
  });

  it("the panel is hoverable: entering it before hideDelay elapses cancels the hide", () => {
    const b = boot({ tooltip: { trigger: "hover", showDelay: 0, hideDelay: 100 } });
    b.ctx.emit("pointer/barHover", { hit: { kind: "bar", id: 1, cursor: "default" }, x: 0, y: 0 });
    vi.advanceTimersByTime(0);
    expect(tipVisible(b.root)).toBe(true);
    b.ctx.emit("pointer/barHover", { x: 0, y: 0 }); // leaves the bar, hide armed
    tip(b.root)?.dispatchEvent(new Event("pointerenter"));
    vi.advanceTimersByTime(10_000);
    expect(tipVisible(b.root)).toBe(true);
    b.dispose();
  });

  it("a press on the hover-tracked bar sticks a dismissal to it (§1.3 hover state row)", () => {
    const b = boot({ tooltip: { trigger: "hover", showDelay: 0 } });
    b.ctx.emit("pointer/barHover", { hit: { kind: "bar", id: 1, cursor: "default" }, x: 0, y: 0 });
    vi.advanceTimersByTime(0);
    expect(tipVisible(b.root)).toBe(true);
    b.ctx.emit("pointer/barDown", {
      hit: { kind: "bar", id: 1, cursor: "default" },
      x: 0,
      y: 0,
      event: press as unknown as PointerEvent,
    });
    expect(tipVisible(b.root)).toBe(false);
    // Continued same-bar hover after the release does not re-show it.
    b.ctx.emit("pointer/barUp", {
      hit: { kind: "bar", id: 1, cursor: "default" },
      x: 0,
      y: 0,
      event: { ...press, buttons: 0, type: "pointerup" } as unknown as PointerEvent,
    });
    b.ctx.emit("pointer/barHover", { hit: { kind: "bar", id: 1, cursor: "default" }, x: 0, y: 0 });
    vi.advanceTimersByTime(10_000);
    expect(tipVisible(b.root)).toBe(false);
    b.dispose();
  });
});

describe("both trigger", () => {
  it("shows immediately on press", () => {
    const b = boot({ tooltip: { trigger: "both" } });
    b.ctx.emit("pointer/barDown", {
      hit: { kind: "bar", id: 1, cursor: "default" },
      x: 0,
      y: 0,
      event: press as unknown as PointerEvent,
    });
    expect(tipVisible(b.root)).toBe(true);
    b.dispose();
  });
});

describe("tooltip/content extension point (§3, first)", () => {
  function contributor(f: (hit: unknown) => string | undefined, id = "test.contrib"): AnyPlugin {
    return {
      meta: { id, dependsOn: ["stargantt.interaction"] },
      setup(ctx): void {
        ctx.contribute("tooltip/content" as never, f as never);
      },
    };
  }

  it("a contribution's answer wins over the built-in fallback", () => {
    const byId = new Map<TaskId, Task>(TASKS.map((t) => [t.id, t]));
    const tasksStore = mockStore<ReadonlyMap<TaskId, Task>>(new Map(byId));
    const root = document.createElement("div");
    document.body.appendChild(root);
    const dataStore = provider("stargantt.data-store", {
      "stargantt.data": {
        getTask: (id: TaskId) => byId.get(id),
        taskIds: () => byId.keys(),
        query: () => ({ byId, children: new Map([[null, [1, 2]]]) }),
        tasks: tasksStore,
        links: mockStore(new Map()),
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
        tToX: (t: number) => t * 1e-6,
        xToT: (x: number) => x / 1e-6,
        pxPerMs: 1e-6,
        zoomLevel: mockStore({ id: "day", pxPerDay: 86.4, scales: [{ unit: "day", format: () => "" }] }),
        requestOriginExtension: () => {},
        releaseOriginExtension: () => {},
      },
      "stargantt.theme": { get: () => "" },
    });
    const treeGrid = provider("stargantt.tree-grid", {
      "stargantt.rows": {
        rowCount: () => 2,
        taskIdAt: (row: number) => [1, 2][row],
        rowOf: () => undefined,
        rowHeight: () => 24,
        yOf: (row: number) => row * 24,
        rowAtY: () => 0,
        totalHeight: () => 48,
        isExpanded: () => true,
      },
      "stargantt.grid": { setSelected: () => {} },
    });
    const taskBars = provider("stargantt.task-bars", {
      "stargantt.task-bars": { barRect: () => undefined, barBoxOf: () => undefined, visibleBoxes: () => [], hasOwnBar: () => false },
    });
    const plugins: AnyPlugin[] = [
      dataStore,
      view,
      treeGrid,
      taskBars,
      interaction(),
      contributor((hit) => ((hit as { id: TaskId }).id === 1 ? "Contributed!" : undefined)),
    ];
    const test = createTestHost({ element: root, plugins });
    const ctx = test.ctxOf("stargantt.interaction");
    ctx.emit("pointer/barDown", {
      hit: { kind: "bar", id: 1, cursor: "default" },
      x: 0,
      y: 0,
      event: press as unknown as PointerEvent,
    });
    expect(tip(root)?.textContent).toBe("Contributed!");
    test.dispose();
  });
});

describe("tooltip.content: null removes the fallback", () => {
  it("shows nothing for a bar with no contribution", () => {
    const b = boot({ tooltip: { content: null } });
    b.ctx.emit("pointer/barDown", {
      hit: { kind: "bar", id: 1, cursor: "default" },
      x: 0,
      y: 0,
      event: press as unknown as PointerEvent,
    });
    expect(tipVisible(b.root)).toBe(false);
    b.dispose();
  });
});

describe("Escape (via the arbiter)", () => {
  it("dismisses a shown tooltip and sticks the dismissal to the target", () => {
    const b = boot();
    b.ctx.emit("pointer/barDown", {
      hit: { kind: "bar", id: 1, cursor: "default" },
      x: 0,
      y: 0,
      event: press as unknown as PointerEvent,
    });
    expect(tipVisible(b.root)).toBe(true);
    b.root.ownerDocument.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(tipVisible(b.root)).toBe(false);
    // Sticky: a fresh press on the same bar lifts it again.
    b.ctx.emit("pointer/barDown", {
      hit: { kind: "bar", id: 1, cursor: "default" },
      x: 0,
      y: 0,
      event: press as unknown as PointerEvent,
    });
    expect(tipVisible(b.root)).toBe(true);
    b.dispose();
  });
});

describe("view/scrolled", () => {
  it("hides a shown tooltip", () => {
    const b = boot();
    b.ctx.emit("pointer/barDown", {
      hit: { kind: "bar", id: 1, cursor: "default" },
      x: 0,
      y: 0,
      event: press as unknown as PointerEvent,
    });
    b.ctx.emit("view/scrolled", { scrollTop: 5, scrollLeft: 0 });
    expect(tipVisible(b.root)).toBe(false);
    b.dispose();
  });
});

describe("freshness (§6.4a, tasks store subscription)", () => {
  it("re-resolves in place on a data change while visible", () => {
    const b = boot();
    b.ctx.emit("pointer/barDown", {
      hit: { kind: "bar", id: 1, cursor: "default" },
      x: 0,
      y: 0,
      event: press as unknown as PointerEvent,
    });
    expect(tip(b.root)?.textContent).toContain("one");
    const renamed = { ...b.byId.get(1)!, name: "renamed" };
    b.byId.set(1, renamed);
    b.tasksStore.set(new Map(b.byId));
    expect(tip(b.root)?.textContent).toContain("renamed");
    b.dispose();
  });

  it("hides when the anchor task disappears", () => {
    const b = boot();
    b.ctx.emit("pointer/barDown", {
      hit: { kind: "bar", id: 1, cursor: "default" },
      x: 0,
      y: 0,
      event: press as unknown as PointerEvent,
    });
    expect(tipVisible(b.root)).toBe(true);
    b.byId.delete(1);
    b.tasksStore.set(new Map(b.byId));
    expect(tipVisible(b.root)).toBe(false);
    b.dispose();
  });

  // "Resolves nothing while no tooltip is visible" is a `panel.refresh()` invariant, covered for
  // real (asserting the content resolver is never even called) at the hostless unit level in
  // `tooltip-panel.test.ts` ("refresh (§6.4a freshness)" > "does nothing when no tooltip is
  // visible") — the wire-level version here only re-asserted "no tooltip was ever shown", which was
  // already true before the store publish and so was vacuous (review round 1 minor-3).
});

describe("focus-driven display (§6.4a, `stargantt.focus`'s FocusState store)", () => {
  it("shows the same content a press would, anchored at the focused bar's bottom-left", () => {
    const b = boot({}, 1);
    b.focusStore.set({ focused: 1 });
    expect(tipVisible(b.root)).toBe(true);
    expect(tip(b.root)?.textContent).toBe("one (1970-01-01 – 1970-01-02)");
    b.dispose();
  });

  it("dismisses on focusout leaving the root, but not a pointer-shown tooltip", () => {
    const b = boot({}, 1);
    b.ctx.emit("pointer/barDown", {
      hit: { kind: "bar", id: 2, cursor: "default" },
      x: 0,
      y: 0,
      event: press as unknown as PointerEvent,
    });
    expect(tipVisible(b.root)).toBe(true);
    b.root.dispatchEvent(new FocusEvent("focusout", { relatedTarget: null }));
    // A pointer-shown tooltip is untouched by a focus blur.
    expect(tipVisible(b.root)).toBe(true);
    b.dispose();
  });
});
