/**
 * The theme module of `stargantt.view`.
 *
 * CSS custom properties on the root element are the single source of truth for every colour the
 * Canvas paints. This plugin reads them through `getComputedStyle(root)` in bulk, caches the
 * result into a token object, and — when the chart root's `class` or `data-theme` attribute
 * changes, or when `prefers-color-scheme` changes — re-reads and marks all renderer layers dirty.
 * Dark mode is therefore pure CSS.
 *
 * On top of that base it offers: a **per-chart colour-scheme pin**, so a palette that overrides
 * only part of the token set has the remainder resolve in the same scheme instead of following the
 * OS; opt-in **theme presets** — two bundled high-contrast palettes plus any the host supplies —
 * switchable at runtime; **diagnostics** that name a retired token or a partial palette at setup;
 * and opt-in `forced-colors` support that hands the canvas painters CSS system colours while
 * Windows High Contrast (or any forced-colors environment) is active.
 */
import { createStore } from "@stargantt/core";
import type { Disposable, PluginContext, Store, WritableStore } from "@stargantt/core";
import type { CanvasLayer, RenderModule } from "../render/index";
import { buildPresetTable, writeInline } from "./presets";
import type { InlineStyleLike, PresetTokens } from "./presets";
import { FORCED_COLORS_QUERY, forcedColorValue } from "./forced-colors";
import { watchMedia } from "./media";
import type { MediaQueryLike } from "./media";
import { CANVAS_READ_TOKENS, RETIRED_TOKENS } from "./registry";
import { applyColorScheme, asColorScheme } from "./scheme";
import type { SchemeTargetLike } from "./scheme";
import { diagnose, measureSchemeDefaults } from "./diagnostics";
import { auditPalette } from "./audit";
import type { ThemeConfig } from "../../config";
import type { ColorScheme, SetPresetOptions, ThemeAuditEntry } from "./types";

export { BUILT_IN_PRESETS, HIGH_CONTRAST_LIGHT, HIGH_CONTRAST_DARK } from "./presets";
export type { PresetTokens } from "./presets";
export { FORCED_COLOR_TOKENS } from "./forced-colors";
export { CANVAS_READ_TOKENS, NON_COLOR_CANVAS_TOKENS, RETIRED_TOKENS } from "./registry";
export type { ColorScheme, SetPresetOptions, ThemeAuditEntry, ThemePreset } from "./types";

/* ------------------------------------------------------------------ *
 * Public types (contract §3.13)
 * ------------------------------------------------------------------ */

// docs/specs/plugins/view.md
/**
 * Resolves theme tokens for the chart.
 *
 * CSS custom properties declared on the chart's root element are the single source of truth for
 * every colour drawn on the Canvas, as well as for the fonts and pixel-length constants used by
 * canvas text and geometry. The service additionally manages the chart's colour-scheme pin and its
 * named theme presets — bundled palettes plus any supplied in the plugin's config — which can be
 * applied and cleared at runtime.
 */
/** The canvas-read token set mapped to its currently resolved values. */
export type ThemeTokens = Readonly<Record<string, string>>;

export interface ThemeService {
  /**
   * Returns the current value of a CSS custom property on the chart root, trimmed — for example
   * `get("--sg-today-line")`. Returns an empty string when the property is unset or when no
   * computed style is available.
   *
   * The same method serves every token kind: a colour token resolves to its computed colour; a
   * font token (for example `get("--sg-header-font")`) resolves to a complete CSS `font` string,
   * meant to be assigned verbatim to a 2D canvas context's `font` property; a numeric token (for
   * example `get("--sg-selection-line-width")`) resolves to a CSS pixel length as text, and the
   * caller extracts the number itself — with `parseFloat`, falling back to its own default when
   * the string is empty or does not parse to a finite number — the same pattern used for colours
   * with `get(token) || FALLBACK`. All token kinds share the same bulk-read cache, so any one of
   * them is refreshed exactly like the colours are, on the same theme-change triggers.
   *
   * Two opt-in layers take precedence over the computed style, in this order: while a
   * forced-colors environment is active (and the plugin was configured to honour it), tokens the
   * plugin knows to be canvas-painted resolve to CSS system colors such as `"CanvasText"`; and
   * while a preset is applied, tokens the preset sets resolve to the preset's values.
   */
  get(token: string): string;

