import { expect, test } from "./_fixtures";
import { FIXED_TIME, settle } from "./_fixtures";
import type { Page } from "@playwright/test";

// E2E for examples/resource-assign.html: the `stargantt.resource` plugin's ASSIGN nest
// (docs/specs/plugins/resource.md §3.3) — the "Resources" grid column, the assignment editor
// dialog, and the effort tri-state (auto-schedule's `meta.effortMode`/`meta.work` accounting,
// scheduling.md §2.5) recomputing as part of the same undo transaction as an assignment edit.
// DOM contract note: the assign area's markup
// (packages/plugins/resource/src/internal/assign/{cell,editor,wire}.ts — data-sg-ra-cell,
// data-sg-ra-open, data-sg-ra-task, data-sg-ra-res, .sg-ra-chip/.sg-ra-open/.sg-ra-editor/
// .sg-ra-row/.sg-ra-apply/.sg-ra-cancel/.sg-ra-drop) is stable, so this file selects by those
// task-id-keyed attributes directly rather than resource.spec.ts's row/column-index indirection
// (that page's composition made task-keyed attributes less convenient to reach; this page's tasks
// are static and few, so the direct attributes are the more faithful and more readable choice
// here).
//
// Overlap with e2e/resource.spec.ts (read first): that file already covers chip counts on a
// "Resources" column, opening the editor, checking a resource and committing as one undo step,
// and lane-drag reassignment through the resource-view strip. NOT covered there, and covered here
// instead: the effort tri-state panel (auto-schedule integration — this page's own reason for
// existing), the Escape-cancel path (no write, focus restore), the chip label's 100%-omitted /
// "N%"-shown formatting, the editor placement/clamping-and-flip geometry, the held-press-survives-
// repaint interaction robustness, and the cell-layout rule that the open button leads the cell and
// survives arbitrarily many chips — all of which resource.spec.ts's own header explicitly lists as
// deferred/out of scope for that file.
//
// API surface (architecture.md §4 / resource.md §1.3):
// - `gantt.service("stargantt.data").assignments.get().get(id)` reads a task's assignments
//   (data-store.md).
// - the public `assignment/set` command performs a host-programmatic assignment change (a move is
//   a set + remove pair).
// - there is no service-level "choices" accessor; this file assigns the page's three known ids
//   directly (alice, bob, dana) rather than reconstructing the choice list, since the page's
//   roster is fixed and small.
//
// No screenshot assertions: this spec has no baseline image, and inventing a new one is out of
// scope here — every visual claim below is a functional/DOM geometry assertion instead.

const PAGE = "resource-assign.html";
const PANE = ".sg-pane--chart";
const GRID = ".sg-pane--grid";
// The gantt root (`ctx.root` — packages/core/src/index.ts's `opts.element`) IS the container div
// passed to `StarGantt.create()`; there is no separate `#gantt-root` wrapper.
const ROOT = "#chart";

declare const gantt: {
  service(key: "stargantt.data"): {
    assignments: { get(): Map<string, { taskId: string; resourceId: string; units: number }[]> };
  };
  dispatch(cmd: string, payload?: unknown): void;
};

/** Reads a task's assignments through the public data store. */
async function assignmentsOf(
  page: Page,
  taskId: string,
): Promise<{ resourceId: string; units: number }[]> {
  return page.evaluate(
    (id) =>
      (gantt.service("stargantt.data").assignments.get().get(id) ?? []).map((a) => ({
        resourceId: String(a.resourceId),
        units: a.units,
      })),
    taskId,
  );
}

async function undo(page: Page): Promise<void> {
  await page.evaluate(() => gantt.dispatch("history/undo", undefined));
}

/**
 * Waits until every selector's `getBoundingClientRect()` stops moving across two consecutive
 * animation frames. The shared harness (e2e/_fixtures.ts) has no generic layout-settle helper, so
 * this file defines its own. The tree-grid pane and the view's panes both resize through a
 * `ResizeObserver` (packages/plugins/tree-grid/src/internal/{pane,height-watch}.ts,
 * packages/plugins/view/src/internal/panes/*), so a CSS-only host resize needs this rather than a
 * fixed frame count.
 */
