/**
 * The grid body: a row-virtualized pool of DOM rows.
 *
 * Only the rows intersecting the pane viewport are materialized, positioned from the row model's
 * O(log n) geometry, and a slot is reused for whatever row scrolls into its place. Nothing here
 * knows about sorting, resizing gestures or editing — it paints what the track and the model say.
 */
// docs/specs/plugins/tree-grid.md § Extension points — virtualization, tree indentation, and the
// reflected selection and focus marks.
import type { Task, TaskId } from "@stargantt/plugin-data-store";
import type { ColumnDef } from "../types";
import type { ColumnTrack } from "./column-track";
import { el } from "./dom";
import type { RowModel } from "./row-model";
import type { GridTokenCache } from "./tokens";
import { treeColumnIndex, treeInset } from "./tree-column";

/** One reusable row of the virtual pool: the row element, its toggle gutter and its cells. */
interface Slot {
  row: HTMLElement;
  /**
   * The expand/collapse gutter, laid out immediately before the tree column's cell. `undefined`
   * only when no column is displayed at all — then there is no tree column and no gutter.
   */
  toggle: HTMLElement | undefined;
  cells: HTMLElement[];
  /** Class tokens the configured `rowClass` hook last applied to this slot's row element. */
  custom: string[];
  /**
   * The task this slot was last painted for, or `undefined` when the slot is vacant (parked at
   * `display: none`) or shows a row with no task. Remembered here rather than re-derived from the
   * model so an in-place mark update can never disagree with what the slot actually shows.
   */
  taskId: TaskId | undefined;
  /**
   * The row index this slot currently shows, `-1` while vacant. The numeric twin of the
   * `data-row-index` attribute (which stays for DOM addressing), so `slotOf` and the column-resize
   * repaint never parse attribute strings on a lookup path.
   */
  rowIndex: number;
}

export interface GridBodyDeps {
  doc: Document;
  track: ColumnTrack;
  tokens: GridTokenCache;
  model: RowModel;
  // docs/specs/plugins/tree-grid.md § Config — already validated by the plugin entry.
  /** Per-level width of the tree column's indent gutter, CSS px. */
  indent: number;
  /**
   * Whether `cell` currently hosts the open inline editor for `id`. Such a cell is left completely
   * untouched by a repaint: clearing it would detach a focused element, and re-appending would not
   * restore focus. Answering `true` also tells the edit session its cell survived this pass.
   */
  retainsEditor(id: TaskId | undefined, cell: HTMLElement): boolean;
  // docs/specs/plugins/tree-grid.md § Dependencies
  /** Reports a fault raised by a contributed `ColumnDef.render`. */
  fault(error: unknown): void;
  // docs/specs/plugins/tree-grid.md § Config (`rowClass`) — already fault-guarded (latched) by the
  // plugin entry. Omitted = no custom row classes, the default.
  /** Extra class tokens for a row's element, re-evaluated each time the row paints. */
  rowClass?: ((task: Readonly<Task>) => string | undefined) | undefined;
  // docs/specs/plugins/tree-grid.md § Extension points, "Collapsed-branch badge" (`collapsedBadge`).
  // Omitted = no badge, the default.
  /** Badge text appended to a row's tree-column cell, or `undefined` for no badge. */
  rowBadge?: ((row: number, id: TaskId) => string | undefined) | undefined;
}

export interface GridBody {
  /** The `.sg-grid-body` element; also the pane's native horizontal scroll container. */
  readonly element: HTMLElement;
  /** The pane viewport's height in CSS px, or 0 when the body is not laid out. */
  viewportHeight(): number;
  /** Discards the slot pool — a slot's cell count is fixed by the column count. */
  resetSlots(): void;
  /** Repaints the rows intersecting `[scrollTop, scrollTop + viewportHeight)`. */
  paint(scrollTop: number): void;
  /** Applies a new width to every materialized cell of the column at `index`. */
  applyColumnWidth(index: number, width: number): void;
  /** The materialized cells of a row, or `undefined` when that row is not materialized. */
  cellsOf(row: number): readonly HTMLElement[] | undefined;
  /**
   * Replaces the reflected selection: re-marks the already-materialized rows in place and takes
   * effect on the rest as they materialize. Repaints nothing.
   */
  setSelected(ids: ReadonlySet<TaskId>): void;
  /**
   * Replaces the reflected roving focus: re-marks the already-materialized rows in place and takes
   * effect on the rest as they materialize. Repaints nothing.
   */
  setFocused(id: TaskId | undefined): void;
}

