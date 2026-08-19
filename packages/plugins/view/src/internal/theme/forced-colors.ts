/**
 * Windows High Contrast / `forced-colors` support for canvas painting.
 *
 * When `(forced-colors: active)` matches, the browser repaints all CSS with the user's system
 * palette — but a `<canvas>` keeps whatever colors the script draws with. This module maps every
 * canvas-read `--sg-*` token to the CSS system color that plays the same role, so that (once the
 * host opts in) `ThemeService.get` hands the painters system colors and the chart follows the
 * forced palette like the rest of the page. CSS system-color keywords (`Canvas`, `CanvasText`,
 * `Highlight`, …) are valid 2D-context color strings, so callers need no change.
 *
 * Hostless on purpose: the map and lookup carry no DOM and no listeners.
 */
// docs/specs/plugins/view.md

/** The media query whose `matches` state gates the whole mapping. */
export const FORCED_COLORS_QUERY = "(forced-colors: active)";

/**
 * Canvas-read tokens → CSS system colors. Roles, not hues: text-like marks map to `CanvasText`,
 * surfaces to `Canvas`, secondary/ground marks to `GrayText`, emphasized figures (task bars,
 * selection, focus, active gestures) to `Highlight`, warnings to `Mark`. Translucent decorative
 * fills become `transparent` — forced-colors mode drops decorative shading rather than guessing
 * an opacity for an unknowable system palette. The translucent progress overlay is dropped the
 * same way so text painted over the bar keeps the guaranteed `Highlight`/`HighlightText`
 * contrast pairing. Tokens absent from this map (fonts, px lengths, stylesheet-only colors) read
 * normally.
 */
