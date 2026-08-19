// Inline-style record assignment (docs/specs/sdk.md, Module: sdk/dom).

/** The element shape {@link styled} writes to; real elements and DOM doubles alike satisfy it. */
export interface StylableElement {
  style: object;
}

/**
 * Assigns a record of camelCase inline-style properties to an element's `style` object — a thin
 * typed loop over property assignment, not a styling framework. Values are CSS text exactly as a
 * `style.<prop> = "…"` assignment would take them; unknown properties are ignored by the engine
 * the way any bad inline assignment is.
 *
 * @example
 * ```ts
 * styled(panel, { position: "absolute", left: "50%", maxWidth: "100%" });
 * ```
 */
export function styled(el: StylableElement, styles: Readonly<Record<string, string>>): void {
  const target = el.style as unknown as Record<string, string>;
  for (const [property, value] of Object.entries(styles)) {
    target[property] = value;
  }
}
