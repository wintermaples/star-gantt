// docs/specs/plugins/interaction.md §1.3 / §6.2 — what the drag feature reads from the rest of the
// composition.
/**
 * One dependency bag for the whole drag feature, declared structurally so every module under
 * `internal/drag/` is exercisable against plain object literals instead of a booted host.
 */
import type { Task, TaskId } from "@stargantt/plugin-data-store";
import type { ResolvedDragEdit } from "../../config";
import type { InteractionMessages } from "../../messages";
import type { LaneDragProvider, SnapService } from "../../types";
import type { PreviewLink } from "./dependency-preview";
import type { RowGeometry } from "./row-list";

/** The bar geometry the drag reads. */
export interface BarReader {
  barBoxOf(id: TaskId): Readonly<{ x: number; y: number; width: number; height: number }> | undefined;
  hasOwnBar(id: TaskId): boolean;
}

/** The pixel↔time mapping and the origin hold the drag reads. */
export interface TimeMapper {
  tToX(t: number): number;
  xToT(x: number): number;
  readonly pxPerMs: number;
  requestOriginExtension(t: number): void;
  releaseOriginExtension(): void;
}

/** The chart viewport, as the drag reads it. */
export interface DragViewport {
  scrollLeft: number;
  scrollTop: number;
  width: number;
  height: number;
}

export interface DragEditDeps {
  config: ResolvedDragEdit;
  messages: InteractionMessages;
  /** The gantt root — the space the lane seam measures against. */
  root: HTMLElement;
  bars: BarReader;
  rows: RowGeometry;
  timeline: TimeMapper;
  viewport(): DragViewport;
  /** The chart pane element the drag tooltip mounts in. */
  chartPane(): HTMLElement;
  invalidateOverlay(): void;
  scrollTo(scrollLeft: number): void;
  getTask(id: TaskId): Readonly<Task> | undefined;
  /** The ids of `parent`'s children (or the roots for `null`), in sibling order. */
  childrenOf(parent: TaskId | null): readonly TaskId[];
  /** Every dependency link — the preview's successor source. */
  links(): Iterable<PreviewLink>;
  /** The current selection, for the multi-task drag's peers. */
  selected(): ReadonlySet<TaskId>;
  /** The chart's rounding rule. */
  snap: SnapService;
  /** The composed `drag/lanes` provider, re-read at gesture time. */
  lanes(): LaneDragProvider | undefined;
  /** One theme token, `""` when unset. */
  themeColor(token: string): string;
  /** Dispatches `task/move`. */
  moveTask(payload: { id: TaskId; start: number; end: number; coalesceKey?: string }): void;
  /** Dispatches `task/setProgress`. */
  setProgress(payload: { id: TaskId; progress: number; coalesceKey?: string }): void;
  /** Dispatches `task/update` — the row drop's one write. */
  updateTask(payload: { id: TaskId; after: { parentId: TaskId | null; orderKey: string } }): void;
  /** Dispatches the grid pane's display-only drop indicator, or clears it with `null`. */
  showDropIndicator(mark: { y: number; depth: number } | null): void;
}
