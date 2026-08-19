/**
 * The grid's left pane — the wiring that assembles the grid out of its internal modules.
 *
 * A DOM-based, row-virtualized table: only the rows intersecting the pane viewport are
 * materialized, positioned from the row model's O(log n) geometry. Every listener, element and
 * frame callback is handed to `ctx.own()`, so the core owns their disposal.
 *
 * Nothing is implemented here. The column track, the header (sort + resize), the body
 * (virtualization), the scroll state, the pane-height watcher, the inline-edit session and the
 * CSS-token cache each live in their own module beside this one; this file creates them, connects
 * them and registers the listeners and the pane's public surface.
 *
 * The pane element itself is not created here either: this plugin contributes to `view/panes` and
 * renders into the element the view plugin hands to `mount()`. The divider and its drag-resize are
 * owned by the view plugin.
 */
// docs/specs/plugins/tree-grid.md § Extension points (the `view/panes` contribution) /
// § Scroll synchronization (the shared vertical viewport)
import type { PluginContext } from "@stargantt/core";
import type { TaskId } from "@stargantt/plugin-data-store";
import type { ThemeService, ViewService } from "@stargantt/plugin-view";
import { listen } from "@stargantt/sdk";
import type { ColumnDef, GridSortState } from "../types";
import { createColumnTrack } from "./column-track";
import { el } from "./dom";
import { locateCellIndex, locateRow } from "./dom-walk";
import { createEditSession } from "./edit-session";
import { frameThrottle } from "./frame-throttle";
import { createGridBody } from "./grid-body";
import type { GridBodyDeps } from "./grid-body";
import { createGridHeader } from "./grid-header";
import { createGridScroll, mirrorScrollLeft } from "./grid-scroll";
import { watchPaneHeight } from "./height-watch";
import { updateOverflowCue } from "./overflow-cue";
import type { RowModel } from "./row-model";
import { createGridTokenCache } from "./tokens";

// docs/specs/plugins/tree-grid.md § Config
/**
 * The grid's default pane width, passed to `view/panes` as `initialWidth`. It is the default of
 * `TreeGridConfig.paneWidth`, and is wide enough for the default column track (24 px gutter + 220
 * + 110 + 110 + 90 = 554 px) plus slack, so all four built-in columns are visible at rest.
 */
export const GRID_PANE_WIDTH = 580;
/**
 * Per tree level, for the width of the tree column's variable indent gutter. It is the default of
 * `TreeGridConfig.indent`.
 */
export const INDENT_PX = 16;

export interface GridPaneOptions {
  /** Current `grid/columns` reduction. */
  columns(): ColumnDef[];
  /**
   * Reports a fault raised by a contributed callback. Function-shaped contributions are invoked by
   * the plugin that owns the extension point, so that plugin guards each call and routes the error
   * here rather than letting it escape.
   */
  fault(error: unknown): void;
  /** The shared vertical viewport, the wheel-speed multiplier and layer invalidation. */
  view: ViewService;
  /** The theme, whose token store the grid's own CSS-token cache follows. */
  theme: ThemeService;
  /** Publishes the visible row set — a header sort reordered it. */
  onRowsChanged(): void;
  /** Publishes the active sort, or `null` when the cycle came to rest unsorted. */
  onSortChanged(sort: GridSortState | null): void;
  /** Publishes the laid-out width of every displayed column. */
  onColumnWidths(widths: ReadonlyMap<string, number>): void;
  // docs/specs/plugins/tree-grid.md § Config — `TreeGridConfig.indent`, already validated by the
  // caller. Omitted here means the built-in default.
  /** Per-level width of the tree column's indent gutter, CSS px. Omitted = `INDENT_PX`. */
  indent?: number;
  // docs/specs/plugins/tree-grid.md § Config — already validated by the caller.
  /** Whether every column behaves as `editable: false`, whatever its `setValue`. */
  readOnly?: boolean;
  // docs/specs/plugins/tree-grid.md § Config — already fault-guarded (latched) by the plugin entry.
  /** Extra class tokens for a row's element, re-evaluated each time the row paints. */
  rowClass?: GridBodyDeps["rowClass"] | undefined;
  /** Badge text appended to a row's tree-column cell, or `undefined` for no badge. */
  rowBadge?: GridBodyDeps["rowBadge"] | undefined;
  /**
   * When present, `Tab` / `Shift+Tab` on the pane (or a row inside it) indent / outdent the active
   * row's task through this callback. Absent = the keys are left to the browser, the default.
   */
  outline?: ((id: TaskId, direction: "indent" | "outdent") => void) | undefined;
}

