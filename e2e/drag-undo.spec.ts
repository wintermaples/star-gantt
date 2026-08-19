import { expect, test } from "./_fixtures";
import type { OpenExample } from "./_fixtures";
import type { Page } from "@playwright/test";

// E2E for examples/drag-and-undo.html: `stargantt.interaction`'s drag-edit and the page's own
// undo/redo toolbar (`#undoBtn` / `#redoBtn`, wired through `history.state.subscribe` — there is no
// `HistoryService.bindButtons()`, docs/specs/plugins/undo-redo.md "Service" resolution note).
//
// e2e/interaction.spec.ts's "drag editing (bar move / resize / progress) with undo" describe block
// already proves: a bar-body move + Ctrl+Z/Ctrl+Shift+Z round-trip, a sub-threshold press being a
// click not a drag, and Escape mid-drag aborting with no history entry — all on a different
// page/dataset but the identical interaction.md §1.3/§3 mechanics. This file is not a duplicate of
// that: it covers what is NOT covered elsewhere — the toolbar's own Undo/Redo buttons (not the
// keyboard chords) round-tripping a resize, and two sequential undo/redo steps applied one at a
// time through `gantt.dispatch`/`history.undo()`/`.redo()`.
//
// Verification uses the task dates and history state returned by the public API
// (`gantt.service()`), not canvas pixels; bar coordinates come from `stargantt.task-bars`/
// `stargantt.timeline`/`stargantt.view`, so nothing depends on how the rendering looks.

const MS_DAY = 86_400_000;
const PANE = ".sg-pane--chart";

/**
 * A regular task in drag-and-undo.html's sample data (Basic design, 2026-08-16 to 08-31). Used for
 * the bar-body move + left-edge handle (resize-start).
 */
const TASK_ID = 3;

/** Another regular task (Requirements, 2026-08-01 to 08-15). Used for the right-edge handle (resize-end). */
const EARLY_TASK_ID = 2;

/** How far inside the resize handle (which extends inward from the bar edge) to grab. */
const HANDLE_GRAB_INSET = 2;

interface TaskSnapshot {
  id: number;
  name: string;
  start: number;
  end: number;
}

interface BarGeometry {
  left: number;
  right: number;
  centerX: number;
  centerY: number;
  pxPerDay: number;
  paneLeft: number;
  paneRight: number;
}

declare const gantt: {
  service(key: "stargantt.data"): {
    getTask(id: number): { id: number; name: string; start: number; end: number } | undefined;
  };
  service(key: "stargantt.timeline"): {
    tToX(t: number): number;
    zoomLevel: { get(): { pxPerDay: number } };
  };
  service(key: "stargantt.task-bars"): {
    barBoxOf(id: number): { x: number; y: number; width: number; height: number } | undefined;
  };
  service(key: "stargantt.view"): {
    viewport: { get(): { scrollLeft: number; scrollTop: number; width: number; height: number } };
    scrollTo(target: { scrollLeft?: number; scrollTop?: number }): void;
  };
  service(key: "stargantt.history"): {
    state: { get(): { canUndo: boolean; canRedo: boolean } };
    undo(): void;
    redo(): void;
  };
};

async function bootExample(page: Page, openExample: OpenExample): Promise<void> {
  await openExample("drag-and-undo.html", { ready: `#chart canvas` });
  // The row model and bar geometry are only correct once the loaded dataset has actually reached
  // the store and painted.
  await expect.poll(async () => taskOf(page, TASK_ID).then((t) => t.name)).toBe("Basic design");
}

async function taskOf(page: Page, id: number): Promise<TaskSnapshot> {
  return page.evaluate((taskId) => {
    const task = gantt.service("stargantt.data").getTask(taskId);
    if (task === undefined) throw new Error(`task ${String(taskId)} not found`);
    return { id: task.id, name: task.name, start: task.start, end: task.end };
  }, id);
}

