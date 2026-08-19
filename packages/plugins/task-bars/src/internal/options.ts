/**
 * Option normalization for `stargantt.task-bars`: the raw `TaskBarsConfig` fields added by the
 * display extensions are validated here once, at `setup()`, into a plain resolved shape the paint
 * pass and the hit test read without re-checking.
 *
 * Per the factory convention, a field holding an unusable value is silently ignored, which leaves
 * that feature at its default (off).
 */
import type { Task } from "@stargantt/plugin-data-store";
import type {
  BarAvatarProvider,
  BarIconProvider,
  BarLabelProvider,
  BarPattern,
  BarPatternProvider,
  BarRenderer,
  CollapsedSummary,
  LabelPlacement,
  MilestoneShape,
} from "../types";

const PLACEMENTS: readonly LabelPlacement[] = ["left", "right", "inside"];
const SHAPES: readonly MilestoneShape[] = ["diamond", "triangle", "star", "square"];
const PATTERNS: readonly BarPattern[] = ["none", "diagonal", "cross", "dots"];
const COLLAPSED: readonly CollapsedSummary[] = ["range", "hidden", "split"];

/** Narrows an unknown value to a label placement, or `undefined`. */
export function asPlacement(value: unknown): LabelPlacement | undefined {
  return PLACEMENTS.includes(value as LabelPlacement) ? (value as LabelPlacement) : undefined;
}

/** Narrows an unknown value to a milestone shape, or `undefined`. */
export function asShape(value: unknown): MilestoneShape | undefined {
  return SHAPES.includes(value as MilestoneShape) ? (value as MilestoneShape) : undefined;
}

/** Narrows an unknown value to a bar pattern, or `undefined`. */
export function asPattern(value: unknown): BarPattern | undefined {
  return PATTERNS.includes(value as BarPattern) ? (value as BarPattern) : undefined;
}

/** Narrows an unknown value to a collapsed-summary mode, or `undefined`. */
export function asCollapsedSummary(value: unknown): CollapsedSummary | undefined {
  return COLLAPSED.includes(value as CollapsedSummary) ? (value as CollapsedSummary) : undefined;
}

// The host label carries its placement in the same object the provider is given in, so all three
// label kinds have one shape: a switch (or a provider) plus an optional placement.
/** The resolved host-supplied label: the provider, if any, and where its labels are drawn. */
export interface HostLabel {
  provider: BarLabelProvider | undefined;
  placement: LabelPlacement;
}

/** Normalizes the `label` option's function-or-object union. */
export function asHostLabel(value: unknown): HostLabel {
  if (typeof value === "function") {
    return { provider: value as BarLabelProvider, placement: "right" };
  }
  if (value !== null && typeof value === "object") {
    const text = (value as { text?: unknown }).text;
    if (typeof text !== "function") return { provider: undefined, placement: "right" };
    return {
      provider: text as BarLabelProvider,
      placement: asPlacement((value as { placement?: unknown }).placement) ?? "right",
    };
  }
  return { provider: undefined, placement: "right" };
}

// The backdrop is on by default. That changes no default chart: all three label kinds are off
// unless configured, so only a composition that already asked for labels sees it, which is exactly
// the population with the problem.
/** The resolved `labelBackdrop` option, or `undefined` when it was switched off. */
export interface BackdropOption {
  color: string | undefined;
  padding: number | undefined;
  radius: number | undefined;
}

/** Normalizes the `labelBackdrop` option. `false` is the only way to switch it off. */
export function asBackdrop(value: unknown): BackdropOption | undefined {
  if (value === false) return undefined;
  if (value !== null && typeof value === "object") {
    const raw = value as { color?: unknown; padding?: unknown; radius?: unknown };
    return {
      color: typeof raw.color === "string" && raw.color !== "" ? raw.color : undefined,
      padding:
        typeof raw.padding === "number" && Number.isFinite(raw.padding) && raw.padding >= 0
          ? raw.padding
          : undefined,
      radius:
        typeof raw.radius === "number" && Number.isFinite(raw.radius) && raw.radius >= 0
          ? raw.radius
          : undefined,
    };
  }
  return { color: undefined, padding: undefined, radius: undefined };
}

/** A built-in label toggle: enabled or not, and at which placement. */
export interface BuiltinLabel {
  enabled: boolean;
  /** Explicit placement, or `undefined` to use the feature's own default placement. */
  placement: LabelPlacement | undefined;
}

