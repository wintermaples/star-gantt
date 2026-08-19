import { FIXED_TIME, expect, settle, test } from "./_fixtures";
import type { OpenExample } from "./_fixtures";
import type { Page } from "@playwright/test";

// E2E for examples/insert-placement.html (docs/specs/plugins/interaction.md §6.5
// `contextMenu.insertMode`, tree-grid.md "Insert rows", view.md's `view/rowInsert`/`view/rowToggle`
// commands).
//
// The page exposes its instance as `window.gantt` (declared below via `declare const gantt`), the
// same pattern e2e/scheduling.spec.ts uses. Every gesture below is a real right-press on the chart
// or the grid — invocation is pointer-only — and every outcome is read back through the public API
// (`gantt.service("stargantt.data")`) or the page's own live readouts, because bars are painted on
// canvas.

const PAGE = "insert-placement.html";

const PANE = ".sg-pane--chart";
const GRID_ROW = ".sg-grid-row";
const NAME_CELL = '.sg-grid-cell[data-column-id="name"]';
const MENU_ITEM = ".sg-context-menu-item";

const DAY = 86_400_000;

/** The page's own default data: the root summary, three tasks, the "Content migration" project
 *  with its two children, and the milestone. */
const DEFAULT_TASK_COUNT = 8;

interface ProbeTask {
  id: string;
  name: string;
  parentId: string | null;
  start: number;
  end: number;
}

declare const gantt: {
  dispatch<K extends string>(cmd: K, payload: unknown): void;
  service(key: "stargantt.data"): {
    taskIds(): Iterable<string>;
    getTask(id: string): ProbeTask | undefined;
  };
  service(key: "stargantt.timeline"): {
    tToX(t: number): number;
  };
  service(key: "stargantt.view"): {
    viewport: { get(): { scrollLeft: number } };
  };
  service(key: "stargantt.task-bars"): {
    barBoxOf(id: string): { x: number; y: number; width: number; height: number } | undefined;
  };
};

async function openPage(page: Page, openExample: OpenExample): Promise<void> {
  // The clock is pinned *before* navigation, so the page's own day-floored "today" anchor and the
  // `day0` every assertion below is written against are the same instant.
  await openExample(PAGE, { ready: `${PANE} canvas`, fixedTime: FIXED_TIME });
  await expect(page.locator("#taskCountReadout")).toHaveText(String(DEFAULT_TASK_COUNT));
  await expect(page.locator(GRID_ROW).first()).toBeVisible();
}

/** Every task in the store, in store order, flattened to what these assertions need. */
async function tasks(page: Page): Promise<ProbeTask[]> {
  return page.evaluate(() => {
    const data = gantt.service("stargantt.data");
    const out: ProbeTask[] = [];
    for (const id of data.taskIds()) {
      const task = data.getTask(id);
      if (task === undefined) continue;
      out.push({ id: task.id, name: task.name, parentId: task.parentId, start: task.start, end: task.end });
    }
    return out;
  });
}

/** The one task the store holds under `name`, failing the test when there is not exactly one. */
async function taskNamed(page: Page, name: string): Promise<ProbeTask> {
  const found = (await tasks(page)).filter((t) => t.name === name);
  expect(found, `exactly one task named ${name}`).toHaveLength(1);
  return found[0] as ProbeTask;
}

/**
 * The client x of an instant, computed from the live axis rather than an assumed pixel density:
 * the zoom level, the pane's own left edge and the horizontal scroll all move it.
 */
async function xOf(page: Page, t: number): Promise<number> {
  const pane = await page.locator(PANE).boundingBox();
  expect(pane).not.toBeNull();
  if (pane === null) throw new Error("no chart pane");
  const contentX = await page.evaluate((instant) => {
    const x = gantt.service("stargantt.timeline").tToX(instant);
    return x - gantt.service("stargantt.view").viewport.get().scrollLeft;
  }, t);
  const x = pane.x + contentX;
  expect(x, "the probe point is inside the chart pane").toBeLessThan(pane.x + pane.width - 4);
  return x;
}

/** Today 0:00 UTC under the pinned clock — the axis origin the page's data is laid out from. */
function originDay(): number {
  return Math.floor(FIXED_TIME.getTime() / DAY) * DAY;
}

/** A right-press at a chart-pane point, followed by the frame the menu is placed in. */
async function rightPress(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.down({ button: "right" });
  await page.mouse.up({ button: "right" });
  await settle(page);
}

