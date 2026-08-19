import { expect, test } from "./_fixtures";
import type { Page } from "@playwright/test";

// E2E for examples/a11y-export.html: the a11y plugin's three opt-in extensions
// (docs/specs/plugins/a11y.md — `describeDependencies`, `shortcutHelp`, `summaryTable`), the
// always-on live-region announcements (`FocusService.announce()`), and drag-edit's always-on
// start-edge resize chords, composed with `presetStandard()` plus the merged `stargantt.export`
// facade's `toPng()`.
//
// The page exposes its chart through `window.gantt` (this repo's convention — see
// examples/scheduling.html), so every `focusService.announce(...)` / instance-service call below
// goes through `gantt.service("stargantt.focus")` directly. The chart mounts into `#chart`, and
// the a11y DOM contract (`.sg-a11y`, `.sg-a11y-live`, `.sg-a11y-desc`, `.sg-a11y-desc-item`,
// `.sg-a11y-help`, `.sg-a11y-help-title`, `.sg-a11y-help-key`, `.sg-a11y-help-close`,
// `.sg-a11y-summary`) is defined in a11y.md.
//
// No screenshot assertions here — this spec covers interaction and DOM state only.
//
// Out of scope here (not present on this page): the PNG export button itself is a thin wrapper
// over `stargantt.export`'s `toPng()`, which is exercised far more rigorously in
// e2e/export.spec.ts (decoded pixel/dimension proofs) — this file only smoke-checks that the
// page's own export button produces a non-empty preview, since the button and its status readout
// are page-specific UI export.spec.ts never touches.

const PAGE = "a11y-export.html";
const CONTAINER = "#chart";

declare const gantt: {
  dispatch<K extends string>(cmd: K, payload: unknown): void;
  service(key: "stargantt.data"): {
    getTask(id: string): { id: string; name: string; start: number; end: number } | undefined;
  };
  service(key: "stargantt.focus"): {
    focus(id: string): void;
    announce(message: string): void;
    state: { get(): { focused: string | undefined } };
  };
};

async function boot(page: Page, openExample: import("./_fixtures").OpenExample): Promise<void> {
  await openExample(PAGE, { ready: `${CONTAINER} canvas` });
  await expect
    .poll(async () => page.evaluate(() => (window as unknown as { gantt?: unknown }).gantt !== undefined))
    .toBe(true);
}

const LOG_ENTRY = "#liveRegion .announcement";

test("two consecutive identical announcements both reach the visible log", async ({ page, openExample }) => {
  await boot(page, openExample);

  const before = await page.locator(LOG_ENTRY).count();
  const MESSAGE = "Repeat announcement smoke test";

  // Two separate macrotasks: the mirror observes `.sg-a11y-live` via `MutationObserver`, whose
  // callback batches same-tick mutations. Announcing twice in the same tick would collapse to one
  // observed change for a reason that has nothing to do with the bug under test, so each call gets
  // its own turn of the event loop.
  await page.evaluate((message) => {
    gantt.service("stargantt.focus").announce(message);
  }, MESSAGE);
  await expect.poll(async () => page.locator(LOG_ENTRY).count()).toBe(before + 1);

  await page.evaluate((message) => {
    gantt.service("stargantt.focus").announce(message);
  }, MESSAGE);
  await expect.poll(async () => page.locator(LOG_ENTRY).count()).toBe(before + 2);

  // Both entries carry the announced text — neither was swallowed as a "no change" duplicate.
  await expect(page.locator(LOG_ENTRY).filter({ hasText: MESSAGE })).toHaveCount(2);
});

// The page also demonstrates the three opt-in keyboard-a11y extensions (a11y.md's
// `describeDependencies` / `shortcutHelp` / `summaryTable`) and drag-edit's always-on start-edge
// resize chords. Each is exercised through the page's own buttons, which send the chord into the
// chart.

