/**
 * The `renderer/layers` pass of `stargantt.task-bars`: one bar per visible row, its labels and
 * decorations, and the `taskbars/overlays` contributions on top — plus the geometry snapshot the
 * pass hands to the service.
 *
 * Geometry comes from `./service`, the drawing calls from `./paint` and `./paint-text`, the colours
 * from `./style`, the decoration choices from `./decor` and the compressed-row rules from
 * `./split`.
 */
import type { Viewport } from "@stargantt/plugin-view";
import type { Task, TaskId } from "@stargantt/plugin-data-store";
import type {
  BarAvatar,
  BarBox,
  BarIcons,
  BarOverlayRenderer,
  BarPattern,
  BarRenderer,
  BarStyleProvider,
  MilestoneShape,
} from "../types";
import type {
  ExpandReader,
  RowHeightReader,
  RowReader,
  TaskReader,
  TaskTreeReader,
  ThemeReader,
} from "./deps";
import type { LabelFeature, PlacedLabel } from "./labels";
import type { BarOptions } from "./options";
import type { PaintBarOptions } from "./paint";
import type { BarGeometry } from "./service";
import { resolveBevel, resolvePattern, resolveRadius, resolveShape, resolveStroke } from "./decor";
import { isMilestone } from "./geometry";
import { paintBar } from "./paint";
import { drawAvatar, drawBarIcons, drawPlacedLabels } from "./paint-text";
import type { GroupLabel, LabelBackdrop } from "./paint-text";
import { resolveBarColor, resolveTrackAlpha } from "./style";
import { isCollapsedSummary, isHiddenSummaryRow, visibleChildIdsOf } from "./split";
import type { EndGutterReader } from "./gutter";

/** The already-latched per-bar foreign functions the display options supplied. */
export interface BarDecorProviders {
  /** The raw bar renderer; the pass owns its latch because a fault must fall back to painting. */
  renderBar?: BarRenderer | undefined;
  /** Reports the bar renderer's first throw. */
  renderBarFault?: ((error: unknown) => void) | undefined;
  patternOf?: ((task: Readonly<Task>) => BarPattern | undefined) | undefined;
  shapeOf?: ((task: Readonly<Task>) => MilestoneShape | undefined) | undefined;
  iconsOf?: ((task: Readonly<Task>) => BarIcons | undefined) | undefined;
  avatarOf?: ((task: Readonly<Task>) => BarAvatar | undefined) | undefined;
}

/** What the bar layer draws from. */
export interface BarLayerDeps {
  /** Row geometry, plus the by-task height resolution the split row's child filter needs. */
  rows: RowReader & RowHeightReader;
  geometry: BarGeometry;
  theme: ThemeReader;
  /**
   * The reduced `taskbars/style` provider. Read once per pass — the reduction is reference-stable
   * for an unchanged contribution set, so this is the same symmetry the overlay list already had.
   */
  styleProvider(): BarStyleProvider | undefined;
  labels: LabelFeature;
  /** The guarded `taskbars/overlays` contributions, in startup order. */
  overlays(): readonly BarOverlayRenderer[];
  /** The resolved display options; absent paints the classic look. */
  options?: BarOptions;
  /** Latched decoration providers; absent members leave their features off. */
  decor?: BarDecorProviders;
  // One resolution per pass, never one per bar; omitting it is the gutter-free composition, whose
  // boxes reserve nothing.
  /** The end-gutter reservation, re-resolved once at the top of every pass. */
  gutter?: Pick<EndGutterReader, "refresh">;
  /** Expansion state; required only by the split-view and collapsed-summary options. */
  expand?: ExpandReader;
  /** Child index and task lookup; required only by the split-view option. */
  tree?: TaskTreeReader;
  data?: TaskReader;
  // `renderTo` (export tiles, thumbnails) and the prefetch warm pass replay this layer's draw for a
  // *foreign* viewport, and those draws must touch no on-screen state. Comparing the draw's
  // viewport to the live one is how the geometry snapshot commit below stays an on-screen-only
  // effect.
  /** The view's live viewport; omitted (tests) commits every draw, the historical behavior. */
  liveViewport?: () => Readonly<{ scrollLeft: number; scrollTop: number; width: number; height: number }>;
  /**
   * The view's LRU-cached `measureText` (`ViewService.textWidth`), used for label layout so a
   * steady-state frame re-measures nothing; omitted falls back to raw `measureText`.
   */
  textWidth?: (g: CanvasRenderingContext2D, text: string) => number;
}

