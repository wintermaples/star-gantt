// @vitest-environment happy-dom
/**
 * The booted-chart harness this package's host-coupled tests are written against.
 *
 * A real `@stargantt/core` instance is started through `createTestHost` around the real a11y plugin
 * plus one recording stub per lower-layer provider — the store, the view, the tree grid and the
 * bars — and, unless a test asks for the degraded composition, one under the interaction plugin's
 * id providing `stargantt.selection`. Stubs rather than the real siblings: this package depends on
 * none of them at runtime, and a stub is what makes "what did the plugin ask for" observable
 * (which rows it scrolled to, which task it marked focused, which commands it dispatched).
 *
 * Everything the modules can be exercised without a host is tested against plain doubles in the
 * other files; this harness exists for the wiring itself.
 */
import { createStore, definePlugin } from "@stargantt/core";
import type { AnyPlugin, PluginContext, Store, WritableStore } from "@stargantt/core";
import { createTestHost } from "@stargantt/sdk";
import type { TestHost } from "@stargantt/sdk";
import type { GanttInstance } from "@stargantt/core";
import type { DataService, Link, ReadonlyDataView, Task, TaskId } from "@stargantt/plugin-data-store";
import type { SelectionService, SelectionState } from "@stargantt/plugin-interaction";
import type { BarBox, TaskBarsService } from "@stargantt/plugin-task-bars";
import type { GridService, GridSortState, RowsService, RowsSnapshot } from "@stargantt/plugin-tree-grid";
import type { ThemeService, TimelineService, ViewService, Viewport, ZoomLevel } from "@stargantt/plugin-view";
import { a11y } from "../src/index";
import type { A11yConfig, FocusService } from "../src/index";
import { MS_DAY } from "@stargantt/sdk";

/* ------------------------------------------------------------------ *
 * Sample data
 * ------------------------------------------------------------------ */

/** `n` flat root tasks `t0…`, each one day long, the first starting at the epoch. */
export function flatTasks(n: number): Task[] {
  const out: Task[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      id: `t${i}`,
      parentId: null,
      name: `t${i}`,
      start: i * MS_DAY,
      end: (i + 1) * MS_DAY,
    });
  }
  return out;
}

/** A two-level tree: `a` with children `a1`, `a2`, then a root leaf `b`. */
export function treeTasks(): Task[] {
  return [
    { id: "a", parentId: null, name: "a", start: 0, end: 2 * MS_DAY, type: "summary" },
    { id: "a1", parentId: "a", name: "a1", start: 0, end: MS_DAY, progress: 0.4 },
    { id: "a2", parentId: "a", name: "a2", start: MS_DAY, end: 2 * MS_DAY },
    { id: "b", parentId: null, name: "b", start: 2 * MS_DAY, end: 3 * MS_DAY },
  ];
}

/* ------------------------------------------------------------------ *
 * The data-store stub
 * ------------------------------------------------------------------ */

export interface DataControl {
  /** Replaces the whole task set and publishes the new snapshot. */
  setTasks(tasks: readonly Task[]): void;
  /** Replaces one task with a patched copy — the shape an inline-edit commit produces. */
  patch(id: TaskId, patch: Partial<Task>): void;
  /** Replaces the link set. */
  setLinks(links: readonly Link[]): void;
  /** Republishes the current tasks without changing any of them. */
  republish(): void;
  readonly service: DataService;
}

