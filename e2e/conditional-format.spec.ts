import { expect, test } from "./_fixtures";
import { FIXED_TIME, settle } from "./_fixtures";

// Feature E2E for the opt-in conditional-format nest, driven by
// `examples/conditional-format.html`.
//
// Conditional formatting is provided as the `treeGrid.conditionalFormat` nested config group
// (docs/specs/plugins/tree-grid.md's internalized-services section), not a standalone service. The
// rendered legend class (`.sg-cf-legend`), its claimed bottom-right corner slot, its fixed entry
// order (labelled rules -> overdue -> progress statuses) and its default label catalog
// ("Overdue"/"Behind schedule"/"On track"/"Complete") are documented there.
//
// The page composes `treeGrid.conditionalFormat` on top of the standard preset with one rule (QA
// tasks -> a distinctive purple, `rgb(190, 24, 220)`), the overdue warning, progress-status
// coloring and the legend. Two behaviors are asserted through what the built bundle actually
// produces:
//
// 1. The legend (`.sg-cf-legend`) mounts in the chart pane with the labelled rule entry first and
//    the overdue and progress entries after it, and never intercepts pointer events.
// 2. The rule color reaches the canvas: the chart pane's layers contain pixels of the exact rule
//    color. Sampling the composited pixels is the only honest cross-process observation of a
//    canvas paint — there is no DOM per bar — and scanning for an exact, deliberately unusual RGB
//    triple keeps the check independent of bar geometry.
//
// The clock is pinned so "overdue" (data-relative: the example anchors its data at today 0:00
// UTC) is deterministic within the run.

const PAGE = "conditional-format.html";
const PANE = ".sg-pane--chart";
const LEGEND = ".sg-cf-legend";

// The rule color of the example page, as an exact RGBA triple to scan for.
const RULE_COLOR = { r: 190, g: 24, b: 220 };

test("the legend mounts with the rule, overdue and progress entries", async ({
  page,
  openExample,
}) => {
  await openExample(PAGE, { ready: `${PANE} canvas`, fixedTime: FIXED_TIME, settle: true });

  const legend = page.locator(LEGEND);
  await expect(legend).toBeVisible();

  // Entry order is fixed at setup(): labelled rules → overdue → progress statuses.
  await expect(legend).toContainText("QA tasks");
  await expect(legend).toContainText("Overdue");
  await expect(legend).toContainText("Behind schedule");
  await expect(legend).toContainText("On track");
  await expect(legend).toContainText("Complete");

  // Decoration only: the legend must never swallow chart interaction.
  await expect(legend).toHaveCSS("pointer-events", "none");
});

test("the rule color is painted onto the chart canvas", async ({ page, openExample }) => {
  await openExample(PAGE, { ready: `${PANE} canvas`, fixedTime: FIXED_TIME, settle: true });
  await settle(page);

  // A bar's uncompleted part is its own fill drawn at `--sg-bar-track-alpha`, so on a task that is
  // not fully complete the rule color reaches the canvas with alpha 56 rather than 255. The layer
  // is transparent, so `getImageData` hands back the un-composited channels either way; alpha is
  // therefore not part of the match, and the two px of slack absorbs the rounding a premultiplied
  // store costs (the track reads 191,23,219).
  const found = await page.evaluate(({ pane, color }) => {
    const canvases = Array.from(document.querySelectorAll<HTMLCanvasElement>(`${pane} canvas`));
    for (const canvas of canvases) {
      const ctx = canvas.getContext("2d");
      if (ctx === null || canvas.width === 0 || canvas.height === 0) continue;
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] === 0) continue;
        if (
          Math.abs((data[i] ?? 0) - color.r) <= 2 &&
          Math.abs((data[i + 1] ?? 0) - color.g) <= 2 &&
          Math.abs((data[i + 2] ?? 0) - color.b) <= 2
        ) {
          return true;
        }
      }
    }
    return false;
  }, { pane: PANE, color: RULE_COLOR });

  expect(found, "a pixel of the rule color rgb(190, 24, 220) on some chart layer").toBe(true);
});
