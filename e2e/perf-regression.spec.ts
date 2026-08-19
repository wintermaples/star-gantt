import { expect, test } from "./_fixtures";
import type { OpenExample } from "./_fixtures";
import type { Page } from "@playwright/test";

// Performance-regression harness. This is the dedicated measurement suite deferred out of
// `e2e/perf-10k.spec.ts`; it COMPLEMENTS `e2e/perf-10k.spec.ts`,
// `e2e/readonly.spec.ts` ("performance") and `e2e/scheduling.spec.ts`
// ("performance: 10k-task reschedule") rather than repeating them. What each file owns:
//
// | Metric                              | Owned by                                                |
// |-------------------------------------|---------------------------------------------------------|
// | 10k load + wheel-step response      | perf-10k.spec.ts                                          |
// | 10k initial paint                   | readonly.spec.ts "performance" (basic.html?tasks=10000)    |
// | 10k reschedule, cold, engine only   | scheduling.spec.ts "performance: 10k-task reschedule"     |
// | 10k SUSTAINED scroll frame rate     | this file, test 1                                         |
// | 100k operability (load, scroll,     | this file, test 2                                         |
// |  sustained frame rate, jump to end) |                                                           |
// | 100k initial paint                  | this file, test 3                                         |
// | 10k reschedule, warm, INCLUDING paint| this file, test 4                                        |
//
// Reference baseline, for the regression comparison these numbers exist to make possible: a prior
// internal benchmark of the predecessor codebase, measured on the same class of machine at
// Chromium 1600x1000:
//   boot -> first chart canvas painted          ~290ms
//   click -> 10,000-row chart on screen         ~150ms   (generate + load ~40ms)
//   click -> 100,000-row chart on screen        ~260ms   (generate + load ~150ms)
//   5s of wheel scrolling at 10k    longest frame 19.4ms, frames over 33ms: 0
//   5s of wheel scrolling at 100k   longest frame 17.5ms, frames over 33ms: 0
// Those were measured through a full-featured product app composing dozens of plugins, not
// through a bare example page, so they are an order-of-magnitude reference rather than a
// like-for-like control. No reschedule/propagation figure was ever recorded in that benchmark.
// The `longestFrame` / `framesOver33ms` fields this file logs exist so the two scroll rows above
// stay directly comparable.
//
// Threshold policy (CLAUDE.md §7): asserting the spec targets
// themselves — 60fps sustained, 300ms initial paint — would go flaky the moment CI shares a box
// with anything else. Every bound below is deliberately an order of magnitude looser than the
// target it guards, so a green run only proves "did not regress catastrophically"; the measured
// values are always console.logged, and it is those logged numbers, not the assertions, that are
// the deliverable of this task. The same margin discipline is used here: a 16.7ms 60fps target is
// asserted at a 250ms mean / 2000ms max.
//
// Every measurement is instrumented from inside the page with the library's OWN public surface —
// `perf-tools`' rAF-interval trace recorder (`stargantt.perf-tools`) for frame rate,
// `ViewService.firstPaintMs()` for initial paint — never Playwright-side wall clock, which would
// also be measuring CDP round-trips.

/**
 * Union of every page global this file touches. `examples/large-data-10k.html` and
 * `examples/scheduling.html` each publish `window.gantt`; the services below are only ever asked
 * for on a page that actually composes the plugin providing them (perf-tools is an opt-in dev
 * plugin, present on large-data-10k.html only).
 */
declare const gantt: {
  dispatch(command: string, payload: unknown): void;
  service(key: "stargantt.data"): {
    taskIds(): Iterable<string | number>;
    getTask(id: string): { id: string; start: number; end: number } | undefined;
  };
  service(key: "stargantt.rows"): {
    rowCount(): number;
    totalHeight(): number;
    rowAtY(y: number): number;
  };
  service(key: "stargantt.view"): {
    viewport: { get(): { scrollTop: number; scrollLeft: number; width: number; height: number } };
    firstPaintMs(): number | undefined;
  };
  service(key: "stargantt.perf-tools"): {
    startRecording(): void;
    stopRecording():
      | {
          frames: { t: number; dur: number }[];
          stats: { fps: number; avgMs: number; maxMs: number; frames: number; overBudget: number };
        }
      | undefined;
  };
};

/* --- budgets ------------------------------------------------------------------------------- */

