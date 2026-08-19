/**
 * Public types of `@stargantt/plugin-task-bars`.
 *
 * Kept in their own module so the internal modules can import them without a cycle through the
 * package entry (which owns the `declare module "@stargantt/core"` augmentation).
 */
import type { Task, TaskId } from "@stargantt/plugin-data-store";

/**
 * The rectangle a single task's bar occupies on the chart canvas, in the same viewport-local CSS
 * pixel space the layer's `draw` call paints in.
 *
 * For a milestone the rectangle is the square that bounds its diamond; for a summary it is the
 * full band the summary glyph is drawn inside, not just the glyph's thin body.
 *
 * The two gutter members describe the strips reserved immediately *outside* the rectangle's two
 * vertical edges. They are clearance, not geometry: they never move the bar or change what a
 * pointer over it hits.
 */
export interface BarBox {
  id: TaskId;
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * Width, in CSS px, of the strip reserved immediately outside the bar's left (start) edge for
   * bar-end affordances such as connector ports. `0` when nothing reserves the strip. A plugin
   * that decorates a bar's start end draws outside this strip.
   */
  gutterStart: number;
  /**
   * The same reservation for the bar's right (end) edge, in CSS px.
   */
  gutterEnd: number;
}

// The strip outside a bar's edges is shared surface (connector ports, bar-end badges, outside
// labels), so it is reserved through a point rather than guessed from another plugin's geometry.
/**
 * A reservation of clearance outside bars' edges, contributed to the `taskbars/endGutter`
 * extension point.
 *
 * Every bar of the chart carries the same resolved reservation, so a decoration placed outside it
 * sits in the same place on every row.
 */
export interface EndGutterContribution {
  /** Stable identifier of the contribution, for diagnostics; it takes no part in the resolution. */
  id: string;
  /** Which bar end(s) the reservation applies to. */
  end: "start" | "end" | "both";
  /** Reserved width in CSS px, measured outward from the bar's edge. */
  size: number;
  /**
   * Whether the reservation currently applies. It is called once per resolution — once per paint
   * pass, not once per bar — so a reservation flips with the feature that owns it rather than
   * mid-frame.
   */
  active(): boolean;
}

/**
 * The reservation the `taskbars/endGutter` contributions reduce to: for each bar end, the largest
 * size among the contributions that are active and cover that end, or 0 when there are none.
 */
export interface ResolvedEndGutter {
  start: number;
  end: number;
}

/**
 * A contribution to the `taskbars/overlays` extension point: extra painting on top of a bar.
 *
 * It is called once per visible bar, with the chart canvas's 2d context and that bar's box, after
 * that bar's labels and bar-end adornments — so an overlay is the last thing drawn for its bar,
 * and it draws above the dependency lines and the selection frame rather than under them. Every
 * contribution is invoked inside a saved canvas state, so changes to `fillStyle`, transforms and
 * the like do not leak into the next bar. A contribution that throws is reported through the
 * core's plugin-error event and then skipped, so one broken overlay cannot stop the chart from
 * painting.
 */
export type BarOverlayRenderer = (g: CanvasRenderingContext2D, bar: Readonly<BarBox>) => void;

/**
 * Visual overrides for one task's bar.
 *
 * `color` is the bar's fill. Omitting it (or leaving the whole style undefined) declines to
 * override, so the color falls through to `task.meta.color` and then to the built-in default for
 * the task's type.
 */
export interface BarStyle {
  color?: string;
}

/**
 * Where a bar's label is drawn: `"right"` starts just past the bar's right edge, `"left"` ends
 * just before its left edge, and `"inside"` is centred inside the bar and clipped to it.
 */
export type LabelPlacement = "left" | "right" | "inside";

/**
 * Produces the label drawn for a task's bar, or `undefined` to draw no label for that task.
 *
 * Called once per visible bar per paint, so it must be cheap and must not touch the DOM. The empty
 * string is treated exactly like `undefined`. Where the label is drawn is a chart-wide choice, made
 * alongside the provider — see the `label` option.
 */
export type BarLabelProvider = (task: Readonly<Task>) => string | undefined;

/**
 * The marker shape a milestone is painted as. All shapes fill the same square box the milestone
 * occupies, so geometry, hit-testing anchors and label anchors are unaffected by the choice.
 */
export type MilestoneShape = "diamond" | "triangle" | "star" | "square";

// The three presentations are mutually exclusive, so they are one enumeration rather than two
// independent flags.
/**
 * What a summary row shows while it is collapsed: `"range"` paints the summary's own span as the
 * summary glyph, `"hidden"` paints nothing at all, and `"split"` paints the bars of the summary's
 * direct children inside its row so a folded project still shows what it contains.
 */
export type CollapsedSummary = "range" | "hidden" | "split";

// Pattern fills, so task types are distinguishable without relying on colour alone.
/**
 * The overlay pattern painted on top of a bar's fill: diagonal hatching, cross hatching, a dot
 * grid, or none.
 */
export type BarPattern = "none" | "diagonal" | "cross" | "dots";

/**
 * Chooses the overlay pattern for one task's bar, or `undefined` to use the built-in per-type
 * mapping (ordinary bars hatch diagonally, summaries cross-hatch, milestones stay plain).
 */
