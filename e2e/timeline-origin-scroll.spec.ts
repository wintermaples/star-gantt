import { expect, settle, test } from "./_fixtures";
import type { OpenExample } from "./_fixtures";
import type { Page } from "@playwright/test";

// Feature E2E: horizontal timeline scrolling with Shift+wheel (docs/specs/plugins/view.md §3
// scroll input) and the origin extension that follows a drag rather than a commit
// (docs/specs/plugins/view.md `requestOriginExtension`/`releaseOriginExtension`).
//
// Both need a real browser for the same reason: the fake DOM decides nothing here. Shift+wheel is
// about how an engine *dispatches* a wheel notch — the modifier arrives with the delta still on
// `deltaY`, and only a real engine can say so — and the deferred retraction is about a real timer
// running against a real store while a real pointer is down. Neither `stargantt.view`'s scroll nor
// `stargantt.timeline`'s origin-extension pair is exercised anywhere else in the E2E suite.

const DAY_MS = 86_400_000;
const PANE = ".sg-pane--chart";

/**
 * Whether the drag ghost (`packages/plugins/interaction/src/internal/gesture/ghost.ts`, the
 * `renderer/layers` overlay contribution) is currently painted on the chart's overlay canvas —
 * proof a date-edit drag is genuinely active, independent of the `dragTooltip`/`liveUpdate` config
 * (the ghost "is drawn regardless", per that file's `bar-drag.ts` caller). Samples the overlay
 * layer (the third `canvas.sg-layer`, confirmed against `readonly.spec.ts`'s
 * background/main/overlay count) for the ghost's fill token default, `rgba(15, 118, 110, 0.28)`
 * (`GHOST_FILL` in ghost.ts) blended over the background: R held down while G and B both rise and
 * stay close to each other — a signature that (empirically verified against this exact page, no
 * false positives at rest) never otherwise appears on that layer. A loose tolerance band, not an
 * exact-token match: the actual paint blends the token's alpha over whatever's beneath it, and a
 * chart-native `stargantt.view.theme` override could shift it slightly without changing the fact
 * that it is still an outlying teal, not any of this page's task-bar hues.
 */
async function hasGhostPixels(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const layers = document.querySelectorAll(".sg-pane--chart canvas.sg-layer");
    const overlay = layers[layers.length - 1] as HTMLCanvasElement | undefined;
    if (overlay === undefined) return false;
    const ctx = overlay.getContext("2d");
    if (ctx === null) return false;
    const data = ctx.getImageData(0, 0, overlay.width, overlay.height).data;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      const a = data[i + 3]!;
      if (a === 0) continue;
      if (Math.abs(g - b) < 15 && g - r > 40 && b - r > 30) return true;
    }
    return false;
  });
}

/** Both examples/hello.html and examples/file-io.html assign `window.gantt = gantt`, and the
 *  demo's own top-level `const gantt` is also visible to `page.evaluate` by name (unqualified
 *  identifier lookup checks the global object too). */
declare const gantt: {
  service(key: "stargantt.data"): {
    taskIds(): Iterable<string | number>;
    getTask(
      id: string | number,
    ): { id: string | number; start: number; end: number; type?: string } | undefined;
  };
  service(key: "stargantt.timeline"): {
    setZoomLevel(id: string, anchorTime?: number): void;
    xToT(x: number): number;
    tToX(t: number): number;
    requestOriginExtension(t: number): void;
    releaseOriginExtension(): void;
  };
  service(key: "stargantt.task-bars"): {
    barBoxOf(id: string | number): { x: number; y: number; width: number; height: number } | undefined;
  };
  service(key: "stargantt.view"): {
    viewport: { get(): { scrollLeft: number; scrollTop: number; width: number; height: number } };
    scrollTo(target: { scrollLeft?: number; scrollTop?: number }): void;
  };
};

interface Scroll {
  scrollLeft: number;
  scrollTop: number;
}

async function scrollOf(page: Page): Promise<Scroll> {
  return page.evaluate(() => {
    const vp = gantt.service("stargantt.view").viewport.get();
    return { scrollLeft: vp.scrollLeft, scrollTop: vp.scrollTop };
  });
}

