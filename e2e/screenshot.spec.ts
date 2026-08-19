import { expect, test } from "./_fixtures";
import { FIXED_TIME } from "./_fixtures";

// Screenshot regression E2E: pins the initial render of five representative example pages. Each
// page loads the built IIFE bundle (`packages/stargantt/dist/stargantt.iife.js`) and boots its own
// composition; a pixel diff against the checked-in baselines in
// `e2e/screenshot.spec.ts-snapshots/` catches unintended visual regressions in the canvas
// renderer, grid pane, time axis and CSS-variable theming.
//
// Baselines are this project's own renders, regenerated after visual review.
//
// Determinism measures:
// - Fixed viewport (set below) so layout and the virtualised visible range never vary.
// - `fixedTime: FIXED_TIME` pins `Date.now()` / `new Date()` BEFORE navigation.
// - `animations: "disabled"` plus the shared two-rAF `settle()` after the canvas appears
//   (`settle: true`), so we capture a fully painted, quiescent frame.
// - `maxDiffPixelRatio: 0.002` keeps the tolerance tight enough to catch real regressions while
//   absorbing minor sub-pixel antialiasing noise.
//
// Regenerate only with `--update-snapshots=all` (see CLAUDE.md §7), after visual review.

test.use({ viewport: { width: 1600, height: 1000 } });

// All five pages mount their chart into `#chart`; confirmed by reading each page under examples/
// before writing this spec.
const CONTAINER = "#chart";

const PAGES = [
  "hello.html",
  "basic-gantt.html",
  "theming-css-vars.html",
  "tree-grid-interaction.html",
  "dependencies-scheduling.html",
] as const;

for (const file of PAGES) {
  test.describe(`initial render of ${file}`, () => {
    test(`initial render of ${file} matches baseline`, async ({ page, openExample }) => {
      await openExample(file, {
        ready: `${CONTAINER} canvas`,
        fixedTime: FIXED_TIME,
        settle: true,
      });
      await expect(page).toHaveScreenshot(`${file.replace(/\.html$/, "")}.png`, {
        animations: "disabled",
        maxDiffPixelRatio: 0.002,
        fullPage: false,
      });
    });
  });
}
