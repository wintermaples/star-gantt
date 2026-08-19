// Hot-path (per-frame / per-pointer-event) paint helpers (docs/specs/sdk.md, Module: sdk/frame):
// half-pixel stroke alignment and repaint-skipping set equality.

/**
 * Whether two sets hold exactly the same members (by the sets' own `has` semantics — SameValueZero
 * for native `Set`s). Used to skip a repaint or a change event when a new selection is the old one.
 */
export function sameIdSet<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/**
 * Half-pixel alignment for 1 px canvas strokes: a 1 px line stroked along an integer coordinate
 * straddles two device pixels and blurs; centred on a `.5` coordinate it covers exactly one.
 * Round-trip the coordinate through this before every 1 px `moveTo`/`lineTo`.
 */
export function alignHalfPixel(v: number): number {
  return Math.round(v) + 0.5;
}
