/**
 * Hostless doubles the `selection-*` test files are written against.
 *
 * `stargantt.selection` is not its own plugin but a module assembled by
 * `createSelectionModule` from a plain `SelectionDeps` bag (geometry, row order, grid mirror,
 * viewport, scroll, store reads, command dispatch, fault channel). These doubles feed that bag
 * directly, so a test drives the whole feature without `Gantt.create()`, without a DOM (except the
 * bulk-delete / delete-flow tests, which need a real `HTMLElement` for the SDK dialog and carry
 * `// @vitest-environment happy-dom` themselves), and without a canvas.
 */
import { resolveConfig } from "../src/config";
import type { SelectionConfig } from "../src/config";
import { resolveMessages } from "../src/messages";
import type { InteractionMessages } from "../src/messages";
import { createSelectionModule } from "../src/internal/selection/service";
import type { SelectionModule, SelectionPress } from "../src/internal/selection/service";
import type { PressModifiers, PointerPoint } from "../src/internal/selection/deferred-collapse";
import type { BarGeometry } from "../src/internal/selection/paint";
import type { TaskId } from "@stargantt/plugin-data-store";
import type { BarBox } from "@stargantt/plugin-task-bars";

/* ------------------------------------------------------------------ *
 * Canvas double
 * ------------------------------------------------------------------ */

/** One recorded canvas call, with the style state active at the moment it was made. */
export interface RecordedOp {
  op: "strokeRect" | "fillRect";
  args: readonly [number, number, number, number];
  strokeStyle: string;
  fillStyle: string;
  lineWidth: number;
}

/** A recording 2D-context double: every `strokeRect` / `fillRect` call, in order. */
export interface FakeCanvas {
  readonly ops: RecordedOp[];
  /** Every call to `op`, in order. */
  calls(op: "strokeRect" | "fillRect"): RecordedOp[];
}

/** A `CanvasRenderingContext2D` stand-in exposing only what `internal/selection/paint.ts` uses. */
export function fakeCanvas(): CanvasRenderingContext2D & FakeCanvas {
  const ops: RecordedOp[] = [];
  let strokeStyle = "";
  let fillStyle = "";
  let lineWidth = 1;
  const ctx = {
    ops,
    calls: (op: "strokeRect" | "fillRect") => ops.filter((o) => o.op === op),
    get strokeStyle(): string {
      return strokeStyle;
    },
    set strokeStyle(v: string) {
      strokeStyle = v;
    },
    get fillStyle(): string {
      return fillStyle;
    },
    set fillStyle(v: string) {
      fillStyle = v;
    },
    get lineWidth(): number {
      return lineWidth;
    },
    set lineWidth(v: number) {
      lineWidth = v;
    },
    strokeRect(x: number, y: number, w: number, h: number): void {
      ops.push({ op: "strokeRect", args: [x, y, w, h], strokeStyle, fillStyle, lineWidth });
    },
    fillRect(x: number, y: number, w: number, h: number): void {
      ops.push({ op: "fillRect", args: [x, y, w, h], strokeStyle, fillStyle, lineWidth });
    },
  };
  return ctx as unknown as CanvasRenderingContext2D & FakeCanvas;
}

/* ------------------------------------------------------------------ *
 * Geometry / row-order doubles — mutable, so a test can move bars and rows mid-gesture
 * (`b.visible.push(...)`, `b.rows.shift()`) through the fake host plugins.
 * ------------------------------------------------------------------ */

/** One bar box, with the two gutter members defaulted to 0. */
export interface FakeBox {
  id: TaskId;
  x: number;
  y: number;
  width?: number;
  height?: number;
}

export function makeBox(id: TaskId, x: number, y: number, width = 40, height = 20): FakeBox {
  return { id, x, y, width, height };
}

/** A bar-geometry double backed by a live, mutable array of boxes. */
export interface MutableBars extends BarGeometry {
  /** The boxes currently "on screen" — mutate freely between calls. */
  readonly boxes: FakeBox[];
}

export function mutableBars(initial: readonly FakeBox[] = []): MutableBars {
  const boxes: FakeBox[] = [...initial];
  const full = (b: FakeBox): BarBox => ({
    id: b.id,
    x: b.x,
    y: b.y,
    width: b.width ?? 40,
    height: b.height ?? 20,
    gutterStart: 0,
    gutterEnd: 0,
  });
  return {
    boxes,
    barBoxOf: (id) => {
      const found = boxes.find((b) => b.id === id);
      return found === undefined ? undefined : full(found);
    },
    visibleBoxes: () => boxes.map(full),
  };
}

/** One row of the composed row order — a mutable twin of `RowModelService`'s slice this feature reads. */
export interface MutableRow {
  id: TaskId;
  height: number;
}

/** The row-order shape `createSelectionModule`'s `SelectionDeps.rows` reads. */
export interface MutableRows {
  readonly rows: MutableRow[];
  rowOf(id: TaskId): number | undefined;
  rowHeight(row: number): number;
  taskIdAt(row: number): TaskId | undefined;
}

