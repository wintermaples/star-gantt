/**
 * The panes module of `stargantt.view`.
 *
 * Owns the generic side-pane mechanism of the root flex row: defines the `view/panes` extension
 * point (collect), creates one pane element per contribution, places left-side panes before the
 * render module's chart pane and right-side panes after it, and owns every pane divider together
 * with its pointer-drag and keyboard resize behavior — clamped so the chart pane is never squeezed
 * below its own minimum width. The chart pane itself stays render-owned and is not a contribution.
 *
 * Also owns the root's vertical composition: the panes' flex row is wrapped in `.sg-pane-row`,
 * and the `view/bottomPanes` extension point (collect) places full-width strips in a bottom
 * region stacked below it, each strip a flex row of gutter / body / trailing columns whose widths
 * this module keeps aligned with the left panes, the chart pane and the right panes above.
 */
// docs/specs/plugins/view.md
import { collect, createStore } from "@stargantt/core";
import type { PluginContext, Store, WritableStore } from "@stargantt/core";
// docs/specs/plugins/view.md — the shared DOM-listener helper.
import { listen } from "@stargantt/sdk";
import { PLUGIN_ID } from "../plugin-id";
import type { PanesConfig } from "../../config";
import type { RenderModule } from "../render/index";
// docs/specs/plugins/view.md — "View modes" — hostless layout planning; the
// DOM writes stay in this file's wiring.
import { layoutFor, parseViewMode } from "./view-mode";
import type { ViewMode } from "./view-mode";
// docs/specs/plugins/view.md — "Bottom region" — the bottom
// region's DOM wiring lives in its own module; this file only measures, triggers and forwards.
import { mountBottomRegion } from "./bottom-region";
import type { BottomRegion } from "./bottom-region";
import type { BottomPaneContribution } from "./bottom-panes";
// One shared drag owner arbitrates the vertical and horizontal divider gestures
// (`.claude/skills/gantt-ui-ux/references/code-quality.md` §2 — single owner, not two machines).
import { createDragOwner, type DragOwner } from "./drag-owner";
import { armPaneDivider, createPaneDivider } from "./divider";
import type { PaneState } from "./divider";

export type { ViewMode } from "./view-mode";
export type { BottomPaneContribution, BottomPaneElements } from "./bottom-panes";

/**
 * One side pane of the root's flex row, contributed to the `view/panes` extension point.
 * The chart pane is renderer-owned and is not contributed here.
 */
export interface PaneContribution {
  /** Unique among contributions; duplicates keep the first and are reported via `core/pluginError`. */
  id: string;
  /** Which side of the chart pane the pane sits on. */
  side: "left" | "right";
  /** Sort key within a side, ascending; ties resolve by registration order. */
  order: number;
  /** Initial width in CSS px. */
  initialWidth: number;
  /** Lower clamp for drag-resize, CSS px. Omitted = 0. */
  minWidth?: number;
  /** Upper clamp for drag-resize, CSS px. Omitted = unbounded. */
  maxWidth?: number;
  /**
   * Omitted = false. `true` lets the user collapse the pane to zero visible width and expand it
   * again by clicking the pane's divider boundary; the same state can be driven programmatically
   * with the `view/paneToggle` command.
   */
  collapsible?: boolean;
  /**
   * Omitted = true. `false` renders no divider for this pane at all — no separator element and
   * no drag-resize.
   */
  resizable?: boolean;
  /**
   * Optional. Called with the pane's new width in CSS px after each resize step of this pane's
   * divider — pointer drag or keyboard — so width-dependent content can re-render without its own
   * ResizeObserver. The reported width is the width the pane actually gets: it is clamped to
   * `[minWidth, maxWidth]` and additionally bounded so the chart pane is never squeezed below its
   * own minimum width. Not called for the initial width, and not called when the pane collapses or
   * expands — its remembered width does not change on those transitions. Additionally called, with
   * the width the pane now occupies, when a view-mode switch (`view/setViewMode`) changes that
   * width — i.e. when this pane gains or loses the table-view grow; the remembered width is
   * untouched there too. Finally, it is called with the width the pane occupies after a bottom
   * strip's height changes: that resize moves this pane's rendered height without moving its
   * width, and this callback is how a contributor that tracks only width learns that its box
   * changed.
   */
  onResize?(width: number): void;
  /**
   * Optional. The accessible name of this pane's divider (its `role="separator"` element).
   * Localization is the contributor's or host's concern; when omitted the divider is named
   * "Resize pane".
   */
  label?: string;
  /**
   * Called exactly once, after every plugin's setup() has completed, with the pane's content
   * element. The contributor renders into `el` and registers its own listeners/observers via its
   * `ctx.own()`; the pane element itself is created and disposed by `stargantt.panes`.
   */
  mount(el: HTMLElement): void;
}