// As with `taskbars/style`, the point-owning plugin guards its contributions and reports through
// `core/pluginError`.
/** Wraps one overlay contribution in the fault barrier and in a saved canvas state. */
function guardOverlay(
  fn: BarOverlayRenderer,
  fault: (error: unknown) => void,
): BarOverlayRenderer {
  let faulted = false;
  return (g, bar) => {
    if (faulted) return;
    g.save();
    try {
      fn(g, bar);
    } catch (error) {
      faulted = true;
      fault(error);
    } finally {
      g.restore();
    }
  };
}

/**
 * The guarded overlay list, rebuilt only when the reduction produces a new array — the reduced
 * value is reference-stable while the contribution set is unchanged, so a pass costs one identity
 * check rather than one wrapper allocation per contribution.
 */
export function createOverlayList(
  read: () => readonly BarOverlayRenderer[] | undefined,
  fault: (error: unknown) => void,
): () => BarOverlayRenderer[] {
  let source: readonly BarOverlayRenderer[] | null = null;
  let guarded: BarOverlayRenderer[] = [];
  return () => {
    const raw = read() ?? [];
    if (raw !== source) {
      source = raw;
      guarded = raw.map((fn) => guardOverlay(fn, fault));
    }
    return guarded;
  };
}

const CLASSIC_OPTIONS: BarOptions = {
  label: { provider: undefined, placement: "right" },
  labelBackdrop: undefined,
  durationLabel: { enabled: false, placement: undefined },
  progressLabel: { enabled: false, placement: undefined },
  renderBar: undefined,
  milestoneShape: undefined,
  patternFill: undefined,
  barRadius: undefined,
  barIcons: undefined,
  avatar: undefined,
  collapsedSummary: "range",
  expandedHitArea: false,
};

/**
 * The layer's whole mutable state: the fields fixed at layer creation, the ones re-resolved once
 * per pass, and the bar renderer's latch. Allocated once per layer and refreshed in place, so the
 * per-bar helpers below stay module-level (and unit-testable) without costing a per-frame object.
 */
interface BarPass {
  readonly deps: BarLayerDeps;
  readonly options: BarOptions;
  readonly decor: BarDecorProviders;
  /** One scratch array and one options object reused per bar — no per-bar allocation. */
  readonly labelScratch: PlacedLabel[];
  /** The collected labels with their colours resolved, reused per bar for the same reason. */
  readonly labelGroup: GroupLabel[];
  readonly paintOptions: PaintBarOptions;
  /** Whether the split-view option is on *and* every reader it needs was supplied. */
  readonly splitOn: boolean;
  /**
   * The replacement bar renderer, cleared for good on its first throw. The latch lives here
   * rather than in a generic wrapper because a fault must fall back to the built-in painting for
   * the faulting bar and every later one.
   */
  renderBar: BarRenderer | undefined;
  /* Re-resolved at the top of every pass by `beginPass`. */
  styleProvider: BarStyleProvider | undefined;
  overlays: readonly BarOverlayRenderer[];
  trackAlpha: number;
  labelled: boolean;
  labelFill: string;
  insideFill: string;
  /** The fill the current bar was painted with — what an inside label has to be readable on. */
  barColor: string;
  labelTypeface: string;
  labelBackdrop: LabelBackdrop | undefined;
  decorated: boolean;
  decorFill: string;
  decorTypeface: string;
  radius: number;
  stroke: string;
  strokeWidth: number;
  bevel: number;
}