export interface GridPane {
  /** Queues a repaint on the next frame. */
  schedule(): void;
  /** The `view/panes` mount target: renders the grid into the pane element the view plugin created. */
  mount(el: HTMLElement): void;
  /**
   * Starts inline editing of a cell of the given row index. `columnId` names which column; omitted
   * targets the first editable column in composed column order. A no-op when the row is not
   * currently materialized in the pane viewport, when `columnId` matches no column or a
   * non-editable one, or when no editable column exists at all.
   */
  editStart(row: number, columnId?: string): void;
  /** Marks the given tasks' rows `.sg-grid-row--selected`. */
  setSelected(ids: ReadonlySet<TaskId>): void;
  /**
   * Marks the given task's row `.sg-grid-row--focused` and scrolls it into the pane viewport;
   * `undefined` clears the mark.
   */
  setFocused(id: TaskId | undefined): void;
  /**
   * Refreshes the horizontal-overflow cue: the `view/panes` contribution's `onResize` routes here,
   * since a pane-divider drag (or a view-mode switch) changes the body's visible width without any
   * of the grid's own repaint triggers firing.
   */
  onPaneResize(): void;
  /**
   * Draws the drop-indicator line at a viewport-local `y`, inset by `depth` indent steps, or hides
   * it for `null` (and for an unusable `y` / `depth`). Display state only: nothing is written, and
   * the line belongs to whichever plugin is dragging.
   */
  showDropIndicator(at: { y: number; depth: number } | null): void;
}

