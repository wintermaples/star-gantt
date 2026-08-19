/**
 * The narrow reads `stargantt.task-bars`' internal modules make of the services this plugin
 * depends on.
 *
 * The data-store and view reads are `Pick`s of those siblings' real service interfaces rather than
 * restated signatures, so a contract change there is a compile error here instead of silent drift,
 * and each internal module still states exactly which members it touches.
 *
 * **The row-model reads are the exception.** `RowsReader` below is a *structural* declaration that
 * is **kept in manual sync with tree-grid's `RowsService`** — it may not be imported:
 * tree-grid depends on this package's types (it contributes to the `taskbars/*` points), so a type
 * import in this direction closes a package-level cycle that leaves pnpm unable to order the two
 * builds, and a full-repo `pnpm run build` then fails non-deterministically. The declaration is
 * deliberately minimal — only the members this plugin actually calls — so the surface that has to
 * be kept in step is as small as possible. The service id and the member shapes are public API on
 * tree-grid's side; a change to either is a breaking change there and must be mirrored here.
 *
 * Because the aliases are this narrow, a unit test can satisfy them with an object literal — no
 * host, no plugins, no DOM.
 */
import type { Store } from "@stargantt/core";
import type { DataService, TaskId } from "@stargantt/plugin-data-store";
import type { ThemeService, TimelineService, Viewport } from "@stargantt/plugin-view";

/**
 * The members of tree-grid's `stargantt.rows` service this plugin consumes — a hand-maintained
 * structural mirror (see the module doc above for why it is not imported).
 *
 * Every member below is called somewhere in this package: the six row-geometry queries by the
 * paint pass, the hit test and the geometry service; `resolvedHeightOf` by the split row's child
 * filter (a child of a collapsed summary has no row index, so the by-task resolution is the only
 * channel); `isExpanded` by the collapsed-summary presentations; and the `rows` store by the
 * repaint trigger, which only needs the notification, never the snapshot's contents.
 */
export interface RowsReader {
  rowCount(): number;
  taskIdAt(row: number): TaskId | undefined;
  rowOf(id: TaskId): number | undefined;
  rowHeight(row: number): number;
  /** The per-task `rows/height` resolution; `0` = hidden, `undefined` = unknown task. */
  resolvedHeightOf(id: TaskId): number | undefined;
  /** Row index → content-space y of the row's top edge. */
  yOf(row: number): number;
  /** Content-space y → row index; out-of-range queries clamp to the nearest row. */
  rowAtY(y: number): number;
  isExpanded(id: TaskId): boolean;
  /** The visible row set, set once per change. Only its notification is consumed here. */
  readonly rows: Store<unknown>;
}

/** The row-model reads bar geometry, painting and hit-testing need. */
export type RowReader = Pick<
  RowsReader,
  "rowCount" | "taskIdAt" | "rowOf" | "rowHeight" | "yOf" | "rowAtY"
>;

/**
 * The task-level row-height read the split row's child filter needs. It is deliberately separate
 * from `RowReader`: the children of a collapsed summary have no row index at all, so the answer
 * has to come from the by-task resolution rather than from `rowOf` + `rowHeight`.
 */
export type RowHeightReader = Pick<RowsReader, "resolvedHeightOf">;

/** The single-task data-store read bar geometry needs. */
export type TaskReader = Pick<DataService, "getTask">;

/** The expansion-state read the split-view and collapsed-summary options need. */
export type ExpandReader = Pick<RowsReader, "isExpanded">;

/** The child-index read the split-view option needs. */
export type TaskTreeReader = Pick<DataService, "query">;

/** The whole-store walk the horizontal content extent needs. */
export type TaskStoreReader = Pick<DataService, "getTask" | "taskIds">;

/** The time-scale read every bar box needs. */
export type TimeMapper = Pick<TimelineService, "tToX">;

/** The theme read every painted colour and font goes through. */
export type ThemeReader = Pick<ThemeService, "get">;

/** The viewport offsets that convert content coordinates into the viewport-local space. */
export type ScrollOffsets = Pick<Viewport, "scrollLeft" | "scrollTop">;
