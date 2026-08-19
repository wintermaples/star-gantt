// docs/specs/plugins/scheduling.md §7.3 — the four color fields are per-instance overrides that win
// over the corresponding CSS custom property; absent an override, the token is read through the
// `theme.get(token) || FALLBACK` consumer pattern via a narrow theme reader so this module stays
// testable without a host, with `ThemeReader` a `Pick` over the real `@stargantt/plugin-view`
// service type.
import type { ThemeService } from "@stargantt/plugin-view";

/** The one member this module reads from `stargantt.theme`. */
export type ThemeReader = Pick<ThemeService, "get">;

export const TOKEN_CRITICAL_BAR = "--sg-critical-bar";
export const TOKEN_NEAR_CRITICAL_BAR = "--sg-near-critical-bar";
export const TOKEN_NEGATIVE_FLOAT = "--sg-negative-float";
export const TOKEN_CRITICAL_FLOAT = "--sg-critical-float";

/** The documented default — also the value used when `stargantt.view`'s theme is not composed. */
export const FALLBACK_CRITICAL_BAR = "#c62828";
export const FALLBACK_NEAR_CRITICAL_BAR = "#ef6c00";
export const FALLBACK_NEGATIVE_FLOAT = "#7f1d1d";
export const FALLBACK_CRITICAL_FLOAT = "rgba(96, 125, 139, 0.3)";

/** The four config overrides this resolver reads (§11.4). */
export interface ColorOverrides {
  criticalColorOverride: string | undefined;
  nearCriticalColorOverride: string | undefined;
  negativeFloatColorOverride: string | undefined;
  floatColorOverride: string | undefined;
}

/** Resolves the four paint colors on demand, read fresh on every call (theme values may change). */
export interface ColorResolver {
  critical(): string;
  nearCritical(): string;
  negativeFloat(): string;
  float(): string;
}

/**
 * Builds the color resolver: config overrides win outright; otherwise the CSS custom property is
 * read through `theme`, falling back to the documented default when `theme` is `undefined` (the
 * view plugin is unavailable) or the token is unset.
 */
export function createColorResolver(
  config: ColorOverrides,
  theme: ThemeReader | undefined,
): ColorResolver {
  const tokenOr = (token: string, fallback: string): string =>
    (theme === undefined ? "" : theme.get(token)) || fallback;
  return {
    critical: (): string =>
      config.criticalColorOverride ?? tokenOr(TOKEN_CRITICAL_BAR, FALLBACK_CRITICAL_BAR),
    nearCritical: (): string =>
      config.nearCriticalColorOverride ?? tokenOr(TOKEN_NEAR_CRITICAL_BAR, FALLBACK_NEAR_CRITICAL_BAR),
    negativeFloat: (): string =>
      config.negativeFloatColorOverride ?? tokenOr(TOKEN_NEGATIVE_FLOAT, FALLBACK_NEGATIVE_FLOAT),
    float: (): string => config.floatColorOverride ?? tokenOr(TOKEN_CRITICAL_FLOAT, FALLBACK_CRITICAL_FLOAT),
  };
}
