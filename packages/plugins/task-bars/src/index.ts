/**
 * `@stargantt/plugin-task-bars` — plugin id `stargantt.task-bars`.
 *
 * The chart pane's content: it draws every visible task as a bar, a summary glyph or a milestone
 * diamond, shades the completed fraction of a bar, and answers hit tests for bars and their
 * resize handles. Geometry comes from the services it depends on — the data store, the row model
 * and the time scale — and the drawing itself is contributed to the view plugin, which owns the
 * canvases and the pointer events.
 *
 * It publishes one service, `stargantt.task-bars`, through which other plugins read the geometry
 * of the bars currently on screen. It owns three extension points: `taskbars/style` for per-task
 * colour, `taskbars/overlays` for extra painting on top of each bar, and `taskbars/endGutter` for
 * reserving the strip just outside a bar's ends so bar-end decorations do not overprint each other.
 *
 * Only the public `@stargantt/core` surface is used — no core internals, no back doors.
 */
import { collect, definePlugin, first } from "@stargantt/core";
import type { ExtensionPointDecl, Plugin, PluginContext } from "@stargantt/core";
import type { Task } from "@stargantt/plugin-data-store";
// Type-only imports. They bring the sibling packages' `declare module "@stargantt/core"`
// augmentations into this program so `ctx.use(...)` and the contributions below are checked
// against the real key spaces. Erased at emit — no runtime dependency is added.
import type { LayerContribution } from "@stargantt/plugin-view";
import type { RowsReader } from "./internal/deps";
import { resolveShape } from "./internal/decor";
import { createEmptyState } from "./internal/empty-state";
import { createMaxTaskEnd } from "./internal/extent";
import { createEndGutter } from "./internal/gutter";
import type { EndGutterReader } from "./internal/gutter";
import { createHitTester } from "./internal/hit";
import { createLabelFeature } from "./internal/labels";
import { createBarLayerDraw, createOverlayList } from "./internal/layer";
import type { BarDecorProviders } from "./internal/layer";
import { latched, resolveBarOptions } from "./internal/options";
import { createBarGeometry } from "./internal/service";
import { guardStyleProvider } from "./internal/style";
import type {
  BarAvatarProvider,
  BarIconProvider,
  BarLabelProvider,
  BarOverlayRenderer,
  BarPatternProvider,
  BarRenderer,
  BarStyle,
  BarStyleProvider,
  CollapsedSummary,
  EndGutterContribution,
  LabelPlacement,
  MilestoneShape,
  ResolvedEndGutter,
  TaskBarsMessages,
  TaskBarsService,
} from "./types";

export type {
  BarAvatar,
  BarAvatarProvider,
  BarBox,
  BarIconProvider,
  BarIcons,
  BarLabelProvider,
  BarOverlayRenderer,
  BarPattern,
  BarPatternProvider,
  BarRenderArgs,
  BarRenderer,
  BarStyle,
  BarStyleProvider,
  CollapsedSummary,
  EndGutterContribution,
  LabelPlacement,
  MilestoneShape,
  ResolvedEndGutter,
  TaskBarsMessages,
  TaskBarsService,
} from "./types";

/* ------------------------------------------------------------------ *
 * Declaration merging
 * ------------------------------------------------------------------ */

declare module "@stargantt/core" {
  interface Services {
    /**
     * Bar geometry: where each of the bars currently on screen sits on the chart canvas.
     */
    "stargantt.task-bars": TaskBarsService;
  }
  interface ExtensionPoints {
    /**
     * Extra painting layered on top of each task bar. Every contribution is called once per
     * visible bar, in plugin startup order, after that bar's labels and bar-end adornments — so an
     * overlay is the last thing drawn for its bar, above the dependency lines and the selection
     * frame and below the drag preview.
     */
    "taskbars/overlays": ExtensionPointDecl<BarOverlayRenderer, BarOverlayRenderer[]>;
    /**
     * Per-task bar styling. Contributions are consulted in plugin startup order and the first
     * one to return a style wins; the reduced value is a single provider that performs that
     * search.
     */
    "taskbars/style": ExtensionPointDecl<BarStyleProvider, BarStyleProvider>;
    /**
     * Clearance reserved outside bars' start and end edges, so connector ports and bar-end
     * decorations stop competing for the same strip. Each contribution names an end and a width;
     * the reduced value is the largest active reservation per end, published on every bar's box as
     * `gutterStart` / `gutterEnd`.
     */
    "taskbars/endGutter": ExtensionPointDecl<EndGutterContribution, ResolvedEndGutter>;
  }
}

