import { expect, settle, test } from "./_fixtures";
import type { OpenExample } from "./_fixtures";
import type { Page } from "@playwright/test";

// E2E for examples/context-menu-clipboard.html: the two opt-in interaction areas the page composes
// (docs/specs/plugins/interaction.md — contextMenu §6.5, clipboard §6.7).
//
// Both `context-menu` and `clipboard` are nests inside the single `interaction` plugin, already
// composed by `presetStandard()`. There is no `stargantt.clipboard` service (interaction.md §2.4):
// clipboard operations are the `clipboard/*` commands only, so the page (and this spec) reads
// clipboard/held state from the page's own readouts rather than a service call. `clipboard/copy`
// always operates on the current selection (no per-id argument), so the page's contributed menu
// entries select the right-pressed task first, then dispatch. State changes are observed by
// subscribing to the relevant services' `.state`/`.tasks` stores.
//
// Class names, `data-item-id` attributes and `role="menuitem"`/`role="treegrid"` markup are
// verified against packages/plugins/interaction/src/internal/context-menu/menu.ts and
// packages/plugins/tree-grid/src/internal/grid-body.ts. The page exposes its chart through
// `window.gantt` (this repo's debug-handle convention).

const PAGE = "context-menu-clipboard.html";

const PANE = ".sg-pane--chart";
const GRID_ROW = ".sg-grid-row";
const MENU = ".sg-context-menu";
const MENU_ITEM = ".sg-context-menu-item";

/** The page's own default data: nine tasks, deterministic offsets from a day-floored today. */
const DEFAULT_TASK_COUNT = 9;

declare const gantt: {
  service(key: "stargantt.data"): {
    taskIds(): Iterable<string>;
    getTask(id: string): { id: string; name: string; start: number } | undefined;
  };
};

async function openPage(page: Page, openExample: OpenExample): Promise<void> {
  await openExample(PAGE, { ready: `${PANE} canvas` });
  await expect(page.locator("#taskCountReadout")).toHaveText(String(DEFAULT_TASK_COUNT));
  // The readout is written by the page's own store listener, which runs before the grid paints
  // its rows — and every probe below measures a row's box to aim a press. Waiting for the first
  // row here is what makes "the page is ready" mean the same thing on a loaded machine.
  await expect(page.locator(GRID_ROW).first()).toBeVisible();
}

/** A right-press at a chart-pane point, followed by the frame the menu would be placed in. */
async function rightPress(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.down({ button: "right" });
  await page.mouse.up({ button: "right" });
  await settle(page);
}

/** Closes an open menu with `Escape` (focus is inside the menu on open, §6.5). */
async function dismissMenu(page: Page): Promise<void> {
  if ((await page.locator(MENU).count()) === 0) return;
  await page.keyboard.press("Escape");
  await expect(page.locator(MENU)).toHaveCount(0);
}

/**
 * Right-presses inward from the chart pane's left edge on successive rows until a *bar* menu
 * opens, returning the point that worked. Bars start at the axis origin (today), but the exact
 * pixel width of a day is a zoom/layout detail no test should hard-code, hence the sweep.
 *
 * A right-press on empty space opens a menu too (the background target), so "did this probe hit a
 * bar" is decided by a bar-only entry — `delete` exists only for a hit target. Every miss is
 * dismissed before the next probe: an open menu sits under the following press point and would
 * swallow it.
 */
async function rightPressOnABar(page: Page): Promise<{ x: number; y: number }> {
  const pane = await page.locator(PANE).boundingBox();
  expect(pane).not.toBeNull();
  const rows = page.locator(GRID_ROW);
  const rowCount = await rows.count();
  expect(rowCount).toBeGreaterThan(0);

  for (let row = 0; row < Math.min(rowCount, 6); row += 1) {
    const box = await rows.nth(row).boundingBox();
    if (box === null || pane === null) continue;
    const y = box.y + box.height / 2;
    for (const dx of [20, 40, 70, 110, 170]) {
      const x = pane.x + dx;
      await rightPress(page, x, y);
      // Deliberately the non-retrying read: whether this probe hit a bar is already decided.
      if ((await page.locator(`${MENU_ITEM}[data-item-id="delete"]`).count()) > 0) return { x, y };
      await dismissMenu(page);
    }
  }
  throw new Error("no right-press on a task bar opened the context menu");
}

