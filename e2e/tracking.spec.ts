import { expect, test } from "./_fixtures";
import { FIXED_TIME, settle } from "./_fixtures";
import type { Page } from "@playwright/test";

// E2E for examples/tracking.html: the tracking wiring (baselines, progress tracking, cost
// tracking, EVM), composed as an OPT-IN plugin on top of `presetStandard()` (tracking.md's own
// presence semantics — every nest dormant unless configured; the example enables all four). The
// package paints baseline slip triangles, RAG badges and the overload glyph family through
// `taskbars/overlays` on the SAME chart-body canvas layer task bars themselves use (view.md's
// zIndex→canvas banding — everything under 100 lands on the `"main"` layer), so those assertions
// are canvas pixel probes at computed anchor positions (the scheduling.spec.ts convention: task-bar
// geometry from `stargantt.task-bars`'s `barBoxOf`, converted to page-absolute coordinates via the
// chart body canvas's own bounding box) rather than DOM locators.
//
// Every discriminating probe below is paired with either a same-page negative control (a second
// task known to lack the thing being probed for, at the geometrically analogous point) or a
// capture-removal control (deactivating the baseline and re-probing the identical point).
//
// The one screenshot assertion, in the "display" describe block, is deliberately left WITHOUT a
// baseline — Playwright's own "no baseline" failure is expected there; baselines are regenerated
// after a visual review (CLAUDE.md §7). Nothing here runs `--update-snapshots`.
//
// Explicitly out of scope here: the baseline bar underlay's own paint (this file only asserts the
// slip triangle overlay, never the baseline bar/rect itself); progress's Escape-to-cancel path,
// the trend panel, and the "only one of {bulk, trend, cost, EVM} panel open at a time" interplay;
// EVM's S-curve panel, its own
// Close button, and the SPI-behind/CPI-over textual flags (only SPI/CPI's numeric values are
// asserted here).

const DAY_MS = 86_400_000;
const CONTAINER = "#chart";

declare const gantt: {
  service(key: "stargantt.data"): {
    getTask(id: string): { id: string; name: string; start: number; end: number; progress?: number } | undefined;
    load(data: unknown): void;
    assignments: { get(): Map<string, { taskId: string; resourceId: string; units: number }[]> };
  };
  service(key: "stargantt.history"): {
    state: { get(): { canUndo: boolean; canRedo: boolean; depth: number } };
    undo(): void;
    redo(): void;
  };
  service(key: "stargantt.timeline"): { tToX(t: number): number };
  service(key: "stargantt.task-bars"): {
    barBoxOf(id: string): { x: number; y: number; width: number; height: number; gutterStart: number; gutterEnd: number } | undefined;
  };
  service(key: "stargantt.baselines"): {
    state: { get(): { baselines: readonly { id: string | number; name: string }[]; activeId: string | number | undefined } };
    save(name?: string): string | number;
    get(id: string | number): { id: string | number; tasks: Map<string, unknown> } | undefined;
    setActive(id: string | number | undefined): void;
    variance(): readonly { id: string; endVarianceMs: number }[];
  };
  service(key: "stargantt.progress"): {
    state: { get(): { progressLineVisible: boolean } };
    setProgressLineVisible(v: boolean): void;
    statusDate(): number;
    openBulkUpdatePanel(): boolean;
  };
  service(key: "stargantt.cost"): {
    costValuesOf(id: string): { actualCost?: number };
  };
  service(key: "stargantt.evm"): {
    projectMetrics(): {
      bac: number;
      pv: number;
      ev: number;
      ac: number;
      sv: number;
      cv: number;
      eac: number;
      etc: number;
      spi?: number;
      cpi?: number;
    };
    statusDate(): number;
  };
};

interface Point {
  x: number;
  y: number;
}

async function chartBodyBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator(".sg-pane--chart canvas.sg-layer").first().boundingBox();
  if (box === null) throw new Error("chart body canvas not found");
  return box;
}

interface BarBox {
  x: number;
  y: number;
  width: number;
  height: number;
  gutterStart: number;
  gutterEnd: number;
}

