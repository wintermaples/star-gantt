// Feature E2E: the DOM focus a press leaves behind, and the text selection it must not leave
// behind. Driven by `examples/multi-select-rubber-band.html` — the page whose selection runs in
// `mode: "multi"`
// with all three opt-in shortcuts enabled (docs/specs/architecture.md distribution chapter:
// specs open the pages under `examples/`, which load the built IIFE bundle; no test-only HTML).
//
// Both rules are browser-resolved and cannot be unit-tested:
//
// 1. The `mousedown` default action moves (or clears) the DOM focus *after* the `pointerdown`
//    handlers have run. Only a real browser dispatches it, so only an E2E can show that a press
//    on a bar still ends with the focus inside the chart root, and therefore that selection's
//    focus-scoped Ctrl/Cmd+A and Delete still fire after the most ordinary gesture there is. The
//    assertions go through the shortcuts themselves rather than through `document.activeElement`
//    alone: the focus is the mechanism, working shortcuts are the promise.
// 2. `user-select` is pure cascade + engine behaviour; whether a Shift-click extends the
//    browser's text selection over the grid rows is only observable from `window.getSelection()`.
//
// interaction.spec.ts already covers plain-click/Ctrl-click/Shift-click/rubber-band selection and
// Ctrl+A/Delete-confirm on a *different* page (examples/interaction.html) using synthetic
// `.click()` calls. None of that duplicates this file: every test here specifically exercises a
// held-across-frames real pointer press (the `humanPress` helper) to prove the DOM-focus
// consequence of `mousedown`, and the text-selection assertions have no equivalent anywhere else
// in the suite.
import { FIXED_TIME, expect, settle, test } from "./_fixtures";
import type { Page } from "@playwright/test";

const PAGE = "multi-select-rubber-band.html";
const ROOT = "#chart";
const CHART = `${ROOT} .sg-pane--chart`;
const ROW = (index: number): string => `${ROOT} .sg-grid-row[data-row-index="${index}"]`;

declare const gantt: {
  service(key: "stargantt.selection"): { state: { get(): { taskIds: Set<string> } } };
  service(key: "stargantt.data"): { taskIds(): Iterable<string> };
  service(key: "stargantt.task-bars"): {
    barBoxOf(id: string): { x: number; y: number; width: number; height: number } | undefined;
  };
};

/** The ids the selection service currently holds. */
async function selected(page: Page): Promise<string[]> {
  return page.evaluate(() => [...gantt.service("stargantt.selection").state.get().taskIds]);
}

/** Every task id in the store — what a working select-all must produce. */
async function allTaskIds(page: Page): Promise<string[]> {
  return page.evaluate(() => [...gantt.service("stargantt.data").taskIds()]);
}

/**
 * The viewport point at the centre of `id`'s bar.
 *
 * The layer canvases start below the timeline header inset, so a viewport-local y is measured
 * from the canvas's top rather than the pane's.
 */
async function barPoint(page: Page, id: string): Promise<{ x: number; y: number }> {
  const point = await page.evaluate((taskId) => {
    const box = gantt.service("stargantt.task-bars").barBoxOf(taskId);
    if (box === undefined) return null;
    const pane = document.querySelector("#chart .sg-pane--chart") as HTMLElement;
    const layer = pane.querySelector("canvas.sg-layer") as HTMLElement;
    return {
      x: pane.getBoundingClientRect().left + box.x + box.width / 2,
      y: layer.getBoundingClientRect().top + box.y + box.height / 2,
    };
  }, id);
  if (point === null) throw new Error(`no bar box for ${id}`);
  return point;
}

/**
 * A press a human could make: the button stays down across two animation frames.
 *
 * A sub-frame synthetic click (what `click()` issues) beats any next-frame consequence of the
 * press, so it can pass while every real press fails. Here the frames matter for a second reason:
 * the `mousedown` default action this test is about runs after `pointerdown`, and holding the
 * press keeps the two apart in the trace when it does not.
 */
async function humanPress(page: Page, point: { x: number; y: number }, modifiers: { shift?: boolean } = {}): Promise<void> {
  if (modifiers.shift === true) await page.keyboard.down("Shift");
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await settle(page);
  await page.mouse.up();
  if (modifiers.shift === true) await page.keyboard.up("Shift");
}