/**
 * Upper bound for the MEDIAN frame interval during sustained scrolling (ms). The target is 16.7ms
 * (60fps); this bound only fails when the frame rate collapses below ~10fps.
 */
const SUSTAINED_FRAME_MEDIAN_BUDGET_MS = 100;
/** Ditto for p95, which must tolerate GC pauses and the progressive-detail refinement frame. */
const SUSTAINED_FRAME_P95_BUDGET_MS = 250;
/** Minimum number of rAF samples a scroll run must produce before its statistics mean anything. */
const MIN_FRAME_SAMPLES = 40;
/** Frames of continuous scrolling per sustained run — ~5s at a nominal 60fps. */
const SUSTAINED_SCROLL_FRAMES = 300;

/**
 * Share of a sustained-scroll run's frames that may exceed {@link JANK_FRAME_MS}. Deliberately
 * not asserted against a 33ms (30fps) line: a CI box under contention can legitimately
 * sit at 30fps, which would put every frame over that line. 100ms frames are stalls, not slowness.
 */
const MAX_JANK_FRAME_SHARE = 0.2;
/** What counts as a stalled frame for {@link MAX_JANK_FRAME_SHARE} (ms). */
const JANK_FRAME_MS = 100;

/**
 * Upper bound for generating + `load()`ing 100,000 tasks (ms). Generation is up to the page. A
 * prior internal benchmark used 30s for the same measurement; this doubles it and still leaves the
 * 180s test timeout room for the scroll runs that follow in the same test.
 */
const LOAD_100K_BUDGET_MS = 60_000;
/** Upper bound for the mean wheel-step response at 100k tasks (ms). The 10k bound (perf-10k.spec.ts) is 250ms. */
const SCROLL_100K_MEAN_BUDGET_MS = 400;
/** Ditto for the worst case (ms). */
const SCROLL_100K_MAX_BUDGET_MS = 4_000;
/** Upper bound for the single frame that jumps the viewport to the very bottom of 100k rows. */
const JUMP_TO_END_BUDGET_MS = 4_000;

/** Upper bound for `firstPaintMs()` at 100,000 tasks. The spec target is 300ms at any size. */
const FIRST_PAINT_100K_BUDGET_MS = 10_000;

/** Upper bound for the MEDIAN warm reschedule, dispatch through composited repaint (ms). */
const RESCHEDULE_MEDIAN_BUDGET_MS = 3_000;

/**
 * Virtualization invariant: no matter how many rows the model holds, only viewport + buffer rows
 * may ever be in the DOM. Same constant asserted at 10k (perf-10k.spec.ts); asserting it at 100k
 * is the actual content of "100,000 tasks stay operable".
 */
const MAX_MATERIALIZED_ROWS = 200;

/* --- helpers ------------------------------------------------------------------------------- */

/** Median of a non-empty sample list (mean of the two middle values for an even count). */
function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** The value at the given quantile (0..1) of a non-empty sample list, nearest-rank. */
function quantile(samples: readonly number[], q: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
}

/**
 * Opens `examples/large-data-10k.html` and clicks one of its own data buttons, waiting for the
 * page's `#status` readout to reach `"Done: …"`. The page prints its own generate/load split into
 * that line, which is logged verbatim by each caller.
 */
async function openAndLoad(
  page: Page,
  openExample: OpenExample,
  button: "#load10k-btn" | "#load100k-btn",
  budgetMs: number,
): Promise<{ loadMs: number; statusText: string }> {
  await openExample("large-data-10k.html", { ready: "#chart canvas" });
  const started = Date.now();
  await page.click(button);
  await expect(page.locator("#status")).toContainText("Done:", { timeout: budgetMs });
  return {
    loadMs: Date.now() - started,
    statusText: (await page.locator("#status").textContent()) ?? "",
  };
}

/**
 * Scrolls continuously for `frames` animation frames with perf-tools recording, and returns every
 * frame INTERVAL the recorder sampled.
 *
 * This is the honest frame-rate instrument: `perf-tools` owns its own rAF loop and records the
 * wall-clock gap between consecutive animation frames, so a frame the browser skipped entirely
 * shows up as one long interval. Timing individual `dispatchEvent` calls (what
 * `measureWheelSteps` below does) cannot see that.
 *
 * Only usable on a page that composes `StarGantt.perfTools()` — `examples/large-data-10k.html`
 * does; the standard preset does not include the dev plugin.
 */
