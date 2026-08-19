import { expect, test } from "./_fixtures";
import type { Page } from "@playwright/test";

// Feature E2E for the host `color-scheme` override path — page-agnostic, since it operates on
// `document.documentElement` rather than chart internals — pointed at `examples/hello.html`.
//
// The bundled stylesheet declares its scheme-dependent tokens once, as `light-dark(<light>,
// <dark>)`, and puts `color-scheme: light dark` on the document root at zero specificity
// (packages/stargantt/src/styles/layout.css confirms `--sg-bg`/`--sg-fg` resolve exactly this way:
// `light-dark(#ffffff, #1a1917)` / `light-dark(#1c1917, #e7e5e4)`, matching the REGISTRY below). A
// page that declares nothing therefore follows the OS, and a host that wants to pin the scheme
// writes one declaration — `:root { color-scheme: dark }` — which wins and flips every token.
//
// `readonly.spec.ts`'s theme describe block pins the chart's OWN scheme through
// `ThemeService.setColorScheme()` (`theming.spec.ts`, the sibling of this file, covers the same
// per-chart mechanism); this file is about the page-wide `:root` declaration a host writes with no
// chart API call at all, and pins the browser context against the OS so the two mechanisms (host
// CSS vs. OS preference) are distinguishable rather than coincidentally agreeing.
//
// `hello.html` is the smallest page that mounts a chart with the stock preset
// (`presetStandard()`) and overrides no `--sg-*` token of its own, so what the root computes is
// the library's own default palette.
const REGISTRY = {
  "--sg-bg": { light: "#ffffff", dark: "#1a1917" },
  "--sg-fg": { light: "#1c1917", dark: "#e7e5e4" },
} as const;

type Token = keyof typeof REGISTRY;
type Scheme = "light" | "dark";

const TOKENS = Object.keys(REGISTRY) as Token[];

/** Parses `rgb(r, g, b)` / `rgba(...)` / `#rrggbb` into a triple so authored hex and computed
 *  `rgb()` can be compared without depending on either serialisation. */
function parseColor(css: string): [number, number, number] {
  const rgb = css.match(/rgba?\(([^)]+)\)/);
  if (rgb !== null && rgb[1] !== undefined) {
    const parts = rgb[1].split(",").map((p) => parseFloat(p.trim()));
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  }
  const hex = css.trim().match(/^#([0-9a-f]{6})$/i);
  if (hex !== null && hex[1] !== undefined) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  throw new Error(`unparseable color: ${css}`);
}

/** Reads the registry tokens off the document root, resolved. */
async function readTokens(
  page: Page,
): Promise<{ colorScheme: string; tokens: Record<string, string> }> {
  return page.evaluate((names: string[]) => {
    const style = getComputedStyle(document.documentElement);
    const tokens: Record<string, string> = {};
    for (const name of names) tokens[name] = style.getPropertyValue(name).trim();
    return { colorScheme: style.colorScheme, tokens };
  }, TOKENS as unknown as string[]);
}

function expectScheme(tokens: Record<string, string>, scheme: Scheme, label: string): void {
  for (const token of TOKENS) {
    expect(parseColor(tokens[token] ?? ""), `${label}: ${token}`).toEqual(
      parseColor(REGISTRY[token][scheme]),
    );
  }
}

/**
 * Opens an example, checks the tokens follow the OS while nothing is pinned, then applies the
 * contract's host declaration and checks they follow the host instead.
 */
async function expectHostPinWins(page: Page, os: Scheme, pinned: Scheme): Promise<void> {
  // Control: with no host declaration the OS still selects the scheme. This is what makes a
  // failure below readable — it separates "the override is ignored" from "the tokens are broken".
  const before = await readTokens(page);
  expect(before.colorScheme, "unpinned: the root offers both schemes").toBe("light dark");
  expectScheme(before.tokens, os, `unpinned, OS prefers ${os}`);

  // The override path exactly as theme.md §4.2 documents it: one declaration on `:root`. It beats
  // the library's `:where(:root)` on specificity alone, so it does not depend on injection order.
  await page.addStyleTag({ content: `:root { color-scheme: ${pinned} }` });

  const after = await readTokens(page);
  // Asserted first, and separately: if the browser did not honour the pin at all then the token
  // assertions below would be measuring the wrong thing.
  expect(after.colorScheme, "the host pin reaches the computed color-scheme").toBe(pinned);
  expectScheme(after.tokens, pinned, `OS prefers ${os}, host pins ${pinned}`);
}

test.describe("the OS prefers light", () => {
  test.use({ colorScheme: "light" });

  test("a host pinning color-scheme: dark gets the dark tokens", async ({ openExample, page }) => {
    await openExample("hello.html");
    await expectHostPinWins(page, "light", "dark");
  });
});

test.describe("the OS prefers dark", () => {
  test.use({ colorScheme: "dark" });

  test("a host pinning color-scheme: light gets the light tokens", async ({
    openExample,
    page,
  }) => {
    await openExample("hello.html");
    await expectHostPinWins(page, "dark", "light");
  });
});