/* ------------------------------------------------------------------ *
 * Plugin
 * ------------------------------------------------------------------ */

const PLUGIN_ID = "stargantt.task-bars";

/** Identifies this plugin's contribution to `renderer/layers`. */
const LAYER_ID = "stargantt.task-bars";

/** Identifies this plugin's second contribution — labels, end icons, avatars and overlays. */
const DECOR_LAYER_ID = "stargantt.task-bars.decorations";

// docs/specs/plugins/task-bars.md "claimOrder registrations" — the order scope is shared, so the
// two bands are claimed in code rather than fixed by a table in a document.
/** The `claimOrder` scope both layer bands are registered in. */
const LAYER_ORDER_SCOPE = "renderer/layers";

/** The claimed order key of the bar band. */
const LAYER_ORDER_KEY = "task-bars:bars";

/** The claimed order key of the decoration band. */
const DECOR_LAYER_ORDER_KEY = "task-bars:decorations";

// `LayerContribution` carries no canvas selector; the view plugin maps zIndex to a canvas and that
// banding is explicitly not part of the plugin API. Bars and milestones belong on the `main`
// canvas, and the today line is drawn at 55, so 60 keeps bars on `main` and just below it.
/** Paint order of the bar layer among all `renderer/layers` contributions. */
const LAYER_Z_INDEX = 60;

// A bar-end avatar is the answer to "who is on this task", and a dependency line drawn across the
// bar end used to bury it. The decorations therefore paint above the dependency lines (70) and the
// selection frame, while staying under 100 so they share the bars' `main` canvas and stay under the
// drag preview (100) that must stay on top of everything.
/** Paint order of the icon/avatar layer among all `renderer/layers` contributions. */
const DECOR_LAYER_Z_INDEX = 80;

// docs/specs/plugins/task-bars.md "Messages" — the normative default table.
const DEFAULT_MESSAGES: TaskBarsMessages = {
  empty: "No tasks",
};

// Uniform message-catalog convention: per-key shallow override; a member that is not a string
// (including `undefined`) is ignored, and `""` is taken verbatim.
function resolveMessages(overrides: Partial<TaskBarsMessages> | undefined): TaskBarsMessages {
  const resolved = { ...DEFAULT_MESSAGES };
  if (overrides === null || typeof overrides !== "object") return resolved;
  for (const key of Object.keys(DEFAULT_MESSAGES) as (keyof TaskBarsMessages)[]) {
    const value = overrides[key];
    if (typeof value === "string") resolved[key] = value;
  }
  return resolved;
}

