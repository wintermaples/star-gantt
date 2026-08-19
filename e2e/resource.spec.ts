import { expect, test } from "./_fixtures";
import { FIXED_TIME, settle } from "./_fixtures";
import type { Page } from "@playwright/test";

// E2E for examples/resource.html: the resource plugin's wiring (pool, assignment editing, the
// resource-view strip, utilization warnings and the load chart), composed as an OPT-IN plugin on
// top of `presetStandard()` — with `interaction.dragEdit.resourceDrag: true`, so lane-drag
// reassignment can be exercised through the real arbiter rather than a service call. The load
// chart renders its band and lanes as CANVAS (resource.md §3.6), and the overload warning glyph
// paints through
// `taskbars/overlays` on the same chart-body canvas layer bars use, so those assertions are pixel
// probes at computed anchor positions (the scheduling.spec.ts / tracking.spec.ts convention), while
// the resource-view strip and the heatmap stay real DOM (resource.md §3.4/§3.6) and are asserted
// through locators.
//
// **Composition note (this file composes `presetStandard()` — interaction, undo-redo, a11y and
// scheduling are present, scheduling with its own default config i.e. no dependency links drawn).**
// The heatmap's `overlay-corner` claim (resource.md §4.2) is composition-dependent: scheduling's
// diagnostics panel and interaction's filter/zoom toolbars only claim a corner when THEIR OWN
// config turns them on, and examples/resource.html configures neither — so, empirically (verified
// against the built bundle before writing this assertion, not assumed from the spec's hypothetical
// fully-loaded-preset example), the heatmap's own requested corner (top-right) is granted outright.
// A page that also enabled those other panels would see the heatmap displaced to its documented
// alternative instead.
//
// Every discriminating probe below is paired with a same-page negative-control resource/task:
// "bob" and "crane" are never overallocated (bob by non-overlap, crane by higher capacity), so
// every overallocation-shaped assertion has a same-page pair to fail against.
//
// The one screenshot assertion, in the "display" describe block, is deliberately left WITHOUT a
// baseline — Playwright's own "no baseline" failure is expected there; baselines are regenerated
// after a visual review (CLAUDE.md §7). Nothing here runs `--update-snapshots`.
//
// Explicitly out of scope here: assignment editing's tri-state checkbox behavior, its Cancel
// path, and the editor placement/clamping and cell-layout pinned geometry rules; the resource-view
// strip's boots-closed default, its position below the chart pane, its header row, pixel-column
// alignment with the tree-grid, and its own service-level open/close (only the view/setBottomPaneHeight
// command path and the drag-reassign gesture are exercised here); the load chart's y-scale
// ladder, gutter-label layout, grid-view interplay, the `resizable: false` divider suppression, DOM
// structure beyond class-name/role spot-checks, the roster-tracked-vs-pinned height distinction
// beyond the one lanes-height scenario covered, `laneScale` variants other than the default
// `"ratio"`, the band/lanes starting hidden (`total`/`lanes: false`), `axisLabels`/`valueLabels`
// content (only their boolean presence is implied by the page composing them on), the resource-view
// strip's own side-panel/toolbar integration, and `aria-errormessage`/edit-dialog interplay on the
// Resources/Overallocation grid columns; the utilization summary and trend panels (only the load
// chart's band/lanes/heatmap panels are exercised).

const DAY_MS = 86_400_000;
const CONTAINER = "#chart";

