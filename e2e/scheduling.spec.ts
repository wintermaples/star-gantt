import { expect, test } from "./_fixtures";
import { FIXED_TIME, settle } from "./_fixtures";
import type { Page } from "@playwright/test";

// E2E for examples/scheduling.html: the scheduling wiring (dependency links, the auto-scheduling
// engine, working calendars, critical-path analysis, schedule diagnostics), composed with
// `presetStandard()` and exercised through real pointer/keyboard gestures wherever the feature has
// one. Links/ports paint as canvas (no per-link DOM node to click), so dependency-line assertions
// here are canvas pixel probes at computed anchor positions rather than DOM locators. Bars ALSO
// paint on the same canvas band as links (view.md's zIndex→canvas banding puts anything under 100
// on the `"main"` layer, and task-bars is 60), so every pixel probe below targets a point with
// real geometric clearance from both endpoints' bars (never a bare "some pixel changed near the
// ports" check) and, where the point is genuinely ambiguous, is paired with a negative control
// that removes the specific thing being probed for and re-probes the identical point (the original
// spec→impl midpoint sat inside the two adjacent bars' combined footprint and stayed "painted"
// even with every link deleted).
//
// Explicitly out of scope here: pulling a task BACK on an earlier move (every scenario below only
// drags/edits forward — a full pull-back suite belongs with the interaction snap/align
// follow-ups); `schedule/reschedule`'s preview-then-apply pairing (`previewReschedule` vs. the
// command's actual apply — headless already, and covered by the package's own unit tests);
// `snap/pushGuards` stand-down interaction with `pushSuccessors` while `autoSchedule.enabled` is
// `false` (this file's example always composes propagation ON); and a pixel-level critical-path
// recolor assertion (bar outline / warning-glyph color changes on classification — this file
// verifies classification through `CriticalPathService` only, not the paint).
//
// Every assertion below is DOM/behavioral/pixel-probe (no committed screenshot baseline needed for
// them). The one screenshot assertion, in the "display" describe block, is deliberately left
// WITHOUT a baseline — Playwright's own "no baseline" failure is expected there; baselines are
// regenerated after a visual review (CLAUDE.md §7). Nothing here runs `--update-snapshots`.

const DAY_MS = 86_400_000;
const CONTAINER = "#chart";
// scheduling/src/internal/links/geometry.ts PORT_GAP (9) + PORT_RADIUS (4) — a port disc's centre
// sits this many CSS px outward from the bar edge it belongs to. Restated here only for pixel
// math (computing where a real pointer gesture must land), never as a second source of truth for
// the plugin's own geometry.
const PORT_OFFSET = 13;

declare const gantt: {
  dispatch<K extends string>(cmd: K, payload: unknown): void;
  on(event: string, handler: (e: any) => void): () => void;
  dispose(): void;
  service(key: "stargantt.data"): {
    getTask(id: string): { id: string; name: string; start: number; end: number } | undefined;
    load(data: unknown): void;
    links: {
      get(): Map<string, { id: string; sourceId: string; targetId: string; type: string; lag?: number }>;
    };
  };
  service(key: "stargantt.history"): {
    state: { get(): { canUndo: boolean; canRedo: boolean; depth: number } };
    undo(): void;
    redo(): void;
  };
  service(key: "stargantt.timeline"): {
    pxPerMs: number;
  };
  service(key: "stargantt.task-bars"): {
    barBoxOf(id: string): { x: number; y: number; width: number; height: number } | undefined;
  };
  service(key: "stargantt.rows"): {
    rowOf(id: string): number | undefined;
  };
  service(key: "stargantt.scheduler"): {
    propagationEnabled(): boolean;
  };
  service(key: "stargantt.critical-path"): {
    criticalityOf(id: string): string | undefined;
  };
  service(key: "stargantt.focus"): {
    state: { get(): { focused: string | undefined } };
  };
};

/** The chart body's own client rect — see e2e/interaction.spec.ts's `chartBodyBox` for why the
 *  canvas box, not the pane container's, is the coordinate origin. */
async function chartBodyBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator(".sg-pane--chart canvas.sg-layer").first().boundingBox();
  if (box === null) throw new Error("chart body canvas not found");
  return box;
}

interface Point {
  x: number;
  y: number;
}

/** Page-absolute centre of a task's bar, plus its right edge and CSS px per calendar day. */
interface BarGeometry extends Point {
  right: number;
  pxPerDay: number;
}

