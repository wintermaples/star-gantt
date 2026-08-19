// docs/specs/plugins/view.md — internal module, not part of the published surface.
/**
 * The per-chart colour-scheme pin (docs/specs/plugins/view.md).
 *
 * A `light-dark()` value resolves against the computed `color-scheme` of the element the
 * declaration sits on, and a registered custom property inherits as an already-resolved colour —
 * so pinning `color-scheme` on the chart element alone changes nothing. The bundled stylesheet
 * therefore declares the whole token block on `:where(:root),:where(.sg-scheme-light),
 *:where(.sg-scheme-dark)`, and this module is the plugin-side half: it puts one of those two
 * classes on the chart element, which is what re-declares the palette there and resolves it in the
 * pinned scheme.
 *
 * The inline `color-scheme` written alongside the class is not what themes the canvas — the class
 * does that — but it is what makes the DOM inside the chart agree: native scrollbars, form
 * controls and the default `Canvas`/`CanvasText` system colours all follow the property, not the
 * class.
 */
import type { ColorScheme } from "./types";

/** The class that pins each scheme; `"auto"` carries none. */
const CLASS_BY_SCHEME: Readonly<Record<"light" | "dark", string>> = {
  light: "sg-scheme-light",
  dark: "sg-scheme-dark",
};

/** Both scheme classes, for the removal pass. */
export const SCHEME_CLASSES: readonly string[] = [CLASS_BY_SCHEME.light, CLASS_BY_SCHEME.dark];

/** The slice of an element this module touches, so the unit tests need no real DOM. */
export interface SchemeTargetLike {
  classList: { add(name: string): void; remove(name: string): void };
  style: { colorScheme?: string };
}

/** `"light"` / `"dark"` / `"auto"` when the value is one of them, else `null`. */
export function asColorScheme(value: unknown): ColorScheme | null {
  return value === "light" || value === "dark" || value === "auto" ? value : null;
}

/**
 * Puts `scheme` on the element: the matching class plus the inline `color-scheme`, with the other
 * scheme's class removed. `"auto"` removes both classes and clears the inline property, leaving
 * the element exactly as it was before any pin — which is what disposal needs.
 */
export function applyColorScheme(target: SchemeTargetLike, scheme: ColorScheme): void {
  for (const name of SCHEME_CLASSES) target.classList.remove(name);
  if (scheme === "auto") {
    target.style.colorScheme = "";
    return;
  }
  target.classList.add(CLASS_BY_SCHEME[scheme]);
  target.style.colorScheme = scheme;
}
