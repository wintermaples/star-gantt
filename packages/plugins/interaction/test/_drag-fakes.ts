/**
 * Extra hostless doubles for the `internal/drag/*` and `internal/gesture/*` modules, layered over
 * `./_fakes.ts`.
 *
 * `dragHarness()` builds a plain `DragEditDeps` object literal instead of a real `Gantt.create()`
 * over a fake DOM — no host, no canvas, no renderer
 * — with every side effect (`task/move`, `task/setProgress`, `task/update`, the drop indicator, the
 * overlay invalidation, the scroll) recorded on plain arrays/counters a test can assert on directly.
 */
import type { Task, TaskId } from "@stargantt/plugin-data-store";
import { MS_DAY } from "@stargantt/sdk";
import { resolveConfig } from "../src/config";
import type { DragEditConfig, ResolvedDragEdit } from "../src/config";
import { resolveMessages } from "../src/messages";
import type { InteractionMessages } from "../src/messages";
import type { LaneBox, LaneDragProvider, SnapService } from "../src/types";
import type { DragEditDeps, DragViewport } from "../src/internal/drag/deps";
import type { PreviewLink } from "../src/internal/drag/dependency-preview";
import { bars, rowsOf, store, timelineOf, viewportOf } from "./_fakes";
import type { FakeBox, FakeRowsOptions, FakeTimeline } from "./_fakes";

/* ------------------------------------------------------------------ *
 * Small standalone doubles
 * ------------------------------------------------------------------ */

/** A rounding rule that changes nothing — the "no snap plugin composed" case (§2.2). */
export function identitySnap(): SnapService {
  return {
    snap: (t) => t,
    step: (t, direction) => direction * 86_400_000,
  };
}

/** One recorded `task/move`. */
export interface Move {
  id: TaskId;
  start: number;
  end: number;
  coalesceKey?: string;
}

/** One recorded `task/setProgress`. */
export interface ProgressSet {
  id: TaskId;
  progress: number;
  coalesceKey?: string;
}

/** One recorded `task/update` (a row drop's write). */
export interface RowUpdate {
  id: TaskId;
  parentId: TaskId | null;
  orderKey: string;
}

/** The drop-indicator mark, or `null` for a clear. */
export type DropMark = { y: number; depth: number } | null;

/**
 * A recording lane provider (`drag/lanes`): a fixed list of lanes at root-relative y-bands, plus
 * recorders for every reassignment and every `highlightLane` mark, a `stargantt.resource-view`
 * stand-in restated as the structural seam.
 */
export interface FakeLaneProvider extends LaneDragProvider {
  readonly reassigns: { taskId: TaskId; from: string; to: string }[];
  readonly marks: (string | null)[];
}

export interface FakeLaneOptions {
  lanes?: readonly LaneBox[];
  /** `laneOfTask` answers from this map when given; omitted, the provider offers no such member. */
  laneOfTask?: (id: TaskId) => LaneBox | undefined;
  /** `false` omits `highlightLane`, so the drag runs unmarked. Default `true`. */
  highlight?: boolean;
}

export function laneProviderOf(options: FakeLaneOptions = {}): FakeLaneProvider {
  const lanes = options.lanes ?? [];
  const reassigns: { taskId: TaskId; from: string; to: string }[] = [];
  const marks: (string | null)[] = [];
  const provider: FakeLaneProvider = {
    laneAt: (y) => lanes.find((lane) => y >= lane.y && y < lane.y + lane.height),
    reassign: (taskId, from, to) => {
      reassigns.push({ taskId, from, to });
    },
    reassigns,
    marks,
  };
  if (options.highlight !== false) {
    provider.highlightLane = (resourceId) => {
      marks.push(resourceId);
    };
  }
  if (options.laneOfTask !== undefined) provider.laneOfTask = options.laneOfTask;
  return provider;
}

/* ------------------------------------------------------------------ *
 * A recording 2D canvas context, for `DragController.draw` / `BarDrag.draw`
 * ------------------------------------------------------------------ */

/** One painted operation, with the style state active at the time it ran. */
export interface CanvasOp {
  op: "fillRect" | "strokeRect" | "beginPath" | "moveTo" | "lineTo" | "stroke";
  args: readonly number[];
  fill: string;
  stroke: string;
  lineWidth: number;
  /** The dash pattern in effect for this op (set by the most recent `setLineDash`). */
  dash: readonly number[];
}

export interface RecordingContext {
  /** Cast to `CanvasRenderingContext2D` at the call site — it implements only what this plugin uses. */
  readonly ctx: CanvasRenderingContext2D;
  calls(op: CanvasOp["op"]): CanvasOp[];
  reset(): void;
}

