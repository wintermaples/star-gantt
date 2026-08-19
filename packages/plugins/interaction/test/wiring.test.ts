// @vitest-environment happy-dom
/**
 * What `setup()` actually wires into a real core: the two services it provides, the two render
 * orders it claims, the layer and content-extent contributions it registers, and the fact that the
 * ten input-stream events reach the gesture arbiter.
 *
 * A real `@stargantt/core` host is booted with service doubles for the four packages below this
 * one, so the assertions are about the composed behaviour rather than about the modules in
 * isolation (those have their own unit tests).
 */
import { describe, expect, it } from "vitest";
import { createTestHost, mockStore } from "@stargantt/sdk";
import type { AnyPlugin, PluginContext } from "@stargantt/core";
import type { Link, Patch, Task, TaskId } from "@stargantt/plugin-data-store";
import { interaction } from "../src/index";
import { bars, rowsOf, task } from "./_fakes";

/** Everything one booted chart records, so a test can assert what the plugin did to it. */
interface Recorder {
  invalidations: string[];
  scrolls: number[];
  gridSelected: TaskId[][];
  commands: { name: string; payload: unknown }[];
  /** Everything spoken through the focus channel's live region. */
  announcements: string[];
  /** Every `core/pluginError` the composition reported. */
  faults: unknown[];
}

/** One chord contributed to the point the a11y plugin owns. */
interface KeyBindingProbe {
  key: string;
  run(): void;
}

const TASKS: readonly Task[] = [
  task({ id: 1, name: "one", start: 0, end: 86_400_000, orderKey: "V" }),
  task({ id: 2, name: "two", start: 86_400_000, end: 172_800_000, orderKey: "k" }),
];

