// docs/specs/plugins/scheduling.md §5 — dependency links.
/**
 * Entry point of the links area: connector ports and clearance (§5.1), pointer and keyboard link
 * creation (§5.2 / §5.6), routing and painting (§5.3), link selection and deletion (§5.4), the
 * emphasis/conflict/driving/drop-ring passes (§5.5), the side-panel inspector (§5.7) and the
 * repaint wiring (§5.8).
 *
 * Wiring only: every rule lives in a sibling module of this directory (`geometry`, `routes`,
 * `avoid`, `style`, `paint`, `emphasis`, `analysis`, `pairs`, `hit`, `link-drag`, `keyboard-link`,
 * `inspector`), each testable without a host.
 *
 * §4.3 — the port drag, the link-selection press and the hover emphasis ride the PUBLIC input
 * stream (`pointer/barDown` / `pointer/barMove` / `pointer/barUp` / `pointer/background` /
 * `pointer/barHover`). Interaction's gesture arbiter starts no gesture for a `"port"` or `"link"`
 * hit, so no competition arises, and this area attaches no document-level pointer listener.
 *
 * §14 (P4 review ruling) — `meta.optional` does not order startup: the core tiers plugins by
 * `dependsOn` alone, so this plugin's `setup()` can and generally does run before `stargantt.view` /
 * `stargantt.task-bars` (same tier as this plugin, or later) have provided anything. Every chart
 * service this area reads is therefore resolved PER USE (`viewService()` / `barsService()` /
 * `timelineService()` / `themeService()`, called fresh at the point of need) rather than latched
 * into a setup-time variable; nothing here early-returns out of the whole function on their
 * absence. Layer/order claims and `ctx.contribute()` calls happen unconditionally at setup
 * (`claimOrder`/`contribute` are timing-agnostic — the core buffers a contribution ahead of its
 * point's definition, and arbitration order determinism is tied to plugin *registration* order,
 * not to whichever plugin's `lifecycle/ready` listener happens to run first). Service-presence
 * DEPENDENT subscriptions (the ones that only make sense once a specific optional service exists —
 * §5.4's task-selection disarm, §5.5's selection-driven path emphasis, §5.8's rows/timeline
 * repaint edges) are registered inside a `ctx.on("lifecycle/ready", ...)` handler, which fires only
 * after every composed plugin's `setup()` has run — the earliest point these lookups are
 * order-independent. An absent optional service leaves the consuming path silently inert: no
 * `core/pluginError` (that channel is reserved for foreign-code faults).
 */
import type { LinkId, LinkType, TaskId } from "@stargantt/plugin-data-store";
// Type-only: these load the sibling packages' `declare module "@stargantt/core"` augmentations, so
// the service keys, the contributions and the dispatches below are checked against the real key
// spaces. Erased at emit — no runtime dependency is added.
import type { FocusService, KeyBinding } from "@stargantt/plugin-a11y";
import type { SelectionService } from "@stargantt/plugin-interaction";
import type { TaskBarsService } from "@stargantt/plugin-task-bars";
import type { RowsService } from "@stargantt/plugin-tree-grid";
import type { LayerContribution, ThemeService, TimelineService, ViewService, Viewport } from "@stargantt/plugin-view";
import { listen } from "@stargantt/sdk";
import type { SchedulingAreaDeps } from "../areas";
import { pathLinkIds, linkStatus } from "./analysis";
import { PORT_CLEARANCE, portCentre } from "./geometry";
import { createLinkHitTester } from "./hit";
import { makeInspectorContribution } from "./inspector";
import { LINK_CHORD, linkChordAnnouncement, linkChordStep } from "./keyboard-link";
import { createPortDragGesture, dropEnd, resolveDrop } from "./link-drag";
import { createLinkEmphasis } from "./emphasis";
import {
  BAND_COLOR,
  DRIVING_COLOR,
  EMPHASIS_COLOR,
  LINK_BAND_TOKEN,
  LINK_COLOR,
  LINK_DRIVING_TOKEN,
  LINK_EMPHASIS_TOKEN,
  LINK_LINE_TOKEN,
  LINK_PORT_TOKEN,
  PORT_COLOR,
  drawBand,
  drawLink,
  drawPort,
  drawPortRing,
} from "./paint";
import { isPairLinked } from "./pairs";
import type { LinkedPredicate } from "./pairs";
import type { RoutedLink, RowSlice } from "./routes";
import { NO_ROWS, createRouteIndex, inHorizontalView, toViewport } from "./routes";
import { DIM_ALPHA, linkStroke } from "./style";
import type { LinkStroke } from "./style";