export const FORCED_COLOR_TOKENS: Readonly<Record<string, string>> = {
  "--sg-bg": "Canvas",
  "--sg-fg": "CanvasText",
  "--sg-muted-fg": "GrayText",
  "--sg-border": "CanvasText",
  "--sg-header-bg": "Canvas",
  "--sg-header-fg": "CanvasText",
  "--sg-header-tick": "GrayText",
  "--sg-bar-fill": "Highlight",
  "--sg-summary-fill": "CanvasText",
  "--sg-milestone-fill": "CanvasText",
  // retired `--sg-progress-fill`, and its replacement needs no entry here: the track is the
  // bar's own colour at `--sg-bar-track-alpha`, so under forced colors it is `Highlight` at that
  // same fraction. Being one colour at two opacities rather than two colours is what keeps the
  // Highlight/HighlightText pairing intact for the inside label, bar icons and avatar initials —
  // the failure mode the former overlay had to be mapped to `transparent` to avoid.
  "--sg-bar-label-fg": "CanvasText",
  // The halo behind an outside label is the surface that label sits on, so under a system palette
  // it is `Canvas` — the counterpart of the `CanvasText` above it, which is what keeps the pairing
  // readable when the user's colours replace the palette's.
  "--sg-bar-label-backdrop": "Canvas",
  // docs/specs/plugins/view.md — the bar outline is a text-like mark, so an
  // outlined palette keeps its bar edges under a system palette. Its companion
  // `--sg-bar-fill-bevel` is a fraction, not a colour, and is exempt like `--sg-bar-track-alpha`.
  "--sg-bar-stroke": "CanvasText",
  "--sg-today-line": "Highlight",
  "--sg-status-line": "Highlight",
  "--sg-grid-line-minor": "GrayText",
  "--sg-grid-line-major": "GrayText",
  "--sg-grid-nonworking": "transparent",
  "--sg-grid-offhours": "transparent",
  "--sg-grid-zone": "transparent",
  "--sg-bar-inside-label-fg": "HighlightText",
  "--sg-selection-stroke": "Highlight",
  "--sg-rubber-band-fill": "transparent",
  "--sg-rubber-band-stroke": "Highlight",
  "--sg-focus-stroke": "Highlight",
  "--sg-drag-ghost-fill": "transparent",
  "--sg-drag-ghost-stroke": "Highlight",
  "--sg-link-line": "CanvasText",
  "--sg-link-port": "CanvasText",
  "--sg-link-band": "Highlight",
  // docs/specs/plugins/view.md — dependency-highlight dual encoding (packages/
  // plugins/scheduling/dependencies, out of this package's scope; registered here). The
  // emphasized figure keeps Highlight; driving keeps CanvasText, its extra width alone carrying
  // the distinction once the palette collapses to system colours.
  "--sg-link-emphasis": "Highlight",
  "--sg-link-driving": "CanvasText",
  "--sg-scrollbar-thumb": "GrayText",
  "--sg-scrollbar-thumb-active": "CanvasText",
  "--sg-load-fill": "Highlight",
  "--sg-load-capacity-line": "CanvasText",
  "--sg-load-over-fill": "Mark",
  "--sg-load-bg": "Canvas",
  "--sg-calendar-nonworking": "transparent",
  "--sg-taskfields-warning": "Mark",
  "--sg-taskfields-avatar": "GrayText",
  "--sg-baseline-bar": "GrayText",
  "--sg-baseline-overlay-fill": "transparent",
  "--sg-baseline-overlay-stroke": "GrayText",
  "--sg-actual-bar": "CanvasText",
  "--sg-baseline-slip-late": "CanvasText",
  "--sg-baseline-slip-early": "CanvasText",
  "--sg-baseline-cp-added": "CanvasText",
  "--sg-baseline-cp-removed": "GrayText",
  // docs/specs/plugins/view.md — critical-path's four tokens (packages/plugins/
  // scheduling/critical-path, out of this package's scope; registered here).
  "--sg-critical-bar": "Highlight",
  "--sg-near-critical-bar": "Mark",
  "--sg-negative-float": "Mark",
  "--sg-critical-float": "transparent",
  // docs/specs/plugins/view.md — the remaining canvas-read families registered
  // in the same pass: resource-utilization's overlay warning glyph, progress-tracking's trend
  // line, and evm's PV/EV/AC curve strokes (all out of this package's scope).
  "--sg-ru-warning": "Mark",
  "--sg-progress-line": "Highlight",
  "--sg-evm-pv": "GrayText",
  "--sg-evm-ev": "Highlight",
  "--sg-evm-ac": "Mark",
  // docs/specs/plugins/view.md — the canvas-read tokens the first pass
  // missed: cost-tracking's curve/breakdown strokes, progress-tracking's RAG recolor/badge fills,
  // resource-utilization's demand/supply trend strokes, and grid-lines' row-hover shade (all out
  // of this package's scope). The planned-cost curve is a secondary reference (`GrayText`) and
  // the actual-cost curve an attention mark (`Mark`), mirroring the evm PV/AC pairing; category
  // breakdown strokes lose their hue distinction under a system palette and paint `CanvasText`.
  // All three RAG badge fills map to `Mark` and the badge letter to `MarkText`, keeping the
  // system palette's guaranteed Mark/MarkText contrast pairing on every badge; the letter R/A/G,
  // not the colour, carries the classification, so the statuses sharing one fill is by design. The
  // demand curve is the emphasized figure (`Highlight`) over the `CanvasText` supply reference.
  // The row-hover shade is decorative ground and is dropped (`transparent`) like the other
  // translucent fills above.
  "--sg-cost-planned": "GrayText",
  "--sg-cost-actual": "Mark",
  "--sg-cost-labor": "CanvasText",
  "--sg-cost-fixed": "CanvasText",
  "--sg-cost-variable": "CanvasText",
  "--sg-cost-material": "CanvasText",
  "--sg-rag-red": "Mark",
  "--sg-rag-amber": "Mark",
  "--sg-rag-green": "Mark",
  "--sg-rag-badge-fg": "MarkText",
  "--sg-ru-demand": "Highlight",
  "--sg-ru-supply": "CanvasText",
  "--sg-row-hover-bg": "transparent",
  // the alternating row background is decoration, like the hover fill above it — a
  // forced-colors palette has no "faintly different surface" to spend on it, and any system
  // colour opaque enough to show would compete with the row text.
  "--sg-row-stripe-bg": "transparent",
};

/** The system color a token maps to while forced colors are active, or `undefined` if unmapped. */
export function forcedColorValue(token: string): string | undefined {
  return FORCED_COLOR_TOKENS[token];
}
