/**
 * Built-in theme presets and the pure helpers behind `ThemeService.setPreset`.
 *
 * A preset is a flat map of CSS custom-property names (`--sg-*`) to CSS color/length/font values.
 * Applying one layers those values over whatever the stylesheet resolves: `ThemeService.get`
 * consults the active preset before the computed style, and — where the environment supports it —
 * the same values are written as inline custom properties on the chart root so purely
 * CSS-consumed tokens (grid rows, tooltips, panes) follow the switch too.
 *
 * This module is hostless on purpose: it owns no DOM, no listeners and no plugin context, so the
 * palettes and the sanitizing/merging rules are unit-testable without booting a host.
 */
// docs/specs/plugins/view.md
import type { ThemePreset } from "./types";

/** A resolved preset: token name → CSS value, both plain strings. */
export type PresetTokens = Readonly<Record<string, string>>;

/*
 * The two built-in high-contrast palettes.
 *
 * Contrast targets (docs/specs/plugins/view.md): body/label text at or
 * above 7:1 (WCAG 1.4.6, AAA) against its background; every non-text UI color (bars, lines,
 * strokes, ticks) at or above 4.5:1 against its documented adjacent surfaces — deliberately above
 * the 3:1 the default theme is audited to. Figure/ground is preserved: grid lines stay grey so
 * bars, selection and focus keep more contrast than the ground they sit on.
 */

