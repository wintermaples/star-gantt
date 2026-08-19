import { expect, test } from "./_fixtures";
import { settle } from "./_fixtures";
import type { Page } from "@playwright/test";

// E2E for examples/resource-view.html: the `stargantt.resource` plugin's VIEW nest
// (docs/specs/plugins/resource.md §3.4) — the resource-view strip below the chart: per-resource
// lane rows grouped into teams, overallocation marked in text AND a modifier class (never color
// alone), and the strip's own visibility toggling through the view plugin's generic
// `view/setBottomPaneHeight` command (resource.md §1.3).
//
// DOM contract note: the strip's markup is verified against
// packages/plugins/resource/src/internal/view/panel.ts — `.sg-resource-view`,
// `.sg-resource-view__row[data-sg-resource="<id>"]`, `--over`/`--target` modifier classes,
// `.sg-resource-view__seg[--over]`, `.sg-resource-view__team`, `.sg-resource-view__header`. Lane
// position is read straight off the row DOM (`data-sg-resource`) rather than through any service
// accessor.
//
// Overlap with e2e/resource.spec.ts (read first): that file already thoroughly covers the
// lane-DRAG-REASSIGN mechanism itself on examples/resource.html (two drops onto different lanes,
// one-undo-step, the live `--target` highlight during the drag), so that scenario is deliberately
// not duplicated here. Covered here instead — all explicitly listed as out of scope in
// resource.spec.ts's own header comment for that file: the strip's boots-closed default, its
// position below the chart pane (not an overlay on it), its header band, segment-to-chart x
// alignment, the teams feature (not configured on resource.html), and the command-path toggle
// (view/setBottomPaneHeight, not a service call).
//
// No screenshot assertions: this spec has no baseline image, and inventing a new one is out of
// scope here — every visual claim below is a functional/DOM/geometry assertion.

const PAGE = "resource-view.html";
const PANE = ".sg-pane--chart";
const PANEL = ".sg-resource-view";
const LAYER = `${PANE} canvas.sg-layer`;

declare const gantt: {
  service(key: "stargantt.data"): {
    assignments: { get(): Map<string, { taskId: string; resourceId: string; units: number }[]> };
  };
  service(key: "stargantt.task-bars"): {
    barBoxOf(id: string): { x: number; y: number; width: number; height: number } | undefined;
  };
  service(key: "stargantt.history"): {
    state: { get(): { canUndo: boolean; canRedo: boolean; depth: number } };
    undo(): void;
  };
};

async function ratesOf(page: Page, taskId: string): Promise<[string, number][]> {
  const rows = await page.evaluate(
    (id) => gantt.service("stargantt.data").assignments.get().get(id) ?? [],
    taskId,
  );
  return rows
    .map((a): [string, number] => [String(a.resourceId), a.units])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

async function chartBodyBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator(LAYER).first().boundingBox();
  if (box === null) throw new Error("chart body canvas not found");
  return box;
}

/** Page-absolute center point of a task's bar, through the public `stargantt.task-bars` service —
 *  the same pattern resource.spec.ts uses, which already accounts for scroll. */
async function barCenter(page: Page, taskId: string): Promise<{ x: number; y: number }> {
  const pane = await chartBodyBox(page);
  const box = await page.evaluate((id) => gantt.service("stargantt.task-bars").barBoxOf(id), taskId);
  if (box === undefined) throw new Error(`no visible bar for task "${taskId}"`);
  return { x: pane.x + box.x + box.width / 2, y: pane.y + box.y + box.height / 2 };
}

/** Page-absolute left edge of a task's bar (for segment-alignment comparison). */
async function barLeft(page: Page, taskId: string): Promise<number> {
  const pane = await chartBodyBox(page);
  const box = await page.evaluate((id) => gantt.service("stargantt.task-bars").barBoxOf(id), taskId);
  if (box === undefined) throw new Error(`no visible bar for task "${taskId}"`);
  return pane.x + box.x;
}

async function laneRow(page: Page, resourceId: string) {
  return page.locator(`.sg-resource-view__row[data-sg-resource="${resourceId}"]`);
}

async function bootResourceView(page: Page, openExample: import("./_fixtures").OpenExample): Promise<void> {
  await openExample(PAGE, { ready: `${PANE} canvas` });
  await settle(page);
}

async function openStrip(page: Page): Promise<void> {
  await page.locator("#view-toggle").click();
  await settle(page);
}

test.describe("closed by default", () => {
  test("the panel boots closed and adds nothing to the chart", async ({ page, openExample }) => {
    await bootResourceView(page, openExample);
    await expect(page.locator(PANEL)).toBeHidden();
    await expect(page.locator(".sg-resource-view__row")).toHaveCount(0);
  });
});