async function barBox(page: Page, taskId: string): Promise<BarBox> {
  const box = await page.evaluate((id) => {
    const b = gantt.service("stargantt.task-bars").barBoxOf(id);
    return b === undefined ? null : { x: b.x, y: b.y, width: b.width, height: b.height, gutterStart: b.gutterStart, gutterEnd: b.gutterEnd };
  }, taskId);
  if (box === null) throw new Error(`no visible bar for task "${taskId}"`);
  return box;
}

/** Page-absolute point the baseline slip triangle paints at (beside the bar's END gutter,
 *  direction: right for late). */
async function slipProbePoint(page: Page, taskId: string): Promise<Point> {
  const pane = await chartBodyBox(page);
  const b = await barBox(page, taskId);
  return { x: pane.x + b.x + b.width + b.gutterEnd + 6, y: pane.y + b.y + b.height / 2 };
}

/** Page-absolute point the RAG badge paints at (beside the bar's START gutter, tracking.md §3.2:
 *  "8 px left of the resolved start gutter"). */
async function ragProbePoint(page: Page, taskId: string): Promise<Point> {
  const pane = await chartBodyBox(page);
  const b = await barBox(page, taskId);
  return { x: pane.x + b.x - b.gutterStart - 8, y: pane.y + b.y + b.height / 2 };
}

/** The RGBA quadruplet at a page-absolute point on the `"main"` chart-body canvas layer. */
async function pixelAt(page: Page, point: Point): Promise<[number, number, number, number]> {
  return page.evaluate(({ x, y }) => {
    const canvas = document.querySelector('.sg-pane--chart canvas[data-layer="main"]') as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const ctx2d = canvas.getContext("2d")!;
    const sx = Math.round((x - rect.left) * (canvas.width / rect.width));
    const sy = Math.round((y - rect.top) * (canvas.height / rect.height));
    const data = ctx2d.getImageData(sx, sy, 1, 1).data;
    return [data[0]!, data[1]!, data[2]!, data[3]!];
  }, point);
}

/** Whether the `"main"` chart-body canvas layer has any non-transparent pixel in a small square
 *  centred at a page-absolute point (the scheduling.spec.ts `hasPaintedPixel` convention). */
async function hasPaintedPixel(page: Page, center: Point, half = 4): Promise<boolean> {
  return page.evaluate(
    ({ cx, cy, half }) => {
      const canvas = document.querySelector('.sg-pane--chart canvas[data-layer="main"]') as HTMLCanvasElement | null;
      if (canvas === null) return false;
      const ctx2d = canvas.getContext("2d");
      if (ctx2d === null) return false;
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const x0 = Math.max(0, Math.round((cx - half - rect.left) * scaleX));
      const y0 = Math.max(0, Math.round((cy - half - rect.top) * scaleY));
      const w = Math.min(canvas.width - x0, Math.round(half * 2 * scaleX));
      const h = Math.min(canvas.height - y0, Math.round(half * 2 * scaleY));
      if (w <= 0 || h <= 0) return false;
      const data = ctx2d.getImageData(x0, y0, w, h).data;
      for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) return true;
      return false;
    },
    { cx: center.x, cy: center.y, half },
  );
}

async function historyState(page: Page) {
  return page.evaluate(() => gantt.service("stargantt.history").state.get());
}

async function bootTracking(page: Page, openExample: import("./_fixtures").OpenExample): Promise<void> {
  await openExample("tracking.html", { ready: `${CONTAINER} canvas`, fixedTime: FIXED_TIME });
  await settle(page);
}

