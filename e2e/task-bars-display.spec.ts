import { FIXED_TIME, expect, settle, test } from "./_fixtures";

// Feature E2E for the opt-in task-bars display options, driven by
// `examples/task-bars-display.html`.
//
// Service surface: `gantt.service("stargantt.timeline")` (docs/specs/plugins/view.md — the service
// id is `stargantt.timeline`, `TimelineService`) exposes `pxPerMs`. `stargantt.task-bars`
// (`visibleBoxes`, `barRect`, `barBoxOf`) and `stargantt.data` (`getTask`) round out the surface
// used here. The page itself assigns `window.ganttDemo = { gantt }`, so the `ganttDemo.gantt`
// access pattern below needs no adaptation.
//
// What is asserted, against the built bundle in a real browser:
//
// 1. The `stargantt.task-bars` geometry service still reports every bar: display options are a
//    painting of the bar, never a geometry change (task-bars.md §1.3.1 — a milestone marker shape
//    fills the same square box its bar would occupy).
// 2. `collapsedSummary: "split"` (the page's default toolbar state): a collapsed summary paints its
//    children instead of its own glyph (task-bars.md §1.14), and an in-row child is a full editing
//    surface — dragging one moves that child, the row it was dragged in still belongs to the parent.
// 3. The pattern fill actually paints: the diagonal stripes are a translucent white overlay, so an
//    ordinary bar's box contains near-white pixels that a pattern-less composition would not
//    produce with the stock palette.
//
// No screenshot baselines: the page is exercised through the service surface and pixel scans.

const PAGE = "task-bars-display.html";
const PANE = ".sg-pane--chart";

test("display options leave the bar geometry service intact", async ({ page, openExample }) => {
  await openExample(PAGE, { ready: `${PANE} canvas`, fixedTime: FIXED_TIME, settle: true });
  await settle(page);

  const report = await page.evaluate(() => {
    const gantt = (window as any).ganttDemo.gantt;
    const svc = gantt.service("stargantt.task-bars");
    const ids = svc.visibleBoxes().map((box: any) => box.id);
    const qa = svc.barRect("qa");
    const impl = svc.barRect("impl");
    const ship = svc.barRect("ship");
    return {
      ids,
      // The QA task spans t0..t0+7d, the plain implementation bar t0-1d..t0+6d — both are 7 civil
      // days wide, so their boxes must match: a display option never changes geometry.
      qaWidth: qa?.width,
      implWidth: impl?.width,
      // A star milestone still fills the standard square box (width === height).
      shipBox: ship ? { width: ship.width, height: ship.height } : undefined,
    };
  });

  expect(report.ids).toEqual(
    expect.arrayContaining(["root", "spec", "impl", "qa", "docs", "ship"]),
  );
  expect(report.qaWidth).toBeGreaterThan(0);
  expect(report.qaWidth).toBe(report.implWidth);
  expect(report.shipBox).toBeDefined();
  expect(report.shipBox!.width).toBe(report.shipBox!.height);
});

test("under collapsedSummary: split every collapsed summary reports its children", async ({
  page,
  openExample,
}) => {
  await openExample(PAGE, { ready: `${PANE} canvas`, fixedTime: FIXED_TIME, settle: true });
  await settle(page);

  const report = await page.evaluate(() => {
    const gantt = (window as any).ganttDemo.gantt;
    const svc = gantt.service("stargantt.task-bars");
    return {
      ids: svc.visibleBoxes().map((box: any) => box.id),
      // The composite members are what §1.14 speaks about: a split row leaves the composite in
      // favour of its children.
      vendor: svc.barBoxOf("vendor") !== undefined,
      post: svc.barBoxOf("post") !== undefined,
      // The in-row children are measurable through the composite, which is what makes them
      // reachable by pointer at all.
      childBox: svc.barBoxOf("vendor-api") !== undefined,
    };
  });

  // The page composes `collapsedSummary: "split"`, and the mode is chart-wide with no per-task
  // opt-in, so *both* collapsed summaries paint their children instead of their own glyph
  // (task-bars.md §1.14).
  expect(report.ids).toEqual(
    expect.arrayContaining(["vendor-ui", "vendor-api", "post-metrics", "post-retro"]),
  );
  expect(report.ids).not.toContain("vendor");
  expect(report.ids).not.toContain("post");
  expect(report.vendor).toBe(false);
  expect(report.post).toBe(false);
  expect(report.childBox).toBe(true);
});

