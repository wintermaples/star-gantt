// docs/specs/plugins/tree-grid.md § Config — theme-token colors.
/**
 * Color resolution: turns a configured color string into the value a canvas `fillStyle` can be
 * assigned. A 2D canvas resolves no CSS custom properties, so a token reference has to be looked
 * up through the theme service before it is painted; everything else is passed through verbatim.
 *
 * Parsing is done once per distinct string and cached, because the resolver runs per visible bar
 * per paint pass. Resolution itself is a cache lookup plus the theme service's own memoized token
 * map — no allocation, no string work.
 */
import type { ThemeService } from "@stargantt/plugin-view";

/** How deep a `var()` fallback chain is parsed before the remainder is taken as a literal. */
const MAX_FALLBACK_DEPTH = 4;

/** Upper bound on distinct color strings kept parsed; reached only by a pathological host. */
const MAX_PARSE_CACHE = 512;

interface TokenRef {
  /** The custom-property name, including the leading `--`. */
  readonly token: string;
  /** What to use when the token resolves empty, or `null` when the reference has no fallback. */
  readonly fallback: Parsed | null;
}

type Parsed =
  /** A plain CSS color, painted as written. */
  | { readonly kind: "literal"; readonly value: string }
  /** A custom-property reference that must be looked up before painting. */
  | { readonly kind: "token"; readonly ref: TokenRef }
  /** Empty, or a malformed `var()` — nothing paintable can come out of it. */
  | { readonly kind: "invalid" };

const INVALID: Parsed = { kind: "invalid" };

/**
 * Splits one color string into its paintable form. Both spellings of a custom-property reference
 * are understood: a bare token (`--sg-critical-bar`) and a `var()` wrapper with an optional fallback
 * (`var(--sg-critical-bar, #c00)`), the fallback itself possibly another reference.
 */
function parse(raw: string, depth: number): Parsed {
  const s = raw.trim();
  if (s === "") return INVALID;
  if (s.startsWith("var(")) {
    if (!s.endsWith(")")) return INVALID;
    const inner = s.slice(4, -1);
    const comma = inner.indexOf(",");
    const token = (comma === -1 ? inner : inner.slice(0, comma)).trim();
    if (!token.startsWith("--")) return INVALID;
    const rest = comma === -1 ? "" : inner.slice(comma + 1).trim();
    let fallback: Parsed | null = null;
    if (rest !== "") {
      fallback =
        depth >= MAX_FALLBACK_DEPTH ? { kind: "literal", value: rest } : parse(rest, depth + 1);
    }
    return { kind: "token", ref: { token, fallback } };
  }
  if (s.startsWith("--")) return { kind: "token", ref: { token: s, fallback: null } };
  return { kind: "literal", value: s };
}

/** Walks a parsed color to the value to paint, or `""` when nothing in the chain resolves. */
function resolveParsed(parsed: Parsed, theme: Pick<ThemeService, "get">): string {
  switch (parsed.kind) {
    case "literal":
      return parsed.value;
    case "invalid":
      return "";
    case "token": {
      // Iterative rather than recursive: this runs per bar per frame.
      let ref: TokenRef | null = parsed.ref;
      while (ref !== null) {
        const value = theme.get(ref.token);
        if (value !== "") return value;
        const fallback: Parsed | null = ref.fallback;
        if (fallback === null) return "";
        if (fallback.kind === "literal") return fallback.value;
        if (fallback.kind === "invalid") return "";
        ref = fallback.ref;
      }
      return "";
    }
    default: {
      const exhaustive: never = parsed;
      return exhaustive;
    }
  }
}

/** The CSS spelling of a parsed color; `""` when nothing paintable can come out of it. */
function cssOf(parsed: Parsed): string {
  switch (parsed.kind) {
    case "literal":
      return parsed.value;
    case "invalid":
      return "";
    case "token": {
      const fallback = parsed.ref.fallback;
      const inner = fallback === null ? "" : cssOf(fallback);
      return inner === "" ? `var(${parsed.ref.token})` : `var(${parsed.ref.token}, ${inner})`;
    }
    default: {
      const exhaustive: never = parsed;
      return exhaustive;
    }
  }
}

/**
 * The CSS spelling of a configured color, for the places the value is written into a stylesheet
 * rather than onto a canvas — CSS resolves custom properties by itself, so a bare token only has
 * to be wrapped. Returns `""` when the string cannot name a color at all.
 */
export function cssColor(raw: string): string {
  return cssOf(parse(raw, 0));
}

/** Resolves one configured color string for painting; `""` means "apply no color". */
export type ColorResolver = (raw: string) => string;

export interface ColorResolverDeps {
  /** The theme the custom-property references are looked up through. */
  theme: Pick<ThemeService, "get">;
  /**
   * Called the first time a given string fails to resolve, and never again for that same string,
   * so a per-bar-per-frame caller cannot flood the error channel.
   */
  onUnresolved: (raw: string) => void;
}

/**
 * Builds the color resolver. A literal color is returned as written; a custom-property reference
 * is looked up through the theme on every call, so a theme switch changes the painted color
 * without the rules being touched. A reference that resolves to nothing yields `""` — the caller
 * applies no color, exactly as it does for a color it cannot use — and is reported once.
 */
export function createColorResolver(deps: ColorResolverDeps): ColorResolver {
  const parsedCache = new Map<string, Parsed>();
  const reported = new Set<string>();
  return (raw: string): string => {
    let parsed = parsedCache.get(raw);
    if (parsed === undefined) {
      parsed = parse(raw, 0);
      // A host that streams new color strings must not grow the cache forever; the working set of
      // one paint pass is tiny, so dropping the whole cache is cheaper than tracking recency.
      if (parsedCache.size >= MAX_PARSE_CACHE) parsedCache.clear();
      parsedCache.set(raw, parsed);
    }
    const value = resolveParsed(parsed, deps.theme);
    if (value === "" && !reported.has(raw)) {
      reported.add(raw);
      deps.onUnresolved(raw);
    }
    return value;
  };
}
