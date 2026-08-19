// docs/specs/plugins/view.md
/**
 * `@stargantt/plugin-view` — plugin id `stargantt.view`.
 *
 * The chart surface: three layered canvases plus DOM overlays, a fully virtual scroll viewport,
 * the pane row and its bottom region, the theme token layer, the time axis and its header, and the
 * two background line passes (grid lines, today line).
 *
 * Six previously-separate plugins merged into one, so that what used to be ninety-odd cross-plugin
 * service reads are now ordinary internal calls. The published surface keeps the same shape: the
 * same types, the same extension points, the same commands and the same pointer event stream. The
 * one intended change is store-ization — the viewport, the view mode, the active zoom level and the theme
 * tokens are stores, and the three `…/changed` events they replace are gone.
 */
import { definePlugin } from "@stargantt/core";
import type { ExtensionPointDecl, Plugin, Store } from "@stargantt/core";
import { normalizeViewConfig } from "./config";
import type { ViewConfig } from "./config";
import { PLUGIN_ID } from "./internal/plugin-id";
import { setupView } from "./internal/wiring";
import type {
  CanvasLayer,
  ContentExtentContribution,
  DomOverlayContribution,
  HitResult,
  HitTester,
  InsetContribution,
  LayerContribution,
  RenderSurface,
  ResolvedInsets,
  RowGeometryProvider,
  Viewport,
} from "./internal/render/index";
import type { PaneContribution } from "./internal/panes/index";
import type { BottomPaneContribution } from "./internal/panes/bottom-panes";
import type { ViewMode } from "./internal/panes/view-mode";
import type { ThemeService } from "./internal/theme/index";
import type { TimelineService, ZoomLevel } from "./internal/timeline/index";

/* ------------------------------------------------------------------ *
 * Public types
 * ------------------------------------------------------------------ */

export type {
  CanvasLayer,
  ContentExtentContribution,
  DomOverlayContribution,
  HitResult,
  HitTester,
  InsetContribution,
  InsetRect,
  InvalidateRect,
  LayerContribution,
  ResolvedInsets,
  RowGeometryProvider,
  Viewport,
} from "./internal/render/index";
export type { PaneContribution } from "./internal/panes/index";
export type { BottomPaneContribution, BottomPaneElements } from "./internal/panes/bottom-panes";
export type { ViewMode } from "./internal/panes/view-mode";
export type {
  GridCell,
  HeaderCell,
  ScaleRow,
  ScaleUnit,
  TimelineService,
  ZoomLevel,
  ZoomLevelMetrics,
} from "./internal/timeline/index";
export type { ThemeService, ThemeTokens } from "./internal/theme/index";
export type {
  ColorScheme,
  SetPresetOptions,
  ThemeAuditEntry,
  ThemePreset,
} from "./internal/theme/types";
export type { PresetTokens } from "./internal/theme/presets";
export {
  BUILT_IN_PRESETS,
  HIGH_CONTRAST_DARK,
  HIGH_CONTRAST_LIGHT,
} from "./internal/theme/presets";
export { FORCED_COLOR_TOKENS } from "./internal/theme/forced-colors";
export {
  CANVAS_READ_TOKENS,
  NON_COLOR_CANVAS_TOKENS,
  RETIRED_TOKENS,
} from "./internal/theme/registry";
export type { StatusDateInput } from "./internal/today-line/status-date";
export type {
  GridLinesConfig,
  PanesConfig,
  ScrollConfig,
  ThemeConfig,
  TimelineConfig,
  TodayLineConfig,
  ViewConfig,
} from "./config";

/* ------------------------------------------------------------------ *
 * The view service
 * ------------------------------------------------------------------ */

// docs/specs/plugins/view.md
/**
 * The chart surface: invalidation, layout, text measurement, scrolling, and the two view stores.
 *
 * The `viewport()` accessor is the one exception: it is subsumed by the same-named store property.
 */
export interface ViewService extends RenderSurface {
  /**
   * The virtual viewport.
   *
   * Set on every scroll and on every size or inset change, in the same pass that composites, so a
   * subscriber observes the state the next paint is about to use. The value never carries
   * `detail` — that hint describes a paint pass, not the scroll state — and it is a snapshot:
   * treat it as immutable.
   *
   * A scroll is additionally announced as `view/scrolled`, and this plugin is the only emitter of
   * that event. Reacting to a viewport change by scrolling again must be deferred (a frame or a
   * microtask); writing back into the store from its own subscriber is refused by the core.
   */
  readonly viewport: Store<Readonly<Viewport>>;
  /**
   * The view mode the pane row is in — `"split"`, `"grid"` or `"gantt"`.
   *
   * Set exactly when a `view/setViewMode` dispatch, or the `panes.initialViewMode` option applied
   * once the panes are mounted, actually changes the mode; never for a switch to the mode already
   * in effect, and never for one this composition cannot honour (`"grid"` with no left pane).
   */
  readonly viewMode: Store<ViewMode>;
}