async function settleLayout(page: Page, selectors: readonly string[]): Promise<void> {
  await page.evaluate(async (list: readonly string[]) => {
    const frame = (): Promise<void> =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const read = (): string | null => {
      const parts: string[] = [];
      for (const selector of list) {
        const el = document.querySelector(selector);
        if (el === null) return null;
        const box = el.getBoundingClientRect();
        parts.push(`${String(box.x)},${String(box.y)},${String(box.width)},${String(box.height)}`);
      }
      return parts.join("|");
    };
    let previous = read();
    if (previous === null) return;
    for (let i = 0; i < 120; i += 1) {
      await frame();
      const current = read();
      if (current !== null && current === previous) return;
      previous = current;
    }
  }, selectors);
}

/**
 * Presses a target the way a human does: pointer down, held across two full frames, then up.
 * Playwright's `click()` issues both mousedown/mouseup inside one frame, which beats
 * any next-frame repaint and so cannot catch one that replaces the pressed element mid-gesture
 * (mousedown and mouseup landing on different elements -> the browser dispatches no `click`). The
 * two-rAF hold guarantees a wrongly-scheduled repaint runs while the button is still held.
 */
async function humanPress(page: Page, target: import("@playwright/test").Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (box === null) throw new Error("press target has no layout box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  await page.mouse.up();
}

async function bootResourceAssign(page: Page, openExample: import("./_fixtures").OpenExample): Promise<void> {
  await openExample(PAGE, { ready: `${PANE} canvas`, fixedTime: FIXED_TIME });
  await settle(page);
}

test.describe("effort tri-state", () => {
  test("recomputes work and duration as part of the same undo transaction as the triggering edit", async ({
    page,
    openExample,
  }) => {
    await bootResourceAssign(page, openExample);

    const cell = (task: string, key: string) => page.locator(`[data-effort-row="${task}"] [data-effort-cell="${key}"]`);
    await expect(cell("impl", "duration")).toHaveText("7 d");
    await expect(cell("design", "work")).toHaveText("2 d");

    // fixed-work: adding a second assignee doubles units, which halves duration; work is held.
    const workButton = page.locator("#effort-work");
    await expect(workButton).toHaveAttribute("aria-pressed", "false");
    await workButton.click();
    await settle(page);
    await expect(cell("impl", "duration")).toHaveText("3.5 d");
    await expect(cell("impl", "work")).toHaveText("7 d");
    await expect(workButton).toHaveAttribute("aria-pressed", "true");

    // fixed-duration: an assignment change re-derives work; dates never move.
    await page.locator("#effort-duration").click();
    await settle(page);
    await expect(cell("design", "duration")).toHaveText("4 d");
    await expect(cell("design", "work")).toHaveText("4 d");

    // fixed-units: a date change (task/move) re-derives work instead of duration.
    const unitsButton = page.locator("#effort-units");
    await unitsButton.click();
    await settle(page);
    await expect(cell("plan", "duration")).toHaveText("5 d");
    await expect(cell("plan", "work")).toHaveText("5 d");

    // One undo reverts the move AND the engine's follow-on recompute together (one transaction).
    await undo(page);
    await settle(page);
    await expect(cell("plan", "duration")).toHaveText("3 d");
    await expect(cell("plan", "work")).toHaveText("3 d");
    await expect(unitsButton).toHaveAttribute("aria-pressed", "false");
  });
});

test.describe("Resources column + editor", () => {
  test("chips render with the 100%-omitted label, and the editor commits, undoes, and cancels via Escape", async ({
    page,
    openExample,
  }) => {
    await bootResourceAssign(page, openExample);

    // chipLabel default: the percent is omitted at exactly 100%, shown otherwise (messages.ts).
    const planChip = page.locator('.sg-ra-chip[data-sg-ra-task="plan"]');
    await expect(planChip).toHaveCount(1);
    await expect(planChip).toHaveText(/^\s*Alice\s*$/);
    await expect(page.locator('.sg-ra-chip[data-sg-ra-task="design"]')).toHaveText(/Alice\s*50%/);

    // "review" has no assignments yet: no chip, only the open button.
    await expect(page.locator('.sg-ra-chip[data-sg-ra-task="review"]')).toHaveCount(0);
    const openButton = page.locator('button[data-sg-ra-open="review"]');
    await expect(openButton).toBeVisible();

    // Open: a dialog named "Assign resources" (messages.ts editorTitle), one row per choice — the
    // two store resources (alice, bob) plus the pool-only "dana" (resource.md §3.3 store-first).
    await openButton.click();
    const dialog = page.locator('.sg-ra-editor[role="dialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".sg-ra-row")).toHaveCount(3);

    const bobRow = dialog.locator(".sg-ra-row", { hasText: "Bob" });
    await bobRow.locator('input[type="checkbox"]').check();
    await dialog.locator("button.sg-ra-apply").click();
    await expect(dialog).toHaveCount(0);
    await settle(page);

    expect(await assignmentsOf(page, "review")).toEqual([{ resourceId: "bob", units: 1 }]);
    await expect(page.locator('.sg-ra-chip[data-sg-ra-task="review"]')).toHaveText(/^\s*Bob\s*$/);

    // One ordinary undoable data-store command.
    await undo(page);
    await settle(page);
    expect(await assignmentsOf(page, "review")).toEqual([]);

    // Escape cancels with a full revert: nothing written, focus returns to the opener.
    await openButton.click();
    await expect(dialog).toBeVisible();
    await dialog.locator(".sg-ra-row", { hasText: "Dana" }).locator('input[type="checkbox"]').check();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(await assignmentsOf(page, "review")).toEqual([]);
    await expect(openButton).toBeFocused();
  });

  test("the editor stays inside the gantt root and flips above when it cannot fit below the last row", async ({
    page,
    openExample,
  }) => {
    await bootResourceAssign(page, openExample);

    // Shrink the host in-page (never the example's own markup) so the last row's editor genuinely
    // cannot fit below it. The header (44px) + 4 rows (28px each, tree-grid.md defaults) is 156px
    // of content; 180px fits every row with no virtual-scroll truncation while leaving only ~24px
    // below "review" — far less than the editor's own footprint. Naive placement (`top =
    // cell.bottom`, no clamp, no flip) would land the editor's bottom well past the root's own
    // 180px-tall clipped box.
    await page.evaluate(() => {
      const chart = document.getElementById("chart");
      if (chart !== null) chart.style.height = "180px";
    });
    await settleLayout(page, [PANE, GRID, ROOT]);

    const cell = page.locator('[data-sg-ra-cell="review"]');
    const openButton = page.locator('button[data-sg-ra-open="review"]');
    await expect(openButton).toBeVisible();
    const cellBox = await cell.boundingBox();
    if (cellBox === null) throw new Error("anchor cell has no layout box");

    await openButton.click();
    const dialog = page.locator('.sg-ra-editor[role="dialog"]');
    await expect(dialog).toBeVisible();

    const root = await page.locator(ROOT).boundingBox();
    const box = await dialog.boundingBox();
    if (root === null || box === null) throw new Error("root or dialog has no layout box");
    // Clamped fully inside the gantt root's own box on both axes (resource.md §3.3).
    expect(box.x).toBeGreaterThanOrEqual(root.x - 1);
    expect(box.y).toBeGreaterThanOrEqual(root.y - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(root.x + root.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(root.y + root.height + 1);

    // The flip actually happened: the editor's bottom lands at or above the anchor cell's own top.
    expect(box.y + box.height).toBeLessThanOrEqual(cellBox.y + 1);

    // The Apply button never scrolls away and stays inside the dialog's own clamped box.
    const apply = dialog.locator("button.sg-ra-apply");
    await expect(apply).toBeVisible();
    const applyBox = await apply.boundingBox();
    if (applyBox === null) throw new Error("apply button has no layout box");
    expect(applyBox.x).toBeGreaterThanOrEqual(box.x - 1);
    expect(applyBox.y).toBeGreaterThanOrEqual(box.y - 1);
    expect(applyBox.x + applyBox.width).toBeLessThanOrEqual(box.x + box.width + 1);
    expect(applyBox.y + applyBox.height).toBeLessThanOrEqual(box.y + box.height + 1);
  });

  test("a held human press on the open button still opens the editor", async ({ page, openExample }) => {
    await bootResourceAssign(page, openExample);

    // Widen the viewport and drag the pane divider right so the Resources column clears it — a
    // raw-coordinate press at the stock width would land on the divider overlay, not the button.
    await page.setViewportSize({ width: 1600, height: 720 });
    await settleLayout(page, [GRID, ROOT]);
    const divider = page.locator(".sg-pane-divider");
    const dividerBox = await divider.boundingBox();
    if (dividerBox === null) throw new Error("pane divider has no layout box");
    await page.mouse.move(dividerBox.x + dividerBox.width / 2, dividerBox.y + 100);
    await page.mouse.down();
    await page.mouse.move(dividerBox.x + dividerBox.width / 2 + 320, dividerBox.y + 100, { steps: 4 });
    await page.mouse.up();
    await settleLayout(page, [GRID, ROOT]);

    // The press's own pointerdown selects the row, which schedules a repaint that could otherwise
    // replace the cell's children between mousedown and mouseup — the browser then dispatches no
    // `click` for a real pointer.
    const openButton = page.locator('button[data-sg-ra-open="plan"]');
    await expect(openButton).toBeVisible();
    const pressed = await page.evaluateHandle(() => document.querySelector('button[data-sg-ra-open="plan"]'));

    await humanPress(page, openButton);

    const dialog = page.locator('.sg-ra-editor[role="dialog"]');
    await expect(dialog).toBeVisible();
    expect(await pressed.evaluate((el) => el !== null && el.isConnected)).toBe(true);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("the open button leads the cell and survives any number of chips", async ({ page, openExample }) => {
    await bootResourceAssign(page, openExample);

    // Give "review" all three known resources at 50% so each chip carries the longer "Name 50%"
    // label — three such chips plus gaps far exceed the 160px default column width. "dana" is
    // pool-only (not yet in the data store): the editor's own commit path mirrors a pool-only
    // choice via `resource/add` before assigning it (resource.md §1.3/§3.3 capability map), so a
    // raw `assignment/set` for her needs that same mirror step done explicitly first, or the
    // command silently targets an unknown resource id.
    await page.evaluate(() => gantt.dispatch("resource/add", { resource: { id: "dana", name: "Dana" } }));
    for (const resourceId of ["alice", "bob", "dana"]) {
      await page.evaluate(
        ({ resourceId }) => gantt.dispatch("assignment/set", { taskId: "review", resourceId, units: 0.5 }),
        { resourceId },
      );
    }
    await settle(page);

    const cell = page.locator('[data-sg-ra-cell="review"]');
    const openButton = page.locator('button[data-sg-ra-open="review"]');
    await expect(page.locator('.sg-ra-chip[data-sg-ra-task="review"]')).toHaveCount(3);

    // The open button is the cell's first child (resource.md §3.3): fixed at the leading
    // edge, fully inside the cell's box regardless of chip count.
    await expect(openButton).toBeVisible();
    const cellBox = await cell.boundingBox();
    const buttonBox = await openButton.boundingBox();
    const firstChipBox = await page.locator('.sg-ra-chip[data-sg-ra-task="review"]').first().boundingBox();
    if (cellBox === null || buttonBox === null || firstChipBox === null) {
      throw new Error("cell, button or chip has no layout box");
    }
    expect(buttonBox.x).toBeGreaterThanOrEqual(cellBox.x - 1);
    expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(cellBox.x + cellBox.width + 1);
    expect(buttonBox.x).toBeLessThan(firstChipBox.x);

    // The chips genuinely shrank to fit inside the cell, not merely styled to overflow invisibly.
    const chips = await page.locator('.sg-ra-chip[data-sg-ra-task="review"]').all();
    for (const chip of chips) {
      const chipBox = await chip.boundingBox();
      if (chipBox === null) throw new Error("chip has no layout box");
      expect(chipBox.x + chipBox.width).toBeLessThanOrEqual(cellBox.x + cellBox.width + 1);
    }

    // The full list stays readable via the cell's title (comma-joined), membership not order.
    const title = await cell.getAttribute("title");
    expect(title).not.toBeNull();
    for (const name of ["Alice", "Bob", "Dana"]) expect(title).toContain(name);

    // The leading button still opens the editor (a plain click — the held-press path is covered by
    // the test above; this one stays diagnosable as pure cell layout).
    await openButton.click();
    await expect(page.locator('.sg-ra-editor[role="dialog"]')).toBeVisible();
    await page.keyboard.press("Escape");
  });
});