async function barGeometry(page: Page, taskId: string): Promise<BarGeometry> {
  const pane = await chartBodyBox(page);
  const box = await page.evaluate((id) => {
    const b = gantt.service("stargantt.task-bars").barBoxOf(id);
    if (b === undefined) return null;
    const pxPerDay = gantt.service("stargantt.timeline").pxPerMs * 86_400_000;
    return { x: b.x, y: b.y, width: b.width, height: b.height, pxPerDay };
  }, taskId);
  if (box === null) throw new Error(`no visible bar for task "${taskId}"`);
  return {
    x: pane.x + box.x + box.width / 2,
    y: pane.y + box.y + box.height / 2,
    right: pane.x + box.x + box.width,
    pxPerDay: box.pxPerDay,
  };
}

/** Page-absolute centre of a task's connector port (scheduling.md §5.1: `PORT_OFFSET` CSS px
 *  outward from the bar's edge, vertically centred on the bar). */
async function portCenter(page: Page, taskId: string, end: "start" | "end"): Promise<Point> {
  const pane = await chartBodyBox(page);
  const box = await page.evaluate((id) => {
    const b = gantt.service("stargantt.task-bars").barBoxOf(id);
    return b === undefined ? null : { x: b.x, y: b.y, width: b.width, height: b.height };
  }, taskId);
  if (box === null) throw new Error(`no visible bar for task "${taskId}"`);
  const x = end === "end" ? box.x + box.width + PORT_OFFSET : box.x - PORT_OFFSET;
  const y = box.y + box.height / 2;
  return { x: pane.x + x, y: pane.y + y };
}

async function taskOf(page: Page, id: string) {
  const task = await page.evaluate((taskId) => gantt.service("stargantt.data").getTask(taskId), id);
  if (task === undefined) throw new Error(`task "${id}" not found`);
  return task;
}

async function historyState(page: Page) {
  return page.evaluate(() => gantt.service("stargantt.history").state.get());
}

async function linkCount(page: Page): Promise<number> {
  return page.evaluate(() => gantt.service("stargantt.data").links.get().size);
}

async function findLink(page: Page, sourceId: string, targetId: string) {
  return page.evaluate(
    ({ sourceId, targetId }) => {
      for (const link of gantt.service("stargantt.data").links.get().values()) {
        if (link.sourceId === sourceId && link.targetId === targetId) return link;
      }
      return undefined;
    },
    { sourceId, targetId },
  );
}

/** The `.sg-grid-cell` locator for the read-only schedule-mode column (§2.4, id
 *  `"scheduling.mode"`, `autoSchedule.modeColumn: true` in examples/scheduling.html) on a task's
 *  row — `data-column-id` mirrors the header's own (tree-grid.md, "Column identification in the
 *  DOM"), and `data-row-index` addresses the row (tree-grid's virtualized slot pool). */
async function modeCell(page: Page, taskId: string) {
  const row = await page.evaluate((id) => gantt.service("stargantt.rows").rowOf(id), taskId);
  if (row === undefined) throw new Error(`task "${taskId}" has no row`);
  return page.locator(`.sg-grid-row[data-row-index="${String(row)}"] .sg-grid-cell[data-column-id="scheduling.mode"]`);
}

/** Whether the `"main"` chart-body canvas layer (view.md's zIndex→canvas banding: anything under
 *  100 — task bars at 60, dependency lines at 69, critical-link emphasis at 72, free-float bars at
 *  56 — lands there) has any non-transparent pixel in a square centred at a page-absolute point.
 *  `half` defaults small (round 1 review: an 8px half-size at a point close to two bars' edges
 *  picked up bar pixels, not link pixels — every probe below either targets a point with real
 *  clearance from both endpoints' bars, uses a tight `half`, or both). */
