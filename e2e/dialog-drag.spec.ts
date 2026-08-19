import { expect, test } from "./_fixtures";
import { settle } from "./_fixtures";
import type { Page } from "@playwright/test";

// The shared dialog chrome (docs/specs/sdk.md, Module: sdk/dialog — `createDialog`), exercised
// through the built bundle on the page that opens the biggest of its panels: the header drags the
// box, and the chart root is the host, so the box can cross into the tree grid pane.
//
// `examples/evm.html` opens an EVM KPI dashboard panel (`#evm-dashboard` button ->
// `evm.openDashboardPanel()`), built on `@stargantt/sdk`'s `createDialog`
// (packages/plugins/tracking/src/internal/evm/panels.ts's `openDialog` helper,
// packages/sdk/src/dialog/dialog.ts): the dialog is appended to `host` (here `ctx.root`, i.e. the
// chart's mount element — `#chart` in examples/evm.html) as a sibling of the pane row, and the drag
// clamps the box's left/top against the host's box while clamping the *bottom* against the host
// using only the header's height (dialog.ts's drag-move handler) — so a box taller than the widget
// can still be dragged back by its header. `createDialog`'s `className` option is
// `"sg-evm-dashboard"` verbatim (panels.ts's `openDialog` call), giving the box its
// `sg-evm-dashboard` class and the header its `sg-evm-dashboard__header` class
// (`${className}__header`, dialog.ts).

const PAGE = "evm.html";
const ROOT = "#chart";
const PANE = ".sg-pane--chart";
const GRID = ".sg-pane--grid";
const DASHBOARD = ".sg-evm-dashboard";
const HEADER = `${DASHBOARD}__header`;

/** Presses the header at its centre, moves by (dx, dy) in a few steps, and releases. */
async function dragHeader(page: Page, dx: number, dy: number): Promise<void> {
  const header = page.locator(HEADER);
  const box = await header.boundingBox();
  if (box === null) throw new Error("dialog header has no layout box");
  const fromX = box.x + box.width / 2;
  const fromY = box.y + box.height / 2;
  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  // Several steps, not one: a single jump can outrun a pointermove-driven drag in a real browser.
  await page.mouse.move(fromX + dx / 2, fromY + dy / 2, { steps: 5 });
  await page.mouse.move(fromX + dx, fromY + dy, { steps: 5 });
  await page.mouse.up();
}

test("the dialog header drags the panel across the chart", async ({ page, openExample }) => {
  await openExample(PAGE, { ready: `${PANE} canvas` });
  await settle(page);
  await page.locator("#evm-dashboard").click();
  const dialog = page.locator(DASHBOARD);
  await expect(dialog).toBeVisible();

  const before = await dialog.boundingBox();
  expect(before).not.toBeNull();
  await dragHeader(page, 80, 40);
  const after = await dialog.boundingBox();
  expect(after).not.toBeNull();

  // Moved by the pointer delta, within the rounding a transform introduces.
  expect(after!.x - before!.x).toBeGreaterThan(70);
  expect(after!.x - before!.x).toBeLessThan(90);
  expect(after!.y - before!.y).toBeGreaterThan(30);
  expect(after!.y - before!.y).toBeLessThan(50);
});

test("the dialog can be dragged over the tree grid, not only the timeline pane", async ({
  page,
  openExample,
}) => {
  await openExample(PAGE, { ready: `${PANE} canvas` });
  await settle(page);
  await page.locator("#evm-dashboard").click();
  const dialog = page.locator(DASHBOARD);
  await expect(dialog).toBeVisible();

  // The dialog is hosted by the chart root (dialog.ts's `host` option, wired to `ctx.root` in
  // panels.ts's `panelHost()`), so it is not a descendant of the chart pane and the pane's
  // `overflow: hidden` is not its cage.
  expect(await page.locator(`${PANE} ${DASHBOARD}`).count()).toBe(0);
  expect(await page.locator(`${ROOT} > ${DASHBOARD}`).count()).toBe(1);

  const grid = await page.locator(GRID).boundingBox();
  expect(grid).not.toBeNull();
  // Hard to the left: the clamp stops the box at the widget's left edge, which is the grid's.
  await dragHeader(page, -4000, 0);
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeLessThan(grid!.x + grid!.width);
  expect(box!.x).toBeGreaterThanOrEqual(grid!.x - 1);
});

test("the dialog cannot be dragged out of the chart", async ({ page, openExample }) => {
  await openExample(PAGE, { ready: `${PANE} canvas` });
  await settle(page);
  await page.locator("#evm-dashboard").click();
  const dialog = page.locator(DASHBOARD);
  await expect(dialog).toBeVisible();

  // Hard against the top-left, then hard against the bottom-right, in one gesture each.
  await dragHeader(page, -4000, -4000);
  // The host is the chart root: the whole widget is the box's range, and its cage.
  const host = await page.locator(ROOT).boundingBox();
  const topLeft = await dialog.boundingBox();
  expect(host).not.toBeNull();
  expect(topLeft).not.toBeNull();
  expect(topLeft!.x).toBeGreaterThanOrEqual(host!.x - 1);
  expect(topLeft!.y).toBeGreaterThanOrEqual(host!.y - 1);

  await dragHeader(page, 4000, 4000);
  const bottomRight = await dialog.boundingBox();
  expect(bottomRight).not.toBeNull();
  expect(bottomRight!.x + bottomRight!.width).toBeLessThanOrEqual(host!.x + host!.width + 1);
  // The bottom clamp keeps the *header* on screen, not the whole box: a box taller than the widget
  // must still be draggable back, and only the header can do that.
  const headerBox = await page.locator(HEADER).boundingBox();
  expect(headerBox).not.toBeNull();
  expect(headerBox!.y + headerBox!.height).toBeLessThanOrEqual(host!.y + host!.height + 1);
});