declare const gantt: {
  service(key: "stargantt.data"): {
    assignments: { get(): Map<string, { taskId: string; resourceId: string; units: number }[]> };
  };
  service(key: "stargantt.history"): {
    state: { get(): { canUndo: boolean; canRedo: boolean; depth: number } };
    undo(): void;
  };
  service(key: "stargantt.rows"): { rowOf(id: string): number | undefined };
  service(key: "stargantt.task-bars"): {
    barBoxOf(id: string): { x: number; y: number; width: number; height: number; gutterStart: number; gutterEnd: number } | undefined;
  };
  service(key: "stargantt.resource-pool"): {
    entries(): readonly { id: string; name: string }[];
  };
  service(key: "stargantt.utilization"): {
    overallocations(): readonly { resourceId: string; peakRatio: number | null }[];
    utilizationReport(options?: unknown): readonly {
      resourceId: string;
      cells: readonly { start: number; end: number; allocated: number; capacity: number; ratio: number | null }[];
    }[];
    bandVisible(): boolean;
    lanesVisible(): boolean;
    setLanesVisible(v: boolean): void;
    lanesHeight(): number;
    setLanesHeight(px: number): void;
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

/** Page-absolute point of the utilization warning glyph (resource.md §3.5: centered 8 px right of
 *  `bar.x + bar.width + bar.gutterEnd`). */
async function warningProbePoint(page: Page, taskId: string): Promise<Point> {
  const pane = await chartBodyBox(page);
  const b = await barBox(page, taskId);
  return { x: pane.x + b.x + b.width + b.gutterEnd + 8, y: pane.y + b.y + b.height / 2 };
}

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

async function assignmentsOf(page: Page, taskId: string) {
  return page.evaluate((id) => gantt.service("stargantt.data").assignments.get().get(id) ?? [], taskId);
}

async function gridCell(page: Page, taskId: string, columnId: string) {
  const row = await page.evaluate((id) => gantt.service("stargantt.rows").rowOf(id), taskId);
  if (row === undefined) throw new Error(`task "${taskId}" has no row`);
  return page.locator(`.sg-grid-row[data-row-index="${String(row)}"] .sg-grid-cell[data-column-id="${columnId}"]`);
}

async function bootResource(page: Page, openExample: import("./_fixtures").OpenExample): Promise<void> {
  await openExample("resource.html", { ready: `${CONTAINER} canvas`, fixedTime: FIXED_TIME });
  await settle(page);
}

test.describe("pool + assignments", () => {
  test("the pool seed mirrors into the data store and the Resources column shows every chip", async ({
    page,
    openExample,
  }) => {
    await bootResource(page, openExample);
    const entries = await page.evaluate(() => gantt.service("stargantt.resource-pool").entries());
    expect(entries.map((e) => e.id).sort()).toEqual(["alice", "bob", "crane"]);

    const cellA = await gridCell(page, "taskA", "resource.resources");
    await expect(cellA.locator(".sg-ra-chip")).toHaveCount(2); // alice + bob
    const cellC = await gridCell(page, "taskC", "resource.resources");
    await expect(cellC.locator(".sg-ra-chip")).toHaveCount(1); // crane only
  });

  test("assignment edit through the editor dialog commits as ONE undo step", async ({ page, openExample }) => {
    await bootResource(page, openExample);
    const before = await historyState(page);
    const cell = await gridCell(page, "taskC", "resource.resources");
    await cell.locator(".sg-ra-open").click();
    await settle(page);

    const dialog = page.getByRole("dialog", { name: "Assign resources" });
    await expect(dialog).toBeVisible();
    await dialog.locator('input[aria-label="Assign Alice"]').check();
    await dialog.getByRole("button", { name: "Apply" }).click();
    await settle(page);

    expect(await dialog.count()).toBe(0);
    const after = await historyState(page);
    expect(after.depth).toBe(before.depth + 1);

    const assignments = await assignmentsOf(page, "taskC");
    expect(assignments.map((a) => a.resourceId).sort()).toEqual(["alice", "crane"]);

    await page.evaluate(() => gantt.service("stargantt.history").undo());
    await settle(page);
    expect((await historyState(page)).depth).toBe(before.depth);
    expect((await assignmentsOf(page, "taskC")).map((a) => a.resourceId)).toEqual(["crane"]);
  });

  test("dragging a single-assignee bar onto another lane reassigns it (interaction's dragging-lane arbiter)", async ({
    page,
    openExample,
  }) => {
    await bootResource(page, openExample);
    expect(await assignmentsOf(page, "taskC")).toEqual([{ taskId: "taskC", resourceId: "crane", units: 1 }]);
    const before = await historyState(page);

    const pane = await chartBodyBox(page);
    const bar = await barBox(page, "taskC"); // taskC has exactly one assignee (crane) — laneOfTask resolves
    const startX = pane.x + bar.x + bar.width / 2;
    const startY = pane.y + bar.y + bar.height / 2;
    const aliceRow = await page.locator(".sg-resource-view__row").first().boundingBox();
    if (aliceRow === null) throw new Error("resource-view row not found");
    const targetY = aliceRow.y + aliceRow.height / 2;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    // Vertical-dominant press-move (|dy| > |dx|) enters `dragging-lane`, per interaction.md's
    // `pointer/barMove` table (only reachable with `dragEdit.resourceDrag: true`, set in this
    // example's `presetStandard()` config).
    await page.mouse.move(startX, startY - 10, { steps: 3 });
    await page.mouse.move(startX, targetY, { steps: 10 });
    await settle(page);
    // The provider's lane highlight (resource.md §3.4's `highlightLane`, `--target` modifiers) is
    // live during the drag — the visible-before-commit signifier gantt-ui-ux requires.
    expect(
      await page.evaluate(
        () => document.querySelectorAll(".sg-resource-view__row--target, .sg-resource-view__label--target").length,
      ),
    ).toBeGreaterThan(0);
    await page.mouse.up();
    await settle(page);

    expect(await assignmentsOf(page, "taskC")).toEqual([{ taskId: "taskC", resourceId: "alice", units: 1 }]);
    const afterFirst = await historyState(page);
    expect(afterFirst.depth).toBe(before.depth + 1); // one undo step for the reassign

    // A second drop, onto a DIFFERENT lane (bob's row): the discriminating half of the check — the
    // target resource genuinely tracks the drop's y position rather than some fixed lane.
    const bobRow = await page.locator(".sg-resource-view__row").nth(1).boundingBox();
    if (bobRow === null) throw new Error("bob's resource-view row not found");
    const bobTargetY = bobRow.y + bobRow.height / 2;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX, startY - 10, { steps: 3 });
    await page.mouse.move(startX, bobTargetY, { steps: 10 });
    await settle(page);
    await page.mouse.up();
    await settle(page);

    expect(await assignmentsOf(page, "taskC")).toEqual([{ taskId: "taskC", resourceId: "bob", units: 1 }]);
    expect((await historyState(page)).depth).toBe(afterFirst.depth + 1); // one undo step per drop
  });
});

test.describe("overallocation", () => {
  test("the warning glyph paints for alice's overlapping tasks, not for crane's — same-page negative control", async ({
    page,
    openExample,
  }) => {
    await bootResource(page, openExample);
    expect(await hasPaintedPixel(page, await warningProbePoint(page, "taskA"))).toBe(true);
    expect(await hasPaintedPixel(page, await warningProbePoint(page, "taskB"))).toBe(true);
    // Negative control: taskC's sole assignee (crane, capacity 2) is never over.
    expect(await hasPaintedPixel(page, await warningProbePoint(page, "taskC"))).toBe(false);
  });

  test("the Overallocation grid column names the over resource, textually — never color alone", async ({
    page,
    openExample,
  }) => {
    await bootResource(page, openExample);
    const cellA = await gridCell(page, "taskA", "resource.overallocation");
    await expect(cellA).toHaveText("⚠ Over: Alice");
    const cellC = await gridCell(page, "taskC", "resource.overallocation");
    await expect(cellC).toHaveText("");
  });

  test("overallocations() and the band's own report agree: alice peaks at 1.3, bob and crane never do", async ({
    page,
    openExample,
  }) => {
    await bootResource(page, openExample);
    const over = await page.evaluate(() => gantt.service("stargantt.utilization").overallocations());
    expect(over).toHaveLength(1);
    expect(over[0]!.resourceId).toBe("alice");
    expect(over[0]!.peakRatio).toBeCloseTo(1.3, 5);

    // Band Σ values (resource.md §3.6): the day-0 bucket (taskA alone, before taskB starts) sums
    // to 0.6 of a working day, and SOME working-day bucket sums to the full 0.6+0.7 overlap — the
    // same figures the aggregate band's bars plot. The overlap calendar-day span (Aug 9–11) has a
    // non-working day inside it (a working calendar, off by default), so which INDEX carries the
    // peak is calendar-dependent; the peak VALUE is not — it is asserted by search, not by a
    // hardcoded bucket index.
    const report = await page.evaluate(() => gantt.service("stargantt.utilization").utilizationReport());
    const alice = report.find((r) => r.resourceId === "alice");
    if (alice === undefined) throw new Error("no alice row in the report");
    expect(alice.cells[0]!.allocated).toBeCloseTo(0.6 * DAY_MS, -2);
    const peakAllocated = Math.max(...alice.cells.map((c) => c.allocated));
    expect(peakAllocated).toBeCloseTo(1.3 * DAY_MS, -2);
    const bob = report.find((r) => r.resourceId === "bob");
    const crane = report.find((r) => r.resourceId === "crane");
    for (const row of [bob, crane]) {
      if (row === undefined) continue;
      for (const cell of row.cells) if (cell.ratio !== null) expect(cell.ratio).toBeLessThanOrEqual(1);
    }
  });
});

test.describe("load chart", () => {
  test("resource-view, the band and the lanes strip stack top to bottom (§4.2's −1 / 0 / 1 orders)", async ({
    page,
    openExample,
  }) => {
    await bootResource(page, openExample);
    const rv = await page.locator(".sg-resource-view").boundingBox();
    const band = await page.locator(".sg-load-chart").boundingBox();
    const lanes = await page.locator(".sg-load-lanes").boundingBox();
    if (rv === null || band === null || lanes === null) throw new Error("a strip is not visible");
    expect(rv.y).toBeLessThan(band.y);
    expect(band.y).toBeLessThan(lanes.y);
  });

  test("the heatmap opens at its granted corner (top-right — see this file's header note)", async ({
    page,
    openExample,
  }) => {
    await bootResource(page, openExample);
    const heatmap = page.locator(".sg-load-heatmap");
    await expect(heatmap).toBeVisible();
    const style = await heatmap.evaluate((el) => ({ top: (el as HTMLElement).style.top, right: (el as HTMLElement).style.right }));
    expect(style.top).toContain("--sg-safe-top");
    expect(style.right).toContain("--sg-safe-right");
    const heatmapBox = await heatmap.boundingBox();
    const chartBox = await page.locator(CONTAINER).boundingBox();
    if (heatmapBox === null || chartBox === null) throw new Error("missing box");
    // Anchored to the right edge, near the top — not bottom-left, which this composition never
    // grants the corner slot away from (see the header note on why).
    expect(heatmapBox.x + heatmapBox.width).toBeGreaterThan(chartBox.x + chartBox.width - 50);
    expect(heatmapBox.y).toBeLessThan(chartBox.y + chartBox.height / 2);
  });

  test("strip toggles via the service, including restore-last-height once a host has sized it", async ({
    page,
    openExample,
  }) => {
    await bootResource(page, openExample);
    const initial = await page.evaluate(() => gantt.service("stargantt.utilization").lanesHeight());
    expect(initial).toBeGreaterThan(0); // roster-tracked auto height (3 resources)
    // Discriminating: the 130 target below must differ from the roster-auto height, or the final
    // assertion could pass merely because the auto formula happens to already equal it.
    expect(initial).not.toBe(130);

    await page.evaluate(() => gantt.service("stargantt.utilization").setLanesHeight(130));
    await settle(page);
    expect(await page.evaluate(() => gantt.service("stargantt.utilization").lanesHeight())).toBe(130);

    await page.evaluate(() => gantt.service("stargantt.utilization").setLanesVisible(false));
    await settle(page);
    expect(await page.evaluate(() => gantt.service("stargantt.utilization").lanesVisible())).toBe(false);
    expect(await page.evaluate(() => gantt.service("stargantt.utilization").lanesHeight())).toBe(0);

    await page.evaluate(() => gantt.service("stargantt.utilization").setLanesVisible(true));
    await settle(page);
    // Restored to the height a host explicitly set, NOT re-derived from the roster formula
    // (resource.md §3.6 — "then theirs for the instance's life").
    expect(await page.evaluate(() => gantt.service("stargantt.utilization").lanesHeight())).toBe(130);
  });
});

test.describe("display", () => {
  test("boots without error and matches the reviewed baseline screenshot", async ({ page, openExample }) => {
    await bootResource(page, openExample);
    // Intentionally no snapshot exists yet — Playwright's own "no baseline" failure is expected
    // here; see the file header. `resource-chromium-linux.png` is generated after a visual review
    // (CLAUDE.md §7). NOT run with `--update-snapshots`.
    await expect(page).toHaveScreenshot("resource.png", { maxDiffPixelRatio: 0.02 });
  });
});
