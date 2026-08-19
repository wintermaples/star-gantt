/**
 * The grid's CSS-token geometry cache.
 *
 * The two numeric layout values the grid computes with live in the stylesheet as custom properties,
 * so a theme owns them; this module reads them back once and caches the result until the theme
 * changes. `getComputedStyle` forces layout, so the read never happens per frame.
 */
// docs/specs/plugins/tree-grid.md § Config — the token names and their role, and the theme-change
// invalidation the grid wires this cache to.
import { parsePx } from "@stargantt/sdk";

// docs/specs/plugins/tree-grid.md § Config — the fallback for `--sg-treegrid-toggle-width`, the
// expand-toggle gutter's base width. The stylesheet's declared value is the source of truth; this
// literal is what the geometry uses when the token cannot be read (no stylesheet,
// `injectStyles: false`, no `getComputedStyle`), and it is byte-identical to the registered value
// so the two can never paint differently.
export const TOGGLE_WIDTH_FALLBACK = 24;

// docs/specs/plugins/tree-grid.md § Config — the fallback for `--sg-treegrid-cell-padding`, the
// grid cell's horizontal padding. It is the base of the tree column's indent computation in the
// variant-A path (the column declares no width to compensate against) and the padding the 24 px
// content-box minimum column width is net of. Same source-of-truth rule as the gutter width above.
export const CELL_BASE_PADDING_FALLBACK_PX = 8;

/** The numeric layout tokens the grid computes with, read from CSS and cached. */
export interface GridTokens {
  /** `--sg-treegrid-toggle-width`: the expand-toggle gutter's base width, CSS px. */
  toggleWidth: number;
  /** `--sg-treegrid-cell-padding`: the grid cell's horizontal padding, CSS px. */
  cellPadding: number;
}

/** The cached token read, with the theme-change invalidation the grid drives it with. */
export interface GridTokenCache {
  /** The tokens, reading (and caching) them on first access after each invalidation. */
  get(): GridTokens;
  /** Drops the cache, so the next `get()` re-reads the tokens. */
  invalidate(): void;
}

/**
 * Reads the grid's layout tokens off `root`, caching them until `invalidate()` is called.
 *
 * A guarded raw `getComputedStyle` rather than a read through `stargantt.theme`: this plugin
 * declares no dependency on the theme service. A token that is absent or does not parse to a
 * positive length degrades to the built-in constant.
 */
export function createGridTokenCache(root: Element): GridTokenCache {
  /** `null` = not read yet, or dropped by a theme change; re-read on the next access. */
  let tokens: GridTokens | null = null;

  return {
    get(): GridTokens {
      if (tokens !== null) return tokens;
      const style =
        typeof globalThis.getComputedStyle === "function" ? globalThis.getComputedStyle(root) : null;
      const read = (token: string, fallback: number): number =>
        style === null ? fallback : parsePx(style.getPropertyValue(token).trim(), fallback);
      tokens = {
        toggleWidth: read("--sg-treegrid-toggle-width", TOGGLE_WIDTH_FALLBACK),
        cellPadding: read("--sg-treegrid-cell-padding", CELL_BASE_PADDING_FALLBACK_PX),
      };
      return tokens;
    },
    invalidate(): void {
      tokens = null;
    },
  };
}
