import { expect, test } from "./_fixtures";
import type { OpenExample } from "./_fixtures";
import type { Page } from "@playwright/test";

// Performance-regression E2E for examples/large-data-10k.html. Confirms full virtual scrolling
// holds up at real data volume: only viewport + buffer rows ever enter the DOM, and both the
// initial load and wheel-scroll response stay inside a loose, non-flaky budget.
//
// The API surface used below (confirmed by reading examples/large-data-10k.html's own header
// comment and the tree-grid/view plugin sources, not guessed):
// - `ViewService` (`stargantt.view`)'s viewport is a store: `view.viewport.get()`.
// - `stargantt.rows`'s `rowCount()`/`totalHeight()`/`rowAtY()`
//   (packages/plugins/tree-grid/src/index.ts).
// - `.sg-grid-row[data-row-index]`, `.sg-a11y-row` and `.sg-a11y[aria-rowcount]`
//   (packages/plugins/tree-grid/src/internal/grid-body.ts,
//   packages/plugins/a11y/src/internal/mirror.ts).
//
// The page has a `#load10k-btn` that generates+loads 10,000 tasks and an `#status` readout that
// reads `"Done: ..."` on completion. `examples/scheduling.html?tasks=10000`'s own dedicated perf
// test (see `e2e/scheduling.spec.ts`, "performance: 10k-task reschedule") already covers the
// engine's propagation cost after a predecessor move; this file's subject is different — initial
// load and scroll — so there is no overlap to dedupe.
//
// Per CLAUDE.md §7: a full dedicated performance-regression harness lives in
// `e2e/perf-regression.spec.ts`. The budgets below are deliberately loose so the suite stays
// robust on a loaded CI box; the measured values are always logged for that harness's baseline.

declare const gantt: {
  service(key: "stargantt.data"): { taskIds(): Iterable<string | number> };
  service(key: "stargantt.rows"): {
    rowCount(): number;
    totalHeight(): number;
    rowAtY(y: number): number;
  };
  service(key: "stargantt.view"): {
    viewport: { get(): { scrollTop: number; scrollLeft: number; width: number; height: number } };
  };
};

/** Upper bound for the initial render (ms). Much looser than the 300ms spec target. */
const INITIAL_RENDER_BUDGET_MS = 15_000;
/** Upper bound for generating + load()ing 10,000 tasks (ms). Data generation is up to the page. */
const LOAD_10K_BUDGET_MS = 60_000;
/** Upper bound for the mean response from one wheel step to the next frame (ms). Much looser than the 16.7ms 60fps target. */
const SCROLL_MEAN_BUDGET_MS = 250;
/** Ditto for the worst case (ms). Tolerates GC and layout-recalculation outliers. */
const SCROLL_MAX_BUDGET_MS = 2_000;
/** As long as virtualisation holds, even 10k rows materialise only viewport + buffer DOM rows. */
const MAX_MATERIALIZED_ROWS = 200;

const TASK_COUNT = 10_000;

/**
 * Opens the page, loads 10,000 tasks and returns the measurements.
 * Load completion is detected via the page's own status line (`#status` becomes "Done: …").
 */
async function openAndLoad10k(
  page: Page,
  openExample: OpenExample,
): Promise<{
  initialRenderMs: number;
  loadMs: number;
  statusText: string;
}> {
  const navStart = Date.now();
  // The moment the view plugin has mounted its 3 canvas layers counts as the "initial render" —
  // which is exactly `openExample`'s default ready condition.
  await openExample("large-data-10k.html", { ready: "#chart canvas" });
  const initialRenderMs = Date.now() - navStart;

  const loadStart = Date.now();
  await page.click("#load10k-btn");
  await expect(page.locator("#status")).toContainText("Done:", {
    timeout: LOAD_10K_BUDGET_MS,
  });
  const loadMs = Date.now() - loadStart;

  return {
    initialRenderMs,
    loadMs,
    statusText: (await page.locator("#status").textContent()) ?? "",
  };
}