/** A minimal `CanvasRenderingContext2D` double that records every draw call it receives. */
export function recordingContext(): RecordingContext {
  let fill = "";
  let stroke = "";
  let lineWidth = 1;
  let dash: number[] = [];
  const ops: CanvasOp[] = [];
  const record = (op: CanvasOp["op"], args: readonly number[]): void => {
    ops.push({ op, args, fill, stroke, lineWidth, dash: [...dash] });
  };
  const target = {
    get fillStyle(): string {
      return fill;
    },
    set fillStyle(v: string) {
      fill = v;
    },
    get strokeStyle(): string {
      return stroke;
    },
    set strokeStyle(v: string) {
      stroke = v;
    },
    get lineWidth(): number {
      return lineWidth;
    },
    set lineWidth(v: number) {
      lineWidth = v;
    },
    fillRect: (x: number, y: number, w: number, h: number) => record("fillRect", [x, y, w, h]),
    strokeRect: (x: number, y: number, w: number, h: number) => record("strokeRect", [x, y, w, h]),
    setLineDash: (pattern: readonly number[]) => {
      dash = [...pattern];
    },
    beginPath: () => record("beginPath", []),
    moveTo: (x: number, y: number) => record("moveTo", [x, y]),
    lineTo: (x: number, y: number) => record("lineTo", [x, y]),
    stroke: () => record("stroke", []),
  };
  return {
    ctx: target as unknown as CanvasRenderingContext2D,
    calls: (op) => ops.filter((o) => o.op === op),
    reset: () => {
      ops.length = 0;
    },
  };
}

/* ------------------------------------------------------------------ *
 * A stub DOM element, for the drag tooltip's mount point
 * ------------------------------------------------------------------ */

/** A stub node satisfying exactly what `createDragTooltip` touches (see drag-tooltip.ts). */
export interface FakeTooltipNode {
  className: string;
  textContent: string;
  style: Record<string, string>;
  offsetWidth: number;
  offsetHeight: number;
  remove(): void;
}

/** A stub pane + document pair for `deps.chartPane()` / `deps.root.ownerDocument`. */
export interface FakeTooltipMount {
  root: HTMLElement;
  chartPane: HTMLElement;
  /** Every node `createElement("div")` produced, in creation order. */
  nodes: FakeTooltipNode[];
}

/**
 * A hostless stand-in for the tooltip's mount point: no real DOM, since `createDragTooltip` only
 * ever calls `doc.createElement`, `pane.appendChild`, and reads/writes the node's own properties —
 * the same thing `drag-tooltip.test.ts` stubs directly.
 */
export function fakeTooltipMount(): FakeTooltipMount {
  const nodes: FakeTooltipNode[] = [];
  const doc = {
    createElement: (): FakeTooltipNode => {
      const node: FakeTooltipNode = {
        className: "",
        textContent: "",
        style: {},
        offsetWidth: 80,
        offsetHeight: 20,
        remove: () => {},
      };
      nodes.push(node);
      return node;
    },
  };
  const chartPane = { appendChild: () => {} };
  const root = { ownerDocument: doc, getBoundingClientRect: () => ({ top: 0, left: 0 }) };
  return {
    root: root as unknown as HTMLElement,
    chartPane: chartPane as unknown as HTMLElement,
    nodes,
  };
}

/* ------------------------------------------------------------------ *
 * The drag harness: a full `DragEditDeps`, wired to recording arrays
 * ------------------------------------------------------------------ */

export interface DragHarnessOptions {
  /** Defaults to three one-day tasks `t0`, `t1`, `t2`. */
  tasks?: Task[];
  /** Bar boxes, one per task by default: 40px/day wide, 20px tall, 28px rows. */
  boxes?: readonly FakeBox[];
  /** The row order; defaults to the tasks' own ids, in order. */
  rowOrder?: readonly (TaskId | undefined)[];
  rowHeight?: number;
  /** Pixels per millisecond of the fake timeline. Default 1 (1 client px == 1 ms). */
  pxPerMs?: number;
  viewport?: Partial<DragViewport>;
  links?: readonly PreviewLink[];
  selected?: readonly TaskId[];
  /** Defaults to `identitySnap()` — the "no snap plugin composed" case. */
  snap?: SnapService;
  lanes?: LaneDragProvider | undefined;
  config?: DragEditConfig;
  messages?: Partial<InteractionMessages>;
  themeTokens?: Record<string, string>;
  mount?: FakeTooltipMount;
  /**
   * Clamps every `scrollTo` target before it lands in the viewport — the auto-scroll suite's stand-in
   * for the renderer's own wall (a scrollable range this module does not own). Defaults to the
   * identity (no wall at all).
   */
  scrollClamp?: (target: number) => number;
}

