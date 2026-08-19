import { expect, test } from "./_fixtures";
import { FIXED_TIME } from "./_fixtures";
import type { Page } from "@playwright/test";

// E2E for the renderer's pointer-capture contract — a real mouse click on a control that a plugin
// mounted into the chart pane must reach that control.
//
// Without this contract the renderer's gesture machine would capture the pointer on the chart pane
// for every `pointerdown` inside it, including presses on overlay contributions: the capture would
// retarget the release, so `click` would fire on the pane and every overlay button would be inert
// to a real mouse — a defect no unit test with synthetic events could see, since pointer capture
// only exists in a real browser. `examples/schedule-diagnostics.html` composes
// `scheduling.diagnostics.panel: true`, whose findings panel sits in the top-left corner slot of
// the chart pane's safe area (docs/specs/plugins/scheduling.md §8, "Slot grant"; architecture.md's
// overlay-corner mechanism), so its toggle button is the fixture. Where that slot resolves to is
// pinned by e2e/overlay-safe-area.spec.ts; this file is only about the press reaching it.

const PAGE = "schedule-diagnostics.html";
const PANE = ".sg-pane--chart";
const TOGGLE = ".sg-diagnostics-button";
const PANEL = ".sg-diagnostics-panel";
const SELECT_ORPHANS = "#selectOrphansBtn";

/** The current selection, read through the public selection service (`SelectionService.state`). */
async function selectedIds(page: Page): Promise<string[]> {
  const ids = await page.evaluate(() => {
    const gantt = (window as unknown as { gantt: { service(id: "stargantt.selection"): { state: { get(): { taskIds: ReadonlySet<string> } } } } }).gantt;
    return Array.from(gantt.service("stargantt.selection").state.get().taskIds);
  });
  return [...ids].map(String).sort();
}

test("a real mouse click on the in-pane diagnostics panel reaches the panel", async ({
  page,
  openExample,
}) => {
  await openExample(PAGE, { ready: `${PANE} canvas`, fixedTime: FIXED_TIME });

  const toggle = page.locator(TOGGLE);
  const panel = page.locator(PANEL);
  await expect(toggle).toBeVisible();
  // The page's default data carries two unlinked tasks ("Design review", "Compliance audit") and
  // one lead (Build -> Test, lag -2d), so the panel is not empty.
  await expect(toggle).toHaveText("Diagnostics (3)");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(panel).toBeHidden();

  // The regression itself: a genuine press+release inside the chart pane, on the overlay's button.
  await toggle.click();

  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Design review");

  // A press inside the opened findings list is likewise not chart input: the list stays open (the
  // outside-click handler sees a target inside the panel) and the release is not retargeted.
  await panel.getByText("Design review").first().click();
  await expect(panel).toBeVisible();

  // Clicking the toggle again closes it — the second click proves the first was not a one-off.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(panel).toBeHidden();
});

test("pressing the panel does not act as a chart-background press", async ({
  page,
  openExample,
}) => {
  await openExample(PAGE, { ready: `${PANE} canvas`, fixedTime: FIXED_TIME });

  // Select the two unlinked tasks through the page's own toolbar button.
  await page.locator(SELECT_ORPHANS).click();
  const selected = await selectedIds(page);
  expect(selected).toEqual(["audit", "review"]);

  // A press on empty chart space starts a background gesture and clears the selection; a press on
  // the overlay must emit no chart pointer input at all, so the selection survives it.
  await page.locator(TOGGLE).click();
  await expect(page.locator(PANEL)).toBeVisible();
  expect(await selectedIds(page)).toEqual(selected);

  // The contrast: a click on empty chart space does clear it, so the assertion above is about the
  // overlay exemption and not about a selection that never changes. The point is horizontally
  // centred (clear of the vertical scrollbar and the top-LEFT slot the open panel occupies), well
  // below the data rows, but above the bottom edge where the horizontal scrollbar lives.
  const box = await page.locator(`${PANE} canvas`).last().boundingBox();
  expect(box).not.toBeNull();
  if (box === null) return;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.8);
  await expect.poll(() => selectedIds(page)).toEqual([]);
});