/** High-contrast light: pure white ground, black text, deep-blue bars. */
export const HIGH_CONTRAST_LIGHT: PresetTokens = {
  "--sg-bg": "#ffffff",
  "--sg-fg": "#000000", // 21:1 on #ffffff
  "--sg-muted-fg": "#262626", // 15.3:1 on #ffffff
  "--sg-border": "#000000",
  "--sg-header-bg": "#ffffff",
  "--sg-header-fg": "#000000",
  "--sg-header-tick": "#3d3d3d", // 10.4:1 on the header background
  "--sg-row-hover-bg": "#e0e0e0",
  "--sg-row-selected-bg": "#bfdbff",
  "--sg-row-stripe-bg": "#f0f0f0", // ground: fainter than the hover fill above it
  "--sg-bar-fill": "#00497e", // 9.2:1 on #ffffff
  "--sg-bar-stroke": "#000000", // invisible until a width is set, but the palette owns it
  "--sg-summary-fill": "#000000",
  "--sg-milestone-fill": "#000000",
  "--sg-bar-label-fg": "#000000",
  // Opaque here, unlike the default palette's translucent halo: a high-contrast palette must not
  // let a dependency line show through the text it sits behind.
  "--sg-bar-label-backdrop": "#ffffff",
  "--sg-today-line": "#c00000", // 6.9:1 on #ffffff, still darker than the bar blue is
  "--sg-grid-line-minor": "#949494", // ground: below bar contrast on purpose
  "--sg-grid-line-major": "#767676",
  "--sg-selection-stroke": "#000000",
  "--sg-rubber-band-fill": "rgba(0, 73, 126, 0.14)",
  "--sg-rubber-band-stroke": "#00497e",
  "--sg-focus-stroke": "#0000cc", // 8.6:1 on #ffffff
  "--sg-invalid-stroke": "#a50000", // 8.0:1 on #ffffff
  "--sg-drag-ghost-fill": "rgba(0, 73, 126, 0.3)",
  "--sg-drag-ghost-stroke": "#00497e",
  "--sg-link-line": "#000000",
  "--sg-link-port": "#000000",
  "--sg-link-band": "#0000cc",
  // docs/specs/plugins/view.md — both inherit --sg-link-line's value verbatim: a
  // high-contrast palette collapses the link family to one colour, the extra emphasis/driving
  // width alone carries the distinction (§6.1).
  "--sg-link-emphasis": "#000000",
  "--sg-link-driving": "#000000",
  "--sg-tooltip-bg": "#000000",
  "--sg-tooltip-fg": "#ffffff",
  "--sg-scrollbar-thumb": "rgba(0, 0, 0, 0.6)",
  "--sg-scrollbar-thumb-active": "rgba(0, 0, 0, 0.9)",
  "--sg-load-fill": "#00497e",
  "--sg-load-capacity-line": "#000000",
  "--sg-load-over-fill": "#a50000",
  "--sg-load-bg": "#ffffff",
  // docs/specs/plugins/view.md — the tokens FORCED_COLOR_TOKENS
  // already named but the palette omitted, plus the additions to that map. Every
  // canvas-read §4 registry token now has an entry here.
  "--sg-status-line": "#0000cc", // 8.6:1 on #ffffff — reuses the --sg-focus-stroke navy
  "--sg-grid-nonworking": "#ececec", // ground: below bar contrast on purpose
  "--sg-grid-offhours": "rgba(0, 0, 0, 0.08)",
  "--sg-grid-zone": "rgba(0, 73, 126, 0.08)",
  "--sg-bar-inside-label-fg": "#ffffff", // 9.3:1 on the deep-blue --sg-bar-fill
  "--sg-calendar-nonworking": "#ececec",
  "--sg-taskfields-warning": "#a50000",
  "--sg-taskfields-avatar": "#3d3d3d", // 10.9:1 under the hardcoded white initials
  "--sg-baseline-bar": "#767676", // ground, subordinate to task bars
  "--sg-baseline-overlay-fill": "rgba(0, 0, 0, 0.14)",
  "--sg-baseline-overlay-stroke": "#3d3d3d",
  "--sg-actual-bar": "#000000",
  "--sg-baseline-slip-late": "#a50000", // 8.1:1 on #ffffff
  "--sg-baseline-slip-early": "#0a5c05", // 8.3:1 on #ffffff
  "--sg-baseline-cp-added": "#a50000",
  "--sg-baseline-cp-removed": "#3d3d3d",
  "--sg-critical-bar": "#a50000",
  "--sg-near-critical-bar": "#8a5300", // 6.3:1 on #ffffff — non-text UI floor is 4.5:1
  "--sg-negative-float": "#6b0000", // 12.9:1 on #ffffff, distinguishable from --sg-critical-bar
  "--sg-critical-float": "rgba(0, 0, 0, 0.14)",
  "--sg-ru-warning": "#a50000",
  "--sg-progress-line": "#004c99", // 8.4:1 on #ffffff
  "--sg-evm-pv": "#004c99",
  "--sg-evm-ev": "#0a5c05",
  "--sg-evm-ac": "#a50000",
  // docs/specs/plugins/view.md — the canvas-read tokens the first pass missed:
  // cost-tracking's curve/breakdown strokes, progress-tracking's RAG fills, and
  // resource-utilization's demand/supply trend strokes.
  "--sg-cost-planned": "#004c99", // 8.4:1 on #ffffff
  "--sg-cost-actual": "#a50000",
  "--sg-cost-labor": "#004c99",
  "--sg-cost-fixed": "#4a148c", // 12.6:1 on #ffffff
  "--sg-cost-variable": "#8a5300",
  "--sg-cost-material": "#0a5c05",
  "--sg-rag-red": "#a50000",
  "--sg-rag-amber": "#8a5300",
  "--sg-rag-green": "#0a5c05",
  "--sg-rag-badge-fg": "#ffffff", // badge letter: 8.1 / 6.3 / 8.3:1 on the three RAG fills above
  "--sg-ru-demand": "#004c99",
  "--sg-ru-supply": "#0a5c05",
};