export interface DragHarness {
  deps: DragEditDeps;
  tasks: Task[];
  moves: Move[];
  progresses: ProgressSet[];
  updates: RowUpdate[];
  /** Every drop-indicator dispatch, `null` for a clear. */
  indicators: DropMark[];
  timeline: FakeTimeline;
  /** The mutable viewport object `deps.viewport()` returns, so a test can move it directly. */
  viewport: DragViewport;
  /** Every `scrollTo` target, in call order. */
  scrolls: number[];
  /** How many times `invalidateOverlay` was called. */
  invalidateCount(): number;
  mount: FakeTooltipMount;
  /** Resolved config, exposed for tests that want to assert on it directly. */
  config: ResolvedDragEdit;
}

/** 40px per day, 28px rows, 20px bars, 4px top offset — the stub-chart geometry, restated. */
function defaultBoxes(tasks: readonly Task[], rowHeight: number): FakeBox[] {
  return tasks.map((t, i) => ({
    id: t.id,
    x: t.start,
    y: i * rowHeight + (rowHeight - 20) / 2,
    width: Math.max(2, t.end - t.start),
    height: 20,
  }));
}

export function dragHarness(options: DragHarnessOptions = {}): DragHarness {
  const rowHeight = options.rowHeight ?? 28;
  const tasks: Task[] = options.tasks ?? [
    { id: "t0", parentId: null, name: "t0", start: 0, end: MS_DAY },
    { id: "t1", parentId: null, name: "t1", start: 0, end: MS_DAY },
    { id: "t2", parentId: null, name: "t2", start: 0, end: MS_DAY },
  ];
  const boxes = options.boxes ?? defaultBoxes(tasks, rowHeight);
  const rowOrder = options.rowOrder ?? tasks.map((t) => t.id);
  const backingStore = store(tasks);
  const barGeometry = bars(boxes);
  const rowGeometry = rowsOf({ order: rowOrder, rowHeight } as FakeRowsOptions);
  const timeline = timelineOf(options.pxPerMs ?? 1);
  const viewport: DragViewport = viewportOf(options.viewport);

  const moves: Move[] = [];
  const progresses: ProgressSet[] = [];
  const updates: RowUpdate[] = [];
  const indicators: DropMark[] = [];
  const scrolls: number[] = [];
  let invalidations = 0;

  const links: PreviewLink[] = [...(options.links ?? [])];
  const selected = new Set<TaskId>(options.selected ?? []);
  const themeTokens = options.themeTokens ?? {};
  const mount = options.mount ?? fakeTooltipMount();

  const config =
    options.config === undefined
      ? resolveConfig(undefined).dragEdit
      : resolveConfig({ dragEdit: options.config }).dragEdit;
  const messages = resolveMessages(options.messages, () => {});

  const deps: DragEditDeps = {
    config,
    messages,
    root: mount.root,
    bars: barGeometry,
    rows: rowGeometry,
    timeline,
    viewport: () => viewport,
    chartPane: () => mount.chartPane,
    invalidateOverlay: () => {
      invalidations += 1;
    },
    scrollTo: (scrollLeft) => {
      const applied = options.scrollClamp === undefined ? scrollLeft : options.scrollClamp(scrollLeft);
      viewport.scrollLeft = applied;
      scrolls.push(applied);
    },
    getTask: (id) => backingStore.getTask(id),
    childrenOf: (parent) => backingStore.childrenOf(parent),
    links: () => links,
    selected: () => selected,
    snap: options.snap ?? identitySnap(),
    lanes: () => options.lanes,
    themeColor: (token) => themeTokens[token] ?? "",
    moveTask: (payload) => {
      const entry: Move = { id: payload.id, start: payload.start, end: payload.end };
      if (payload.coalesceKey !== undefined) entry.coalesceKey = payload.coalesceKey;
      moves.push(entry);
      const task = backingStore.getTask(payload.id);
      if (task !== undefined) {
        task.start = payload.start;
        task.end = payload.end;
      }
    },
    setProgress: (payload) => {
      const entry: ProgressSet = { id: payload.id, progress: payload.progress };
      if (payload.coalesceKey !== undefined) entry.coalesceKey = payload.coalesceKey;
      progresses.push(entry);
      const task = backingStore.getTask(payload.id);
      if (task !== undefined) task.progress = payload.progress;
    },
    updateTask: (payload) => {
      updates.push({ id: payload.id, parentId: payload.after.parentId, orderKey: payload.after.orderKey });
      const task = backingStore.getTask(payload.id);
      if (task !== undefined) {
        task.parentId = payload.after.parentId;
        (task as Task & { orderKey?: string }).orderKey = payload.after.orderKey;
      }
    },
    showDropIndicator: (mark) => {
      indicators.push(mark);
    },
  };

  return {
    deps,
    tasks,
    moves,
    progresses,
    updates,
    indicators,
    timeline,
    viewport,
    scrolls,
    invalidateCount: () => invalidations,
    mount,
    config,
  };
}