/** The instant the axis currently begins at. */
async function originOf(page: Page): Promise<number> {
  return page.evaluate(() => gantt.service("stargantt.timeline").xToT(0));
}

/** Puts the pointer over the middle of the chart pane, where the wheel handler lives. */
async function hoverChart(page: Page): Promise<void> {
  const pane = page.locator(PANE);
  await expect(pane).toBeVisible();
  const box = await pane.boundingBox();
  if (!box) throw new Error("the chart pane has no box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

test.describe("Shift+wheel scrolls the timeline horizontally", () => {
  test.use({ viewport: { width: 1200, height: 800 } });

  /** Opens the chart at the densest built-in level, so the content overflows horizontally. */
  async function openWide(page: Page, openExample: OpenExample): Promise<void> {
    await openExample("hello.html", { ready: `${PANE} canvas`, settle: true });
    await page.evaluate(() => gantt.service("stargantt.timeline").setZoomLevel("hour"));
    await hoverChart(page);
  }

  test("a Shift+wheel notch moves the view sideways, not down", async ({ page, openExample }) => {
    await openWide(page, openExample);
    const before = await scrollOf(page);

    await page.keyboard.down("Shift");
    await page.mouse.wheel(0, 400);
    await page.keyboard.up("Shift");

    await expect.poll(async () => (await scrollOf(page)).scrollLeft).toBeGreaterThan(before.scrollLeft);
    // The whole point: the notch went to the other axis, so the rows did not move.
    expect((await scrollOf(page)).scrollTop).toBe(before.scrollTop);
  });

  test("the same notch without Shift leaves the timeline where it was", async ({ page, openExample }) => {
    await openWide(page, openExample);
    const before = await scrollOf(page);

    // Positive control: `expect.poll(scrollLeft).toBe(before.scrollLeft)` is true trivially at
    // t=0, before `page.mouse.wheel()`'s synthesized event has even reached the page — a poll
    // whose very first check already satisfies the assertion proves nothing about whether the
    // notch was actually delivered and handled. hello.html doesn't have enough rows for the
    // vertical axis to guarantee an observable scrollTop change either (the comment this replaces
    // said so), so that can't serve as the control. Instead, a bubble-phase listener added AFTER
    // the pane's own wheel handler (packages/plugins/view/src/internal/render/index.ts's `listen`
    // call) fires only once that handler has already run its synchronous `setScroll` — same
    // element, same phase, so same-element listeners run in registration order — which is a real
    // proof of delivery-and-handling, not a race against it.
    await page.evaluate(() => {
      const pane = document.querySelector(".sg-pane--chart");
      if (pane === null) throw new Error(".sg-pane--chart missing");
      (window as unknown as { __wheelSeen: boolean }).__wheelSeen = false;
      pane.addEventListener(
        "wheel",
        () => {
          (window as unknown as { __wheelSeen: boolean }).__wheelSeen = true;
        },
        { once: true },
      );
    });

    await page.mouse.wheel(0, 400);

    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __wheelSeen: boolean }).__wheelSeen))
      .toBe(true);

    // Only now — with delivery-and-handling proven, and `setScroll` synchronous within the wheel
    // handler (no rAF deferral for the viewport store, unlike the canvas repaint) — is a plain read
    // meaningful. The whole point: an unmodified notch is never horizontal.
    expect((await scrollOf(page)).scrollLeft).toBe(before.scrollLeft);
  });

  test("scrolling back past the start clamps at the left edge", async ({ page, openExample }) => {
    await openWide(page, openExample);
    await page.evaluate(() => gantt.service("stargantt.view").scrollTo({ scrollLeft: 300 }));

    await page.keyboard.down("Shift");
    await page.mouse.wheel(0, -5000);
    await page.keyboard.up("Shift");

    await expect.poll(async () => (await scrollOf(page)).scrollLeft).toBe(0);
  });
});