function dataStub(tasks: readonly Task[], links: readonly Link[]): {
  plugin: AnyPlugin;
  control: DataControl;
} {
  const store: WritableStore<ReadonlyMap<TaskId, Readonly<Task>>> = createStore(
    new Map(tasks.map((t) => [t.id, t])),
  );
  let linkList: readonly Link[] = links;

  const query = (): ReadonlyDataView => {
    const byId = store.get();
    const children = new Map<TaskId | null, TaskId[]>();
    for (const task of byId.values()) {
      const parent = task.parentId ?? null;
      const list = children.get(parent);
      if (list === undefined) children.set(parent, [task.id]);
      else list.push(task.id);
    }
    const linksByTask = new Map<TaskId, { in: Link[]; out: Link[] }>();
    const bucket = (id: TaskId): { in: Link[]; out: Link[] } => {
      const found = linksByTask.get(id);
      if (found !== undefined) return found;
      const fresh = { in: [] as Link[], out: [] as Link[] };
      linksByTask.set(id, fresh);
      return fresh;
    };
    for (const link of linkList) {
      bucket(link.targetId).in.push(link);
      bucket(link.sourceId).out.push(link);
    }
    return {
      byId,
      children,
      linksByTask,
      calendars: new Map(),
      resources: new Map(),
      assignmentsByTask: new Map(),
    };
  };

  const service = {
    getTask: (id: TaskId) => store.get().get(id),
    taskIds: () => store.get().keys(),
    query,
    load: () => {},
    hasDeferredChildren: () => false,
    materializeChildren: () => {},
    toJSON: () => ({ tasks: [], links: [], calendars: [], resources: [], assignments: [] }),
    tasks: store as Store<ReadonlyMap<TaskId, Readonly<Task>>>,
    links: createStore(new Map()),
    resources: createStore(new Map()),
    assignments: createStore(new Map()),
  } as unknown as DataService;

  const plugin = definePlugin({
    meta: { id: "stargantt.data-store" },
    setup(ctx: PluginContext) {
      ctx.provide("stargantt.data", service);
    },
  });

  return {
    plugin,
    control: {
      service,
      setTasks: (next) => store.set(new Map(next.map((t) => [t.id, t]))),
      patch: (id, patch) => {
        const next = new Map(store.get());
        const task = next.get(id);
        if (task !== undefined) next.set(id, { ...task, ...patch });
        store.set(next);
      },
      setLinks: (next) => {
        linkList = next;
        store.set(new Map(store.get()));
      },
      republish: () => store.set(new Map(store.get())),
    },
  };
}

/* ------------------------------------------------------------------ *
 * The view stub
 * ------------------------------------------------------------------ */

export interface ViewControl {
  /** Canvas layers passed to `invalidate`, in call order. */
  readonly invalidations: string[];
  /** Targets passed to `scrollTo`, in call order. */
  readonly scrolls: { scrollLeft?: number; scrollTop?: number }[];
  /** Replaces the reported viewport (without emitting `view/scrolled`). */
  setViewport(vp: Partial<Viewport>): void;
  /** The `renderer/layers` contributions collected so far, in registration order. */
  layers(): { id: string; zIndex: number; draw: (g: unknown, vp: Viewport) => void }[];
  /** Emits `view/scrolled` and updates the viewport, as a real scroll would. */
  scroll(scrollTop: number): void;
  /** The zoom level the timeline reports. */
  setZoomLevel(id: string): void;
  /** `timeline/zoomIn` / `timeline/zoomOut` dispatches, in order. */
  readonly zoomSteps: ("in" | "out")[];
  /** Sets a theme token's value. */
  setToken(token: string, value: string): void;
}