/**
 * Re-resolves the pass-scoped values: one resolution per pass each, not one per bar — the style
 * reduction, the progress shade, the label tokens and the corner radius.
 */
function beginPass(pass: BarPass): void {
  const { deps, decor } = pass;
  pass.overlays = deps.overlays();
  // Each contribution's `active()` is read here, once, so a reservation flips with its feature
  // between frames and every box this pass publishes carries the same pair.
  deps.gutter?.refresh();
  pass.styleProvider = deps.styleProvider();
  pass.trackAlpha = resolveTrackAlpha(deps.theme);
  pass.labelled = deps.labels.enabled();
  pass.labelFill = pass.labelled ? deps.labels.color() : "";
  pass.insideFill = pass.labelled ? deps.labels.insideColor() : "";
  pass.labelTypeface = pass.labelled ? deps.labels.font() : "";
  pass.labelBackdrop = pass.labelled ? deps.labels.backdrop() : undefined;
  // Icons and the avatar badge sit on the bar, so they share the inside foreground and the label
  // font — resolved only when one of those features is on.
  pass.decorated = decor.iconsOf !== undefined || decor.avatarOf !== undefined;
  pass.decorFill = pass.decorated ? deps.labels.insideColor() : "";
  pass.decorTypeface = pass.decorated ? deps.labels.font() : "";
  pass.radius = resolveRadius(pass.options, deps.theme);
  // Theme-only decorations, resolved once per pass like the radius and copied onto the shared paint
  // options below.
  const stroke = resolveStroke(deps.theme);
  pass.stroke = stroke.color;
  pass.strokeWidth = stroke.width;
  pass.bevel = resolveBevel(deps.theme);
}

/** Whether the box lies entirely left or right of the viewport — a painting cull only. */
function isOffscreen(box: BarBox, vp: Readonly<Viewport>): boolean {
  return box.x + box.width < 0 || box.x > vp.width;
}

/** Refreshes the shared paint options for one task (radius, pattern, milestone shape). */
function applyDecorOptions(pass: BarPass, task: Readonly<Task>): void {
  const { paintOptions, options, decor } = pass;
  paintOptions.radius = pass.radius;
  paintOptions.stroke = pass.stroke;
  paintOptions.strokeWidth = pass.strokeWidth;
  paintOptions.bevel = pass.bevel;
  paintOptions.pattern = resolvePattern(options, decor.patternOf, task);
  paintOptions.milestoneShape = isMilestone(task) ? resolveShape(options, decor.shapeOf, task) : undefined;
}

/**
 * A split row paints its direct children's bars in its own band instead of its own glyph; the
 * children join the composite snapshot because they are the row's visible bars. Store order is
 * paint order, so overlapping children stack later-on-top, and the per-child `isOffscreen` check is
 * the horizontal cull that keeps a project with thousands of children costing only what the
 * viewport covers.
 *
 * A child whose own row is hidden is excluded from all three surfaces at once (painting, the
 * snapshot, the hit test), and the children that remain carry the regular per-task pipeline: the
 * bar body through `paintBody` and the labels through the decoration record. Only the
 * per-row-owning-bar contributions — icons, avatars and `taskbars/overlays` — are withheld, because
 * a split row owns no bar of its own.
 */