// `setup()` is wiring: every piece of logic below lives in an `internal/*` module that can be
// exercised without a host, and this function only resolves services, defines and contributes the
// extension points, publishes the service and subscribes to the repaint triggers.
function setup(ctx: PluginContext, config: TaskBarsConfig): void {
  const view = ctx.use("stargantt.view");
  const data = ctx.use("stargantt.data");
  const scale = ctx.use("stargantt.timeline");
  // The row model is consumed structurally, through `internal/deps`' hand-maintained `RowsReader`:
  // importing tree-grid's declaration — the augmentation that puts `"stargantt.rows"` in the key
  // space along with it — would close a package-level type cycle (tree-grid depends on this
  // package's types for its `taskbars/*` contributions), which leaves pnpm unable to order the two
  // builds. The key is the published service id and the cast is confined to this one
  // line; the runtime call is the ordinary `ctx.use("stargantt.rows")`.
  const rows = ctx.use("stargantt.rows" as never) as RowsReader;
  // The built-in bar fills are theme tokens read through the theme service's cached
  // `getComputedStyle`, so dark mode can restyle them from CSS alone.
  const theme = ctx.use("stargantt.theme");

  // docs/specs/plugins/task-bars.md "Claims" — this plugin owns the `task.meta.color` per-task fill
  // override its style resolution reads.
  ctx.claimKey("task.meta", "color");

  // Resolved once, at setup(), and not re-read afterwards.
  const messages = resolveMessages(config.messages);

  // Function-shaped contributions are invoked by the point-owning plugin, which must guard them and
  // report via `core/pluginError`. The contributor's own plugin id is not observable through the
  // public API, so the invoking plugin is reported — but the payload must not therefore claim that
  // *this* plugin threw, so the cause is wrapped with the point it came through.
  const fault = (point: string, error: unknown): void => {
    ctx.emit("core/pluginError", { pluginId: PLUGIN_ID, error: { point, cause: error } });
  };

  /* --- `taskbars/style` (first) — internal/style.ts -------------------- */

  const stylePoint = ctx.defineExtensionPoint(
    "taskbars/style",
    (inputs: BarStyleProvider[]): BarStyleProvider =>
      first<[task: Readonly<Task>], BarStyle>()(
        inputs.map((fn) => guardStyleProvider(fn, (error) => fault("taskbars/style", error))),
      ),
  );

  /* --- `taskbars/overlays` (collect) — internal/layer.ts --------------- */

  const overlaysPoint = ctx.defineExtensionPoint(
    "taskbars/overlays",
    collect<BarOverlayRenderer>(),
  );
  const overlays = createOverlayList(
    () => overlaysPoint.get(),
    (error) => fault("taskbars/overlays", error),
  );

  /* --- `taskbars/endGutter` (reduce) — internal/gutter.ts -------------- */

  const endGutter = createEndGutter((error) => fault("taskbars/endGutter", error));
  const gutterPoint = ctx.defineExtensionPoint("taskbars/endGutter", endGutter.reduce);
  // The core caches a reduction while the contribution set is unchanged, so `get()` is only what
  // keeps that set current; `refresh()` is the resolution proper, re-reading every `active()` once
  // per paint pass so a reservation flips with its feature rather than mid-frame.
  const gutter: EndGutterReader = {
    current: endGutter.current,
    refresh: () => {
      gutterPoint.get();
      endGutter.refresh();
    },
  };

  /* --- bar labels — internal/labels.ts --------------------------------- */

  // The display extensions are validated once, here; an unusable value silently leaves its feature
  // at the default. A throwing config-supplied function is reported once — with this plugin's id,
  // since such a function has no observable plugin id of its own, and with the cause wrapped in the
  // option it came through so a diagnostic does not read "task-bars faulted".
  const options = resolveBarOptions(config);
  const optionFault = (option: string) => (error: unknown): void => {
    ctx.emit("core/pluginError", { pluginId: PLUGIN_ID, error: { option, cause: error } });
  };

  const labels = createLabelFeature(theme, optionFault("label"), {
    host: options.label,
    duration: options.durationLabel,
    progress: options.progressLabel,
    backdrop: options.labelBackdrop,
  });

  // Every config-supplied function that runs inside the paint loop sits behind a latched barrier:
  // the first throw is reported once and the function then declines for good. The bar renderer's
  // latch lives in the layer pass because its fault must also fall back to the built-in painting.
  const decor: BarDecorProviders = {
    renderBar: options.renderBar,
    renderBarFault: optionFault("renderBar"),
    patternOf:
      typeof options.patternFill === "function"
        ? latched(options.patternFill, optionFault("patternFill"))
        : undefined,
    shapeOf:
      typeof options.milestoneShape === "function"
        ? latched(options.milestoneShape, optionFault("milestoneShape"))
        : undefined,
    iconsOf: options.barIcons && latched(options.barIcons, optionFault("barIcons")),
    avatarOf: options.avatar && latched(options.avatar, optionFault("avatar")),
  };

  /* --- the geometry service — internal/service.ts ---------------------- */

  // `rows` is the row model, which is also the expansion reader; `options` was resolved above, so
  // the service knows what a collapsed summary presents without re-reading the config.
  const geometry = createBarGeometry({
    rows,
    data,
    scale,
    expand: rows,
    collapsedSummary: options.collapsedSummary,
    gutter,
  });
  ctx.provide("stargantt.task-bars", geometry.service);

  /* --- `renderer/layers` contributions — internal/layer.ts ------------- */

  const draws = createBarLayerDraw({
    rows,
    geometry,
    theme,
    styleProvider: () => stylePoint.get(),
    labels,
    overlays,
    gutter,
    options,
    decor,
    expand: rows,
    tree: data,
    data,
    // Lets the pass tell a live-viewport draw from a `renderTo`/warm-pass replay, so only the
    // former commits the service's geometry snapshot.
    liveViewport: () => view.viewport.get(),
    // Label measurement rides the view's LRU measureText cache.
    textWidth: (g, text) => view.textWidth(g, text),
  });
  ctx.claimOrder(LAYER_ORDER_SCOPE, LAYER_ORDER_KEY, LAYER_Z_INDEX);
  const layer: LayerContribution = {
    id: LAYER_ID,
    zIndex: LAYER_Z_INDEX,
    draw: draws.bars,
  };
  ctx.contribute("renderer/layers", layer);
  // The decoration band: labels, bar-end adornments and the replayed `taskbars/overlays` calls, all
  // above the dependency lines. Contributed unconditionally: the pass is a no-op while nothing
  // wants painting there, and a conditional contribution would make the layer set depend on config
  // in a way nothing else here does.
  ctx.claimOrder(LAYER_ORDER_SCOPE, DECOR_LAYER_ORDER_KEY, DECOR_LAYER_Z_INDEX);
  const decorLayer: LayerContribution = {
    id: DECOR_LAYER_ID,
    zIndex: DECOR_LAYER_Z_INDEX,
    draw: draws.decorations,
  };
  ctx.contribute("renderer/layers", decorLayer);

  /* --- `renderer/hitTest` contribution — internal/hit.ts --------------- */

  ctx.contribute(
    "renderer/hitTest",
    createHitTester({
      rows,
      data,
      scale,
      viewport: () => view.viewport.get(),
      expand: rows,
      tree: data,
      // The hit test follows the same resolved shape the paint pass uses, per-task chooser
      // included.
      shapeOf: (task) => resolveShape(options, decor.shapeOf, task),
      options: {
        expandedHitArea: options.expandedHitArea,
        collapsedSummary: options.collapsedSummary,
      },
    }),
  );

  /* --- the empty state — `.sg-empty` (internal/empty-state.ts) --------- */

  // The mount point is the element the view plugin hands out, never found by its class string.
  // This plugin's `dependsOn` puts the view plugin's `setup()` first, so the pane already exists
  // here and the element never changes afterwards.
  const emptyState = createEmptyState({
    document: ctx.root.ownerDocument,
    parent: view.chartPaneElement(),
    rowCount: () => rows.rowCount(),
    text: messages.empty,
  });
  ctx.own({ dispose: () => emptyState.dispose() });
  emptyState.sync();

  /* --- `renderer/contentExtent` contribution (internal/extent.ts) ------ */

  // The horizontal half of the scrollable-range bound: the view plugin cannot bound the axis by
  // itself, so without a contribution here the chart could be wheeled into an empty void far past
  // the data. The extent is the x of the latest task end plus one viewport of slack, so near-future
  // empty time stays reachable without the axis being infinite.
  const maxTaskEnd = createMaxTaskEnd(data);

  ctx.contribute("renderer/contentExtent", {
    id: PLUGIN_ID,
    measure: (): { width?: number } => {
      const end = maxTaskEnd.get();
      if (end === null) return {};
      return { width: scale.tToX(end) + view.viewport.get().width };
    },
  });

  /* --- repaint triggers ------------------------------------------------ */
  // docs/specs/plugins/task-bars.md "Events" — the store subscriptions that drive repaints.
  // `invalidate` is frame-batched by the view plugin, so these handlers stay
  // cheap even where another plugin already repaints for the same cause (a scroll, a theme change):
  // a redundant mark is folded into the one pass that frame.
  const repaint = (): void => view.invalidate("main");
  ctx.own(
    data.tasks.subscribe(() => {
      maxTaskEnd.invalidate();
      emptyState.sync();
      repaint();
    }),
  );
  ctx.own(
    rows.rows.subscribe(() => {
      emptyState.sync();
      repaint();
    }),
  );
  // The viewport store is set inside the pass that composites, so an unconditional repaint here
  // would arm the next frame from within the current one and never settle. Stores gate on nothing,
  // so the comparison is made here: only a viewport that actually moved or resized repaints.
  ctx.own(
    view.viewport.subscribe((next, prev) => {
      if (
        next.scrollLeft !== prev.scrollLeft ||
        next.scrollTop !== prev.scrollTop ||
        next.width !== prev.width ||
        next.height !== prev.height
      ) {
        repaint();
      }
    }),
  );
  // The zoom store is deliberately re-published for an origin move over an unchanged level, so
  // every notification is a t↔x mapping change and every one of them invalidates.
  ctx.own(scale.zoomLevel.subscribe(repaint));
  ctx.own(theme.tokens.subscribe(repaint));
}

