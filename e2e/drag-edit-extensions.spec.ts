import { expect, test } from "./_fixtures";
import type { OpenExample } from "./_fixtures";
import type { Page } from "@playwright/test";

// E2E for examples/drag-edit-features.html: the drag-edit extensions —
// docs/specs/plugins/interaction.md §6.2 `dragEdit`.
//
// examples/interaction.html (e2e/interaction.spec.ts) also composes `dragTooltip`, `rowDrag` and
// `autoScroll`, but interaction.spec.ts's own tests never exercise those three paths (its describe
// blocks cover move/resize/progress editing, selection, keyboard, tooltip, context menu, edit
// dialog, side panel, filter/search, zoom and clipboard — none of them a drag tooltip, a row
// reorder, or an edge-triggered auto-scroll). This file is therefore the suite's only coverage of
// those three, plus `clickMove` and a `resourceDrag`-without-a-provider fall-through, both unique
// to this page (interaction.html leaves `clickMove: false` and never sets `resourceDrag`).
//
// Verification reads task state through the public services on `window.gantt` (this page assigns
// `window.gantt = gantt` directly) and asserts DOM — no new screenshot baselines.

const PANE = ".sg-pane--chart";
const TOOLTIP = ".sg-drag-tooltip";
const DAY_MS = 86_400_000;

declare const gantt: {
  service(key: "stargantt.data"): {
    getTask(id: string): { id: string; start: number; end: number; parentId: string | null } | undefined;
  };
  service(key: "stargantt.timeline"): { pxPerMs: number; tToX(t: number): number };
  service(key: "stargantt.rows"): {
    rowOf(id: string): number | undefined;
    yOf(row: number): number;
    rowHeight(row: number): number;
  };
  service(key: "stargantt.view"): {
    viewport: { get(): { scrollTop: number; scrollLeft: number } };
  };
  service(key: "stargantt.task-bars"): {
    barBoxOf(id: string): { x: number; y: number; width: number; height: number } | undefined;
  };
  service(key: "stargantt.history"): {
    state: { get(): { canUndo: boolean; canRedo: boolean } };
    undo(): void;
  };
  getService(key: string): unknown;
};

interface TaskSnapshot {
  start: number;
  end: number;
}

interface BarGeometry {
  centerX: number;
  centerY: number;
  paneLeft: number;
  paneRight: number;
  pxPerDay: number;
}

async function chartBodyBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator(`${PANE} canvas.sg-layer`).first().boundingBox();
  if (box === null) throw new Error("chart body canvas not found");
  return box;
}

async function boot(page: Page, openExample: OpenExample): Promise<void> {
  await openExample("drag-edit-features.html", { ready: `${PANE} canvas` });
  await expect.poll(async () => taskOf(page, "build").then((t) => t.start)).not.toBeUndefined();
}

async function taskOf(page: Page, id: string): Promise<TaskSnapshot> {
  return page.evaluate((taskId) => {
    const task = gantt.service("stargantt.data").getTask(taskId);
    if (task === undefined) throw new Error(`task ${taskId} not found`);
    return { start: task.start, end: task.end };
  }, id);
}

async function parentOf(page: Page, id: string): Promise<string | null> {
  return page.evaluate((taskId) => gantt.service("stargantt.data").getTask(taskId)?.parentId ?? null, id);
}

async function barGeometry(page: Page, id: string): Promise<BarGeometry> {
  const pane = await chartBodyBox(page);
  const box = await page.evaluate((taskId) => {
    const b = gantt.service("stargantt.task-bars").barBoxOf(taskId);
    if (b === undefined) return null;
    const pxPerDay = gantt.service("stargantt.timeline").pxPerMs * 86_400_000;
    return { x: b.x, y: b.y, width: b.width, height: b.height, pxPerDay };
  }, id);
  if (box === null) throw new Error(`no visible bar for task "${id}"`);
  return {
    centerX: pane.x + box.x + box.width / 2,
    centerY: pane.y + box.y + box.height / 2,
    paneLeft: pane.x,
    paneRight: pane.x + pane.width,
    pxPerDay: box.pxPerDay,
  };
}