async function measureSustainedScroll(
  page: Page,
  frames: number,
): Promise<{
  durations: number[];
  traceStats: { fps: number; avgMs: number; maxMs: number; frames: number } | null;
  stalled: number;
  scrolledPx: number;
  totalHeight: number;
  gridRowEls: number;
}> {
  return page.evaluate(async (frameCount: number) => {
    const perf = gantt.service("stargantt.perf-tools");
    const view = gantt.service("stargantt.view");
    const rows = gantt.service("stargantt.rows");
    const target = document.querySelector("#chart canvas");
    if (target === null) throw new Error("canvas not found");
    const nextFrame = (): Promise<void> =>
      new Promise((resolve) => requestAnimationFrame(() => resolve()));

    // Defensive only on this page: the overlay defaults on, so the meter's rAF loop is already
    // running continuously and every recorded interval is a genuine consecutive-callback delta.
    // The frame waits future-proof the measurement against a page composing overlay: false,
    // where startRecording() restarts the loop and the first callback yields no sample
    // (perf-tools.md §1.1).
    await nextFrame();
    perf.startRecording();
    await nextFrame();

    const startTop = view.viewport.get().scrollTop;
    let stalled = 0;
    for (let i = 0; i < frameCount; i++) {
      const before = view.viewport.get().scrollTop;
      target.dispatchEvent(new WheelEvent("wheel", { deltaY: 240, bubbles: true, cancelable: true }));
      await nextFrame();
      if (view.viewport.get().scrollTop <= before) stalled++;
    }
    const trace = perf.stopRecording();

    const vp = view.viewport.get();
    return {
      durations: (trace?.frames ?? []).map((f) => f.dur),
      traceStats: trace?.stats ?? null,
      stalled,
      scrolledPx: vp.scrollTop - startTop,
      totalHeight: rows.totalHeight(),
      gridRowEls: document.querySelectorAll(".sg-grid-row").length,
    };
  }, frames);
}

/** The share of a run's frames longer than {@link JANK_FRAME_MS}, i.e. outright stalls. */
function jankShare(durations: readonly number[]): number {
  return durations.filter((d) => d > JANK_FRAME_MS).length / durations.length;
}

/** Formats one sustained-scroll run for the log, matching the field names/units used in the reference baseline above. */
function describeScrollRun(
  label: string,
  run: { durations: number[]; traceStats: { fps: number; avgMs: number } | null; stalled: number; scrolledPx: number; totalHeight: number; gridRowEls: number },
): string {
  const med = median(run.durations);
  return (
    `${label}: frames=${run.durations.length} median=${med.toFixed(1)}ms ` +
    `(${(1000 / med).toFixed(1)}fps) p95=${quantile(run.durations, 0.95).toFixed(1)}ms ` +
    `longestFrame=${Math.max(...run.durations).toFixed(1)}ms ` +
    `framesOver33ms=${run.durations.filter((d) => d > 33).length} ` +
    `traceAvg=${run.traceStats?.avgMs.toFixed(1) ?? "n/a"}ms ` +
    `traceFps=${run.traceStats?.fps.toFixed(1) ?? "n/a"} ` +
    `scrolled=${run.scrolledPx}/${run.totalHeight}px stalledSteps=${run.stalled} ` +
    `domRows=${run.gridRowEls}`
  );
}

/**
 * Dispatches `steps` wheel events at the chart canvas, one per animation frame, and returns the
 * per-step response times (wheel dispatch → next composited frame) plus the resulting scroll
 * state. The same shape is reused here at 100k.
 */
async function measureWheelSteps(
  page: Page,
  steps: number,
  deltaY: number,
): Promise<{
  samples: number[];
  advanced: number;
  scrollTop: number;
  viewportHeight: number;
  totalHeight: number;
  rowAtTop: number;
  gridFirstRowIndex: string | null;
  gridRowEls: number;
  a11yRowEls: number;
}> {
  return page.evaluate(
    async ({ steps: n, deltaY: dy }) => {
      const view = gantt.service("stargantt.view");
      const rows = gantt.service("stargantt.rows");
      const target = document.querySelector("#chart canvas");
      if (target === null) throw new Error("canvas not found");
      const nextFrame = (): Promise<void> =>
        new Promise((resolve) => requestAnimationFrame(() => resolve()));

      const samples: number[] = [];
      let advanced = 0;
      for (let i = 0; i < n; i++) {
        const before = view.viewport.get().scrollTop;
        const t0 = performance.now();
        target.dispatchEvent(new WheelEvent("wheel", { deltaY: dy, bubbles: true, cancelable: true }));
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
        a11yRowEls: document.querySelectorAll(".sg-a11y-row").length,
      };
    },
    { steps, deltaY },
  );
}