// examples/file-io.html composes `view: { timeline: { autoExtendOrigin: true } }` with `interaction`
// left at its `dragEdit` default (`liveUpdate: false`) — nothing reaches the store until the button
// comes up, which is the precondition the origin-extension behavior needs.
test.describe("the origin follows a drag, and gives the room back", () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  async function openFileIo(page: Page, openExample: OpenExample): Promise<void> {
    await openExample("file-io.html", { ready: `${PANE} canvas`, settle: true });
    await expect.poll(async () => originOf(page).then((o) => Number.isFinite(o))).toBe(true);
  }

  async function chartBodyBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
    const box = await page.locator(`${PANE} canvas.sg-layer`).first().boundingBox();
    if (box === null) throw new Error("chart body canvas not found");
    return box;
  }

  /**
   * A press point on the body of the earliest **leaf** bar, and the pane's left edge to drag it to.
   *
   * The earliest task overall is the file-io fixture's summary root, whose dates are derived and
   * which therefore starts no date drag at all; the earliest leaf begins the same day, so it is
   * pinned to the axis's left edge just the same. The press sits near the bar's trailing end so the
   * pointer has the bar's whole width to travel — the axis grows under it and the scroll is
   * compensated, so every travelled pixel is spent on the proposal rather than on the view.
   */
  async function earliestLeafBar(page: Page): Promise<{ pressX: number; pressY: number; paneLeft: number }> {
    const pane = await chartBodyBox(page);
    const id = await page.evaluate(() => {
      const data = gantt.service("stargantt.data");
      let best: { id: string | number; start: number } | undefined;
      for (const taskId of data.taskIds()) {
        const task = data.getTask(taskId);
        if (task === undefined || !Number.isFinite(task.start)) continue;
        if (task.type === "summary") continue;
        if (best === undefined || task.start < best.start) best = { id: taskId, start: task.start };
      }
      if (best === undefined) throw new Error("no leaf task with a usable start");
      return best.id;
    });
    // Stability wait: this page's very first bar geometry read (particularly right after a fresh
    // navigation) was observed to occasionally still be settling — a press computed from it can
    // miss the bar entirely, which then reads downstream as "the drag never started" (an
    // `expect.poll` timeout several steps later, far from its real cause). Two equal consecutive
    // reads, a frame apart, is the same box-stability idiom used elsewhere in this suite
    // (e2e/resources-load-chart.spec.ts's `settleLayout`) applied to a service accessor instead of
    // a DOM rect.
    const boxOf = () =>
      page.evaluate((taskId) => {
        const b = gantt.service("stargantt.task-bars").barBoxOf(taskId);
        return b === undefined ? null : `${String(b.x)},${String(b.y)},${String(b.width)},${String(b.height)}`;
      }, id);
    let previous = await boxOf();
    for (let i = 0; i < 60 && previous !== null; i += 1) {
      await settle(page);
      const current = await boxOf();
      if (current === previous) break;
      previous = current;
    }
    const box = await page.evaluate((taskId) => {
      const b = gantt.service("stargantt.task-bars").barBoxOf(taskId);
      if (b === undefined) throw new Error("the earliest leaf task has no visible bar");
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    }, id);
    return {
      // Clear of both resize handles, so this is a body move and not an end resize.
      pressX: pane.x + Math.min(box.x + box.width - 20, pane.width - 10),
      pressY: pane.y + box.y + box.height / 2,
      paneLeft: pane.x,
    };
  }

  test("extends while the button is still down, with nothing committed, and gives it back on Escape", async ({
    page,
    openExample,
  }) => {
    await openFileIo(page, openExample);
    // The chart opens scrolled; the earliest bar has to be on screen for a pointer to reach it.
    await page.evaluate(() => gantt.service("stargantt.view").scrollTo({ scrollLeft: 0 }));
    const before = await originOf(page);
    const bar = await earliestLeafBar(page);

    await page.mouse.move(bar.pressX, bar.pressY);
    await page.mouse.down();
    // `steps` interpolates real intermediate pointermove events along the path (Playwright's
    // default is a single jump with none) — a two-hop, zero-step drag was observed to
    // intermittently not register as a drag at all under `--retries=0 --workers=1`, i.e. the whole
    // gesture landed as noise the arbiter's press-vs-drag disambiguation discarded. More samples
    // make the gesture unambiguous, matching how a real pointer actually arrives.
    await page.mouse.move(bar.pressX - 8, bar.pressY, { steps: 5 });
    await page.mouse.move(bar.paneLeft + 6, bar.pressY, { steps: 10 });

    // Positive gate: proof the gesture above was recognised as a drag, asserted before polling the
    // origin — a gesture that silently failed to start fails here with a clear message instead of
    // racing the poll below (which could otherwise hang until its own timeout with no indication
    // of why). This page composes `interaction` at its default (`dragTooltip: false`), so the
    // tooltip itself isn't available as the signal here — the ghost paints unconditionally instead.
    await expect.poll(() => hasGhostPixels(page)).toBe(true);

    // Still held: `liveUpdate` is off, so this cannot have come from the store.
    await expect.poll(() => originOf(page)).toBeLessThan(before);

    // A pointer resting mid-drag must not have the axis retracted underneath it.
    const extended = await originOf(page);
    await page.waitForTimeout(500);
    expect(await originOf(page)).toBe(extended);

    await page.keyboard.press("Escape");
    await page.mouse.up();

    // The gesture wrote nothing, so the room it borrowed comes back once the chart settles.
    await expect.poll(() => originOf(page)).toBe(before);
  });

  // The drag can now reach earlier than the chart opened, so it can also finish with its own
  // result behind the viewport's left edge.
  test("leaves the committed task inside the viewport, not behind its left edge", async ({
    page,
    openExample,
  }) => {
    await openFileIo(page, openExample);
    await page.evaluate(() => gantt.service("stargantt.view").scrollTo({ scrollLeft: 0 }));
    const bar = await earliestLeafBar(page);

    await page.mouse.move(bar.pressX, bar.pressY);
    await page.mouse.down();
    // Same interpolated-steps hardening as the sibling test above — a zero-step two-hop drag was
    // observed to intermittently not register.
    await page.mouse.move(bar.pressX - 8, bar.pressY, { steps: 5 });
    await page.mouse.move(bar.paneLeft + 6, bar.pressY, { steps: 10 });
    await expect.poll(() => hasGhostPixels(page)).toBe(true);
    await page.mouse.up();

    const seen = await page.evaluate(() => {
      const data = gantt.service("stargantt.data");
      const timeline = gantt.service("stargantt.timeline");
      const vp = gantt.service("stargantt.view").viewport.get();
      let best: { id: string | number; start: number } | undefined;
      for (const id of data.taskIds()) {
        const task = data.getTask(id);
        if (task === undefined || task.type === "summary") continue;
        if (best === undefined || task.start < best.start) best = { id, start: task.start };
      }
      if (best === undefined) throw new Error("no leaf task");
      return { startX: timeline.tToX(best.start), scrollLeft: vp.scrollLeft };
    });

    // The committed start is at or after the viewport's left edge: the bar the user just dropped is
    // on screen, not off to the left of it.
    expect(seen.startX).toBeGreaterThanOrEqual(seen.scrollLeft);
  });

  test("retracts to the origin the chart was opened with, never past it", async ({ page, openExample }) => {
    await openFileIo(page, openExample);
    const before = await originOf(page);

    await page.evaluate((day) => {
      gantt.service("stargantt.timeline").requestOriginExtension(Date.now() - 400 * day);
    }, DAY_MS);
    expect(await originOf(page)).toBeLessThan(before);

    // Held: the axis stays where the caller put it for as long as the hold lasts.
    await page.waitForTimeout(500);
    expect(await originOf(page)).toBeLessThan(before);

    await page.evaluate(() => gantt.service("stargantt.timeline").releaseOriginExtension());
    // …and it stops exactly where it started: the data still reaches back that far and no further.
    await expect.poll(() => originOf(page)).toBe(before);
  });
});
