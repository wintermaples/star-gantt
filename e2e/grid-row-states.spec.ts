import { expect, test } from "./_fixtures";
import type { OpenExample } from "./_fixtures";
import type { Page } from "@playwright/test";

// Feature E2E: how the grid pane paints a row that is both selected and hovered
// (docs/specs/plugins/tree-grid.md, packages/stargantt/src/styles/{tokens,layout,plugins}.css).
// The reflected selection has to stay visible under the pointer — `:hover` carries a pseudo-class
// the selection rule must outweigh, so source order alone is not enough — while the hover still
// has to read as a hover. Only the cascade resolved by a real browser can show either, so both are
// asserted as computed styles on `examples/multi-select-rubber-band.html`, whose selection runs in
// `mode: "multi"`.
//
// This is not exercised anywhere in interaction.spec.ts (which never inspects computed
// background colors), so nothing here is a duplicate.

const ROOT = "#chart";
const ROW = (index: number): string => `${ROOT} .sg-grid-row[data-row-index="${index}"]`;

/** Resolved values of the two row-background tokens, as `rgb(...)` strings. */
async function tokens(page: Page): Promise<{ hover: string; selected: string }> {
  return page.evaluate(() => {
    const probe = document.createElement("div");
    document.body.append(probe);
    const read = (token: string): string => {
      probe.style.backgroundColor = `var(${token})`;
      return getComputedStyle(probe).backgroundColor;
    };
    const result = { hover: read("--sg-row-hover-bg"), selected: read("--sg-row-selected-bg") };
    probe.remove();
    return result;
  });
}

/**
 * Resolves each CSS colour to 8-bit sRGB channels by painting it. A computed background may come
 * back in any serialization the value used — `color-mix()` resolves to `color(srgb …)` with
 * fractional components — so the comparison is done on painted pixels rather than on the text.
 */
async function channels(page: Page, colors: string[]): Promise<number[][]> {
  return page.evaluate((list) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    return list.map((color) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const pixel = ctx.getImageData(0, 0, 1, 1).data;
      return [pixel[0]!, pixel[1]!, pixel[2]!];
    });
  }, colors);
}

async function background(page: Page, index: number): Promise<string> {
  return page.locator(ROW(index)).evaluate((el) => getComputedStyle(el).backgroundColor);
}

async function gotoExample(openExample: OpenExample): Promise<void> {
  // The grid rows, not the canvas, are what every assertion below reads.
  await openExample("multi-select-rubber-band.html", { ready: ROW(0) });
}

test.describe("grid row states", () => {
  test("a selected row keeps a selected background while hovered", async ({ page, openExample }) => {
    await gotoExample(openExample);
    const { hover, selected } = await tokens(page);

    // A pointer-down on a grid row is the selection surface; the selection plugin reflects the
    // result back onto the row.
    await page.locator(ROW(1)).click();
    await expect(page.locator(ROW(1))).toHaveClass(/sg-grid-row--selected/);
    await expect(page.locator("#selectionReadout")).not.toHaveText("(none)");

    // Off the pointer, the selected row paints the selection token…
    await page.mouse.move(0, 0);
    await expect.poll(async () => background(page, 1)).toBe(selected);

    // …and an unselected row under the pointer paints the hover token.
    await page.locator(ROW(2)).hover();
    expect(await background(page, 2)).toBe(hover);
    expect(await background(page, 1)).toBe(selected);

    // The row that is both is the case the cascade could lose: it must not fall back to the plain
    // hover fill, and it must still differ from an untouched selected row so the pointer position
    // stays visible. Its fill is a blend, so every channel lies between the two tokens.
    await page.locator(ROW(1)).hover();
    const both = await background(page, 1);
    expect(both).not.toBe(hover);
    expect(both).not.toBe(selected);

    const [blend, hoverRgb, selectedRgb] = await channels(page, [both, hover, selected]);
    for (let i = 0; i < 3; i += 1) {
      const low = Math.min(hoverRgb![i]!, selectedRgb![i]!);
      const high = Math.max(hoverRgb![i]!, selectedRgb![i]!);
      expect(blend![i]!).toBeGreaterThanOrEqual(low);
      expect(blend![i]!).toBeLessThanOrEqual(high);
    }
    // …and the shift away from the plain selection fill is large enough to be seen, not a
    // sub-perceptual rounding difference.
    const shift = Math.max(...blend!.map((value, i) => Math.abs(value - selectedRgb![i]!)));
    expect(shift).toBeGreaterThanOrEqual(4);
  });
});