test.describe("baselines", () => {
  test("the seeded baseline is active with the variance rows the dataset implies", async ({ page, openExample }) => {
    await bootTracking(page, openExample);
    const state = await page.evaluate(() => gantt.service("stargantt.baselines").state.get());
    expect(state.activeId).toBe("approved");
    expect(state.baselines.map((b) => b.id)).toEqual(["approved"]);

    const variance = await page.evaluate(() => gantt.service("stargantt.baselines").variance());
    const byId = new Map(variance.map((r) => [r.id, r]));
    // impl and qa were seeded one day later than the baseline snapshot; spec matches exactly.
    expect(byId.get("spec")?.endVarianceMs).toBe(0);
    expect(byId.get("impl")?.endVarianceMs).toBe(DAY_MS);
    expect(byId.get("qa")?.endVarianceMs).toBe(DAY_MS);
  });

  test("slip triangle paints for a late task, not for an on-baseline one — capture removal clears it", async ({
    page,
    openExample,
  }) => {
    await bootTracking(page, openExample);
    const implPoint = await slipProbePoint(page, "impl");
    const specPoint = await slipProbePoint(page, "spec");

    // Positive: impl slipped a day late against the active baseline.
    expect(await hasPaintedPixel(page, implPoint)).toBe(true);
    // Negative control: spec has zero slip against the same active baseline, same page, same
    // geometry — the discriminating pair (not merely "some pixel changed somewhere").
    expect(await hasPaintedPixel(page, specPoint)).toBe(false);

    // Capture-removal negative control: deactivating the baseline stops every slip triangle,
    // including impl's, at the identical point.
    await page.evaluate(() => gantt.service("stargantt.baselines").setActive(undefined));
    await settle(page);
    expect(await hasPaintedPixel(page, implPoint)).toBe(false);
  });

  test("save() captures a new baseline against the live schedule, leaving the old one intact", async ({
    page,
    openExample,
  }) => {
    await bootTracking(page, openExample);
    const before = await page.evaluate(() => gantt.service("stargantt.baselines").get("approved"));
    expect(before).toBeDefined();

    const newId = await page.evaluate(() => gantt.service("stargantt.baselines").save("Recapture"));
    await settle(page);

    const state = await page.evaluate(() => gantt.service("stargantt.baselines").state.get());
    expect(state.activeId).toBe(newId);
    expect(state.baselines.map((b) => b.id).sort()).toEqual(["approved", newId].sort());

    // Fresh capture against the live schedule: zero variance everywhere.
    const variance = await page.evaluate(() => gantt.service("stargantt.baselines").variance());
    for (const row of variance) expect(row.endVarianceMs).toBe(0);

    // The old baseline is untouched.
    const stillThere = await page.evaluate(() => gantt.service("stargantt.baselines").get("approved"));
    expect(stillThere).toBeDefined();
  });
});