async function hasPaintedPixel(page: Page, center: Point, half = 3): Promise<boolean> {
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

/** Page-absolute midpoint of the straight-line route between two tasks' facing ports — under
 *  examples/scheduling.html's `dependencies.routingStyle: "straight"` override this is a real
 *  point ON the route; it also doubles as a geometry reference in the elbow-routing test below
 *  (task bar positions are unaffected by routing style, so it addresses the same content there
 *  too). */
async function routeMidpoint(
  page: Page,
  sourceId: string,
  sourceEnd: "start" | "end",
  targetId: string,
  targetEnd: "start" | "end",
): Promise<Point> {
  const source = await portCenter(page, sourceId, sourceEnd);
  const target = await portCenter(page, targetId, targetEnd);
  return { x: (source.x + target.x) / 2, y: (source.y + target.y) / 2 };
}

async function bootScheduling(page: Page, openExample: import("./_fixtures").OpenExample): Promise<void> {
  await openExample("scheduling.html", { ready: `${CONTAINER} canvas`, fixedTime: FIXED_TIME });
  await settle(page);
  // The row model and bar geometry are only correct once the loaded dataset has reached the store
  // and painted — the same readiness gate e2e/interaction.spec.ts's `bootInteraction` uses.
  await expect.poll(async () => taskOf(page, "spec").then((t) => t.name)).toBe("Design");
}

test.describe("dependency links: rendering, creation, selection", () => {
  test("l6 (pred → succ) dependency line paints on the main canvas; removing the link clears exactly that point", async ({
    page,
    openExample,
  }) => {
    await bootScheduling(page, openExample);
    // "pred" (row 8) and "succ" (row 9) sit two rows apart with a real 2-day (l6's lag) horizontal
    // gap between pred's end port and succ's start port, so this midpoint has genuine clearance
    // from both bars — the fix for the round-1 blocker, which used the touching spec/impl pair.
    const mid = await routeMidpoint(page, "pred", "end", "succ", "start");
    expect(await hasPaintedPixel(page, mid)).toBe(true);

    // Discriminating negative control (round 1 review): the SAME point, with the line itself
    // removed. A corner-of-the-chart negative control would not have caught the original bug (it
    // would still pass even though the "positive" probe was reading bar pixels, not line pixels);
    // re-probing the identical coordinates after deleting the one thing that could paint there
    // does.
    await page.evaluate(() => gantt.dispatch("link/remove", { ids: ["l6"] }));
    await settle(page);
    expect(await hasPaintedPixel(page, mid)).toBe(false);
  });

  test("a port drag creates a link (wk → audit) and reschedules its target, undoable", async ({ page, openExample }) => {
    await bootScheduling(page, openExample);
    expect(await findLink(page, "wk", "audit")).toBeUndefined();
    const before = await linkCount(page);
    const auditBefore = await taskOf(page, "audit");

    const source = await portCenter(page, "wk", "end");
    const target = await portCenter(page, "audit", "start");
    await page.mouse.move(source.x, source.y);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 8 });
    await page.mouse.up();
    await settle(page);

    const link = await findLink(page, "wk", "audit");
    expect(link?.type).toBe("FS");
    expect(await linkCount(page)).toBe(before + 1);

    // The new link seeds propagation from "wk" (scheduling.md §2.1 — link/add seeds the link's
    // SOURCE), pulling "audit" into the forward closure for the first time. The engine then
    // re-derives audit's placement from BOTH its incoming bounds — the pre-existing SF from "spec"
    // (endBound = T0, far too early to bind) and the new FS from "wk" (startBound = wk.end,
    // T0 + 3d) — which is exactly one day earlier than audit's own stored start (T0 + 4d), so
    // audit moves bodily one day earlier, duration preserved. This is not a violation-driven
    // nudge: the engine always re-derives a task's placement in full once it enters the closure
    // ("fixed point" placement) — verified against the real engine's output for this exact dataset
    // before being committed.
    const auditAfter = await taskOf(page, "audit");
    expect(auditAfter.start).toBe(auditBefore.start - DAY_MS);
    expect(auditAfter.end).toBe(auditBefore.end - DAY_MS);

    expect((await historyState(page)).canUndo).toBe(true);
    await page.evaluate(() => gantt.service("stargantt.history").undo());
    expect(await findLink(page, "wk", "audit")).toBeUndefined();
    expect(await linkCount(page)).toBe(before);
    const auditUndone = await taskOf(page, "audit");
    expect(auditUndone.start).toBe(auditBefore.start);
    expect(auditUndone.end).toBe(auditBefore.end);
  });

  test("a port drag onto an already-linked task adds nothing", async ({ page, openExample }) => {
    await bootScheduling(page, openExample);
    const before = await linkCount(page);

    // Positive control first: the IDENTICAL gesture mechanics on an UNLINKED pair (wk -> audit is
    // linked in the creation test, but wk -> cycB is free here) DO create a link — proving the
    // drag genuinely starts and drops, so the assertion below cannot pass on a dead gesture.
    const ctlSource = await portCenter(page, "wk", "end");
    const ctlTarget = await portCenter(page, "cycB", "start");
    await page.mouse.move(ctlSource.x, ctlSource.y);
    await page.mouse.down();
    await page.mouse.move(ctlTarget.x, ctlTarget.y, { steps: 8 });
    await page.mouse.up();
    await settle(page);
    expect(await linkCount(page)).toBe(before + 1);
    // Undo the control link so the subject assertion runs against the original graph.
    await page.evaluate(() => gantt.service("stargantt.history").undo());
    await settle(page);
    expect(await linkCount(page)).toBe(before);
    const depthAfterControl = (await historyState(page)).depth;

    // "spec" -[FS]-> "impl" already exists (link "l1"); dragging the exact same ordered pair again
    // must not create a second edge (data-store's one-link-per-ordered-pair rule, scheduling.md
    // §5.2 — "a release over ... a task the source already links to ... creates nothing").
    const source = await portCenter(page, "spec", "end");
    const target = await portCenter(page, "impl", "start");
    await page.mouse.move(source.x, source.y);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 8 });
    await page.mouse.up();
    await settle(page);

    expect(await linkCount(page)).toBe(before);
    expect((await historyState(page)).depth).toBe(depthAfterControl);
  });

  test("Escape mid-drag abandons a port drag: no link created, no history entry", async ({ page, openExample }) => {
    await bootScheduling(page, openExample);
    const before = await linkCount(page);
    const depthBefore = (await historyState(page)).depth;

    const source = await portCenter(page, "pred", "end");
    const target = await portCenter(page, "cycA", "start");
    await page.mouse.move(source.x, source.y);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 4 });
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await settle(page);

    expect(await linkCount(page)).toBe(before);
    expect((await historyState(page)).depth).toBe(depthBefore);
  });

  test("clicking a link selects it; Delete removes it; Ctrl+Z restores it", async ({ page, openExample }) => {
    await bootScheduling(page, openExample);
    expect(await findLink(page, "spec", "impl")).toBeDefined();
    const before = await linkCount(page);
    const mid = await routeMidpoint(page, "spec", "end", "impl", "start");

    await page.mouse.click(mid.x, mid.y);
    await page.keyboard.press("Delete");
    await settle(page);

    expect(await findLink(page, "spec", "impl")).toBeUndefined();
    expect(await linkCount(page)).toBe(before - 1);
    expect((await historyState(page)).canUndo).toBe(true);

    await page.evaluate(() => gantt.service("stargantt.history").undo());
    expect(await findLink(page, "spec", "impl")).toBeDefined();
    expect(await linkCount(page)).toBe(before);
  });

  test("Alt+L two-step keyboard chord creates a link (spec → wk)", async ({ page, openExample }) => {
    await bootScheduling(page, openExample);
    const before = await linkCount(page);

    // The mirror's first row is the root summary; ArrowDown once reaches "spec".
    const rootRow = page.locator(".sg-a11y-row").first();
    await rootRow.focus();
    await page.keyboard.press("ArrowDown");
    await expect
      .poll(() => page.evaluate(() => gantt.service("stargantt.focus").state.get().focused))
      .toBe("spec");

    await page.keyboard.press("Alt+l");
    await settle(page);

    // Dataset row order: root, spec, impl, qa, ship, audit, cycA, cycB, pred, succ, wk — nine more
    // ArrowDown presses from "spec" reach "wk", the last row.
    for (let i = 0; i < 9; i++) await page.keyboard.press("ArrowDown");
    await expect
      .poll(() => page.evaluate(() => gantt.service("stargantt.focus").state.get().focused))
      .toBe("wk");

    await page.keyboard.press("Alt+l");
    await settle(page);

    const link = await findLink(page, "spec", "wk");
    expect(link?.type).toBe("FS");
    expect(await linkCount(page)).toBe(before + 1);
  });
});