export function mountGridPane(
  ctx: PluginContext,
  model: RowModel,
  options: GridPaneOptions,
): GridPane {
  const doc = ctx.root.ownerDocument;
  const indent = options.indent ?? INDENT_PX;
  const readOnly = options.readOnly ?? false;

  /** The pane element received from the view plugin; `null` until `mount()` runs. */
  let pane: HTMLElement | null = null;
  /**
   * The F2 path needs a "current row" and this plugin cannot depend on the plugin that owns the
   * roving tabindex. The pane is therefore focusable itself and remembers the row last pointed at.
   */
  let activeRow: number | null = null;

  /* --- the modules ---------------------------------------------------- */
  const tokens = createGridTokenCache(ctx.root);
  const track = createColumnTrack(() => options.columns());

  const repaint = frameThrottle(ctx, () => render());
  /** Heavy work is scheduled onto a frame, never done inside a change handler. */
  function schedule(): void {
    repaint.schedule();
  }

  // docs/specs/plugins/tree-grid.md § Services — the `columnWidths` store snapshot, republished
  // wherever a width actually changes. The horizontal-overflow cue is re-derived from the same
  // point, since a width change resizes cells directly, outside the repaint path.
  function publishWidths(): void {
    options.onColumnWidths(track.widths());
    updateOverflowCue(body.element);
  }

  // A resize drag applies widths to the DOM every move (the gesture stays frame-tight) but
  // republishes the snapshot at most once per animation frame: subscribers recompute geometry per
  // publication, and `pointermove` can fire several times per frame.
  const announceWidths = frameThrottle(ctx, () => publishWidths());

  const edit = createEditSession({
    doc,
    track,
    model,
    readOnly,
    cellsOf: (row) => body.cellsOf(row),
    update: (id, after) => ctx.dispatch("task/update", { id, after }),
    fault: options.fault,
    // When the closing editor still holds the DOM focus, it returns to the grid pane so every
    // root-scoped binding (arrows, chords, undo) keeps working. A blur-commit caused by the user
    // focusing something else leaves that new focus alone.
    restoreFocus: (host) => {
      const active = doc.activeElement;
      if (active == null || typeof host.contains !== "function" || !host.contains(active)) return;
      if (pane !== null && typeof pane.focus === "function") pane.focus();
    },
    schedule,
  });

  const body = createGridBody({
    doc,
    track,
    tokens,
    model,
    indent,
    retainsEditor: (id, cell) => edit.retains(id, cell),
    fault: options.fault,
    rowClass: options.rowClass,
    rowBadge: options.rowBadge,
  });

  const header = createGridHeader({
    doc,
    track,
    tokens,
    applyBodyWidth: (index, width) => body.applyColumnWidth(index, width),
    setSortComparator: (compare) => model.setSortComparator(compare),
    fault: options.fault,
    schedule,
    onRowsChanged: () => options.onRowsChanged(),
    onSortChanged: (sort) => options.onSortChanged(sort),
    /**
     * A committed width change is published at once; any drag-coalesced publication still pending
     * is dropped, since this one already carries its information.
     */
    onWidthsChanged: () => {
      announceWidths.cancel();
      publishWidths();
    },
    onWidthsChangedThrottled: () => announceWidths.schedule(),
  });

  // docs/specs/plugins/tree-grid.md § Scroll synchronization — the wheel path asks the view plugin
  // to move the shared vertical viewport and follows it back in; both panes scroll at one speed.
  const scroll = createGridScroll({
    model,
    viewportHeight: () => body.viewportHeight(),
    schedule,
    requestScrollTop: (scrollTop) => options.view.scrollTo({ scrollTop }),
    wheelSpeedFactor: () => options.view.wheelSpeedFactor(),
  });

  // A bottom-pane divider drag (or a vertical host resize) changes the pane's height with no
  // scroll and no data change; the watcher repaints through the same frame-coalesced `schedule()`
  // every other trigger uses, and the repaint pass's own `scroll.clamp()` re-clamps a `scrollTop`
  // a grown pane has pushed past the new maximum. Its `ResizeObserver` (or fallback listener) is
  // owned once, inside the watcher.
  const heightWatch = watchPaneHeight(ctx, schedule);

  /* --- the repaint pass ----------------------------------------------- */
  /**
   * One repaint: adopt any new column composition, then paint the rows intersecting the viewport.
   * The edit session brackets the pass so an open editor whose cell this pass no longer paints is
   * evicted rather than silently detached.
   */
  function render(): void {
    if (pane === null) return;
    let rebuilt = false;
    if (track.refresh()) {
      header.rebuild();
      // A slot's cell count is fixed by the column count, so the pool is rebuilt from scratch.
      body.resetSlots();
      rebuilt = true;
    }
    edit.beginPaintPass();
    scroll.clamp();
    body.paint(scroll.top());
    edit.endPaintPass();
    // A fresh header layout is the first moment a width-less column has a measurable width, so the
    // snapshot is republished here — and only here inside the repaint path. The overflow cue is
    // deliberately NOT recomputed on every repaint: `render()` runs on every plain vertical scroll
    // and data change, neither of which can move the body's horizontal geometry, and the cue's read
    // of `scrollWidth` / `clientWidth` forces a synchronous relayout. It is refreshed only at the
    // points that can actually change that geometry (scroll, a column-width change, a pane resize,
    // a gutter-width theme change) plus once for the first paint.
    if (rebuilt) options.onColumnWidths(track.widths());
  }

  /* --- row pointer gestures + drop indicator ---------------------------- */

  /** The pointer whose grid-row press is being tracked, or `null` while none is. */
  let trackedPointer: number | null = null;

  /** A number as the payload carries it: anything unusable (a synthetic event's gap) reads as 0. */
  function num(value: number | undefined): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }

  /** A pointer event's position relative to the grid body's top-left corner. */
  function bodyLocal(e: { clientX: number; clientY: number }): { x: number; y: number } {
    // A detached (never laid out) body measures as a zero box, which leaves the raw client
    // position — the same fallback the context-menu path uses for its pane box.
    const box =
      typeof body.element.getBoundingClientRect === "function"
        ? body.element.getBoundingClientRect()
        : undefined;
    return box === undefined
      ? { x: num(e.clientX), y: num(e.clientY) }
      : { x: num(e.clientX) - num(box.left), y: num(e.clientY) - num(box.top) };
  }

  /** The drop-indicator line, created on the first drop that needs one and reused after. */
  let dropIndicator: HTMLElement | null = null;

  function showDropIndicator(at: { y: number; depth: number } | null): void {
    if (at === null || !Number.isFinite(at.y) || !Number.isFinite(at.depth)) {
      if (dropIndicator !== null) dropIndicator.style.display = "none";
      return;
    }
    if (dropIndicator === null) {
      dropIndicator = el(doc, "div", "sg-grid-drop-indicator");
      body.element.appendChild(dropIndicator);
    }
    // The indent step is the grid's own, so the line lands exactly where a row of that depth does.
    dropIndicator.style.left = `${Math.max(0, at.depth) * indent}px`;
    dropIndicator.style.top = `${at.y}px`;
    dropIndicator.style.display = "";
  }

  /* --- inline edit entry (F2 / double-click) ---------------------------- */
  /** Opens an inline edit and, when one opened, remembers its row as the F2 fallback target. */
  function beginEdit(row: number, columnId?: string): void {
    if (edit.open(row, columnId)) activeRow = row;
  }

  listen(ctx, edit.input, "keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter") edit.sharedDone()?.commit(edit.input.value);
    else if (e.key === "Escape") edit.sharedDone()?.cancel();
  });
  listen(ctx, edit.input, "blur", () => edit.sharedDone()?.commit(edit.input.value));

  /* --- theme ------------------------------------------------------------ */
  // A runtime theme change can restyle the gutter and the cell padding, so the token cache is
  // dropped, the header's gutter (sized outside the repaint path) re-applied, and the rows
  // repainted with the new geometry. The gutter width (`--sg-treegrid-toggle-width`) is part of the
  // body's total content width and is not itself depth-compensated the way a row's indent is, so a
  // theme swap that changes it is a real horizontal-geometry change, not just a repaint.
  ctx.own(
    options.theme.tokens.subscribe(() => {
      tokens.invalidate();
      header.applyGutterWidth();
      schedule();
      updateOverflowCue(body.element);
    }),
  );

  // docs/specs/plugins/tree-grid.md § Scroll synchronization — the grid follows chart-side scrolls
  // (and its own, round-tripped) by subscribing to the view plugin's viewport store. The value the
  // grid just requested comes back with the offset already stored in the scroll module, where the
  // equality guard stops the round trip.
  ctx.own(
    options.view.viewport.subscribe((next) => {
      scroll.onViewportScrollTop(next.scrollTop);
    }),
  );

  /**
   * The `view/panes` mount target. The view plugin calls it exactly once, on `lifecycle/ready`,
   * with the pane element it created; the grid adopts the element as its keyboard/wheel target,
   * keeps the `.sg-pane--grid` class on it for CSS compatibility, and paints the first frame.
   */
  function mount(target: HTMLElement): void {
    pane = target;
    target.classList.add("sg-pane--grid");
    // Makes the pane a keyboard event target at all, so the F2 binding below is reachable.
    target.setAttribute("tabindex", "0");
    target.appendChild(header.element);
    target.appendChild(body.element);

    // The watched element is the pane the grid was mounted into — the element whose height a
    // bottom-pane resize changes directly.
    heightWatch.watch(target);

    /* --- header: sort click + resize drag ------------------------------ */
    listen(ctx, header.element, "click", (e: MouseEvent) => header.onClick(e));
    listen(ctx, header.element, "keydown", (e: KeyboardEvent) => header.onKeyDown(e));
    listen(ctx, header.element, "pointerdown", (e: PointerEvent) => header.onPointerDown(e));
    listen(ctx, doc, "pointermove", (e: PointerEvent) => header.onPointerMove(e));
    // The pointer may leave the document (released over an iframe, drag cancelled by the UA):
    // both end events release the drag so the resize never sticks to the pointer.
    listen(ctx, doc, "pointerup", () => header.onPointerEnd());
    listen(ctx, doc, "pointercancel", () => header.onPointerEnd());

    /* --- pointer / keyboard on the pane -------------------------------- */
    listen(ctx, body.element, "click", (e: MouseEvent) => {
      const hit = locateRow(e.target);
      if (hit === undefined) return;
      activeRow = hit.row;
      if (!hit.toggle) return;
      const id = model.taskIdAt(hit.row);
      if (id === undefined) return;
      ctx.dispatch("view/rowToggle", { id });
    });

    // docs/specs/plugins/tree-grid.md § Events — a pointerdown anywhere on a row (any cell, or the
    // row's own padding) publishes the flat selection-surface payload; the toggle is the one
    // exception (it dispatches `view/rowToggle` instead, on `click` above). The grid takes no
    // selection action of its own — this is information only, emitted for every button so a
    // subscriber that cares filters on `button`.
    listen(ctx, body.element, "pointerdown", (e: PointerEvent) => {
      // The second exception alongside the expand toggle: an open inline editor is a self-contained
      // widget, and a press inside it (caret placement, text selection, the native calendar-picker
      // press) is editor interaction, not a row gesture. Emitting here would let a subscriber steal
      // DOM focus and blur the editor mid-edit. The click that *opens* an editor still emits, since
      // no editor is mounted yet when it fires.
      if (edit.within(e.target)) return;
      const hit = locateRow(e.target);
      if (hit === undefined || hit.toggle) return;
      const id = model.taskIdAt(hit.row);
      if (id === undefined) return;
      const at = bodyLocal(e);
      ctx.emit("grid/rowPointerDown", {
        id,
        row: hit.row,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
        button: e.button,
        pointerId: num(e.pointerId),
        x: at.x,
        y: at.y,
        clientX: num(e.clientX),
        clientY: num(e.clientY),
      });
      // The press is followed through to its end. The tracking is document-level, exactly as the
      // header's resize drag does it, and deliberately *not* `setPointerCapture`: capturing on the
      // body retargets the whole press there, so the `click` a cell's own button (or the inline
      // editor's calendar icon) needs would be dispatched at the body instead and every in-cell
      // control would go dead.
      trackedPointer = e.pointerId;
    });

    // The two halves of the tracked press. They carry no row index — a row drag resolves its own
    // target from `y` — and the grid itself acts on neither. Document-level, so a pointer that
    // leaves the pane mid-drag keeps reporting.
    listen(ctx, doc, "pointermove", (e: PointerEvent) => {
      if (trackedPointer !== e.pointerId) return;
      const at = bodyLocal(e);
      ctx.emit("grid/rowPointerMove", {
        pointerId: num(e.pointerId),
        x: at.x,
        y: at.y,
        clientX: num(e.clientX),
        clientY: num(e.clientY),
        altKey: e.altKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
      });
    });

    const endPress = (e: PointerEvent, cancelled: boolean): void => {
      if (trackedPointer !== e.pointerId) return;
      trackedPointer = null;
      const at = bodyLocal(e);
      ctx.emit("grid/rowPointerUp", {
        pointerId: num(e.pointerId),
        x: at.x,
        y: at.y,
        clientX: num(e.clientX),
        clientY: num(e.clientY),
        cancelled,
      });
    };
    listen(ctx, doc, "pointerup", (e: PointerEvent) => endPress(e, false));
    listen(ctx, doc, "pointercancel", (e: PointerEvent) => endPress(e, true));

    // docs/specs/plugins/tree-grid.md § Events — the grid's context-menu surface. Published on
    // `contextmenu` rather than on the right `pointerdown` so that a menu opened in response is not
    // closed again by the document-level outside-press handling that every menu needs; that press
    // has already been dispatched by the time this fires. The grid itself opens nothing and
    // suppresses nothing.
    listen(ctx, body.element, "contextmenu", (e: MouseEvent) => {
      // A context-menu request inside the mounted inline-editor host belongs to the editor too:
      // opening the row menu here would move focus and blur (and so cancel) the edit the same way
      // an unguarded pointerdown or dblclick did. The grid emits nothing and calls no
      // `preventDefault`, so the browser's own input context menu survives untouched.
      if (edit.within(e.target)) return;
      // Pane-local coordinates: the pane is a positioned box (`.sg-pane` is `position: relative`),
      // so this is the space a menu mounted inside it is placed in. Shared by both the row and the
      // blank-area branches below.
      const box =
        typeof target.getBoundingClientRect === "function"
          ? target.getBoundingClientRect()
          : undefined;
      const x = box === undefined ? e.clientX : e.clientX - box.left;
      const y = box === undefined ? e.clientY : e.clientY - box.top;

      const hit = locateRow(e.target);
      if (hit === undefined) {
        // The press is inside the body element but resolves no row — the blank area below the last
        // row. The header path is a separate, unlistened element and stays native.
        ctx.emit("grid/backgroundContextMenu", { x, y });
        return;
      }
      if (hit.toggle) return;
      const id = model.taskIdAt(hit.row);
      if (id === undefined) return;
      ctx.emit("grid/rowContextMenu", { id, row: hit.row, x, y });
    });

    listen(ctx, body.element, "dblclick", (e: MouseEvent) => {
      // A text-selecting double-click inside the already-open editor must not restart the session:
      // `beginEdit` below would close and reopen it, discarding a custom editor's in-progress state
      // for a press that was never a row gesture.
      if (edit.within(e.target)) return;
      const hit = locateRow(e.target);
      if (hit === undefined || hit.toggle) return;
      const cells = body.cellsOf(hit.row);
      const colIndex = cells === undefined ? undefined : locateCellIndex(e.target, cells);
      const columnId = colIndex === undefined ? undefined : track.list()[colIndex]?.id;
      beginEdit(hit.row, columnId);
    });

    // docs/specs/plugins/tree-grid.md § Config — registered only when the config opted in, so the
    // default grid leaves Tab to the browser's focus order. The target guard keeps the binding off
    // an open inline editor (whose keystrokes bubble up here).
    const outline = options.outline;
    if (outline !== undefined) {
      // The named keyboard exit from the Tab-capturing composite widget: `Escape` parks the focus
      // on the pane container and releases `Tab` back to the browser for exactly that one step out,
      // so the pane is never a keyboard trap. The release ends as soon as the focus leaves the pane
      // or lands back on a row, after which `Tab` indents again.
      let tabReleased = false;
      listen(ctx, target, "keydown", (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          // An open inline editor owns its own Escape (cancel); the exit applies outside one only.
          if (edit.within(e.target)) return;
          tabReleased = true;
          if (typeof target.focus === "function") target.focus();
          return;
        }
        if (e.key !== "Tab") return;
        if (tabReleased) return;
        // Tab is captured on the pane and its rows only, never inside an open inline editor: there
        // it keeps its native focus behaviour instead of re-parenting the task mid-edit.
        if (edit.within(e.target)) return;
        const hit = locateRow(e.target);
        if (hit === undefined && e.target !== target) return;
        const row = hit?.row ?? activeRow;
        if (row === null) return;
        const id = model.taskIdAt(row);
        if (id === undefined) return;
        e.preventDefault();
        outline(id, e.shiftKey ? "outdent" : "indent");
      });

      // The release covers exactly the step out of the pane: any focus landing on a row again, and
      // any focus moving out of the pane altogether, re-arms the Tab capture.
      listen(ctx, target, "focusin", (e: Event) => {
        if (locateRow((e as { target?: unknown }).target) !== undefined) tabReleased = false;
      });
      listen(ctx, target, "focusout", (e: Event) => {
        const related = (e as { relatedTarget?: unknown }).relatedTarget;
        if (related != null && typeof target.contains === "function") {
          if (target.contains(related as Node)) return;
        }
        tabReleased = false;
      });
    }

    listen(ctx, target, "keydown", (e: KeyboardEvent) => {
      if (e.key !== "F2") return;
      // The event target is the pane itself unless something inside it holds focus, so the
      // tracked active row is the fallback; `locateRow` still wins when a row *is* the target.
      const row = locateRow(e.target)?.row ?? activeRow;
      if (row === null) return;
      beginEdit(row);
    });

    /**
     * There is no native `scrollHeight`: wheel input drives the shared vertical viewport through
     * the view plugin, and the grid repaints from the value that comes back.
     *
     * Only the *vertical* component is consumed. A horizontal-dominant gesture (a trackpad pan,
     * `Shift`+wheel, or a mouse with a horizontal wheel) is left alone — no `preventDefault` — so
     * it falls through to `.sg-grid-body`'s native `overflow-x: auto` scroll container instead of
     * being silently discarded.
     */
    listen(ctx, target, "wheel", (e: WheelEvent) => scroll.onWheel(e));

    // The header scrolls in lockstep with the body's native horizontal scroll, and back: the
    // browser scrolls the `overflow: hidden` header on its own when an off-pane header cell
    // receives keyboard focus. This offset is private to the grid — it is never published through
    // the viewport store, whose vertical offset is the only shared one.
    const mirrorBodyScroll = mirrorScrollLeft(body.element, header.element);
    const mirrorHeaderScroll = mirrorScrollLeft(header.element, body.element);
    // The cue is re-derived from the same scroll that drives the header/body lockstep, in both
    // directions, so it stays in sync with whichever side the user (or a scroll-into-view) moved.
    listen(ctx, body.element, "scroll", () => {
      mirrorBodyScroll();
      updateOverflowCue(body.element);
    });
    listen(ctx, header.element, "scroll", () => {
      mirrorHeaderScroll();
      updateOverflowCue(body.element);
    });

    // First paint: mount happens on `lifecycle/ready`, so paint directly.
    render();
    // The one point that needs the cue but has no dedicated trigger of its own: the columns are
    // laid out with their initial widths by the `render()` call just above, so this establishes the
    // starting `data-overflow` state once, at mount, without paying that cost on every later
    // repaint. The width snapshot is republished with them, now that the header has been laid out.
    publishWidths();
  }

  return {
    schedule,
    mount,
    editStart: beginEdit,
    // The write side of the selection reflection, wired through by the plugin entry. No repaint is
    // scheduled — the body re-marks the materialized rows in place, which is what keeps a press on
    // an interactive child of a contributed cell alive across the selection change its own
    // `pointerdown` produced.
    setSelected: (ids) => body.setSelected(ids),
    // The focus write side. The focus owner pushes each effective placement here rather than the
    // grid subscribing to a focus store, so the two packages keep a single dependency edge and no
    // cycle. Like the selection, the mark is applied in place and schedules nothing; the
    // scroll-into-view repaints through the ordinary scroll path, and only when it actually moves
    // the pane.
    setFocused: (id) => {
      body.setFocused(id);
      if (id !== undefined) scroll.scrollRowIntoView(id);
    },
    onPaneResize: () => updateOverflowCue(body.element),
    showDropIndicator,
  };
}