/**
 * Options for the task-bars plugin.
 *
 * Bar styling stays a `taskbars/style` contribution and bar colours stay CSS tokens; bar shape and
 * geometry are fixed and not configurable.
 */
export interface TaskBarsConfig {
  /**
   * Draws a text label beside each task's bar.
   *
   * Omit it and no bar carries a label, which is the default. Supply a function and it is called
   * once per visible bar on every paint; the string it returns is drawn past the bar's right edge,
   * and returning `undefined` (or the empty string) leaves that bar unlabelled. The object form
   * takes the same function as `text` and moves every label to another side: `"left"` ends just
   * before the bar, `"inside"` is centred on the bar and clipped to it.
   */
  label?: BarLabelProvider | { text: BarLabelProvider; placement?: LabelPlacement };

  /**
   * Replacement wording for the built-in empty state, per key. Keys left out keep their English
   * defaults.
   */
  messages?: Partial<TaskBarsMessages>;

  /**
   * Paints a halo behind every label drawn *outside* a bar, so it stays legible where a dependency
   * line crosses it.
   *
   * On by default, which changes nothing until a chart asks for labels: with none configured there
   * is nothing to put a halo behind. The fill comes from the `--sg-bar-label-backdrop` theme token
   * and covers only the label's own text, so the line stays visible either side of it. Labels
   * placed inside a bar never get one — they sit on the bar's fill, not on the chart background.
   *
   * The object form overrides the fill, the padding around the text in CSS px, and the corner
   * radius. `false` paints bare text.
   */
  labelBackdrop?: boolean | { color?: string; padding?: number; radius?: number };

