import { expect, test } from "./_fixtures";
import { settle } from "./_fixtures";
import type { Page } from "@playwright/test";

/** Waits for `selector`'s box to stop changing — the injected `<style>` tag below resizes the
 *  chart pane through a `ResizeObserver`, whose callback timing a fixed sleep would only guess at
 *  (see e2e/resources-load-chart.spec.ts's `settleLayout` for the same rationale, copied here in
 *  miniature since this file needs it for one box only). */
async function settleBox(page: Page, selector: string): Promise<void> {
  await page.evaluate(async (sel) => {
    const frame = (): Promise<void> => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const read = (): string | null => {
      const el = document.querySelector(sel);
      if (el === null) return null;
      const box = el.getBoundingClientRect();
      return `${String(box.x)},${String(box.y)},${String(box.width)},${String(box.height)}`;
    };
    let previous = read();
    if (previous === null) return;
    for (let i = 0; i < 120; i += 1) {
      await frame();
      const current = read();
      if (current !== null && current === previous) return;
      previous = current;
    }
  }, selector);
}

// Feature E2E for tooltip placement, driven by examples/zoom-levels.html.
//
// interaction.md §6.6 fixes the panel's visible area as the browser viewport **intersected with
// every ancestor that clips its overflow**. The tooltip is mounted
// inside the chart pane, which is `overflow: hidden`, so a pane edge that lies well inside the
// window bounds the panel exactly as the window edge would. e2e/interaction.spec.ts's own
// "tooltip" describe block only proves the panel shows and Escape hides it — it never checks WHERE
// the panel lands, so this pane-vs-window clamp is genuinely new coverage, not a duplicate.
//
// A window-only bound is not a theoretical shortcut: with the page's own content filling the
// window, the chart pane's right edge is normally at or near the window edge, so no flip fires and
// the absolutely positioned panel would be silently re-squeezed by its containing block after its
// `left` is applied — it wraps into a tall sliver and is clipped away. That is only observable in a
// real layout, which is why it lives here rather than in the plugin's unit tests. A `<style>` tag
// narrows the page's own content column below — `body` plays that role here since `#chart` has no
// explicit width of its own and simply fills its containing block.
//
// The sweep does not assume a bar sits at any particular coordinate: it presses at a series of
// offsets in from the pane's right edge and checks the invariant for every tooltip that actually
// opens, requiring at least one to have opened so the test cannot pass vacuously.
//
// Timing: the page leaves the tooltip's `trigger` at its default `"click"` (interaction.md §6.6),
// so the panel is shown synchronously from the pointer-down handler — including its
// measure-and-place pass. There is no delay to wait out on this path, so each probe only needs the
// frame the show belongs to (`settle()`) before its state can be read; dismissal is a web-first
// `toBeHidden()` assertion, which additionally *proves* the Escape dismissal happened instead of
// assuming a sleep outlasted it.

const PAGE = "zoom-levels.html";

const PANE = ".sg-pane--chart";
const TOOLTIP = ".sg-tooltip";
const GRID_ROW = ".sg-grid-row";

// Wide enough that the chart pane's right edge can sit comfortably inside the window — the
// geometry that separates a pane-aware clamp from a window-only one.
test.use({ viewport: { width: 1900, height: 1000 } });

test("the tooltip stays inside the chart pane, not merely inside the window", async ({
  page,
  openExample,
}) => {
  await openExample(PAGE, { ready: `${PANE} canvas` });

  // Leave real window space to the right of the chart. Without it the pane's right edge *is* the
  // window's, and a tooltip clamped only to the window would pass this test by accident.
  await page.addStyleTag({ content: "body { max-width: 1200px; }" });
  await settleBox(page, PANE);

  const pane = await page.locator(PANE).boundingBox();
  expect(pane).not.toBeNull();
  if (pane === null) return;

  // The chart rows line up with the grid rows, so a grid row gives a y that lands on a bar without
  // reaching into canvas internals.
  const rows = page.locator(GRID_ROW);
  const rowCount = await rows.count();
  expect(rowCount).toBeGreaterThan(0);

  const viewportWidth = page.viewportSize()?.width ?? 0;
  expect(pane.x + pane.width).toBeLessThan(viewportWidth - 100);

  const tip = page.locator(TOOLTIP).first();
  let opened = 0;

  for (let row = 0; row < Math.min(rowCount, 4); row += 1) {
    const rowBox = await rows.nth(row).boundingBox();
    if (rowBox === null) continue;
    const y = rowBox.y + rowBox.height / 2;

    for (const dx of [5, 20, 40, 80, 150, 260]) {
      const x = pane.x + pane.width - dx;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.up();
      // The show is synchronous with the press; one frame turn is all the panel's placement needs
      // before its box is the one the user would see.
      await settle(page);

      // Deliberately the non-retrying check: whether this probe hit a bar at all is already
      // decided by now, and retrying would only wait out the six misses.
      if ((await tip.count()) === 0 || !(await tip.isVisible())) continue;
      const box = await tip.boundingBox();
      if (box === null) continue;
      opened += 1;

      // Fully inside the pane's clip box on both axes. A half-pixel of slack absorbs the
      // fractional layout positions the browser reports.
      expect(box.x).toBeGreaterThanOrEqual(pane.x - 0.5);
      expect(box.x + box.width).toBeLessThanOrEqual(pane.x + pane.width + 0.5);
      expect(box.y).toBeGreaterThanOrEqual(pane.y - 0.5);
      expect(box.y + box.height).toBeLessThanOrEqual(pane.y + pane.height + 0.5);

      // Kept at its natural size rather than re-squeezed into a wrapped column: the single-line
      // panel is well under two lines tall whatever the anchor.
      expect(box.height).toBeLessThan(48);

      // Dismiss before the next probe so each anchor is measured from a clean state. Asserting the
      // panel is actually gone also pins Escape dismissal (WCAG 1.4.13) — a sleep here would have
      // let a broken dismissal through as long as the next probe re-opened a panel.
      await page.keyboard.press("Escape");
      await expect(tip).toBeHidden();
    }
  }

  expect(opened).toBeGreaterThan(0);
});
