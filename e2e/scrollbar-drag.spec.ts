import { expect, test } from "./_fixtures";
import type { OpenExample } from "./_fixtures";
import type { Locator, Page } from "@playwright/test";

// E2E for examples/large-data-10k.html: the synthetic overlay scrollbars and their draggable
// thumbs (docs/specs/plugins/view.md). No overlap with the resource-plugin specs in this batch —
// this file is independent.
//
// The unit tests drive the thumb through a fake DOM, which cannot answer the question that
// matters most here: whether a real browser lets the press reach the thumb at all. Whether a
// `pointerdown` lands on `.sg-scrollbar__thumb` or falls through to the canvas underneath is
// decided by `pointer-events` and hit testing, which no DOM double reproduces. Everything below
// therefore drives real pointer input over `examples/large-data-10k.html` (10,000 rows, so both
// axes overflow) and reads the scroll position back through the public view service.
//
// DOM contract note: verified against packages/plugins/view/src/internal/render/{scrollbars,dom}.ts
// — the class names (`sg-scrollbar`, `sg-scrollbar--vertical`/`--horizontal`, `sg-scrollbar--active`,
// `sg-scrollbar__thumb`) and the track-inert/thumb-draggable `pointer-events` split. The drag itself
// is wired through native `pointerdown`/`pointermove`/`pointerup`, which Chromium synthesizes from
// `page.mouse` input.
//
// Service surface (confirmed in packages/plugins/view/src/index.ts): the view service is
// `ViewService` (`stargantt.view`), and `viewport` is a STORE property (`viewport.get()`), not a
// method call. examples/large-data-10k.html explicitly assigns `window.gantt = gantt;`, so no
// special lexical-scope handling is needed here.
//
// No screenshot assertions: this spec has no baseline image, and inventing one is out of scope
// here — every visual claim below is already a functional/DOM/geometry assertion.

declare const gantt: {
  service(key: "stargantt.view"): {
    viewport: { get(): { scrollTop: number; scrollLeft: number; width: number; height: number } };
  };
};

const VERTICAL = ".sg-scrollbar--vertical";
const HORIZONTAL = ".sg-scrollbar--horizontal";
const THUMB = ".sg-scrollbar__thumb";

interface Scroll {
  scrollTop: number;
  scrollLeft: number;
}

/** The live viewport, read through the public `stargantt.view` service. */
async function scroll(page: Page): Promise<Scroll> {
  return page.evaluate(() => {
    const vp = gantt.service("stargantt.view").viewport.get();
    return { scrollTop: vp.scrollTop, scrollLeft: vp.scrollLeft };
  });
}

/** Opens the page and loads its 10,000 tasks, so both axes overflow the viewport. */
async function open10k(page: Page, openExample: OpenExample): Promise<void> {
  await openExample("large-data-10k.html", { ready: "#chart canvas" });
  await page.click("#load10k-btn");
  await expect(page.locator("#status")).toContainText("Done:", { timeout: 60_000 });
}

/** Drags `thumb` by (dx, dy) from its centre with real pointer input. */
async function dragThumb(page: Page, thumb: Locator, dx: number, dy: number): Promise<void> {
  // The thumb is sized from the content extent the view service publishes a frame after the 10k
  // load reports "Done:", and `boundingBox()` does not wait for visibility — it just answers
  // `null`. Waiting here is what makes the measurement below mean "the thumb as the user sees it".
  await expect(thumb).toBeVisible();
  const box = await thumb.boundingBox();
  if (!box) throw new Error("the thumb has no box");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  // Two steps, so the drag looks like a drag rather than a teleport to any consumer in between.
  await page.mouse.move(x + dx / 2, y + dy / 2);
  await page.mouse.move(x + dx, y + dy);
  await page.mouse.up();
}

// `large-data-10k.html` puts its controls and status line above the chart, so with the default
// 720px-high viewport the chart pane's bottom edge — and with it the horizontal bar — sits below
// the browser viewport, where no real pointer can reach it. The taller viewport is about being
// able to aim at the bar, not about how the bar is placed.
test.use({ viewport: { width: 1280, height: 950 } });