  /**
   * Shows each bar's duration as a `"3d"`-style label, rounded to whole days (minimum one day).
   * `true` places it past the bar's right edge; the object form also picks the placement.
   * Milestones carry no duration and get none. Off by default.
   */
  durationLabel?: boolean | { placement?: LabelPlacement };

  /**
   * Shows each ordinary bar's completion as a `"40%"`-style label. `true` places it inside the
   * bar; the object form also picks the placement. Milestones and summaries get none. Off by
   * default.
   */
  progressLabel?: boolean | { placement?: LabelPlacement };

  /**
   * Replaces the painting of every bar body. The function receives the canvas context, the bar's
   * box and task, and a `defaultPaint` callback that paints the built-in look, so it can decorate
   * around the default instead of redrawing it. Labels, icons, avatars and overlay contributions
   * still draw on top afterwards. A renderer that throws is reported once, the affected bar falls
   * back to the built-in look, and the renderer is disabled from then on. Off by default.
   */
  renderBar?: BarRenderer;

  /**
   * The marker shape milestones are painted as — `"diamond"` (the default), `"triangle"`,
   * `"star"` or `"square"` — or a per-task chooser returning one of those (returning `undefined`
   * falls back to the diamond). Every shape fills the same square box, so hit-testing and label
   * anchors are unaffected.
   */
  milestoneShape?: MilestoneShape | ((task: Readonly<Task>) => MilestoneShape | undefined);