test("focused rows carry a dependency description and the page mirrors it", async ({ page, openExample }) => {
  await boot(page, openExample);

  // Only rows whose task has links get a description node, so the four leaf tasks of the page's
  // default dataset are described and the link-less summary row is not.
  await expect(page.locator(`${CONTAINER} .sg-a11y-desc .sg-a11y-desc-item`)).toHaveCount(4);

  await page.click("#focusRowBtn");
  // "Task 3: Implementation" has exactly one predecessor and no successors.
  await expect(page.locator("#depReadout")).toContainText("Depends on: Task 2: Design");

  // Walking up one row with the keyboard reaches the task with both lists populated, and the
  // read-out follows the roving focus.
  await page.locator(`${CONTAINER} .sg-a11y [role='row'][tabindex='0']`).focus();
  await page.keyboard.press("ArrowUp");
  await expect(page.locator("#depReadout")).toContainText("Depends on: Task 1: Requirements");
  await expect(page.locator("#depReadout")).toContainText(
    "Blocks: Task 3: Implementation, Task 4: Testing",
  );
});

test("the shortcut-help dialog opens, is Tab-navigable and closes on Escape", async ({ page, openExample }) => {
  await boot(page, openExample);

  const dialog = page.locator(`${CONTAINER} .sg-a11y-help`);
  await expect(dialog).toHaveCount(0);

  await page.click("#focusRowBtn");
  await page.click("#shortcutHelpBtn");

  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(page.locator(`${CONTAINER} .sg-a11y-help-title`)).toHaveText("Keyboard shortcuts");
  // Every described binding in force is listed, including the two the page's own config adds.
  const chords = page.locator(`${CONTAINER} .sg-a11y-help-key`);
  await expect(chords.filter({ hasText: "?" })).toHaveCount(1);
  await expect(chords.filter({ hasText: "Ctrl+Alt+S" })).toHaveCount(1);

  // Tab is claimed but routed around the dialog's own focus ring, so the close button is
  // keyboard-reachable and the focus never escapes the modal.
  await page.keyboard.press("Tab");
  await expect(page.locator(`${CONTAINER} .sg-a11y-help-close`)).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("the summary table is built on demand and toggles away again", async ({ page, openExample }) => {
  await boot(page, openExample);

  const summary = page.locator(`${CONTAINER} .sg-a11y-summary`);
  // Never eager: nothing exists until the chord is sent.
  await expect(summary).toHaveCount(0);

  await page.click("#focusRowBtn");
  await page.click("#summaryTableBtn");

  // One body row per task of the whole store (the page's five tasks), not per virtualized row.
  await expect(summary.locator("tbody tr")).toHaveCount(5);
  await expect(summary.locator("thead th")).toHaveCount(4);

  await page.click("#summaryTableBtn");
  await expect(summary).toHaveCount(0);
});

test("the start-edge chords move the focused task's start by one day", async ({ page, openExample }) => {
  await boot(page, openExample);

  const startOf = async (): Promise<number> =>
    page.evaluate(() => gantt.service("stargantt.data").getTask("1-3")!.start);

  await page.click("#focusRowBtn");
  const before = await startOf();

  await page.click("#startEarlierBtn");
  await expect.poll(startOf).toBe(before - 24 * 60 * 60 * 1000);

  // The edit announces through the live region, so it also lands in the page's visible log.
  await expect(page.locator(LOG_ENTRY).first()).toContainText("Task 3: Implementation");

  await page.click("#startLaterBtn");
  await expect.poll(startOf).toBe(before);
});

test.describe("PNG export button", () => {
  // The facade's toPng() is exercised far more rigorously in e2e/export.spec.ts (decoded
  // pixel/dimension proofs); this only smoke-checks the page's own button + status readout, which
  // export.spec.ts never touches.
  test("the export button produces a non-empty PNG preview and reports its size", async ({ page, openExample }) => {
    await boot(page, openExample);

    await expect(page.locator("#exportPreview")).toBeHidden();
    await page.click("#exportBtn");

    await expect(page.locator("#statusText")).toHaveText(/^✓ Export complete \([\d.]+ KB\)$/);
    const preview = page.locator("#exportPreview");
    await expect(preview).toBeVisible();
    const intrinsic = await preview.evaluate((el) => ({
      width: (el as HTMLImageElement).naturalWidth,
      height: (el as HTMLImageElement).naturalHeight,
    }));
    expect(intrinsic.width).toBeGreaterThan(0);
    expect(intrinsic.height).toBeGreaterThan(0);
  });
});
