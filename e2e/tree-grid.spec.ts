import { expect, test } from "./_fixtures";
import { FIXED_TIME, settle } from "./_fixtures";
import type { OpenExample } from "./_fixtures";
import type { Locator, Page } from "@playwright/test";

// Feature E2E: tree-grid (docs/specs/plugins/tree-grid.md) + roving-focus keyboard editing
// (docs/specs/plugins/a11y.md §"Keyboard bindings"). Driven by
// `examples/tree-grid-interaction.html`, which mounts `presetStandard()` and feeds it a
// two-summary/nine-row dataset (ids `p1`/`t1-1..3`/`p2`/`t2-1..3`/`t3`), plus a third-party
// column/row-height contribution and outline-editing controls not exercised here (covered by the
// page's own demo, not by this file).
//
// Service surface (docs/specs/architecture.md ch. 4.1 service catalog): `stargantt.rows`,
// `stargantt.view`, `stargantt.timeline`. `SelectionService`'s `state.get().taskIds` and
// `FocusService`'s `state.get().focused` are store-shaped (architecture.md §3.3). The page assigns
// `window.gantt` directly (no wrapper).
//
// Everything is asserted through the DOM (the grid pane and the parallel ARIA `role="treegrid"`
// mirror) or through public services reachable from `window.gantt`; the canvas is never inspected
// pixel-wise except the background-layer stripe-color probe in the last test (view.md's
// `--sg-row-hover-bg`/`--sg-row-selected-bg`-adjacent shading tokens paint from the
// tree-grid-owned row geometry via `renderer/rowGeometry`, tree-grid.md §"Points").

declare const gantt: {
  dispatch<K extends string>(cmd: K, payload: unknown): void;
  service(key: "stargantt.selection"): { state: { get(): { taskIds: Set<string> } } };
  service(key: "stargantt.focus"): { state: { get(): { focused: string | undefined } } };
  service(key: "stargantt.rows"): {
    rowCount(): number;
    taskIdAt(row: number): string | undefined;
    isExpanded(id: string): boolean;
    rowOf(id: string): number | undefined;
    yOf(row: number): number;
    totalHeight(): number;
  };
  service(key: "stargantt.view"): {
    viewport: { get(): { scrollLeft: number; scrollTop: number; width: number; height: number } };
    scrollTo(target: { scrollLeft?: number; scrollTop?: number }): void;
  };
  service(key: "stargantt.timeline"): { tToX(t: number): number };
  service(key: "stargantt.data"): {
    getTask(id: string): { start: number; end: number } | undefined;
  };
};

const CONTAINER = "#chart";
const GRID = `${CONTAINER} .sg-pane--grid`;
// a11y.md — the parallel ARIA DOM is queried and driven through the DOM rather than through
// visual actionability.
const MIRROR = `${CONTAINER} [role="treegrid"]`;
const MIRROR_ROWS = `${MIRROR} [role="row"]`;

interface MirrorRow {
  rowindex: string | null;
  level: string | null;
  expanded: string | null;
  tabindex: string | null;
  text: string;
}

/** Snapshot of every materialized row of the ARIA mirror, in DOM order. */
async function mirrorRows(page: Page): Promise<MirrorRow[]> {
  return page.$$eval(`${CONTAINER} [role="treegrid"] [role="row"]`, (rows) =>
    rows.map((row) => ({
      rowindex: row.getAttribute("aria-rowindex"),
      level: row.getAttribute("aria-level"),
      expanded: row.getAttribute("aria-expanded"),
      tabindex: row.getAttribute("tabindex"),
      text: row.textContent ?? "",
    })),
  );
}

/** `data-row-index` of every grid-pane row currently painted (hidden pool slots excluded). */
async function visibleGridRowIndexes(page: Page): Promise<number[]> {
  return page.$$eval(`${CONTAINER} .sg-grid-row`, (rows) =>
    rows
      .filter((row) => (row as HTMLElement).style.display !== "none")
      .map((row) => Number((row as HTMLElement).getAttribute("data-row-index")))
      .sort((a, b) => a - b),
  );
}

/** Row count as reported by the public `stargantt.rows` service. */
async function apiRowCount(page: Page): Promise<number> {
  return page.evaluate(() => gantt.service("stargantt.rows").rowCount());
}