/** High-contrast dark: pure black ground, white text, light-blue bars. */
export const HIGH_CONTRAST_DARK: PresetTokens = {
  "--sg-bg": "#000000",
  "--sg-fg": "#ffffff", // 21:1 on #000000
  "--sg-muted-fg": "#d4d4d4", // 14.1:1 on #000000
  "--sg-border": "#ffffff",
  "--sg-header-bg": "#000000",
  "--sg-header-fg": "#ffffff",
  "--sg-header-tick": "#bdbdbd", // 11.2:1 on the header background
  "--sg-row-hover-bg": "#2a2a2a",
  "--sg-row-selected-bg": "#003a75",
  "--sg-row-stripe-bg": "#191919", // ground: fainter than the hover fill above it
  "--sg-bar-fill": "#6db3f2", // 9.0:1 on #000000
  "--sg-bar-stroke": "#ffffff", // invisible until a width is set, but the palette owns it
  "--sg-summary-fill": "#ffffff",
  "--sg-milestone-fill": "#ffffff",
  "--sg-bar-label-fg": "#ffffff",
  "--sg-bar-label-backdrop": "#000000",
  "--sg-today-line": "#ff5252", // 5.8:1 on #000000, subordinate to the bar blue
  "--sg-grid-line-minor": "#5a5a5a", // ground: below bar contrast on purpose
  "--sg-grid-line-major": "#8a8a8a",
  "--sg-selection-stroke": "#ffffff",
  "--sg-rubber-band-fill": "rgba(109, 179, 242, 0.16)",
  "--sg-rubber-band-stroke": "#6db3f2",
  "--sg-focus-stroke": "#7ab8ff", // 9.4:1 on #000000
  "--sg-invalid-stroke": "#ff6b6b", // 6.5:1 on #000000
  "--sg-drag-ghost-fill": "rgba(109, 179, 242, 0.3)",
  "--sg-drag-ghost-stroke": "#6db3f2",
  "--sg-link-line": "#ffffff",
  "--sg-link-port": "#ffffff",
  "--sg-link-band": "#7ab8ff",
  // docs/specs/plugins/view.md — see HIGH_CONTRAST_LIGHT's matching comment.
  "--sg-link-emphasis": "#ffffff",
  "--sg-link-driving": "#ffffff",
  "--sg-tooltip-bg": "#ffffff",
  "--sg-tooltip-fg": "#000000",
  "--sg-scrollbar-thumb": "rgba(255, 255, 255, 0.6)",
  "--sg-scrollbar-thumb-active": "rgba(255, 255, 255, 0.9)",
  "--sg-load-fill": "#6db3f2",
  "--sg-load-capacity-line": "#ffffff",
  "--sg-load-over-fill": "#ff6b6b",
  "--sg-load-bg": "#000000",
  // docs/specs/plugins/view.md — see HIGH_CONTRAST_LIGHT's
  // matching comment.
  "--sg-status-line": "#7ab8ff", // 10.1:1 on #000000
  "--sg-grid-nonworking": "#1a1a1a", // ground: below bar contrast on purpose
  "--sg-grid-offhours": "rgba(255, 255, 255, 0.08)",
  "--sg-grid-zone": "rgba(109, 179, 242, 0.1)",
  "--sg-bar-inside-label-fg": "#000000", // 9.4:1 on the light-blue --sg-bar-fill
  "--sg-calendar-nonworking": "#1a1a1a",
  "--sg-taskfields-warning": "#ff6b6b",
  "--sg-taskfields-avatar": "#5a5a5a", // 6.9:1 under the hardcoded white initials
  "--sg-baseline-bar": "#8a8a8a",
  "--sg-baseline-overlay-fill": "rgba(255, 255, 255, 0.16)",
  "--sg-baseline-overlay-stroke": "#bdbdbd",
  "--sg-actual-bar": "#ffffff",
  "--sg-baseline-slip-late": "#ff6b6b", // 7.6:1 on #000000
  "--sg-baseline-slip-early": "#4ade80", // 12.1:1 on #000000
  "--sg-baseline-cp-added": "#ff6b6b",
  "--sg-baseline-cp-removed": "#bdbdbd",
  "--sg-critical-bar": "#ff6b6b",
  "--sg-near-critical-bar": "#ffb84d", // 12.2:1 on #000000
  "--sg-negative-float": "#ff8a80", // 9.2:1 on #000000, distinguishable from --sg-critical-bar
  "--sg-critical-float": "rgba(255, 255, 255, 0.16)",
  "--sg-ru-warning": "#ff6b6b",
  "--sg-progress-line": "#7ab8ff",
  "--sg-evm-pv": "#7ab8ff",
  "--sg-evm-ev": "#4ade80",
  "--sg-evm-ac": "#ff6b6b",
  // docs/specs/plugins/view.md — see HIGH_CONTRAST_LIGHT's matching comment.
  "--sg-cost-planned": "#7ab8ff", // 9.4:1 on #000000
  "--sg-cost-actual": "#ff6b6b",
  "--sg-cost-labor": "#7ab8ff",
  "--sg-cost-fixed": "#ce93d8", // 8.0:1 on #000000
  "--sg-cost-variable": "#ffb84d",
  "--sg-cost-material": "#4ade80",
  "--sg-rag-red": "#ff6b6b",
  "--sg-rag-amber": "#ffb84d",
  "--sg-rag-green": "#4ade80",
  "--sg-rag-badge-fg": "#000000", // badge letter: 7.6 / 12.2 / 12.1:1 on the three RAG fills above
  "--sg-ru-demand": "#7ab8ff",
  "--sg-ru-supply": "#4ade80",
};

