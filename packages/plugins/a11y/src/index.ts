// docs/specs/plugins/a11y.md
/**
 * `@stargantt/plugin-a11y` — plugin id `stargantt.a11y`.
 *
 * Makes the chart usable with a keyboard and a screen reader. It builds a hidden `role="treegrid"`
 * mirror of the rows next to the canvas — virtualized exactly like the chart, so only the rows
 * around the current viewport exist in the DOM while `aria-rowcount` and `aria-rowindex` still
 * report the true position in the full list. Each mirrored row speaks the task's name, period and
 * progress, carries its depth and expanded state, and — wherever selection information exists —
 * its `aria-selected`.
 *
 * Focus moves with a roving tabindex: the arrow keys walk the rows, `+` / `-` expand and collapse
 * them, and the chart scrolls so the focused row stays fully in view. Every key is routed through
 * the `keys/bindings` extension point, so any plugin can add or replace a chord — later
 * contributions win. Operation results are announced through an `aria-live="polite"` region,
 * reachable from other plugins through the `stargantt.focus` service, whose store publishes every
 * effective focus placement.
 *
 * `setup()` below is wiring only: every feature lives in its own `internal/` module and is
 * unit-testable without a host (`references/code-quality.md` §1).
 */
import { collect, createStore, definePlugin } from "@stargantt/core";
import type { Plugin, PluginContext } from "@stargantt/core";
import type { TaskId } from "@stargantt/plugin-data-store";
// Type-only imports. They bring the sibling packages' `declare module "@stargantt/core"`
// augmentations into this program, so `ctx.use(...)`, `ctx.dispatch(...)` and `ctx.on(...)` below
// are checked against the real key spaces. Erased at emit — no runtime dependency is added, and
// `@stargantt/plugin-interaction` (same layer) is reached only through the optional, late lookup in
// `internal/selection-channel.ts`.
import type {} from "@stargantt/plugin-interaction";
import type {} from "@stargantt/plugin-task-bars";
import type {} from "@stargantt/plugin-tree-grid";
import type {} from "@stargantt/plugin-view";
import { resolveMessages } from "./messages";
import type { A11yConfig, A11yMessages, FocusService, FocusState, KeyBinding } from "./types";
import { defaultBindings } from "./internal/bindings";
import { dependencyParts } from "./internal/dependency-text";
import { mountKeyDispatcher } from "./internal/dispatch";
import { createEditAnnouncer } from "./internal/edit-announce";
import {
  FOCUS_LAYER_ID,
  FOCUS_LAYER_Z_INDEX,
  FOCUS_STROKE_FALLBACK,
  FOCUS_STROKE_TOKEN,
  createFocusLayer,
} from "./internal/focus-layer";
import { chordCache } from "./internal/keys";
import { mountMirror } from "./internal/mirror";
import type { Mirror } from "./internal/mirror";
import { createSelectionChords } from "./internal/selection-chords";
import type { SelectionChords } from "./internal/selection-chords";
import { selectionChannel } from "./internal/selection-channel";
import { createShortcutHelp } from "./internal/shortcut-help";
import { createSummaryTable } from "./internal/summary-table";
import { asIdSet } from "./internal/ids";
import type { IdSetLike } from "./internal/ids";

/* ------------------------------------------------------------------ *
 * Public surface
 * ------------------------------------------------------------------ */

export type {
  A11yConfig,
  A11yMessages,
  FocusService,
  FocusState,
  KeyBinding,
  RowTextParts,
} from "./types";
export { DEFAULT_MESSAGES } from "./messages";

/* ------------------------------------------------------------------ *
 * Plugin
 * ------------------------------------------------------------------ */

const PLUGIN_ID = "stargantt.a11y";

/** The scope the focus box's paint order is claimed in. */
const LAYER_SCOPE = "renderer/layers";

