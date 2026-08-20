import { expect, test } from "./_fixtures";
import { FIXED_TIME, settle } from "./_fixtures";
import type { Page } from "@playwright/test";

// E2E for examples/interaction.html: interaction/undo-redo/a11y wiring, composed with
// `presetStandard()` and every peripheral feature (docs/specs/plugins/interaction.md §6.4–§6.10)
// turned on. Covers bar drag/undo, selection, keyboard, tooltip, context menu, edit dialog,
// filter/search and zoom against the actual service/DOM surface (`stargantt.view`,
// `stargantt.timeline`, `stargantt.rows`, `stargantt.history`).
//
// Every assertion below is DOM/behavioral (public service state, dispatched commands, rendered
// DOM/ARIA attributes) so the suite is green with no committed screenshot baseline. The one
// screenshot assertion, at the end of the "display" describe block, is deliberately left WITHOUT a
// baseline — Playwright's own "no baseline" failure is expected there; a baseline is generated
// separately after a visual review (CLAUDE.md §7). Nothing here runs `--update-snapshots`.

const DAY_MS = 86_400_000;
const CONTAINER = "#chart";

declare const gantt: {
  dispatch<K extends string>(cmd: K, payload: unknown): void;
  dispose(): void;
  service(key: "stargantt.data"): {
    getTask(id: string): { id: string; name: string; start: number; end: number; progress?: number } | undefined;
    taskIds(): Iterable<string>;
    load(data: unknown): void;
    query(): { children: { get(id: string): string[] | undefined } };
  };
  service(key: "stargantt.history"): {
    state: { get(): { canUndo: boolean; canRedo: boolean; depth: number } };
    undo(): void;
    redo(): void;
  };
  service(key: "stargantt.timeline"): {
    tToX(t: number): number;
    xToT(x: number): number;
    pxPerMs: number;
    zoomLevel: { get(): { id: string; pxPerDay: number } };
  };
  service(key: "stargantt.rows"): {
    rowOf(id: string): number | undefined;
    yOf(row: number): number;
    rowHeight(row: number): number;
    isExpanded(id: string): boolean;
    totalHeight(): number;
  };
  service(key: "stargantt.view"): {
    viewport: { get(): { scrollTop: number; scrollLeft: number; width: number; height: number } };
    scrollTo(target: { scrollLeft?: number; scrollTop?: number }): void;
  };
  service(key: "stargantt.task-bars"): {
    barBoxOf(id: string): { x: number; y: number; width: number; height: number } | undefined;
    visibleBoxes(): { id: string }[];
  };
  service(key: "stargantt.selection"): {
    state: { get(): { taskIds: Set<string> } };
  };
  service(key: "stargantt.focus"): {
    state: { get(): { focused: string | undefined } };
  };
  service(key: "stargantt.filter"): {
    state: { get(): { query: string; active: boolean; matchCount: number } };
  };
};

/** Client-space geometry of one task's bar, plus the chart pane's own bounds. */
interface BarGeometry {
  left: number;
  right: number;
  top: number;
  bottom: number;
  centerX: number;
  centerY: number;
  width: number;
  /** Horizontal CSS px per calendar day at the current zoom. */
  pxPerDay: number;
  paneLeft: number;
  paneRight: number;
}

/**
 * The chart body's own client rect — `.sg-pane--chart canvas.sg-layer`'s box, not the pane
 * container's. `TaskBarsService.barBoxOf`/`RowsService.yOf` etc. report "viewport-local" pixels
 * where y=0 is the top of the first row, i.e. the top of the scrollable body *below* the timeline
 * header; `.sg-pane--chart` itself is the header + body together (its own top sits one
 * `--sg-safe-top` higher than the body), so using the pane's own box as the origin puts every
 * computed y that many pixels too high. The three stacked canvases (background/main/overlay) share
 * one box, so the first is as good as any.
 */
async function chartBodyBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator(".sg-pane--chart canvas.sg-layer").first().boundingBox();
  if (box === null) throw new Error("chart body canvas not found");
  return box;
}

/** Reads a task's bar box (already viewport-local, per `TaskBarsService.barBoxOf`) and the chart
 *  body's own client rect, and combines them into page-absolute coordinates a real pointer gesture
 *  can target. `centerX`/`centerY` are clamped to the slice of the bar actually inside the current
 *  horizontal scroll window (`barBoxOf` reports a task's full box even when part of it is scrolled
 *  out of view — this dataset's later tasks extend past the initial viewport), so a plain click
 *  always lands on real, visible bar pixels; `left`/`right`/`width` stay the bar's true (possibly
 *  off-screen) extent for drag-distance math. Throws if the task has no currently visible bar, no
 *  part of it is inside the current horizontal scroll window, or the body cannot be found. */