test.describe("progress tracking", () => {
  test("RAG badges: amber vs red are visually distinct; a task with no RAG paints nothing there", async ({
    page,
    openExample,
  }) => {
    await bootTracking(page, openExample);
    const implPoint = await ragProbePoint(page, "impl"); // amber
    const qaPoint = await ragProbePoint(page, "qa"); // red
    const shipPoint = await ragProbePoint(page, "ship"); // no progressTracking meta at all

    const implSample = await pixelAt(page, implPoint);
    const qaSample = await pixelAt(page, qaPoint);

    expect(await hasPaintedPixel(page, implPoint)).toBe(true);
    expect(await hasPaintedPixel(page, qaPoint)).toBe(true);
    // Meaning is never carried by color alone in this codebase, but the two colors are still
    // genuinely different pixels — the discriminating half of the probe.
    expect(implSample).not.toEqual(qaSample);
    // Negative control: a task that never had a `progressTracking` meta value paints nothing at
    // the geometrically analogous point. Two-way difference, honestly noted: "ship" differs from
    // impl/qa in BOTH ways (no RAG meta AND it is a milestone, a different bar shape/gutters than
    // a regular task bar) — this pins "no RAG badge on a bare milestone" rather than isolating the
    // RAG-absence variable alone on an otherwise-identical task bar.
    expect(await hasPaintedPixel(page, shipPoint)).toBe(false);
  });

  test("progress line toggle repaints the chart body", async ({ page, openExample }) => {
    await bootTracking(page, openExample);
    expect(await page.evaluate(() => gantt.service("stargantt.progress").state.get().progressLineVisible)).toBe(false);

    // The line is a zigzag (status-date x at the canvas top and bottom, deflecting to each bar's
    // own progress point in between — `internal/progress/line.ts`'s `progressLinePoints`), not a
    // straight vertical stroke, so this asserts "the chart body's pixels changed" over the whole
    // canvas rather than guessing one on-line coordinate: a checksum of every RGBA byte, before vs
    // after each toggle.
    const checksum = () =>
      page.evaluate(() => {
        const canvas = document.querySelector('.sg-pane--chart canvas[data-layer="main"]') as HTMLCanvasElement;
        const ctx2d = canvas.getContext("2d")!;
        const data = ctx2d.getImageData(0, 0, canvas.width, canvas.height).data;
        let sum = 0;
        for (let i = 0; i < data.length; i += 1) sum = (sum + data[i]!) % 1_000_000_007;
        return sum;
      });

    const before = await checksum();

    await page.click("#btn-progress-line");
    await settle(page);
    expect(await page.evaluate(() => gantt.service("stargantt.progress").state.get().progressLineVisible)).toBe(true);
    const afterOn = await checksum();
    expect(afterOn).not.toBe(before);

    // Toggling back off repaints the identical (pre-line) frame — capture-removal style.
    await page.click("#btn-progress-line");
    await settle(page);
    expect(await page.evaluate(() => gantt.service("stargantt.progress").state.get().progressLineVisible)).toBe(false);
    const afterOff = await checksum();
    expect(afterOff).toBe(before);
  });

  test("bulk progress update commits every edited row as ONE undo step", async ({ page, openExample }) => {
    await bootTracking(page, openExample);
    await page.evaluate(() => gantt.service("stargantt.progress").openBulkUpdatePanel());
    await settle(page);
    const dialog = page.getByRole("dialog", { name: "Update progress" });
    await expect(dialog).toBeVisible();

    const before = await historyState(page);
    const specInput = dialog.locator('input[aria-label="Design — Progress %"]');
    const implInput = dialog.locator('input[aria-label="Build — Progress %"]');
    await specInput.fill("80");
    await implInput.fill("90");
    await dialog.getByRole("button", { name: "Apply" }).click();
    await settle(page);

    expect(await dialog.count()).toBe(0); // Apply closes the panel.
    const after = await historyState(page);
    expect(after.depth).toBe(before.depth + 1); // exactly one undo step for BOTH edited rows.

    const specTask = await page.evaluate(() => gantt.service("stargantt.data").getTask("spec"));
    const implTask = await page.evaluate(() => gantt.service("stargantt.data").getTask("impl"));
    expect(specTask?.progress).toBeCloseTo(0.8, 5);
    expect(implTask?.progress).toBeCloseTo(0.9, 5);

    await page.evaluate(() => gantt.service("stargantt.history").undo());
    await settle(page);
    const undone = await historyState(page);
    expect(undone.depth).toBe(before.depth); // the single undo reverted both edits together.
    const specAfterUndo = await page.evaluate(() => gantt.service("stargantt.data").getTask("spec"));
    const implAfterUndo = await page.evaluate(() => gantt.service("stargantt.data").getTask("impl"));
    expect(specAfterUndo?.progress).toBe(1);
    expect(implAfterUndo?.progress).toBe(0.6);
  });
});

