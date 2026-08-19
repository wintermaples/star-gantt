// docs/specs/plugins/interaction.md
/**
 * `@stargantt/plugin-interaction` — plugin id `stargantt.interaction`.
 *
 * All pointer and keyboard interaction with the chart: selection (single / multi / rubber band /
 * delete confirmation), drag-and-drop editing (bar move / resize / progress / row drag / lane
 * drag), snapping (rounding / alignment / working time / successor push-out), and the tooltip,
 * context menu, zoom toolbar, clipboard, filter, edit dialog and side panel.
 *
 * Ten separate plugins merged into one. What used to be four plugins competing for the same
 * `pointer/*` stream is now a single gesture arbiter (`internal/gesture/arbiter.ts`): click,
 * drag-start and hover interpretation is decided in one place and dispatched to the feature
 * modules.
 *
 * `setup()` below is wiring only — every decision lives in an `internal/` module that can be
 * exercised without booting a host.
 */
import { definePlugin } from "@stargantt/core";
import type { Plugin, PluginContext } from "@stargantt/core";
import { isEditableTarget, listen } from "@stargantt/sdk";
import type { Task, TaskId } from "@stargantt/plugin-data-store";
// Type-only: they load the sibling packages' `declare module "@stargantt/core"` augmentations, so
// every service key, extension point and command below is checked against the real key spaces.
// Erased at emit — no runtime dependency is added.
import type {} from "@stargantt/plugin-view";
import type {} from "@stargantt/plugin-tree-grid";
import type {} from "@stargantt/plugin-task-bars";
import { resolveConfig } from "./config";
import type { InteractionConfig } from "./config";
import { resolveMessages } from "./messages";
import type { InteractionMessages } from "./messages";
import { createArbiter } from "./internal/gesture/arbiter";
import type {
  ArbiterContextMenu,
  ArbiterEditDialog,
  ArbiterTooltip,
} from "./internal/gesture/arbiter";
import { createDragController } from "./internal/drag";
import { EDIT_KEYS, PROGRESS_KEYS, nextProgress, steppedRange } from "./internal/drag/keyboard";
import type { DragMode } from "./internal/drag/gesture";
import { isUsableLaneProvider } from "./internal/drag/lane-drag";
import { createSelectionModule } from "./internal/selection/service";
import {
  RUBBER_BAND_FILL,
  RUBBER_BAND_FILL_TOKEN,
  RUBBER_BAND_STROKE,
  RUBBER_BAND_STROKE_TOKEN,
  SELECTION_STROKE,
  SELECTION_STROKE_TOKEN,
  paintRubberBand,
  paintSelectionFrames,
} from "./internal/selection/paint";
import { createSnapModule } from "./internal/snap/service";
import { isUsableWorkingTimeProvider } from "./internal/snap/working-time";
import { contributeKeyBinding, focusChannel } from "./internal/upward";
import {
  INERT_CONTEXT_MENU,
  INERT_EDIT_DIALOG,
  INERT_TOOLTIP,
} from "./internal/peripheral";
import type { PeripheralWiring } from "./internal/peripheral";
import { wireTooltip } from "./internal/tooltip/wire";
import { wireContextMenu } from "./internal/context-menu/wire";
import { wireZoom } from "./internal/zoom/wire";
import { wireClipboard } from "./internal/clipboard/wire";
import { wireFilter } from "./internal/filter/wire";
import { wireEditDialog } from "./internal/edit-dialog/wire";
import { wireSidePanel } from "./internal/side-panel/wire";

/* ------------------------------------------------------------------ *
 * Public surface
 * ------------------------------------------------------------------ */

export type {
  InteractionConfig,
  SelectionConfig,
  SelectionShortcutsConfig,
  DeleteConfirmRequest,
  DragEditConfig,
  SnapConfig,
  SnapAlignConfig,
  SnapWorkingDaysConfig,
  TooltipConfig,
  ContextMenuConfig,
  ZoomControlsConfig,
  ClipboardConfig,
  FilterSearchConfig,
  EditDialogConfig,
  SidePanelConfig,
} from "./config";
export type {
  AssignmentLineParts,
  DragTooltipParts,
  EditRejectedParts,
  EditedParts,
  InteractionMessages,
  LinkLineParts,
  ProgressEditedParts,
} from "./messages";
export type {
  LaneBox,
  LaneDragProvider,
  PushGuard,
  SelectionService,
  SelectionState,
  SnapRule,
  SnapRuleContext,
  SnapService,
  SnapUnit,
  WorkingBoundaries,
  WorkingTimeProvider,
  // §6.4 / §3 tooltip/content
  TooltipContent,
  TooltipContentProvider,
  // §6.5 / §3 contextmenu/items
  ContextMenuTarget,
  ContextMenuItem,
  ContextMenuItemProvider,
  // §4 clipboard/paste
  ClipboardPasteOptions,
  // §6.9 edit-dialog
  EditDialogField,
  EditDialogDraft,
  EditDialogRenderContext,
  // §6.10 / §3 sidepanel/fields
  SidePanelFieldKey,
  SidePanelFieldContribution,
  SidePanelFieldHandle,
  SidePanelRenderContext,
  // §2.3 filter
  FilterCriteria,
  FilterView,
  FilterFieldDef,
  FilterState,
  FilterService,
} from "./types";

