/**
 * The grid header: the column-header row, the three-state sort cycle it drives, and the
 * header-boundary column resize — pointer drag and keyboard nudge alike.
 *
 * Every handler is exposed rather than registered here, so the pane stays the single place that
 * wires listeners through `ctx.own()` and every gesture is unit-testable by calling the handler with
 * a plain event object.
 */
// docs/specs/plugins/tree-grid.md § Extension points — boundary resize, the sibling sort cycle, the
// tree column's gutter, columnheader semantics, tab stops, keyboard sort/resize, `aria-sort` and
// `data-sort`, the ≥24 px handle hit box, and the resize floor (24 CSS px of content box).
import type { Task } from "@stargantt/plugin-data-store";
import type { GridSortState } from "../types";
import type { ColumnTrack } from "./column-track";
import { el } from "./dom";
import { isResizeHandle, locateHeaderColumn } from "./dom-walk";
import type { GridTokenCache } from "./tokens";
import { minColumnWidth, treeColumnIndex } from "./tree-column";

// docs/specs/plugins/tree-grid.md § Extension points — the contract leaves the keyboard resize step
// unspecified ("the same width change the drag handle performs"); this mirrors the pane divider's
// 16 CSS px arrow-key step for a consistent keyboard "nudge" size across the library.
const KEYBOARD_RESIZE_STEP_PX = 16;

export interface GridHeaderDeps {
  doc: Document;
  track: ColumnTrack;
  tokens: GridTokenCache;
  /** Applies a committed width to every materialized body cell of the column at `index`. */
  applyBodyWidth(index: number, width: number): void;
  /** Installs (or clears, with `null`) the row model's sibling-scoped sort comparator. */
  setSortComparator(compare: ((a: Readonly<Task>, b: Readonly<Task>) => number) | null): void;
  // docs/specs/plugins/tree-grid.md § Dependencies
  /** Reports a fault raised by a contributed `ColumnDef.compare`. */
  fault(error: unknown): void;
  /** Queues a repaint on the next frame. */
  schedule(): void;
  /** Announces that the visible row order changed — a re-sort reordered it. */
  onRowsChanged(): void;
  /** Publishes the active sort. */
  onSortChanged(sort: GridSortState | null): void;
  /** Publishes a committed, non-coalesced column-width change. */
  onWidthsChanged(): void;
  /** Publishes a drag-step column-width change, coalesced onto the next animation frame. */
  onWidthsChangedThrottled(): void;
}

export interface GridHeader {
  /** The `.sg-grid-header` element. */
  readonly element: HTMLElement;
  /** Rebuilds the header row (gutter + one cell per composed column) and re-applies the sort marks. */
  rebuild(): void;
  /** Re-applies the leading gutter's width after a theme change. */
  applyGutterWidth(): void;
  /** Reflects the active sort onto every header cell's `aria-sort` / `data-sort`. */
  applySort(): void;
  /** Cycles a column's sort: ascending → descending → off. A no-op without `ColumnDef.compare`. */
  cycleSort(columnId: string): void;
  /** Header click: cycles the clicked column's sort, ignoring the resize handle. */
  onClick(e: { target?: unknown }): void;
  /** Header keydown: Enter/Space cycles sort, Alt+ArrowLeft/Right resizes. */
  onKeyDown(e: HeaderKeyEvent): void;
  /** Header pointerdown on a boundary handle: starts a resize drag. */
  onPointerDown(e: HeaderPointerEvent): void;
  /** Document pointermove: advances an in-progress resize drag. */
  onPointerMove(e: { clientX: number }): void;
  /** Document pointerup/pointercancel: releases any in-progress resize drag. */
  onPointerEnd(): void;
}

/** The parts of a `KeyboardEvent` the header reads. */
interface HeaderKeyEvent {
  key: string;
  altKey: boolean;
  target?: unknown;
  preventDefault(): void;
}

/** The parts of a `PointerEvent` the header reads. */
interface HeaderPointerEvent {
  target?: unknown;
  clientX: number;
  pointerId: number;
}

/** Whether an object exposes a callable `setPointerCapture`. */
function capturable(value: unknown): value is { setPointerCapture(id: number): void } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { setPointerCapture?: unknown }).setPointerCapture === "function"
  );
}