// task-bars.md §1.14 — an in-row child is a full editing surface: dragging one moves that child,
// and the row it was dragged in still belongs to the parent.
test("dragging an in-row child of a split row moves that child", async ({ page, openExample }) => {
  await openExample(PAGE, { ready: `${PANE} canvas`, fixedTime: FIXED_TIME, settle: true });
  await settle(page);

  const before = await page.evaluate(() => {
    const gantt = (window as any).ganttDemo.gantt;
    const box = gantt.service("stargantt.task-bars").barBoxOf("vendor-api");
    const task = gantt.service("stargantt.data").getTask("vendor-api");
    const pane = document.querySelector(".sg-pane--chart") as HTMLElement;
    const rect = pane.getBoundingClientRect();
    // The chart canvases start below the timeline header inset, so a viewport-local y is measured
    // from the layer canvas's top, not the pane's.
    const layer = pane.querySelector("canvas.sg-layer") as HTMLElement;
    const top = layer.getBoundingClientRect().top;
    return {
      start: task.start,
      end: task.end,
      x: rect.left + box.x + box.width / 2,
      y: top + box.y + box.height / 2,
      dayPx: gantt.service("stargantt.timeline").pxPerMs * 86_400_000,
    };
  });

  // The gesture only becomes a drag past the 3px threshold, so it is walked, not teleported.
  const dx = Math.round(before.dayPx * 2);
  await page.mouse.move(before.x, before.y);
  await page.mouse.down();
  await page.mouse.move(before.x + 8, before.y);
  await page.mouse.move(before.x + dx / 2, before.y);
  await page.mouse.move(before.x + dx, before.y);
  await page.mouse.up();
  await settle(page);

  const after = await page.evaluate(() => {
    const gantt = (window as any).ganttDemo.gantt;
    const data = gantt.service("stargantt.data");
    const child = data.getTask("vendor-api");
    return { start: child.start, end: child.end, parentId: child.parentId };
  });

  expect(after.parentId).toBe("vendor");
  expect(after.start).toBeGreaterThan(before.start);
  // A move keeps the duration: only the placement changed.
  expect(after.end - after.start).toBe(before.end - before.start);
});

test("the pattern fill paints translucent-white stripes inside a bar", async ({
  page,
  openExample,
}) => {
  await openExample(PAGE, { ready: `${PANE} canvas`, fixedTime: FIXED_TIME, settle: true });
  await settle(page);

  const found = await page.evaluate((pane) => {
    const gantt = (window as any).ganttDemo.gantt;
    // The docs bar: an ordinary bar with 10% progress, so almost all of its body is the plain
    // fill plus the diagonal pattern — near-white stripe pixels must appear inside its box.
    const box = gantt.service("stargantt.task-bars").barBoxOf("docs");
    if (!box) return "no box";
    const canvases = Array.from(document.querySelectorAll<HTMLCanvasElement>(`${pane} canvas`));
    for (const canvas of canvases) {
      const ctx = canvas.getContext("2d");
      if (ctx === null || canvas.width === 0 || canvas.height === 0) continue;
      const dpr = canvas.width / canvas.getBoundingClientRect().width;
      const x = Math.round((box.x + 2) * dpr);
      const y = Math.round((box.y + 1) * dpr);
      const w = Math.max(1, Math.round((box.width - 4) * dpr));
      const h = Math.max(1, Math.round((box.height - 2) * dpr));
      if (x < 0 || y < 0 || x + w > canvas.width || y + h > canvas.height) continue;
      const data = ctx.getImageData(x, y, w, h).data;
      for (let i = 0; i < data.length; i += 4) {
        // A stripe pixel: rgba(255,255,255,0.55) blended over the bar fill lands well above the
        // stock bar blue in every channel; 200 per channel is far from both the fill and the
        // progress overlay but below pure page white (the scan stays inside the bar box).
        if ((data[i] ?? 0) > 200 && (data[i + 1] ?? 0) > 200 && (data[i + 2] ?? 0) > 200) {
          return true;
        }
      }
    }
    return false;
  }, PANE);

  expect(found, "a near-white diagonal-stripe pixel inside the docs bar").toBe(true);
});
