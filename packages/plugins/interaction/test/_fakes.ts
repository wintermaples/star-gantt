/**
 * Hostless doubles this package's tests are written against.
 *
 * Every internal module of `@stargantt/plugin-interaction` declares what it reads as a narrow
 * structural interface, so a unit test hands it a plain object literal instead of booting a chart:
 * no `Gantt.create()`, no DOM, no canvas. The recording doubles below make what a module *did*
 * observable — which commands it dispatched, which lanes it marked, how far it asked the chart to
 * scroll — so the assertions are about behaviour rather than about mock call counts.
 */
import type { Task, TaskId } from "@stargantt/plugin-data-store";
import type {
  BarDownInput,
  BarHoverInput,
  BarMoveInput,
  BarUpInput,
  BackgroundInput,
  GridBackgroundMenuInput,
  GridDownInput,
  GridMoveInput,
  GridRowMenuInput,
  GridUpInput,
} from "../src/internal/gesture/arbiter";
import type { BarReader, DragViewport, TimeMapper } from "../src/internal/drag/deps";
import type { RowGeometry } from "../src/internal/drag/row-list";
import type { BarGeometry } from "../src/internal/selection/paint";

/* ------------------------------------------------------------------ *
 * Data
 * ------------------------------------------------------------------ */

/** One task, with the two required dates defaulted so a test states only what it cares about. */
export function task(over: Partial<Task> & { id: TaskId }): Task {
  return {
    parentId: null,
    name: `task-${String(over.id)}`,
    start: 0,
    end: 86_400_000,
    ...over,
  };
}

/** A `getTask` / `childrenOf` pair over a flat task list, in declaration order. */
export function store(tasks: readonly Task[]): {
  getTask(id: TaskId): Task | undefined;
  childrenOf(parent: TaskId | null): readonly TaskId[];
  tasks: readonly Task[];
} {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return {
    getTask: (id) => byId.get(id),
    childrenOf: (parent) => tasks.filter((t) => (t.parentId ?? null) === parent).map((t) => t.id),
    tasks,
  };
}

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