async function historyState(page: Page): Promise<{ canUndo: boolean; canRedo: boolean }> {
  // Narrowed to the two fields the tests assert: the store's `state` also carries `depth`, which
  // would otherwise fail every `toEqual({ canUndo, canRedo })` comparison below.
  return page.evaluate(() => {
    const { canUndo, canRedo } = gantt.service("stargantt.history").state.get();
    return { canUndo, canRedo };
  });
}

async function chartBodyBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator(`${PANE} canvas.sg-layer`).first().boundingBox();
  if (box === null) throw new Error("chart body canvas not found");
  return box;
}

/**
 * Scrolls so the task's bar sits centred in the pane. The chart opens at Aug 1 2026 (the page's
 * fixed `view.timeline.origin`), so a task later in the plan can be off to the right of the initial
 * viewport at day zoom — a resize test needs both handles on screen, not merely the body.
 */
async function centerOn(page: Page, id: number): Promise<void> {
  await page.evaluate((taskId) => {
    const data = gantt.service("stargantt.data");
    const timeline = gantt.service("stargantt.timeline");
    const view = gantt.service("stargantt.view");
    const task = data.getTask(taskId);
    if (task === undefined) throw new Error(`task ${String(taskId)} not found`);
    const centre = (timeline.tToX(task.start) + timeline.tToX(task.end)) / 2;
    view.scrollTo({ scrollLeft: Math.max(0, centre - view.viewport.get().width / 2) });
  }, id);
}

async function barGeometry(page: Page, id: number): Promise<BarGeometry> {
  const pane = await chartBodyBox(page);
  // Two equal consecutive reads a frame apart: after a boot/scroll the bar box can still be
  // settling, and press coordinates computed from a moving box miss the bar (the same latent
  // cause timeline-origin-scroll.spec.ts's earliestLeafBar fix addressed).
  const box = await page.evaluate(async (taskId) => {
    const read = () => {
      const b = gantt.service("stargantt.task-bars").barBoxOf(taskId);
      if (b === undefined) return null;
      const pxPerDay = gantt.service("stargantt.timeline").zoomLevel.get().pxPerDay;
      return { x: b.x, y: b.y, width: b.width, height: b.height, pxPerDay };
    };
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    let prev = read();
    for (let i = 0; i < 20; i += 1) {
      await frame();
      const next = read();
      if (prev !== null && next !== null && JSON.stringify(prev) === JSON.stringify(next)) {
        return next;
      }
      prev = next;
    }
    return prev;
  }, id);
  if (box === null) throw new Error(`no visible bar for task "${String(id)}"`);
  return {
    left: pane.x + box.x,
    right: pane.x + box.x + box.width,
    centerX: pane.x + box.x + box.width / 2,
    centerY: pane.y + box.y + box.height / 2,
    pxPerDay: box.pxPerDay,
    paneLeft: pane.x,
    paneRight: pane.x + pane.width,
  };
}

function expectInsidePane(x: number, bar: BarGeometry): void {
  expect(x).toBeGreaterThan(bar.paneLeft);
  expect(x).toBeLessThan(bar.paneRight);
}

/** Drags with the real mouse: a large first move to clear the 3px threshold, then in stages. */
async function dragBy(page: Page, x: number, y: number, dx: number): Promise<void> {
  const direction = dx >= 0 ? 1 : -1;
  await page.mouse.move(x, y);
  await page.mouse.down();
  // Interpolated streams (like timeline-origin-scroll.spec.ts's fix): a two-point jump can be
  // coalesced into a single event that never crosses the drag threshold on a loaded box.
  await page.mouse.move(x + direction * 8, y, { steps: 4 });
  await page.mouse.move(x + dx / 2, y, { steps: 5 });
  await page.mouse.move(x + dx, y, { steps: 5 });
  await page.mouse.up();
}