/** Focuses an element without requiring it to be visible — the mirror is clipped to 1×1 px. */
async function focusElement(locator: Locator): Promise<void> {
  await locator.evaluate((el) => (el as HTMLElement).focus());
}

/** `aria-rowindex` of the mirror row that currently owns the DOM focus. */
async function focusedRowIndex(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.getAttribute("aria-rowindex") ?? null);
}

async function gotoExample(page: Page, openExample: OpenExample): Promise<void> {
  // `ready: null` because the readiness signal here is the ARIA mirror, not a canvas: it is
  // rendered on boot, and waiting for the full row set makes every subsequent assertion start
  // from the same, fully expanded state.
  await openExample("tree-grid-interaction.html", { ready: null, fixedTime: FIXED_TIME });
  await expect(page.locator(MIRROR)).toHaveAttribute("aria-rowcount", "9");
  await expect(page.locator(MIRROR_ROWS)).toHaveCount(9);
}

test.describe("tree-grid", () => {
  test("ARIA treegrid mirror matches the task tree", async ({ page, openExample }) => {
    await gotoExample(page, openExample);

    const mirror = page.locator(MIRROR);
    // a11y.md — the mirror carries an accessible name and the *true* row count, even though only
    // the windowed rows exist in the DOM.
    await expect(mirror).toHaveAttribute("aria-label", /.+/);
    await expect(mirror).toHaveAttribute("aria-rowcount", "9");

    const rows = await mirrorRows(page);
    // `aria-rowindex` is 1-based and absolute.
    expect(rows.map((r) => r.rowindex)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    // Depth -> `aria-level`: two summaries at level 1 with three level-2 children each, then a
    // standalone level-1 task.
    expect(rows.map((r) => r.level)).toEqual(["1", "2", "2", "2", "1", "2", "2", "2", "1"]);
    // `aria-expanded` is present only on rows that actually have children.
    expect(rows.map((r) => r.expanded)).toEqual(["true", null, null, null, "true", null, null, null, null]);
    // Each row speaks its task name, period and — when the task carries one — progress.
    expect(rows[0]?.text).toContain("Project A");
    expect(rows[1]?.text).toContain("Design");
    // The period is an ISO-shaped date (this page anchors on "today", not a hardcoded date, so
    // only the shape is asserted, not a literal date string).
    expect(rows[1]?.text).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(rows[1]?.text).toContain("100%");

    // Roving tabindex: exactly one row is tabbable, the rest are `-1`.
    expect(rows.filter((r) => r.tabindex === "0")).toHaveLength(1);
    expect(rows.filter((r) => r.tabindex === "-1")).toHaveLength(8);

    // The grid pane paints one row per visible row of the model.
    expect(await visibleGridRowIndexes(page)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("clicking the twisty collapses and expands a summary row", async ({ page, openExample }) => {
    await gotoExample(page, openExample);

    // tree-grid.md — a click on the row's toggle dispatches `view/rowToggle`.
    const firstToggle = page.locator(`${GRID} .sg-grid-row[data-row-index="0"] .sg-grid-toggle`);
    await expect(firstToggle).toBeVisible();
    await expect(firstToggle).toHaveText("▾");

    await firstToggle.click();

    // Collapsing project A hides its three children: 9 -> 6 rows in the model, the grid pane and
    // the ARIA mirror alike.
    await expect(page.locator(MIRROR)).toHaveAttribute("aria-rowcount", "6");
    await expect(page.locator("#rowCount")).toHaveText("6");
    expect(await apiRowCount(page)).toBe(6);
    await expect(firstToggle).toHaveText("▸");
    expect(await visibleGridRowIndexes(page)).toEqual([0, 1, 2, 3, 4, 5]);

    const collapsed = await mirrorRows(page);
    expect(collapsed[0]?.expanded).toBe("false");
    // Project B and its children follow immediately after the collapsed project A.
    expect(collapsed.map((r) => r.level)).toEqual(["1", "1", "2", "2", "2", "1"]);
    expect(collapsed[1]?.text).toContain("Project B");

    // Expanding again restores the full tree.
    await firstToggle.click();
    await expect(page.locator(MIRROR)).toHaveAttribute("aria-rowcount", "9");
    await expect(firstToggle).toHaveText("▾");
    expect((await mirrorRows(page))[0]?.expanded).toBe("true");
  });

  test("+ / - collapse and expand the focused row and are announced", async ({ page, openExample }) => {
    await gotoExample(page, openExample);

    // a11y.md — the default `keys/bindings` contributions bind `+` and `-` to expand/collapse of
    // the row the roving tabindex sits on (unshadowed here: `zoomKeys` defaults off and this page
    // never turns it on). The key listener is on the chart root, so focusing a mirror row is what
    // routes the keystrokes there.
    const firstRow = page.locator(MIRROR_ROWS).first();
    await focusElement(firstRow);
    expect(await focusedRowIndex(page)).toBe("1");

    await page.keyboard.press("-");
    await expect(page.locator(MIRROR)).toHaveAttribute("aria-rowcount", "6");
    expect((await mirrorRows(page))[0]?.expanded).toBe("false");
    expect(await apiRowCount(page)).toBe(6);
    // The result is spoken through the polite live region.
    const live = page.locator(`${CONTAINER} .sg-a11y-live`);
    await expect(live).toHaveAttribute("aria-live", "polite");
    await expect(live).toHaveText(/Project A.*collapsed/);

    await page.keyboard.press("+");
    await expect(page.locator(MIRROR)).toHaveAttribute("aria-rowcount", "9");
    expect((await mirrorRows(page))[0]?.expanded).toBe("true");
    await expect(live).toHaveText(/Project A.*expanded/);

    // Pressing `-` on a leaf changes no row, so nothing new is announced.
    await page.keyboard.press("ArrowDown");
    await expect
      .poll(async () => page.evaluate(() => gantt.service("stargantt.focus").state.get().focused))
      .toBe("t1-1");
    await page.keyboard.press("-");
    await expect(page.locator(MIRROR)).toHaveAttribute("aria-rowcount", "9");
    await expect(live).toHaveText(/Project A.*expanded/);
  });

  test("roving tabindex follows the arrow keys and stays unique", async ({ page, openExample }) => {
    await gotoExample(page, openExample);

    const firstRow = page.locator(MIRROR_ROWS).first();
    await focusElement(firstRow);

    // a11y.md — arrows walk the rows; the tabbable row and the DOM focus move together, and only
    // one row is ever tabbable.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect.poll(async () => focusedRowIndex(page)).toBe("3");

    let rows = await mirrorRows(page);
    expect(rows.filter((r) => r.tabindex === "0").map((r) => r.rowindex)).toEqual(["3"]);
    expect(rows[2]?.text).toContain("Implementation");
    expect(await page.evaluate(() => gantt.service("stargantt.focus").state.get().focused)).toBe("t1-2");
    // Moving the focus selects the row so the chart shows where the focus is.
    expect(await page.evaluate(() => [...gantt.service("stargantt.selection").state.get().taskIds])).toEqual([
      "t1-2",
    ]);

    await page.keyboard.press("ArrowUp");
    await expect.poll(async () => focusedRowIndex(page)).toBe("2");

    // The focus is clamped at the first row instead of wrapping.
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expect.poll(async () => focusedRowIndex(page)).toBe("1");

    // …and at the last row.
    for (let i = 0; i < 10; i += 1) await page.keyboard.press("ArrowDown");
    await expect.poll(async () => focusedRowIndex(page)).toBe("9");
    rows = await mirrorRows(page);
    expect(rows.filter((r) => r.tabindex === "0").map((r) => r.rowindex)).toEqual(["9"]);
    expect(rows[8]?.text).toContain("Routine maintenance");
  });

  test("expand all / collapse all keep the grid and the mirror in step", async ({ page, openExample }) => {
    await gotoExample(page, openExample);

    // The example drives both buttons through `gantt.dispatch("view/rowToggle", …)`.
    await page.locator("#collapseAllBtn").click();
    await expect(page.locator(MIRROR)).toHaveAttribute("aria-rowcount", "3");
    await expect(page.locator("#rowCount")).toHaveText("3");
    expect(await visibleGridRowIndexes(page)).toEqual([0, 1, 2]);

    const collapsed = await mirrorRows(page);
    expect(collapsed.map((r) => r.level)).toEqual(["1", "1", "1"]);
    expect(collapsed.map((r) => r.expanded)).toEqual(["false", "false", null]);
    expect(
      await page.evaluate(() => {
        const rows = gantt.service("stargantt.rows");
        return [rows.isExpanded("p1"), rows.isExpanded("p2")];
      }),
    ).toEqual([false, false]);

    await page.locator("#expandAllBtn").click();
    await expect(page.locator(MIRROR)).toHaveAttribute("aria-rowcount", "9");
    await expect(page.locator("#rowCount")).toHaveText("9");
    expect((await mirrorRows(page)).map((r) => r.expanded)).toEqual([
      "true",
      null,
      null,
      null,
      "true",
      null,
      null,
      null,
      null,
    ]);

    // The single-summary toggle button flips only project A.
    await page.locator("#toggleFirstBtn").click();
    await expect(page.locator(MIRROR)).toHaveAttribute("aria-rowcount", "6");
    expect(
      await page.evaluate(() => {
        const rows = gantt.service("stargantt.rows");
        return [rows.isExpanded("p1"), rows.isExpanded("p2")];
      }),
    ).toEqual([false, true]);
  });
});

// theme.md's `--sg-row-hover-bg`/`--sg-row-selected-bg` background is painted twice: tree-grid
// marks the grid pane's rows, the view plugin's grid-lines paints the chart pane's (from the row
// geometry tree-grid publishes via `renderer/rowGeometry`, tree-grid.md §"Points"). Both derive
// parity from the row's own logical index, so the two must agree at any scroll offset. A drift
// shows up as rows that stripe in one pane and not the other, which a screenshot baseline would
// happily keep green.
test("both panes stripe the same rows, before and after scrolling", async ({ page, openExample }) => {
  await openExample("tree-grid-interaction.html", {
    ready: `${CONTAINER} .sg-pane--chart canvas`,
    fixedTime: FIXED_TIME,
    settle: true,
  });

  /** The stripe state of each visible grid row, as [rowIndex, striped] pairs. */
  const gridStripes = async (): Promise<[number, boolean][]> =>
    page.locator(`${CONTAINER} .sg-grid-row`).evaluateAll((rows) =>
      rows
        .filter((row) => (row as HTMLElement).style.display !== "none")
        .map((row) => [Number(row.getAttribute("data-row-index")), row.classList.contains("sg-grid-row--odd")]),
    );

  /**
   * A viewport-local x (CSS px) landing on a plain working weekday, at least one day after
   * "today". view.md's `gridLines.nonWorkingDays` defaults **on** (weekend shading, a translucent
   * red tint spanning the full row height) and the today marker is its own full-height line at
   * today's x — either would make every row (striped or not) register as painted at that column,
   * so a fixed "1/3 across" probe is not safe here. This scans forward from "today" + 1 day for
   * the first UTC weekday.
   */
  const safeWeekdayX = async (): Promise<number> =>
    page.evaluate(() => {
      const DAY = 86_400_000;
      const timeline = gantt.service("stargantt.timeline");
      const vp = gantt.service("stargantt.view").viewport.get();
      const t0 = gantt.service("stargantt.data").getTask("p1")!.start;
      for (let day = 1; day < 8; day += 1) {
        const t = t0 + day * DAY + 12 * 3_600_000; // midday, clear of either day's boundary
        const dow = new Date(t).getUTCDay();
        if (dow !== 0 && dow !== 6) return timeline.tToX(t) - vp.scrollLeft;
      }
      throw new Error("no weekday found in a 7-day scan");
    });

  /** Whether the chart pane's background canvas is striped at a row's vertical midpoint. */
  const chartStripes = async (): Promise<[number, boolean][]> => {
    const rows = await gridStripes();
    const probeX = await safeWeekdayX();
    return page.evaluate(
      ({ indices, probeX }) => {
        const canvas = document.querySelector<HTMLCanvasElement>(
          "#chart .sg-pane--chart canvas[data-layer='background']",
        );
        const grid = document.querySelector("#chart .sg-pane--grid");
        if (canvas === null || grid === null) return [];
        const ctx = canvas.getContext("2d");
        if (ctx === null) return [];
        const dpr = canvas.width / canvas.getBoundingClientRect().width;
        const chartTop = canvas.getBoundingClientRect().top;
        return indices.map(([index]) => {
          const row = document.querySelector(`#chart .sg-grid-row[data-row-index="${index}"]`);
          const box = row!.getBoundingClientRect();
          const y = Math.round((box.top + box.height / 2 - chartTop) * dpr);
          const x = Math.round(probeX * dpr);
          const [r, g, b, a] = ctx.getImageData(x, y, 1, 1).data;
          // The stripe is the only opaque fill this probe can land on; the plain rows are unpainted.
          return [index, a !== 0 && !(r === 0 && g === 0 && b === 0 && a === 0)] as [number, boolean];
        });
      },
      { indices: rows, probeX },
    );
  };

  const before = await gridStripes();
  expect(before.length).toBeGreaterThan(4);
  expect(await chartStripes()).toEqual(before);
  // Parity is the row index, not the paint order: the first visible row is not always even.
  for (const [index, striped] of before) expect(striped).toBe(index % 2 === 1);

  // The grid pane has no native vertical scroll container of its own (tree-grid.md §"Scroll
  // synchronization"): the shared vertical viewport lives on `stargantt.view`, and the grid
  // follows it, via the view service's `scrollTo`.
  await page.evaluate(() => gantt.service("stargantt.view").scrollTo({ scrollTop: 90 }));
  await settle(page);

  const after = await gridStripes();
  for (const [index, striped] of after) expect(striped).toBe(index % 2 === 1);
  expect(await chartStripes()).toEqual(after);
});

// interaction.md — `SelectionService.revealSelected` (default on) reveals a grid-row press's
// task on screen; this is the one press surface that says nothing about where the bar is, which
// is why it is the surface that reveals. This behavior lives in the interaction plugin's
// selection feature (not tree-grid), but it composes unconditionally here through
// `presetStandard()`, so the observable behavior on this page is straightforward to exercise.
test.describe("revealing the pressed row's bar", () => {
  /** Where task `id`'s bar sits in the chart viewport, in viewport-local pixels. */
  async function barSpan(page: Page, id: string): Promise<{ left: number; right: number }> {
    return page.evaluate((taskId) => {
      const task = gantt.service("stargantt.data").getTask(taskId);
      const timeline = gantt.service("stargantt.timeline");
      const vp = gantt.service("stargantt.view").viewport.get();
      if (task === undefined) throw new Error(`no task ${taskId}`);
      return {
        left: timeline.tToX(task.start) - vp.scrollLeft,
        right: timeline.tToX(task.end) - vp.scrollLeft,
      };
    }, id);
  }

  const viewportWidth = async (page: Page): Promise<number> =>
    page.evaluate(() => gantt.service("stargantt.view").viewport.get().width);

  const scrollLeft = async (page: Page): Promise<number> =>
    page.evaluate(() => gantt.service("stargantt.view").viewport.get().scrollLeft);

  test("a row press pulls a bar scrolled off screen back, then leaves it alone", async ({ page, openExample }) => {
    await gotoExample(page, openExample);
    const id = await page.evaluate(() => gantt.service("stargantt.rows").taskIdAt(2));
    expect(id).toBeDefined();
    if (id === undefined) return;

    // Scroll well past the bar, so it is entirely off the left edge of the chart.
    await page.evaluate((taskId) => {
      const timeline = gantt.service("stargantt.timeline");
      const task = gantt.service("stargantt.data").getTask(taskId);
      if (task === undefined) return;
      gantt.service("stargantt.view").scrollTo({ scrollLeft: timeline.tToX(task.end) + 1200 });
    }, id);
    expect((await barSpan(page, id)).right).toBeLessThan(0);

    await page.locator(`${GRID} .sg-grid-row`).nth(2).click();

    // The bar's start is on screen. A bar too wide to fit between the margins shows its start
    // rather than being centred, so the assertion is about where the bar *begins*.
    const width = await viewportWidth(page);
    const span = await barSpan(page, id);
    expect(span.left).toBeGreaterThanOrEqual(0);
    expect(span.left).toBeLessThan(width);
    expect(span.right).toBeGreaterThan(span.left);

    // Pressing the same row again has nothing left to reveal, so the chart does not move.
    const settled = await scrollLeft(page);
    await page.locator(`${GRID} .sg-grid-row`).nth(2).click();
    expect(await scrollLeft(page)).toBe(settled);
  });
});