export type BarPatternProvider = (task: Readonly<Task>) => BarPattern | undefined;

/**
 * What a replacement bar renderer receives: the bar's box, its task, and `defaultPaint`, which
 * paints the built-in look for this bar (body, progress fill and pattern) so a renderer can
 * decorate around it instead of redrawing everything.
 */
export interface BarRenderArgs {
  box: Readonly<BarBox>;
  task: Readonly<Task>;
  defaultPaint(): void;
}

/**
 * Replaces the painting of a task's bar body. The canvas state is saved and restored around each
 * call, and a renderer that throws is reported once and then disabled, with painting falling back
 * to the built-in look.
 */
export type BarRenderer = (g: CanvasRenderingContext2D, args: BarRenderArgs) => void;

/**
 * Icon glyphs overlaid on a bar's two ends. Each member is a short string (typically one
 * character) drawn centred inside the corresponding end of the bar.
 */
export interface BarIcons {
  left?: string;
  right?: string;
}

/**
 * Produces the end icons for one task's bar, or `undefined` for no icons on that bar.
 */
export type BarIconProvider = (task: Readonly<Task>) => BarIcons | undefined;

/**
 * An assignee badge drawn as a filled circle at the bar's right end: `initials` is the short text
 * inside the circle, `color` its fill (falling back to a built-in neutral when omitted).
 */
export interface BarAvatar {
  initials?: string;
  color?: string;
}

/**
 * Produces the avatar badge for one task's bar, or `undefined` for no badge on that bar.
 */
export type BarAvatarProvider = (task: Readonly<Task>) => BarAvatar | undefined;

/**
 * A contribution to the `taskbars/style` extension point: a per-task look-up of bar styling.
 *
 * Contributions are consulted in plugin startup order and the first one to return a value other
 * than `undefined` wins, so returning `undefined` passes the decision to the next contribution.
 * A contribution that throws is reported through the core's plugin-error event and then skipped
 * for the rest of the session.
 */
export type BarStyleProvider = (task: Readonly<Task>) => BarStyle | undefined;

/**
 * Wording of the built-in zero-row empty state.
 */
export interface TaskBarsMessages {
  /** Text shown in the chart body when the composed row count is 0. Default `"No tasks"`. */
  empty: string;
}

/**
 * Read access to bar geometry, published so that plugins that decorate, route between or drag bars
 * can measure them without contributing a drawing callback.
 *
 * `barBoxOf` and `visibleBoxes` answer from the latest completed paint pass, so between a data,
 * scroll or zoom change and the frame that repaints, they still describe the previous frame; they
 * report viewport-local pixels, the space the chart canvas paints in. `barRect` instead computes a
 * box on demand, in scroll-independent content coordinates, and answers for off-screen bars too.
 */
export interface TaskBarsService {
  /**
   * Returns the box of the given task's bar as of the latest paint, or `undefined` when the task
   * has no visible bar — an unknown id, a task hidden by a collapsed ancestor, or one scrolled
   * outside the visible row range.
   *
   * The returned box must not be modified.
   */
  barBoxOf(id: TaskId): Readonly<BarBox> | undefined;
  /**
   * Returns the boxes of every visible bar as of the latest paint, in top-to-bottom row order.
   *
   * The array is a fresh snapshot the caller may keep, but the boxes inside it must not be
   * modified.
   */
  visibleBoxes(): ReadonlyArray<Readonly<BarBox & { id: TaskId }>>;
  /**
   * Computes the box the given task's bar occupies right now, in content coordinates — the
   * scroll-independent CSS pixel space in which x = 0 is the timeline origin and y = 0 is the top
   * of the first row — or `undefined` when the task is unknown or hidden inside a collapsed branch.
   *
   * The box is derived from the current row model and time scale rather than from the latest paint,
   * so it answers for a task on any row, on screen or not: a consumer routing between bars can
   * measure an end that is scrolled out of view. Subtract the chart viewport's scroll offsets
   * (`scrollLeft` from x, `scrollTop` from y) to obtain the viewport-local box `barBoxOf` reports.
   *
   * A milestone's box is the square bounding its diamond, centred on its start instant; a summary's
   * box spans its dates like an ordinary bar's.
   */
  barRect(id: TaskId): Readonly<BarBox> | undefined;
  /**
   * Whether this task currently has a bar of its own painted on its own row.
   *
   * `false` for a collapsed summary while collapsed summaries are hidden (nothing is painted for
   * it) or split (its row shows its children's bars instead of its own), and `false` for a task
   * the row model does not place at all — an unknown id, a task inside a collapsed branch, or one
   * on a row whose height is zero. `true` for every other bar, milestone and summary, including
   * one scrolled out of view: this asks how the task is presented, not whether it is on screen.
   *
   * Consult it before drawing anything anchored to a bar. `barRect` still answers for a collapsed
   * summary, because a dependency line into a folded branch needs somewhere to land, so `barRect`
   * alone cannot tell a decorating plugin whether a bar is actually there.
   */
  hasOwnBar(id: TaskId): boolean;
}