test.describe("dependency links: routing style", () => {
  test("elbow routing (the plugin's default) draws a different route than the example's straight override", async ({
    page,
    openExample,
  }) => {
    await bootScheduling(page, openExample);
    const mid = await routeMidpoint(page, "pred", "end", "succ", "start");
    // Under the example's own "straight" override this exact point sits on the anchor-to-anchor
    // diagonal (the same point the rendering test above probes).
    expect(await hasPaintedPixel(page, mid)).toBe(true);

    // A second navigation to the SAME dataset and container, with `?routing=elbow`
    // (examples/scheduling.html — the plugin's own default, "elbow", orthogonal segments,
    // scheduling.md §5.3) the only difference from the default page's deliberate "straight"
    // override. A fresh `page.goto` isolates the routing option without disturbing the
    // manually-reviewed default page. Task bar positions are unaffected by routing style, so
    // `mid`, computed against the first page load, still addresses the same content on the second.
    await openExample("scheduling.html?routing=elbow", { ready: `${CONTAINER} canvas`, fixedTime: FIXED_TIME });
    await settle(page);
    await expect.poll(async () => taskOf(page, "spec").then((t) => t.name)).toBe("Design");

    // Elbow routes are orthogonal (horizontal/vertical runs meeting at right angles) and never
    // draw through the anchor-to-anchor diagonal a straight route does, so the SAME point clears —
    // and the vertical elbow channel paints just to its right (the route moved, it did not vanish).
    expect(await hasPaintedPixel(page, mid)).toBe(false);
    expect(await hasPaintedPixel(page, { x: mid.x + 11, y: mid.y })).toBe(true);
  });
});