test.describe("drag-edit + undo/redo (examples/drag-and-undo.html)", () => {
  test("initially the history is empty and the Undo/Redo buttons are disabled", async ({ page, openExample }) => {
    await bootExample(page, openExample);
    // `data.load()` is not a transaction, so it is not pushed onto the history.
    expect(await historyState(page)).toEqual({ canUndo: false, canRedo: false });
    await expect(page.locator("#undoBtn")).toBeDisabled();
    await expect(page.locator("#redoBtn")).toBeDisabled();
  });

  test("dragging the right-edge handle stretches the duration, and the toolbar's Undo/Redo buttons round-trip it", async ({
    page,
    openExample,
  }) => {
    await bootExample(page, openExample);
    const before = await taskOf(page, EARLY_TASK_ID);
    await centerOn(page, EARLY_TASK_ID);
    const bar = await barGeometry(page, EARLY_TASK_ID);

    const grabX = bar.right - HANDLE_GRAB_INSET;
    expectInsidePane(grabX, bar);
    const days = 4;
    await dragBy(page, grabX, bar.centerY, bar.pxPerDay * days);

    await expect.poll(async () => (await taskOf(page, EARLY_TASK_ID)).end).not.toBe(before.end);
    const resized = await taskOf(page, EARLY_TASK_ID);

    expect(resized.start).toBe(before.start);
    expect(resized.end).toBeGreaterThan(before.end);
    expect(Math.abs(resized.end - (before.end + days * MS_DAY))).toBeLessThanOrEqual(MS_DAY / 2 + 1);
    expect(await historyState(page)).toEqual({ canUndo: true, canRedo: false });

    await page.locator("#undoBtn").click();
    await expect.poll(async () => taskOf(page, EARLY_TASK_ID)).toEqual(before);
    await expect(page.locator("#undoBtn")).toBeDisabled();
    await expect(page.locator("#redoBtn")).toBeEnabled();

    await page.locator("#redoBtn").click();
    await expect.poll(async () => taskOf(page, EARLY_TASK_ID)).toEqual(resized);
  });

  test("after a move and a resize, Undo/Redo still round-trips one step at a time", async ({ page, openExample }) => {
    await bootExample(page, openExample);

    const state0 = await taskOf(page, TASK_ID);
    await centerOn(page, TASK_ID);
    const bar0 = await barGeometry(page, TASK_ID);
    expectInsidePane(bar0.centerX, bar0);
    await dragBy(page, bar0.centerX, bar0.centerY, bar0.pxPerDay * 3);
    await expect.poll(async () => (await taskOf(page, TASK_ID)).start).not.toBe(state0.start);
    const state1 = await taskOf(page, TASK_ID);

    // Second step: the left-edge handle (resize-start) — the end date stays put, only the start
    // shrinks.
    await centerOn(page, TASK_ID);
    const bar1 = await barGeometry(page, TASK_ID);
    const grabX = bar1.left + HANDLE_GRAB_INSET;
    expectInsidePane(grabX, bar1);
    await dragBy(page, grabX, bar1.centerY, bar1.pxPerDay * 2);
    await expect.poll(async () => (await taskOf(page, TASK_ID)).start).not.toBe(state1.start);
    const state2 = await taskOf(page, TASK_ID);
    expect(state2.end).toBe(state1.end);
    expect(state2.start).toBeGreaterThan(state1.start);

    // Rewind the two history entries one step at a time.
    await page.evaluate(() => gantt.service("stargantt.history").undo());
    await expect.poll(async () => taskOf(page, TASK_ID)).toEqual(state1);
    await page.evaluate(() => gantt.service("stargantt.history").undo());
    await expect.poll(async () => taskOf(page, TASK_ID)).toEqual(state0);
    expect(await historyState(page)).toEqual({ canUndo: false, canRedo: true });

    // Redo in the same order.
    await page.evaluate(() => gantt.service("stargantt.history").redo());
    await expect.poll(async () => taskOf(page, TASK_ID)).toEqual(state1);
    await page.evaluate(() => gantt.service("stargantt.history").redo());
    await expect.poll(async () => taskOf(page, TASK_ID)).toEqual(state2);
    expect(await historyState(page)).toEqual({ canUndo: true, canRedo: false });
  });
});
