import { expect, test } from "./_fixtures";
import type { Page } from "@playwright/test";

// E2E for the load chart's per-resource lanes strip on examples/resources-load-chart.html.
//
// Structural note (verified against packages/plugins/resource/src/internal/load-chart/lanes-view.ts
// and band-view.ts before writing any selector below): the lanes strip draws bars, the reference
// line and per-run value labels on ONE CANVAS per strip — only the strip container, its
// `role="group"` scroll surface, one `role="img"` proxy per lane (`.sg-load-lanes__lane`) and the
// gutter name node (`.sg-load-lanes__label`, only when the gutter column has width) are real DOM.
// Assertions below are therefore canvas-paint-presence/paint-difference checks (the
// `hasPaintedPixel`-style precedent resource.spec.ts already established for this plugin's
// canvas-drawn surfaces) rather than exact per-bar/per-label pixel geometry, which would need a
// column-by-column canvas pixel scan beyond this batch's effort budget — noted per assertion below.
//
// Page note: examples/resources-load-chart.html has no debug state handle — every lane-related
// toggle (`#lane-ratio`/`#lane-shared`/`#lane-auto`, `#total-toggle`, `#lane-values-toggle`) is a
// SETUP-TIME option that disposes and fully rebuilds the `gantt` instance (the page's own header
// comment explains why). So `window.gantt` itself is reassigned by every toggle click, and this
// file always re-reads `gantt` fresh (never caches a handle across a click) and re-waits for the
// rebuilt canvas/lanes DOM rather than expecting an in-place repaint. State is read back through the
// toolbar's own `aria-pressed` attributes and the `#lane-readout` text (the page's own source of
// truth for "what did the last rebuild actually compose"), not through a debug window property.
//
// Overlap with e2e/resource.spec.ts: that file's "load chart" describe block already covers strip
// stacking order (resource-view/band/lanes top-to-bottom) and lanesVisible/setLanesVisible/
// lanesHeight/setLanesHeight service mechanics on examples/resource.html. NOT covered there, and
// covered here instead (this page's own reason for existing): per-lane aria-labelling, lane-to-band
// bucket x-alignment, gutter-name scroll-pinning, the `laneScale` toolbar (`ratio`/`shared`/`auto`
// — resource.spec.ts's header explicitly defers "`laneScale` variants other than the default
// `ratio`"), the total-band release-to-zero-height toggle, and the laneValueLabels toggle.
//
// No screenshot assertions: this page has no baseline image checked in.

const PAGE = "resources-load-chart.html";
const PANE = ".sg-pane--chart";
const BAND = ".sg-load-chart";
const LANES = ".sg-load-lanes";
const LANE = ".sg-load-lanes__lane";

declare const gantt: {
  service(key: "stargantt.view"): {
    viewport: { get(): { scrollTop: number; scrollLeft: number } };
  };
};

async function boot(page: Page, openExample: import("./_fixtures").OpenExample): Promise<void> {
  await openExample(PAGE, { ready: `${PANE} canvas` });
  await expect(page.locator(LANE).first()).toBeVisible();
}

/** Clicks a toolbar button that rebuilds the instance, then waits for the rebuilt lanes strip. */
async function rebuildVia(page: Page, buttonId: string): Promise<void> {
  await page.locator(`#${buttonId}`).click();
  await expect(page.locator(`${PANE} canvas`).first()).toBeVisible();
  await expect(page.locator(LANE).first()).toBeVisible();
}

/** A content hash of one canvas, so two renders can be compared without decoding pixels. */
async function canvasFingerprint(page: Page, selector: string): Promise<string> {
  return page.evaluate((sel) => {
    const canvas = document.querySelector(sel);
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error(`no canvas at ${sel}`);
    return canvas.toDataURL();
  }, selector);
}

test("draws one named lane per resource, stacked below the aggregate band and the chart canvas", async ({
  page,
  openExample,
}) => {
  await boot(page, openExample);

  await expect(page.locator(LANES)).toBeVisible();
  await expect(page.locator(LANE)).toHaveCount(3);
  await expect(page.locator(".sg-load-lanes__label")).toHaveText(["Alice", "Bob", "Carol"]);

  // Stacking order: lanes below the band, band below the chart's own canvases.
  const boxes = await page.evaluate(
    ([paneSel, bandSel, lanesSel]) => {
      const rect = (selector: string): DOMRect | null => {
        const el = document.querySelector(selector);
        return el === null ? null : el.getBoundingClientRect();
      };
      const canvas = rect(`${paneSel} canvas`);
      return { canvasBottom: canvas === null ? 0 : canvas.bottom, band: rect(bandSel), lanes: rect(lanesSel) };
    },
    [PANE, BAND, LANES] as const,
  );
  expect(boxes.band).not.toBeNull();
  expect(boxes.lanes).not.toBeNull();
  expect(boxes.lanes!.top).toBeGreaterThanOrEqual(boxes.band!.bottom - 1);
  expect(boxes.band!.top).toBeGreaterThanOrEqual(boxes.canvasBottom - 1);
});