test.describe("auto-scheduling", () => {
  test("moving a predecessor propagates to its successor, honoring the FS lag", async ({ page, openExample }) => {
    await bootScheduling(page, openExample);
    expect(await page.evaluate(() => gantt.service("stargantt.scheduler").propagationEnabled())).toBe(true);

    const predBefore = await taskOf(page, "pred");
    const succBefore = await taskOf(page, "succ");
    const succDuration = succBefore.end - succBefore.start;

    const geo = await barGeometry(page, "pred");
    await page.mouse.move(geo.x, geo.y);
    await page.mouse.down();
    // +2 days lands "pred"'s start on the Friday of the following week (T0 is pinned to a Friday —
    // see FIXED_TIME/examples/scheduling.html), a working day under the "std" calendar, so no
    // working-time snap correction applies and the arithmetic below is exact.
    await page.mouse.move(geo.x + geo.pxPerDay * 2, geo.y, { steps: 8 });
    await page.mouse.up();
    await settle(page);

    const predAfter = await taskOf(page, "pred");
    const succAfter = await taskOf(page, "succ");
    expect(predAfter.start).toBe(predBefore.start + 2 * DAY_MS);
    // FS + a 2-day lag (link "l6"): the successor starts exactly `lag` after the predecessor ends.
    expect(succAfter.start).toBe(predAfter.end + 2 * DAY_MS);
    expect(succAfter.end - succAfter.start).toBe(succDuration);
    expect((await historyState(page)).canUndo).toBe(true);

    await page.evaluate(() => gantt.service("stargantt.history").undo());
    const predUndone = await taskOf(page, "pred");
    const succUndone = await taskOf(page, "succ");
    expect(predUndone.start).toBe(predBefore.start);
    expect(succUndone.start).toBe(succBefore.start);
  });

  test("moving a mid-chain task leaves its predecessor untouched (forward-only propagation)", async ({
    page,
    openExample,
  }) => {
    await bootScheduling(page, openExample);
    const specBefore = await taskOf(page, "spec");
    const implBefore = await taskOf(page, "impl");
    const qaBefore = await taskOf(page, "qa");

    const geo = await barGeometry(page, "impl");
    await page.mouse.move(geo.x, geo.y);
    await page.mouse.down();
    await page.mouse.move(geo.x + geo.pxPerDay * 2, geo.y, { steps: 8 });
    await page.mouse.up();
    await settle(page);

    const implAfter = await taskOf(page, "impl");
    expect(implAfter.start).toBe(implBefore.start + 2 * DAY_MS);

    // Forward-only propagation (scheduling.md §2.1): the engine never reaches backward to a moved
    // task's own predecessor, however far downstream the edit's effects travel.
    const specAfter = await taskOf(page, "spec");
    expect(specAfter.start).toBe(specBefore.start);
    expect(specAfter.end).toBe(specBefore.end);

    // Downstream DOES move: "qa" enters the forward closure through "impl" -[SS, lag 1d]-> "qa"
    // (link "l2") and is re-derived exactly from that bound, whatever slack it held before —
    // verified against the real engine's output for this exact dataset before being committed.
    const qaAfter = await taskOf(page, "qa");
    expect(qaAfter.start).toBe(implAfter.start + DAY_MS);
    expect(qaAfter.end - qaAfter.start).toBe(qaBefore.end - qaBefore.start);
  });

  test("dragging the qa end handle re-times ship (downstream via FF); impl (upstream) is untouched", async ({
    page,
    openExample,
  }) => {
    await bootScheduling(page, openExample);
    const qaBefore = await taskOf(page, "qa");
    const implBefore = await taskOf(page, "impl");

    const geo = await barGeometry(page, "qa");
    const handleX = geo.right - 2; // well inside the 6px end handle (task-bars HANDLE_WIDTH)
    await page.mouse.move(handleX, geo.y);
    await page.mouse.down();
    await page.mouse.move(handleX + geo.pxPerDay * 2, geo.y, { steps: 8 });
    await page.mouse.up();
    await settle(page);

    const qaAfter = await taskOf(page, "qa");
    expect(qaAfter.start).toBe(qaBefore.start);
    expect(qaAfter.end).toBe(qaBefore.end + 2 * DAY_MS);

    // Downstream via the tight FF ("l3", lag 0): ship's end tracks qa's new end exactly.
    const shipAfter = await taskOf(page, "ship");
    expect(shipAfter.end).toBe(qaAfter.end);
    expect(shipAfter.start).toBe(shipAfter.end); // still a zero-duration milestone

    // Upstream is untouched: "impl" feeds qa via SS (which reads impl.START — this resize never
    // touches it), and forward-only propagation never reaches backward regardless.
    const implAfter = await taskOf(page, "impl");
    expect(implAfter.start).toBe(implBefore.start);
    expect(implAfter.end).toBe(implBefore.end);
  });

  test("a link/add that would close a cycle is rejected: schedule/cycleRejected fires with the chain, no link created, no history entry", async ({
    page,
    openExample,
  }) => {
    await bootScheduling(page, openExample);
    const existing = await findLink(page, "cycA", "cycB");
    expect(existing).toBeDefined();
    const before = await linkCount(page);
    const depthBefore = (await historyState(page)).depth;

    const payload = await page.evaluate(() => {
      let seen: { chain: readonly string[] } | undefined;
      gantt.on("schedule/cycleRejected", (e) => {
        seen = { chain: (e.chain as unknown[]).map(String) };
      });
      // cycA -> cycB already exists (link "l5"); the reverse edge would close a 2-node cycle.
      gantt.dispatch("link/add", { sourceId: "cycB", targetId: "cycA", type: "FS" });
      return seen;
    });

    expect(payload).toBeDefined();
    expect(payload?.chain).toContain(existing!.id);
    expect(await findLink(page, "cycB", "cycA")).toBeUndefined();
    expect(await linkCount(page)).toBe(before);
    expect((await historyState(page)).depth).toBe(depthBefore);
  });

  test("cycle rejection via a real port drag: dragging cycB → cycA is refused", async ({ page, openExample }) => {
    await bootScheduling(page, openExample);
    const before = await linkCount(page);
    const depthBefore = (await historyState(page)).depth;

    await page.evaluate(() => {
      (window as unknown as { __cycleRejections: unknown[] }).__cycleRejections = [];
      gantt.on("schedule/cycleRejected", (e) => {
        (window as unknown as { __cycleRejections: unknown[] }).__cycleRejections.push(
          (e.chain as unknown[]).map(String),
        );
      });
    });

    // cycA -> cycB already exists ("l5"); a real port drag the reverse direction is refused the
    // same way the dispatched-payload test above proves at the API level — this proves the SAME
    // rejection is reachable from the actual pointer gesture a user would perform, not merely a
    // hand-built payload.
    const source = await portCenter(page, "cycB", "end");
    const target = await portCenter(page, "cycA", "start");
    await page.mouse.move(source.x, source.y);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 8 });
    await page.mouse.up();
    await settle(page);

    const rejections = await page.evaluate(
      () => (window as unknown as { __cycleRejections: unknown[] }).__cycleRejections,
    );
    expect(rejections).toHaveLength(1);
    expect(await findLink(page, "cycB", "cycA")).toBeUndefined();
    expect(await linkCount(page)).toBe(before);
    expect((await historyState(page)).depth).toBe(depthBefore);
  });
});