function viewStub(tokens: Record<string, string>): { plugin: AnyPlugin; control: ViewControl } {
  const invalidations: string[] = [];
  const scrolls: { scrollLeft?: number; scrollTop?: number }[] = [];
  const zoomSteps: ("in" | "out")[] = [];
  const viewport = createStore<Viewport>({ scrollTop: 0, scrollLeft: 0, width: 400, height: 300 });
  const zoomLevel = createStore<ZoomLevel>({ id: "day", pxPerDay: 24, scales: [] });
  const themeTokens: Record<string, string> = { ...tokens };
  let getLayers: (() => unknown[] | undefined) | undefined;
  let emitScrolled: ((scrollTop: number) => void) | undefined;

  const plugin = definePlugin({
    meta: { id: "stargantt.view" },
    setup(ctx: PluginContext) {
      const point = ctx.defineExtensionPoint("renderer/layers", (inputs) => [...inputs]);
      getLayers = () => point.get();
      emitScrolled = (scrollTop) => {
        viewport.set({ ...viewport.get(), scrollTop });
        ctx.emit("view/scrolled", { scrollTop, scrollLeft: viewport.get().scrollLeft });
      };
      const view = {
        viewport: viewport as Store<Readonly<Viewport>>,
        viewMode: createStore("split"),
        invalidate: (layer: string) => invalidations.push(layer),
        // The real view emits `view/scrolled` from the one clamp path every scroll mutation goes
        // through, `scrollTo` included — so the stub does too, or the mirror's window would never
        // follow a programmatic scroll.
        scrollTo: (target: { scrollLeft?: number; scrollTop?: number }) => {
          scrolls.push(target);
          const next = { ...viewport.get() };
          if (target.scrollTop !== undefined) next.scrollTop = target.scrollTop;
          if (target.scrollLeft !== undefined) next.scrollLeft = target.scrollLeft;
          viewport.set(next);
          ctx.emit("view/scrolled", { scrollTop: next.scrollTop, scrollLeft: next.scrollLeft });
        },
        refreshInsets: () => {},
        direction: () => "ltr" as const,
        reducedMotion: () => false,
        textWidth: (_g: unknown, text: string) => text.length * 6,
        bidiIsolate: (text: string) => text,
        firstPaintMs: () => undefined,
        batchRead: (fn: () => void) => fn(),
        batchWrite: (fn: () => void) => fn(),
        predictedViewport: () => undefined,
        chartPaneElement: () => ctx.root,
        wheelSpeedFactor: () => 1,
        renderTo: () => {},
      } as unknown as ViewService;
      ctx.provide("stargantt.view", view);

      const timeline = {
        tToX: (t: number) => t,
        xToT: (x: number) => x,
        pxPerMs: 1,
        setZoomLevel: () => {},
        setOrigin: () => {},
        requestOriginExtension: () => {},
        releaseOriginExtension: () => {},
        levelMetrics: () => [],
        firstDayOfWeek: () => 1 as const,
        unitBoundaries: () => [],
        formatDate: (t: number) => String(t),
        gridCellAt: () => undefined,
        zoomLevel: zoomLevel as Store<Readonly<ZoomLevel>>,
      } as unknown as TimelineService;
      ctx.provide("stargantt.timeline", timeline);

      const theme = {
        get: (token: string) => themeTokens[token] ?? "",
        tokens: () => [],
        snapshot: () => ({}),
        audit: () => [],
        setPreset: () => {},
        preset: () => null,
        presets: () => [],
        setColorScheme: () => {},
        colorScheme: () => "auto" as const,
        refresh: () => {},
      } as unknown as ThemeService;
      ctx.provide("stargantt.theme", theme);

      ctx.registerCommand("timeline/zoomIn", () => {
        zoomSteps.push("in");
        zoomLevel.set({ id: "hour", pxPerDay: 240, scales: [] });
      });
      ctx.registerCommand("timeline/zoomOut", () => {
        zoomSteps.push("out");
        zoomLevel.set({ id: "week", pxPerDay: 6, scales: [] });
      });
    },
  });

  return {
    plugin,
    control: {
      invalidations,
      scrolls,
      zoomSteps,
      setViewport: (vp) => viewport.set({ ...viewport.get(), ...vp }),
      layers: () =>
        (getLayers?.() ?? []) as { id: string; zIndex: number; draw: (g: unknown, vp: Viewport) => void }[],
      scroll: (scrollTop) => emitScrolled?.(scrollTop),
      setZoomLevel: (id) => zoomLevel.set({ id, pxPerDay: 24, scales: [] }),
      setToken: (token, value) => {
        themeTokens[token] = value;
      },
    },
  };
}

/* ------------------------------------------------------------------ *
 * The tree-grid stub
 * ------------------------------------------------------------------ */