/* ------------------------------------------------------------------ *
 * Declaration merging
 * ------------------------------------------------------------------ */

declare module "@stargantt/core" {
  interface Services {
    "stargantt.view": ViewService;
    "stargantt.timeline": TimelineService;
    "stargantt.theme": ThemeService;
  }

  interface ExtensionPoints {
    /**
     * Canvas drawing passes. `zIndex` orders the contributions and selects the canvas each paints
     * into; `draw` receives that canvas's 2d context, already scaled to CSS pixels, together with
     * the current viewport. Each draw is fault-isolated and bracketed in `save`/`restore`; claim
     * the order with `ctx.claimOrder("renderer/layers", key, order)`.
     */
    "renderer/layers": ExtensionPointDecl<LayerContribution, LayerContribution[]>; // collect
    /**
     * Hit testers, consulted in registration order until one answers. A tester that throws counts
     * as "no hit" and the search falls through to the next.
     */
    "renderer/hitTest": ExtensionPointDecl<HitTester, HitTester>; // first
    /**
     * Horizontal strips reserved at the top and bottom edges of the chart pane for chrome drawn by
     * other plugins — a timeline header, a load histogram, a minimap. Contributions to one side are
     * stacked outermost-first by ascending `order` (ties by registration order), each is told the
     * rectangle it was given through its `placed` callback, and the side reserves the sum of their
     * sizes (0 when nothing contributes). The canvases and the DOM overlay sit inside the remaining
     * band and the viewport height excludes both.
     */
    "renderer/insets": ExtensionPointDecl<InsetContribution, ResolvedInsets>; // reduce
    /**
     * HTML placed inside the chart body and anchored in content coordinates. Each contribution gets
     * its own wrapper element, clipped to the chart viewport and kept aligned with the canvas layers
     * as the chart scrolls, so a contribution positions its children once per data change rather
     * than once per scroll. Wrappers are appended in contribution order and stack by document order;
     * there is no `zIndex` field.
     */
    "renderer/domOverlays": ExtensionPointDecl<DomOverlayContribution, DomOverlayContribution[]>; // collect
    /**
     * Content-size contributions that bound the scrollable range. They are reduced at clamp time —
     * per axis, the maximum of the finite values the contributions currently report — rather than
     * through the point's own reduction, because `measure()` must be re-invoked on every clamp
     * rather than cached; an axis with no finite contribution stays unbounded.
     */
    "renderer/contentExtent": ExtensionPointDecl<
      ContentExtentContribution,
      ContentExtentContribution[]
    >; // collect
    /**
     * Row geometry for the row-dependent background passes: the horizontal separators, the row
     * stripes and the hovered-row fill. The first registered provider wins and the rest are never
     * consulted; with no provider at all those passes silently draw nothing while the vertical
     * passes are unaffected. Repainting when the geometry moves is the contributor's job —
     * `ViewService.invalidate("background")`.
     */
    "renderer/rowGeometry": ExtensionPointDecl<
      RowGeometryProvider,
      RowGeometryProvider | undefined
    >; // first
    /** Side panes placed around the chart pane, mounted on `lifecycle/ready`. */
    "view/panes": ExtensionPointDecl<PaneContribution, PaneContribution[]>; // collect
    /** Full-width strips stacked below the pane row; each contribution is one strip. */
    "view/bottomPanes": ExtensionPointDecl<BottomPaneContribution, BottomPaneContribution[]>; // collect
    /**
     * Zoom levels added to the ladder. Purely additive: `timeline.zoomLevels` in the config
     * replaces only the built-in six, never what other plugins contribute here.
     */
    "timeline/zoomLevels": ExtensionPointDecl<ZoomLevel, ZoomLevel[]>; // collect
  }

  interface Commands {
    /**
     * Steps the timeline to the next finer zoom level — the registered level with the next
     * higher pixels-per-day density, the same ladder the Ctrl+wheel gesture climbs. A no-op at
     * the finest level. `anchorTime` (epoch milliseconds) keeps that instant under the same point
     * of the visible chart area across the change; omitted, the middle of that area stays put.
     */
    "timeline/zoomIn": { anchorTime?: number };
    /**
     * Steps the timeline to the next coarser zoom level — the registered level with the next
     * lower pixels-per-day density. A no-op at the coarsest level. `anchorTime` (epoch
     * milliseconds) keeps that instant under the same point of the visible chart area across the
     * change — as far as the chart's left edge allows, since nothing scrolls before the axis's
     * start; omitted, the middle of that area stays put.
     */
    "timeline/zoomOut": { anchorTime?: number };
    /**
     * Collapses or expands a collapsible pane. `id` is the pane contribution's id; `collapsed`
     * sets the state explicitly, and omitting it toggles the current state. Targeting an unknown
     * id, or a pane whose contribution did not opt into `collapsible: true`, is a no-op.
     */
    "view/paneToggle": { id: string; collapsed?: boolean };
    /**
     * Switches how the root row presents its panes: `"split"` (side panes and chart together —
     * the default), `"grid"` (table view: only the left-side panes are shown and the innermost of
     * them fills the freed width), or `"gantt"` (chart view: every contributed pane is hidden and
     * the chart fills the row). Pane content stays mounted across switches and every pane's
     * remembered width is untouched, so switching back restores the previous layout exactly.
     * A `mode` that is not one of the three literals is ignored, and `"grid"` is ignored when no
     * left-side pane exists. Not undoable — this is view state, not model state. If the currently
     * focused element sits inside something the switch hides, focus moves first to a still-visible
     * anchor (the chart pane, or the pane taking the grow) so it never falls through to `<body>`.
     */
    "view/setViewMode": { mode: ViewMode };
    /**
     * Sets a bottom pane's height. `id` is the `view/bottomPanes` contribution's id; `height` is
     * clamped to the pane's effective range before it is applied — on a resizable pane that range
     * never goes below 24 px, so the pane's divider cannot be resized away. An unknown id or an
     * unusable height is a no-op. Not undoable — view state only.
     */
    "view/setBottomPaneHeight": { id: string; height: number };
  }