export function createGridHeader(deps: GridHeaderDeps): GridHeader {
  const { doc, track, tokens } = deps;
  const element = el(doc, "div", "sg-grid-header");

  /** The header's leading gutter element, kept so a theme change can re-apply its width. */
  let gutter: HTMLElement | null = null;
  // docs/specs/plugins/tree-grid.md § Extension points — header-click sort state. `null` = no active
  // sort ("off"); otherwise the column and direction currently applied.
  let sortState: { columnId: string; direction: "asc" | "desc" } | null = null;
  // docs/specs/plugins/tree-grid.md § Extension points — the in-progress header-boundary drag, if
  // any. `x` / `startWidth` are the pointer position and column width at `pointerdown`.
  let resizeDrag: { columnId: string; x: number; startWidth: number } | null = null;

  function applySort(): void {
    for (const [id, cell] of track.headerCells()) {
      const column = track.find(id);
      if (typeof column?.compare !== "function") {
        cell.removeAttribute("aria-sort");
        cell.removeAttribute("data-sort");
        continue;
      }
      if (sortState !== null && sortState.columnId === id) {
        const direction = sortState.direction === "asc" ? "ascending" : "descending";
        cell.setAttribute("aria-sort", direction);
        // docs/specs/plugins/tree-grid.md § Extension points — the visible twin of `aria-sort`: the
        // bundled stylesheet paints a direction glyph from this attribute.
        cell.setAttribute("data-sort", direction);
      } else {
        cell.setAttribute("aria-sort", "none");
        cell.removeAttribute("data-sort");
      }
    }
  }

  function rebuild(): void {
    element.textContent = "";
    track.clearHeaderCells();
    gutter = null;
    const columns = track.list();
    // docs/specs/plugins/tree-grid.md § Extension points, "Tree indentation" — the gutter sits at
    // the same position in the header as in every row: immediately before the tree column. Anywhere
    // else and the header cells would no longer sit over their own body cells, which is the parity
    // invariant. With no column displayed there is no tree column and no gutter at all.
    const treeIndex = treeColumnIndex(columns);
    for (let index = 0; index < columns.length; index += 1) {
      const column = columns[index];
      if (column === undefined) continue;
      if (index === treeIndex) {
        // Sized inline from the same `--sg-treegrid-toggle-width` token `.sg-grid-toggle` is styled
        // with, because this package does not own the stylesheet; `aria-hidden` keeps the spacer
        // out of the accessibility tree.
        const spacer = el(doc, "div", "sg-grid-header-gutter");
        spacer.style.flex = "0 0 auto";
        spacer.style.width = `${tokens.get().toggleWidth}px`;
        spacer.setAttribute("aria-hidden", "true");
        gutter = spacer;
        element.appendChild(spacer);
      }
      const cell = el(doc, "div", "sg-grid-cell sg-grid-header-cell");
      const width = track.widthOf(column);
      if (width !== undefined) cell.style.width = `${width}px`;
      // Anchors the resize handle below; a functional necessity kept inline rather than in an
      // external stylesheet this package does not own.
      cell.style.position = "relative";
      cell.textContent = column.header;
      cell.setAttribute("data-column-id", column.id);
      // docs/specs/plugins/tree-grid.md § Extension points — every header cell is a `columnheader`
      // and a tab stop, keyboard-operable via `onKeyDown`.
      cell.setAttribute("role", "columnheader");
      cell.setAttribute("tabindex", "0");
      track.setHeaderCell(column.id, cell);

      // docs/specs/plugins/tree-grid.md § Extension points — every header cell's trailing boundary
      // is a drag handle, dragging which resizes the column to its left (this one). Styled inline
      // for the same reason as `position: relative` above.
      // docs/specs/plugins/tree-grid.md § Extension points — the pointer target is a ≥24 px-wide
      // transparent box (WCAG 2.5.8); the painted affordance is the narrow strip the bundled
      // stylesheet draws via `::after`. The cell stretches to the full header height (styles.css),
      // so the target is ≥24 px on both axes.
      const handle = el(doc, "div", "sg-grid-header-resize-handle");
      handle.style.position = "absolute";
      handle.style.top = "0";
      handle.style.right = "0";
      handle.style.bottom = "0";
      handle.style.width = "24px";
      handle.style.cursor = "col-resize";
      cell.appendChild(handle);

      element.appendChild(cell);
    }
    // A rebuild (new column array) must restore the still-active sorted column's `aria-sort`.
    applySort();
  }

  /** Applies `sortState` to the row model and announces the reorder via the repaint path. */
  function applySortComparator(): void {
    if (sortState === null) {
      deps.setSortComparator(null);
    } else {
      const column = track.find(sortState.columnId);
      const compare = column?.compare;
      const direction = sortState.direction;
      if (typeof compare !== "function") {
        deps.setSortComparator(null);
      } else {
        deps.setSortComparator((a, b) => {
          // § Dependencies: `compare` is a contributed callback, guarded like `render`.
          try {
            const r = compare(a, b);
            return direction === "asc" ? r : -r;
          } catch (error) {
            deps.fault(error);
            return 0;
          }
        });
      }
    }
    // docs/specs/plugins/tree-grid.md § Extension points — announced through the existing repaint
    // path; no new event. Display order only: nothing is dispatched, nothing is undoable.
    applySort();
    deps.onRowsChanged();
    deps.schedule();
  }

  function cycleSort(columnId: string): void {
    const column = track.find(columnId);
    if (column === undefined || typeof column.compare !== "function") return;
    if (sortState === null || sortState.columnId !== columnId) {
      sortState = { columnId, direction: "asc" };
    } else if (sortState.direction === "asc") {
      sortState = { columnId, direction: "desc" };
    } else {
      sortState = null;
    }
    applySortComparator();
    // docs/specs/plugins/tree-grid.md § Extension points — each cycle step is published so the
    // a11y layer can announce it ("<column>, sorted ascending" …) through the live region.
    deps.onSortChanged(
      sortState === null
        ? null
        : {
            columnId,
            header: column.header,
            direction: sortState.direction === "asc" ? "ascending" : "descending",
          },
    );
  }

  /**
   * The narrowest a column may be resized to: 24 CSS px of content box, i.e. net of the cell's own
   * horizontal padding. Read off the cached tokens, so a restyled `--sg-treegrid-cell-padding`
   * moves the floor with it and no `getComputedStyle` happens inside a drag.
   */
  function resizeFloor(): number {
    return minColumnWidth(tokens.get().cellPadding);
  }

  /** Live-applies a column's width to its header cell and every materialized body cell. */
  function applyColumnWidth(columnId: string, width: number): void {
    const idx = track.indexOf(columnId);
    if (idx < 0) return;
    const headerCell = track.headerCell(columnId);
    if (headerCell !== undefined) headerCell.style.width = `${width}px`;
    deps.applyBodyWidth(idx, width);
  }

  return {
    element,
    rebuild,
    applyGutterWidth(): void {
      if (gutter !== null) gutter.style.width = `${tokens.get().toggleWidth}px`;
    },
    applySort,
    cycleSort,
    onClick(e): void {
      if (isResizeHandle(e.target)) return;
      const columnId = locateHeaderColumn(e.target);
      if (columnId === undefined) return;
      cycleSort(columnId);
    },
    onKeyDown(e): void {
      const columnId = locateHeaderColumn(e.target);
      if (columnId === undefined) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        cycleSort(columnId);
        return;
      }
      if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        const column = track.find(columnId);
        // The tracked width (a live drag-resize override, else the column's own declared width) so
        // successive presses accumulate off the value this plugin itself just wrote, the same
        // source of truth `applyColumnWidth` reads. With nothing tracked the column is laid out at
        // its content width, so the seed is the header cell's measured width — exactly what the
        // drag handle seeds from — and not the resize floor, which would make the first press jump
        // the column instead of nudging it.
        const tracked = column === undefined ? undefined : track.widthOf(column);
        const current = tracked ?? track.measuredWidthOf(columnId) ?? resizeFloor();
        const step = e.key === "ArrowRight" ? KEYBOARD_RESIZE_STEP_PX : -KEYBOARD_RESIZE_STEP_PX;
        const width = Math.max(resizeFloor(), current + step);
        track.setWidth(columnId, width);
        applyColumnWidth(columnId, width);
        deps.onWidthsChanged();
      }
    },
    onPointerDown(e): void {
      if (!isResizeHandle(e.target)) return;
      const columnId = locateHeaderColumn(e.target);
      if (columnId === undefined) return;
      const headerCell = track.headerCell(columnId);
      const startWidth = headerCell?.getBoundingClientRect().width ?? resizeFloor();
      // Keeps move/up events flowing even when the pointer crosses an iframe or leaves the
      // window mid-drag. Guarded: capture is best-effort only.
      try {
        if (capturable(e.target)) e.target.setPointerCapture(e.pointerId);
      } catch {
        /* pointer already gone — pointercancel below releases the drag */
      }
      resizeDrag = { columnId, x: e.clientX, startWidth };
    },
    onPointerMove(e): void {
      if (resizeDrag === null) return;
      const width = Math.max(resizeFloor(), resizeDrag.startWidth + (e.clientX - resizeDrag.x));
      track.setWidth(resizeDrag.columnId, width);
      applyColumnWidth(resizeDrag.columnId, width);
      // docs/specs/plugins/tree-grid.md § Extension points — the widths are applied to the DOM
      // every move (the gesture stays frame-tight), but the announcement is coalesced to at most
      // one per animation frame: subscribers do geometry work per emission, and pointermove can
      // fire several times per frame. The row set is deliberately not re-announced — no row set
      // changed.
      deps.onWidthsChangedThrottled();
    },
    onPointerEnd(): void {
      resizeDrag = null;
    },
  };
}