export interface GridControl {
  /** The task the grid pane currently marks as focused. */
  focused(): TaskId | undefined;
  /** Every `setFocused` argument, in call order. */
  readonly focusPushes: (TaskId | undefined)[];
  /** The ids the grid pane currently marks as selected. */
  selected(): ReadonlySet<TaskId>;
  /** Expands or collapses one branch, republishing the row set. */
  setExpanded(id: TaskId, expanded: boolean): void;
  /** Hides rows by resolving their height to 0 — the shape a filter produces. */
  setHidden(ids: readonly TaskId[]): void;
  /** Gives one task's row a height of its own — the shape a `rows/height` contribution produces. */
  setRowHeight(id: TaskId, height: number): void;
  /** `view/rowToggle` dispatches, in order. */
  readonly toggles: { id: TaskId; expanded?: boolean }[];
  /** `view/editStart` dispatches, in order. */
  readonly editStarts: TaskId[];
  /** Publishes a new sort state. */
  setSort(sort: GridSortState | null): void;
  /** Recomputes the row set from the current store contents and publishes it. */
  rebuild(): void;
  readonly service: RowsService;
}

interface TreeGridOptions {
  data: DataControl;
  rowHeight: number;
}

function treeGridStub(options: TreeGridOptions): { plugin: AnyPlugin; control: GridControl } {
  const { data, rowHeight } = options;
  const collapsed = new Set<TaskId>();
  let hidden = new Set<TaskId>();
  const focusPushes: (TaskId | undefined)[] = [];
  let focused: TaskId | undefined;
  let selected: ReadonlySet<TaskId> = new Set();
  const toggles: { id: TaskId; expanded?: boolean }[] = [];
  const editStarts: TaskId[] = [];
  const sort = createStore<GridSortState | null>(null);

  let order: TaskId[] = [];
  const rowsStore = createStore<RowsSnapshot>({ taskIds: [], totalHeight: 0 });

  const overrides = new Map<TaskId, number>();
  const heightOf = (id: TaskId): number =>
    hidden.has(id) ? 0 : (overrides.get(id) ?? rowHeight);

  const compute = (): TaskId[] => {
    const view = data.service.query();
    const out: TaskId[] = [];
    const walk = (parent: TaskId | null): void => {
      for (const id of view.children.get(parent) ?? []) {
        out.push(id);
        if (!collapsed.has(id)) walk(id);
      }
    };
    walk(null);
    return out;
  };

  const rebuild = (): void => {
    order = compute();
    let total = 0;
    for (const id of order) total += heightOf(id);
    rowsStore.set({ taskIds: [...order], totalHeight: total });
  };

  const service = {
    rowCount: () => order.length,
    taskIdAt: (row: number) => order[row],
    rowOf: (id: TaskId) => {
      const index = order.indexOf(id);
      return index === -1 ? undefined : index;
    },
    rowHeight: (row: number) => {
      const id = order[row];
      return id === undefined ? 0 : heightOf(id);
    },
    resolvedHeightOf: (id: TaskId) => (data.service.getTask(id) === undefined ? undefined : heightOf(id)),
    yOf: (row: number) => {
      let y = 0;
      for (let i = 0; i < row && i < order.length; i += 1) y += heightOf(order[i] as TaskId);
      return y;
    },
    rowAtY: (y: number) => {
      let top = 0;
      for (let i = 0; i < order.length; i += 1) {
        const h = heightOf(order[i] as TaskId);
        if (y < top + h) return i;
        top += h;
      }
      return Math.max(0, order.length - 1);
    },
    totalHeight: () => rowsStore.get().totalHeight,
    isExpanded: (id: TaskId) => !collapsed.has(id),
    rows: rowsStore as Store<RowsSnapshot>,
  } as unknown as RowsService;

  const plugin = definePlugin({
    meta: { id: "stargantt.tree-grid", dependsOn: ["stargantt.data-store"] },
    setup(ctx: PluginContext) {
      rebuild();
      // The row set follows the store, exactly as the real row model does.
      ctx.own(data.service.tasks.subscribe(() => rebuild()));
      ctx.provide("stargantt.rows", service);
      const grid = {
        setSelected: (ids: ReadonlySet<TaskId>) => {
          selected = new Set(ids);
        },
        setFocused: (id: TaskId | undefined) => {
          focused = id;
          focusPushes.push(id);
        },
        columnWidths: createStore(new Map()),
        sort: sort as Store<GridSortState | null>,
      } as unknown as GridService;
      ctx.provide("stargantt.grid", grid);
      ctx.registerCommand("view/rowToggle", (payload) => {
        toggles.push(payload);
        const expanded = payload.expanded ?? collapsed.has(payload.id);
        if (expanded) collapsed.delete(payload.id);
        else collapsed.add(payload.id);
        rebuild();
      });
      ctx.registerCommand("view/editStart", (payload) => editStarts.push(payload.id));
    },
  });

  return {
    plugin,
    control: {
      service,
      focused: () => focused,
      focusPushes,
      selected: () => selected,
      toggles,
      editStarts,
      setExpanded: (id, expanded) => {
        if (expanded) collapsed.delete(id);
        else collapsed.add(id);
        rebuild();
      },
      setHidden: (ids) => {
        hidden = new Set(ids);
        rebuild();
      },
      setRowHeight: (id, height) => {
        overrides.set(id, height);
        rebuild();
      },
      setSort: (next) => sort.set(next),
      rebuild,
    },
  };
}

