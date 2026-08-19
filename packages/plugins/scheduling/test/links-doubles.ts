/**
 * Hostless doubles for the links area (docs/specs/plugins/scheduling.md §5).
 *
 * Two levels:
 *
 * - the *slice* stubs (`stubRows`, `stubData`, `viewport`, `rect`) — `internal/links/routes` reads
 *   the chart through `Pick`s of the real `RowsService` / `DataService` / `Viewport`, so a plain
 *   object with those few methods is a complete, type-checked stand-in;
 * - the *recording* `PluginContext` and service doubles, which let `wireLinks(deps)` run with no
 *   core, no sibling plugin and no DOM, while every contribution, command dispatch, subscription
 *   and owned disposable is recorded for assertion.
 *
 * They are deliberately not a second copy of `@stargantt/sdk`'s test harness: nothing here fakes a
 * browser, only this area's own service seam. `test/_helpers.ts` stays untouched and is imported,
 * never modified.
 */
import { mockStore } from "@stargantt/sdk";
import type { WritableStore } from "@stargantt/core";
import type { Disposable, PluginContext } from "@stargantt/core";
import type { Link, LinkType, ReadonlyDataView, Task, TaskId } from "@stargantt/plugin-data-store";
import type { FocusState } from "@stargantt/plugin-a11y";
import type { SelectionState } from "@stargantt/plugin-interaction";
import type { BarBox } from "@stargantt/plugin-task-bars";
import type { Viewport } from "@stargantt/plugin-view";
import type { Rect } from "../src/internal/links/geometry";
import type { DataSlice, RowSlice, ViewportSlice } from "../src/internal/links/routes";

/* ------------------------------------------------------------------ *
 * Slice stubs
 * ------------------------------------------------------------------ */

/** A task with just the fields the route index reads, plus a name for announcements. */
export function stubTask(id: string, over: Partial<Task> = {}): Task {
  return { id, parentId: null, name: id, start: 0, end: 1, ...over };
}

/** A link record. */
export function stubLink(
  id: string,
  sourceId: string,
  targetId: string,
  type: LinkType = "FS",
  lag?: number,
): Link {
  return lag === undefined ? { id, sourceId, targetId, type } : { id, sourceId, targetId, type, lag };
}

/** A rectangle, in the content coordinates every route works in. */
export function rect(x: number, y: number, width = 100, height = 20): Rect {
  return { x, y, width, height };
}

/** Fixed-height rows carrying the given task ids in order; `undefined` means an unmapped row. */
export function stubRows(ids: (TaskId | undefined)[], rowHeight = 30): RowSlice {
  return {
    rowCount: () => ids.length,
    // Clamps to the last row exactly as the real row model does, which is what makes the route
    // index's own band check load-bearing.
    rowAtY: (y) => {
      const raw = Math.floor(y / rowHeight);
      const index = Number.isFinite(raw) ? raw : 0;
      return Math.min(Math.max(index, 0), Math.max(ids.length - 1, 0));
    },
    yOf: (row) => row * rowHeight,
    rowHeight: () => rowHeight,
    taskIdAt: (row) => ids[row],
  };
}

/** A store slice over fixed tasks and links, counting how often the link table was rebuilt. */
export interface StubData extends DataSlice {
  /** How many times `query()` has been called — i.e. how often routes were rebuilt. */
  queries: number;
}

export function stubData(tasks: readonly Task[], links: readonly Link[] = []): StubData {
  const byId = new Map<TaskId, Readonly<Task>>(tasks.map((t) => [t.id, t]));
  const linksByTask = new Map<TaskId, { in: Link[]; out: Link[] }>();
  const bucket = (id: TaskId): { in: Link[]; out: Link[] } => {
    let found = linksByTask.get(id);
    if (found === undefined) {
      found = { in: [], out: [] };
      linksByTask.set(id, found);
    }
    return found;
  };
  for (const l of links) {
    bucket(l.sourceId).out.push(l);
    bucket(l.targetId).in.push(l);
  }
  const view: ReadonlyDataView = {
    byId,
    children: new Map(),
    linksByTask,
    calendars: new Map(),
    resources: new Map(),
    assignmentsByTask: new Map(),
  };
  const stub: StubData = {
    queries: 0,
    getTask: (id) => byId.get(id),
    query: () => {
      stub.queries += 1;
      return view;
    },
  };
  return stub;
}

/** A viewport slice. */
export function viewport(over: Partial<ViewportSlice> = {}): ViewportSlice {
  return { scrollLeft: 0, scrollTop: 0, height: 300, ...over };
}

/** A full viewport value, for the doubles that publish one. */
export function fullViewport(over: Partial<Viewport> = {}): Viewport {
  return { scrollLeft: 0, scrollTop: 0, width: 800, height: 300, ...over };
}