  /**
   * Measures the palette in force and reports one entry per documented relationship: the contrast
   * ratio of each figure/ground pair against the ratio it is expected to reach, and whether the
   * four row-state backgrounds still step away from the chart background in the right order.
   *
   * A translucent foreground is composited over its background before the ratio is measured, so a
   * palette written with `rgba()` is measured as it paints. A pair whose values cannot be read as
   * colours — an unset token, a system colour while forced colors is active — is left out of the
   * result rather than reported as passing.
   */
  audit(): readonly ThemeAuditEntry[];

  /**
   * Applies the named theme preset, or clears back to the plain stylesheet with `null`.
   *
   * Applying a preset makes `get` answer with the preset's values for the tokens it sets and, in
   * a real DOM, writes the same values as inline custom properties on the chart root so purely
   * CSS-styled parts (grid rows, tooltips, panes) follow the same switch. A preset that names a
   * colour scheme also pins it for as long as the preset is applied, ahead of any pin the chart
   * carries of its own — a palette is written for one scheme, and the chart returns to its own pin
   * when the preset is cleared. The change repaints the chart and sets the token store once.
   *
   * `options.mode` defaults to `"replace"`, which leaves only the named preset's tokens applied;
   * `"merge"` layers them over the tokens already applied, so a base palette can stay in place
   * while an accent group is swapped. An unknown name, a non-string, or re-applying the active
   * preset in `"replace"` mode does nothing.
   */
  setPreset(name: string | null, options?: SetPresetOptions): void;

  /** The name of the currently applied preset, or `null` when none is applied. */
  preset(): string | null;

  /**
   * The names of every preset that can be passed to `setPreset`: the bundled ones
   * (`"high-contrast"`, `"high-contrast-dark"`) plus any presets supplied in the plugin config.
   */
  presets(): readonly string[];

  /**
   * Pins this chart's colour scheme, or hands the choice back to the page with `"auto"`.
   *
   * A pinned chart resolves the library's whole default palette in that scheme, so the tokens a
   * host palette does *not* override can no longer come from the other scheme — which is what
   * makes a partial palette safe. The pin is per chart: two charts on one page can wear different
   * schemes. It is also mirrored onto the element's `color-scheme`, so the DOM inside the chart —
   * native scrollbars, form controls — follows the same choice.
   *
   * While a chart is pinned its tokens are declared on the chart element itself, so a host's own
   * token overrides must be written on a selector that matches that element rather than on
   * `:root`. Calling this with the scheme already in force does nothing.
   */
  setColorScheme(scheme: ColorScheme): void;

  /**
   * The colour-scheme pin the chart currently carries: the one an applied preset asks for, else the
   * one set through the config or {@link ThemeService.setColorScheme}, else `"auto"` when the chart
   * follows the page.
   */
  colorScheme(): ColorScheme;

  /**
   * Re-reads every token from the chart root, marks the canvas repainted, and announces the
   * change — the same three steps a `class` / `data-theme` change on the chart root already
   * triggers automatically. Call this after changing something *outside* the chart element that
   * its colours depend on: a `data-theme` attribute or class on an ancestor such as `<html>`, a
   * stylesheet swap, an injected `<style>` element, or anything else that changes what
   * `getComputedStyle` reports for the chart root without mutating an attribute of the root
   * itself. The chart only watches its own element for theme-relevant attribute changes and the
   * `prefers-color-scheme` / forced-colors media queries — it does not, and will not, watch
   * ancestors or arbitrary stylesheets, so propagating an outside change to the chart is the
   * host's responsibility, and this method is how the host discharges it. Calling it when nothing
   * actually changed is harmless: the tokens are re-read to the same values, the canvas repaints
   * to the same pixels, and the change is still announced once.
   */
  refresh(): void;

  /**
   * Every token a canvas painter reads, mapped to the value it currently resolves to.
   *
   * This is the set a palette has to cover to be self-contained — a token left out of a palette
   * keeps whatever the stylesheet resolves for it; tokens consumed only by the library's own CSS
   * (grid rows, tooltips, panes) are deliberately not in it, since DOM content follows the
   * stylesheet whether a palette is applied or not. The names alone are `Object.keys` of the
   * value.
   *
   * The store is set once per theme change — a `class` / `data-theme` mutation on the chart root, a
   * `prefers-color-scheme` flip, a preset or scheme application, a forced-colors flip, or
   * `refresh()` — with the freshly re-read values, after the three canvas layers have been marked
   * dirty. A canvas outside those layers repaints from this subscription.
   */
  readonly tokens: Store<ThemeTokens>;
}

