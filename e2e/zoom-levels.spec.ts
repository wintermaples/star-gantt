import { expect, test } from "./_fixtures";
import { FIXED_TIME, settle } from "./_fixtures";
import type { OpenExample } from "./_fixtures";
import type { Page } from "@playwright/test";

// Feature E2E for the built-in zoom levels (docs/specs/plugins/view.md §"stargantt.timeline" /
// packages/plugins/view/src/internal/timeline/levels.ts `defaultZoomLevels`): `hour`, `month`,
// `quarter` and `year` join the pre-existing `day` and `week` levels, each with its own two-row
// header treatment.
//
// examples/zoom-levels.html is its own page: a toolbar of zoom-level buttons, one-step zoom
// commands, five setup-time timeline options, and a live readout. The *structural* assertions
// (`assertLevelGeometry` — the level's declared pixel scale, the pixel scale the axis actually
// maps with, and the two header rows' units) run before every screenshot, so a level that reported
// its id but left the mapping (or the header composition) at the previous level's fails there even
// if the pixel diff stayed inside the ratio.
//
// Determinism: `fixedTime: FIXED_TIME` pins `Date.now()` before navigation. The page's own dataset
// is anchored on a hardcoded literal date (`Date.UTC(2026, 7, 3)`), so pinning the clock is not
// needed for the *data* — it is needed for the **today/status line** the view plugin paints from
// the real wall clock by default, which would otherwise drift a pixel column every day this suite
// runs and slowly invalidate the baselines for a reason unrelated to zoom levels.
//
// `day` and `week` are covered as non-screenshot sanity checks only: `day` is the page's own
// default and `week` is asserted structurally without minting a new image.

const CONTAINER = "#chart";
const DAY_MS = 86_400_000;

declare const gantt: {
  service(key: "stargantt.timeline"): {
    zoomLevel: { get(): { id: string; pxPerDay: number; scales: { unit: string }[] } };
    setZoomLevel(id: string, anchorTime?: number): void;
    tToX(t: number): number;
    xToT(x: number): number;
  };
  service(key: "stargantt.view"): {
    viewport: { get(): { scrollLeft: number } };
    scrollTo(target: { scrollLeft?: number }): void;
  };
  dispatch(key: "timeline/zoomIn" | "timeline/zoomOut", payload: Record<string, never>): void;
};

/** The page's own debug handle (`window.zoomLevelsDemo`, set at the end of `rebuild()`). */
declare const zoomLevelsDemo: { origin: number };

test.use({ viewport: { width: 1600, height: 1000 } });

async function openSettled(openExample: OpenExample): Promise<void> {
  await openExample("zoom-levels.html", {
    ready: `${CONTAINER} canvas`,
    fixedTime: FIXED_TIME,
    settle: true,
  });
}

/** The page's own fixed data anchor (2026-08-03 00:00 UTC), read back through its debug handle so
 *  the anchor passed to `setZoomLevel` always matches the data's own anchor. */
async function originOf(page: Page): Promise<number> {
  return page.evaluate(() => zoomLevelsDemo.origin);
}

async function setZoom(page: Page, id: string): Promise<void> {
  const t0 = await originOf(page);
  await page.evaluate(({ id, t0 }) => gantt.service("stargantt.timeline").setZoomLevel(id, t0), { id, t0 });
  await settle(page);
}

/** What the axis reports about the active level, plus the scale it actually maps time with. */
async function levelGeometry(
  page: Page,
): Promise<{ id: string; pxPerDay: number; measuredPxPerDay: number; units: string[] }> {
  const t0 = await originOf(page);
  return page.evaluate(
    ({ t0, day }) => {
      const timeline = gantt.service("stargantt.timeline");
      const level = timeline.zoomLevel.get();
      return {
        id: level.id,
        pxPerDay: level.pxPerDay,
        // The declared number is one thing; the mapping the header and the bars are drawn with is
        // another. Measuring `tToX` over exactly one day catches a level whose id changed while its
        // projection did not.
        measuredPxPerDay: timeline.tToX(t0 + day) - timeline.tToX(t0),
        units: level.scales.map((row) => row.unit),
      };
    },
    { t0, day: DAY_MS },
  );
}

/**
 * The built-in level table (packages/plugins/view/src/internal/timeline/levels.ts
 * `defaultZoomLevels`): every level is a two-row header with the coarser unit on top, and
 * `pxPerDay` is strictly decreasing across hour > day > week > month > quarter > year.
 */
