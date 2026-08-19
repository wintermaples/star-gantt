/**
 * `src/internal/tokens.ts` — the CSS-token geometry cache, including the documented fallbacks and
 * the invalidation a theme change drives.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  CELL_BASE_PADDING_FALLBACK_PX,
  TOGGLE_WIDTH_FALLBACK,
  createGridTokenCache,
} from "../src/internal/tokens";
// The shared harness owns `getComputedStyle` and its live token map, so no hand-rolled global stub
// is needed here.
import { installDom } from "./_harness/index";
import type { DomHarness } from "./_harness/index";

let harness: DomHarness | undefined;

/**
 * Installs a `getComputedStyle` reporting `values`, or none at all for `null`, and hands back the
 * live token map so a restyle between reads is a plain write.
 */
function installStyle(values: Record<string, string> | null): Record<string, string> {
  harness?.restore();
  harness =
    values === null ? installDom({ noComputedStyle: true }) : installDom({ tokens: values });
  return harness.tokens;
}

afterEach(() => {
  harness?.restore();
  harness = undefined;
});

/** A stand-in for the element the tokens are read off; the cache only passes it through. */
const root = {} as unknown as Element;

describe("createGridTokenCache", () => {
  it("reads both layout tokens off the root", () => {
    installStyle({ "--sg-treegrid-toggle-width": " 30px ", "--sg-treegrid-cell-padding": "12px" });
    expect(createGridTokenCache(root).get()).toEqual({ toggleWidth: 30, cellPadding: 12 });
  });

  it("caches the read until it is invalidated", () => {
    const values = installStyle({
      "--sg-treegrid-toggle-width": "30px",
      "--sg-treegrid-cell-padding": "12px",
    });
    const cache = createGridTokenCache(root);
    expect(cache.get().toggleWidth).toBe(30);

    values["--sg-treegrid-toggle-width"] = "40px";
    expect(cache.get().toggleWidth).toBe(30);

    cache.invalidate();
    expect(cache.get().toggleWidth).toBe(40);
  });

  it("falls back to the built-in constants when a token is absent", () => {
    installStyle({});
    expect(createGridTokenCache(root).get()).toEqual({
      toggleWidth: TOGGLE_WIDTH_FALLBACK,
      cellPadding: CELL_BASE_PADDING_FALLBACK_PX,
    });
  });

  it("falls back for a token that does not parse to a positive length", () => {
    installStyle({ "--sg-treegrid-toggle-width": "auto", "--sg-treegrid-cell-padding": "-4px" });
    const tokens = createGridTokenCache(root).get();
    expect(tokens.toggleWidth).toBe(TOGGLE_WIDTH_FALLBACK);
    expect(tokens.cellPadding).toBe(CELL_BASE_PADDING_FALLBACK_PX);
  });

  it("falls back wholesale where `getComputedStyle` does not exist", () => {
    installStyle(null);
    expect(createGridTokenCache(root).get()).toEqual({
      toggleWidth: TOGGLE_WIDTH_FALLBACK,
      cellPadding: CELL_BASE_PADDING_FALLBACK_PX,
    });
  });
});