/** The vertical middle of the grid row whose name cell reads `name`. */
async function rowMiddle(page: Page, name: string): Promise<number> {
  const names = await page.locator(`${GRID_ROW} ${NAME_CELL}`).allTextContents();
  const index = names.indexOf(name);
  expect(index, `a visible row named ${name}`).toBeGreaterThanOrEqual(0);
  const box = await page.locator(GRID_ROW).nth(index).boundingBox();
  expect(box).not.toBeNull();
  if (box === null) throw new Error("no row box");
  return box.y + box.height / 2;
}

async function activateInsert(page: Page): Promise<void> {
  await page.locator(`${MENU_ITEM}[data-item-id="insert"]`).click();
  await settle(page);
}

test.describe("insert placement and duration", () => {
  test("a grid-row insert into a summary creates a child one day long at the day zoom", async ({
    page,
    openExample,
  }) => {
    await openPage(page, openExample);
    const day0 = originDay();

    // Row 0 is "Website relaunch", already a summary — the branch the one-grid-cell rule governs.
    await page.locator(GRID_ROW).nth(0).locator(NAME_CELL).click({ button: "right" });
    await settle(page);
    await activateInsert(page);

    await expect(page.locator("#taskCountReadout")).toHaveText(String(DEFAULT_TASK_COUNT + 1));
    const added = await taskNamed(page, "New task");
    expect(added.parentId).toBe("relaunch");
    expect(added.start).toBe(day0);
    expect(added.end - added.start).toBe(DAY);
  });

  // The leaf exception: "Design system" has no children, so the insert promotes it to a summary
  // and a summary's dates come from its children — a one-cell child would shrink a six-day task to
  // one day, so the child copies the span instead and nothing moves.
  test("a grid-row insert into a leaf gives the child that leaf's whole span", async ({ page, openExample }) => {
    await openPage(page, openExample);
    const day0 = originDay();

    await page.locator(GRID_ROW).nth(1).locator(NAME_CELL).click({ button: "right" });
    await settle(page);
    await activateInsert(page);

    const added = await taskNamed(page, "New task");
    expect(added.parentId).toBe("design");
    expect(added.start).toBe(day0);
    expect(added.end).toBe(day0 + 6 * DAY);
    const parent = await taskNamed(page, "Design system");
    expect(parent.start).toBe(day0);
    expect(parent.end).toBe(day0 + 6 * DAY);
  });

  test("the duration follows the zoom level's cell", async ({ page, openExample }) => {
    await openPage(page, openExample);
    const day0 = originDay();

    await page.selectOption("#zoomSelect", "week");
    await settle(page);

    // The summary row again: the leaf exception ignores the cell, so a leaf cannot measure it.
    await page.locator(GRID_ROW).nth(0).locator(NAME_CELL).click({ button: "right" });
    await settle(page);
    await activateInsert(page);

    const added = await taskNamed(page, "New task");
    expect(added.start).toBe(day0);
    expect(added.end - added.start).toBe(7 * DAY);
  });

  test("view/rowInsert with no position inserts a child under the same rule as the menu", async ({
    page,
    openExample,
  }) => {
    await openPage(page, openExample);
    const day0 = originDay();

    await page.click("#insertChildBtn");
    await settle(page);

    await expect(page.locator("#taskCountReadout")).toHaveText(String(DEFAULT_TASK_COUNT + 1));
    const added = await taskNamed(page, "New task");
    expect(added.parentId).toBe("design");
    expect(added.start).toBe(day0);
    expect(added.end).toBe(day0 + 6 * DAY);
  });
});