test.describe("10,000-task performance regression", () => {
  // Covers data generation → load → scroll measurement, so the default 30s may not be enough.
  test.setTimeout(180_000);

  test("initial render and the 10,000-task load stay within budget, and rows are virtualised", async ({
    page,
    openExample,
  }) => {
    const { initialRenderMs, loadMs, statusText } = await openAndLoad10k(page, openExample);

    const state = await page.evaluate(() => {
      const data = gantt.service("stargantt.data");
      const rows = gantt.service("stargantt.rows");
      return {
        taskCount: [...data.taskIds()].length,
        rowCount: rows.rowCount(),
        totalHeight: rows.totalHeight(),
        // tree-grid / a11y only put the visible range into the DOM.
        gridRowEls: document.querySelectorAll(".sg-grid-row").length,
        a11yRowEls: document.querySelectorAll(".sg-a11y-row").length,
        // the true count is conveyed by aria-rowcount.
        ariaRowCount: document.querySelector(".sg-a11y")?.getAttribute("aria-rowcount") ?? null,
      };
    });

    console.log(
      `[perf-10k] initialRender=${initialRenderMs}ms load(incl. generation)=${loadMs}ms ` +
        `rowCount=${state.rowCount} totalHeight=${state.totalHeight}px ` +
        `domRows(grid/a11y)=${state.gridRowEls}/${state.a11yRowEls} status="${statusText}"`,
    );

    expect(state.taskCount).toBe(TASK_COUNT);
    expect(state.rowCount).toBe(TASK_COUNT);
    expect(state.ariaRowCount).toBe(String(TASK_COUNT));

    // Full virtual scrolling: even with 10k rows, only viewport + buffer rows enter the DOM.
    expect(state.gridRowEls).toBeGreaterThan(0);
    expect(state.gridRowEls).toBeLessThan(MAX_MATERIALIZED_ROWS);
    expect(state.a11yRowEls).toBeGreaterThan(0);
    expect(state.a11yRowEls).toBeLessThan(MAX_MATERIALIZED_ROWS);

    expect(initialRenderMs).toBeLessThan(INITIAL_RENDER_BUDGET_MS);
    expect(loadMs).toBeLessThan(LOAD_10K_BUDGET_MS);
  });

  test("wheel scrolling over 10,000 tasks keeps up within a frame", async ({
    page,
    openExample,
  }) => {
    await openAndLoad10k(page, openExample);

    const measurement = await page.evaluate(async (steps: number) => {
      const view = gantt.service("stargantt.view");
      const rows = gantt.service("stargantt.rows");
      // The view plugin handles wheel itself instead of using native scrolling.
      const target = document.querySelector("#chart canvas");
      if (target === null) throw new Error("canvas not found");

      const nextFrame = () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      const samples: number[] = [];
      let advanced = 0;
      for (let i = 0; i < steps; i++) {
        const before = view.viewport.get().scrollTop;
        const t0 = performance.now();
        target.dispatchEvent(
          new WheelEvent("wheel", { deltaY: 400, bubbles: true, cancelable: true }),
        );
        await nextFrame();
        samples.push(performance.now() - t0);
        if (view.viewport.get().scrollTop > before) advanced++;
      }

      const vp = view.viewport.get();
      return {
        samples,
        advanced,
        scrollTop: vp.scrollTop,
        viewportHeight: vp.height,
        totalHeight: rows.totalHeight(),
        rowAtTop: rows.rowAtY(vp.scrollTop),
        gridFirstRowIndex:
          document.querySelector(".sg-grid-row")?.getAttribute("data-row-index") ?? null,
        gridRowEls: document.querySelectorAll(".sg-grid-row").length,
      };
    }, 30);

    const { samples } = measurement;
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const max = Math.max(...samples);
    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;

    console.log(
      `[perf-10k] wheel response n=${samples.length} mean=${mean.toFixed(1)}ms ` +
        `p95=${p95.toFixed(1)}ms max=${max.toFixed(1)}ms | ` +
        `scrollTop=${measurement.scrollTop}/${measurement.totalHeight} ` +
        `topRow=${measurement.rowAtTop} domFirst=${measurement.gridFirstRowIndex} ` +
        `domRows=${measurement.gridRowEls}`,
    );

    // The scroll position must advance on every wheel step (no freezing mid-way).
    expect(measurement.advanced).toBe(samples.length);
    expect(measurement.scrollTop).toBeGreaterThan(0);
    // The scroll limit is clamped to totalHeight - viewport height.
    expect(measurement.scrollTop).toBeLessThanOrEqual(
      measurement.totalHeight - measurement.viewportHeight,
    );

    // The tree-grid's DOM rows must have been swapped to follow the scroll position.
    expect(measurement.gridFirstRowIndex).not.toBeNull();
    expect(Number(measurement.gridFirstRowIndex)).toBeGreaterThan(0);
    expect(Number(measurement.gridFirstRowIndex)).toBeLessThanOrEqual(measurement.rowAtTop);
    expect(measurement.gridRowEls).toBeLessThan(MAX_MATERIALIZED_ROWS);

    expect(mean).toBeLessThan(SCROLL_MEAN_BUDGET_MS);
    expect(max).toBeLessThan(SCROLL_MAX_BUDGET_MS);
  });
});