/** The panes module's handle: the view mode, published as a store. */
export interface PanesModule {
  /**
   * The mode the pane row is in.
   *
   * Set exactly when a `view/setViewMode` dispatch — or the `initialViewMode` option, applied once
   * the panes are mounted — actually changes it; never for a switch to the mode already in effect,
   * and never for one this composition cannot honour.
   */
  readonly viewMode: Store<ViewMode>;
}

/** Creates the panes module. */
export function createPanesModule(
  ctx: PluginContext,
  config: PanesConfig,
  render: RenderModule,
): PanesModule {
  // docs/specs/plugins/view.md — the mode currently applied to the DOM, published for subscribers.
  const viewModeStore: WritableStore<ViewMode> = createStore<ViewMode>("split");
  const point = ctx.defineExtensionPoint("view/panes", collect<PaneContribution>());
  // docs/specs/plugins/view.md — the bottom region's contribution
  // surface, collected — like `view/panes` — on `lifecycle/ready`.
  const bottomPoint = ctx.defineExtensionPoint("view/bottomPanes", collect<BottomPaneContribution>());

  // docs/specs/architecture.md —:
  // contributed values are handled by the point-owning plugin, which guards them and reports
  // faults via `core/pluginError` instead of letting one bad contribution break the layout.
  const fault = (error: unknown): void => {
    ctx.emit("core/pluginError", { pluginId: PLUGIN_ID, error: { point: "view/panes", cause: error } });
  };
  // The same barrier for the bottom region's foreign code, tagged with its own point.
  const bottomFault = (error: unknown): void => {
    ctx.emit("core/pluginError", {
      pluginId: PLUGIN_ID,
      error: { point: "view/bottomPanes", cause: error },
    });
  };

  // docs/specs/plugins/view.md — keyed by contribution id so the
  // `view/paneToggle` command handler — registered below, independent of `lifecycle/ready` — can
  // reach a mounted pane's state. Populated as panes are mounted; a dispatch that names an id not
  // (yet) mounted is indistinguishable from an unknown id and is a no-op, per contract.
  const panesById = new Map<string, PaneState>();

  // docs/specs/plugins/view.md — "View modes": mounted panes in mount order
  // (left outermost→innermost, then right innermost→outermost) — the shape `layoutFor` plans over.
  const mountedPanes: { side: "left" | "right"; state: PaneState }[] = [];
  /** The mode currently applied to the DOM. `"split"` is the do-nothing default. */
  let currentMode: ViewMode = "split";
  /**
   * Mode requested before `lifecycle/ready` mounted the panes: seeded from the config option
   * (an unusable value silently parses to `null`, per the factory convention) and overwritten by
   * any pre-ready `view/setViewMode` dispatch — the later intent wins. Applied once at ready.
   */
  let pendingMode: ViewMode | null = parseViewMode(config.initialViewMode);
  /** Assigned on `lifecycle/ready`; `null` marks "not mounted yet", replacing a boolean flag. */
  let applyModeNow: ((mode: ViewMode) => void) | null = null;
  /**
   * The `view/setBottomPaneHeight` implementation, wired through `mountBottomRegion`'s `connect`
   * hook on `lifecycle/ready` — before any bottom contribution's `mount` runs, so a mount that
   * dispatches the command already hits the real implementation. While `null` — before ready, or
   * in a composition with no usable `view/bottomPanes` contribution — a dispatch targets no
   * mounted pane and is the unknown-id no-op.
   */
  let setBottomHeightNow: ((id: string, height: number) => void) | null = null;
  /**
   * Rewrites the bottom panes' column widths (docs/specs/plugins/view.md "Bottom-pane columns");
   * a no-op until the region is wired — through the same `connect` hook, before any bottom
   * contribution's `mount` runs — and forever in a composition without one. Called from every
   * trigger that changes a side pane's occupied width: a divider resize step, a collapse/expand,
   * and a view-mode switch.
   */
  let refreshBottomColumns: () => void = () => {};


  // The parse stays local rather than adopting the `@stargantt/sdk` `parsePx` helper
  // (docs/specs/plugins/view.md): that helper rejects zero and negative lengths,
  // while this call site accepts **any** finite value — a `--sg-chart-min-width: 0` is a legitimate
  // host choice meaning "no chart floor", and it must clamp at 0 rather than silently fall back to
  // the built-in default. the `parsePx` deliberately does not cover this call site.
  /**
   * Reads `--sg-chart-min-width` off `ctx.root`'s computed style, in CSS px. `null` when there is
   * no `getComputedStyle` (SSR, a test double) or the value doesn't parse.
   */
  function readChartMinWidth(): number | null {
    if (typeof globalThis.getComputedStyle !== "function") return null;
    const raw = globalThis
      .getComputedStyle(ctx.root)
      .getPropertyValue("--sg-chart-min-width")
      .trim();
    const value = parseFloat(raw);
    return Number.isFinite(value) ? value : null;
  }

  /**
   * The pane's width as this plugin knows it, in CSS px: `state.width` while expanded and 0 while
   * collapsed (a collapsed pane's remembered width is not the width it occupies). This — not a
   * `getBoundingClientRect()` measurement — is the single source of truth for a pane's width, so
   * the pointer drag, the keyboard steps and the resize clamp can never read different numbers for
   * the same pane (`.claude/skills/gantt-ui-ux/references/code-quality.md` §8).
   */
  function paneWidth(state: PaneState): number {
    return state.collapsed ? 0 : state.width;
  }

  /**
   * A pane's effective resize clamp (docs/specs/plugins/view.md): `[minWidth, maxWidth]` bounded above by
   * the width at which the chart pane would be squeezed below its own minimum — the room left is
   * the pane's and the chart pane's combined current width minus that minimum, since the chart
   * pane (the sole flex-growing member) absorbs exactly what the pane gives up. Degrades to
   * `[minWidth, maxWidth]` alone when the chart pane's minimum can't be determined (retires
   * the former "no chart pane" arm: the renderer is a hard dependency and always answers).
   */
  function clampBounds(state: PaneState): { min: number; max: number } {
    let max = state.max;
    const floor = readChartMinWidth();
    if (floor !== null) {
      // The chart pane has no plugin-side width state — it is the flex-growing member — so its
      // current width is measured; the pane's own side of the sum comes from `paneWidth`.
      const room = paneWidth(state) + render.chartPaneElement().getBoundingClientRect().width - floor;
      max = Math.min(max, room);
    }
    // Never invert the clamp: under heavy container pressure `room` can fall below the pane's own
    // `minWidth`, and an inverted `[min, max]` would let a resize step push the pane below
    // `minWidth` and write `aria-valuemin > aria-valuemax`. The pane stops at `minWidth` and the
    // fully-squeezed case is the root-clipping arm of docs/specs/plugins/view.md, mirroring
    // `bottomResizeBounds`' floor protection.
    return { min: state.min, max: Math.max(state.min, max) };
  }

  /**
   * Keeps a divider's `aria-value*` triad in sync with its pane's current clamp and width.
   * A no-op for a pane with no divider (`resizable: false`). A collapsed pane's rendered width is
   * 0 (docs/specs/plugins/view.md), below its ordinary `minWidth` floor — reporting `state.width` (the
   * remembered pre-collapse width) here would leave `aria-valuenow` describing a width the pane
   * no longer has, so both the reported value and `aria-valuemin` drop to 0 while collapsed,
   * keeping the triad internally consistent (`aria-valuemin` \<= `aria-valuenow` \<= `aria-valuemax`).
   */
  function updateAria(state: PaneState): void {
    const divider = state.divider;
    if (divider === undefined) return;
    const { min, max } = clampBounds(state);
    divider.setAttribute("aria-valuemin", String(state.collapsed ? 0 : min));
    if (Number.isFinite(max)) divider.setAttribute("aria-valuemax", String(max));
    else divider.removeAttribute("aria-valuemax");
    divider.setAttribute("aria-valuenow", String(state.collapsed ? 0 : state.width));
  }

  /**
   * Applies one resize step — pointer or keyboard — to `width`, already clamped by the caller:
   * updates the pane's rendered width and remembered width, clears a stale `collapsed` flag
   * (docs/specs/plugins/view.md), refreshes the divider's `aria-value*` attributes, and fires the guarded
   * `onResize` callback.
   */
  function applyWidth(state: PaneState, width: number): void {
    // Guards against a truly unbounded clamp (no `maxWidth`, no determinable chart floor): rather
    // than writing a non-finite CSS length, a resize step that would jump to it is a no-op.
    if (!Number.isFinite(width)) return;
    state.width = width;
    state.el.style.width = `${width}px`;
    if (state.collapsed) {
      state.collapsed = false;
      // `setCollapsed(true)` zeroed the pane's CSS `min-width` so it could reach 0 px;
      // a resize step that un-collapses (dragging a collapsed pane's divider outward) must
      // restore it, or the pane loses its shrink-under-container-pressure floor for good.
      state.el.style.minWidth = `${state.min}px`;
    }
    updateAria(state);
    // A resize step moved this pane's occupied width, so the bottom panes' columns track it
    // (docs/specs/plugins/view.md — "Bottom-pane columns").
    refreshBottomColumns();
    if (state.onResize !== undefined) {
      try {
        state.onResize(width);
      } catch (error) {
        fault(error);
      }
    }
  }

  /**
   * Collapses or expands one pane. A no-op if the target state already holds or the pane is not
   * `collapsible`. Never touches `onResize` — collapsing/expanding does not change the pane's
   * remembered width (docs/specs/plugins/view.md). Also zeroes/restores the pane's `min-width` so a
   * collapsed pane can reach 0 px despite the CSS floor that keeps shrink and drag sharing one
   * floor while expanded.
   */
  function setCollapsed(state: PaneState, target: boolean): void {
    if (!state.collapsible || state.collapsed === target) return;
    if (target) {
      state.el.style.minWidth = "0px";
      state.el.style.width = "0px";
    } else {
      state.el.style.minWidth = `${state.min}px`;
      state.el.style.width = `${state.width}px`;
    }
    state.collapsed = target;
    updateAria(state);
    // A collapsed/expanded pane changes the width its side occupies, so the bottom panes'
    // columns track it (docs/specs/plugins/view.md).
    refreshBottomColumns();
  }

  // docs/specs/plugins/view.md — declared in the plugin's `Commands` augmentation and registered
  // here, at setup time. Participates in no transaction: it is view state, not model state.
  ctx.registerCommand("view/paneToggle", (payload) => {
    const state = panesById.get(payload.id);
    if (state === undefined) return;
    const target = payload.collapsed === undefined ? !state.collapsed : payload.collapsed;
    setCollapsed(state, target);
  });

  // docs/specs/plugins/view.md — "View modes": registered at setup time like
  // `view/paneToggle`; a dispatch before `lifecycle/ready` is deferred and applied once the panes
  // are mounted. View state only — participates in no transaction, not undoable.
  ctx.registerCommand("view/setViewMode", (payload) => {
    const target = parseViewMode((payload as { mode?: unknown } | null | undefined)?.mode);
    if (target === null) return;
    if (applyModeNow === null) pendingMode = target;
    else applyModeNow(target);
  });

  // docs/specs/plugins/view.md — "Bottom-pane height ownership":
  // registered at setup time like the other view commands; clamping and application live with
  // the mounted region. View state only — participates in no transaction, not undoable. An
  // unknown id or an unusable (non-string id / non-finite height) payload is a no-op.
  ctx.registerCommand("view/setBottomPaneHeight", (payload) => {
    const p = payload as { id?: unknown; height?: unknown } | null | undefined;
    if (p === null || p === undefined) return;
    if (typeof p.id !== "string" || typeof p.height !== "number") return;
    setBottomHeightNow?.(p.id, p.height);
  });

  /**
   * The single owner of every divider drag — vertical (side panes) and horizontal (bottom
   * panes): a `pointerdown` claims it, a second press while a drag runs is refused, and events
   * from any other pointer are ignored, so the two gesture machines can never fight over one
   * pointer (`.claude/skills/gantt-ui-ux/references/code-quality.md` §2).
   */
  const rawDragOwner = createDragOwner();

  // Escape cancels an in-progress divider drag with full revert (the claim's `cancel()` hook
  // restores the pre-drag width). The capture-phase document listener is armed only while a claim
  // is active, so an idle chart adds no document-level keydown listener and the key keeps its
  // ordinary meaning otherwise.
  const onEscapeKeydown = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    if (dragOwner.abort()) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  let escapeArmedOn: Document | null = null;
  let claimedPointerId: number | null = null;
  function disarmEscape(): void {
    escapeArmedOn?.removeEventListener("keydown", onEscapeKeydown as EventListener, {
      capture: true,
    });
    escapeArmedOn = null;
  }
  ctx.own({ dispose: disarmEscape });
  const dragOwner: DragOwner = {
    claim(c) {
      const claimed = rawDragOwner.claim(c);
      if (claimed) {
        claimedPointerId = c.pointerId;
        if (escapeArmedOn === null) {
          const doc = ctx.root.ownerDocument;
          doc.addEventListener("keydown", onEscapeKeydown as EventListener, { capture: true });
          escapeArmedOn = doc;
        }
      }
      return claimed;
    },
    move: (e) => rawDragOwner.move(e),
    up(e) {
      rawDragOwner.up(e);
      // Events from a non-claiming pointer are ignored by the owner and must not disarm.
      if (e.pointerId === claimedPointerId) {
        claimedPointerId = null;
        disarmEscape();
      }
    },
    cancel(e) {
      rawDragOwner.cancel(e);
      if (e.pointerId === claimedPointerId) {
        claimedPointerId = null;
        disarmEscape();
      }
    },
    abort() {
      const aborted = rawDragOwner.abort();
      if (aborted) {
        claimedPointerId = null;
        disarmEscape();
      }
      return aborted;
    },
  };
  let docListenersInstalled = false;

  function installDocListeners(doc: Document): void {
    if (docListenersInstalled) return;
    docListenersInstalled = true;
    // The pointer may leave the document (released over an iframe, drag cancelled by the UA):
    // `pointerup` ends the claim through its `up()` hook — where a sub-threshold press is
    // classified as a click — and `pointercancel` drops it silently, so a divider never sticks
    // to the pointer.
    listen(ctx, doc, "pointermove", (e: PointerEvent) => dragOwner.move(e));
    listen(ctx, doc, "pointerup", (e: PointerEvent) => dragOwner.up(e));
    listen(ctx, doc, "pointercancel", (e: PointerEvent) => dragOwner.cancel(e));
  }

  /**
   * docs/specs/plugins/view.md — Placement: collection, placement and
   * mount() happen on `lifecycle/ready`, not during this plugin's own setup(). Contributors
   * declare `stargantt.panes` in `dependsOn` and therefore set up *after* this plugin — a
   * setup-time read of `view/panes` would see an empty point.
   */
  ctx.on("lifecycle/ready", () => {
    const raw = point.get() ?? [];

    // Duplicate ids keep the first contribution; later ones are reported and dropped.
    const seen = new Set<string>();
    const unique: PaneContribution[] = [];
    for (const c of raw) {
      if (seen.has(c.id)) {
        fault(new Error(`duplicate view/panes contribution id "${c.id}"`));
        continue;
      }
      seen.add(c.id);
      unique.push(c);
    }

    // Sort key: side, then `order` ascending, then registration order (collect preserves it).
    const indexed = unique.map((c, i) => ({ c, i }));
    indexed.sort(
      (a, b) =>
        (a.c.side === b.c.side ? 0 : a.c.side === "left" ? -1 : 1) ||
        a.c.order - b.c.order ||
        a.i - b.i,
    );

    const doc = ctx.root.ownerDocument;
    // docs/specs/plugins/view.md — the render module created its chart pane before this module
    // existed, so the accessor answers here and the placement references below are exact.
    const chart = render.chartPaneElement();

    // docs/specs/plugins/view.md — "Root layout and the pane row":
    // before any side pane mounts, the horizontal composition is wrapped in `.sg-pane-row`, a
    // direct child of the root, and the renderer-owned chart pane moves into it — the root
    // thereby becomes a vertical stack with the bottom region under the row. The chart pane is
    // foreign DOM: it is moved, never disposed, and the disposer returns it to `ctx.root` at the
    // row's own position before removing the row, so the renderer gets its element back exactly
    // as found. This disposer is registered before the per-pane ones and disposal is
    // last-in-first-out, so it runs after every pane and divider has already left the row.

    // The move is only sound while the chart pane is a **direct child** of the root: both
    // `ctx.root.insertBefore(paneRow, chart)` here and the dispose-time
    // `ctx.root.insertBefore(chart, paneRow)` restore use `chart` as an insertion reference,
    // which a real DOM accepts only for a direct child (`NotFoundError` otherwise) — a mere
    // descendant (a renderer wrapping its pane one level deep) would throw here and be "restored"
    // to the wrong parent on dispose, breaking the "returned exactly as found". A renderer
    // answering with the root itself would additionally be asked to become its own descendant,
    // a cyclic tree that hangs the first walk of it rather than throwing. The accessor is foreign
    // code, so any other shape (the root, a wrapped grandchild, a detached element) is refused
    // and reported through the fault barrier; the row is appended empty and the mount loops below
    // use a `null` insertion reference instead of the absent chart pane.
    const paneRow = doc.createElement("div");
    paneRow.className = "sg-pane-row";
    const chartIsRootChild = chart !== ctx.root && chart.parentElement === ctx.root;
    if (!chartIsRootChild) {
      fault(
        new Error(
          "stargantt.renderer's chartPaneElement() must be a direct child of the chart root; " +
            "the pane row was created empty and the chart pane was left where it is.",
        ),
      );
      ctx.root.appendChild(paneRow);
    } else {
      ctx.root.insertBefore(paneRow, chart);
      paneRow.appendChild(chart);
    }
    ctx.own({
      dispose: () => {
        if (chartIsRootChild) ctx.root.insertBefore(chart, paneRow);
        paneRow.remove();
      },
    });

    const lefts = indexed.filter((x) => x.c.side === "left").map((x) => x.c);
    const rights = indexed.filter((x) => x.c.side === "right").map((x) => x.c);

    /** Inserts one pane (and, unless `resizable: false`, its divider) before `ref`. */
    function mountPane(c: PaneContribution, ref: Node | null): void {
      const pane = doc.createElement("div");
      pane.className = "sg-pane";

      const state: PaneState = {
        el: pane,
        min: c.minWidth ?? 0,
        max: c.maxWidth ?? Infinity,
        collapsible: c.collapsible === true,
        collapsed: false,
        width: c.initialWidth,
        onResize: typeof c.onResize === "function" ? c.onResize.bind(c) : undefined,
        divider: undefined,
      };
      pane.style.width = `${c.initialWidth}px`;
      // the pane's own floor shares the divider clamp's lower bound (`state.min`), so CSS
      // shrink-under-pressure and the JS drag/keyboard clamp cannot diverge; `setCollapsed` zeroes
      // this so a collapsible pane can still reach 0 px.
      pane.style.minWidth = `${state.min}px`;
      // First mounted contribution with a given id wins the id→state mapping too, mirroring the
      // duplicate-id handling above (the duplicate never reaches `mountPane`).
      panesById.set(c.id, state);
      ctx.own({ dispose: () => panesById.delete(c.id) });
      // Mount order is the planning order for view modes (docs/specs/plugins/view.md "View modes").
      mountedPanes.push({ side: c.side, state });

      const divider = createPaneDivider({
        doc,
        state,
        side: c.side,
        resizable: c.resizable !== false,
        label: c.label,
      });

      // A divider sits between the pane and its inward (chart-side) neighbor: after a left pane,
      // before a right pane. Since the panes and dividers live inside the pane row, not
      // directly under the root.
      if (c.side === "left") {
        paneRow.insertBefore(pane, ref);
        if (divider !== null) paneRow.insertBefore(divider, ref);
      } else {
        if (divider !== null) paneRow.insertBefore(divider, ref);
        paneRow.insertBefore(pane, ref);
      }
      ctx.own({ dispose: () => pane.remove() });
      if (divider !== null) ctx.own({ dispose: () => divider.remove() });
      updateAria(state);

      if (divider !== null) {
        installDocListeners(doc);
        armPaneDivider({
          ctx,
          divider,
          state,
          side: c.side,
          dragOwner,
          clampBounds,
          applyWidth,
          setCollapsed,
          paneWidth,
        });
      }

      // Called exactly once, guarded (docs/specs/architecture.md §1.4 fault barrier).
      try {
        c.mount(pane);
      } catch (error) {
        fault(error);
      }
    }

    // Left panes go before the chart pane (leftmost = lowest order). When the guard above
    // refused to wrap the chart pane, it is not a child of the row and cannot serve as an
    // insertion reference (a real DOM's `insertBefore` throws `NotFoundError` for a reference
    // that is not a child) — a `null` reference appends the panes in contributed order instead.
    for (const c of lefts) mountPane(c, chartIsRootChild ? chart : null);

    // Right panes go after the chart pane (lowest order innermost).
    const rightRef: Node | null = chartIsRootChild ? chart.nextSibling : null;
    for (const c of rights) mountPane(c, rightRef);

    // ---- View modes (docs/specs/plugins/view.md — "View modes") ----

    // The chart pane belongs to the render module: the only inline style written on it here is
    // `display`, restored on dispose so the element goes back exactly as it was found.
    ctx.own({
      dispose: () => {
        chart.style.display = "";
      },
    });

    // Anchors that `reanchorFocus` made programmatically focusable by writing a `tabindex="-1"`
    // attribute they did not have before; the attribute is removed again on dispose.
    const anchorsGivenTabindex = new Set<HTMLElement>();
    ctx.own({
      dispose: () => {
        for (const el of anchorsGivenTabindex) el.removeAttribute("tabindex");
        anchorsGivenTabindex.clear();
      },
    });

    /**
     * Calls a pane's `onResize` with the width it now occupies after a mode switch changed it,
     * guarded like every other contributor callback. Never touches `state.width`: a mode switch
     * is not a resize step and the pane's remembered width must survive it.
     */
    function notifyOccupiedWidth(state: PaneState, width: number): void {
      if (state.onResize === undefined) return;
      try {
        state.onResize(width);
      } catch (error) {
        fault(error);
      }
    }

    /** Index of the pane currently holding the grid-mode `flex: 1 1 auto` grow, `-1` for none. */
    let growIndex = -1;

    /** The mounted bottom region, assigned below; `null` without a usable contribution. */
    let region: BottomRegion | null = null;

    /**
     * Measures the widths the bottom panes' three columns must mirror
     * (docs/specs/plugins/view.md — "Bottom-pane columns"): the gutter
     * is the combined outer width of every left pane and its divider currently occupying the row
     * a mode-hidden or collapsed one counts as 0 — the body is the chart pane's width, and the
     * trailing column is the right-side equivalent. Widths come from the live layout: the side
     * panes are shrinkable flex items and the chart pane is the flex-growing member, so under
     * container pressure a rect is the only source that matches what the reader actually sees.
     * Only called on resize-shaped triggers (a divider step, a toggle, a mode switch, a row
     * resize), never per frame.
     */
    function measureColumns(): { gutter: number; body: number; trailing: number } {
      let gutter = 0;
      let trailing = 0;
      for (const p of mountedPanes) {
        const el = p.state.el;
        const paneW =
          el.style.display === "none" || p.state.collapsed ? 0 : el.getBoundingClientRect().width;
        const divider = p.state.divider;
        const dividerW =
          divider === undefined || divider.style.display === "none"
            ? 0
            : divider.getBoundingClientRect().width;
        if (p.side === "left") gutter += paneW + dividerW;
        else trailing += paneW + dividerW;
      }
      const body = chart.style.display === "none" ? 0 : chart.getBoundingClientRect().width;
      return { gutter, body, trailing };
    }

    /**
     * docs/specs/plugins/view.md — an applied bottom-pane height changes every side pane's
     * rendered height without touching its width, and `PaneContribution.onResize` is width-only,
     * so each mounted side pane's callback is re-invoked (guarded, the mode-switch precedent)
     * with the width it currently occupies: 0 while a view mode hides it, the laid-out width
     * while it holds the grid-mode grow, this module's own width state otherwise.
     */
    function notifySidePanesOfBottomResize(): void {
      mountedPanes.forEach((p, i) => {
        const st = p.state;
        if (st.onResize === undefined) return;
        const width =
          st.el.style.display === "none"
            ? 0
            : i === growIndex
              ? st.el.getBoundingClientRect().width
              : paneWidth(st);
        notifyOccupiedWidth(st, width);
      });
    }

    /**
     * docs/specs/plugins/view.md— "View modes": when
     * `document.activeElement` sits inside an element `applyMode` is about to hide (the chart pane,
     * a pane, or a divider — `dividersHidden` can hide a divider whose own pane stays visible),
     * focus moves to `anchor` before any `display` write, so a keyboard user's focus never falls
     * through to `<body>`. `anchor` is made programmatically reachable with `tabindex="-1"` the
     * first time it is used as one — invisible to the regular tab order, exactly like the
     * container-focus pattern client-side routers use on navigation.
     */
    function reanchorFocus(hiding: readonly HTMLElement[], anchor: HTMLElement): void {
      const active = doc.activeElement;
      if (active === null) return;
      if (!hiding.some((el) => el.contains(active))) return;
      // A negative `tabIndex` with no `tabindex` attribute (the default for a plain `<div>`)
      // means "not already an explicit tab stop" — only that case needs the `-1` reflected onto
      // the attribute so `.focus()` can reach it; an anchor some other plugin already gave a
      // `tabindex` (tabbable or not) is left exactly as it is. Writes are recorded so dispose can
      // remove the attribute again — the chart pane belongs to the renderer.
      if (anchor.tabIndex < 0 && !anchor.hasAttribute("tabindex")) {
        anchor.setAttribute("tabindex", "-1");
        anchorsGivenTabindex.add(anchor);
      }
      anchor.focus({ preventScroll: true });
    }

    function applyMode(target: ViewMode): void {
      if (target === currentMode) return;
      const layout = layoutFor(target, mountedPanes);
      // `null` = inapplicable to this composition ("grid" with no left pane): ignore, keep mode.
      if (layout === null) return;

      // gather every element this switch is about to hide, and the still-visible anchor —
      // the chart pane when it stays visible, otherwise the pane taking the grow (layoutFor
      // guarantees `growIndex >= 0` whenever `chartHidden` is true) — before mutating any style.
      const hiding: HTMLElement[] = [];
      if (layout.chartHidden) {
        hiding.push(chart);
        // docs/specs/plugins/view.md — the bottom region
        // follows the chart pane's visibility, and its horizontal dividers and everything a
        // bottom pane mounted are focusable — so a switch that hides the chart is about to hide
        // the region too, and the region joins the guard on the same terms as a side pane.
        if (region !== null) hiding.push(region.element);
      }
      mountedPanes.forEach((p, i) => {
        const paneHidden = layout.paneHidden[i] === true;
        if (paneHidden) hiding.push(p.state.el);
        if (p.state.divider !== undefined && (paneHidden || layout.dividersHidden)) {
          hiding.push(p.state.divider);
        }
      });
      const anchor = layout.chartHidden ? mountedPanes[layout.growIndex]!.state.el : chart;
      reanchorFocus(hiding, anchor);

      chart.style.display = layout.chartHidden ? "none" : "";
      mountedPanes.forEach((p, i) => {
        const hidden = layout.paneHidden[i] === true;
        p.state.el.style.display = hidden ? "none" : "";
        p.state.el.style.flex = i === layout.growIndex ? "1 1 auto" : "";
        if (p.state.divider !== undefined) {
          p.state.divider.style.display = hidden || layout.dividersHidden ? "none" : "";
        }
      });
      // The bottom region follows the chart pane's visibility: hidden in every mode
      // where the chart pane is hidden, visible in the others.
      region?.setHidden(layout.chartHidden);
      currentMode = target;
      // The pane whose occupied width the switch changed learns its new width: the pane that just
      // took the grow reads its fluid, laid-out width; the pane that just lost it is back at its
      // remembered width (0 while collapsed).
      if (growIndex !== layout.growIndex && growIndex >= 0) {
        const prev = mountedPanes[growIndex]!.state;
        notifyOccupiedWidth(prev, paneWidth(prev));
      }
      if (layout.growIndex >= 0) {
        const grown = mountedPanes[layout.growIndex]!.state;
        notifyOccupiedWidth(grown, grown.el.getBoundingClientRect().width);
      }
      growIndex = layout.growIndex;
      // Column widths are rewritten before the store is set, so a subscriber reads settled
      // bottom-pane geometry.
      region?.writeColumns();
      viewModeStore.set(target);
    }

    // ---- Bottom region (docs/specs/plugins/view.md — "Bottom region") ----

    // collected on `lifecycle/ready` like `view/panes`, and mounted after the side panes.
    // With no usable contribution `mountBottomRegion` creates no element at all and returns
    // `null`, leaving the rendering identical to the pre-region output apart from the row.
    // `connect` hands the region back **before** any bottom contribution's `mount` runs, so the
    // command implementation and the column rewrite are live for a mount that dispatches
    // `view/setBottomPaneHeight` or `view/paneToggle`.
    region = mountBottomRegion({
      ctx,
      row: paneRow,
      contributions: bottomPoint.get() ?? [],
      fault: bottomFault,
      measureColumns,
      onHeightApplied: () => notifySidePanesOfBottomResize(),
      claimDrag: (claim) => dragOwner.claim(claim),
      installDocListeners: () => installDocListeners(doc),
      // The focus policy, reused for the hide: when a bottom pane is about to reach
      // `display: none` with focus inside it (a contributor driving a `resizable: false` strip
      // to 0, the empty-roster shape), focus moves to the chart pane — visible whenever
      // the region is — through the same reanchor, with the same `anchorsGivenTabindex`
      // bookkeeping, the view-mode switch uses.
      reanchorFocus: (hiding) => reanchorFocus(hiding, chart),
      connect: (mounted) => {
        setBottomHeightNow = (id, height) => mounted.setHeight(id, height);
        refreshBottomColumns = () => mounted.writeColumns();
      },
    });

    applyModeNow = applyMode;
    if (pendingMode !== null) applyMode(pendingMode);
  });

  return { viewMode: viewModeStore };
}