export function createGridBody(deps: GridBodyDeps): GridBody {
  const { doc, track, tokens, model, indent } = deps;
  const element = el(doc, "div", "sg-grid-body");
  const slots: Slot[] = [];

  // docs/specs/plugins/tree-grid.md § Extension points — the reflected selection, applied as
  // `.sg-grid-row--selected` on materialize. Display state only, owned by whichever plugin calls
  // `GridService.setSelected`; the grid never writes to it on its own.
  let selectedIds: ReadonlySet<TaskId> = new Set();
  // docs/specs/plugins/tree-grid.md § Extension points — the task under keyboard-a11y's roving
  // focus, pushed in through `GridService.setFocused` and mirrored onto `.sg-grid-row--focused`.
  // `undefined` = nothing focused.
  let focusedId: TaskId | undefined;

  function viewportHeight(): number {
    const h = element.getBoundingClientRect().height;
    return Number.isFinite(h) && h > 0 ? h : 0;
  }

  function slotAt(i: number, treeIndex: number): Slot {
    const existing = slots[i];
    if (existing !== undefined) return existing;
    const row = el(doc, "div", "sg-grid-row");
    // docs/specs/plugins/tree-grid.md § Extension points, "Tree indentation" — the gutter sits
    // immediately before the TREE column, not at the row's leading edge: with `wbs` on, the
    // numbering column is laid out before it and never moves with depth. With `wbs` off the tree
    // column is the first column, so the gutter is the row's first child exactly as before. The
    // tree column is fixed for the life of a slot: a column-composition change rebuilds the whole
    // pool (`resetSlots`).
    let toggle: HTMLElement | undefined;
    const cells: HTMLElement[] = [];
    const columns = track.list();
    for (let index = 0; index < columns.length; index += 1) {
      const column = columns[index];
      if (column === undefined) continue;
      if (index === treeIndex) {
        toggle = el(doc, "div", "sg-grid-toggle");
        row.appendChild(toggle);
      }
      const cell = el(doc, "div", "sg-grid-cell");
      const width = track.widthOf(column);
      if (width !== undefined) cell.style.width = `${width}px`;
      // docs/specs/plugins/tree-grid.md § Extension points, "Column identification in the DOM" —
      // mirrors the header cell's own `data-column-id` (grid-header.ts), so a host's test can
      // address a column by id instead of by position. A slot's cell count is fixed by the column
      // count, and a column-composition change rebuilds the whole pool (`resetSlots`), so this is
      // set once, here, never on repaint.
      cell.setAttribute("data-column-id", column.id);
      row.appendChild(cell);
      cells.push(cell);
    }
    const slot: Slot = { row, toggle, cells, custom: [], taskId: undefined, rowIndex: -1 };
    slots[i] = slot;
    element.appendChild(row);
    return slot;
  }

  function slotOf(row: number): Slot | undefined {
    return slots.find((s) => s.rowIndex === row);
  }

  /**
   * Sizes the tree column's cell for a row at `depth` and reports the inset actually applied.
   *
   * The cell shrinks by exactly the amount the toggle gutter grows, so the row's total width
   * equals the header row's and every column stays under its own header. The inset is capped at
   * whatever still leaves the column its 24 px content box, so a tree deeper than the column
   * affords stops indenting instead of pushing the row past its header.
   */
  function sizeTreeCell(
    treeCell: HTMLElement,
    treeColumn: ColumnDef,
    depth: number,
    cellPadding: number,
  ): number {
    // A column with no declared width is laid out at its content width, which the header cell
    // measures; using it here keeps the compensation — and with it the constant row width — in
    // force for such a column instead of only for a column that declares a width.
    const declared = track.widthOf(treeColumn) ?? track.measuredWidthOf(treeColumn.id);
    const inset = treeInset(depth, indent, declared, cellPadding);
    if (declared !== undefined) {
      treeCell.style.width = `${declared - inset}px`;
      treeCell.style.paddingLeft = "";
    } else {
      // Nothing to shrink yet (the header has not been laid out): inset the content itself
      // instead, leaving the cell's own width auto — reading the header cell's box forces layout,
      // so this is reached only for a detached pane.
      treeCell.style.width = "";
      treeCell.style.paddingLeft = `${cellPadding + inset}px`;
    }
    return inset;
  }

  // docs/specs/plugins/tree-grid.md § Extension points — the two display-state marks.
  /**
   * Derived from the task the slot currently shows. Toggling classes touches no cell and no cell
   * child, so this is safe to run outside a paint pass: a press in progress on a contributed
   * cell's child keeps its target element (the marks change on the very `pointerdown` a selection
   * owner reacts to).
   */
  function applyDisplayState(slot: Slot): void {
    const id = slot.taskId;
    slot.row.classList.toggle("sg-grid-row--selected", id !== undefined && selectedIds.has(id));
    slot.row.classList.toggle("sg-grid-row--focused", id !== undefined && id === focusedId);
  }

  /**
   * Re-marks every materialized row from the current display state, without repainting.
   *
   * A vacant slot (`taskId === undefined`) is skipped: it is parked at `display: none` and takes
   * its marks from `paintRow` when a row next materializes into it.
   */
  function reflectDisplayState(): void {
    for (const slot of slots) {
      if (slot.taskId === undefined) continue;
      applyDisplayState(slot);
    }
  }

  /** The stripe and display-state classes a slot carries for the row it currently shows. */
  function applyStateClasses(slot: Slot, row: number, id: TaskId | undefined): void {
    // docs/specs/plugins/tree-grid.md § Extension points — the alternating row background. Parity
    // is the row's own index, the same index the chart pane's `grid-lines` stripe derives its
    // parity from, so a row is striped in both panes or in neither. Slots are recycled across
    // scroll positions, so this has to be re-toggled on every materialize rather than set once at
    // creation.
    slot.row.classList.toggle("sg-grid-row--odd", row % 2 === 1);
    // Display state only, reflected from `GridService.setSelected` / `setFocused`; the same
    // toggling those calls perform in place on an already-materialized row.
    slot.taskId = id;
    applyDisplayState(slot);
  }

  // docs/specs/plugins/tree-grid.md § Config (`rowClass`).
  /** The previous slot occupant's tokens are removed first, so a reused slot never carries a stale class over. */
  function applyCustomClasses(slot: Slot, task: Readonly<Task> | undefined): void {
    if (slot.custom.length > 0) {
      for (const token of slot.custom) slot.row.classList.remove(token);
      slot.custom = [];
    }
    if (deps.rowClass === undefined || task === undefined) return;
    const cls = deps.rowClass(task);
    if (typeof cls !== "string" || cls === "") return;
    const tokens = cls.split(/\s+/).filter((t) => t !== "");
    for (const token of tokens) slot.row.classList.add(token);
    slot.custom = tokens;
  }

  // docs/specs/plugins/tree-grid.md § Extension points — the toggle gutter geometry.
  /**
   * Widens with depth instead of the whole row shifting right, so every column stays aligned with
   * its header; the tree column's cell shrinks by the same `inset` this gutter grew by.
   */
  function paintToggle(
    slot: Slot,
    row: number,
    id: TaskId | undefined,
    inset: number,
    toggleWidth: number,
  ): void {
    const toggle = slot.toggle;
    if (toggle === undefined) return;
    toggle.style.width = `${toggleWidth + inset}px`;
    if (id !== undefined && model.hasChildrenAt(row)) {
      toggle.style.visibility = "";
      toggle.textContent = model.isExpanded(id) ? "▾" : "▸";
      return;
    }
    // Reserved, not removed: a leaf row keeps the same gutter width as its siblings.
    toggle.style.visibility = "hidden";
    toggle.textContent = "";
  }

  /** Repaints every cell an open editor does not own; reports whether the tree cell was one. */
  function paintCells(
    slot: Slot,
    columns: readonly ColumnDef[],
    id: TaskId | undefined,
    task: Readonly<Task> | undefined,
    treeIndex: number,
  ): boolean {
    let treeCellRepainted = false;
    for (let i = 0; i < slot.cells.length; i += 1) {
      const cell = slot.cells[i];
      const column = columns[i];
      if (cell === undefined || column === undefined) continue;
      // The cell hosting an open editor is left completely untouched (see `retainsEditor`).
      if (deps.retainsEditor(id, cell)) continue;
      if (i === treeIndex) treeCellRepainted = true;
      cell.textContent = "";
      if (task === undefined) continue;
      // § Dependencies: `render` is a contributed callback invoked by this plugin, so this plugin
      // guards it and reports the fault instead of letting one bad column kill the pane.
      try {
        column.render(cell, task);
      } catch (error) {
        deps.fault(error);
      }
    }
    return treeCellRepainted;
  }

  // docs/specs/plugins/tree-grid.md § Extension points, "Collapsed-branch badge".
  /**
   * Appended after the TREE column's own render (never the WBS numbering column's, whose code it
   * would truncate), and only to a cell this pass actually repainted, so an open editor's cell is
   * never touched. The badge is plain text in the row's own color: the information is never
   * conveyed by color alone.
   */
  function appendBadge(
    slot: Slot,
    row: number,
    id: TaskId | undefined,
    task: Readonly<Task> | undefined,
    treeCell: HTMLElement | undefined,
    treeCellRepainted: boolean,
  ): void {
    if (deps.rowBadge === undefined || id === undefined || task === undefined) return;
    if (treeCell === undefined || !treeCellRepainted) return;
    const text = deps.rowBadge(row, id);
    if (text === undefined) return;
    const badge = el(doc, "span", "sg-grid-badge");
    badge.textContent = text;
    treeCell.appendChild(badge);
  }

  function paintRow(
    slot: Slot,
    row: number,
    y: number,
    scrollTop: number,
    columns: readonly ColumnDef[],
    treeIndex: number,
  ): void {
    const id = model.taskIdAt(row);
    const task: Readonly<Task> | undefined = id === undefined ? undefined : model.task(id);
    const depth = model.depthAt(row);

    slot.row.style.display = "";
    slot.row.style.height = `${model.rowHeight(row)}px`;
    slot.row.style.transform = `translateY(${y - scrollTop}px)`;
    slot.row.setAttribute("data-row-index", String(row));
    slot.rowIndex = row;
    applyStateClasses(slot, row, id);
    applyCustomClasses(slot, task);

    // The cached token read: no `getComputedStyle` happens here, so painting a row stays free of
    // forced layout.
    const { toggleWidth, cellPadding } = tokens.get();

    const treeColumn = treeIndex < 0 ? undefined : columns[treeIndex];
    const treeCell = treeIndex < 0 ? undefined : slot.cells[treeIndex];
    const inset =
      treeCell === undefined || treeColumn === undefined
        ? 0
        : sizeTreeCell(treeCell, treeColumn, depth, cellPadding);
    paintToggle(slot, row, id, inset, toggleWidth);

    appendBadge(slot, row, id, task, treeCell, paintCells(slot, columns, id, task, treeIndex));
  }

  return {
    element,
    viewportHeight,
    resetSlots(): void {
      for (const slot of slots) slot.row.remove();
      slots.length = 0;
    },
    paint(scrollTop): void {
      const count = model.rowCount();
      const vh = viewportHeight();
      const bottom = scrollTop + vh;
      // Resolved once per pass, not per row: the tree column is a property of the composition.
      const columns = track.list();
      const treeIndex = treeColumnIndex(columns);
      let used = 0;
      if (count > 0 && vh > 0) {
        // Row virtualization: start at the row containing `scrollTop` (O(log n)) and stop at the
        // first row past the pane's bottom edge — never a walk over the full row set.
        for (let row = model.rowAtY(scrollTop); row < count; row += 1) {
          const y = model.yOf(row);
          if (y >= bottom) break;
          // docs/specs/plugins/tree-grid.md § Extension points — a row the `rows/height` reduction
          // put at 0 is hidden, so it gets no slot at all. Materializing it laid a zero-height flex
          // row over the row below and, since a row does not clip its cells, printed its whole text
          // on top of that row: a filter that hid six rows drew all six of their labels stacked on
          // the one row that survived.
          if (!(model.rowHeight(row) > 0)) continue;
          paintRow(slotAt(used, treeIndex), row, y, scrollTop, columns, treeIndex);
          used += 1;
        }
      }
      for (let i = used; i < slots.length; i += 1) {
        const slot = slots[i];
        if (slot === undefined) continue;
        slot.row.style.display = "none";
        slot.row.setAttribute("data-row-index", "");
        slot.rowIndex = -1;
        slot.taskId = undefined;
      }
    },
    applyColumnWidth(index, width): void {
      const treeIndex = treeColumnIndex(track.list());
      const { toggleWidth, cellPadding } = tokens.get();
      for (const slot of slots) {
        const cell = slot.cells[index];
        if (cell === undefined) continue;
        if (index !== treeIndex) {
          cell.style.width = `${width}px`;
          continue;
        }
        // docs/specs/plugins/tree-grid.md § Extension points — resizing the tree column must
        // reapply this row's indent compensation, or a resize drag/keypress would reintroduce the
        // header/cell misalignment the gutter fix removes. The gutter is rewritten too: a narrower
        // column saturates the inset, and a gutter left at the old width would push the row past
        // its header — the very drift parity forbids.
        const rowIndex = slot.rowIndex;
        const depth = rowIndex >= 0 ? model.depthAt(rowIndex) : 0;
        const inset = treeInset(depth, indent, width, cellPadding);
        cell.style.width = `${width - inset}px`;
        if (slot.toggle !== undefined) slot.toggle.style.width = `${toggleWidth + inset}px`;
      }
    },
    cellsOf: (row) => slotOf(row)?.cells,
    // docs/specs/plugins/tree-grid.md § Extension points — reflecting display state re-renders
    // nothing: the marks move on the materialized rows here and now, and the pool is left
    // otherwise untouched, so no cell content and no contributed cell's children are replaced.
    setSelected(ids): void {
      selectedIds = ids;
      reflectDisplayState();
    },
    setFocused(id): void {
      focusedId = id;
      reflectDisplayState();
    },
  };
}