/* ------------------------------------------------------------------ *
 * Implementation
 * ------------------------------------------------------------------ */

/** The three canvases; all of them are marked dirty on a theme change. */
const ALL_LAYERS: readonly CanvasLayer[] = ["background", "main", "overlay"];

/**
 * Creates the theme module: it reads the chart's CSS custom properties once per paint and re-reads
 * them, repainting, when the page's theme changes. Optionally it pins the chart's colour scheme,
 * applies a named theme preset (bundled palettes or presets supplied here) and honours
 * forced-colors environments.
 */
export function createThemeModule(
  ctx: PluginContext,
  config: ThemeConfig,
  render: RenderModule,
): ThemeService {
  // docs/specs/plugins/view.md — CSS custom properties are the single source of truth for colour;
  // a theme change invalidates every canvas layer.
  const root = ctx.root;

  // docs/specs/plugins/view.md — the preset table is fixed at setup:
  // built-ins plus sanitized config presets.
  const presetTable = buildPresetTable(config.presets);
  let presetName: string | null = null;
  let presetTokens: PresetTokens | null = null;
  let presetScheme: "light" | "dark" | null = null;

  // docs/specs/plugins/view.md — two pins, one winner: an applied preset's pin
  // outranks the host's, which is what the element falls back to when the preset is cleared.
  // `appliedScheme` is what the element actually wears.
  let hostScheme: ColorScheme = asColorScheme(config.colorScheme) ?? "auto";
  let appliedScheme: ColorScheme = "auto";

  // docs/specs/plugins/view.md — forced-colors is a latched boolean derived
  // from the media query; it stays `false` forever unless the config opted in.
  let forcedActive = false;

  /**
   * The token object. `null` means "stale": the next read performs one bulk
   * `getComputedStyle(root)` and memoises every token asked for until the next invalidation.
   */
  let computed: CSSStyleDeclaration | null = null;
  let tokens = new Map<string, string>();

  function invalidateCache(): void {
    computed = null;
    tokens = new Map<string, string>();
  }

  /** The chart root's own computed value for a property, with no preset or forced-colors layer. */
  function readComputed(token: string): string {
    if (computed === null) {
      if (typeof globalThis.getComputedStyle !== "function") return "";
      computed = globalThis.getComputedStyle(root);
    }
    return computed.getPropertyValue(token).trim();
  }

  // docs/specs/plugins/view.md
  // `read` is the single string-valued reader for every token kind (colour, font, numeric px
  // length). It stays generic on purpose: fonts are used verbatim by the caller and numeric
  // tokens are parsed by the caller with `parseFloat`, so this function does no kind-specific
  // work and no typed accessor is added here.

  // Precedence (docs/specs/plugins/view.md): forced-colors system
  // palette (strongest — mirrors how forced-colors overrides author CSS), then the applied
  // preset, then the computed style. All three answer through the same memo, which every refresh
  // trigger clears, so a state flip can never serve stale values.
  function read(token: string): string {
    const hit = tokens.get(token);
    if (hit !== undefined) return hit;
    let value: string | undefined;
    if (forcedActive) value = forcedColorValue(token);
    if (value === undefined && presetTokens !== null) value = presetTokens[token];
    if (value === undefined) value = readComputed(token);
    tokens.set(token, value);
    return value;
  }

  /** The canvas-read tokens as they resolve right now — the value the store publishes. */
  function snapshotTokens(): ThemeTokens {
    const out: Record<string, string> = {};
    for (const token of CANVAS_READ_TOKENS) out[token] = read(token);
    return out;
  }

  /**
   * The published snapshot. Created at the end of `setup`, once the config pin and the config
   * preset are in force, so the first value a subscriber ever reads is the palette the chart
   * actually paints with.
   */
  let tokensStore: WritableStore<ThemeTokens> | null = null;

  /** Re-read the tokens, mark every layer dirty and publish the change. */
  function refresh(): void {
    invalidateCache();
    for (const layer of ALL_LAYERS) render.invalidate(layer);
    // docs/specs/plugins/view.md — the store is set after the layers are marked dirty, carrying
    // the freshly re-read values. Canvases that are not renderer layers (the timeline header)
    // cannot be reached by `invalidate`; this subscription is their repaint signal. It stays
    // `null` for the length of `setup` alone, where nothing can be subscribed yet.
    tokensStore?.set(snapshotTokens());
  }

  // --- `class` / `data-theme` change on the root element (§3.6) ---
  // docs/specs/plugins/view.md
  // exactly these two attribute names, in this order. Both are equal triggers running the
  // same refresh; neither the old nor the new value is inspected, because this plugin never
  // interprets what a class or a `data-theme` value *means* — only that the root's styling inputs
  // may have moved. `data-theme` is here because the common host convention for a manual
  // light/dark switch is `<html data-theme="dark">` rather than a class; before such a host
  // got new CSS values but no cache invalidation. Only the root is observed (no `subtree`, no
  // ancestors): a host that flips the attribute on `<html>`/`<body>` mutates no attribute of the
  // root itself and must flip it on the chart root too, a limitation inherited from the
  // pre-existing `class` behaviour and deliberately not widened here. A preset's inline write
  // touches only the `style` attribute, which this filter excludes, so applying a preset cannot
  // echo through the observer.

  // docs/specs/plugins/view.md — the scheme pin, unlike a preset's
  // inline write, *does* touch `class`. `writingScheme` and the queue drain below are what keep
  // the plugin's own class write from echoing back as a second refresh: the flag covers an
  // observer that reports synchronously, the drain covers the real DOM's microtask delivery.
  let writingScheme = false;
  let observer: MutationObserver | null = null;
  if (typeof globalThis.MutationObserver === "function") {
    observer = new globalThis.MutationObserver(() => {
      if (writingScheme) return;
      refresh();
    });
    observer.observe(root, { attributes: true, attributeFilter: ["class", "data-theme"] });
    const mo = observer;
    ctx.own({ dispose: () => mo.disconnect() });
  }

  /** Writes the pin to the element without letting the write trigger a refresh of its own. */
  function writeScheme(next: ColorScheme): void {
    if (next === appliedScheme) return;
    appliedScheme = next;
    writingScheme = true;
    try {
      applyColorScheme(root as unknown as SchemeTargetLike, next);
      observer?.takeRecords();
    } finally {
      writingScheme = false;
    }
  }

  // docs/specs/plugins/view.md — the applied preset's own pin
  // wins over the host's. A preset's tokens are authored for one scheme, and letting the host pin
  // override it painted a dark palette onto a light-scheme element: every token the preset sets
  // came out dark while every surface it does not set resolved light, which is the partial-palette
  // hazard the pin exists to prevent, reintroduced from the other side.
  /** Re-derives which pin wins (preset over host) and writes it to the element. */
  function syncScheme(): void {
    writeScheme(presetScheme ?? (hostScheme !== "auto" ? hostScheme : "auto"));
  }

  // docs/specs/plugins/view.md — apply/clear a preset. The inline write
  // covers purely CSS-consumed tokens in a real DOM; `read`'s preset layer covers the canvas
  // painters everywhere (including environments whose style object lacks `setProperty`).
  /** Removes the applied preset's inline write and resets the three fields tracking it. */
  function clearPresetState(): void {
    writeInline(root.style as InlineStyleLike, null, presetTokens);
    presetName = null;
    presetTokens = null;
    presetScheme = null;
  }

  function setPreset(name: string | null, options?: SetPresetOptions): void {
    const merge = options?.mode === "merge";
    if (name === null) {
      if (presetName === null) return;
      clearPresetState();
      syncScheme();
      refresh();
      return;
    }
    if (typeof name !== "string") return;
    if (!merge && name === presetName) return;
    const next = presetTable.get(name);
    if (next === undefined) return; // unusable value, silently ignored
    // "merge" layers the named preset over what is already applied; "replace" drops the rest.
    const applied: PresetTokens =
      merge && presetTokens !== null ? { ...presetTokens, ...next.tokens } : next.tokens;
    writeInline(root.style as InlineStyleLike, applied, presetTokens);
    presetName = name;
    presetTokens = applied;
    presetScheme = next.colorScheme;
    syncScheme();
    refresh();
  }

  function setColorScheme(scheme: ColorScheme): void {
    const wanted = asColorScheme(scheme);
    if (wanted === null || wanted === hostScheme) return;
    hostScheme = wanted;
    const before = appliedScheme;
    syncScheme();
    if (appliedScheme !== before) refresh();
  }

  // --- `prefers-color-scheme` change (§3.6) / `forced-colors` change (§7) ---
  if (typeof globalThis.matchMedia === "function") {
    const scheme = globalThis.matchMedia("(prefers-color-scheme: dark)") as MediaQueryLike;
    const unwatchScheme = watchMedia(scheme, () => refresh());

    // docs/specs/plugins/view.md — the watch exists only when the config
    // opted in, so the default composition takes no forced-colors code path at all.
    let unwatchForced: (() => void) | null = null;
    if (config.forcedColors === true) {
      const forced = globalThis.matchMedia(FORCED_COLORS_QUERY) as MediaQueryLike;
      forcedActive = forced.matches === true;
      unwatchForced = watchMedia(forced, () => {
        const now = forced.matches === true;
        if (now === forcedActive) return;
        forcedActive = now;
        refresh();
      });
    }

    const d: Disposable = {
      dispose: () => {
        unwatchScheme();
        unwatchForced?.();
        unwatchForced = null;
      },
    };
    ctx.own(d);
  }

  // docs/specs/architecture.md §1.4 — the `ctx.own` ownership rule:
  // the inline preset layer and the scheme class both live on the host's own root element, which
  // outlives the chart, so both are removed on disposal exactly as clearing them would.
  ctx.own({
    dispose: () => {
      if (presetTokens !== null) clearPresetState();
      // Route through `writeScheme` rather than writing the class directly: it is the one place
      // that guards re-entrancy (`writingScheme`) and drains the observer's queued records, and
      // bypassing it here would let the class write echo back through the `MutationObserver` as
      // a spurious `refresh()` firing after the plugin has already begun disposing.
      writeScheme("auto");
    },
  });

  // The config pin lands first and the config preset second, and applying a preset runs
  // `syncScheme` itself, so the preset's own pin is in force by the time the module is built.
  syncScheme();

  // docs/specs/plugins/view.md — the config-selected preset is applied at setup; an unknown name
  // falls through `setPreset`'s guard.
  if (typeof config.preset === "string") setPreset(config.preset);

  tokensStore = createStore<ThemeTokens>(snapshotTokens());

  const service: ThemeService = {
    get: (token: string): string => read(token),
    audit: () => auditPalette(read),
    setPreset,
    preset: () => presetName,
    presets: () => [...presetTable.keys()],
    setColorScheme,
    colorScheme: () => appliedScheme,
    // docs/specs/plugins/view.md — public alias of the existing
    // internal refresh(); the host's escape hatch for a theme-relevant change the plugin's own
    // observers cannot see (an ancestor attribute, a stylesheet swap).
    refresh: () => refresh(),
    tokens: tokensStore,
  };

  scheduleDiagnostics();

  // docs/specs/plugins/view.md — the checks are deferred to a timer rather
  // than run inline: they read computed styles and briefly mount two probe elements, and doing that
  // during `setup` would force a style flush before the chart's first paint. Nothing they report
  // is time-critical, so they wait until the first frame is out.
  function scheduleDiagnostics(): void {
    if (config.diagnostics === false) return;
    if (typeof globalThis.setTimeout !== "function") return;
    const handle = globalThis.setTimeout(() => runDiagnostics(), 0);
    ctx.own({ dispose: () => globalThis.clearTimeout(handle) });
  }

  /**
   * The two warnings. They run after the pin and the config preset are in place, so what they
   * measure is the palette the chart actually paints with, and they never change it.
   */
  function runDiagnostics(): void {
    if (typeof globalThis.getComputedStyle !== "function") return;
    // The deferred run may land after a repaint, so the cache is dropped first: `readComputed`
    // must report what the chart resolves now, not what it resolved at setup.
    invalidateCache();
    const probes = measureSchemeDefaults(
      root as unknown as Parameters<typeof measureSchemeDefaults>[0],
      CANVAS_READ_TOKENS,
    );
    const messages = diagnose({
      tokens: CANVAS_READ_TOKENS,
      readRoot: readComputed,
      readLight: probes?.readLight ?? ((): string => ""),
      readDark: probes?.readDark ?? ((): string => ""),
      // With no probes there is nothing to compare against, so the partial-palette check is
      // skipped rather than guessed at; the retired-token check needs no probe and still runs.
      schemePinned: appliedScheme !== "auto" || probes === null,
      retired: RETIRED_TOKENS,
    });
    for (const message of messages) console.warn(`[StarGantt] theme: ${message}`);
  }

  return service;
}