/* --- the suite ----------------------------------------------------------------------------- */

test.describe("performance regression", () => {
  // Data generation at 100k plus multi-second measurement runs; the default 30s is far too short.
  // Same 180s ceiling perf-10k.spec.ts uses, kept for continuity.
  test.setTimeout(180_000);

  test("sustained wheel scrolling over 10,000 tasks holds a 60fps-class frame rate", async ({
    page,
    openExample,
  }) => {
    const { statusText } = await openAndLoad(page, openExample, "#load10k-btn", 60_000);

    // ~5 seconds of continuous scrolling at a nominal 60fps, matching the duration the reference
    // baseline's "longest frame / frames over 33ms" figures were recorded over.
    const run = await measureSustainedScroll(page, SUSTAINED_SCROLL_FRAMES);

    expect(run.durations.length).toBeGreaterThanOrEqual(MIN_FRAME_SAMPLES);
    const med = median(run.durations);
    const p95 = quantile(run.durations, 0.95);

    console.log(
      `[perf-regression] ${describeScrollRun("10k sustained scroll", run)} status="${statusText}"`,
    );

    // Non-vacuity: the run must actually have scrolled, otherwise a frozen viewport would post a
    // perfect frame rate.
    expect(run.scrolledPx).toBeGreaterThan(0);
    expect(run.stalled).toBe(0);
    // Virtualization must survive the whole run.
    expect(run.gridRowEls).toBeGreaterThan(0);
    expect(run.gridRowEls).toBeLessThan(MAX_MATERIALIZED_ROWS);

    expect(med).toBeLessThan(SUSTAINED_FRAME_MEDIAN_BUDGET_MS);
    expect(p95).toBeLessThan(SUSTAINED_FRAME_P95_BUDGET_MS);
    expect(jankShare(run.durations)).toBeLessThan(MAX_JANK_FRAME_SHARE);
  });

  test("100,000 tasks load, stay virtualised and stay scrollable", async ({
    page,
    openExample,
  }) => {
    const { loadMs, statusText } = await openAndLoad(
      page,
      openExample,
      "#load100k-btn",
      LOAD_100K_BUDGET_MS,
    );

    const state = await page.evaluate(() => {
      const data = gantt.service("stargantt.data");
      const rows = gantt.service("stargantt.rows");
      return {
        taskCount: [...data.taskIds()].length,
        rowCount: rows.rowCount(),
        totalHeight: rows.totalHeight(),
        gridRowEls: document.querySelectorAll(".sg-grid-row").length,
        a11yRowEls: document.querySelectorAll(".sg-a11y-row").length,
        ariaRowCount: document.querySelector(".sg-a11y")?.getAttribute("aria-rowcount") ?? null,
      };
    });

    const scroll = await measureWheelSteps(page, 30, 400);
    const mean = scroll.samples.reduce((a, b) => a + b, 0) / scroll.samples.length;
    const p95 = quantile(scroll.samples, 0.95);
    const worst = Math.max(...scroll.samples);

    // The same ~5s sustained-scroll frame-rate run test 1 does at 10k, repeated at 100k: the
    // reference baseline recorded both sizes, so both are needed for a like-for-like comparison.
    const sustained = await measureSustainedScroll(page, SUSTAINED_SCROLL_FRAMES);
    const sustainedMedian = median(sustained.durations);

    // The extreme operability case: one wheel event large enough to clamp the viewport to the
    // very bottom of 100,000 rows, i.e. the worst possible row-range swap in a single frame.
    const jump = await page.evaluate(async () => {
      const view = gantt.service("stargantt.view");
      const rows = gantt.service("stargantt.rows");
      const target = document.querySelector("#chart canvas");
      if (target === null) throw new Error("canvas not found");
      const nextFrame = (): Promise<void> =>
        new Promise((resolve) => requestAnimationFrame(() => resolve()));

      const t0 = performance.now();
      target.dispatchEvent(
        new WheelEvent("wheel", { deltaY: 1e9, bubbles: true, cancelable: true }),
      );
      await nextFrame();
      const elapsedMs = performance.now() - t0;

      const vp = view.viewport.get();
      return {
        elapsedMs,
        scrollTop: vp.scrollTop,
        maxScrollTop: rows.totalHeight() - vp.height,
        rowAtTop: rows.rowAtY(vp.scrollTop),
        gridFirstRowIndex:
          document.querySelector(".sg-grid-row")?.getAttribute("data-row-index") ?? null,
        gridRowEls: document.querySelectorAll(".sg-grid-row").length,
        a11yRowEls: document.querySelectorAll(".sg-a11y-row").length,
      };
    });

    console.log(
      `[perf-regression] 100k: load(incl. generation)=${loadMs}ms rowCount=${state.rowCount} ` +
        `totalHeight=${state.totalHeight}px domRows(grid/a11y)=${state.gridRowEls}/${state.a11yRowEls} | ` +
        `wheel n=${scroll.samples.length} mean=${mean.toFixed(1)}ms p95=${p95.toFixed(1)}ms ` +
        `max=${worst.toFixed(1)}ms | jumpToEnd=${jump.elapsedMs.toFixed(1)}ms ` +
        `topRow=${jump.rowAtTop} domRows=${jump.gridRowEls} status="${statusText}"`,
    );
    console.log(`[perf-regression] ${describeScrollRun("100k sustained scroll", sustained)}`);

    expect(state.taskCount).toBe(100_000);
    expect(state.rowCount).toBe(100_000);
    expect(state.ariaRowCount).toBe("100000");

    // Virtualization at 100k: this, not the wall clock, is what makes the size operable at all.
    expect(state.gridRowEls).toBeGreaterThan(0);
    expect(state.gridRowEls).toBeLessThan(MAX_MATERIALIZED_ROWS);
    expect(state.a11yRowEls).toBeGreaterThan(0);
    expect(state.a11yRowEls).toBeLessThan(MAX_MATERIALIZED_ROWS);

    // Scrolling must respond on every step and keep the DOM rows following the viewport.
    expect(scroll.advanced).toBe(scroll.samples.length);
    expect(scroll.gridRowEls).toBeLessThan(MAX_MATERIALIZED_ROWS);
    expect(Number(scroll.gridFirstRowIndex)).toBeGreaterThan(0);
    expect(Number(scroll.gridFirstRowIndex)).toBeLessThanOrEqual(scroll.rowAtTop);

    // The single-frame jump lands exactly on the clamped maximum and re-virtualises there.
    expect(jump.scrollTop).toBeCloseTo(jump.maxScrollTop, 0);
    expect(jump.rowAtTop).toBeGreaterThan(99_000);
    expect(jump.gridRowEls).toBeGreaterThan(0);
    expect(jump.gridRowEls).toBeLessThan(MAX_MATERIALIZED_ROWS);
    expect(jump.a11yRowEls).toBeLessThan(MAX_MATERIALIZED_ROWS);

    // Sustained frame rate at 100k, same instrument and same bounds as the 10k run in test 1.
    expect(sustained.durations.length).toBeGreaterThanOrEqual(MIN_FRAME_SAMPLES);
    expect(sustained.stalled).toBe(0);
    expect(sustained.scrolledPx).toBeGreaterThan(0);
    expect(sustainedMedian).toBeLessThan(SUSTAINED_FRAME_MEDIAN_BUDGET_MS);
    expect(quantile(sustained.durations, 0.95)).toBeLessThan(SUSTAINED_FRAME_P95_BUDGET_MS);
    expect(jankShare(sustained.durations)).toBeLessThan(MAX_JANK_FRAME_SHARE);

    expect(loadMs).toBeLessThan(LOAD_100K_BUDGET_MS);
    expect(mean).toBeLessThan(SCROLL_100K_MEAN_BUDGET_MS);
    expect(worst).toBeLessThan(SCROLL_100K_MAX_BUDGET_MS);
    expect(jump.elapsedMs).toBeLessThan(JUMP_TO_END_BUDGET_MS);
  });

  test("initial paint of a 100,000-task dataset stays within a lenient budget", async ({
    page,
    openExample,
  }) => {
    // `examples/basic.html?tasks=N` is the deterministic initial-paint harness: it builds
    // the dataset, calls `create()` + `load()` and publishes `ViewService.firstPaintMs()` — time
    // from the render surface's construction to the first completed canvas composite — on
    // `#perf-readout`. readonly.spec.ts measures the same page at 10,000; this is the 100,000 arm.
    await openExample("/examples/basic.html?tasks=100000", { ready: "#chart canvas" });
    await expect
      .poll(async () => page.locator("#perf-readout").getAttribute("data-first-paint-ms"), {
        timeout: 120_000,
      })
      .not.toBeNull();

    const [taskCount, firstPaintMs, wallMs] = await page.evaluate(() => {
      const el = document.getElementById("perf-readout")!;
      return [Number(el.dataset.taskCount), Number(el.dataset.firstPaintMs), Number(el.dataset.wallMs)];
    });

    const rowCount = await page.evaluate(() => gantt.service("stargantt.rows").rowCount());

    console.log(
      `[perf-regression] 100k initial paint: tasks=${taskCount} rows=${rowCount} ` +
        `firstPaint=${firstPaintMs.toFixed(1)}ms wallSinceCreate=${wallMs.toFixed(1)}ms`,
    );

    expect(taskCount).toBeGreaterThanOrEqual(100_000);
    expect(rowCount).toBeGreaterThanOrEqual(100_000);
    expect(firstPaintMs).toBeGreaterThan(0);
    expect(firstPaintMs).toBeLessThan(FIRST_PAINT_100K_BUDGET_MS);
  });

  test("repeated rescheduling of a 10,000-task chain stays within a lenient budget, paint included", async ({
    page,
    openExample,
  }) => {
    // Complements scheduling.spec.ts's cold, engine-only measurement: this one warms the engine
    // first and then times five consecutive moves END TO END — `dispatch()` returning AND the
    // resulting repaint composited — which is the latency a user actually feels when dragging a
    // predecessor around at this size.
    await openExample("scheduling.html?tasks=10000", { ready: "#chart canvas" });
    await expect
      .poll(async () => page.evaluate(() => gantt.service("stargantt.data").getTask("c9999")?.start))
      .toBeGreaterThan(0);

    const run = await page.evaluate(async (moves: number) => {
      const DAY_MS = 86_400_000;
      const data = gantt.service("stargantt.data");
      const nextFrame = (): Promise<void> =>
        new Promise((resolve) => requestAnimationFrame(() => resolve()));

      // Warm-up move, discarded: the first propagation also pays for lazily built engine state.
      gantt.dispatch("task/move", { id: "c0", start: 0, end: DAY_MS });
      await nextFrame();
      const warmTail = data.getTask("c9999")?.start ?? 0;

      const engineMs: number[] = [];
      const endToEndMs: number[] = [];
      const tails: number[] = [];
      for (let i = 1; i <= moves; i++) {
        const start = i * 7 * DAY_MS;
        const t0 = performance.now();
        gantt.dispatch("task/move", { id: "c0", start, end: start + DAY_MS });
        const afterDispatch = performance.now();
        await nextFrame();
        engineMs.push(afterDispatch - t0);
        endToEndMs.push(performance.now() - t0);
        tails.push(data.getTask("c9999")?.start ?? 0);
      }

      return { warmTail, engineMs, endToEndMs, tails, head: data.getTask("c0")?.start ?? 0 };
    }, 5);

    const engineMedian = median(run.engineMs);
    const endToEndMedian = median(run.endToEndMs);

    console.log(
      `[perf-regression] 10k chain reschedule (warm, n=${run.endToEndMs.length}): ` +
        `engine median=${engineMedian.toFixed(1)}ms [${run.engineMs.map((v) => v.toFixed(0)).join(", ")}] ` +
        `end-to-end median=${endToEndMedian.toFixed(1)}ms ` +
        `[${run.endToEndMs.map((v) => v.toFixed(0)).join(", ")}]`,
    );

    // Non-vacuity: every move must have propagated all the way to the last task of the chain, and
    // moving the head strictly forward must move the tail strictly forward too. A measurement of
    // a no-op reschedule would otherwise be trivially "fast".
    expect(run.tails).toHaveLength(5);
    expect(run.tails[0]).toBeGreaterThan(run.warmTail);
    for (let i = 1; i < run.tails.length; i++) {
      expect(run.tails[i]!).toBeGreaterThan(run.tails[i - 1]!);
    }

    expect(endToEndMedian).toBeLessThan(RESCHEDULE_MEDIAN_BUDGET_MS);
  });
});