/** Client x of an arbitrary instant on the chart body — used for the click-move placement press. */
async function xOfInstant(page: Page, t: number): Promise<number> {
  const pane = await chartBodyBox(page);
  const x = await page.evaluate((time) => {
    const timeline = gantt.service("stargantt.timeline");
    const vp = gantt.service("stargantt.view").viewport.get();
    return timeline.tToX(time) - vp.scrollLeft;
  }, t);
  return pane.x + x;
}

async function historyState(page: Page): Promise<{ canUndo: boolean; canRedo: boolean }> {
  return page.evaluate(() => gantt.service("stargantt.history").state.get());
}

async function rowBoxOf(page: Page, id: string): Promise<{ x: number; y: number; height: number }> {
  const row = await page.evaluate((taskId) => gantt.service("stargantt.rows").rowOf(taskId), id);
  if (row === undefined) throw new Error(`task "${id}" has no row`);
  const box = await page.locator(`.sg-pane--grid .sg-grid-row[data-row-index="${row}"]`).boundingBox();
  if (box === null) throw new Error(`row ${row} has no box`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, height: box.height };
}

test.describe("drag-edit extensions (examples/drag-edit-features.html)", () => {
  test("the drag tooltip appears during a bar drag with committable dates and hides on release", async ({
    page,
    openExample,
  }) => {
    await boot(page, openExample);
    const before = await taskOf(page, "build");
    const bar = await barGeometry(page, "build");
    expect(bar.centerX).toBeGreaterThan(bar.paneLeft);
    expect(bar.centerX).toBeLessThan(bar.paneRight);

    await expect(page.locator(TOOLTIP)).toBeHidden();

    await page.mouse.move(bar.centerX, bar.centerY);
    await page.mouse.down();
    await page.mouse.move(bar.centerX + 8, bar.centerY);
    await page.mouse.move(bar.centerX + 40, bar.centerY);

    const tooltip = page.locator(TOOLTIP);
    await expect(tooltip).toBeVisible();
    // The default catalog builder renders two ISO days around an en dash (interaction.md §6.2).
    await expect(tooltip).toHaveText(/\d{4}-\d{2}-\d{2} – \d{4}-\d{2}-\d{2}/);
    // Placed above the dragged bar so the bar and its handles stay unobscured.
    const box = await tooltip.boundingBox();
    expect(box).not.toBeNull();
    if (box !== null) {
      expect(box.y + box.height).toBeLessThanOrEqual(bar.centerY);
    }

    await page.mouse.up();
    await expect(tooltip).toBeHidden();

    await expect.poll(async () => (await taskOf(page, "build")).start).not.toBe(before.start);
    await page.evaluate(() => gantt.service("stargantt.history").undo());
    await expect.poll(async () => (await taskOf(page, "build")).start).toBe(before.start);
  });

  test("click-move picks a bar up and places its start on the next background click, one undo entry", async ({
    page,
    openExample,
  }) => {
    await boot(page, openExample);
    const before = await taskOf(page, "review");
    const duration = before.end - before.start;
    const root = await taskOf(page, "root");
    const target = root.start + 17 * DAY_MS;
    const bar = await barGeometry(page, "review");
    const xOf = await xOfInstant(page, target);
    expect(bar.centerX).toBeGreaterThan(bar.paneLeft);
    expect(xOf).toBeLessThan(bar.paneRight);

    // Pick up: press-and-release on the bar body.
    await page.mouse.click(bar.centerX, bar.centerY);
    // Nothing is dispatched by the pick-up itself.
    expect(await taskOf(page, "review")).toEqual(before);

    // Place: a background press on the same row at root.start + 17 days, a date with no bar under
    // it, so the hit test reports background.
    await page.mouse.click(xOf, bar.centerY);

    await expect.poll(async () => (await taskOf(page, "review")).start).not.toBe(before.start);
    const moved = await taskOf(page, "review");
    expect(moved.end - moved.start).toBe(duration);
    expect(moved.start % DAY_MS).toBe(0);
    expect(Math.abs(moved.start - target)).toBeLessThanOrEqual(DAY_MS / 2 + 1);

    await page.evaluate(() => gantt.service("stargantt.history").undo());
    await expect.poll(async () => (await taskOf(page, "review")).start).toBe(before.start);
    expect((await historyState(page)).canUndo).toBe(false);
  });

  // interaction.md §1.1 "Auto-scroll" — only a real browser can show this: the pointer stops moving
  // inside the edge zone and the view keeps scrolling by itself, frame after frame, until release.
  test("auto-scroll advances the view while a drag holds near the pane's right edge, and stops on release", async ({
    page,
    openExample,
  }) => {
    await boot(page, openExample);
    const scrollLeft = async (): Promise<number> =>
      page.evaluate(() => gantt.service("stargantt.view").viewport.get().scrollLeft);
    expect(await scrollLeft()).toBe(0);

    const before = await taskOf(page, "build");
    const bar = await barGeometry(page, "build");

    await page.mouse.move(bar.centerX, bar.centerY);
    await page.mouse.down();
    await page.mouse.move(bar.centerX + 8, bar.centerY);
    await page.mouse.move(bar.paneRight - 6, bar.centerY);

    await expect.poll(async () => scrollLeft()).toBeGreaterThan(0);
    const parked = await scrollLeft();

    await page.mouse.up();
    const atRelease = await scrollLeft();
    expect(atRelease).toBeGreaterThanOrEqual(parked);
    await page.waitForTimeout(200);
    expect(await scrollLeft()).toBe(atRelease);

    await expect.poll(async () => (await taskOf(page, "build")).start).not.toBe(before.start);
    await page.evaluate(() => gantt.service("stargantt.history").undo());
    await expect.poll(async () => (await taskOf(page, "build")).start).toBe(before.start);
  });

  // interaction.md §6.2 `resourceDrag` — the seam is resolved at gesture time via the `drag/lanes`
  // extension point, whose official contributor is the resource plugin. `presetStandard()` does not
  // compose it, so no provider is ever registered and the flag is completely inert: the same
  // vertical drag that would reassign a resource in a lane view still reorders the row here.
  test("resourceDrag is inert without a resource-lane view: the vertical drag still reorders rows", async ({
    page,
    openExample,
  }) => {
    await boot(page, openExample);

    // Nothing publishes a lane view on this page — that is the precondition the test rests on.
    expect(await page.evaluate(() => gantt.getService("stargantt.resource") !== undefined)).toBe(false);

    const rowOf = async (id: string): Promise<number | undefined> =>
      page.evaluate((taskId) => gantt.service("stargantt.rows").rowOf(taskId), id);

    expect(await rowOf("spec")).toBe(1);
    expect(await rowOf("qa")).toBe(4);

    const spec = await barGeometry(page, "spec");
    const qa = await barGeometry(page, "qa");

    // A body press followed by a dominantly vertical move past the threshold: the row drag, not a
    // date drag.
    await page.mouse.move(spec.centerX, spec.centerY);
    await page.mouse.down();
    await page.mouse.move(spec.centerX, spec.centerY + 8);
    await page.mouse.move(spec.centerX, qa.centerY + 4);
    await page.mouse.up();

    await expect.poll(async () => rowOf("spec")).toBe(4);

    await page.evaluate(() => gantt.service("stargantt.history").undo());
    await expect.poll(async () => rowOf("spec")).toBe(1);
  });

  // interaction.md §6.2 `rowDrag` (the gesture starts in the grid pane too) / the row-drop
  // outline-depth arithmetic (internal/drag/row-drag.ts DEPTH_STEP_PX). Both are only observable
  // with a real grid pane under a real pointer.
  test("a grid-row drag re-parents, and travelling left lifts the task to the root", async ({
    page,
    openExample,
  }) => {
    await boot(page, openExample);
    expect(await parentOf(page, "spec")).toBe("root");

    const spec = await rowBoxOf(page, "spec");
    const ship = await rowBoxOf(page, "ship");

    // Press the grid row, travel past the threshold down to the gap below the last row, and left —
    // more than one outline-indent step (16px), which asks for the root level.
    await page.mouse.move(spec.x, spec.y);
    await page.mouse.down();
    await page.mouse.move(spec.x, spec.y + 8);
    await page.mouse.move(spec.x - 24, ship.y + ship.height);
    await expect(page.locator(".sg-pane--grid .sg-grid-drop-indicator")).toBeVisible();
    await page.mouse.up();

    await expect.poll(async () => parentOf(page, "spec")).toBeNull();
    await expect(page.locator(".sg-pane--grid .sg-grid-drop-indicator")).toBeHidden();

    await page.evaluate(() => gantt.service("stargantt.history").undo());
    await expect.poll(async () => parentOf(page, "spec")).toBe("root");
  });
});