test.describe("schedule modes", () => {
  test("pinning a task to manual scheduling exempts it from propagation; the mode column reflects it", async ({
    page,
    openExample,
  }) => {
    await bootScheduling(page, openExample);
    await expect(await modeCell(page, "succ")).toHaveText("Auto");

    await page.evaluate(() => gantt.dispatch("schedule/setTaskMode", { id: "succ", mode: "manual" }));
    await settle(page);
    await expect(await modeCell(page, "succ")).toHaveText("Manual");

    const succBefore = await taskOf(page, "succ");
    const predBefore = await taskOf(page, "pred");
    const geo = await barGeometry(page, "pred");
    await page.mouse.move(geo.x, geo.y);
    await page.mouse.down();
    await page.mouse.move(geo.x + geo.pxPerDay * 2, geo.y, { steps: 8 });
    await page.mouse.up();
    await settle(page);

    // Positive control: the drag itself really moved the predecessor (+2 days) — so the frozen
    // successor below is the pin at work, not a dead gesture.
    const predAfter = await taskOf(page, "pred");
    expect(predAfter.start).toBe(predBefore.start + 2 * DAY_MS);

    // "succ" is manually scheduled: it still participates as a fixed predecessor to anything
    // downstream of it (nothing, here) but is never itself moved by the engine (scheduling.md
    // §2.4) — the same predecessor edit the "honoring the FS lag" test above shows propagating
    // normally is a no-op on "succ" once pinned.
    const succAfter = await taskOf(page, "succ");
    expect(succAfter.start).toBe(succBefore.start);
    expect(succAfter.end).toBe(succBefore.end);
  });
});