/* ------------------------------------------------------------------ *
 * The task-bars stub
 * ------------------------------------------------------------------ */

export interface BarsControl {
  setBox(id: TaskId, box: Omit<BarBox, "id" | "gutterStart" | "gutterEnd">): void;
  clearBoxes(): void;
}

function taskBarsStub(): { plugin: AnyPlugin; control: BarsControl } {
  const boxes = new Map<TaskId, BarBox>();
  const plugin = definePlugin({
    meta: { id: "stargantt.task-bars" },
    setup(ctx: PluginContext) {
      const service = {
        barBoxOf: (id: TaskId) => boxes.get(id),
        visibleBoxes: () => [...boxes.values()],
        barRect: (id: TaskId) => boxes.get(id),
        hasOwnBar: (id: TaskId) => boxes.has(id),
      } as unknown as TaskBarsService;
      ctx.provide("stargantt.task-bars", service);
    },
  });
  return {
    plugin,
    control: {
      setBox: (id, box) => boxes.set(id, { ...box, id, gutterStart: 0, gutterEnd: 0 }),
      clearBoxes: () => boxes.clear(),
    },
  };
}

/* ------------------------------------------------------------------ *
 * The selection stub (registered under the interaction plugin's id)
 * ------------------------------------------------------------------ */

export interface SelectionControl {
  /** Every id list handed to `select()`, oldest first. */
  readonly selections: TaskId[][];
  /** The current selection. */
  selected(): ReadonlySet<TaskId>;
  /** Replaces the selection from outside the plugin — a "foreign" change. */
  select(ids: readonly TaskId[]): void;
  /** Ids the stub's own `grid/rowPointerDown` handler saw, for the ordering test. */
  readonly pointerLog: string[];
}

function selectionStub(mode: "single" | "multi" | "none"): {
  plugin: AnyPlugin;
  control: SelectionControl;
} {
  const selections: TaskId[][] = [];
  const pointerLog: string[] = [];
  const state = createStore<SelectionState>({ taskIds: new Set<TaskId>() });
  const select = (ids: readonly TaskId[]): void => {
    selections.push([...ids]);
    state.set({ taskIds: new Set(ids) });
  };

  const plugin = definePlugin({
    meta: { id: "stargantt.interaction", dependsOn: ["stargantt.tree-grid"] },
    setup(ctx: PluginContext) {
      ctx.on("grid/rowPointerDown", () => pointerLog.push("selection"));
      const service = {
        state: state as Store<SelectionState>,
        select,
        toggle: () => {},
        clear: () => state.set({ taskIds: new Set<TaskId>() }),
        reveal: () => {},
        mode: () => mode,
        deleteSelected: () => {},
      } as unknown as SelectionService;
      ctx.provide("stargantt.selection", service);
    },
  });

  return {
    plugin,
    control: {
      selections,
      pointerLog,
      selected: () => state.get().taskIds,
      select,
    },
  };
}