/* ------------------------------------------------------------------ *
 * Plugin
 * ------------------------------------------------------------------ */

const PLUGIN_ID = "stargantt.interaction";

/** The scope every `renderer/layers` order is claimed in. */
const LAYER_SCOPE = "renderer/layers";

/** Identifies the selection frame + rubber-band layer. */
const SELECTION_LAYER_ID = "stargantt.interaction:selection";

/** Just above the bars (60) and in the same canvas band, so the frame surrounds what it frames. */
const SELECTION_LAYER_Z_INDEX = 70;

/** Identifies the drag-preview layer. */
const DRAG_LAYER_ID = "stargantt.interaction:drag-preview";

/** The bottom of the overlay canvas band. */
const DRAG_LAYER_Z_INDEX = 100;

function setup(ctx: PluginContext, rawConfig: InteractionConfig): void {
  const config = resolveConfig(rawConfig);

  /* --- services (all strictly lower layers) ----------------------------- */

  const view = ctx.use("stargantt.view");
  const timeline = ctx.use("stargantt.timeline");
  const theme = ctx.use("stargantt.theme");
  const rows = ctx.use("stargantt.rows");
  const grid = ctx.use("stargantt.grid");
  const bars = ctx.use("stargantt.task-bars");
  const data = ctx.use("stargantt.data");

  const reportError = (error: unknown): void => {
    ctx.emit("core/pluginError", { pluginId: PLUGIN_ID, error });
  };
  const messages: InteractionMessages = resolveMessages(rawConfig.messages, (messageKey, cause) => {
    ctx.emit("core/pluginError", { pluginId: PLUGIN_ID, error: { messageKey, cause } });
  });

  /* --- extension points this plugin owns (§3) --------------------------- */

  // "first" over object-shaped contributions: the first one that structurally offers what the
  // feature needs wins, and one missing a required member is treated as absent.
  const workingTime = ctx.defineExtensionPoint("snap/workingTime", (inputs) =>
    inputs.find(isUsableWorkingTimeProvider),
  );
  const pushGuards = ctx.defineExtensionPoint("snap/pushGuards", (inputs) => [...inputs]);
  const lanes = ctx.defineExtensionPoint("drag/lanes", (inputs) => inputs.find(isUsableLaneProvider));

  /* --- snap (§2.2) ------------------------------------------------------ */

  const snapModule = createSnapModule(config.snap, {
    scaleUnit: () => {
      // The header rows, top to bottom, so the last row is the finest. A row's optional `step` is
      // deliberately not applied: a stepped row fixes no origin for the boundaries it would need.
      const scales = timeline.zoomLevel.get().scales;
      return scales.length === 0 ? undefined : scales[scales.length - 1]?.unit;
    },
    pxPerMs: () => timeline.pxPerMs,
    tasks: () => data.tasks.get().values(),
    view: () => data.query(),
    workingTime: () => workingTime.get(),
    pushGuards: () => pushGuards.get(),
    onFault: reportError,
  });
  ctx.provide("stargantt.snap", snapModule.service);

  // Both gates are also the `snap.enabled: false` gate: the resolution forces every extension off
  // for a disabled nest, so neither the data subscription nor the transaction hook is ever
  // registered and the feature has no side effects left to have.
  if (config.snap.align !== undefined) {
    // The alignment's edge snapshot is rebuilt lazily after every data change, so a consultation is
    // a binary search rather than a per-frame store scan.
    ctx.own(data.tasks.subscribe(() => snapModule.invalidateEdges()));
  }
  if (config.snap.pushSuccessors) {
    // Registered here, ahead of `wireClipboard`'s own `data/willApplyTransaction` handler further
    // down (§4's single-transaction batching, `internal/clipboard/wire.ts`) purely because of this
    // function's own top-to-bottom order — both handlers append to the same `e.transaction.patches`
    // array, so registration order decides which append lands first.
    ctx.on("data/willApplyTransaction", (e) => snapModule.appendPushOut(e.transaction));
  }

  /* --- selection (§2.1) ------------------------------------------------- */

  const selection = createSelectionModule(config.selection, messages, {
    geometry: bars,
    rows,
    setGridSelected: (ids) => grid.setSelected(ids),
    invalidate: () => view.invalidate("main"),
    viewport: () => view.viewport.get(),
    scrollTo: (scrollLeft) => view.scrollTo({ scrollLeft }),
    tToX: (t) => timeline.tToX(t),
    taskDates: (id) => {
      const task = data.getTask(id);
      return task === undefined ? undefined : { start: task.start, end: task.end };
    },
    taskIds: () => data.taskIds(),
    removeTasks: (ids) => ctx.dispatch("task/remove", { ids: [...ids] }),
    root: ctx.root,
    reportError,
  });
  ctx.provide("stargantt.selection", selection.service);
  // One disposable owned once at setup closes "the confirmation dialog, if any"; each open swaps
  // the flow's own state and never registers a new disposable.
  ctx.own({ dispose: () => selection.dispose() });

  ctx.claimOrder(LAYER_SCOPE, SELECTION_LAYER_ID, SELECTION_LAYER_Z_INDEX);
  ctx.contribute("renderer/layers", {
    id: SELECTION_LAYER_ID,
    zIndex: SELECTION_LAYER_Z_INDEX,
    draw(g): void {
      const selected = selection.selected();
      if (selected.size > 0) {
        // One token read per pass; the theme service caches the bulk `getComputedStyle` behind it
        // and returns "" for an unset property, which falls back to the built-in colour.
        paintSelectionFrames(
          g,
          selected,
          bars,
          theme.get(SELECTION_STROKE_TOKEN) || SELECTION_STROKE,
        );
      }
      const band = selection.rubberBandRect();
      if (band !== undefined) {
        paintRubberBand(
          g,
          band,
          theme.get(RUBBER_BAND_FILL_TOKEN) || RUBBER_BAND_FILL,
          theme.get(RUBBER_BAND_STROKE_TOKEN) || RUBBER_BAND_STROKE,
        );
      }
    },
  });

  /* --- drag editing (§6.2) ---------------------------------------------- */

  const drag = createDragController({
    config: config.dragEdit,
    messages,
    root: ctx.root,
    bars,
    rows,
    timeline,
    viewport: () => view.viewport.get(),
    chartPane: () => view.chartPaneElement(),
    invalidateOverlay: () => view.invalidate("overlay"),
    scrollTo: (scrollLeft) => view.scrollTo({ scrollLeft }),
    getTask: (id) => data.getTask(id),
    childrenOf: (parent) => data.query().children.get(parent) ?? [],
    links: () => data.links.get().values(),
    selected: () => selection.selected(),
    snap: snapModule.service,
    lanes: () => lanes.get(),
    themeColor: (token) => theme.get(token),
    moveTask: (payload) => ctx.dispatch("task/move", payload),
    setProgress: (payload) => ctx.dispatch("task/setProgress", payload),
    updateTask: (payload) => ctx.dispatch("task/update", payload),
    showDropIndicator: (mark) => ctx.dispatch("view/dropIndicator", mark),
  });
  ctx.own({ dispose: () => drag.dispose() });

  ctx.claimOrder(LAYER_SCOPE, DRAG_LAYER_ID, DRAG_LAYER_Z_INDEX);
  ctx.contribute("renderer/layers", {
    id: DRAG_LAYER_ID,
    zIndex: DRAG_LAYER_Z_INDEX,
    draw: (g, vp) => drag.draw(g, vp),
  });
  // The right-hand mirror of the origin extension: the scrollable range's right end is the reduced
  // `renderer/contentExtent`, whose only other horizontal contributor measures the *committed*
  // store — so without this a drag heading right would stop dead at whatever the data already
  // reached.
  ctx.contribute("renderer/contentExtent", { id: PLUGIN_ID, measure: () => drag.measure() });

  /* --- the gesture arbiter (§1) ----------------------------------------- */

  // The three features the arbiter dispatches to: inert until their `wire*` entry
  // point installs the real implementation.
  let tooltip: ArbiterTooltip = INERT_TOOLTIP;
  let contextMenu: ArbiterContextMenu = INERT_CONTEXT_MENU;
  let editDialog: ArbiterEditDialog = INERT_EDIT_DIALOG;

  const arbiter = createArbiter({
    selection: {
      mode: () => selection.service.mode(),
      barPress: (press) => selection.barPress(press),
      gridPress: (press) => selection.gridPress(press),
      pointerMove: (e) => selection.pointerMove(e),
      pointerUp: (e) => selection.pointerUp(e),
      clearPending: () => selection.clearPending(),
      rubberBandBegin: (x, y) => selection.rubberBandBegin(x, y),
      rubberBandMove: (x, y) => selection.rubberBandMove(x, y),
      rubberBandEnd: (x, y, release) => selection.rubberBandEnd(x, y, release),
      rubberBandCancel: () => selection.rubberBandCancel(),
    },
    drag,
    // Read through the variables above rather than captured, so a later `set*` takes effect.
    tooltip: {
      hover: (e) => tooltip.hover(e),
      press: (e) => tooltip.press(e),
      suppress: () => tooltip.suppress(),
      dismiss: () => tooltip.dismiss(),
    },
    contextMenu: {
      enabled: () => contextMenu.enabled(),
      openAtHit: (e) => contextMenu.openAtHit(e),
      openAtBackground: (e) => contextMenu.openAtBackground(e),
      openAtRow: (e) => contextMenu.openAtRow(e),
      openAtGridBackground: (e) => contextMenu.openAtGridBackground(e),
      close: () => contextMenu.close(),
    },
    editDialog: {
      press: (target, id, counts) => editDialog.press(target, id, counts),
      reset: () => editDialog.reset(),
    },
  });

  ctx.on("pointer/barHover", (e) => arbiter.barHover(e));
  ctx.on("pointer/barDown", (e) => arbiter.barDown(e));
  ctx.on("pointer/barMove", (e) => arbiter.barMove(e));
  ctx.on("pointer/barUp", (e) => arbiter.barUp(e));
  ctx.on("pointer/background", (e) => arbiter.background(e));
  ctx.on("grid/rowPointerDown", (e) => arbiter.gridPointerDown(e));
  ctx.on("grid/rowPointerMove", (e) => arbiter.gridPointerMove(e));
  ctx.on("grid/rowPointerUp", (e) => arbiter.gridPointerUp(e));
  ctx.on("grid/rowContextMenu", (e) => arbiter.gridContextMenu(e));
  ctx.on("grid/backgroundContextMenu", (e) => arbiter.gridBackgroundContextMenu(e));

  /* --- keyboard: Escape and the selection shortcuts --------------------- */

  const doc: Document | undefined = ctx.root.ownerDocument ?? undefined;
  if (doc !== undefined) {
    listen(ctx, doc, "keydown", (e) => {
      // Typing wins: a key pressed inside an input, textarea or contenteditable belongs to that
      // field and to nothing else — not even to the always-on gesture cancel, since a user typing
      // has no gesture in flight to cancel. `isEditableTarget` (`@stargantt/sdk`) is a superset of
      // the narrower per-feature guards the individual predecessor plugins each hand-rolled (it
      // also recognizes `select` and walks ancestors) — one shared guard instead of several
      // narrower ones, a deliberate SDK-consolidation choice.
      const editableTarget = isEditableTarget(e.target);
      const active = doc.activeElement;
      // Resolved BEFORE the arbiter cancels anything: Escape's rubber-band cancel takes priority
      // over the opt-in `clearOnEscape`, and the priority is decided by whether a band is in flight
      // at the moment of the press.
      const action = selection.handleKey({
        key: e.key,
        ctrlKey: e.ctrlKey === true,
        metaKey: e.metaKey === true,
        editableTarget,
        focusInRoot: active !== null && active !== undefined && ctx.root.contains(active),
      });
      if (e.key === "Escape" && !editableTarget) arbiter.escape();
      if (action === undefined) return;
      // Keep the browser from also select-all-ing the page text under the chart.
      if (action === "select-all" && typeof e.preventDefault === "function") e.preventDefault();
      selection.runShortcut(action);
    });
  }

  /* --- keyboard edits (§5) ---------------------------------------------- */

  const focus = focusChannel(ctx);

  /**
   * The focus channel and the task a chord would edit, or `undefined` when there is nothing to
   * edit. A summary's dates and progress are derived and the store rejects the write, so declining
   * here keeps the history free of no-op entries.
   */
  function focusedEditableTask():
    | { channel: NonNullable<ReturnType<typeof focus>>; id: TaskId; task: Readonly<Task> }
    | undefined {
    const channel = focus();
    if (channel === undefined) return undefined;
    const id = channel.state.get().focused;
    if (id === undefined) return undefined;
    const task = data.getTask(id);
    if (task === undefined || task.type === "summary") return undefined;
    return { channel, id, task };
  }

  /** Steps the focused task by one unit and speaks its new period. */
  function keyboardEdit(mode: DragMode, direction: 1 | -1): void {
    const target = focusedEditableTask();
    if (target === undefined) return;
    const { channel, id, task } = target;
    const range = steppedRange(
      mode,
      { start: task.start, end: task.end },
      direction,
      snapModule.service,
      config.dragEdit.minDuration,
    );
    // A press that lands the task exactly where it already is changes nothing.
    if (range === undefined) return;
    // One press is one edit and one undo entry, so it carries no `coalesceKey`.
    ctx.dispatch("task/move", { id, start: range.start, end: range.end });
    // What is spoken is the period that was committed, so a screen-reader user hears what the store
    // now holds rather than the intermediate stepped instant.
    channel.announce(messages.edited({ name: task.name, start: range.start, end: range.end }));
  }

  /** Steps the focused task's completion by one press and speaks its new value. */
  function keyboardProgressEdit(direction: 1 | -1): void {
    const target = focusedEditableTask();
    if (target === undefined) return;
    const { channel, id, task } = target;
    const current = task.progress ?? 0;
    const next = nextProgress(current, direction);
    // A press whose clamped result equals the stored progress dispatches nothing.
    if (next === current) return;
    ctx.dispatch("task/setProgress", { id, progress: next });
    channel.announce(messages.progressEdited({ name: task.name, progress: next }));
  }

  // `enabled: false` is the read-only-composition switch: no pointer gestures (the controller
  // declines every press) and no key-binding contributions either.
  if (config.dragEdit.enabled) {
    for (const { key, mode, direction } of EDIT_KEYS) {
      contributeKeyBinding(ctx, { key, run: () => keyboardEdit(mode, direction) });
    }
    for (const { key, direction } of PROGRESS_KEYS) {
      contributeKeyBinding(ctx, { key, run: () => keyboardProgressEdit(direction) });
    }
  }

  /* --- the seven peripheral features -------------------------------------- */

  const wiring: PeripheralWiring = {
    ctx,
    messages,
    config: {},
    selection: selection.service,
    snap: snapModule.service,
    setTooltip: (impl) => {
      tooltip = impl;
    },
    setContextMenu: (impl) => {
      contextMenu = impl;
    },
    setEditDialog: (impl) => {
      editDialog = impl;
    },
    menuClosed: () => arbiter.menuClosed(),
    reportError,
  };
  /** The wiring bag with one feature's own configuration nest in it. */
  const nest = (raw: unknown): PeripheralWiring => ({
    ...wiring,
    config: typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {},
  });

  if (config.enabled.tooltip) wireTooltip(nest(rawConfig.tooltip));
  if (config.enabled.contextMenu) wireContextMenu(nest(rawConfig.contextMenu));
  if (config.enabled.zoomControls) wireZoom(nest(rawConfig.zoomControls));
  if (config.enabled.clipboard) wireClipboard(nest(rawConfig.clipboard));
  if (config.enabled.filterSearch) wireFilter(nest(rawConfig.filterSearch));
  if (config.enabled.editDialog) wireEditDialog(nest(rawConfig.editDialog));
  if (config.enabled.sidePanel) wireSidePanel(nest(rawConfig.sidePanel));
}

/**
 * Creates the interaction plugin: selection, drag editing, snapping, and the peripheral UI
 * features.
 *
 * Configurable plugins are exported as factories because the host passes no per-plugin config to
 * `setup()`: the configuration is closed over here and the produced plugin itself takes `void`.
 */
export function interaction(config: InteractionConfig = {}): Plugin<void> {
  // A snapshot, so a later mutation of the caller's object cannot change a running chart.
  const options: InteractionConfig = { ...config };
  return definePlugin({
    meta: {
      id: PLUGIN_ID,
      // Every hard dependency is a strictly lower layer: the store (L1), the view and its timeline
      // and theme (L2), the row model and the grid mirror (L3), and the bar geometry (L4).
      dependsOn: [
        "stargantt.data-store",
        "stargantt.view",
        "stargantt.tree-grid",
        "stargantt.task-bars",
      ],
      // Same layer, resolved late and never at `setup()`: the a11y plugin starts after this one.
      // Without it the keyboard chords stay buffered and their announcements silent.
      optional: ["stargantt.a11y"],
    },
    setup: (ctx) => setup(ctx, options),
  });
}