test.describe("working calendar", () => {
  test("dragging a task onto a non-working day snaps it to the nearest working boundary", async ({
    page,
    openExample,
  }) => {
    await bootScheduling(page, openExample);
    const before = await taskOf(page, "wk"); // Friday .. Monday (T0 .. T0 + 3d)
    const duration = before.end - before.start;

    const geo = await barGeometry(page, "wk");
    await page.mouse.move(geo.x, geo.y);
    await page.mouse.down();
    // +2 days lands the raw (day-rounded) start on Sunday (T0 + 2d). With `snap.workingDays` on
    // and the "std" calendar's Sat/Sun off, Sunday 00:00 is not accepted in place, and both the
    // forward walk (Monday, T0 + 3d) and the backward walk (Saturday, T0 + 2d exactly — the close
    // of Friday's working day) are one day away; the tie resolves FORWARD
    // (interaction/src/internal/snap/working-time.ts), landing on Monday, not the raw Sunday drop.
    await page.mouse.move(geo.x + geo.pxPerDay * 2, geo.y, { steps: 8 });
    await page.mouse.up();
    await settle(page);

    const after = await taskOf(page, "wk");
    expect(after.start).toBe(before.start + 3 * DAY_MS);
    expect(after.end - after.start).toBe(duration);
  });
});

test.describe("critical path", () => {
  test("the zero-float chain is reported critical, and an edit that opens float declassifies it", async ({
    page,
    openExample,
  }) => {
    await bootScheduling(page, openExample);
    const criticalityOf = (id: string): Promise<string | undefined> =>
      page.evaluate((taskId) => gantt.service("stargantt.critical-path").criticalityOf(taskId), id);

    // qa -[FF]-> ship is the tight link reaching the project finish (ship, T0 + 11d — the largest
    // end among every non-summary task in the base dataset): qa.end + 0 lag == ship.end exactly,
    // so both have zero total float (scheduling.md §7.2, thresholdDays 0 — the example's default).
    // spec and impl are NOT on this critical chain despite feeding it: link "l2" (impl -[SS, lag
    // 1d]-> qa) is loose — impl.start + 1d == T0 + 4d, four days before qa's actual start (T0 +
    // 8d) — so impl (and, through the tight FS "l1", spec) carry that same 4-day slack as real
    // float. This is the CPM math working correctly, not a dataset bug: a chain is only as
    // critical as its tightest link.
    for (const id of ["qa", "ship"]) {
      expect(await criticalityOf(id), `criticality of "${id}"`).toBe("critical");
    }
    for (const id of ["spec", "impl"]) {
      expect(await criticalityOf(id), `criticality of "${id}"`).toBeUndefined();
    }

    // "succ" carries no outgoing link, so extending it propagates nowhere else — it only pushes
    // the project finish past "ship", which is exactly what opens float on the qa/ship chain and
    // declassifies it.
    await page.evaluate(() => {
      const succ = gantt.service("stargantt.data").getTask("succ")!;
      gantt.dispatch("task/update", { id: "succ", after: { end: succ.end + 5 * 86_400_000 } });
    });
    await settle(page);

    expect(await criticalityOf("ship")).not.toBe("critical");
    expect(await criticalityOf("qa")).not.toBe("critical");
  });
});