/** Boots a real core with the interaction plugin over service doubles. */
function boot(
  config: Parameters<typeof interaction>[0] = {},
  /** The task the keyboard focus sits on, when the composition has an a11y plugin at all. */
  focused?: TaskId,
): {
  ctx: PluginContext;
  host: ReturnType<typeof createTestHost>;
  rec: Recorder;
  /** The chords the plugin contributed to the a11y plugin's `keys/bindings` point. */
  keys(): readonly KeyBindingProbe[];
} {
  const rec: Recorder = {
    invalidations: [],
    scrolls: [],
    gridSelected: [],
    commands: [],
    announcements: [],
    faults: [],
  };
  const byId = new Map<TaskId, Task>(TASKS.map((t) => [t.id, t]));
  const geometry = bars([
    { id: 1, x: 0, y: 0, width: 40, height: 20 },
    { id: 2, x: 40, y: 24, width: 40, height: 20 },
  ]);

  /** One stand-in plugin registered under a real provider's id, publishing its services. */
  const provider = (id: string, services: Record<string, unknown>): AnyPlugin => ({
    meta: { id },
    setup(ctx): void {
      for (const [key, impl] of Object.entries(services)) ctx.provide(key as never, impl as never);
    },
  });

  // One finish-to-start edge, so the successor push-out has something it could push: task 2 may
  // not start before task 1 ends.
  const link: Link = { id: "l1", sourceId: 1, targetId: 2, type: "FS" };
  const dataStore = provider("stargantt.data-store", {
    "stargantt.data": {
      getTask: (id: TaskId) => byId.get(id),
      taskIds: () => byId.keys(),
      query: () => ({
        byId,
        children: new Map([[null, [1, 2]]]),
        linksByTask: new Map([
          [1, { in: [], out: [link] }],
          [2, { in: [link], out: [] }],
        ]),
      }),
      tasks: mockStore<ReadonlyMap<TaskId, Task>>(byId),
      links: mockStore<ReadonlyMap<string, Link>>(new Map([[link.id as string, link]])),
    },
  });
  const view = provider("stargantt.view", {
    "stargantt.view": {
      invalidate: (layer: string) => rec.invalidations.push(layer),
      viewport: mockStore({ scrollLeft: 0, scrollTop: 0, width: 800, height: 600 }),
      scrollTo: (target: { scrollLeft?: number }) => {
        if (target.scrollLeft !== undefined) rec.scrolls.push(target.scrollLeft);
      },
      chartPaneElement: () => document.createElement("div"),
    },
    "stargantt.timeline": {
      // 86.4 px per day, the density the zoom level below declares.
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
    "stargantt.rows": rowsOf({ order: [1, 2] }),
    "stargantt.grid": { setSelected: (ids: ReadonlySet<TaskId>) => rec.gridSelected.push([...ids]) },
  });
  const taskBars = provider("stargantt.task-bars", { "stargantt.task-bars": geometry });

  // Records every command the plugin dispatches, so the wiring is observable without a real store.
  const probe: AnyPlugin = {
    meta: { id: "test.probe" },
    setup(ctx): void {
      for (const name of ["task/move", "task/setProgress", "task/update", "task/remove", "view/dropIndicator"]) {
        ctx.registerCommand(name as never, ((payload: unknown) => {
          rec.commands.push({ name, payload });
        }) as never);
      }
    },
  };

  // Stands in for the a11y plugin: it owns the `keys/bindings` point and the focus channel,
  // and it starts after this plugin, so the chords it receives are ones the core buffered. Omitted
  // entirely when the test asks for no keyboard focus, which is the "no a11y composed" composition.
  // Read lazily rather than snapshotted at setup: neither plugin declares an ordering edge to the
  // other, so the chords may arrive before or after this point is defined — the core buffers either
  // way, and only a read at assertion time is guaranteed to see them all.
  let bindings: { get(): KeyBindingProbe[] } | undefined;
  const a11y: AnyPlugin = {
    meta: { id: "stargantt.a11y" },
    setup(ctx): void {
      ctx.provide("stargantt.focus" as never, {
        state: mockStore<{ focused: TaskId | undefined }>({ focused }),
        focus: () => {},
        announce: (text: string) => rec.announcements.push(text),
      } as never);
      bindings = (
        ctx.defineExtensionPoint as unknown as (
          key: string,
          reduce: (inputs: KeyBindingProbe[]) => KeyBindingProbe[],
        ) => { get(): KeyBindingProbe[] }
      )("keys/bindings", (inputs) => inputs);
    },
  };

  const plugins: AnyPlugin[] = [dataStore, view, treeGrid, taskBars, probe, interaction(config)];
  if (focused !== undefined) plugins.push(a11y);
  const host = createTestHost({ plugins });
  host.host.on("core/pluginError", (e) => rec.faults.push(e.error));
  return { ctx: host.ctxOf("stargantt.interaction"), host, rec, keys: () => bindings?.get() ?? [] };
}

describe("services", () => {
  it("provides the selection and snap services", () => {
    const { host } = boot();
    expect(host.host.getService("stargantt.selection")).toBeDefined();
    expect(host.host.getService("stargantt.snap")).toBeDefined();
    host.dispose();
  });

  it("publishes the configured selection mode and an empty initial state", () => {
    const { host } = boot({ selection: { mode: "multi" } });
    const selection = host.host.service("stargantt.selection");
    expect(selection.mode()).toBe("multi");
    expect(selection.state.get().taskIds.size).toBe(0);
    host.dispose();
  });

  it("rounds to the finest header row and ignores that row's optional step", () => {
    // A stepped row fixes no origin for the intermediate boundaries it would need, so only the
    // row's unit is read — a `step: 2` day row still rounds to whole days.
    const { host, ctx } = boot();
    const timeline = ctx.use("stargantt.timeline");
    (timeline.zoomLevel as unknown as { set(v: unknown): void }).set({
      id: "two-day",
      pxPerDay: 43.2,
      scales: [
        { unit: "month", format: (): string => "" },
        { unit: "day", step: 2, format: (): string => "" },
      ],
    });
    expect(host.host.service("stargantt.snap").snap(13 * 3_600_000)).toBe(86_400_000);
    expect(host.host.service("stargantt.snap").step(0, 1)).toBe(86_400_000);
    host.dispose();
  });

  it("rounds through the snap service using the finest header row", () => {
    const { host } = boot();
    const snap = host.host.service("stargantt.snap");
    // One UTC day is the unit; 10:00 rounds back to the day it is in, 13:00 forward to the next.
    expect(snap.snap(10 * 3_600_000)).toBe(0);
    expect(snap.snap(13 * 3_600_000)).toBe(86_400_000);
    expect(snap.step(0, 1)).toBe(86_400_000);
    host.dispose();
  });
});

describe("snap.enabled: false", () => {
  it("commits the instant the pointer describes, unrounded", () => {
    const { ctx, rec, host } = boot({ snap: { enabled: false } });
    const press = { pointerId: 1, clientX: 0, clientY: 0, buttons: 1, button: 0, type: "pointerdown" };
    ctx.emit("pointer/barDown", {
      hit: { kind: "bar", id: 1, cursor: "default" },
      x: 10,
      y: 5,
      event: press as unknown as PointerEvent,
    });
    ctx.emit("pointer/barMove", {
      hit: { kind: "bar", id: 1, cursor: "default" },
      x: 60,
      y: 5,
      event: { ...press, clientX: 50, type: "pointermove" } as unknown as PointerEvent,
    });
    ctx.emit("pointer/barUp", {
      hit: { kind: "bar", id: 1, cursor: "default" },
      x: 60,
      y: 5,
      event: { ...press, clientX: 50, buttons: 0, type: "pointerup" } as unknown as PointerEvent,
    });
    // 50 client px at 86.4 px/day is 50_000_000 ms. Rounded, it would land on the next day
    // boundary (86_400_000) — see the enabled case above; unrounded, it commits exactly.
    expect(rec.commands).toEqual([
      {
        name: "task/move",
        payload: {
          id: 1,
          start: 50_000_000,
          end: 50_000_000 + 86_400_000,
          coalesceKey: expect.stringMatching(/^stargantt\.interaction:/) as unknown as string,
        },
      },
    ]);
    host.dispose();
  });

  it("falls the keyboard chords back to one UTC day", () => {
    const h = boot({ snap: { enabled: false } }, 1);
    h.keys().find((b) => b.key === "Ctrl+ArrowRight")?.run();
    expect(h.rec.commands).toEqual([
      { name: "task/move", payload: { id: 1, start: 86_400_000, end: 172_800_000 } },
    ]);
    h.host.dispose();
  });

  it("still publishes the service, rounding nothing", () => {
    const { host } = boot({ snap: { enabled: false, unit: "day" } });
    const snap = host.host.service("stargantt.snap");
    expect(snap.snap(13 * 3_600_000)).toBe(13 * 3_600_000);
    expect(snap.step(0, -1)).toBe(-86_400_000);
    host.dispose();
  });

  /** A user edit dragging task 1's end past task 2's start — the FS link is violated by it. */
  function violatingEdit(): { id: string; label: string; origin: "user"; patches: Patch[] } {
    return {
      id: "t",
      label: "edit",
      origin: "user",
      patches: [{ op: "task/update", id: 1, before: { end: 86_400_000 }, after: { end: 172_800_000 } }],
    };
  }

  it("registers no transaction hook, so a user edit gains no push-out patches", () => {
    // The positive control first: with the feature on, this very edit pushes the successor out.
    const on = boot({ snap: { pushSuccessors: true } });
    const pushed = violatingEdit();
    on.ctx.emit("data/willApplyTransaction", { transaction: pushed, cancel: () => {} } as never);
    expect(pushed.patches).toHaveLength(2);
    expect(pushed.patches[1]).toEqual({
      op: "task/update",
      id: 2,
      before: { start: 86_400_000, end: 172_800_000 },
      after: { start: 172_800_000, end: 259_200_000 },
    });
    on.host.dispose();

    const off = boot({ snap: { enabled: false, pushSuccessors: true } });
    const untouched = violatingEdit();
    off.ctx.emit("data/willApplyTransaction", { transaction: untouched, cancel: () => {} } as never);
    expect(untouched.patches).toHaveLength(1);
    off.host.dispose();
  });
});

describe("render orders", () => {
  it("claims the selection layer at 70 and the drag preview at 100", () => {
    const { host } = boot();
    const orders = host.host.orders("renderer/layers");
    expect(orders).toEqual([
      { key: "stargantt.interaction:selection", order: 70, pluginId: "stargantt.interaction" },
      { key: "stargantt.interaction:drag-preview", order: 100, pluginId: "stargantt.interaction" },
    ]);
    host.dispose();
  });
});

describe("the input streams reach the arbiter", () => {
  it("selects the pressed bar and mirrors the selection into the grid", () => {
    const { ctx, host, rec } = boot();
    ctx.emit("pointer/barDown", {
      hit: { kind: "bar", id: 2, cursor: "default" },
      x: 50,
      y: 30,
      event: { pointerId: 1, clientX: 50, clientY: 30, buttons: 1, button: 0, type: "pointerdown" } as unknown as PointerEvent,
    });
    expect([...host.host.service("stargantt.selection").state.get().taskIds]).toEqual([2]);
    expect(rec.gridSelected.at(-1)).toEqual([2]);
    expect(rec.invalidations).toContain("main");
    host.dispose();
  });

  it("selects from a grid-row press and reveals the bar", () => {
    const { ctx, host } = boot();
    ctx.emit("grid/rowPointerDown", {
      id: 1,
      row: 0,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      button: 0,
      pointerId: 1,
      x: 0,
      y: 0,
      clientX: 0,
      clientY: 0,
    });
    expect([...host.host.service("stargantt.selection").state.get().taskIds]).toEqual([1]);
    host.dispose();
  });

  it("commits a bar drag through the task/move command with a coalesce key", () => {
    const { ctx, rec, host } = boot();
    const press = { pointerId: 1, clientX: 0, clientY: 0, buttons: 1, button: 0, type: "pointerdown" };
    ctx.emit("pointer/barDown", {
      hit: { kind: "bar", id: 1, cursor: "default" },
      x: 10,
      y: 5,
      event: press as unknown as PointerEvent,
    });
    ctx.emit("pointer/barMove", {
      hit: { kind: "bar", id: 1, cursor: "default" },
      x: 60,
      y: 5,
      event: { ...press, clientX: 50, type: "pointermove" } as unknown as PointerEvent,
    });
    ctx.emit("pointer/barUp", {
      hit: { kind: "bar", id: 1, cursor: "default" },
      x: 60,
      y: 5,
      event: { ...press, clientX: 50, buttons: 0, type: "pointerup" } as unknown as PointerEvent,
    });
    const moves = rec.commands.filter((c) => c.name === "task/move");
    expect(moves).toHaveLength(1);
    const payload = moves[0]?.payload as { id: TaskId; start: number; end: number; coalesceKey: string };
    expect(payload.id).toBe(1);
    // 50 client px at 86.4 px/day is 0.58 of a day, which the day-unit rounding carries to the
    // next boundary; the duration is kept.
    expect(payload.start).toBe(86_400_000);
    expect(payload.end).toBe(172_800_000);
    expect(payload.coalesceKey).toMatch(/^stargantt\.interaction:/);
    host.dispose();
  });

  it("deletes the selection through one task/remove transaction", () => {
    // A confirm hook answering `true` stands in for the dialog, whose own DOM is covered by the
    // selection unit tests; what this asserts is that the whole selection leaves in one command.
    const { host, rec } = boot({ selection: { mode: "multi", confirmDelete: () => true } });
    const selection = host.host.service("stargantt.selection");
    selection.select([1, 2]);
    selection.deleteSelected();
    const removes = rec.commands.filter((c) => c.name === "task/remove");
    expect(removes).toHaveLength(1);
    expect(removes[0]?.payload).toEqual({ ids: [1, 2] });
    host.dispose();
  });

  it("declines to delete without a confirmation", () => {
    const { host, rec } = boot({ selection: { confirmDelete: () => false } });
    const selection = host.host.service("stargantt.selection");
    selection.select([1]);
    selection.deleteSelected();
    expect(rec.commands.filter((c) => c.name === "task/remove")).toHaveLength(0);
    expect([...selection.state.get().taskIds]).toEqual([1]);
    host.dispose();
  });
});

describe("the keyboard chords (§5)", () => {
  /** The eight chords this plugin owns, in the order the two tables declare them. */
  const CHORDS = [
    "Ctrl+ArrowRight",
    "Ctrl+ArrowLeft",
    "Ctrl+Shift+ArrowRight",
    "Ctrl+Shift+ArrowLeft",
    "Ctrl+Alt+ArrowRight",
    "Ctrl+Alt+ArrowLeft",
    "Ctrl+Shift+ArrowUp",
    "Ctrl+Shift+ArrowDown",
  ];

  /** Runs the named chord against a booted chart. */
  function run(h: ReturnType<typeof boot>, key: string): void {
    const binding = h.keys().find((b) => b.key === key);
    expect(binding, `no binding contributed for ${key}`).toBeDefined();
    binding?.run();
  }

  it("contributes exactly the eight chords to the a11y plugin's point", () => {
    const h = boot({}, 1);
    expect(h.keys().map((b) => b.key)).toEqual(CHORDS);
    h.host.dispose();
  });

  it("contributes nothing at all in a read-only composition", () => {
    const h = boot({ dragEdit: { enabled: false } }, 1);
    expect(h.keys()).toEqual([]);
    h.host.dispose();
  });

  it("moves the focused task by one snap step and announces the committed period", () => {
    const h = boot({}, 1);
    run(h, "Ctrl+ArrowRight");
    expect(h.rec.commands).toEqual([
      { name: "task/move", payload: { id: 1, start: 86_400_000, end: 172_800_000 } },
    ]);
    // The announcement carries what the store now holds, not the intermediate stepped instant.
    expect(h.rec.announcements).toEqual(["one, 1970-01-02 – 1970-01-03"]);
    h.host.dispose();
  });

  it("carries no coalesce key: one press is one edit and one undo entry", () => {
    const h = boot({}, 1);
    run(h, "Ctrl+ArrowLeft");
    expect(h.rec.commands[0]?.payload).not.toHaveProperty("coalesceKey");
    h.host.dispose();
  });

  it("resizes the end and the start from their own chords", () => {
    const end = boot({}, 1);
    run(end, "Ctrl+Shift+ArrowRight");
    expect(end.rec.commands[0]?.payload).toEqual({ id: 1, start: 0, end: 172_800_000 });
    end.host.dispose();

    const start = boot({}, 1);
    run(start, "Ctrl+Alt+ArrowLeft");
    expect(start.rec.commands[0]?.payload).toEqual({ id: 1, start: -86_400_000, end: 86_400_000 });
    start.host.dispose();
  });

  it("steps the progress by a tenth and announces the percentage", () => {
    const h = boot({}, 1);
    run(h, "Ctrl+Shift+ArrowUp");
    expect(h.rec.commands).toEqual([
      { name: "task/setProgress", payload: { id: 1, progress: 0.1 } },
    ]);
    expect(h.rec.announcements).toEqual(["one, 10%"]);
    h.host.dispose();
  });

  it("dispatches nothing when the progress is already clamped at its bound", () => {
    const h = boot({}, 1);
    run(h, "Ctrl+Shift+ArrowDown");
    expect(h.rec.commands).toEqual([]);
    expect(h.rec.announcements).toEqual([]);
    h.host.dispose();
  });

  it("stays inert without a focus channel, and without a focused task", () => {
    // No a11y plugin composed at all: the contributions stay buffered and nothing can run them.
    const none = boot({});
    expect(none.keys()).toEqual([]);
    none.host.dispose();

    const unfocused = boot({}, 99); // a focused id the store does not know
    run(unfocused, "Ctrl+ArrowRight");
    expect(unfocused.rec.commands).toEqual([]);
    expect(unfocused.rec.announcements).toEqual([]);
    unfocused.host.dispose();
  });

  it("reports a throwing announcement builder and speaks the built-in default instead", () => {
    const boom = new Error("bad wording");
    const h = boot(
      {
        messages: {
          edited: () => {
            throw boom;
          },
        },
      },
      1,
    );
    run(h, "Ctrl+ArrowRight");
    expect(h.rec.commands).toHaveLength(1); // the edit still commits
    expect(h.rec.announcements).toEqual(["one, 1970-01-02 – 1970-01-03"]);
    expect(h.rec.faults).toEqual([{ messageKey: "edited", cause: boom }]);
    h.host.dispose();
  });
});

describe("the document-level keyboard wiring", () => {
  /** Dispatches one keydown on the document the chart root belongs to. */
  function keydown(root: HTMLElement, init: KeyboardEventInit): void {
    root.ownerDocument.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  }

  it("clears the selection on Escape only when the shortcut is opted into", () => {
    const off = boot();
    off.host.host.service("stargantt.selection").select([1]);
    keydown(off.ctx.root, { key: "Escape" });
    expect(off.host.host.service("stargantt.selection").state.get().taskIds.size).toBe(1);
    off.host.dispose();

    const on = boot({ selection: { shortcuts: { clearOnEscape: true } } });
    on.host.host.service("stargantt.selection").select([1]);
    keydown(on.ctx.root, { key: "Escape" });
    expect(on.host.host.service("stargantt.selection").state.get().taskIds.size).toBe(0);
    on.host.dispose();
  });

  it("selects every task on Ctrl+A in multi mode while the focus is inside the chart", () => {
    const { ctx, host } = boot({
      selection: { mode: "multi", shortcuts: { selectAll: true } },
    });
    // The root must be in the document and focused for the focus-scoped shortcut to apply.
    document.body.appendChild(ctx.root);
    ctx.root.setAttribute("tabindex", "-1");
    ctx.root.focus();
    keydown(ctx.root, { key: "a", ctrlKey: true });
    expect([...host.host.service("stargantt.selection").state.get().taskIds]).toEqual([1, 2]);
    ctx.root.remove();
    host.dispose();
  });
});
