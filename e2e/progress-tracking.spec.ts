import { expect, test } from "./_fixtures";
import { FIXED_TIME, settle } from "./_fixtures";

// E2E for examples/progress-tracking.html: the `stargantt.tracking` plugin's `progress` nest
// (docs/specs/plugins/tracking.md §1.2/§2.5/§2.6), composed as an OPT-IN plugin on top of
// `presetStandard()`.
//
// Overlap check against e2e/tracking.spec.ts (which already exercises `stargantt.progress` on
// `examples/tracking.html`): that file's "bulk progress update commits every edited row as ONE
// undo step" test already proves the bulk panel's Apply path end to end, and its file header
// explicitly defers "progress's Escape-to-cancel path, the trend panel, and the 'only one of
// {bulk, trend, cost, EVM} panel open at a time' interplay" here. This file therefore does not
// re-cover the Apply/undo assertions; it covers exactly what tracking.spec.ts defers, plus
// `recordSnapshot()` / the `state` store (neither exercised anywhere else).

const CONTAINER = "#chart";
const PANE = ".sg-pane--chart";

declare const gantt: {
  service(key: "stargantt.data"): {
    getTask(id: string): { id: string; progress?: number } | undefined;
  };
  service(key: "stargantt.progress"): {
    state: {
      get(): { progressLineVisible: boolean; snapshots: readonly { date: number; percentComplete: number }[] };
    };
    openBulkUpdatePanel(): boolean;
    openTrendPanel(): boolean;
    recordSnapshot(): { date: number; percentComplete: number };
  };
  service(key: "stargantt.history"): {
    state: { get(): { canUndo: boolean; canRedo: boolean; depth: number } };
  };
};

async function bootProgress(page: import("@playwright/test").Page, openExample: import("./_fixtures").OpenExample): Promise<void> {
  await openExample("progress-tracking.html", { ready: `${PANE} canvas`, fixedTime: FIXED_TIME });
  await settle(page);
}

test.describe("bulk update panel", () => {
  test("Escape cancels with nothing written and no history entry", async ({ page, openExample }) => {
    await bootProgress(page, openExample);

    const before = await page.evaluate(() => gantt.service("stargantt.history").state.get());

    await page.locator("#btn-bulk").click();
    const dialog = page.getByRole("dialog", { name: "Update progress" });
    await expect(dialog).toBeVisible();
    // One header row plus one row per task (this page's dataset has 5 tasks).
    await expect(dialog.locator('[role="row"]')).toHaveCount(6);

    await dialog.locator('input[aria-label="Test pass — Progress %"]').fill("55");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await settle(page);

    const after = await page.evaluate(() => gantt.service("stargantt.history").state.get());
    expect(after.depth).toBe(before.depth); // nothing committed
    const test_ = await page.evaluate(() => gantt.service("stargantt.data").getTask("test"));
    expect(test_?.progress).toBeUndefined();
  });
});

test.describe("trend panel", () => {
  test("lists the seeded snapshots as accessible text, and opening bulk closes it (one panel at a time)", async ({
    page,
    openExample,
  }) => {
    await bootProgress(page, openExample);

    await page.locator("#btn-trend").click();
    const trend = page.getByRole("dialog", { name: "Progress trend" });
    await expect(trend).toBeVisible();
    expect(await trend.getAttribute("class")).toBe("sg-progress-trend");

    // The page seeds two snapshots (18% and 34% complete); the accessible <li> list mirrors the
    // canvas polyline (tracking.md §2.6's `trendLine` builder — meaning never carried by the
    // drawing alone).
    await expect(trend).toContainText("18% complete");
    await expect(trend).toContainText("34% complete");

    // tracking.md §2.5: at most one of this plugin's panels per feature area is open at a time —
    // opening the bulk panel closes the trend panel.
    await page.locator("#btn-bulk").click();
    await expect(page.getByRole("dialog", { name: "Update progress" })).toBeVisible();
    await expect(trend).toHaveCount(0);
  });

  test("recordSnapshot() appends a new point to the observable state store", async ({ page, openExample }) => {
    await bootProgress(page, openExample);

    const before = await page.evaluate(() => gantt.service("stargantt.progress").state.get().snapshots);
    expect(before).toHaveLength(2); // the two seeded snapshots

    await page.locator("#btn-snapshot").click();
    await settle(page);

    const after = await page.evaluate(() => gantt.service("stargantt.progress").state.get().snapshots);
    expect(after.length).toBe(before.length + 1);

    // The freshly recorded point is today's — the panel would now show three lines.
    await page.locator("#btn-trend").click();
    const trend = page.getByRole("dialog", { name: "Progress trend" });
    await expect(trend.locator("li")).toHaveCount(3);
  });
});