/** One bar box, with the two gutter members defaulted. */
export interface FakeBox {
  id: TaskId;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A bar-geometry double answering from a fixed list of boxes, in list order. */
export function bars(boxes: readonly FakeBox[]): BarGeometry & BarReader {
  const full = boxes.map((b) => ({ ...b, gutterStart: 0, gutterEnd: 0 }));
  return {
    barBoxOf: (id) => full.find((b) => b.id === id),
    visibleBoxes: () => full,
    hasOwnBar: (id) => full.some((b) => b.id === id),
  };
}

/** Options of the row-model double. */
export interface FakeRowsOptions {
  /** The row order: one entry per row, `undefined` for a row that carries no task. */
  order: readonly (TaskId | undefined)[];
  /** Uniform row height. Default 24. */
  rowHeight?: number;
  /** Rows (by task id) resolved to height 0 — the shape a filter produces. */
  zeroHeight?: readonly TaskId[];
}

/** A row-model double with uniform row heights. */
export function rowsOf(options: FakeRowsOptions): RowGeometry {
  const height = options.rowHeight ?? 24;
  const zero = new Set(options.zeroHeight ?? []);
  const heightAt = (row: number): number => {
    const id = options.order[row];
    return id !== undefined && zero.has(id) ? 0 : height;
  };
  const topOf = (row: number): number => {
    let y = 0;
    for (let i = 0; i < row; i += 1) y += heightAt(i);
    return y;
  };
  return {
    rowCount: () => options.order.length,
    taskIdAt: (row) => options.order[row],
    rowOf: (id) => {
      const index = options.order.indexOf(id);
      return index === -1 ? undefined : index;
    },
    rowHeight: heightAt,
    yOf: topOf,
    rowAtY: (y) => {
      for (let row = 0; row < options.order.length; row += 1) {
        if (y < topOf(row) + heightAt(row)) return row;
      }
      return Math.max(0, options.order.length - 1);
    },
  };
}

/** A time mapper that records the origin-extension holds it was asked for. */
export interface FakeTimeline extends TimeMapper {
  /** Every `requestOriginExtension` argument, in order. */
  readonly extensions: number[];
  /** How often the hold was released. */
  releases(): number;
}

/** A linear time mapper: `x = t * pxPerMs`, with a recording origin hold. */
export function timelineOf(pxPerMs = 0.001): FakeTimeline {
  const extensions: number[] = [];
  let released = 0;
  return {
    tToX: (t) => t * pxPerMs,
    xToT: (x) => x / pxPerMs,
    pxPerMs,
    requestOriginExtension: (t) => {
      extensions.push(t);
    },
    releaseOriginExtension: () => {
      released += 1;
    },
    extensions,
    releases: () => released,
  };
}

/** A mutable viewport double. */
export function viewportOf(over: Partial<DragViewport> = {}): DragViewport {
  return { scrollLeft: 0, scrollTop: 0, width: 800, height: 600, ...over };
}

/* ------------------------------------------------------------------ *
 * Input builders
 * ------------------------------------------------------------------ */

/** The pointer-event fields every input builder below copies through. */
export interface FakePointer {
  pointerId?: number;
  clientX?: number;
  clientY?: number;
  buttons?: number;
  button?: number;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  type?: string;
}

/** A `PointerEvent` stand-in: only the fields this plugin reads, nothing else. */
export function pointer(over: FakePointer = {}): PointerEvent {
  return {
    pointerId: 1,
    clientX: 0,
    clientY: 0,
    buttons: 1,
    button: 0,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    type: "pointerdown",
    ...over,
  } as unknown as PointerEvent;
}

/** A hit result for a task's bar body (or another kind when one is named). */
export function hit(id: TaskId, kind = "bar"): { kind: string; id: TaskId; cursor: string } {
  return { kind, id, cursor: "default" };
}

export function barHover(id?: TaskId, x = 10, y = 10): BarHoverInput {
  return id === undefined ? { x, y } : { hit: hit(id), x, y };
}

export function barDown(
  id: TaskId,
  over: FakePointer & { kind?: string; x?: number; y?: number } = {},
): BarDownInput {
  const { kind, x, y, ...rest } = over;
  return {
    hit: hit(id, kind ?? "bar"),
    x: x ?? 0,
    y: y ?? 0,
    event: pointer({ type: "pointerdown", ...rest }),
  };
}

export function barMove(
  over: FakePointer & { id?: TaskId; kind?: string; x?: number; y?: number } = {},
): BarMoveInput {
  const { id, kind, x, y, ...rest } = over;
  const base = { x: x ?? 0, y: y ?? 0, event: pointer({ type: "pointermove", ...rest }) };
  return id === undefined ? base : { ...base, hit: hit(id, kind ?? "bar") };
}

export function barUp(
  over: FakePointer & { id?: TaskId; kind?: string; x?: number; y?: number } = {},
): BarUpInput {
  const { id, kind, x, y, ...rest } = over;
  const base = { x: x ?? 0, y: y ?? 0, event: pointer({ type: "pointerup", buttons: 0, ...rest }) };
  return id === undefined ? base : { ...base, hit: hit(id, kind ?? "bar") };
}

export function background(over: FakePointer & { x?: number; y?: number } = {}): BackgroundInput {
  const { x, y, ...rest } = over;
  return { x: x ?? 0, y: y ?? 0, event: pointer({ type: "pointerdown", ...rest }) };
}

export function gridDown(id: TaskId, over: Partial<GridDownInput> = {}): GridDownInput {
  return {
    id,
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
    ...over,
  };
}

export function gridMove(over: Partial<GridMoveInput> = {}): GridMoveInput {
  return {
    pointerId: 1,
    x: 0,
    y: 0,
    clientX: 0,
    clientY: 0,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...over,
  };
}

export function gridUp(over: Partial<GridUpInput> = {}): GridUpInput {
  return { pointerId: 1, x: 0, y: 0, clientX: 0, clientY: 0, cancelled: false, ...over };
}

export function gridRowMenu(id: TaskId, over: Partial<GridRowMenuInput> = {}): GridRowMenuInput {
  return { id, row: 0, x: 0, y: 0, ...over };
}

export function gridBackgroundMenu(
  over: Partial<GridBackgroundMenuInput> = {},
): GridBackgroundMenuInput {
  return { x: 0, y: 0, ...over };
}