function paintSplitRow(
  g: CanvasRenderingContext2D,
  pass: BarPass,
  task: Readonly<Task>,
  row: number,
  vp: Readonly<Viewport>,
  nextList: BarBox[],
  nextIndex: Map<TaskId, BarBox>,
  queue: DecorQueue,
): void {
  const { deps } = pass;
  for (const childId of visibleChildIdsOf(deps.tree!, deps.rows, task.id)) {
    const child = deps.data!.getTask(childId);
    if (child === undefined) continue;
    const childBox = deps.geometry.placedBoxFor(child, row, vp);
    nextList.push(childBox);
    nextIndex.set(childBox.id, childBox);
    if (isOffscreen(childBox, vp)) continue;
    // Through `paintBody`, not `paintBar`: a split row's children are ordinary visible bars, so the
    // replacement renderer and the `taskbars/style` provider apply to them like they do to a bar on
    // its own row.
    paintBody(g, pass, childBox, child, vp);
    if (pass.labelled) enqueueDecoration(queue, childBox, child, pass.barColor, false);
  }
}

/**
 * Paints one bar: its body, through the replacement renderer when one is installed.
 *
 * The replacement renderer runs inside a saved canvas state; its first throw is reported once,
 * painting falls back to the built-in look for this bar, and the renderer is disabled for good.
 */
function paintBody(
  g: CanvasRenderingContext2D,
  pass: BarPass,
  box: BarBox,
  task: Readonly<Task>,
  vp: Readonly<Viewport>,
): void {
  const { deps, paintOptions } = pass;
  applyDecorOptions(pass, task);
  const color = resolveBarColor(task, pass.styleProvider, deps.theme);
  // The label pass runs straight after this one for the same bar and picks its inside colour
  // against this fill.
  pass.barColor = color;
  const defaultPaint = (): void => {
    paintBar(g, box, task, color, pass.trackAlpha, paintOptions);
  };
  if (pass.renderBar === undefined) {
    defaultPaint();
    return;
  }
  g.save();
  try {
    pass.renderBar(g, { box, task, defaultPaint });
  } catch (error) {
    pass.renderBar = undefined;
    pass.decor.renderBarFault?.(error);
    defaultPaint();
  } finally {
    g.restore();
  }
}

/**
 * The bar's labels.
 *
 * Painted by the *decoration* pass, not the bar pass, for the reason that entry gives for icons and
 * avatars: the bar band is zIndex 60 and dependency lines are 70, so a line routed between two bars
 * was drawn straight over the label in the gap it crosses. `barColor` is passed in rather than read
 * off the pass, because by the time the decoration pass runs the pass-scoped field holds whichever
 * bar was painted last.
 */
function paintLabels(
  g: CanvasRenderingContext2D,
  pass: BarPass,
  box: BarBox,
  task: Readonly<Task>,
  barColor: string,
): void {
  if (!pass.labelled) return;
  const collected = pass.deps.labels.collect(task, pass.labelScratch);
  const group = pass.labelGroup;
  group.length = 0;
  for (const placed of collected) {
    group.push({
      text: placed.text,
      placement: placed.placement,
      // An outside label sits on the chart background, which the pass-scoped colour was resolved
      // against; an inside label sits on this bar's own fill.
      color:
        placed.placement === "inside"
          ? pass.deps.labels.insideColorOn(barColor, pass.insideFill)
          : pass.labelFill,
    });
  }
  // Measurement goes through the view's LRU cache when wired, so a steady-state frame re-measures
  // none of its labels.
  drawPlacedLabels(g, box, group, pass.labelTypeface, pass.labelBackdrop, pass.deps.textWidth);
}

/** The bar's icon pair and avatar badge, when either provider is installed. */
function paintDecorations(g: CanvasRenderingContext2D, pass: BarPass, box: BarBox, task: Readonly<Task>): void {
  const icons = pass.decor.iconsOf?.(task);
  if (icons !== undefined && icons !== null && typeof icons === "object") {
    drawBarIcons(
      g,
      box,
      typeof icons.left === "string" ? icons.left : undefined,
      typeof icons.right === "string" ? icons.right : undefined,
      pass.decorFill,
      pass.decorTypeface,
    );
  }
  const avatar = pass.decor.avatarOf?.(task);
  if (avatar !== undefined && avatar !== null && typeof avatar === "object") {
    drawAvatar(g, box, avatar, pass.decorFill, pass.decorTypeface);
  }
}