test.describe("clipboard", () => {
  test("copying a branch captures its subtree, and pasting it is one undo step", async ({
    page,
    openExample,
  }) => {
    await openPage(page, openExample);

    await page.click("#selectBranchBtn");
    await expect(page.locator("#selectionReadout")).toHaveText("discovery");

    await page.click("#copyBtn");
    await expect(page.locator("#clipboardReadout")).toHaveText("holds a copied subtree");

    // VERIFIED AGAINST THE RUNNING PAGE: the page's local TSV preview
    // (`previewCopyText`, examples/context-menu-clipboard.html) rebuilds from the CURRENT
    // SELECTION ONLY, not the copied subtree — its own header comment discloses this is an
    // approximation, since there is no `stargantt.clipboard` read-back service (interaction.md
    // §2.4). So the preview shows exactly the one selected row ("discovery" — a summary with no
    // `progress` field, hence the empty trailing tab), even though the ACTUAL `clipboard/copy`
    // command below captures the whole subtree per interaction.md §6.7 — proven by the +3 task
    // count after paste, not by this preview.
    const tsv = (await page.locator("#tsvReadout").textContent()) ?? "";
    const rows = tsv.split("\n");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("Discovery");
    expect(rows[0]).toMatch(/^Discovery\t\d{4}-\d{2}-\d{2}\t\d{4}-\d{2}-\d{2}\t$/);

    // A structured paste re-creates the whole captured subtree with fresh ids — the real
    // `clipboard/copy` command captured "discovery" AND its two children (interviews, audit),
    // regardless of what the local preview showed above.
    await page.click("#pasteBtn");
    await expect(page.locator("#taskCountReadout")).toHaveText(String(DEFAULT_TASK_COUNT + 3));

    // The whole paste is exactly one history entry, so a single undo reverses all three.
    await page.click("#undoBtn");
    await expect(page.locator("#taskCountReadout")).toHaveText(String(DEFAULT_TASK_COUNT));
  });

  test("duplicate copies in place without disturbing the held clipboard", async ({
    page,
    openExample,
  }) => {
    await openPage(page, openExample);

    // Nothing held yet: the toolbar refuses the paste instead of silently doing nothing.
    await page.click("#pasteBtn");
    await expect(page.locator("#statusReadout")).toContainText("Nothing to paste");
    await expect(page.locator("#taskCountReadout")).toHaveText(String(DEFAULT_TASK_COUNT));

    // `clipboard/duplicate` does not overwrite the held payload, and there is none.
    await page.click("#selectBranchBtn");
    await page.click("#duplicateBtn");
    await expect(page.locator("#taskCountReadout")).toHaveText(String(DEFAULT_TASK_COUNT + 3));
    await expect(page.locator("#clipboardReadout")).toHaveText("empty");

    // One undo step for the whole duplicate.
    await page.click("#undoBtn");
    await expect(page.locator("#taskCountReadout")).toHaveText(String(DEFAULT_TASK_COUNT));
  });

  test("a foreign tab-separated paste writes cell values from the anchor row down", async ({
    page,
    openExample,
  }) => {
    await openPage(page, openExample);

    // The anchor is the focused row. Nothing carries an implicit initial focus here:
    // `stargantt.focus`'s `FocusState` is set only by a real moveFocus/focusTask call (keyboard,
    // pointer or api — a11y.md), never by mount alone (verified against the running page: the
    // readout reads "(none)" before any interaction). A plain click on the first row's name cell
    // is the pointer path that sets it, mirroring interaction.spec.ts's own selection tests.
    await page.locator(GRID_ROW).first().locator('.sg-grid-cell[data-column-id="name"]').click();
    await expect(page.locator("#anchorReadout")).toHaveText("relaunch");

    await page.click("#pasteCellsBtn");

    // Two text rows onto the two editable rows from the anchor downward: summary rows are not
    // cell-paste targets, so the anchor row ("Website relaunch") and the next summary
    // ("Discovery") are stepped over and the values land on the first two ordinary tasks. A cell
    // paste updates existing rows rather than creating tasks, so the task count does not move.
    await expect(page.locator("#taskCountReadout")).toHaveText(String(DEFAULT_TASK_COUNT));
    const mirrorRow = page.locator('[role="treegrid"] [role="row"]');
    await expect(mirrorRow.nth(0)).toContainText("Website relaunch");
    await expect(mirrorRow.nth(1)).toContainText("Discovery");
    await expect(mirrorRow.nth(2)).toContainText("Kickoff workshop");
    await expect(mirrorRow.nth(3)).toContainText("Accessibility audit");

    // The two-row paste is one history entry.
    await page.click("#undoBtn");
    await expect(mirrorRow.nth(2)).toContainText("Stakeholder interviews");
    await expect(mirrorRow.nth(3)).toContainText("Content audit");
  });
});

