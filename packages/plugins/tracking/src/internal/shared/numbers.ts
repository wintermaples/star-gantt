// Small numeric validators shared by every area — the defensive-read pattern ("an unusable value
// silently falls back") applied uniformly to the money / duration / percent / index quantities the
// four areas exchange.

/** `typeof value === "number" && Number.isFinite(value)`, narrowed. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** A finite number, or `undefined`. */
export function finiteOrUndefined(value: unknown): number | undefined {
  return isFiniteNumber(value) ? value : undefined;
}

/** A finite, non-negative number, or `undefined`. */
export function finiteNonNegative(value: unknown): number | undefined {
  return isFiniteNumber(value) && value >= 0 ? value : undefined;
}

/** A finite, strictly positive number, or `undefined`. */
export function finitePositive(value: unknown): number | undefined {
  return isFiniteNumber(value) && value > 0 ? value : undefined;
}

/** `value` clamped into `[min, max]`; a non-finite `value` clamps to `min`. */
export function clamp(value: number, min: number, max: number): number {
  const v = isFiniteNumber(value) ? value : min;
  return v < min ? min : v > max ? max : v;
}

/** A non-empty, trimmed string, or `undefined` (used for cost codes, item ids/labels). */
export function trimmedNonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