// End icons and the avatar badge are painted by a second layer that sits above the dependency
// lines, so an assignee badge on a bar end is never buried under a link routed across it. The bar
// pass records what to decorate instead of drawing it, and the decoration pass replays that record
// in the same frame.
/** One bar the decoration pass still owes: the box, the task, and the fill the bar was painted in. */
interface DecorEntry {
  box: BarBox;
  task: Readonly<Task>;
  /** The bar's resolved fill, so an inside label's contrast is measured against its own bar. */
  barColor: string;
  // A split row's in-row child gets its labels but no icons, avatar or overlay calls: those are per
  // row-owning bar, and a split row owns none.
  /** Whether this bar owns its row, which is what the adornments and the overlays are per. */
  ownRow: boolean;
}

/**
 * The record shared by the two passes. A plain array plus a live count, refilled in place every
 * frame — the entries are reused, so a steady-state frame allocates nothing here.
 */
interface DecorQueue {
  entries: DecorEntry[];
  count: number;
}

/** Records one bar for the decoration pass, reusing the slot a previous frame allocated. */
function enqueueDecoration(
  queue: DecorQueue,
  box: BarBox,
  task: Readonly<Task>,
  barColor: string,
  ownRow: boolean,
): void {
  const existing = queue.entries[queue.count];
  if (existing === undefined) queue.entries.push({ box, task, barColor, ownRow });
  else {
    existing.box = box;
    existing.task = task;
    existing.barColor = barColor;
    existing.ownRow = ownRow;
  }
  queue.count += 1;
}

/** One `renderer/layers` draw callback. */
export type LayerDraw = (g: CanvasRenderingContext2D, vp: Readonly<Viewport>) => void;

/** The plugin's two paint passes, sharing one pass state and one decoration record. */
export interface BarLayerDraws {
  /** The bar bodies — the bar band. */
  bars: LayerDraw;
  /**
   * Labels, end icons, avatar badges and the recorded `taskbars/overlays` calls, all replayed
   * above the dependency lines.
   */
  decorations: LayerDraw;
}