function setup(ctx: PluginContext, config: A11yConfig): void {
  /* --- services (all strictly lower layers) ----------------------------- */

  const data = ctx.use("stargantt.data");
  const view = ctx.use("stargantt.view");
  const timeline = ctx.use("stargantt.timeline");
  const theme = ctx.use("stargantt.theme");
  const rows = ctx.use("stargantt.rows");
  const grid = ctx.use("stargantt.grid");
  const bars = ctx.use("stargantt.task-bars");

  // Contributions that are functions are invoked by the point-owning plugin, which must guard them
  // and report through `core/pluginError`. The contributor's own plugin id is not observable
  // through the public API, so this plugin is named and the cause wrapped with the point it came
  // through.
  const fault = (error: unknown): void => {
    ctx.emit("core/pluginError", {
      pluginId: PLUGIN_ID,
      error: { point: "keys/bindings", cause: error },
    });
  };

  const messages: A11yMessages = resolveMessages(config.messages, (messageKey, cause) => {
    ctx.emit("core/pluginError", { pluginId: PLUGIN_ID, error: { messageKey, cause } });
  });

  // Focus and selection are separated: the plugin draws its own focus box, so selecting the focused
  // task on every move is no longer required to see where the focus is. `syncSelection` (default
  // `true`) keeps doing it anyway, preserving the historical UX.
  const syncSelection = config.syncSelection !== false;

  /* --- the focus store (§ Service) --------------------------------------- */

  // Set only on an effective placement; the row-0 tabindex fallback is not a placement and leaves
  // the store at its initial value.
  const focusState = createStore<FocusState>({ focused: undefined });

  // Scrolls the chart body via `ViewService.scrollTo` by the minimum amount that leaves `id`'s row
  // fully within the viewport; a row already fully visible is left untouched. The horizontal
  // position is never changed.
  const scrollRowIntoView = (id: TaskId): void => {
    const row = rows.rowOf(id);
    if (row === undefined) return;
    const vp = view.viewport.get();
    // A detached or unsized container (e.g. a headless composition) has nothing to scroll.
    if (vp.height <= 0) return;
    const top = rows.yOf(row);
    const height = rows.rowHeight(row);
    if (top < vp.scrollTop) view.scrollTo({ scrollTop: top });
    else if (top + height > vp.scrollTop + vp.height) {
      view.scrollTo({ scrollTop: top + height - vp.height });
    }
  };

  /* --- the ARIA mirror and the roving focus ------------------------------ */
  // The mirror's callbacks and the chords module refer to each other, so one of the two has to be
  // reachable through a binding that already exists while the other is being built. These holders
  // are it: plain `let`s assigned the moment each part exists, so a callback that fires during
  // construction reads "not ready yet" instead of touching an uninitialized `const`.
  let mirrorRef: Mirror | undefined;
  let chordsRef: SelectionChords | undefined;

  const mirror = mountMirror(ctx, {
    rows,
    data,
    onFocus: (id, cause) => {
      chordsRef?.onFocusPlaced(id, cause);
      // The focus box is this plugin's own layer; nothing else repaints it.
      view.invalidate("main");
      scrollRowIntoView(id);
    },
    // DOM focus entered (or left) the mirror. On entry the full focus visualization is painted for
    // the effectively-focused row — including the never-placed row-0 tabindex fallback, which still
    // sets no store. On exit the visualization is cleared only when no effective placement was made.
    onFocusVisibility: (visible) => {
      if (mirrorRef === undefined) return;
      if (visible) grid.setFocused(mirrorRef.focusedId());
      else if (!mirrorRef.focusPlaced()) grid.setFocused(undefined);
      view.invalidate("main");
    },
    // The single choke point for reporting: the mirror calls this for every effective focus change,
    // whether driven by an explicit `focusTask` (arrow move, pointer follow, `FocusService.focus`)
    // or by the mirror relocating or clearing an already-placed focus on its own (a collapsing
    // ancestor, a store change that drops the focused task).
    onFocusChanged: (id) => {
      // The range anchor goes stale at the moment the focus moves, not at the moment it is read;
      // this callback is where the mirror reports relocating the focus on its own.
      chordsRef?.onFocusChanged();
      focusState.set({ focused: id });
      // The same placement is pushed into the grid pane, which marks the row
      // `.sg-grid-row--focused` and scrolls it into the grid's own viewport.
      grid.setFocused(id);
    },
    label: config.label,
    rowText: messages.rowText,
    // The dependency read-out is default-off; when off the mirror is handed no builder at all and
    // its DOM stays byte-identical to the pre-feature output.
    rowDescription:
      config.describeDependencies === true
        ? (id) => {
            const parts = dependencyParts(data.query(), id);
            return parts === undefined ? "" : messages.rowDependencies(parts);
          }
        : undefined,
  });
  mirrorRef = mirror;

  /* --- the optional, late-resolved selection edge (§ Dependencies) -------- */

  // Never looked up at `setup()`: `stargantt.selection` is a same-layer service whose provider may
  // start after this plugin. Every call site below goes through this channel, which resolves once
  // and then installs the state subscription that drives `aria-selected`, `aria-multiselectable`
  // and the keyboard anchor reset.
  const selection = selectionChannel(ctx, {
    own: (d) => ctx.own(d),
    // A same-layer service any plugin may provide: the declared `ReadonlySet` is checked rather
    // than assumed, so an array-shaped payload cannot throw out of the subscription.
    readIds: (taskIds) => asIdSet(taskIds as IdSetLike),
    onResolved: (service, selected) => {
      // `mode()` never changes over the service's lifetime, so it is read once, here.
      mirror.setMultiselectable(service.mode() === "multi");
      // Seeds the mirror with whatever is already selected, so the first render after resolution is
      // correct without waiting for a change that may never come.
      mirror.setSelected(selected ?? new Set<TaskId>());
    },
    onChanged: (selected) => {
      // Every effective change, by any path (pointer, this plugin's own keyboard chords, or
      // programmatic), updates the mirror's `aria-selected` — the accessible channel for selection
      // state — and invalidates the keyboard anchor, since a selection this plugin did not choose
      // no longer corresponds to a row it chose. The chords module re-states its anchor after each
      // of its own `select()` calls, which is why this needs no "was it me?" flag.
      mirror.setSelected(selected ?? new Set<TaskId>());
      chordsRef?.onSelectionChanged();
    },
  });

  const focusedTask = (): TaskId | undefined => mirror.focusedId();

  const chords = createSelectionChords({
    rows,
    selection,
    syncSelection,
    shiftMoveFocus: (delta) => mirror.moveFocus(delta, "shift"),
    focusedTask,
    announce: (message) => mirror.announce(message),
    selectionCount: (count) => messages.selectionCount(count),
  });
  chordsRef = chords;

  /* --- the focus box: a dedicated `renderer/layers` contribution ---------- */

  ctx.claimOrder(LAYER_SCOPE, FOCUS_LAYER_ID, FOCUS_LAYER_Z_INDEX);
  ctx.contribute(
    "renderer/layers",
    createFocusLayer({
      focusPlaced: () => mirror.focusPlaced(),
      focusVisible: () => mirror.focusVisible(),
      focusedId: () => mirror.focusedId(),
      barBoxOf: (id) => bars.barBoxOf(id),
      // One token read per pass; the theme layer caches the bulk `getComputedStyle` behind it and
      // returns "" for an unset property, which falls back to the built-in colour.
      stroke: () => theme.get(FOCUS_STROKE_TOKEN) || FOCUS_STROKE_FALLBACK,
    }),
  );

  /* --- `keys/bindings` (collect, last wins) ------------------------------ */

  const bindingsPoint = ctx.defineExtensionPoint("keys/bindings", collect<KeyBinding>());

  // The keyboard edit-commit announcement, armed by the Enter binding and disarmed by any other
  // executed binding or any pointer gesture.
  const editAnnouncer = createEditAnnouncer({
    taskName: (id) => data.getTask(id)?.name,
    announce: (message) => mirror.announce(message),
    editCommitted: (name) => messages.editCommitted(name),
  });

  for (const binding of defaultBindings({
    rows,
    messages,
    taskName: (id) => data.getTask(id)?.name,
    parentOf: (id) => data.getTask(id)?.parentId ?? null,
    hasChildren: (id) => (data.query().children.get(id)?.length ?? 0) > 0,
    focusedTask,
    moveFocus: (delta) => mirror.moveFocus(delta, "keyboard"),
    focusTask: (id) => mirror.focusTask(id, "keyboard"),
    announce: (message) => mirror.announce(message),
    toggleRow: (id, expanded) => ctx.dispatch("view/rowToggle", { id, expanded }),
    startEdit: (id) => {
      // Arm the keyboard edit-commit announcement: the next change to this task is the edit
      // committing (the editor holds the DOM focus in between, so no other keyboard path can change
      // it first; a pointer gesture disarms it).
      editAnnouncer.arm(id);
      ctx.dispatch("view/editStart", { id });
    },
    multiSelection: () => chords.multiSelection(),
    shiftMove: (delta) => chords.shiftMove(delta),
    toggleFocusedSelection: () => chords.toggleFocused(),
  })) {
    ctx.contribute("keys/bindings", binding);
  }

  /* --- the shortcut-help dialog (opt-in) --------------------------------- */
  // Created only when enabled; its DOM exists only while open, so an enabled-but-unopened chart
  // renders nothing extra.
  const help =
    config.shortcutHelp === true
      ? createShortcutHelp({
          doc: ctx.root.ownerDocument,
          root: ctx.root,
          bindings: () => bindingsPoint.get(),
          title: () => messages.shortcutHelpTitle(),
          closeLabel: () => messages.shortcutHelpClose(),
        })
      : undefined;
  if (help !== undefined) {
    ctx.own({ dispose: () => help.close() });
    ctx.contribute("keys/bindings", {
      key: "?",
      description: "Show keyboard shortcuts",
      run: () => help.toggle(),
    });
  }

  /* --- the screen-reader summary table (opt-in) -------------------------- */

  const summary =
    config.summaryTable === true
      ? createSummaryTable({
          doc: ctx.root.ownerDocument,
          root: ctx.root,
          data,
          messages,
        })
      : undefined;
  if (summary !== undefined) {
    ctx.own({ dispose: () => summary.close() });
    ctx.contribute("keys/bindings", {
      key: "Ctrl+Alt+S",
      description: "Show the summary table",
      run: () => summary.toggle(),
    });
    // `Escape` closes an open table and stays inert otherwise, so the chord still falls through to
    // any other contribution (drag cancel, an editor's own Escape) while the table is closed.
    ctx.contribute("keys/bindings", {
      key: "Escape",
      when: () => summary.isOpen(),
      run: () => summary.close(),
    });
  }

  /* --- keyboard zoom (opt-in) -------------------------------------------- */

  if (config.zoomKeys === true) {
    // The chords dispatch the view plugin's own commands — a strictly downward edge — so they
    // walk the full composed zoom ladder. The announcement reads the level the timeline reports
    // *after* the step.
    const zoomStep = (direction: "in" | "out"): void => {
      if (direction === "in") ctx.dispatch("timeline/zoomIn", {});
      else ctx.dispatch("timeline/zoomOut", {});
      mirror.announce(messages.zoomChanged(timeline.zoomLevel.get().id));
    };
    // The chords are plain `+` / `-`, never `Ctrl`+`±`: the dispatcher would `preventDefault` the
    // latter and take the browser's page zoom (a WCAG 1.4.4 resize-text affordance) away from any
    // keyboard user whose focus is inside the chart. Contributed after the default bindings, so
    // while `zoomKeys` is on they shadow the `+` / `-` expand-collapse aliases; `ArrowRight` /
    // `ArrowLeft` keep expand/collapse keyboard-reachable, and a later contribution can rebind
    // either pair.
    ctx.contribute("keys/bindings", {
      key: "+",
      description: "Zoom in (finer timeline)",
      run: () => zoomStep("in"),
    });
    ctx.contribute("keys/bindings", {
      key: "-",
      description: "Zoom out (coarser timeline)",
      run: () => zoomStep("out"),
    });
  }

  /* --- key routing -------------------------------------------------------- */

  const chordOf = chordCache();
  mountKeyDispatcher(ctx, {
    bindings: () => bindingsPoint.get(),
    chordOf,
    fault,
    // Any executed binding disarms the pending edit-commit announcement first; the Enter binding
    // re-arms it inside its own `run()`. This keeps a cancelled edit (Escape) from leaving the flag
    // armed until an unrelated later change to the same task — an undo, a move chord — announced
    // itself as "updated".
    onClaim: () => editAnnouncer.disarm(),
    // A pointer gesture disarms it too: whatever commits after this point is (or is
    // indistinguishable from) a silent pointer edit.
    onPointerDown: () => editAnnouncer.disarm(),
    // While the shortcut-help dialog is open it owns every in-scope keystroke.
    modalStroke: help === undefined ? undefined : (stroke) => help.handleStroke(stroke),
  });

  /* --- keeping the mirror in step ---------------------------------------- */

  // The visible row set — and with it which rows are hidden at height 0, and therefore unreachable
  // — is re-derived from these two stores only; the mirror caches that answer between them so
  // scrolling never rescans the row list.
  ctx.own(
    rows.rows.subscribe(() => {
      mirror.invalidateRows();
      mirror.schedule();
    }),
  );
  ctx.own(
    data.tasks.subscribe((next, prev) => {
      mirror.invalidateRows();
      // The armed keyboard edit committed: announce it through the polite region. The pointer path
      // of an edit stays silent; it disarms this from the pointerdown claim.
      editAnnouncer.onTasksChanged(next, prev);
      mirror.schedule();
    }),
  );

  // Each sort cycle step is announced, so a screen-reader user learns that every row just
  // reordered. The store carries no header once sorting is off, so the previous state names the
  // column the cycle just left.
  ctx.own(
    grid.sort.subscribe((next, prev) => {
      if (next?.columnId === prev?.columnId && next?.direction === prev?.direction) return;
      const header = next?.header ?? prev?.header;
      if (header === undefined) return;
      mirror.announce(messages.sortChanged({ header, direction: next?.direction ?? null }));
    }),
  );

  ctx.on("lifecycle/ready", () => {
    // Every plugin has been set up by now, so this is the earliest moment a same-layer optional
    // service can be resolved — and the resolution is what seeds `aria-selected` and
    // `aria-multiselectable`.
    selection();
    // First layout has happened by now, so the cached container measurement the window size is
    // derived from is taken (or retaken) here rather than during setup, when the root may still be
    // unsized (`references/code-quality.md` §3).
    mirror.remeasure();
    mirror.render();
  });

  // The mirror window follows the viewport: every scroll re-anchors it at the first visible row,
  // exactly the range the panes render, so a screen-reader user always reads what is on screen.
  ctx.on("view/scrolled", (e) => {
    mirror.setViewportStart(rows.rowAtY(Math.max(0, e.scrollTop)));
  });

  /* --- focus follows the pointer ------------------------------------------ */

  // A press on a grid row or on a bar's body places the roving focus on the pressed row, so the
  // documented mixed-input flows ("click a row, then Enter / Shift+Arrow") address the clicked row.
  // The `"pointer"` cause is what keeps the placement from re-selecting: the selection plugin owns
  // what a press selects.
  const pointerFocus = (id: TaskId): void => {
    if (rows.rowOf(id) === undefined) return;
    mirror.focusTask(id, "pointer");
  };
  ctx.on("grid/rowPointerDown", (e) => {
    // Only a primary-button press follows: a right-press opens the context menu, whose plugin owns
    // focus for it, and a focus steal here would land on the ARIA mirror row instead of the menu's
    // first entry.
    if (e.button !== 0) return;
    pointerFocus(e.id);
  });
  ctx.on("pointer/barDown", (e) => {
    if (e.event.button !== 0) return;
    // The bar body only: a press on a resize handle or the progress strip is the start of an edit
    // gesture and does not move the focus.
    if (e.hit.kind === "bar") pointerFocus(e.hit.id as TaskId);
  });

  /* --- the service --------------------------------------------------------- */

  const service: FocusService = {
    state: focusState,
    // The public signature carries no cause, so the service names its own internally.
    focus: (id) => mirror.focusTask(id, "api"),
    announce: (message) => mirror.announce(message),
  };
  ctx.provide("stargantt.focus", service);

  mirror.render();
}