async function barGeometry(page: Page, taskId: string): Promise<BarGeometry> {
  const pane = await chartBodyBox(page);
  const box = await page.evaluate((id) => {
    const b = gantt.service("stargantt.task-bars").barBoxOf(id);
    if (b === undefined) return null;
    const pxPerDay = gantt.service("stargantt.timeline").pxPerMs * 86_400_000;
    return { x: b.x, y: b.y, width: b.width, height: b.height, pxPerDay };
  }, taskId);
  if (box === null) throw new Error(`no visible bar for task "${taskId}"`);
  const visibleLeft = Math.max(box.x, 0);
  const visibleRight = Math.min(box.x + box.width, pane.width);
  if (visibleLeft >= visibleRight) {
    throw new Error(`task "${taskId}"'s bar is entirely outside the current horizontal scroll window`);
  }
  return {
    left: pane.x + box.x,
    right: pane.x + box.x + box.width,
    top: pane.y + box.y,
    bottom: pane.y + box.y + box.height,
    centerX: pane.x + (visibleLeft + visibleRight) / 2,
    centerY: pane.y + box.y + box.height / 2,
    width: box.width,
    pxPerDay: box.pxPerDay,
    paneLeft: pane.x,
    paneRight: pane.x + pane.width,
  };
}

/** The page-absolute vertical center of a task's grid row, from the chart body's own top. */
async function rowCenterY(page: Page, taskId: string): Promise<number> {
  const pane = await chartBodyBox(page);
  const vp = await page.evaluate(() => gantt.service("stargantt.view").viewport.get());
  const y = await page.evaluate((id) => {
    const rows = gantt.service("stargantt.rows");
    const row = rows.rowOf(id);
    if (row === undefined) return null;
    return rows.yOf(row) + rows.rowHeight(row) / 2;
  }, taskId);
  if (y === null) throw new Error(`task "${taskId}" has no row`);
  return pane.y + (y - vp.scrollTop);
}

async function taskOf(page: Page, id: string) {
  const task = await page.evaluate((taskId) => gantt.service("stargantt.data").getTask(taskId), id);
  if (task === undefined) throw new Error(`task "${id}" not found`);
  return task;
}

async function historyState(page: Page) {
  return page.evaluate(() => gantt.service("stargantt.history").state.get());
}

async function selectedIds(page: Page): Promise<string[]> {
  return page.evaluate(() => [...gantt.service("stargantt.selection").state.get().taskIds]);
}

async function bootInteraction(page: Page, openExample: import("./_fixtures").OpenExample): Promise<void> {
  await openExample("interaction.html", { ready: `${CONTAINER} canvas`, fixedTime: FIXED_TIME });
  await settle(page);
  // The row model and bar geometry are only correct once the loaded dataset has actually reached
  // the store and painted.
  await expect.poll(async () => taskOf(page, "impl").then((t) => t.name)).toBe("Implementation");
}