test.describe("schedule diagnostics", () => {
  test("the panel reports the one orphaned task (the unlinked \"Weekend Task\")", async ({ page, openExample }) => {
    await bootScheduling(page, openExample);
    const button = page.locator(".sg-diagnostics-button");
    await expect(button).toHaveText("Diagnostics (1)");

    await button.click();
    const panel = page.locator(".sg-diagnostics-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Weekend Task");
  });
});

/**
 * Simulates the perf chain's own placement rule (scheduling.md §2.1/§2.2 — a start bound is landed
 * forward past non-working days via `nextWorkingTime`, which applies even for a calendar with no
 * declared working hours — engine/engine.ts `placeFromStart`) over `count` FS-linked, zero-lag,
 * one-day tasks anchored at `start0`, so the perf test's post-condition below is a real computed
 * value derived from the dataset's own shape, never a hardcoded magic number. Cross-checked against
 * the real engine's actual output for this exact 10k-task chain before being committed.
 */
function simulateFsChain(start0: number, count: number, isWorkingDay: (t: number) => boolean): number {
  let start = start0;
  for (let i = 0; i < count; i++) {
    let candidate = start + DAY_MS;
    while (!isWorkingDay(candidate)) candidate += DAY_MS;
    start = candidate;
  }
  return start;
}

/** The "std" calendar's working-day rule (examples/scheduling.html: `workingDays: [1,2,3,4,5]`). */
function isMonToFriUtc(t: number): boolean {
  const day = new Date(t).getUTCDay();
  return day >= 1 && day <= 5;
}

test.describe("performance: 10k-task reschedule", () => {
  // Step 4 of this task: propagating one predecessor move across a 10k-task FS chain. The bound
  // below is deliberately loose (CLAUDE.md §7 — a loose green bound is not proof of hitting a real
  // target, only of not regressing far past it); the measured value is always logged. This
  // measures the ENGINE's propagation cost only, not paint: `examples/scheduling.html`'s chain
  // dataset is 10,001 rows tall in a ~480px viewport, so task-bars' own row-virtualization culls
  // all but a small visible slice — repainting after the move is comparatively cheap and is not
  // what the number below reflects.
  test("propagating a predecessor move across a 10k-task chain stays within a lenient budget", async ({
    page,
    openExample,
  }) => {
    await openExample("scheduling.html?tasks=10000", { ready: `${CONTAINER} canvas`, fixedTime: FIXED_TIME });
    await expect
      .poll(async () => page.evaluate(() => gantt.service("stargantt.data").getTask("c9999")?.name))
      .toBe("Task 10000");

    // The dispatch is synchronous end to end (the will-hook that runs propagation, the effort
    // follow-ons, and the store apply all happen inside this one call), so bracketing it with
    // `performance.now()` measures the whole reschedule, chain included.
    const elapsedMs = await page.evaluate(() => {
      const start = performance.now();
      gantt.dispatch("task/move", { id: "c0", start: 0, end: 86_400_000 });
      return performance.now() - start;
    });

    // eslint-disable-next-line no-console -- deliberate: the measured value is part of this test's deliverable
    console.log(`[perf] scheduling: 10,000-task chain reschedule took ${elapsedMs.toFixed(1)}ms`);

    // Post-condition: the chain actually propagated all the way to c9999, to the EXACT instant the
    // engine's own placement rule computes — not merely "> 0", which the pre-move dataset already
    // satisfies (T0 is "today", far past epoch 0) and would pass even if propagation silently did
    // nothing at all.
    const expectedC9999Start = simulateFsChain(0, 9999, isMonToFriUtc);
    expect(await page.evaluate(() => gantt.service("stargantt.data").getTask("c9999")?.start)).toBe(
      expectedC9999Start,
    );

    expect(elapsedMs).toBeLessThan(2000);
  });
});

test.describe("display", () => {
  // Deliberately no committed baseline (see the file header): expect Playwright's own
  // "no baseline"/"Snapshot doesn't exist" failure here, not a pass. Do not generate one with
  // `--update-snapshots`; baselines are regenerated only after a visual review.
  test("initial render of scheduling.html matches a baseline (none committed yet)", async ({ page, openExample }) => {
    await bootScheduling(page, openExample);
    await expect(page).toHaveScreenshot("scheduling.png", {
      animations: "disabled",
      maxDiffPixelRatio: 0.002,
    });
  });
});