  interface Events {
    /**
     * The chart body scrolled. Emitted from the one clamp path every scroll mutation goes through
     * — wheel input, `ViewService.scrollTo`, the scrollbar thumb drag, a re-clamp after the
     * content shrank — so this plugin is the only emitter, whoever asked for the scroll. The
     * `viewport` store is set in the same pass.
     */
    "view/scrolled": { scrollTop: number; scrollLeft: number };
    /**
     * Emitted when a pointer goes down on a shape the hit test recognized. The raw pointer event
     * is captured and re-emitted annotated with the hit result and the viewport-local coordinates.
     * Such a press also starts a gesture, whose movement and release arrive as `pointer/barMove`
     * and `pointer/barUp`.
     */
    "pointer/barDown": { hit: HitResult; x: number; y: number; event: PointerEvent };
    /**
     * Pointer movement during an active gesture — one started by a `pointer/barDown` (press on a
     * hit shape) or by a `pointer/background` (press on empty space). Emitted synchronously from
     * the raw pointer-move handler, never frame-batched, so the raw event's modifier-key state is
     * exact at delivery. `hit` is the initiating `pointer/barDown`'s hit, unchanged for the whole
     * gesture, and is absent throughout a background-initiated gesture; `x` / `y` track the current
     * pointer position in viewport-local CSS pixels.
     */
    "pointer/barMove": { hit?: HitResult; x: number; y: number; event: PointerEvent };
    /**
     * End of an active gesture — one started by a `pointer/barDown` or by a `pointer/background`:
     * the pointer was released or the capture was cancelled. Emitted synchronously, exactly once
     * per gesture, with the final pointer position. `hit` is the initiating hit, and is absent when
     * the gesture started on empty space.
     */
    "pointer/barUp": { hit?: HitResult; x: number; y: number; event: PointerEvent };
    /**
     * The hover target changed: the frame-rate hit resolution produced a different result than the
     * previous frame. `hit` is the newly resolved target, or absent when the pointer moved off
     * every hit shape. Resolved once per animation frame at most, on the latest recorded pointer
     * position, so it carries no raw event and trails the pointer by up to one frame. No hover is
     * resolved while a gesture is active.
     */
    "pointer/barHover": { hit?: HitResult; x: number; y: number };
    /**
     * Pointer-down on empty chart space: no hit-test contribution claimed the position. Emitted
     * synchronously. Such a press also starts a gesture — subsequent movement and the release are
     * delivered as `pointer/barMove` / `pointer/barUp` with no `hit` — so consumers such as a
     * rubber-band selection can track a drag that begins on empty space.
     */
    "pointer/background": { x: number; y: number; event: PointerEvent };
    /**
     * Emitted after a bottom pane's applied height actually changed — by pointer drag, keyboard
     * step or the `view/setBottomPaneHeight` command. `height` is the height the pane now
     * occupies, in CSS px.
     */
    "view/bottomPaneResized": { id: string; height: number };
  }
}

/* ------------------------------------------------------------------ *
 * Factory
 * ------------------------------------------------------------------ */

/**
 * Creates the view plugin: the canvases and the virtual viewport, the pane row and its bottom
 * region, the theme token layer, the time axis and its header, and the background grid and today
 * lines.
 *
 * Configurable plugins are exported as factories because the host passes no per-plugin config to
 * `setup()`: the configuration is read and normalized once here, and the produced plugin itself
 * takes `void`.
 */
export function view(config?: ViewConfig): Plugin<void> {
  const options = normalizeViewConfig(config);
  return definePlugin({
    meta: {
      id: PLUGIN_ID,
      // The date domain: the origin guard follows the task store, and the non-working shading
      // reads the calendar a `gridLines.nonWorkingDays.calendar` names.
      dependsOn: ["stargantt.data-store"],
    },
    setup: (ctx) => setupView(ctx, options),
  });
}