export function mutableRows(initial: readonly MutableRow[] = []): MutableRows {
  const rows: MutableRow[] = [...initial];
  return {
    rows,
    rowOf: (id) => {
      const at = rows.findIndex((r) => r.id === id);
      return at === -1 ? undefined : at;
    },
    rowHeight: (row) => rows[row]?.height ?? 0,
    taskIdAt: (row) => rows[row]?.id,
  };
}

/* ------------------------------------------------------------------ *
 * Press / pointer-event builders
 * ------------------------------------------------------------------ */

/** Modifiers plus press-time pointer identity/position, as `SelectionPress` reads them. */
export interface PressOverrides extends Partial<PressModifiers> {
  pointerId?: number;
  clientX?: number;
  clientY?: number;
}

export function press(id: TaskId, over: PressOverrides = {}): SelectionPress {
  return {
    id,
    ctrlKey: over.ctrlKey ?? false,
    metaKey: over.metaKey ?? false,
    shiftKey: over.shiftKey ?? false,
    pointerId: over.pointerId ?? 1,
    clientX: over.clientX ?? 0,
    clientY: over.clientY ?? 0,
    type: "pointerdown",
  };
}

export function point(over: Partial<PointerPoint> = {}): PointerPoint {
  return {
    pointerId: over.pointerId ?? 1,
    clientX: over.clientX ?? 0,
    clientY: over.clientY ?? 0,
    type: over.type ?? "pointerup",
  };
}

/* ------------------------------------------------------------------ *
 * The selection module harness
 * ------------------------------------------------------------------ */

export interface SelectionHarness {
  readonly module: SelectionModule;
  readonly bars: MutableBars;
  readonly rows: MutableRows;
  readonly viewport: { scrollLeft: number; width: number };
  /** One entry per `deps.invalidate()` call. */
  readonly invalidations: unknown[];
  /** Every `deps.setGridSelected` call, as plain arrays, in order. */
  readonly mirrors: TaskId[][];
  /** Every `deps.scrollTo` argument, in order. */
  readonly scrolls: number[];
  /** Every `deps.removeTasks` argument, in order. */
  readonly removed: TaskId[][];
  /** Every `deps.reportError` argument, in order. */
  readonly errors: unknown[];
  /** Every `service.state` notification, in order. */
  readonly storeSnapshots: { taskIds: ReadonlySet<TaskId>; anchor?: TaskId }[];
  /** The ids `deps.taskIds()` reports — the select-all source. Mutate freely. */
  readonly taskIds: TaskId[];
  /** Per-task dates for the reveal's geometry-less fallback. Mutate freely. */
  readonly taskDates: Map<TaskId, { start: number; end: number }>;
  /** Slope of `deps.tToX`; `x = t * pxPerMs`. */
  pxPerMs: number;
  readonly root: HTMLElement;
}

export interface HarnessOptions {
  /** The chart root the confirm dialog mounts under. Only touched by `deleteSelected()`. */
  root?: HTMLElement;
  /** Message catalog overrides, resolved exactly as `index.ts` resolves them. */
  messages?: Partial<InteractionMessages>;
}

/**
 * Builds a fresh `createSelectionModule` instance wired to recording/mutable doubles.
 *
 * `rawConfig` is the `SelectionConfig` nest a host would pass to `interaction({ selection })`,
 * resolved through the real `resolveConfig` — so a harness test exercises the same resolution pass
 * a booted plugin would.
 */
export function harness(rawConfig: SelectionConfig = {}, opts: HarnessOptions = {}): SelectionHarness {
  const resolved = resolveConfig({ selection: rawConfig }).selection;
  const errors: unknown[] = [];
  const messages = resolveMessages(opts.messages, (key, error) => errors.push({ key, error }));

  const bars = mutableBars();
  const rows = mutableRows();
  const viewport = { scrollLeft: 0, width: 800 };
  const invalidations: unknown[] = [];
  const mirrors: TaskId[][] = [];
  const scrolls: number[] = [];
  const removed: TaskId[][] = [];
  const taskIds: TaskId[] = [];
  const taskDates = new Map<TaskId, { start: number; end: number }>();
  const root = opts.root ?? ({} as HTMLElement);

  const state = { pxPerMs: 0.001 };

  const module = createSelectionModule(resolved, messages, {
    geometry: bars,
    rows,
    setGridSelected: (ids) => mirrors.push([...ids]),
    invalidate: () => invalidations.push(1),
    viewport: () => ({ ...viewport }),
    scrollTo: (scrollLeft) => scrolls.push(scrollLeft),
    tToX: (t) => t * state.pxPerMs,
    taskDates: (id) => taskDates.get(id),
    taskIds: () => taskIds,
    removeTasks: (ids) => removed.push([...ids]),
    root,
    reportError: (error) => errors.push(error),
  });

  const storeSnapshots: { taskIds: ReadonlySet<TaskId>; anchor?: TaskId }[] = [];
  module.service.state.subscribe((next) => storeSnapshots.push(next));

  return {
    module,
    bars,
    rows,
    viewport,
    invalidations,
    mirrors,
    scrolls,
    removed,
    errors,
    storeSnapshots,
    taskIds,
    taskDates,
    get pxPerMs(): number {
      return state.pxPerMs;
    },
    set pxPerMs(v: number) {
      state.pxPerMs = v;
    },
    root,
  };
}