test.describe("context menu", () => {
  test("a right-press on a bar opens the menu with the built-in and contributed entries", async ({
    page,
    openExample,
  }) => {
    await openPage(page, openExample);
    await rightPressOnABar(page);

    // The menu survived the dispatch that opened it, and there is exactly one of it.
    const menu = page.locator(MENU);
    await expect(menu).toHaveCount(1);

    // interaction.md §6.5 — one `role="menu"` element with an accessible name, entries as
    // `role="menuitem"`, each at least 24 CSS px tall.
    await expect(menu).toHaveAttribute("role", "menu");
    await expect(menu).toHaveAttribute("aria-label", /.+/);
    await expect(page.locator(MENU_ITEM).first()).toHaveAttribute("role", "menuitem");

    // The built-in entries for a bar target, in their fixed order; `link-to` is disabled until a
    // link source has been armed. Then the page's own `contextmenu/items` contribution.
    const ids = await page.locator(MENU_ITEM).evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-item-id")),
    );
    expect(ids).toEqual([
      "insert",
      "duplicate",
      "delete",
      "link-from",
      "link-to",
      "demo-copy",
      "demo-duplicate",
    ]);
    await expect(page.locator(`${MENU_ITEM}[data-item-id="link-to"]`)).toHaveAttribute(
      "aria-disabled",
      "true",
    );

    const heights = await page.locator(MENU_ITEM).evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect().height),
    );
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(24);

    // Focus moves to the first enabled entry on open, arrows rove, Escape closes. Asserted
    // through `document.activeElement` in the page's own world (see interaction.spec.ts's
    // equivalent probes for why `toBeFocused()` is avoided here).
    const activeItem = () =>
      page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null;
        if (active === null || active.closest(".sg-context-menu") === null) return null;
        return active.dataset?.itemId ?? null;
      });
    await expect.poll(activeItem, { message: "focus lands on the first enabled entry" }).toBe(
      "insert",
    );
    await page.keyboard.press("ArrowDown");
    await expect.poll(activeItem, { message: "ArrowDown roves to the next entry" }).toBe(
      "duplicate",
    );
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  });

  test("the opening press is ignored by the outside-press closer, the next press is not", async ({
    page,
    openExample,
  }) => {
    await openPage(page, openExample);
    await rightPressOnABar(page);

    // The press that opened the menu bubbled to the document-level closer already; the menu is
    // still open one full dispatch (and two animation frames) later.
    await expect(page.locator(MENU)).toHaveCount(1);

    // A press outside the chart pane produces no renderer pointer event at all, so only that same
    // document-level listener can close the menu — and for a second, genuine press it must.
    const outside = await page.locator("h1").boundingBox();
    expect(outside).not.toBeNull();
    if (outside === null) return;
    await page.mouse.move(outside.x + outside.width / 2, outside.y + outside.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    await expect(page.locator(MENU)).toHaveCount(0);
  });

  test("activating a built-in entry dispatches exactly one command", async ({
    page,
    openExample,
  }) => {
    await openPage(page, openExample);
    await rightPressOnABar(page);

    // `duplicate` dispatches a single `task/add`, hence exactly one undo step.
    await page.locator(`${MENU_ITEM}[data-item-id="duplicate"]`).click();
    await expect(page.locator(MENU)).toHaveCount(0);
    await expect(page.locator("#taskCountReadout")).toHaveText(String(DEFAULT_TASK_COUNT + 1));

    await page.click("#undoBtn");
    await expect(page.locator("#taskCountReadout")).toHaveText(String(DEFAULT_TASK_COUNT));
  });

  test("the background target and the extras toggle change the collected entry list", async ({
    page,
    openExample,
  }) => {
    await openPage(page, openExample);

    // A `"background"` target offers only the root-level insert (no pending link source), and the
    // page's contribution answers hit targets only, so nothing is appended. The press goes one row
    // below the last data row: empty chart space, clear of both scrollbar trays. The last row sits
    // below the default 720px viewport fold on this page, and a press outside the viewport
    // dispatches nothing — scroll it into view first and measure afterwards.
    await page.locator(GRID_ROW).last().scrollIntoViewIfNeeded();
    const pane = await page.locator(PANE).boundingBox();
    expect(pane).not.toBeNull();
    const lastRow = await page.locator(GRID_ROW).last().boundingBox();
    expect(lastRow).not.toBeNull();
    if (pane === null || lastRow === null) return;
    const pressY = lastRow.y + lastRow.height * 1.5;
    const viewportHeight = page.viewportSize()?.height ?? 0;
    expect(pressY, "press point must be inside the viewport").toBeLessThan(viewportHeight);
    await rightPress(page, pane.x + pane.width / 2, pressY);
    await expect(page.locator(MENU_ITEM)).toHaveCount(1);
    await expect(page.locator(MENU_ITEM)).toHaveText("Insert task");
    await dismissMenu(page);

    // With the page's contribution switched off, only the fallback provider's entries remain for
    // a bar target.
    await page.click("#extrasToggle");
    await expect(page.locator("#extrasToggle")).toHaveAttribute("aria-pressed", "false");
    await rightPressOnABar(page);
    const ids = await page.locator(MENU_ITEM).evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-item-id")),
    );
    expect(ids).toEqual(["insert", "duplicate", "delete", "link-from", "link-to"]);
  });
});

