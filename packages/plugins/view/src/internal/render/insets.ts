// docs/specs/plugins/view.md — the published surface is only the plugin value, its
// public types and its `declare module` augmentation; this module is not part of it.
/**
 * The ordered-strip inset model of `renderer/insets`.
 *
 * Everything here is pure: the reducer maps a contribution list to the per-side sums *and* the
 * ordered strip list, the rect assignment maps that list plus a body box to rectangles, and the
 * placement tracker only remembers which rectangle each contribution was last told about. None of
 * it touches the DOM or the extension-point registry, so all of it is unit-testable without a host.
 */
import type { InsetContribution, InsetRect, ResolvedInsets } from "./index";

/** Which edge of the chart body a strip is reserved at. */
export type InsetSide = "top" | "bottom";

/** One accepted contribution, with its size already sanitized. */
export interface InsetStrip {
  readonly contribution: InsetContribution;
  readonly side: InsetSide;
  /** Height of the strip in CSS px; never negative and never non-finite. */
  readonly size: number;
}

/**
 * What `renderer/insets` reduces to.
 *
 * `top` / `bottom` are the per-side sums the point's public contract publishes (`ResolvedInsets`);
 * `strips` is the ordered list the renderer needs in order to hand each contribution its rectangle.
 * The extra member rides along on the reduced value rather than being recorded as a side effect of
 * the reducer, which keeps the reducer pure — the renderer holds the only handle to this point, so
 * no other plugin can observe the member.
 */
// docs/specs/plugins/view.md
export interface InsetLayout extends ResolvedInsets {
  readonly strips: readonly InsetStrip[];
}

/** The layout of a composition that reserves nothing. */
export const NO_INSETS: InsetLayout = { top: 0, bottom: 0, strips: [] };

/** A contributed size or reserved band, clamped so a bad contribution cannot flip a sign. */
export function sanePositive(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** A contributed value is usable only as an object naming one of the two sides. */
function isStrip(value: unknown): value is InsetContribution {
  if (typeof value !== "object" || value === null) return false;
  const side = (value as { side?: unknown }).side;
  return side === "top" || side === "bottom";
}

function orderOf(contribution: InsetContribution): number {
  return typeof contribution.order === "number" && Number.isFinite(contribution.order)
    ? contribution.order
    : 0;
}

/** The strips of one side, stacked outermost-first: ascending `order`, ties in registration order. */
function stack(strips: readonly InsetStrip[], side: InsetSide): InsetStrip[] {
  // Registration order is the input order (docs/specs/architecture.md §1.4) and `Array#sort` is stable, so
  // sorting by `order` alone leaves ties in registration order.
  return strips
    .filter((strip) => strip.side === side)
    .sort((a, b) => orderOf(a.contribution) - orderOf(b.contribution));
}

/**
 * The `renderer/insets` reducer: pure, total, and the single place the strip model is decided.
 *
 * Values that do not name a side are dropped, sizes are sanitized, each side is stacked
 * outermost-first, and the side reserves the sum of its sizes.
 */
// docs/specs/plugins/view.md
export function reduceInsets(inputs: readonly InsetContribution[]): InsetLayout {
  const accepted: InsetStrip[] = [];
  for (const contribution of inputs) {
    if (!isStrip(contribution)) continue;
    accepted.push({ contribution, side: contribution.side, size: sanePositive(contribution.size) });
  }
  const top = stack(accepted, "top");
  const bottom = stack(accepted, "bottom");
  const sum = (list: readonly InsetStrip[]): number => list.reduce((acc, s) => acc + s.size, 0);
  return { top: sum(top), bottom: sum(bottom), strips: [...top, ...bottom] };
}

/**
 * Reads a reduced value back as an `InsetLayout`.
 *
 * The renderer's own reducer always produces one, so this is a total, allocation-free pass-through
 * in practice; it exists so a re-defined point or a missing reduction cannot feed non-finite
 * bands or a missing strip list into layout.
 */
export function asInsetLayout(value: ResolvedInsets | undefined): InsetLayout {
  if (value === undefined) return NO_INSETS;
  const strips = (value as Partial<InsetLayout>).strips;
  const top = sanePositive(value.top);
  const bottom = sanePositive(value.bottom);
  if (Array.isArray(strips)) {
    // The common case: the value this package's own reducer returned, handed back unchanged so the
    // per-frame and per-pointer-event reads allocate nothing.
    return top === value.top && bottom === value.bottom
      ? (value as InsetLayout)
      : { top, bottom, strips };
  }
  return { top, bottom, strips: [] };
}

/** One strip and the rectangle a layout pass assigned it. */
export interface InsetPlacement {
  readonly contribution: InsetContribution;
  readonly rect: InsetRect;
}

/**
 * Assigns every strip its rectangle.
 *
 * Rects are expressed in the chart body's own box: `y = 0` is the pane's top edge and each strip
 * spans the full pane width. Top strips stack downwards from the pane's top edge in ascending
 * `order`, bottom strips stack upwards from its bottom edge, so in both cases a lower `order` sits
 * closer to that edge.
 */
// docs/specs/plugins/view.md
export function assignInsetRects(
  strips: readonly InsetStrip[],
  bodyWidth: number,
  bodyHeight: number,
): InsetPlacement[] {
  const placements: InsetPlacement[] = [];
  let top = 0;
  let bottom = bodyHeight;
  for (const strip of strips) {
    let y: number;
    if (strip.side === "top") {
      y = top;
      top += strip.size;
    } else {
      bottom -= strip.size;
      y = bottom;
    }
    placements.push({
      contribution: strip.contribution,
      rect: { x: 0, y, width: bodyWidth, height: strip.size },
    });
  }
  return placements;
}

/** Remembers which rectangle each contribution was last told about. */
export interface InsetPlacementTracker {
  /**
   * The subset of `placements` whose rectangle differs from the one its contribution was last told
   * about — recording them as told in the same call, so a strip that did not move is reported once
   * and never again.
   *
   * Only the contributions of the current call are remembered: one that has left the stack is
   * forgotten, so if it is ever placed again it is told its rectangle again even when that rectangle
   * is the one it had before.
   */
  moved(placements: readonly InsetPlacement[]): InsetPlacement[];
}

export function createPlacementTracker(): InsetPlacementTracker {
  // Keyed by contribution identity, so a reduction triggered by a *new* contribution does not
  // re-fire `placed` for the strips that were already placed where they still are. The entries are
  // pruned to the contributions of the latest pass, which both bounds what is retained and makes a
  // strip that left and came back a strip that has never been placed.
  let last = new Map<InsetContribution, InsetRect>();
  const same = (a: InsetRect | undefined, b: InsetRect): boolean =>
    a !== undefined && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  return {
    moved(placements) {
      const changed: InsetPlacement[] = [];
      const next = new Map<InsetContribution, InsetRect>();
      for (const placement of placements) {
        const previous = last.get(placement.contribution);
        next.set(placement.contribution, placement.rect);
        if (same(previous, placement.rect)) continue;
        changed.push(placement);
      }
      last = next;
      return changed;
    },
  };
}
