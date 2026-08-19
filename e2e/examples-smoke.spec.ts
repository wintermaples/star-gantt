import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FIXED_TIME, expect, test } from "./_fixtures";

// This spec merges two smoke checks into one file: an all-pages smoke sweep with an index
// catalog-completeness check, and infrastructure smoke (hello.html boots the IIFE bundle;
// resources-load-chart.html boots its opt-in loadChart/side-panel plugins).
//
// Every demo page under examples/ is a plain, self-contained HTML file (own inline styles, own
// dataset, no shared chrome) that loads nothing but the built IIFE bundle; only index.html loads
// examples/site.js, which renders its sidebar and card grid (see site.js's own header comment). As
// a result:
//   - there is no sidebar-based page listing to check on a demo page; only index.html renders one,
//     and the catalog-completeness test below exercises the same underlying `CATALOG` array
//     index.html's sidebar and card grid both render from.
//   - there is no skip link on a demo page for a keyboard-navigation check; a11y-export.html itself
//     carries no skip link of its own (confirmed by reading the page). A real keyboard-navigation
//     test for a11y-export.html's own ARIA treegrid is out of scope for a smoke sweep and belongs
//     with a dedicated a11y feature spec.
//   - there is no injected per-page header to check, since nothing injects one on demo pages.
// The catalog-completeness check reads index.html's own rendered `.ex-card` grid directly (site.js's
// catalog is a plain JS array literal, so no comment parsing is needed); the per-page "loads,
// mounts a chart, clean console" sweep needs no shared chrome markup to also verify.

const EXAMPLES_DIR = fileURLToPath(new URL("../examples", import.meta.url));

const ALL_PAGES = readdirSync(EXAMPLES_DIR)
  .filter((f) => f.endsWith(".html"))
  .sort();

const DEMO_PAGES = ALL_PAGES.filter((f) => f !== "index.html");

/**
 * Deliberate `console.error` output a page is allowed to emit: map of file name to tolerated
 * message substrings. Empty — the sweep below found no page that needs one.
 */
const CONSOLE_ERROR_ALLOWLIST: Record<string, readonly string[]> = {};

// index.html's own script (site.js) renders the card grid from a single `CATALOG` array, the same
// array its sidebar renders from — so this one check also covers the sidebar's page listing, since
// both draw from the identical source.
test("index.html's catalog lists every demo page exactly once", async ({ page }) => {
  await page.goto("/examples/index.html");
  await page.locator(".ex-card").first().waitFor();

  const linked = (
    await page.locator(".ex-catalog .ex-card").evaluateAll((cards) =>
      cards.map((card) => (card.getAttribute("href") ?? "").replace("./", "")),
    )
  ).sort();

  expect([...new Set(linked)].sort()).toEqual(linked); // no duplicates
  expect(linked).toEqual(DEMO_PAGES);
});

for (const file of DEMO_PAGES) {
  test(`${file} loads with a mounted chart and a clean console`, async ({
    page,
    openExample,
  }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    // Default `ready: "canvas"` (openExample's default — see _fixtures.ts) is deliberately kept
    // here rather than a per-page container selector: every page swept composes its chart
    // synchronously at top-level script scope (confirmed by reading each page directly; a page
    // that instead deferred chart creation behind a button click would fail this smoke test with a
    // real, informative timeout rather than a false green).
    await openExample(file, { fixedTime: FIXED_TIME });
    const allowed = CONSOLE_ERROR_ALLOWLIST[file] ?? [];
    const unexpected = consoleErrors.filter((text) => !allowed.some((a) => text.includes(a)));
    expect(unexpected, "unexpected console.error output").toEqual([]);
  });
}

// --- Infrastructure smoke ---------------------------------------------------------------------
//
// Proves the E2E setup works end to end (the dev server serves the repo root, the example page
// loads the built IIFE bundle, StarGantt boots in a real browser) and, for resources-load-chart.html
// specifically, that its two opt-in surfaces (the resource plugin's loadChart band and the
// interaction plugin's side panel) actually mount. Both pages mount into `<div id="chart">`
// (confirmed by reading each page's markup).

test("hello example boots StarGantt from the IIFE bundle", async ({ page, openExample }) => {
  await openExample("hello.html", { ready: "#chart canvas" });
  // The IIFE bundle exposes the `StarGantt` global (docs/specs/architecture.md distribution
  // chapter).
  await expect
    .poll(async () => page.evaluate(() => typeof (window as any).StarGantt))
    .toBe("object");
});

test("resources-load-chart example boots with the loadChart band and the side panel composed", async ({
  page,
  openExample,
}) => {
  await openExample("resources-load-chart.html", { ready: "#chart canvas" });
  // `.sg-load-chart` (resource plugin's load-chart band root, BAND_CLASS) and `.sg-side-panel`
  // (interaction plugin's side-panel root) — the page composes both by default (`lanes: true` /
  // `total: true` in its own `rebuild()`, and `sidePanel: {}` unconditionally).
  await expect(page.locator(".sg-load-chart")).toBeAttached();
  await expect(page.locator(".sg-side-panel")).toBeAttached();
});