  /**
   * Distinguishes task types by texture as well as colour: `true` hatches ordinary bars
   * diagonally and cross-hatches summary bodies (milestones already differ by shape), and a
   * function chooses the pattern per task, falling back to that built-in mapping when it returns
   * `undefined`. Off by default.
   */
  patternFill?: boolean | BarPatternProvider;

  /**
   * Corner radius of ordinary task bars in CSS px.
   *
   * `0` is an explicit choice of square corners and overrides whatever the theme asks for.
   * Omitting the option — or giving it a negative or non-finite number — reads the
   * `--sg-bar-radius` theme token instead; with neither set, bars keep their classic square
   * corners.
   */
  barRadius?: number;

  /**
   * Overlays status icon glyphs on the two ends of each bar. The function returns
   * `{ left?, right? }` strings drawn centred inside the corresponding end, or `undefined` for
   * none; bars too narrow to fit a glyph per end (or milestones) draw none. Off by default.
   */
  barIcons?: BarIconProvider;

  /**
   * Draws an assignee badge — a filled circle with initials — on each bar's right end. The
   * function returns `{ initials?, color? }` or `undefined` for no badge on that task. Off by
   * default.
   */
  avatar?: BarAvatarProvider;

  /**
   * What a summary row shows while it is collapsed.
   *
   * `"range"` (the default) paints the summary's own span as the summary glyph, `"hidden"` paints
   * and hit-tests nothing for it, and `"split"` paints the bars of its direct children inside its
   * row, so a folded project still shows what it contains and when. Those in-row bars are ordinary
   * horizontal editing surfaces — they can be dragged, resized and have their progress set like
   * any other bar — and they are painted like one too, labels and colours included; what they do
   * not carry is end icons, avatars and overlay contributions. A child whose own row is hidden is
   * left out of the split row entirely. Expanding the row gives every child its own row again,
   * which is also how the keyboard reaches them.
   */
  collapsedSummary?: CollapsedSummary;

  /**
   * Widens every bar's pointer target to at least 24 × 24 CSS px around its centre, so very
   * short or thin bars stay clickable; resize handles and the progress strip keep their exact
   * zones. Nothing painted changes. Off by default.
   */
  expandedHitArea?: boolean;
}

/**
 * Creates the task-bars plugin: it draws one bar per visible task, answers the hit test for bars,
 * their resize handles and the narrow strip around each bar's progress boundary, and publishes the
 * resulting bar geometry as the `stargantt.task-bars` service.
 *
 * Configurable plugins are exported as factories because the host passes no per-plugin config to
 * `setup()`: any configuration is closed over here and the produced plugin itself takes `void`.
 */
export function taskBars(config?: TaskBarsConfig): Plugin<void> {
  // A config-bearing plugin ships as a factory. The object is snapshotted so a later mutation by
  // the caller cannot change the plugin's behavior.
  const snapshot: TaskBarsConfig = { ...config };
  return definePlugin({
    // `dependsOn` takes provider plugin ids, while the five services consumed above are service
    // ids: the view plugin provides three of them.
    meta: {
      id: PLUGIN_ID,
      dependsOn: ["stargantt.data-store", "stargantt.view", "stargantt.tree-grid"],
    },
    setup: (ctx: PluginContext): void => setup(ctx, snapshot),
  });
}
