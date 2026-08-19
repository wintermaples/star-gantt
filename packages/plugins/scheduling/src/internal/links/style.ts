// docs/specs/plugins/scheduling.md §5.3 (colour precedence) / §5.5 (conflict, driving, dim)
/**
 * Stroke resolution for one dependency line: how its colour, width, dash pattern and arrowhead are
 * decided from the configured base style, the per-type colour map, the link's analysis status
 * (conflicting / driving) and its interactive emphasis (hovered / on the highlighted path /
 * selected).
 *
 * Pure decision only — no canvas — so the precedence rules are unit-testable without a host
 * (the `sanitize*` half lives in `config.ts`, which owns every field's resolution here).
 */
import type { ResolvedDependencies } from "../../config";

/** How a dependency line's arrowhead is drawn. */
export type ArrowHead = "filled" | "open" | "none";

/** The resolved base look of every dependency line, as `config.ts` decides it. */
export type ResolvedLineStyle = ResolvedDependencies["linkStyle"];

// §5.5 — a conflicting link is dashed as well as recoloured, so the warning never rides on colour
// alone (the dual-encoding rule).
/** Dash pattern forced onto a conflicting link, overriding `linkStyle.dash` for that line. */
export const CONFLICT_DASH: readonly number[] = [4, 3];

/** Built-in colour of a conflicting link when no `conflictColor` is configured. */
export const CONFLICT_COLOR = "#dc2626";

// §5.5 — emphasis is dual-encoded (own colour *and* extra width), so the cue never rides on width
// alone; the width contributions are additive, so a driving link on the highlighted path stays
// distinguishable from either alone.
/** Extra stroke width given to a hovered link or one on the highlighted dependency path. */
export const EMPHASIS_EXTRA_WIDTH = 1.5;

/** Extra stroke width given to a driving link and to the selected link. */
export const STRONG_EXTRA_WIDTH = 1.5;

// §5.5 — while anything is emphasized, everything else recedes; a conflicting link keeps full
// opacity, because a warning is never dimmed.
/** Opacity every non-emphasized link is drawn at while the emphasized set is non-empty. */
export const DIM_ALPHA = 0.35;

/** Opacity of a link that is not dimmed: fully opaque. */
export const FULL_ALPHA = 1;

/** Everything the stroke of one link is a function of. */
export interface StrokeInputs {
  /** The resolved base style. */
  style: ResolvedLineStyle;
  /** The theme-resolved line colour (`--sg-link-line` or its fallback). */
  baseColor: string;
  /** The configured colour for this link's type, when one is configured. */
  typeColor: string | undefined;
  /** The theme-resolved band colour, used for the selected link. */
  bandColor: string;
  /** The theme-resolved emphasis colour, used for a hovered or path-highlighted link. */
  emphasisColor: string;
  /** The theme-resolved driving colour, used for a link that pins its successor's dates. */
  drivingColor: string;
  /** The configured (or built-in) conflict colour. */
  conflictColor: string;
  /** Whether the link violates its own date constraint (§5.5). */
  conflicting: boolean;
  /** Whether the link exactly determines its successor's date (§5.5). */
  driving: boolean;
  /** Whether the link is hovered or on the highlighted dependency path (§5.5). */
  emphasized: boolean;
  /** Whether the link is the currently selected one (§5.4). */
  selected: boolean;
  /**
   * Whether the link sits outside a non-empty emphasized set and therefore recedes (§5.5). A
   * conflicting link ignores this: its warning is never dimmed.
   */
  dimmed: boolean;
}

/** The stroke one link is painted with. */
export interface LinkStroke {
  color: string;
  width: number;
  dash: readonly number[] | undefined;
  arrowHead: ArrowHead;
  /** Opacity the whole link — line and arrowhead — is painted at. */
  alpha: number;
}

// §5.3 — colour precedence, strongest first: selected > conflicting > emphasized > driving >
// per-type entry > `--sg-link-line`. Width grows additively; a conflicting link is always dashed,
// and never dimmed.
/** Resolves the stroke of one link from everything that can affect it. */
export function linkStroke(inputs: StrokeInputs): LinkStroke {
  const { style } = inputs;
  // Written weakest first, so each stronger state simply overwrites the one below it.
  let color = inputs.typeColor ?? inputs.baseColor;
  if (inputs.driving) color = inputs.drivingColor;
  if (inputs.emphasized) color = inputs.emphasisColor;
  if (inputs.conflicting) color = inputs.conflictColor;
  if (inputs.selected) color = inputs.bandColor;
  let width = style.width;
  if (inputs.emphasized) width += EMPHASIS_EXTRA_WIDTH;
  if (inputs.driving) width += STRONG_EXTRA_WIDTH;
  if (inputs.selected) width += STRONG_EXTRA_WIDTH;
  const dash = inputs.conflicting ? CONFLICT_DASH : style.dash;
  const alpha = inputs.dimmed && !inputs.conflicting ? DIM_ALPHA : FULL_ALPHA;
  return { color, width, dash, arrowHead: style.arrowHead, alpha };
}