/** The presets every composition ships with, keyed by their public names. */
export const BUILT_IN_PRESETS: Readonly<Record<string, ThemePreset>> = {
  // both pin the scheme they were designed for. Without the pin the tokens a palette does
  // not set keep following the OS, which is how a high-contrast *dark* chart used to end up with
  // light-scheme row stripes and non-working columns on a light page.
  "high-contrast": { colorScheme: "light", tokens: HIGH_CONTRAST_LIGHT },
  "high-contrast-dark": { colorScheme: "dark", tokens: HIGH_CONTRAST_DARK },
};

/**
 * Keeps only the usable entries of a raw config-supplied token map: string values on custom-property
 * names (`--…`). Everything else is silently dropped. Returns `null` when nothing survives,
 * so an all-garbage preset never registers an empty name.
 */
function sanitizeTokens(raw: unknown): PresetTokens | null {
  if (typeof raw !== "object" || raw === null) return null;
  const out: Record<string, string> = {};
  let any = false;
  for (const [name, value] of Object.entries(raw)) {
    if (!name.startsWith("--")) continue;
    if (typeof value !== "string" || value.trim() === "") continue;
    out[name] = value.trim();
    any = true;
  }
  return any ? out : null;
}

/**
 * A preset as the plugin holds it: a token map plus the scheme it pins, `null` for "leave the pin
 * alone". Both accepted authoring forms — the flat token map and `{ colorScheme?, tokens }` —
 * normalize to this.
 */
export interface NormalizedPreset {
  readonly colorScheme: "light" | "dark" | null;
  readonly tokens: PresetTokens;
}

/** `"light"` / `"dark"` when the value is one of them, else `null` (unusable → dropped). */
function sanitizeScheme(value: unknown): "light" | "dark" | null {
  return value === "light" || value === "dark" ? value : null;
}

/**
 * Normalizes one authored preset. Accepts the flat token map and the `{ colorScheme?, tokens }`
 * object identically; returns `null` when no token survives sanitization, so an all-garbage preset
 * never registers an empty name.
 */
export function normalizePreset(raw: unknown): NormalizedPreset | null {
  if (typeof raw !== "object" || raw === null) return null;
  const objectForm = "tokens" in (raw as Record<string, unknown>);
  const source = objectForm ? (raw as { tokens?: unknown }).tokens : raw;
  const tokens = sanitizeTokens(source);
  if (tokens === null) return null;
  const colorScheme = objectForm
    ? sanitizeScheme((raw as { colorScheme?: unknown }).colorScheme)
    : null;
  return { colorScheme, tokens };
}

/**
 * Builds the full preset table: the built-ins, then the config-supplied presets layered over them
 * (a custom preset under a built-in name replaces that built-in wholesale — no per-token merge).
 * Unusable names and unusable token maps are silently dropped.
 */
export function buildPresetTable(custom: unknown): Map<string, NormalizedPreset> {
  const table = new Map<string, NormalizedPreset>();
  for (const [name, preset] of Object.entries(BUILT_IN_PRESETS)) {
    table.set(name, { colorScheme: preset.colorScheme ?? null, tokens: preset.tokens });
  }
  if (typeof custom === "object" && custom !== null) {
    for (const [name, raw] of Object.entries(custom)) {
      if (name.trim() === "") continue;
      const normalized = normalizePreset(raw);
      if (normalized !== null) table.set(name, normalized);
    }
  }
  return table;
}

/**
 * The slice of `CSSStyleDeclaration` inline-preset writing needs. Both methods are optional so the
 * writer degrades to a no-op on style objects that lack them (the unit-test fake DOM); in that
 * case `ThemeService.get`'s own preset layer still answers every canvas-side read.
 */
export interface InlineStyleLike {
  setProperty?(name: string, value: string): void;
  removeProperty?(name: string): void;
}

/**
 * Writes a preset switch to the chart root's inline style: removes the previous preset's
 * properties that the next one no longer sets, then sets the next one's values. `next === null`
 * clears back to the stylesheet, `previous === null` starts from a clean root.
 */
export function writeInline(
  style: InlineStyleLike,
  next: PresetTokens | null,
  previous: PresetTokens | null,
): void {
  if (previous !== null && typeof style.removeProperty === "function") {
    for (const name of Object.keys(previous)) {
      if (next === null || !(name in next)) style.removeProperty(name);
    }
  }
  if (next !== null && typeof style.setProperty === "function") {
    for (const [name, value] of Object.entries(next)) style.setProperty(name, value);
  }
}