test("is a keyboard-reachable labelled group, and each lane names its own resource with a load summary", async ({
  page,
  openExample,
}) => {
  await boot(page, openExample);

  const strip = page.locator(LANES);
  await expect(strip).toHaveAttribute("role", "group");
  await expect(strip).toHaveAttribute("tabindex", "0");
  // messages.ts's `lanesLabel` default: "Resource load by resource, {N} resources."
  await expect(strip).toHaveAttribute("aria-label", /3 resources/);

  // Every lane carries its own generated name and a numeric overload count (messages.ts's
  // `laneLabel` default always reports "{N} overloaded", so this checks the count is well-formed
  // and resource-specific rather than hardcoding which of this page's three resources is over —
  // this page's own dataset (alice/bob/carol, 8 overlapping assignments), and the per-resource
  // overload arithmetic is a scheduling/utilization concern, not a lanes-rendering one.
  const names = ["Alice", "Bob", "Carol"];
  for (let i = 0; i < names.length; i += 1) {
    const lane = page.locator(LANE).nth(i);
    await expect(lane).toHaveAttribute("role", "img");
    const label = await lane.getAttribute("aria-label");
    expect(label).not.toBeNull();
    expect(label).toContain(names[i]);
    expect(label).toMatch(/\d+ overloaded/);
  }
});

test("keeps the gutter lane names pinned while the chart scrolls sideways", async ({ page, openExample }) => {
  await boot(page, openExample);

  const labelLeft = async (): Promise<number> =>
    page.evaluate(() => {
      const el = document.querySelector(".sg-load-lanes__label");
      if (el === null) throw new Error("lane label is missing");
      return el.getBoundingClientRect().left;
    });

  const before = await labelLeft();
  await page.locator(PANE).hover();
  await page.mouse.wheel(600, 0);
  await expect
    .poll(async () => page.evaluate(() => gantt.service("stargantt.view").viewport.get().scrollLeft))
    .toBeGreaterThan(0);
  expect(Math.abs((await labelLeft()) - before)).toBeLessThanOrEqual(1);
});

test("switches the lane scale through the toolbar, producing a visibly different render each time", async ({
  page,
  openExample,
}) => {
  await boot(page, openExample);

  await expect(page.locator("#lane-ratio")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#lane-readout")).toContainText("Ratio");
  const ratioPaint = await canvasFingerprint(page, `${LANES} canvas`);

  await rebuildVia(page, "lane-shared");
  await expect(page.locator("#lane-shared")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#lane-ratio")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#lane-readout")).toContainText("Units");
  const sharedPaint = await canvasFingerprint(page, `${LANES} canvas`);
  expect(sharedPaint).not.toBe(ratioPaint);

  await rebuildVia(page, "lane-auto");
  await expect(page.locator("#lane-auto")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#lane-readout")).toContainText("Per lane");
  const autoPaint = await canvasFingerprint(page, `${LANES} canvas`);
  expect(autoPaint).not.toBe(sharedPaint);
  expect(autoPaint).not.toBe(ratioPaint);

  // Back to the default: the toggle round-trips rather than being one-way.
  await rebuildVia(page, "lane-ratio");
  await expect(page.locator("#lane-ratio")).toHaveAttribute("aria-pressed", "true");
  expect(await canvasFingerprint(page, `${LANES} canvas`)).toBe(ratioPaint);
});

test("releases the aggregate band to zero height while keeping the lanes, when the total band is switched off", async ({
  page,
  openExample,
}) => {
  await boot(page, openExample);
  await expect(page.locator(BAND)).toBeVisible();
  await expect(page.locator("#total-toggle")).toHaveAttribute("aria-pressed", "true");

  await rebuildVia(page, "total-toggle");
  await expect(page.locator("#total-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#total-toggle")).toHaveText("Total band: off");

  await expect(page.locator(BAND)).toBeHidden();
  expect(await page.locator(BAND).evaluate((el) => el.getBoundingClientRect().height)).toBe(0);
  await expect(page.locator(LANE)).toHaveCount(3);

  // Round-trips back on.
  await rebuildVia(page, "total-toggle");
  await expect(page.locator("#total-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(BAND)).toBeVisible();
});

// Per-run value labels, opt-in (docs/specs/plugins/resource.md's load-chart section). The values
// are canvas-painted (see this file's header, no `.sg-load-lanes__value`/`__plot` DOM elements
// exist), so this is narrowed to the toggle's own wiring plus a paint-changed check — proof the
// option reaches the renderer, not a geometry re-verification.
test("toggles per-run value labels through the toolbar", async ({ page, openExample }) => {
  await boot(page, openExample);

  await expect(page.locator("#lane-values-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#lane-values-toggle")).toHaveText("Values: off");
  const before = await canvasFingerprint(page, `${LANES} canvas`);

  await rebuildVia(page, "lane-values-toggle");
  await expect(page.locator("#lane-values-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#lane-values-toggle")).toHaveText("Values: on");
  const after = await canvasFingerprint(page, `${LANES} canvas`);
  expect(after).not.toBe(before);

  await rebuildVia(page, "lane-values-toggle");
  await expect(page.locator("#lane-values-toggle")).toHaveAttribute("aria-pressed", "false");
  expect(await canvasFingerprint(page, `${LANES} canvas`)).toBe(before);
});