test.describe("an insert beside a bar still creates a task", () => {
  test("a press in a task's empty lane creates a child at the pressed cell", async ({ page, openExample }) => {
    // examples/insert-placement.html's refresh() previously did not subscribe to
    // stargantt.history's `state` store, relying solely on the incidental data.tasks/rows
    // subscriptions to also refresh #undoBtn/#redoBtn. Verified against the live page and the
    // store directly: gantt.service("stargantt.history").state.get() read
    // `{ canUndo: true, depth: 1 }` immediately after this insert — a genuine single undo step —
    // while #undoBtn stayed disabled until the NEXT edit's refresh() call happened to observe the
    // now-settled history state one edit late (drag-and-undo.html and dependencies-scheduling.html
    // both already called `history.state.subscribe(...)` correctly). The page now subscribes to
    // stargantt.history's state store directly, so the `#undoBtn` click at the end of this test
    // (below) exercises the real, live-enabled button rather than one that would still be one edit
    // stale.

    await openPage(page, openExample);
    const day0 = originDay();

    // "Design system" runs days 0-6; day 8 is empty chart space in its own lane. The press picks
    // the parent, but "Design system" is a leaf, so the leaf exception picks the span: honouring
    // the pressed day would hand the promoted summary its child's dates and *move* the row.
    const y = await rowMiddle(page, "Design system");
    await rightPress(page, await xOf(page, day0 + 8.5 * DAY), y);
    await activateInsert(page);

    await expect(page.locator("#taskCountReadout")).toHaveText(String(DEFAULT_TASK_COUNT + 1));
    const added = await taskNamed(page, "New task");
    expect(added.parentId).toBe("design");
    expect(added.start).toBe(day0);
    expect(added.end).toBe(day0 + 6 * DAY);

    // One command, so one undo step.
    await page.click("#undoBtn");
    await settle(page);
    await expect(page.locator("#taskCountReadout")).toHaveText(String(DEFAULT_TASK_COUNT));
  });

  test("a press over the bar creates a child dated from that task's own start", async ({ page, openExample }) => {
    await openPage(page, openExample);
    const day0 = originDay();

    const y = await rowMiddle(page, "Design system");
    // Day 2 is inside the bar. "Design system" is a leaf, so the new child takes its whole span.
    await rightPress(page, await xOf(page, day0 + 2.5 * DAY), y);
    await activateInsert(page);

    await expect(page.locator("#taskCountReadout")).toHaveText(String(DEFAULT_TASK_COUNT + 1));
    const added = await taskNamed(page, "New task");
    expect(added.parentId).toBe("design");
    expect(added.start).toBe(day0);
    expect(added.end).toBe(day0 + 6 * DAY);
  });
});

// The page composes `taskBars.collapsedSummary: "split"`, so "Content migration" is a folded
// project whose row paints its direct children. An insert there still goes under the task the
// press named.
test.describe("inserting into a collapsed split row", () => {
  test("a press on an in-row child inserts under that child, not into the project", async ({
    page,
    openExample,
  }) => {
    await openPage(page, openExample);

    // The project starts folded, so its row carries its two children's bars, not its own glyph.
    await expect(page.locator("#splitReadout")).toHaveText("Audit, Move");
    const inRow = await page.evaluate(() => {
      const svc = gantt.service("stargantt.task-bars");
      return {
        parent: svc.barBoxOf("migration") !== undefined,
        audit: svc.barBoxOf("mig-audit") !== undefined,
        move: svc.barBoxOf("mig-move") !== undefined,
      };
    });
    expect(inRow).toEqual({ parent: false, audit: true, move: true });

    // A press on the in-row "Move" bar names that child; "Move" is a leaf running days 12-16, so
    // the new task takes that whole span.
    const day0 = originDay();
    const y = await rowMiddle(page, "Content migration");
    await rightPress(page, await xOf(page, day0 + 13.5 * DAY), y);
    await activateInsert(page);

    await expect(page.locator("#taskCountReadout")).toHaveText(String(DEFAULT_TASK_COUNT + 1));
    const added = await taskNamed(page, "New task");
    expect(added.parentId).toBe("mig-move");
    expect(added.start).toBe(day0 + 12 * DAY);
    expect(added.end).toBe(day0 + 16 * DAY);

    // A split row shows the *direct* children only, so the new grandchild is not painted in it.
    await expect(page.locator("#splitReadout")).toHaveText("Audit, Move");
  });

  test("a press in the project's own lane inserts into the project and reveals it", async ({
    page,
    openExample,
  }) => {
    await openPage(page, openExample);
    const day0 = originDay();

    // Days 10-12 are the gap between the two in-row children: inside the project's row, over no
    // child bar, so the press is a background one and the row's own task is the parent.
    const y = await rowMiddle(page, "Content migration");
    await rightPress(page, await xOf(page, day0 + 10.5 * DAY), y);
    await activateInsert(page);

    const added = await taskNamed(page, "New task");
    expect(added.parentId).toBe("migration");
    expect(added.start).toBe(day0 + 10 * DAY);
    expect(added.end).toBe(day0 + 11 * DAY);

    // The new child would have landed out of sight, so the entry expanded its parent.
    await expect(page.locator("#splitReadout")).toHaveText("its own summary bar (expanded)");

    // Folding it again puts all three direct children back in the project's own row.
    await page.click("#splitToggleBtn");
    await expect(page.locator("#splitReadout")).toHaveText("Audit, Move, New task");
  });

  test("folding the row again is display state, not a second undo step", async ({ page, openExample }) => {
    await openPage(page, openExample);

    await page.click("#splitToggleBtn");
    await expect(page.locator("#splitReadout")).toHaveText("its own summary bar (expanded)");
    await page.click("#splitToggleBtn");
    await expect(page.locator("#splitReadout")).toHaveText("Audit, Move");

    // No transaction was produced by either toggle.
    await expect(page.locator("#undoBtn")).toBeDisabled();
  });
});