// `true` enables the label at its default placement; an object form may also pick the placement.
// Anything else leaves it off.
/** Normalizes a `durationLabel` / `progressLabel` option value. */
export function asBuiltinLabel(value: unknown): BuiltinLabel {
  if (value === true) return { enabled: true, placement: undefined };
  if (value !== null && typeof value === "object") {
    return { enabled: true, placement: asPlacement((value as { placement?: unknown }).placement) };
  }
  return { enabled: false, placement: undefined };
}

/** The validated, resolved display options of one plugin instance. */
export interface BarOptions {
  /** The host-supplied label provider and where its labels go. */
  label: HostLabel;
  /** The halo painted behind labels drawn outside a bar, or `undefined` when switched off. */
  labelBackdrop: BackdropOption | undefined;
  durationLabel: BuiltinLabel;
  progressLabel: BuiltinLabel;
  renderBar: BarRenderer | undefined;
  /** Fixed milestone shape, a per-task chooser, or the built-in diamond when `undefined`. */
  milestoneShape: MilestoneShape | ((task: Readonly<Task>) => MilestoneShape | undefined) | undefined;
  /** `undefined` = feature off; a provider = per-task pattern (built-in mapping when it declines). */
  patternFill: BarPatternProvider | "builtin" | undefined;
  /** Corner radius override in CSS px, or `undefined` to read the `--sg-bar-radius` token. */
  barRadius: number | undefined;
  barIcons: BarIconProvider | undefined;
  avatar: BarAvatarProvider | undefined;
  /** What a collapsed summary row shows: its own span, nothing, or its children's bars. */
  collapsedSummary: CollapsedSummary;
  expandedHitArea: boolean;
}

/** The raw config fields this module validates (a structural subset of `TaskBarsConfig`). */
export interface RawBarOptions {
  label?: unknown;
  labelBackdrop?: unknown;
  durationLabel?: unknown;
  progressLabel?: unknown;
  renderBar?: unknown;
  milestoneShape?: unknown;
  patternFill?: unknown;
  barRadius?: unknown;
  barIcons?: unknown;
  avatar?: unknown;
  collapsedSummary?: unknown;
  expandedHitArea?: unknown;
}

/** Validates the raw config once into the resolved option shape. */
export function resolveBarOptions(raw: RawBarOptions): BarOptions {
  const radius = raw.barRadius;
  return {
    label: asHostLabel(raw.label),
    labelBackdrop: asBackdrop(raw.labelBackdrop),
    durationLabel: asBuiltinLabel(raw.durationLabel),
    progressLabel: asBuiltinLabel(raw.progressLabel),
    renderBar: typeof raw.renderBar === "function" ? (raw.renderBar as BarRenderer) : undefined,
    milestoneShape:
      typeof raw.milestoneShape === "function"
        ? (raw.milestoneShape as (task: Readonly<Task>) => MilestoneShape | undefined)
        : asShape(raw.milestoneShape),
    patternFill:
      raw.patternFill === true
        ? "builtin"
        : typeof raw.patternFill === "function"
          ? (raw.patternFill as BarPatternProvider)
          : undefined,
    // 0 is a value, not an absence: it overrides the --sg-bar-radius token with square corners.
    // Only an absent, negative or non-finite value declines to override and lets the token decide.
    barRadius:
      typeof radius === "number" && Number.isFinite(radius) && radius >= 0 ? radius : undefined,
    barIcons: typeof raw.barIcons === "function" ? (raw.barIcons as BarIconProvider) : undefined,
    avatar: typeof raw.avatar === "function" ? (raw.avatar as BarAvatarProvider) : undefined,
    collapsedSummary: asCollapsedSummary(raw.collapsedSummary) ?? "range",
    expandedHitArea: raw.expandedHitArea === true,
  };
}

// Every config-supplied function that runs inside the paint loop sits behind the same latched
// barrier: the first throw is reported once and the function then declines for the rest of the
// instance's life, so a broken host function cannot emit an error per bar per frame.
/**
 * Wraps a per-bar foreign function in a latched fault barrier: after the first throw — reported
 * once through `onFault` — every later call returns `undefined` without calling through.
 */
export function latched<A extends unknown[], R>(
  fn: (...args: A) => R,
  onFault: (error: unknown) => void,
): (...args: A) => R | undefined {
  let faulted = false;
  return (...args: A): R | undefined => {
    if (faulted) return undefined;
    try {
      return fn(...args);
    } catch (error) {
      faulted = true;
      onFault(error);
      return undefined;
    }
  };
}