/* ------------------------------------------------------------------ *
 * The canvas double
 * ------------------------------------------------------------------ */

/** One recorded `strokeRect`, with the style state active when it was made. */
export interface RecordedStroke {
  x: number;
  y: number;
  width: number;
  height: number;
  strokeStyle: string;
  lineWidth: number;
}

/** A `CanvasRenderingContext2D` stand-in exposing only what the focus layer uses. */
export class FakeCanvasContext {
  lineWidth = 1;
  strokeStyle = "";
  readonly strokes: RecordedStroke[] = [];
  strokeRect(x: number, y: number, width: number, height: number): void {
    this.strokes.push({
      x,
      y,
      width,
      height,
      strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth,
    });
  }
}

/* ------------------------------------------------------------------ *
 * boot()
 * ------------------------------------------------------------------ */

export interface BootOptions {
  /** The initial task set. Defaults to five flat tasks. */
  tasks?: readonly Task[];
  /** The initial link set. Defaults to none. */
  links?: readonly Link[];
  /** The plugin's own configuration. */
  config?: A11yConfig;
  /** What the selection stub reports from `mode()`. Defaults to `"single"`. */
  selectionMode?: "single" | "multi" | "none";
  /** `false` composes no `stargantt.selection` provider at all — the degraded composition. */
  selection?: boolean;
  /** Height the chart root reports. Defaults to 300 (12 rows of 24 px). */
  rootHeight?: number;
  /** Uniform row height. Defaults to 24. */
  rowHeight?: number;
  /** Extra plugins, composed between the stubs and the a11y plugin. */
  plugins?: readonly AnyPlugin[];
}

export interface Booted {
  host: TestHost;
  gantt: GanttInstance;
  root: HTMLElement;
  doc: Document;
  data: DataControl;
  view: ViewControl;
  grid: GridControl;
  bars: BarsControl;
  /** `undefined` in the degraded composition (`selection: false`). */
  selection: SelectionControl | undefined;
  focus: FocusService;
  /** The mirror container. */
  mirror: HTMLElement;
  /** The polite live region. */
  live: HTMLElement;
  /** The mirrored `role="row"` elements, in document order. */
  rows(): HTMLElement[];
  /** The row text of every mirrored row, in document order. */
  rowTexts(): string[];
  /** Fires a keydown on the document; returns whether `preventDefault` was called. */
  key(
    key: string,
    modifiers?: Partial<Record<"ctrl" | "alt" | "shift" | "meta", boolean>>,
    target?: EventTarget | null,
  ): boolean;
  /** Fires a document-level, capture-phase `pointerdown` targeting `target`. */
  pointerDown(target: EventTarget | null): void;
  /** Fires a document-level, capture-phase `focusin` targeting `target`. */
  focusIn(target: EventTarget | null): void;
  /** Runs every pending mirror frame callback. */
  flushFrames(): void;
  /** Draws the a11y focus layer onto a fresh canvas double. */
  drawFocusLayer(): FakeCanvasContext;
  /** Every `core/pluginError` payload, in emission order. */
  readonly faults: unknown[];
  dispose(): void;
}