/* ------------------------------------------------------------------ *
 * Layer identity (§15 reserves the `stargantt.scheduling:*` order keys)
 * ------------------------------------------------------------------ */

/** The order scope both layer claims are made in. */
const LAYER_SCOPE = "renderer/layers";

/** Identifies the dependency-line contribution and its order claim. */
const LINE_LAYER_ID = "stargantt.scheduling:links";

/** Identifies the ports-and-rubber-band contribution and its order claim. */
const PORT_LAYER_ID = "stargantt.scheduling:ports";

// §5 — 69 keeps the arrows above the bars they connect (task-bars 60) and below interaction's
// selection frame (70); 110 puts the interactive port/band furniture in the overlay band.
/** Paint order of the dependency-line layer. */
const LINE_Z_INDEX = 69;

/** Paint order of the port/rubber-band layer. */
const PORT_Z_INDEX = 110;

/** Identifies this area's `taskbars/endGutter` reservation. */
const END_GUTTER_ID = "stargantt.scheduling:link-ports";

/** A viewport-shaped zero fallback for a hit test asked before any real viewport is available. */
const ZERO_VIEWPORT: Viewport = { scrollLeft: 0, scrollTop: 0, width: 0, height: 0 };

/** Wires the links area. Called unconditionally — the `dependencies` nest is on by default (§11). */
export function wireLinks(deps: SchedulingAreaDeps): void {
  const { ctx, data, messages } = deps;
  const options = deps.config.dependencies;
  const { allowLinkCreate, routingStyle, defaultLinkType, defaultLag } = options;

  /* --- services (§14: data + view + task-bars, resolved per use, never latched) ------------- */

  const viewService = (): ViewService | undefined => ctx.useOptional("stargantt.view");
  const barsService = (): TaskBarsService | undefined => ctx.useOptional("stargantt.task-bars");
  const timelineService = (): TimelineService | undefined => ctx.useOptional("stargantt.timeline");
  const themeService = (): ThemeService | undefined => ctx.useOptional("stargantt.theme");

  // §14 — the three late-optional edges are resolved per use, never latched. `rows` alone memoizes
  // once resolved (a row model, once composed, never goes away), matching the original intent of
  // the earlier per-setup latch without repeating its setup-time-only failure mode.
  let rowsLatch: RowsService | undefined;
  const rowsService = (): RowsService | undefined =>
    (rowsLatch ??= ctx.useOptional("stargantt.rows"));
  const selectionService = (): SelectionService | undefined =>
    ctx.useOptional("stargantt.selection");
  const focusService = (): FocusService | undefined => ctx.useOptional("stargantt.focus");

  /** Announces through the focus service when an a11y plugin is present; silent otherwise. */
  const announce = (message: string): void => {
    focusService()?.announce(message);
  };

  /** The row geometry, or the inert zero-row stand-in while no row model is composed. */
  const currentRows = (): RowSlice => rowsService() ?? NO_ROWS;
  const rows: RowSlice = {
    rowCount: () => currentRows().rowCount(),
    taskIdAt: (row) => currentRows().taskIdAt(row),
    rowHeight: (row) => currentRows().rowHeight(row),
    yOf: (row) => currentRows().yOf(row),
    rowAtY: (y) => currentRows().rowAtY(y),
  };

  /* --- geometry: the visible links and their routes --------------------- */

  // §5.2 / §5.6 — both creation gestures ask this before offering a link, so neither the
  // drop-candidate ring nor the chord promises a second link over a pair the store already holds
  // one for. The view is read at the moment of the question, never cached.
  const isLinked: LinkedPredicate = (sourceId, targetId) =>
    isPairLinked(data.query(), sourceId, targetId);

  // §5.1 — the anchor inset applies whenever link creation is enabled, so a route never shifts as
  // a row scrolls in or out; `allowLinkCreate: false` drops it and the ports with it. `barRect` is
  // a per-call re-resolve of `stargantt.task-bars` (§14) — absent, every task answers with no bar
  // and the route index naturally produces nothing.
  const routes = createRouteIndex({
    rows,
    data,
    barRect: (id) => barsService()?.barRect(id),
    routingStyle,
    anchorInset: allowLinkCreate ? PORT_CLEARANCE : 0,
    avoidBars: options.avoidBars,
  });

  const emphasis = createLinkEmphasis();
  const portDrag = createPortDragGesture();

  /* --- painting (§5.3 / §5.5) ------------------------------------------- */

  // §5.3 — colours are read at paint time, once per token per paint pass, as
  // `theme.get(token) || FALLBACK`: the fallback applies when the token resolves to the empty
  // string as well (absent theme service included). A theme change marks the renderer's layers
  // dirty, so no subscription is needed.
  const colorOf = (token: string, fallback: string): string => themeService()?.get(token) || fallback;

  // §5.5 — the conflict/driving classification runs only when a feature asks for it.
  const needStatus = options.highlightConflicts || options.highlightDriving;

  // The full-opacity links held back by the dimming pass below. Two parallel arrays reused across
  // paints, so a hovered chart allocates no more per frame than an unhovered one.
  const heldRoutes: RoutedLink[] = [];
  const heldStrokes: LinkStroke[] = [];

  const paintLink = (
    g: CanvasRenderingContext2D,
    entry: RoutedLink,
    stroke: LinkStroke,
    vp: Readonly<Viewport>,
  ): void => {
    drawLink(
      g,
      entry.route.map((p) => toViewport(p, vp)),
      stroke.color,
      { width: stroke.width, dash: stroke.dash, arrowHead: stroke.arrowHead },
    );
  }

  const drawLines = (g: CanvasRenderingContext2D, vp: Readonly<Viewport>): void => {
    // §5.3 — `showLinks: false` paints nothing; the layer stays contributed and its order claim
    // stays registered.
    if (!options.showLinks) return;
    const line = colorOf(LINK_LINE_TOKEN, LINK_COLOR);
    // Each of the three feature tokens is read only while the feature that paints with it is on.
    const band = options.linkEditing ? colorOf(LINK_BAND_TOKEN, BAND_COLOR) : BAND_COLOR;
    const emphasisColor = options.highlightPaths
      ? colorOf(LINK_EMPHASIS_TOKEN, EMPHASIS_COLOR)
      : EMPHASIS_COLOR;
    const drivingColor = options.highlightDriving
      ? colorOf(LINK_DRIVING_TOKEN, DRIVING_COLOR)
      : DRIVING_COLOR;
    // §5.5 — dimming exists only while something is emphasized; an empty set dims nothing and the
    // pass below is exactly the default one, down to the drawing order.
    const dimming = options.highlightPaths && emphasis.anyEmphasized();

    /** Resolves the stroke of one visible link, or `undefined` when it is culled away. */
    const strokeOf = (entry: RoutedLink): LinkStroke | undefined => {
      // §5.3 — opt-in: a route wholly outside the horizontal window paints nothing visible.
      if (options.cullLines && !inHorizontalView(entry, vp)) return undefined;
      const { link } = entry;
      let conflicting = false;
      let driving = false;
      if (needStatus) {
        const source = data.getTask(link.sourceId);
        const target = data.getTask(link.targetId);
        if (source !== undefined && target !== undefined) {
          const status = linkStatus(link, source, target);
          conflicting = options.highlightConflicts && status.conflicting;
          driving = options.highlightDriving && status.driving;
        }
      }
      const emphasized = emphasis.emphasized(link.id);
      return linkStroke({
        style: options.linkStyle,
        baseColor: line,
        typeColor: options.typeColors[link.type],
        bandColor: band,
        emphasisColor,
        drivingColor,
        conflictColor: options.conflictColor,
        conflicting,
        driving,
        emphasized,
        selected: options.linkEditing && emphasis.isSelected(link.id),
        dimmed: dimming && !emphasized,
      });
    };

    if (!dimming) {
      for (const entry of routes.routedLinks(vp)) {
        const stroke = strokeOf(entry);
        if (stroke !== undefined) paintLink(g, entry, stroke, vp);
      }
      return;
    }

    // Two passes, so `globalAlpha` is set once for the whole receding group instead of once per
    // line: the dimmed lines first, then everything that keeps full opacity on top of them.
    g.save();
    g.globalAlpha = DIM_ALPHA;
    for (const entry of routes.routedLinks(vp)) {
      const stroke = strokeOf(entry);
      if (stroke === undefined) continue;
      if (stroke.alpha < 1) paintLink(g, entry, stroke, vp);
      else {
        heldRoutes.push(entry);
        heldStrokes.push(stroke);
      }
    }
    g.restore();
    for (let i = 0; i < heldRoutes.length; i += 1) {
      const entry = heldRoutes[i];
      const stroke = heldStrokes[i];
      if (entry !== undefined && stroke !== undefined) paintLink(g, entry, stroke, vp);
    }
    heldRoutes.length = 0;
    heldStrokes.length = 0;
  };

  const drawPorts = (g: CanvasRenderingContext2D, vp: Readonly<Viewport>): void => {
    // §5.1 — with link creation off there is no port and no band to paint, and neither token is
    // read; the layer stays contributed and its order claim stays registered.
    if (!allowLinkCreate) return;
    // §14 — re-resolved on every paint; an absent task-bars service leaves this pass inert.
    const bars = barsService();
    if (bars === undefined) return;
    // §5.1 — ports are permanent, not hover-revealed: every visible bar carries both of them, so
    // the affordance never has to be found before it can be used.
    const range = routes.visibleRows(vp);
    if (range !== undefined) {
      const port = colorOf(LINK_PORT_TOKEN, PORT_COLOR);
      for (let row = range.first; row <= range.last; row += 1) {
        const id = rows.taskIdAt(row);
        if (id === undefined) continue;
        // §5.1 / §5.8 — `barRect` answers for a collapsed summary whether or not one is painted
        // (a line into a folded branch needs an anchor), so `hasOwnBar` decides the ports.
        if (!bars.hasOwnBar(id)) continue;
        const box = bars.barRect(id);
        if (box === undefined) continue;
        drawPort(g, toViewport(portCentre(box, "start"), vp), port);
        drawPort(g, toViewport(portCentre(box, "end"), vp), port);
      }
    }
    const drag = portDrag.current();
    if (drag === null) return;
    const band = colorOf(LINK_BAND_TOKEN, BAND_COLOR);
    drawBand(g, toViewport(drag.origin, vp), drag.point, band);
    // §5.5 — while a drag is in flight, ring the port the release would connect to, resolved by
    // the same rules the release itself uses, so the ring never promises a refused link.
    if (!options.highlightDropTargets) return;
    const contentX = drag.point.x + vp.scrollLeft;
    const contentY = drag.point.y + vp.scrollTop;
    const found = routes.taskAtY(contentY);
    if (found === undefined) return;
    if (resolveDrop(drag, found, contentX, contentY, isLinked) === undefined) return;
    const end = dropEnd(found.box, contentX, contentY);
    drawPortRing(g, toViewport(portCentre(found.box, end), vp), band);
  };

  // §14 — claims and contributions are registered unconditionally at setup: `claimOrder` and
  // `contribute` are timing-agnostic (the core buffers a contribution ahead of its point's
  // definition), and the corner/order arbitration's registration-order determinism is tied to
  // plugin registration order, not to `stargantt.view`'s presence. The draw bodies above re-resolve
  // `stargantt.task-bars`/`stargantt.theme` per call and paint nothing when absent — the layer
  // itself is always claimed, but it is a silent no-op until a chart surface exists to invoke it.
  const lineLayer: LayerContribution = { id: LINE_LAYER_ID, zIndex: LINE_Z_INDEX, draw: drawLines };
  const portLayer: LayerContribution = { id: PORT_LAYER_ID, zIndex: PORT_Z_INDEX, draw: drawPorts };
  ctx.claimOrder(LAYER_SCOPE, LINE_LAYER_ID, LINE_Z_INDEX);
  ctx.claimOrder(LAYER_SCOPE, PORT_LAYER_ID, PORT_Z_INDEX);
  ctx.contribute("renderer/layers", lineLayer);
  ctx.contribute("renderer/layers", portLayer);

  /* --- the end-gutter reservation (§5.1) -------------------------------- */

  // The same 17 CSS px the anchor inset uses, reserved outside both bar ends so bar-end
  // decorations sit clear of the port discs. Row-independent and constant while link creation is
  // enabled — ports come and go per row, the space they need does not.
  ctx.contribute("taskbars/endGutter", {
    id: END_GUTTER_ID,
    end: "both",
    size: PORT_CLEARANCE,
    active: () => allowLinkCreate,
  });

  /* --- the hit test (§5.1 / §5.3 / §5.4) -------------------------------- */

  ctx.contribute(
    "renderer/hitTest",
    createLinkHitTester({
      routes,
      // §14 — only ever invoked by the view plugin itself while dispatching a real hit test, so a
      // real viewport is available whenever this actually runs; the zero fallback is defensive.
      viewport: () => viewService()?.viewport.get() ?? ZERO_VIEWPORT,
      allowLinkCreate,
      showLinks: options.showLinks,
      linkEditing: options.linkEditing,
    }),
  );

  /* --- port-drag link creation (§5.2 / §4.3) ---------------------------- */

  if (allowLinkCreate) {
    // `x` / `y` on all three events are already in the viewport-local space this area paints in,
    // so no pane-offset bookkeeping is needed to keep tracking the pointer. These `pointer/*`
    // events are only ever emitted once interaction (and, transitively, view) are composed and
    // running, so by the time any of these handlers actually fires `stargantt.view` genuinely
    // resolves — the per-call `viewService()` lookup is the uniform, always-safe idiom (§14), not
    // a defensive workaround.
    ctx.on("pointer/barDown", (e) => {
      if (e.hit.kind !== "port") return;
      const view = viewService();
      if (view === undefined) return;
      const vp = view.viewport.get();
      const found = routes.taskAtY(e.y + vp.scrollTop);
      if (found === undefined) return;
      const contentX = e.x + vp.scrollLeft;
      const contentY = e.y + vp.scrollTop;
      const point = { x: e.x, y: e.y };
      if (!portDrag.start(found, contentX, contentY, point, e.event.pointerId)) return;
      view.invalidate("overlay");
    });

    // `pointer/barMove` is delivered only while a gesture is active; the view freezes the
    // initiating hit and keeps emitting synchronously for the whole gesture, so no re-hit-testing
    // is needed here. A move reported by a different pointer is declined by the gesture (§4.3).
    ctx.on("pointer/barMove", (e) => {
      if (!portDrag.track({ x: e.x, y: e.y }, e.event.pointerId)) return;
      viewService()?.invalidate("overlay");
    });

    ctx.on("pointer/barUp", (e) => {
      const started = portDrag.finish(e.event.pointerId);
      if (started === null) return;
      const view = viewService();
      view?.invalidate("overlay");
      // §4.3 — exactly one `pointer/barUp` is emitted for both a genuine release and a
      // `pointercancel`; a cancel abandons the drag with nothing dispatched.
      if (e.event.type === "pointercancel") return;
      if (view === undefined) return;
      const vp = view.viewport.get();
      const contentX = e.x + vp.scrollLeft;
      const contentY = e.y + vp.scrollTop;
      const found = routes.taskAtY(contentY);
      if (found === undefined) return;
      const draft = resolveDrop(started, found, contentX, contentY, isLinked);
      if (draft === undefined) return;
      // §5.2 — creation goes through the store's command, so the transaction, its will phase
      // (where §2.7 rejects cycles) and undo all apply. `defaultLag` fills `lag`; the type is
      // always derived from the two connected ends, so `defaultLinkType` is never consulted here.
      ctx.dispatch("link/add", {
        ...draft,
        ...(defaultLag !== undefined ? { lag: defaultLag } : {}),
      });
    });

    // Escape abandons an in-flight port drag with nothing dispatched — the pre-ship rule that any
    // in-progress interaction is cancellable from the keyboard (not restated by §5.6 verbatim —
    // recorded here as the inline addition pending a spec catch-up). Its `when` is true only
    // while a drag is in flight and the link-selection Escape's
    // only while a link is selected, so the two are disjoint whichever order the point scans them
    // in, and every unrelated Escape falls through to the bindings below both.
    const cancelDrag: KeyBinding = {
      key: "Escape",
      run: () => {
        if (portDrag.cancel()) viewService()?.invalidate("overlay");
      },
      when: () => portDrag.current() !== null,
    };

    /* --- keyboard link creation (§5.6) ---------------------------------- */

    // The task marked as the link source by the chord's first press; `null` when none is pending.
    let pendingSource: TaskId | null = null;

    const keyboardLink = (): void => {
      const focus = focusService();
      if (focus === undefined) return;
      const id = focus.state.get().focused;
      if (id === undefined) return;
      const step = linkChordStep(pendingSource, id, isLinked);
      // Mark on the first press, drop the pending source on the other three.
      pendingSource = step.kind === "mark" ? step.sourceId : null;
      if (step.kind === "create") {
        // §5.6 — the keyboard path names no bar ends, so the type is always `defaultLinkType`
        // (FS when omitted); `defaultLag` fills `lag` exactly as on the pointer path.
        ctx.dispatch("link/add", {
          sourceId: step.sourceId,
          targetId: step.targetId,
          type: defaultLinkType,
          ...(defaultLag !== undefined ? { lag: defaultLag } : {}),
        });
      }
      focus.announce(
        linkChordAnnouncement(step, (taskId) => data.getTask(taskId)?.name ?? String(taskId)),
      );
    };

    const linkBinding: KeyBinding = { key: LINK_CHORD, run: keyboardLink };
    ctx.contribute("keys/bindings", linkBinding);
    ctx.contribute("keys/bindings", cancelDrag);

    // A pending source naming a task the store no longer holds would create a link to nowhere, so
    // a data change clears it — silently, since nothing was announced when it was set aside from
    // the marking announcement above.
    ctx.own(
      data.tasks.subscribe(() => {
        pendingSource = null;
      }),
    );
  }

  /* --- link selection and deletion (§5.4) ------------------------------- */

  if (options.linkEditing) {
    const repaintSelection = (): void => {
      viewService()?.invalidate("main");
    };

    // The selected link's source task, remembered at press time so the survival check below asks
    // that one task's out-list instead of scanning the whole link table on every data change.
    let selectedSource: TaskId | null = null;

    ctx.on("pointer/barDown", (e) => {
      const view = viewService();
      if (view === undefined) return;
      const next = e.hit.kind === "link" ? (e.hit.id as LinkId) : null;
      selectedSource =
        next === null
          ? null
          : (routes
              .routedLinks(view.viewport.get())
              .find((entry) => entry.link.id === next)?.link.sourceId ??
            // The hit should always come from the memoized route list; if it ever does not, fall
            // back to the link table rather than silently dropping a live selection.
            data.links.get().get(next)?.sourceId ??
            null);
      if (emphasis.setSelected(next)) repaintSelection();
    });
    // A press on empty space deselects, exactly as a press on a bar does.
    ctx.on("pointer/background", () => {
      if (emphasis.setSelected(null)) repaintSelection();
    });

    const removeSelected = (): void => {
      const id = emphasis.selected();
      if (id === null) return;
      emphasis.setSelected(null);
      ctx.dispatch("link/remove", { ids: [id] });
      announce(messages.linkRemoved);
      repaintSelection();
    };
    const hasSelection = (): boolean => emphasis.selected() !== null;
    // `when` lets an unrelated Delete/Escape press fall through to earlier bindings, so these
    // claim the keys only while a link is actually selected.
    ctx.contribute("keys/bindings", { key: "Delete", run: removeSelected, when: hasSelection });
    ctx.contribute("keys/bindings", { key: "Backspace", run: removeSelected, when: hasSelection });
    ctx.contribute("keys/bindings", {
      key: "Escape",
      run: () => {
        if (emphasis.setSelected(null)) repaintSelection();
      },
      when: hasSelection,
    });

    // §5.4 — link selection and task selection claim the same Delete/Backspace keys, and link
    // selection is plugin-local state a viewer cannot relate to the task selection they can see.
    // A NON-EMPTY task selection therefore disarms the link selection; an empty one changes
    // nothing, so clearing a task selection does not also clear a just-clicked link.
    //
    // §14 — `stargantt.selection` (interaction, tier ≥ this plugin's) is resolved at
    // `lifecycle/ready`, never at setup: a setup-time `selectionService()` call would see
    // `undefined` in any composition where interaction has not run its own `setup()` yet (the
    // common case, since `meta.optional` does not order startup), silently dropping this
    // subscription forever.
    ctx.on("lifecycle/ready", () => {
      const selection = selectionService();
      if (selection === undefined) return;
      ctx.own(
        selection.state.subscribe((next) => {
          if (next.taskIds.size === 0) return;
          if (emphasis.setSelected(null)) repaintSelection();
        }),
      );
    });

    // A selected link the store no longer holds must not survive a data change: Delete would
    // otherwise address a link that is not there.
    ctx.own(
      data.tasks.subscribe(() => {
        const id = emphasis.selected();
        if (id === null) return;
        const entry =
          selectedSource === null ? undefined : data.query().linksByTask.get(selectedSource);
        if (entry !== undefined) {
          for (const link of entry.out) if (link.id === id) return;
        }
        emphasis.setSelected(null);
        repaintSelection();
      }),
    );
  }

  /* --- hover and dependency-path emphasis (§5.5) ------------------------ */

  if (options.highlightPaths) {
    ctx.on("pointer/barHover", (e) => {
      const next = e.hit?.kind === "link" ? (e.hit.id as LinkId) : null;
      if (emphasis.setHover(next)) viewService()?.invalidate("main");
    });
    // §14 — same late-resolution rule as the §5.4 subscription above.
    ctx.on("lifecycle/ready", () => {
      const selection = selectionService();
      if (selection === undefined) return;
      ctx.own(
        selection.state.subscribe((next) => {
          if (emphasis.setPath(pathLinkIds(data.query(), next.taskIds))) {
            viewService()?.invalidate("main");
          }
        }),
      );
    });
    // A data change can rewrite the link table under the hover and under the selected tasks' path
    // alike: drop the hover, and recompute the path from the current selection — re-read lazily,
    // so an added or removed link updates the emphasis without a selection gesture.
    ctx.own(
      data.tasks.subscribe(() => {
        let dirty = emphasis.setHover(null);
        const seeds = selectionService()?.state.get().taskIds;
        const path =
          seeds === undefined || seeds.size === 0
            ? new Set<LinkId>()
            : pathLinkIds(data.query(), seeds);
        if (emphasis.setPath(path)) dirty = true;
        if (dirty) viewService()?.invalidate("main");
      }),
    );
  }

  /* --- the dependency inspector (§5.7) ---------------------------------- */

  if (options.inspector) {
    ctx.contribute(
      "sidepanel/fields",
      makeInspectorContribution({
        messages,
        data,
        removeLink: (link) => {
          ctx.dispatch("link/remove", { ids: [link.id] });
          announce(messages.linkRemoved);
        },
        // §5.7 — retype/re-lag is one `link/update` command, so the edit is one transaction and
        // one undo step. `lag: 0` is the store's spelling of "no lag", which is what an emptied or
        // zeroed lag field means here.
        updateLink: (link, type: LinkType, lag: number | undefined) => {
          ctx.dispatch("link/update", { id: link.id, type, lag: lag ?? 0 });
          announce(messages.linkUpdated);
        },
        listen: (target, type, fn) => {
          listen(ctx, target, type, fn as (e: never) => void);
        },
      }),
    );
  }

  /* --- repaint wiring (§5.8) -------------------------------------------- */

  // The `data/tasksChanged` / `rows/changed` / `timeline/zoomChanged` edges: the three things
  // that can move a line. `invalidate` is rAF-batched by the view, so these handlers stay cheap;
  // re-resolving `stargantt.view` per call (§14) costs a map lookup, not a repaint.
  const invalidateBoth = (): void => {
    routes.invalidate();
    const view = viewService();
    view?.invalidate("main");
    view?.invalidate("overlay");
  };
  // The data store publishes `tasks` on every transaction, link-only ones included (its
  // `publishChanges` sets it unconditionally), so this one subscription covers link add / update /
  // remove as well — which is why §5.8 names three edges and not four. `data` is a hard dependency
  // (never optional), so this subscription is safe to register at setup.
  ctx.own(data.tasks.subscribe(invalidateBoth));
  // §14 — `rows` (tree-grid) and `timeline` (view) are both late-optional: deferred to
  // `lifecycle/ready` so a real, tiered composition still wires these two repaint edges.
  ctx.on("lifecycle/ready", () => {
    const rowsForRepaint = rowsService();
    if (rowsForRepaint !== undefined) ctx.own(rowsForRepaint.rows.subscribe(invalidateBoth));
    const timeline = timelineService();
    if (timeline !== undefined) ctx.own(timeline.zoomLevel.subscribe(invalidateBoth));
  });
}