/** The centre of a grid row, in viewport coordinates. */
async function rowPoint(page: Page, index: number): Promise<{ x: number; y: number }> {
  const box = await page.locator(ROW(index)).boundingBox();
  if (box === null) throw new Error(`row ${index} has no layout box`);
  return { x: box.x + Math.min(60, box.width / 2), y: box.y + box.height / 2 };
}

test("a press on a bar leaves the DOM focus inside the chart root", async ({ page, openExample }) => {
  await openExample(PAGE, { ready: `${CHART} canvas`, fixedTime: FIXED_TIME, settle: true });

  const ids = await allTaskIds(page);
  const first = ids[0];
  if (first === undefined) throw new Error("the example composed no tasks");

  await humanPress(page, await barPoint(page, first));
  await settle(page);

  expect(await selected(page)).toEqual([first]);
  // The press selected the bar *and* kept the focus in the chart — a canvas is not a focusable
  // element, so an unguarded `mousedown` default action would clear it to <body> instead.
  expect(
    await page.evaluate(() => {
      const root = document.querySelector("#chart") as HTMLElement;
      const active = document.activeElement;
      return active !== null && root.contains(active);
    }),
  ).toBe(true);
});

test("Ctrl+A selects every task after a press on a bar", async ({ page, openExample }) => {
  await openExample(PAGE, { ready: `${CHART} canvas`, fixedTime: FIXED_TIME, settle: true });

  const ids = await allTaskIds(page);
  const first = ids[0];
  if (first === undefined) throw new Error("the example composed no tasks");

  await humanPress(page, await barPoint(page, first));
  await settle(page);
  await page.keyboard.press("Control+a");
  await settle(page);

  // `shortcuts.selectAll` is focus-scoped, so this is exactly the assertion that goes silently
  // false if the press leaves the focus on <body>.
  expect((await selected(page)).sort()).toEqual([...ids].sort());
});

test("Delete opens the bulk-delete confirmation after a press on a bar", async ({ page, openExample }) => {
  await openExample(PAGE, { ready: `${CHART} canvas`, fixedTime: FIXED_TIME, settle: true });

  const ids = await allTaskIds(page);
  const first = ids[0];
  if (first === undefined) throw new Error("the example composed no tasks");

  await humanPress(page, await barPoint(page, first));
  await settle(page);
  await page.keyboard.press("Delete");

  const dialog = page.locator(".sg-selection-confirm[role='alertdialog']");
  await expect(dialog).toBeVisible();

  // Confirming really deletes: the shortcut is wired to the same flow the service's
  // `deleteSelected()` runs, and one transaction removes the selected task.
  await page.locator(".sg-selection-confirm__delete").click();
  await settle(page);
  expect(await allTaskIds(page)).not.toContain(first);
  expect(await selected(page)).not.toContain(first);
});

test("a Shift-click range extension selects rows, not their text", async ({ page, openExample }) => {
  await openExample(PAGE, { ready: ROW(0), fixedTime: FIXED_TIME, settle: true });

  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await humanPress(page, await rowPoint(page, 0));
  await settle(page);
  await humanPress(page, await rowPoint(page, 2), { shift: true });
  await settle(page);

  // The row range is selected...
  expect(await selected(page)).toHaveLength(3);
  // ...and the browser's own text selection stayed empty. An unguarded `user-select` would let a
  // Shift-click extend it across every row it passed, painting their text in the highlight colour
  // on top of the row-selection fill.
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");
});

test("an inline editor still allows selecting the text being edited", async ({ page, openExample }) => {
  await openExample(PAGE, { ready: ROW(0), fixedTime: FIXED_TIME, settle: true });

  await page.locator(`${ROW(0)} .sg-grid-cell`).first().dblclick();
  const editor = page.locator(`${ROW(0)} .sg-grid-editor`);
  await expect(editor).toBeVisible();

  // The pane's `user-select: none` must not reach into the editor host: selecting the text you
  // are editing (to replace it, or to copy it out) is the whole point of an editor.
  expect(await editor.evaluate((el) => getComputedStyle(el).userSelect)).not.toBe("none");
  await page.keyboard.press("Escape");
});