test.describe("opened panel", () => {
  test("shows resource rows, overallocation marking, and team headers", async ({ page, openExample }) => {
    await bootResourceView(page, openExample);
    const panel = page.locator(PANEL);
    await openStrip(page);
    await expect(panel).toBeVisible();

    // One row per resource in the assignment universe, one segment per assignment.
    await expect(panel.locator(".sg-resource-view__row")).toHaveCount(3);
    await expect(panel.locator(".sg-resource-view__seg")).toHaveCount(5);

    // Alice is over-allocated where design (0.75) and impl (0.5) overlap: her row carries the
    // modifier class AND a text label (messages.ts rowLabel: "{name} (overallocated)") — never
    // color alone.
    await expect(panel.locator(".sg-resource-view__row--over")).toHaveCount(1);
    const aliceLabel = panel.locator(".sg-resource-view__label--over");
    await expect(aliceLabel).toHaveCount(1);
    await expect(aliceLabel).toContainText("Alice");
    await expect(aliceLabel).toContainText("overallocated");
    await expect(panel.locator(".sg-resource-view__seg--over").first()).toBeVisible();

    // The two configured teams (this page's own config, not resource.html's) render headers; every
    // resource is claimed by one, so no trailing "Other resources" group appears
    // (messages.ts ungroupedTeam).
    const teams = panel.locator(".sg-resource-view__body .sg-resource-view__team");
    await expect(teams).toHaveCount(2);
    await expect(teams.nth(0)).toContainText("Engineering");
    await expect(teams.nth(1)).toContainText("Design");
    await expect(panel.getByText("Other resources")).toHaveCount(0);
  });
});

test.describe("strip layout (a pane below the chart, not an overlay on it)", () => {
  test("the strip sits below the chart's canvases and covers none of them", async ({ page, openExample }) => {
    await bootResourceView(page, openExample);
    await openStrip(page);

    const panelBox = await page.locator(PANEL).boundingBox();
    const layerBox = await page.locator(LAYER).first().boundingBox();
    if (panelBox === null || layerBox === null) throw new Error("panel or layer has no layout box");
    expect(panelBox.y).toBeGreaterThanOrEqual(layerBox.y + layerBox.height - 1);
    expect(panelBox.height).toBeGreaterThan(0);
  });

  test("a header band carrying the panel label sits above the lane stack", async ({ page, openExample }) => {
    await bootResourceView(page, openExample);
    await openStrip(page);

    const panel = page.locator(PANEL);
    const header = panel.locator(".sg-resource-view__body .sg-resource-view__header");
    await expect(header).toBeVisible();
    await expect(header).toHaveText("Resource view"); // messages.ts panelLabel default

    const headerBox = await header.boundingBox();
    const aliceRow = await laneRow(page, "alice");
    const aliceBox = await aliceRow.boundingBox();
    if (headerBox === null || aliceBox === null) throw new Error("header or first lane has no layout box");
    expect(aliceBox.y).toBeGreaterThanOrEqual(headerBox.y + headerBox.height - 1);
  });

  test("segments line up on-screen with the chart's own x for the same task", async ({ page, openExample }) => {
    await bootResourceView(page, openExample);
    await openStrip(page);
    await expect(page.locator(PANEL)).toBeVisible();

    const seg = page.locator(".sg-resource-view__seg", { hasText: "Implementation" }).first();
    await expect(seg).toBeVisible();
    const segBox = await seg.boundingBox();
    if (segBox === null) throw new Error("segment has no layout box");
    const expectedLeft = await barLeft(page, "impl");
    // Compared on the page (not through the panel's own inline style), so a nesting offset that
    // shifts the whole resource axis right (the panel's name column) would be caught here.
    expect(Math.abs(segBox.x - expectedLeft)).toBeLessThanOrEqual(2);
  });
});

test.describe("visibility command path", () => {
  test("view/setBottomPaneHeight (the #view-toggle button) opens and closes the strip", async ({
    page,
    openExample,
  }) => {
    await bootResourceView(page, openExample);
    const panel = page.locator(PANEL);
    await expect(panel).toBeHidden();

    await openStrip(page);
    await expect(panel).toBeVisible();

    await page.locator("#view-toggle").click();
    await settle(page);
    await expect(panel).toBeHidden();
  });
});

test.describe("lane drag reassignment — page-specific edge only", () => {
  // The drag-to-lane MECHANISM (two drops onto different lanes, one undo step, the live
  // `--target` highlight) is already thoroughly proven by resource.spec.ts on examples/resource.html
  // — deliberately not re-proven here (see this file's header). What's page-specific and worth one
  // assertion: this page's strip is a genuine bottom-region PANE (not an overlay), so the drag must
  // physically cross out of the chart pane and down into a different pane's DOM before dropping —
  // a geometry resource.html's own composition doesn't exercise the same way.
  test("a drag starting on a chart bar can drop onto a lane in the separate strip pane below it", async ({
    page,
    openExample,
  }) => {
    await bootResourceView(page, openExample);
    await openStrip(page);
    await expect(page.locator(PANEL)).toBeVisible();

    expect(await ratesOf(page, "design")).toEqual([["alice", 0.75]]);
    const before = await page.evaluate(() => gantt.service("stargantt.history").state.get());

    const start = await barCenter(page, "design");
    const carolRow = await laneRow(page, "carol");
    const carolBox = await carolRow.boundingBox();
    if (carolBox === null) throw new Error("carol's lane row has no layout box");
    const targetY = carolBox.y + carolBox.height / 2;
    expect(targetY).toBeGreaterThan(start.y); // the strip is genuinely below the bar

    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x, start.y + 8, { steps: 3 });
    await page.mouse.move(start.x, targetY, { steps: 10 });
    await settle(page);
    await expect(page.locator(".sg-resource-view__row--target")).toHaveCount(1);
    await page.mouse.up();
    await settle(page);

    await expect.poll(async () => ratesOf(page, "design")).toEqual([["carol", 0.75]]);
    const after = await page.evaluate(() => gantt.service("stargantt.history").state.get());
    expect(after.depth).toBe(before.depth + 1);

    await page.evaluate(() => gantt.service("stargantt.history").undo());
    await expect.poll(async () => ratesOf(page, "design")).toEqual([["alice", 0.75]]);
  });
});