test.describe("drag editing (bar move / resize / progress) with undo", () => {
  test("dragging a bar body moves the task, preserving its duration; Ctrl+Z / Ctrl+Shift+Z round-trip it, announced", async ({
    page,
    openExample,
  }) => {
    await bootInteraction(page, openExample);
    const before = await taskOf(page, "impl");
    const duration = before.end - before.start;

    const geo = await barGeometry(page, "impl");
    await page.mouse.move(geo.centerX, geo.centerY);
    await page.mouse.down();
    await page.mouse.move(geo.centerX + geo.pxPerDay * 2, geo.centerY, { steps: 8 });
    await page.mouse.up();
    await settle(page);

    const after = await taskOf(page, "impl");
    expect(after.start).not.toBe(before.start);
    expect(after.end - after.start).toBe(duration);
    expect((await historyState(page)).canUndo).toBe(true);

    // Real chords, not `gantt.service("stargantt.history").undo()`: this is what actually proves
    // undo-redo's default `keys/bindings` contributions (Ctrl+Z / Ctrl+Shift+Z) are wired end to
    // end through the a11y plugin's dispatcher, and that its announcement ("Undone"/"Redone",
    // undo-redo/src/index.ts `DEFAULT_MESSAGES`) reaches the shared aria-live region.
    const live = page.locator(".sg-a11y-live");
    await page.keyboard.press("Control+z");
    await settle(page);
    const reverted = await taskOf(page, "impl");
    expect(reverted.start).toBe(before.start);
    expect(reverted.end).toBe(before.end);
    expect((await historyState(page)).canRedo).toBe(true);
    await expect(live).toHaveText("Undone");

    await page.keyboard.press("Control+Shift+z");
    await settle(page);
    const redone = await taskOf(page, "impl");
    expect(redone.start).toBe(after.start);
    expect(redone.end).toBe(after.end);
    expect((await historyState(page)).canRedo).toBe(false);
    await expect(live).toHaveText("Redone");
  });

  // interaction.md §1.3, "Escape in `dragging-bar`": "→ `idle`. The drag is abandoned; the task
  // keeps whatever the store holds (live dispatches stand as dispatched; the undo entry the
  // gesture opened reverts them) [...]". This composition's `dragEdit.liveUpdate` is off
  // (examples/interaction.html), so nothing was ever dispatched mid-drag — "whatever the store
  // holds" is exactly the pre-drag values, and there is no undo entry to speak of either, since one
  // is only opened by the first live dispatch a `liveUpdate: true` composition would have made.
  test("Escape mid-drag abandons the gesture: with liveUpdate off, the task is untouched and no history entry exists", async ({
    page,
    openExample,
  }) => {
    await bootInteraction(page, openExample);
    const before = await taskOf(page, "impl");
    const depthBefore = (await historyState(page)).depth;

    const geo = await barGeometry(page, "impl");
    await page.mouse.move(geo.centerX, geo.centerY);
    await page.mouse.down();
    await page.mouse.move(geo.centerX + geo.pxPerDay * 2, geo.centerY, { steps: 8 });
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await settle(page);

    const after = await taskOf(page, "impl");
    expect(after.start).toBe(before.start);
    expect(after.end).toBe(before.end);
    expect((await historyState(page)).depth).toBe(depthBefore);
  });

  test("a sub-threshold press-and-release on a bar body is a click, not a drag: no mutation, no history entry", async ({
    page,
    openExample,
  }) => {
    await bootInteraction(page, openExample);
    const before = await taskOf(page, "impl");
    const depthBefore = (await historyState(page)).depth;

    const geo = await barGeometry(page, "impl");
    await page.mouse.move(geo.centerX, geo.centerY);
    await page.mouse.down();
    // 2 CSS px stays under DRAG_THRESHOLD_PX (3, internal/drag/pointer-gesture.ts) — the arbiter
    // never leaves `pressing`, so `barUp` resolves as a plain click.
    await page.mouse.move(geo.centerX + 2, geo.centerY);
    await page.mouse.up();
    await settle(page);

    const after = await taskOf(page, "impl");
    expect(after.start).toBe(before.start);
    expect(after.end).toBe(before.end);
    expect((await historyState(page)).depth).toBe(depthBefore);
    // The press still did something (selected the bar) — proving the click was processed as a
    // click, not merely dropped for an unrelated reason.
    expect(await selectedIds(page)).toEqual(["impl"]);
  });

  test("dragging the end handle resizes the task, leaving its start untouched, as one undo step", async ({
    page,
    openExample,
  }) => {
    await bootInteraction(page, openExample);
    const before = await taskOf(page, "impl");

    const geo = await barGeometry(page, "impl");
    // Grab well inside the 6px end handle (task-bars/src/internal/geometry.ts HANDLE_WIDTH).
    const handleX = geo.right - 2;
    await page.mouse.move(handleX, geo.centerY);
    await page.mouse.down();
    await page.mouse.move(handleX + geo.pxPerDay * 3, geo.centerY, { steps: 8 });
    await page.mouse.up();
    await settle(page);

    const after = await taskOf(page, "impl");
    expect(after.start).toBe(before.start);
    expect(after.end).toBeGreaterThan(before.end);

    expect((await historyState(page)).canUndo).toBe(true);
    await page.evaluate(() => gantt.service("stargantt.history").undo());
    expect((await taskOf(page, "impl")).end).toBe(before.end);
  });

  test("dragging the progress strip sets completion, as one undo step", async ({ page, openExample }) => {
    await bootInteraction(page, openExample);
    const before = await taskOf(page, "impl"); // progress 0.4

    const geo = await barGeometry(page, "impl");
    const currentProgress = before.progress ?? 0;
    const grabX = geo.left + geo.width * currentProgress;
    const targetX = geo.left + geo.width * 0.8;
    // The progress hit band extends ±12 CSS px below the bar's bottom edge (PROGRESS_BAND_HALF).
    await page.mouse.move(grabX, geo.bottom);
    await page.mouse.down();
    await page.mouse.move(targetX, geo.bottom, { steps: 8 });
    await page.mouse.up();
    await settle(page);

    const after = await taskOf(page, "impl");
    expect(after.progress ?? 0).toBeGreaterThan(currentProgress);
    expect(after.start).toBe(before.start);
    expect(after.end).toBe(before.end);

    expect((await historyState(page)).canUndo).toBe(true);
    await page.evaluate(() => gantt.service("stargantt.history").undo());
    expect((await taskOf(page, "impl")).progress).toBe(before.progress);
  });
});