/** Boots the a11y plugin over the recording stubs. */
export function boot(options: BootOptions = {}): Booted {
  const doc = globalThis.document;
  const root = doc.createElement("div");
  const height = options.rootHeight ?? 300;
  // happy-dom reports a zero-sized rect for every element, and the mirror derives its window size
  // from the root's height, so the measurement is stubbed to a real one.
  root.getBoundingClientRect = (() => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 400,
    bottom: height,
    width: 400,
    height,
    toJSON: () => ({}),
  })) as HTMLElement["getBoundingClientRect"];
  doc.body.appendChild(root);

  // Deterministic frames: the mirror reads `globalThis.requestAnimationFrame` per schedule, so the
  // queue below replaces it for the life of the booted chart and `flushFrames()` drains it.
  const frames: (() => void)[] = [];
  const realRaf = globalThis.requestAnimationFrame;
  const realCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = ((fn: () => void) => {
    frames.push(fn);
    return frames.length;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((handle: number) => {
    frames[handle - 1] = () => {};
  }) as typeof globalThis.cancelAnimationFrame;

  const data = dataStub(options.tasks ?? flatTasks(5), options.links ?? []);
  const view = viewStub({});
  const grid = treeGridStub({ data: data.control, rowHeight: options.rowHeight ?? 24 });
  const bars = taskBarsStub();
  const selection =
    options.selection === false ? undefined : selectionStub(options.selectionMode ?? "single");

  const faults: unknown[] = [];
  const faultProbe = definePlugin({
    meta: { id: "test.faults" },
    setup(ctx: PluginContext) {
      ctx.on("core/pluginError", (e) => faults.push(e));
    },
  });

  const host = createTestHost({
    element: root,
    plugins: [
      faultProbe,
      data.plugin,
      view.plugin,
      grid.plugin,
      bars.plugin,
      ...(selection === undefined ? [] : [selection.plugin]),
      ...(options.plugins ?? []),
      a11y(options.config),
    ],
  });

  const mirror = root.querySelector(".sg-a11y") as HTMLElement | null;
  const live = root.querySelector(".sg-a11y-live") as HTMLElement | null;
  if (mirror === null || live === null) throw new Error("the a11y mirror was not created");

  const fireKey = (
    key: string,
    modifiers: Partial<Record<"ctrl" | "alt" | "shift" | "meta", boolean>> = {},
    target: EventTarget | null = root,
  ): boolean => {
    const event = new globalThis.KeyboardEvent("keydown", {
      key,
      ctrlKey: modifiers.ctrl ?? false,
      altKey: modifiers.alt ?? false,
      shiftKey: modifiers.shift ?? false,
      metaKey: modifiers.meta ?? false,
      bubbles: true,
      cancelable: true,
    });
    (target ?? doc).dispatchEvent(event);
    return event.defaultPrevented;
  };

  const fire = (type: string, target: EventTarget | null): void => {
    const event = new globalThis.Event(type, { bubbles: true });
    (target ?? doc).dispatchEvent(event);
  };

  return {
    host,
    gantt: host.host,
    root,
    doc,
    data: data.control,
    view: view.control,
    grid: grid.control,
    bars: bars.control,
    selection: selection?.control,
    focus: host.host.service("stargantt.focus"),
    mirror,
    live,
    faults,
    rows: () => [...mirror.querySelectorAll(".sg-a11y-row")] as HTMLElement[],
    rowTexts: () =>
      ([...mirror.querySelectorAll(".sg-a11y-cell")] as HTMLElement[]).map(
        (cell) => cell.textContent ?? "",
      ),
    key: fireKey,
    pointerDown: (target) => fire("pointerdown", target),
    focusIn: (target) => fire("focusin", target),
    flushFrames: () => {
      const pending = frames.splice(0, frames.length);
      for (const fn of pending) fn();
    },
    drawFocusLayer(): FakeCanvasContext {
      const g = new FakeCanvasContext();
      const vp: Viewport = { scrollTop: 0, scrollLeft: 0, width: 400, height };
      for (const layer of view.control.layers()) {
        if (layer.id === "stargantt.a11y:focus") layer.draw(g, vp);
      }
      return g;
    },
    dispose(): void {
      host.dispose();
      root.remove();
      globalThis.requestAnimationFrame = realRaf;
      globalThis.cancelAnimationFrame = realCancel;
    },
  };
}

/** A plugin that runs `setup` under a chosen id — for contribution / ordering probes. */
export function probe(
  setup: (ctx: PluginContext) => void,
  id = "test.probe",
  dependsOn: string[] = [],
): AnyPlugin {
  return definePlugin({ meta: { id, dependsOn }, setup });
}