// interaction.md §6.5 (grid-pane menu target) / §6.1 (insert placement) — the grid pane's own
// menu, and where an insert on empty chart space lands.
test.describe("the grid-row menu and insert placement", () => {
  const GRID_PANE = ".sg-pane--grid";
  const NAME_CELL = '.sg-grid-cell[data-column-id="name"]';

  /** The name column of every materialized grid row, top to bottom. */
  async function rowNames(page: Page): Promise<string[]> {
    return page.locator(`${GRID_ROW} ${NAME_CELL}`).allTextContents();
  }

  /** A right-press on a grid row's name cell, followed by the frame the menu is placed in. */
  async function rightPressRow(page: Page, row: number): Promise<void> {
    await page.locator(GRID_ROW).nth(row).locator(NAME_CELL).click({ button: "right" });
    await settle(page);
  }

  test("a right-press on a grid row opens the menu in the grid pane", async ({
    page,
    openExample,
  }) => {
    await openPage(page, openExample);
    await rightPressRow(page, 0);

    // Same entries a bar gives: a row is the task, seen from the other pane.
    const ids = await page.locator(MENU_ITEM).evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-item-id")),
    );
    expect(ids).toEqual(["insert", "duplicate", "delete", "link-from", "link-to"]);

    // Mounted in the grid pane, not the chart's DOM overlay, which clips its own overflow — and
    // still open after its own opening press has been dispatched.
    await expect(page.locator(`${GRID_PANE} ${MENU}`)).toHaveCount(1);
    await expect(page.locator(`.sg-dom-overlay ${MENU}`)).toHaveCount(0);

    await dismissMenu(page);
  });

  test("it acts on the row it was opened on", async ({ page, openExample }) => {
    await openPage(page, openExample);
    const names = await rowNames(page);
    const target = names.indexOf("Content audit");
    expect(target).toBeGreaterThan(0);

    await rightPressRow(page, target);
    await page.locator(`${MENU_ITEM}[data-item-id="delete"]`).click();
    await settle(page);

    await expect(page.locator("#taskCountReadout")).toHaveText(String(DEFAULT_TASK_COUNT - 1));
    expect(await rowNames(page)).not.toContain("Content audit");
  });

  test("insert on a row's empty chart space makes a dated child of that row", async ({
    page,
    openExample,
  }) => {
    await openPage(page, openExample);
    const names = await rowNames(page);
    // "Launch" is the last task and starts weeks after the axis origin, so the left edge of its
    // row is empty chart space — a background press inside a task's lane, which is exactly the
    // gesture this scenario is about.
    const lane = names.indexOf("Launch");
    expect(lane).toBeGreaterThan(0);
    const row = await page.locator(GRID_ROW).nth(lane).boundingBox();
    const pane = await page.locator(PANE).boundingBox();
    expect(row).not.toBeNull();
    expect(pane).not.toBeNull();
    if (row === null || pane === null) return;

    await rightPress(page, pane.x + 12, row.y + row.height / 2);
    const ids = await page.locator(MENU_ITEM).evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-item-id")),
    );
    expect(ids, "a background press offers the insert alone").toEqual(["insert"]);
    await page.locator(`${MENU_ITEM}[data-item-id="insert"]`).click();
    await settle(page);

    await expect(page.locator("#taskCountReadout")).toHaveText(String(DEFAULT_TASK_COUNT + 1));
    // The new row is a child of the row the press landed in, so it appears directly under it and
    // one level deeper — depth being visible as the first cell's indent.
    const after = await rowNames(page);
    const added = after.indexOf("New task");
    expect(added).toBe(lane + 1);
    // And it really is *under* it, not merely next to it: the pressed row was a leaf and now
    // carries an expand toggle, which only a row with children gets.
    await expect(page.locator(GRID_ROW).nth(lane).locator(".sg-grid-toggle")).toHaveCount(1);

    // The dates are painted on canvas, so the store is where they can be read; the page's own
    // `window.gantt` debug handle is the documented way in.
    const start = await page.evaluate(() => {
      const g = (window as unknown as { gantt?: typeof gantt }).gantt;
      if (g === undefined) return null;
      const data = g.service("stargantt.data");
      for (const id of data.taskIds()) {
        const task = data.getTask(id);
        if (task?.name === "New task") return task.start;
      }
      return null;
    });
    expect(start).not.toBeNull();
    // Not the epoch: a real date on a day boundary, near the axis origin the press pointed at
    // rather than 1970-01-01.
    expect(start).toBeGreaterThan(Date.now() - 365 * 86_400_000);
    expect((start ?? 1) % 86_400_000).toBe(0);
  });
});