test.describe("performance: bar-drag frame trace", () => {
  // Records `requestAnimationFrame` timestamps for the duration of one real drag gesture and
  // computes an average fps. The spec target (docs/specs — perceived-performance budget) is 60fps;
  // this assertion is deliberately loose (30fps floor) so the suite stays robust on a loaded CI
  // box, while the measured value is always logged (CLAUDE.md §7 — a loose green bound is not
  // proof of hitting the real target, only of not regressing far past it).
  test("stays above a lenient 30fps floor while dragging a bar", async ({ page, openExample }) => {
    await bootInteraction(page, openExample);
    const geo = await barGeometry(page, "impl");

    await page.evaluate(() => {
      const w = window as unknown as { __frameTimes: number[] };
      w.__frameTimes = [];
      const tick = (t: number): void => {
        w.__frameTimes.push(t);
        if (w.__frameTimes.length < 300) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    await page.mouse.move(geo.centerX, geo.centerY);
    await page.mouse.down();
    for (let i = 1; i <= 30; i++) {
      await page.mouse.move(geo.centerX + i * 4, geo.centerY);
    }
    await page.mouse.up();
    await settle(page);

    const frames = await page.evaluate(() => (window as unknown as { __frameTimes: number[] }).__frameTimes);
    expect(frames.length).toBeGreaterThan(1);
    const first = frames[0]!;
    const last = frames[frames.length - 1]!;
    const elapsedMs = last - first;
    const fps = elapsedMs > 0 ? ((frames.length - 1) * 1000) / elapsedMs : 0;
    // eslint-disable-next-line no-console -- deliberate: the measured value is part of this test's deliverable
    console.log(`[perf] bar-drag: ${frames.length} frames over ${elapsedMs.toFixed(1)}ms, ~${fps.toFixed(1)}fps`);
    expect(fps).toBeGreaterThan(30);
  });
});

test.describe("selection: pointer, Ctrl, Shift, rubber band", () => {
  test("a plain click replaces the selection with the pressed row's task", async ({ page, openExample }) => {
    await bootInteraction(page, openExample);
    const row = await page.evaluate(() => gantt.service("stargantt.rows").rowOf("spec"));
    const rowEl = page.locator(`.sg-grid-row[data-row-index="${String(row)}"]`);
    await rowEl.click();
    expect(await selectedIds(page)).toEqual(["spec"]);
    await expect(rowEl).toHaveClass(/sg-grid-row--selected/);
  });

  test("Ctrl-click adds to the selection; a second Ctrl-click removes it", async ({ page, openExample }) => {
    await bootInteraction(page, openExample);
    const rowOf = async (id: string): Promise<number> =>
      page.evaluate((taskId) => gantt.service("stargantt.rows").rowOf(taskId)!, id);

    await page.locator(`.sg-grid-row[data-row-index="${String(await rowOf("spec"))}"]`).click();
    await page
      .locator(`.sg-grid-row[data-row-index="${String(await rowOf("qa"))}"]`)
      .click({ modifiers: ["Control"] });
    expect(new Set(await selectedIds(page))).toEqual(new Set(["spec", "qa"]));

    await page
      .locator(`.sg-grid-row[data-row-index="${String(await rowOf("qa"))}"]`)
      .click({ modifiers: ["Control"] });
    expect(await selectedIds(page)).toEqual(["spec"]);
  });

  test("Shift-click selects the contiguous range between the anchor and the pressed row", async ({
    page,
    openExample,
  }) => {
    await bootInteraction(page, openExample);
    const rowOf = async (id: string): Promise<number> =>
      page.evaluate((taskId) => gantt.service("stargantt.rows").rowOf(taskId)!, id);

    await page.locator(`.sg-grid-row[data-row-index="${String(await rowOf("spec"))}"]`).click();
    await page
      .locator(`.sg-grid-row[data-row-index="${String(await rowOf("qa"))}"]`)
      .click({ modifiers: ["Shift"] });

    const selected = new Set(await selectedIds(page));
    // The range spec..qa spans spec, impl, qa in row order.
    expect(selected.has("spec")).toBe(true);
    expect(selected.has("impl")).toBe(true);
    expect(selected.has("qa")).toBe(true);
  });

  test("a rubber-band drag over the chart body selects every bar it overlaps", async ({ page, openExample }) => {
    await bootInteraction(page, openExample);
    const pane = await chartBodyBox(page);
    const topY = await rowCenterY(page, "root");
    // Strictly below every row (`rows.totalHeight()`), not merely off to one side: the root
    // summary's bar spans the *entire* project width, so any point still inside a row's vertical
    // band is a bar hit regardless of x. Only a point past the last row content-y hit-tests as
    // background (task-bars/src/internal/hit.ts `rowBandAt`), which is what a rubber band must
    // start from.
    const belowRowsContentY = await page.evaluate(() => gantt.service("stargantt.rows").totalHeight() + 20);

    const startX = pane.x + pane.width - 15;
    const startY = pane.y + belowRowsContentY;
    const endX = pane.x + 15;
    const endY = topY - 5;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(endX, startY, { steps: 4 });
    await page.mouse.move(endX, endY, { steps: 8 });
    await page.mouse.up();
    await settle(page);

    const selected = await selectedIds(page);
    expect(selected.length).toBeGreaterThan(1);
  });

  test("Ctrl+A selects the whole store; Delete opens the confirmation, and confirming removes every task as one undo step", async ({
    page,
    openExample,
  }) => {
    await bootInteraction(page, openExample);
    const totalBefore = [...(await page.evaluate(() => [...gantt.service("stargantt.data").taskIds()]))].length;

    // Ctrl+A / Delete are scoped to "focus inside the chart" (interaction.md §6.1); a plain click
    // on a bar both selects it and moves DOM focus into the chart root.
    const geo = await barGeometry(page, "spec");
    await page.mouse.click(geo.centerX, geo.centerY);

    await page.keyboard.press("Control+a");
    // "whole store" (interaction.md §6.1 shortcuts row) — every task, not merely the ones currently
    // painted.
    await expect.poll(async () => (await selectedIds(page)).length).toBe(totalBefore);

    await page.keyboard.press("Delete");
    const confirm = page.locator(".sg-selection-confirm");
    await expect(confirm).toBeVisible();
    await page.locator(".sg-selection-confirm__delete").click();
    await settle(page);

    const remaining = [...(await page.evaluate(() => [...gantt.service("stargantt.data").taskIds()]))];
    expect(remaining).toHaveLength(0);
    expect((await historyState(page)).canUndo).toBe(true);

    await page.evaluate(() => gantt.service("stargantt.history").undo());
    const restored = [...(await page.evaluate(() => [...gantt.service("stargantt.data").taskIds()]))];
    expect(restored).toHaveLength(totalBefore);
  });
});

test.describe("keyboard-only editing, focus navigation and announcements", () => {
  test("ArrowDown moves the roving focus, and Ctrl+ArrowRight edits the focused task's dates, announced", async ({
    page,
    openExample,
  }) => {
    await bootInteraction(page, openExample);
    // The mirror's first row is the root summary (row 0); nothing has been focused yet, so it
    // carries the roving-tabindex fallback (a11y.md § roving focus).
    const rootRow = page.locator(".sg-a11y-row").first();
    await rootRow.focus();
    await expect(rootRow).toHaveAttribute("tabindex", "0");

    await page.keyboard.press("ArrowDown");
    const focusedAfterDown = await page.evaluate(() => gantt.service("stargantt.focus").state.get().focused);
    expect(focusedAfterDown).toBe("spec");

    const before = await taskOf(page, "spec");
    const live = page.locator(".sg-a11y-live");
    await expect(live).toHaveAttribute("aria-live", "polite");

    await page.keyboard.press("Control+ArrowRight");
    await settle(page);
    const moved = await taskOf(page, "spec");
    expect(moved.start).toBeGreaterThan(before.start);
    await expect(live).not.toHaveText("");

    expect((await historyState(page)).canUndo).toBe(true);
    await page.evaluate(() => gantt.service("stargantt.history").undo());
    expect((await taskOf(page, "spec")).start).toBe(before.start);
  });

  test("Ctrl+Shift+ArrowUp raises the focused task's completion, announced", async ({ page, openExample }) => {
    await bootInteraction(page, openExample);
    // Reaches "impl" (row 2) by real ArrowDown presses, not a raw DOM `.focus()` on its row: a
    // script-triggered `.focus()` moves the browser's focus but is not itself a keyboard
    // navigation the mirror recognizes as an *effective placement* (a11y.md — only a moveFocus/
    // focusTask("keyboard"|"pointer"|"api") call sets `FocusState`), so `stargantt.focus`'s
    // `focused` would stay `undefined` and the edit chord below would silently no-op.
    const rootRow = page.locator(".sg-a11y-row").first();
    await rootRow.focus();
    await page.keyboard.press("ArrowDown"); // root -> spec
    await page.keyboard.press("ArrowDown"); // spec -> impl
    await expect
      .poll(async () => page.evaluate(() => gantt.service("stargantt.focus").state.get().focused))
      .toBe("impl");

    const before = (await taskOf(page, "impl")).progress ?? 0;
    const live = page.locator(".sg-a11y-live");

    await page.keyboard.press("Control+Shift+ArrowUp");
    await settle(page);

    const after = (await taskOf(page, "impl")).progress ?? 0;
    expect(after).toBeGreaterThan(before);
    await expect(live).not.toHaveText("");

    await page.evaluate(() => gantt.service("stargantt.history").undo());
    expect((await taskOf(page, "impl")).progress).toBe(before);
  });

  test("ArrowRight/ArrowLeft expand and collapse the focused summary row, announced (zoomKeys shadows +/-)", async ({
    page,
    openExample,
  }) => {
    await bootInteraction(page, openExample);
    const rootRow = page.locator(".sg-a11y-row").first();
    await rootRow.focus();
    const expandedBefore = await page.evaluate(() => gantt.service("stargantt.rows").isExpanded("root"));
    expect(expandedBefore).toBe(true); // starts expanded — collapse it first

    await page.keyboard.press("ArrowLeft");
    await expect
      .poll(async () => page.evaluate(() => gantt.service("stargantt.rows").isExpanded("root")))
      .toBe(false);

    await page.keyboard.press("ArrowRight");
    await expect
      .poll(async () => page.evaluate(() => gantt.service("stargantt.rows").isExpanded("root")))
      .toBe(true);
  });
});

test.describe("tooltip", () => {
  test("a click shows the tooltip (trigger: both) and Escape dismisses it (sticky dismissal)", async ({
    page,
    openExample,
  }) => {
    await bootInteraction(page, openExample);
    const geo = await barGeometry(page, "spec");
    const tooltip = page.locator(".sg-tooltip");
    await expect(tooltip).toBeHidden();

    await page.mouse.click(geo.centerX, geo.centerY);
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText("Design");

    await page.keyboard.press("Escape");
    await expect(tooltip).toBeHidden();
  });
});

test.describe("context menu", () => {
  test("right-click on a bar opens the menu; Insert task adds a child and Delete task removes it, each undoable", async ({
    page,
    openExample,
  }) => {
    await bootInteraction(page, openExample);
    const before = [...(await page.evaluate(() => [...gantt.service("stargantt.data").taskIds()]))];

    const geo = await barGeometry(page, "qa");
    await page.mouse.click(geo.centerX, geo.centerY, { button: "right" });
    const menu = page.locator(".sg-context-menu");
    await expect(menu).toBeVisible();

    await page.getByRole("menuitem", { name: "Insert task" }).click();
    await expect(menu).toBeHidden();
    await settle(page);
    const afterInsert = [...(await page.evaluate(() => [...gantt.service("stargantt.data").taskIds()]))];
    expect(afterInsert.length).toBe(before.length + 1);
    expect((await historyState(page)).canUndo).toBe(true);
    await page.evaluate(() => gantt.service("stargantt.history").undo());

    await page.mouse.click(geo.centerX, geo.centerY, { button: "right" });
    await expect(menu).toBeVisible();
    await page.getByRole("menuitem", { name: "Delete task" }).click();
    await settle(page);
    expect(await taskOf(page, "qa").catch(() => undefined)).toBeUndefined();
    await page.evaluate(() => gantt.service("stargantt.history").undo());
    await expect.poll(() => taskOf(page, "qa").then((t) => t.id).catch(() => undefined)).toBe("qa");
  });

  test("an outside press closes the menu, and the arbiter cleanly returns to normal (a bar click still shows the tooltip)", async ({
    page,
    openExample,
  }) => {
    await bootInteraction(page, openExample);
    const geo = await barGeometry(page, "spec");
    await page.mouse.click(geo.centerX, geo.centerY, { button: "right" });
    const menu = page.locator(".sg-context-menu");
    await expect(menu).toBeVisible();

    // Well outside the chart — the page heading.
    await page.locator("h1").click();
    await expect(menu).toBeHidden();

    // Proves the gesture arbiter actually left its `context` state (interaction.md §1.3), not just
    // that the menu widget happened to remove its own DOM: a stuck `context` state would swallow
    // the very next bar press instead of routing it to the tooltip feature.
    const tooltip = page.locator(".sg-tooltip");
    await page.mouse.click(geo.centerX, geo.centerY);
    await expect(tooltip).toBeVisible();
  });
});

test.describe("edit dialog", () => {
  test("double-click opens the dialog; an invalid range is rejected in place, a valid save commits one undo step", async ({
    page,
    openExample,
  }) => {
    await bootInteraction(page, openExample);
    const before = await taskOf(page, "impl");
    const geo = await barGeometry(page, "impl");

    // Two presses within the 400ms double-activation window (edit-dialog/dblclick.ts); `clickCount`
    // dispatches both at CDP level in rapid succession, well inside the window.
    await page.mouse.click(geo.centerX, geo.centerY, { clickCount: 2 });
    const dialog = page.locator(".sg-edit-dialog");
    await expect(dialog).toBeVisible();

    const startInput = page.locator("#sg-edit-dialog-1-start");
    const endInput = page.locator("#sg-edit-dialog-1-end");
    const startValue = await startInput.inputValue();
    // End before start: rejected, dialog stays open.
    await endInput.fill(startValue);
    await page.locator(".sg-edit-dialog-save").click();
    await expect(dialog).toBeVisible();
    await expect(endInput).toHaveAttribute("aria-invalid", "true");

    // Fix it: a name change plus a valid end date, saved as one commit.
    const nameInput = page.locator("#sg-edit-dialog-1-name");
    await nameInput.fill("Implementation (updated)");
    const validEnd = new Date(before.end + 5 * DAY_MS).toISOString().slice(0, 10);
    await endInput.fill(validEnd);
    await page.locator(".sg-edit-dialog-save").click();
    await expect(dialog).toBeHidden();

    const after = await taskOf(page, "impl");
    expect(after.name).toBe("Implementation (updated)");
    expect(after.end).toBeGreaterThan(before.end);
    expect((await historyState(page)).depth).toBe(1); // one dialog commit == one undo step

    await page.evaluate(() => gantt.service("stargantt.history").undo());
    expect((await taskOf(page, "impl")).name).toBe(before.name);
  });
});

test.describe("side panel", () => {
  test("follows the selection and commits a name edit through the field", async ({ page, openExample }) => {
    await bootInteraction(page, openExample);
    await expect(page.locator(".sg-side-panel-empty")).toBeVisible();

    const row = await page.evaluate(() => gantt.service("stargantt.rows").rowOf("spec"));
    await page.locator(`.sg-grid-row[data-row-index="${String(row)}"]`).click();

    const detail = page.locator(".sg-side-panel-detail");
    await expect(detail).toBeVisible();
    const nameInput = page.locator("#sg-side-panel-1-name");
    await expect(nameInput).toHaveValue("Design");

    await nameInput.fill("Design (renamed)");
    await nameInput.dispatchEvent("change");
    await settle(page);

    expect((await taskOf(page, "spec")).name).toBe("Design (renamed)");
    expect((await historyState(page)).canUndo).toBe(true);
    await page.evaluate(() => gantt.service("stargantt.history").undo());
  });

  // This test covers a rejected field edit being marked with aria-errormessage carrying the
  // page's cause text. The rejection/marking logic
  // (packages/plugins/interaction/src/internal/side-panel/edit.ts's `DECIDERS.progress` +
  // `setInvalid`) is a built-in of the side panel itself, so this types directly into the
  // progress field. Neither this file nor resource.spec.ts previously asserted
  // `aria-errormessage` at all — resource.spec.ts's header lists it as out of scope for that file,
  // which this test now actually covers, here.
  test("a rejected field edit is marked aria-invalid with aria-errormessage carrying the cause text", async ({
    page,
    openExample,
  }) => {
    await bootInteraction(page, openExample);

    const row = await page.evaluate(() => gantt.service("stargantt.rows").rowOf("spec"));
    await page.locator(`.sg-grid-row[data-row-index="${String(row)}"]`).click();
    await expect(page.locator(".sg-side-panel-detail")).toBeVisible();

    const before = await taskOf(page, "spec");
    // Captured BEFORE the rejected edit, so the depth comparison below can actually catch a
    // commit (an after-the-fact capture would compare X to X).
    const historyBefore = await historyState(page);
    const progressInput = page.locator("#sg-side-panel-1-progress");
    // Out of the field's 0..1 range (docs/specs/plugins/interaction.md §6.10's `progress` decider,
    // `packages/plugins/interaction/src/internal/side-panel/edit.ts`'s `DECIDERS.progress`).
    await progressInput.fill("5");
    await progressInput.dispatchEvent("change");
    await settle(page);

    const marking = await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>("#sg-side-panel-1-progress");
      if (input === null) throw new Error("the progress input is missing");
      const errorId = input.getAttribute("aria-errormessage");
      const error = errorId === null ? null : document.getElementById(errorId);
      return {
        invalid: input.getAttribute("aria-invalid"),
        errorId,
        errorText: error?.textContent ?? null,
        errorClass: error?.className ?? null,
      };
    });
    expect(marking.invalid).toBe("true");
    expect(marking.errorId).not.toBeNull();
    expect(marking.errorClass).toContain("sg-side-panel-error");
    // The built-in `panelErrorProgressRange` message (interaction/src/messages.ts).
    expect(marking.errorText).toBe("Progress must be a number between 0 and 1");

    // Nothing was dispatched: the store still holds the old value, and there is no new undo step.
    expect((await taskOf(page, "spec")).progress).toBe(before.progress);
    expect((await historyState(page)).depth).toBe(historyBefore.depth);
  });
});

test.describe("filter / search", () => {
  test("a query narrows visible bars to matches plus their ancestor chain, and clear restores everything", async ({
    page,
    openExample,
  }) => {
    await bootInteraction(page, openExample);
    const totalBefore = await page.evaluate(() => gantt.service("stargantt.task-bars").visibleBoxes().length);

    await page.locator(".sg-filter-search-input").fill("Verification");
    await expect
      .poll(async () => page.evaluate(() => gantt.service("stargantt.filter").state.get().matchCount))
      .toBe(1);
    const stateAfterQuery = await page.evaluate(() => gantt.service("stargantt.filter").state.get());
    expect(stateAfterQuery.active).toBe(true);
    await expect(page.locator(".sg-filter-match-count")).toHaveText("1 matches");

    // `visibleBoxes()` reflects the latest *completed paint*, not the store — settle() waits out
    // the two rAF turns the invalidated row heights need to actually repaint.
    await settle(page);
    const narrowed = await page.evaluate(() => gantt.service("stargantt.task-bars").visibleBoxes().length);
    expect(narrowed).toBeLessThan(totalBefore);

    // `.sg-filter-clear` lives inside the filter *panel* (opened via the "Filter" button); this
    // page only opts into the search box, so clearing here is the natural search-box action —
    // emptying the input, which fires the same live "input" listener every keystroke does.
    await page.locator(".sg-filter-search-input").fill("");
    await expect
      .poll(async () => page.evaluate(() => gantt.service("stargantt.filter").state.get().active))
      .toBe(false);
    await settle(page);
    const restored = await page.evaluate(() => gantt.service("stargantt.task-bars").visibleBoxes().length);
    expect(restored).toBe(totalBefore);
  });
});

test.describe("zoom toolbar", () => {
  test("the +/- buttons step the zoom level and change the day-to-pixel mapping", async ({ page, openExample }) => {
    await bootInteraction(page, openExample);
    const initial = await page.evaluate(() => gantt.service("stargantt.timeline").zoomLevel.get());

    await page.locator(".sg-zoom-controls__in").click();
    await settle(page);
    const zoomedIn = await page.evaluate(() => gantt.service("stargantt.timeline").zoomLevel.get());
    expect(zoomedIn.pxPerDay).toBeGreaterThan(initial.pxPerDay);

    await page.locator(".sg-zoom-controls__out").click();
    await page.locator(".sg-zoom-controls__out").click();
    await settle(page);
    const zoomedOut = await page.evaluate(() => gantt.service("stargantt.timeline").zoomLevel.get());
    expect(zoomedOut.pxPerDay).toBeLessThan(zoomedIn.pxPerDay);
  });

  test("the today button scrolls the chart horizontally", async ({ page, openExample }) => {
    await bootInteraction(page, openExample);
    // The dataset starts exactly "today" (examples/interaction.html's T0), so jumping to today
    // actually lands near scrollLeft 0 — coincidentally the chart's own initial position. Scrolling
    // away first and comparing against *that* (not the pristine initial value, which the today
    // jump would trivially "differ from and then land back on") is what proves the button moved
    // the viewport, not just that the two happen to differ.
    await page.evaluate(() => gantt.service("stargantt.view").scrollTo({ scrollLeft: 5000 }));
    await settle(page);
    const scrolledAway = await page.evaluate(() => gantt.service("stargantt.view").viewport.get().scrollLeft);
    expect(scrolledAway).toBeGreaterThan(0);

    await page.locator(".sg-zoom-controls__today").click();
    await settle(page);
    const after = await page.evaluate(() => gantt.service("stargantt.view").viewport.get().scrollLeft);
    expect(after).not.toBe(scrolledAway);
  });

  test("zooming in preserves the viewport-center time instant, not just the pxPerDay ratio", async ({
    page,
    openExample,
  }) => {
    await bootInteraction(page, openExample);
    const centerTime = async (): Promise<number> =>
      page.evaluate(() => {
        const t = gantt.service("stargantt.timeline");
        const vp = gantt.service("stargantt.view").viewport.get();
        return t.xToT(vp.scrollLeft + vp.width / 2);
      });

    const before = await centerTime();
    await page.locator(".sg-zoom-controls__in").click();
    await settle(page);
    const after = await centerTime();

    // The only slack allowed is sub-pixel rounding at the *new* (finer) zoom level: the anchor is
    // the pixel at the viewport's horizontal center, and one pixel's worth of time there is far
    // smaller than a day.
    const pxPerMsAfter = await page.evaluate(() => gantt.service("stargantt.timeline").pxPerMs);
    const onePixelMs = 1 / pxPerMsAfter;
    expect(Math.abs(after - before)).toBeLessThanOrEqual(onePixelMs * 2);
  });
});

test.describe("clipboard", () => {
  test("Ctrl+D duplicates the selected task as a new sibling, undoable", async ({ page, openExample }) => {
    await bootInteraction(page, openExample);
    const before = [...(await page.evaluate(() => [...gantt.service("stargantt.data").taskIds()]))];

    const geo = await barGeometry(page, "qa");
    await page.mouse.click(geo.centerX, geo.centerY);
    expect(await selectedIds(page)).toEqual(["qa"]);

    await page.keyboard.press("Control+d");
    await settle(page);

    const after = [...(await page.evaluate(() => [...gantt.service("stargantt.data").taskIds()]))];
    expect(after.length).toBe(before.length + 1);
    const newIds = after.filter((id) => !before.includes(id));
    expect(newIds).toHaveLength(1);
    expect((await selectedIds(page))[0]).toBe(newIds[0]);
    expect((await historyState(page)).canUndo).toBe(true);

    await page.evaluate(() => gantt.service("stargantt.history").undo());
    const reverted = [...(await page.evaluate(() => [...gantt.service("stargantt.data").taskIds()]))];
    expect(reverted).toEqual(before);
  });

  test("Ctrl+C/Ctrl+V copy-pastes a selected summary's whole subtree", async ({ page, openExample }) => {
    await bootInteraction(page, openExample);
    // "root" is a summary with four children (spec/impl/qa/ship); copying a summary captures its
    // whole subtree (internal/clipboard/transfer.ts `capture()`'s recursive walk) — the "subtree
    // copy-paste" scenario, as opposed to the single-leaf Ctrl+D duplicate covered above.
    const row = await page.evaluate(() => gantt.service("stargantt.rows").rowOf("root"));
    await page.locator(`.sg-grid-row[data-row-index="${String(row)}"]`).click();
    expect(await selectedIds(page)).toEqual(["root"]);

    const before = [...(await page.evaluate(() => [...gantt.service("stargantt.data").taskIds()]))];

    // Headless Chromium does not fire the native `copy`/`paste` DOM events for a bare Ctrl+C/
    // Ctrl+V keypress without an active text selection and clipboard permissions (verified
    // empirically against this exact page: neither event fires). Dispatching the same
    // `ClipboardEvent`s a real shortcut produces — sharing one `DataTransfer` between them the way
    // the OS clipboard would — drives the *exact* listener path a genuine Ctrl+C/Ctrl+V round-trip
    // does (internal/clipboard/wire.ts's `copy`/`paste` handlers on `ctx.root`), deterministically.
    // This is the pattern Playwright's own docs recommend for clipboard testing without OS access.
    await page.evaluate(() => {
      const root = document.getElementById("chart")!;
      const dt = new DataTransfer();
      root.dispatchEvent(new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true }));
      root.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await settle(page);

    const after = [...(await page.evaluate(() => [...gantt.service("stargantt.data").taskIds()]))];
    expect(after.length).toBe(before.length + 5); // the pasted root + its 4 children

    const newRootId = (await selectedIds(page))[0];
    expect(newRootId).toBeDefined();
    expect(before.includes(newRootId!)).toBe(false);

    const childNames = await page.evaluate((id) => {
      const data = gantt.service("stargantt.data");
      const childIds = data.query().children.get(id) ?? [];
      return childIds.map((childId) => data.getTask(childId)?.name);
    }, newRootId!);
    expect(childNames).toEqual(["Design", "Implementation", "Verification", "Release"]);

    expect((await historyState(page)).canUndo).toBe(true);
    await page.evaluate(() => gantt.service("stargantt.history").undo());
    const reverted = [...(await page.evaluate(() => [...gantt.service("stargantt.data").taskIds()]))];
    expect(reverted).toEqual(before);
  });
});

test.describe("display", () => {
  // Deliberately no committed baseline (see the file header): expect Playwright's own
  // "no baseline"/"Snapshot doesn't exist" failure here, not a pass. Do not generate one with
  // `--update-snapshots` without a visual review first.
  test("initial render of interaction.html matches a baseline (none committed yet)", async ({
    page,
    openExample,
  }) => {
    await bootInteraction(page, openExample);
    await expect(page).toHaveScreenshot("interaction.png", {
      animations: "disabled",
      maxDiffPixelRatio: 0.002,
    });
  });
});