test.describe("cost + EVM", () => {
  test("the cost table panel opens modal and Apply commits one undo step", async ({ page, openExample }) => {
    await bootTracking(page, openExample);
    await page.click("#btn-cost-table");
    await settle(page);
    const dialog = page.getByRole("dialog", { name: "Budget vs actual" });
    await expect(dialog).toBeVisible();
    expect(await dialog.getAttribute("aria-modal")).toBe("true");
    expect(await dialog.getAttribute("class")).toBe("sg-cost-table");

    const before = await historyState(page);
    const actualInput = dialog.locator('input[aria-label="Actual cost — Design"]');
    await actualInput.fill("1500");
    await dialog.getByRole("button", { name: "Apply" }).click();
    await settle(page);

    expect(await dialog.count()).toBe(0);
    const after = await historyState(page);
    expect(after.depth).toBe(before.depth + 1);
    const values = await page.evaluate(() => gantt.service("stargantt.cost").costValuesOf("spec"));
    expect(values.actualCost).toBe(1500);
  });

  // A rendering-fidelity check, not a formula proof: it asserts the panel's DOM text matches
  // `EvmService.projectMetrics()`'s own numbers (re-formatted with the same `Intl.NumberFormat`
  // rules the panel's built-in renderer uses), not that the EVM math itself is correct — that is
  // the package's own unit-test coverage's job.
  test("EVM dashboard tiles report the service's own project metrics", async ({ page, openExample }) => {
    await bootTracking(page, openExample);
    await page.click("#btn-evm-dashboard");
    await settle(page);
    const dialog = page.getByRole("dialog", { name: "Earned value" });
    await expect(dialog).toBeVisible();
    expect(await dialog.getAttribute("class")).toBe("sg-evm-dashboard");

    const metrics = await page.evaluate(() => gantt.service("stargantt.evm").projectMetrics());
    const tiles = await page.evaluate(() => {
      const grid = document.querySelector(".sg-evm-dashboard div[style*='grid-template-columns']");
      if (grid === null) return [];
      return [...grid.children].map((card) => {
        const [label, value] = card.children;
        return { label: label?.textContent ?? "", value: value?.textContent ?? "" };
      });
    });
    const byLabel = new Map(tiles.map((t) => [t.label, t.value]));

    const amountFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
    expect(byLabel.get("BAC")).toBe(amountFmt.format(metrics.bac));
    expect(byLabel.get("PV")).toBe(amountFmt.format(metrics.pv));
    expect(byLabel.get("EV")).toBe(amountFmt.format(metrics.ev));
    expect(byLabel.get("AC")).toBe(amountFmt.format(metrics.ac));
    expect(byLabel.get("EAC")).toBe(amountFmt.format(metrics.eac));
    expect(byLabel.get("ETC")).toBe(amountFmt.format(metrics.etc));
    // AC is 0 in this dataset (no actual cost recorded yet) — CPI is genuinely undefined, not a
    // rendering bug: the built-in `formatIndex` renders the em dash for it.
    expect(metrics.ac).toBe(0);
    expect(byLabel.get("CPI")).toBe("—");
    const spiFmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    expect(byLabel.get("SPI")).toBe(spiFmt.format(metrics.spi!));
  });

  // Only progress and EVM are checked, honestly: `ProgressService.statusDate()` and
  // `EvmService.statusDate()` are the two RESOLVED, publicly readable accessors (the configured
  // value, else a fallback chain — §2.11/§2.14). Baselines has no status-date concept at all
  // (variance/critical-path comparison is snapshot-based, not date-accrual-based). Cost's
  // configured status date is real (`cost.statusDate` in this page's config) but NOT exposed on
  // `CostService`'s public surface at all — it is only visible inside a custom `cost.formulas[]`
  // callback's `CostFormulaInput.statusDate` (§2.12), which this page does not configure, so there
  // is nothing on the service to read back and compare.
  test("progress and EVM both resolve the same configured status date", async ({ page, openExample }) => {
    await bootTracking(page, openExample);
    const dates = await page.evaluate(() => ({
      progress: gantt.service("stargantt.progress").statusDate(),
      evm: gantt.service("stargantt.evm").statusDate(),
    }));
    const T0 = (await page.evaluate(() => Math.floor(Date.now() / 86_400_000) * 86_400_000)) as number;
    expect(dates.progress).toBe(T0 + 6 * DAY_MS);
    expect(dates.evm).toBe(T0 + 6 * DAY_MS);
  });
});

test.describe("display", () => {
  test("boots without error and matches the reviewed baseline screenshot", async ({ page, openExample }) => {
    await bootTracking(page, openExample);
    // Intentionally no snapshot exists yet — Playwright's own "no baseline" failure is expected
    // here; see the file header. `tracking-chromium-linux.png` is generated after a visual review
    // (CLAUDE.md §7). NOT run with `--update-snapshots`.
    await expect(page).toHaveScreenshot("tracking.png", { maxDiffPixelRatio: 0.02 });
  });
});