test.describe("synthetic scrollbars", () => {
  test.setTimeout(120_000);

  test("both bars are present and the thumb — not the canvas — is under the pointer", async ({
    page,
    openExample,
  }) => {
    await open10k(page, openExample);

    await expect(page.locator(VERTICAL)).toBeVisible();
    await expect(page.locator(HORIZONTAL)).toBeVisible();

    // The track is inert and the thumb is the drag target. `elementFromPoint` is the whole
    // point — it answers with what the browser would actually deliver the press to.
    const atThumb = await page.evaluate(
      ({ thumbSelector }) => {
        const thumb = document.querySelector(thumbSelector);
        if (thumb === null) throw new Error("no vertical thumb");
        const r = thumb.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return {
          isThumb: hit === thumb,
          trackPointerEvents: getComputedStyle(thumb.parentElement as HTMLElement).pointerEvents,
          thumbPointerEvents: getComputedStyle(thumb).pointerEvents,
        };
      },
      { thumbSelector: `${VERTICAL} ${THUMB}` },
    );

    expect(atThumb.isThumb).toBe(true);
    expect(atThumb.thumbPointerEvents).toBe("auto");
    expect(atThumb.trackPointerEvents).toBe("none");
  });

  test("dragging the vertical thumb scrolls the chart down", async ({ page, openExample }) => {
    await open10k(page, openExample);
    expect((await scroll(page)).scrollTop).toBe(0);

    await dragThumb(page, page.locator(`${VERTICAL} ${THUMB}`), 0, 120);

    const after = await scroll(page);
    expect(after.scrollTop).toBeGreaterThan(0);
    // The vertical drag must not disturb the other axis.
    expect(after.scrollLeft).toBe(0);
  });

  test("dragging the vertical thumb back up returns to the top", async ({ page, openExample }) => {
    await open10k(page, openExample);
    await dragThumb(page, page.locator(`${VERTICAL} ${THUMB}`), 0, 200);
    expect((await scroll(page)).scrollTop).toBeGreaterThan(0);

    // Dragged well past the top: the clamp pins it at 0 rather than going negative.
    await dragThumb(page, page.locator(`${VERTICAL} ${THUMB}`), 0, -600);
    expect((await scroll(page)).scrollTop).toBe(0);
  });

  test("dragging the horizontal thumb scrolls the chart sideways", async ({ page, openExample }) => {
    await open10k(page, openExample);
    expect((await scroll(page)).scrollLeft).toBe(0);

    await dragThumb(page, page.locator(`${HORIZONTAL} ${THUMB}`), 150, 0);

    const after = await scroll(page);
    expect(after.scrollLeft).toBeGreaterThan(0);
    expect(after.scrollTop).toBe(0);
  });

  test("the thumb follows the wheel, and the wheel still works over the bar", async ({ page, openExample }) => {
    await open10k(page, openExample);

    const thumb = page.locator(`${VERTICAL} ${THUMB}`);
    const before = await thumb.boundingBox();
    if (!before) throw new Error("the thumb has no box");

    // The bars capture no wheel input: a wheel over the thumb scrolls the chart exactly as one
    // over the canvas does.
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.wheel(0, 1_200);
    await expect.poll(async () => (await scroll(page)).scrollTop).toBeGreaterThan(0);

    const after = await thumb.boundingBox();
    if (!after) throw new Error("the thumb has no box after the wheel");
    expect(after.y).toBeGreaterThan(before.y);
  });

  // The 8px thumb gets a 24px pointer target, and the scrollbar is an overlay that reserves
  // no layout space — so the extra 16px has to come out of the chart it floats over. This measures
  // the price rather than assuming it: the band must be wide enough to satisfy WCAG 2.2 §2.5.8, and
  // narrow enough that it is the thumb's own strip and not a dead edge along the whole chart.
  test("the thumb's pointer target is 24px, and it costs only its own strip of the chart", async ({
    page,
    openExample,
  }) => {
    await open10k(page, openExample);

    const pane = page.locator(".sg-pane--chart");
    const paneBox = await pane.boundingBox();
    if (!paneBox) throw new Error("the chart pane has no box");

    for (const axis of [VERTICAL, HORIZONTAL] as const) {
      const thumb = page.locator(`${axis} ${THUMB}`);
      const box = await thumb.boundingBox();
      if (!box) throw new Error(`the ${axis} thumb has no box`);

      // The painted thumb stays thin; what grew is the hit area, which `boundingBox` does not see.
      // Probe it instead: the point 12px inward from the thumb's centre line — inside the target,
      // outside the paint — must hit the thumb itself.
      const probe =
        axis === VERTICAL
          ? { x: box.x + box.width / 2 - 12, y: box.y + box.height / 2 }
          : { x: box.x + box.width / 2, y: box.y + box.height / 2 - 12 };
      const hit = await page.evaluate((p) => document.elementFromPoint(p.x, p.y)?.className ?? "", probe);
      expect(hit).toContain("sg-scrollbar__thumb");

      // ...and one pixel beyond the far edge of the target does not. This is what keeps the cost
      // bounded: the chart is reachable everywhere except the thumb's own band.
      const past =
        axis === VERTICAL
          ? { x: box.x + box.width / 2 - 20, y: box.y + box.height / 2 }
          : { x: box.x + box.width / 2, y: box.y + box.height / 2 - 20 };
      const beyond = await page.evaluate((p) => document.elementFromPoint(p.x, p.y)?.className ?? "", past);
      expect(beyond).not.toContain("sg-scrollbar__thumb");
    }

    // The strip belongs to the thumb, not to the edge: past the horizontal thumb's own length, the
    // bottom of the chart still answers to the canvas underneath.
    const hThumb = await page.locator(`${HORIZONTAL} ${THUMB}`).boundingBox();
    if (!hThumb) throw new Error("the horizontal thumb has no box");
    const beyondThumb = {
      x: Math.min(hThumb.x + hThumb.width + 40, paneBox.x + paneBox.width - 4),
      y: hThumb.y + hThumb.height / 2 - 8,
    };
    const atEdge = await page.evaluate((p) => document.elementFromPoint(p.x, p.y)?.className ?? "", beyondThumb);
    expect(atEdge).not.toContain("sg-scrollbar__thumb");
  });
});