/**
 * Creates the accessibility plugin: it mirrors the visible rows into a `role="treegrid"` DOM next
 * to the canvas, moves a roving focus with the arrow keys, routes every chord through the
 * `keys/bindings` extension point, and announces the results.
 *
 * With no argument the grid is named "Gantt chart" and the four opt-in features (dependency
 * read-out, shortcut help, keyboard zoom, summary table) are off.
 *
 * Configurable plugins are exported as factories because the host passes no per-plugin config to
 * `setup()`: the configuration is closed over here and the produced plugin itself takes `void`.
 */
export function a11y(config: A11yConfig = {}): Plugin<void> {
  // A snapshot, so a later mutation of the caller's object cannot change a running chart.
  const options: A11yConfig = { ...config };
  return definePlugin({
    meta: {
      id: PLUGIN_ID,
      // Every hard dependency is a strictly lower layer: the store (L1), the view with its timeline
      // and theme (L2), the row model and the grid mirror (L3), and the bar geometry (L4).
      dependsOn: [
        "stargantt.data-store",
        "stargantt.view",
        "stargantt.tree-grid",
        "stargantt.task-bars",
      ],
      // Same layer, resolved late and never at `setup()`: the interaction plugin provides
      // `stargantt.selection` and may start after this one. Without it the multi-selection chords
      // report inactive, `syncSelection` has nothing to sync, and no selection attribute is written
      // — everything else works unchanged.
      optional: ["stargantt.interaction"],
    },
    setup: (ctx) => setup(ctx, options),
  });
}