const LEVELS = {
  hour: { pxPerDay: 480, units: ["day", "hour"] },
  day: { pxPerDay: 40, units: ["month", "day"] },
  week: { pxPerDay: 12, units: ["month", "week"] },
  month: { pxPerDay: 4, units: ["year", "month"] },
  quarter: { pxPerDay: 1.6, units: ["year", "month"] },
  year: { pxPerDay: 0.5, units: ["year", "year"] },
} as const;

async function assertLevelGeometry(page: Page, id: keyof typeof LEVELS): Promise<void> {
  const expected = LEVELS[id];
  const actual = await levelGeometry(page);
  expect(actual.id).toBe(id);
  expect(actual.pxPerDay).toBeCloseTo(expected.pxPerDay, 6);
  expect(actual.measuredPxPerDay).toBeCloseTo(expected.pxPerDay, 6);
  expect(actual.units).toEqual([...expected.units]);
}

const BASELINE_LEVELS = ["hour", "month", "quarter", "year"] as const;

// Baselines are this project's own renders of zoom-levels.html, regenerated only with
// `--update-snapshots=all` (see CLAUDE.md §7), after visual review. The structural geometry
// assertion runs before each screenshot so a failure names what changed.
test.describe("zoom level screenshots", () => {
  for (const id of BASELINE_LEVELS) {
    test(`zoom level "${id}" matches baseline`, async ({ page, openExample }) => {
      await openSettled(openExample);
      await setZoom(page, id);

      // Structural first, so a failure says *what* is wrong rather than "some pixels differ".
      await assertLevelGeometry(page, id);

      await expect(page).toHaveScreenshot(`zoom-levels-${id}.png`, {
        animations: "disabled",
        maxDiffPixelRatio: 0.002,
        fullPage: false,
      });
    });
  }
});

// Sanity coverage for the two pre-existing levels: no new baseline image, just confirmation that
// driving them through the same path as the new levels works and actually changes the geometry.
test('zoom level "day" (pre-existing) is selectable and is the page\'s default', async ({
  page,
  openExample,
}) => {
  await openSettled(openExample);
  await assertLevelGeometry(page, "day");

  await setZoom(page, "day");
  await assertLevelGeometry(page, "day");
});

test('zoom level "week" (pre-existing) is selectable and changes the pixel scale', async ({
  page,
  openExample,
}) => {
  await openSettled(openExample);

  const dayPxPerDay = (await levelGeometry(page)).pxPerDay;

  await setZoom(page, "week");
  await assertLevelGeometry(page, "week");

  // `week` is a much more zoomed-out level than `day` (12 px/day vs. 40 in the built-in table), so
  // this also catches a `setZoomLevel` that silently no-ops.
  expect(LEVELS.week.pxPerDay).toBeLessThan(dayPxPerDay);
});

// Zoom out to `year`, scroll right until the tasks are gone, zoom back in to `day`, and the tasks
// must still be reachable by scrolling back to the left edge. This lives in E2E rather than only in
// unit tests because the fix leans on the renderer's clamp against the *composed* content extent,
// which only a real composition (task-bars contributing it, a real viewport width) produces.
test("zooming out, scrolling away and zooming back in leaves the data reachable", async ({
  page,
  openExample,
}) => {
  await openSettled(openExample);
  const t0 = await originOf(page);

  // Driven through the zoom *commands*, not `setZoomLevel(id)`: they anchor on the middle of the
  // visible chart area, which is the path a reader's Ctrl+wheel and the zoom controls take, and the
  // anchoring is what the original bug lived in. `day` -> `year` is four density steps.
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => gantt.dispatch("timeline/zoomOut", {}));
  }
  await settle(page);
  await assertLevelGeometry(page, "year");

  // Scroll as far right as the axis allows — past every task at 0.5 px/day.
  await page.evaluate(() => gantt.service("stargantt.view").scrollTo({ scrollLeft: 1_000_000 }));
  await settle(page);

  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => gantt.dispatch("timeline/zoomIn", {}));
  }
  await settle(page);
  await assertLevelGeometry(page, "day");

  // The axis still begins where it did, so nothing has been pushed out of reach…
  expect(await page.evaluate(() => gantt.service("stargantt.timeline").xToT(0))).toBe(t0);

  // …and scrolling back to the left edge actually shows the start of the plan.
  const leftmost = await page.evaluate(() => {
    const view = gantt.service("stargantt.view");
    view.scrollTo({ scrollLeft: 0 });
    return gantt.service("stargantt.timeline").xToT(view.viewport.get().scrollLeft);
  });
  expect(leftmost).toBeLessThanOrEqual(t0);
});