/* ------------------------------------------------------------------ *
 * A recording canvas
 * ------------------------------------------------------------------ */

/** One recorded canvas call: the method name and its arguments. */
export interface DrawCall {
  op: string;
  args: readonly unknown[];
}

/** A 2d context double that records every call and every style assignment made through it. */
export interface RecordingCanvas {
  g: CanvasRenderingContext2D;
  calls: DrawCall[];
  /** Every value assigned to `strokeStyle`, in order. */
  strokes: string[];
  /** Every value assigned to `fillStyle`, in order. */
  fills: string[];
  /** Every value assigned to `lineWidth`, in order. */
  widths: number[];
  /** Every value assigned to `globalAlpha`, in order. */
  alphas: number[];
  /** Calls of one op, in order. */
  of(op: string): DrawCall[];
}

const CANVAS_METHODS = [
  "beginPath",
  "closePath",
  "moveTo",
  "lineTo",
  "arc",
  "stroke",
  "fill",
  "save",
  "restore",
  "setLineDash",
] as const;

/** Creates the recording 2d context double. */
export function recordingCanvas(): RecordingCanvas {
  const calls: DrawCall[] = [];
  const strokes: string[] = [];
  const fills: string[] = [];
  const widths: number[] = [];
  const alphas: number[] = [];
  const target: Record<string, unknown> = {};
  for (const op of CANVAS_METHODS) {
    target[op] = (...args: unknown[]): void => {
      calls.push({ op, args });
    };
  }
  const g = new Proxy(target, {
    set(_t, prop, value: unknown) {
      if (prop === "strokeStyle") strokes.push(String(value));
      else if (prop === "fillStyle") fills.push(String(value));
      else if (prop === "lineWidth") widths.push(Number(value));
      else if (prop === "globalAlpha") alphas.push(Number(value));
      target[String(prop)] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return {
    g,
    calls,
    strokes,
    fills,
    widths,
    alphas,
    of: (op) => calls.filter((c) => c.op === op),
  };
}

/* ------------------------------------------------------------------ *
 * Service doubles
 * ------------------------------------------------------------------ */

/** The view double: an invalidation log plus the viewport store the area reads. */
export interface ViewDouble {
  invalidated: string[];
  viewport: WritableStore<Readonly<Viewport>>;
}

/** The task-bars double: fixed boxes plus the `hasOwnBar` answer per id. */
export interface BarsDouble {
  boxes: Map<TaskId, Rect>;
  ownBars: Set<TaskId>;
}

/** A dispatched command, as the recording context saw it. */
export interface DispatchRecord {
  key: string;
  payload: unknown;
}

/** An order claim, as the recording context saw it. */
export interface OrderClaim {
  scope: string;
  key: string;
  order: number;
}

/** Everything a wired area did against its context. */
export interface RecordingContext {
  ctx: PluginContext;
  /** Contributions by extension-point key, in registration order. */
  contributions: Map<string, unknown[]>;
  /** Every `ctx.dispatch(...)`, in order. */
  dispatched: DispatchRecord[];
  /** Every `ctx.claimOrder(...)`, in order. */
  orders: OrderClaim[];
  /** Every `ctx.emit(...)`, in order. */
  emitted: DispatchRecord[];
  /** Event handlers by event key, in registration order. */
  handlers: Map<string, ((e: never) => void)[]>;
  /** Every disposable handed to `ctx.own()`. */
  owned: Disposable[];
  /** Delivers one event to every handler registered for it. */
  fire(key: string, event: unknown): void;
  /** The contributions of one point, typed by the caller. */
  contributedTo<T>(key: string): T[];
  /** Disposes everything the area owned, in registration order. */
  disposeAll(): void;
}

/** What the recording context resolves service lookups with. */
export interface ServiceTable {
  [key: string]: unknown;
}

/**
 * A `PluginContext` double that answers `use` / `useOptional` from `services` and records
 * everything else. `use` of a key the table does not carry throws, exactly as the real core does
 * for an unprovided service.
 */
export function recordingContext(services: ServiceTable): RecordingContext {
  const contributions = new Map<string, unknown[]>();
  const dispatched: DispatchRecord[] = [];
  const emitted: DispatchRecord[] = [];
  const orders: OrderClaim[] = [];
  const handlers = new Map<string, ((e: never) => void)[]>();
  const owned: Disposable[] = [];

  const ctx = {
    provide(): void {},
    use(key: string): unknown {
      if (!(key in services)) throw new Error(`stargantt: service "${key}" is not provided`);
      return services[key];
    },
    useOptional(key: string): unknown {
      return services[key];
    },
    defineExtensionPoint(key: string, reduce: (inputs: never[]) => unknown): unknown {
      return { key, get: () => reduce((contributions.get(key) ?? []) as never[]) };
    },
    contribute(key: string, value: unknown): void {
      const list = contributions.get(key);
      if (list === undefined) contributions.set(key, [value]);
      else list.push(value);
    },
    on(key: string, fn: (e: never) => void): Disposable {
      const list = handlers.get(key);
      if (list === undefined) handlers.set(key, [fn]);
      else list.push(fn);
      return { dispose: () => undefined };
    },
    emit(key: string, payload: unknown): void {
      emitted.push({ key, payload });
    },
    registerCommand(): void {},
    dispatch(key: string, payload: unknown): void {
      dispatched.push({ key, payload });
    },
    claimOrder(scope: string, key: string, order: number): void {
      orders.push({ scope, key, order });
    },
    claimKey(): void {},
    claimSlot(): { granted: boolean } {
      return { granted: true };
    },
    own(d: Disposable): void {
      owned.push(d);
    },
    root: {} as unknown as HTMLElement,
    locale: "en",
  } as unknown as PluginContext;

  return {
    ctx,
    contributions,
    dispatched,
    emitted,
    orders,
    handlers,
    owned,
    fire(key: string, event: unknown): void {
      for (const fn of handlers.get(key) ?? []) (fn as (e: unknown) => void)(event);
    },
    contributedTo<T>(key: string): T[] {
      return (contributions.get(key) ?? []) as T[];
    },
    disposeAll(): void {
      for (const d of owned) d.dispose();
    },
  };
}

/** Builds the service table `wireLinks` looks up, with the optional edges opt-in. */
export interface ServicesOptions {
  data: unknown;
  view: ViewDouble;
  bars: BarsDouble;
  rows?: RowSlice | undefined;
  rowsStore?: WritableStore<unknown> | undefined;
  selection?: WritableStore<SelectionState> | undefined;
  focus?: { state: WritableStore<FocusState>; announced: string[] } | undefined;
  /** Theme token values; a token absent here resolves to the empty string (→ the fallback). */
  tokens?: Record<string, string>;
  zoom?: WritableStore<unknown> | undefined;
}

/** A view double with an invalidation log. */
export function viewDouble(vp: Viewport = fullViewport()): ViewDouble {
  return { invalidated: [], viewport: mockStore<Readonly<Viewport>>(vp) };
}

/** A task-bars double over a fixed box map; every mapped id has its own bar unless excluded. */
export function barsDouble(boxes: Map<TaskId, Rect>, ownBars?: Iterable<TaskId>): BarsDouble {
  return { boxes, ownBars: new Set(ownBars ?? boxes.keys()) };
}

/** A focus-service double with an announcement log. */
export function focusDouble(focused?: TaskId): {
  state: WritableStore<FocusState>;
  announced: string[];
} {
  return { state: mockStore<FocusState>({ focused }), announced: [] };
}

/**
 * The service table `wireLinks` resolves against: `stargantt.view` / `stargantt.timeline` /
 * `stargantt.theme` / `stargantt.task-bars` hard, and `stargantt.rows` / `stargantt.selection` /
 * `stargantt.focus` present only when the caller supplies them.
 */
export function serviceTable(options: ServicesOptions): ServiceTable {
  const tokens = options.tokens ?? {};
  const table: ServiceTable = {
    "stargantt.data": options.data,
    "stargantt.view": {
      invalidate: (layer: string) => options.view.invalidated.push(layer),
      viewport: options.view.viewport,
    },
    "stargantt.timeline": { zoomLevel: options.zoom ?? mockStore({ id: "day" }) },
    "stargantt.theme": { get: (token: string) => tokens[token] ?? "" },
    "stargantt.task-bars": {
      barRect: (id: TaskId) => options.bars.boxes.get(id) as BarBox | undefined,
      hasOwnBar: (id: TaskId) => options.bars.ownBars.has(id),
    },
  };
  if (options.rows !== undefined) {
    table["stargantt.rows"] = {
      ...options.rows,
      rows: options.rowsStore ?? mockStore({ rows: [] }),
    };
  }
  if (options.selection !== undefined) {
    table["stargantt.selection"] = { state: options.selection };
  }
  if (options.focus !== undefined) {
    const focus = options.focus;
    table["stargantt.focus"] = {
      state: focus.state,
      announce: (message: string) => focus.announced.push(message),
    };
  }
  return table;
}

/** A `pointer/barDown`-shaped event over a hit shape. */
export function pointerEvent(
  x: number,
  y: number,
  over: { type?: string; pointerId?: number } = {},
): { x: number; y: number; event: PointerEvent } {
  return {
    x,
    y,
    event: {
      type: over.type ?? "pointerdown",
      pointerId: over.pointerId ?? 1,
    } as unknown as PointerEvent,
  };
}