/** Builds the layer's `draw` callbacks. */
export function createBarLayerDraw(deps: BarLayerDeps): BarLayerDraws {
  const { rows, geometry } = deps;
  const options = deps.options ?? CLASSIC_OPTIONS;
  const decor = deps.decor ?? {};
  const pass: BarPass = {
    deps,
    options,
    decor,
    labelScratch: [],
    labelGroup: [],
    paintOptions: {},
    splitOn:
      options.collapsedSummary === "split" &&
      deps.expand !== undefined &&
      deps.tree !== undefined &&
      deps.data !== undefined,
    renderBar: decor.renderBar,
    styleProvider: undefined,
    overlays: [],
    trackAlpha: 0,
    labelled: false,
    labelFill: "",
    insideFill: "",
    barColor: "",
    labelTypeface: "",
    labelBackdrop: undefined,
    decorated: false,
    decorFill: "",
    decorTypeface: "",
    radius: 0,
    stroke: "",
    strokeWidth: 0,
    bevel: 0,
  };
  const decorQueue: DecorQueue = { entries: [], count: 0 };

  const bars: LayerDraw = (g, vp) => {
    // The pass builds the next geometry snapshot alongside the painting and swaps it in at the
    // end, so a reader that runs mid-pass (a `taskbars/overlays` contribution, say) still sees a
    // whole frame rather than a half-filled one.
    const nextList: BarBox[] = [];
    const nextIndex = new Map<TaskId, BarBox>();
    // Whatever a previous frame left unconsumed is void: this pass decides afresh what carries a
    // decoration.
    decorQueue.count = 0;
    try {
      const count = rows.rowCount();
      if (count === 0 || vp.width <= 0 || vp.height <= 0) return;
      // The row-direction O(1) division, borrowed for painting: only the rows the viewport actually
      // covers are visited, so the pass costs the same at 100 tasks and at 100 000.
      const firstRow = rows.rowAtY(vp.scrollTop);
      const lastRow = rows.rowAtY(vp.scrollTop + vp.height);
      beginPass(pass);
      for (let row = firstRow; row <= lastRow && row < count; row += 1) {
        const found = geometry.placedBarAt(row, vp);
        if (found === null) continue;
        const { box, task } = found;
        if (pass.splitOn && isCollapsedSummary(task, deps.expand!)) {
          paintSplitRow(g, pass, task, row, vp, nextList, nextIndex, decorQueue);
          continue;
        }
        // The shared hit.ts/layer.ts predicate (split.ts): under `"hidden"` a collapsed summary
        // paints nothing and leaves the composite.
        if (isHiddenSummaryRow(options.collapsedSummary, deps.expand, task)) continue;
        // The snapshot covers the visible row range, which is what "visible" means for the service:
        // an unknown id, a task under a collapsed ancestor and a row scrolled out of range are the
        // three cases that yield nothing. The horizontal cull below is a painting optimisation and
        // deliberately does not remove a bar from the snapshot, so a consumer asking about a bar
        // scrolled sideways still gets its (off-screen) box.
        nextList.push(box);
        nextIndex.set(box.id, box);
        // The cull gates the label too: a bar culled here has its provider skipped, so a label
        // whose bar has just left the viewport leaves with it (recorded deliberately — widening the
        // cull would cost a text measurement per culled row).
        if (isOffscreen(box, vp)) continue;
        paintBody(g, pass, box, task, vp);
        // Labels, bar-end adornments and the `taskbars/overlays` contributions are all *recorded*
        // here and painted by the decoration pass, above the dependency lines. Milestones carry no
        // adornments but do carry labels and overlays, so the record is gated on any of the three
        // being wanted; the decoration pass re-checks which of them applies to each entry.
        if (pass.labelled || pass.overlays.length > 0 || (pass.decorated && !isMilestone(task))) {
          enqueueDecoration(decorQueue, box, task, pass.barColor, true);
        }
      }
    } finally {
      // A draw replayed for a foreign viewport (`renderTo` export tiles/thumbnails, the prefetch
      // warm pass) must touch no on-screen state, so only a draw for the live viewport installs its
      // snapshot as the service composite. With no live-viewport reader (hostless unit tests) every
      // draw commits, the historical behavior.
      const live = deps.liveViewport?.();
      if (
        live === undefined ||
        (live.scrollLeft === vp.scrollLeft &&
          live.scrollTop === vp.scrollTop &&
          live.width === vp.width &&
          live.height === vp.height)
      ) {
        geometry.commit(nextList, nextIndex);
      }
    }
  };

  // The second pass. It runs later in the same composite than the bar pass, so the record is
  // exactly what that pass just built; consuming it leaves nothing behind for a decoration pass
  // that somehow runs twice. Per bar the order is labels, then adornments, then the overlays — an
  // overlay is still the last thing drawn for its bar, just in this later band, above the
  // dependency lines and the selection frame.
  const decorations: LayerDraw = (g) => {
    const { entries, count } = decorQueue;
    decorQueue.count = 0;
    for (let i = 0; i < count; i += 1) {
      const entry = entries[i];
      if (entry === undefined) continue;
      paintLabels(g, pass, entry.box, entry.task, entry.barColor);
      // An in-row child of a split row stops here: the adornments and the overlay contributions are
      // per row-owning bar.
      if (!entry.ownRow) continue;
      if (pass.decorated && !isMilestone(entry.task)) {
        paintDecorations(g, pass, entry.box, entry.task);
      }
      for (const overlay of pass.overlays) overlay(g, entry.box);
    }
  };

  return { bars, decorations };
}
