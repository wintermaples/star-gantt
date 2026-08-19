import { expect, test } from "./_fixtures";
import type { OpenExample } from "./_fixtures";
import type { Locator, Page } from "@playwright/test";

// E2E for the pane divider's pointer target (docs/specs/plugins/view.md's `view/panes` /
// `view/bottomPanes` extension points — divider ownership, clamps, a11y separators, collapse).
//
// The divider is painted `--sg-divider-width` wide but must answer to the pointer over at least
// 24 CSS px (WCAG 2.5.8), enlarged around the painted line without changing the painted width or
// the layout — and, across the contributed pane's header strip, without swallowing a control that
// pane puts at its own inner edge (tree-grid's column-resize handles): the two hit bands are
// disjoint, not stacked. Only a real browser can tell any of this apart: the enlargement overlays
// the neighbouring panes, so whether it is reachable — and what it covers — depends on hit-testing
// against those panes' positioned descendants, which no DOM double reproduces. Everything below is
// therefore driven through `document.elementFromPoint` and computed styles.
//
// Target pages: `examples/basic-gantt.html` (a minimal `presetStandard()` composition mounting one
// vertical divider — deliberately not the protected `basic.html`),
// `examples/tree-grid-interaction.html` (a grid with a column boundary at its inner edge),
// `examples/resources-load-chart.html` (the horizontal bottom-pane dividers), and
// `examples/drag-and-undo.html` (the chart pane's leading-edge mirror case).

const DIVIDER = ".sg-pane-divider";

interface Band {
  left: number;
  right: number;
  width: number;
}

/** The divider's own border box — the painted line — in CSS px relative to the viewport. */
async function dividerBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator(DIVIDER).boundingBox();
  if (!box) throw new Error("the divider has no box");
  return box;
}

/**
 * The run of x positions at height `y` that hit-test to the divider — its actual pointer target,
 * which the enlargement puts outside the element's own box and so cannot be read from any rect.
 */
async function hitBand(page: Page, y: number): Promise<Band> {
  const box = await dividerBox(page);
  return page.evaluate(
    ({ centre, at }) => {
      const isDivider = (x: number): boolean =>
        document.elementFromPoint(x, at)?.classList.contains("sg-pane-divider") === true;
      if (!isDivider(centre)) throw new Error(`the painted line does not answer at y=${at}`);
      let left = centre;
      let right = centre;
      while (isDivider(left - 1)) left -= 1;
      while (isDivider(right + 1)) right += 1;
      return { left, right, width: right - left };
    },
    { centre: box.x + box.width / 2, at: y },
  );
}

/**
 * Focuses `divider` and pins its focus ring at the stylesheet's declared geometry: the shared 2px
 * `--sg-focus-stroke` outline, drawn *inside* the divider's own box (`outline-offset: -1px`).
 */
async function expectFocusRing(divider: Locator): Promise<void> {
  await divider.focus();
  const stroke = await divider.evaluate((el) => getComputedStyle(el).getPropertyValue("--sg-focus-stroke").trim());
  await expect(divider).toHaveCSS("outline-style", "solid");
  await expect(divider).toHaveCSS("outline-width", "2px");
  await expect(divider).toHaveCSS("outline-color", stroke);
  await expect(divider).toHaveCSS("outline-offset", "-1px");
}

async function gotoExample(openExample: OpenExample, file: string): Promise<void> {
  // The divider itself is the readiness signal here — every probe below hit-tests against it.
  await openExample(file, { ready: DIVIDER });
}

/** The two heights the band has to be measured at: inside the header strip, and below it. */
async function probeHeights(page: Page): Promise<{ header: number; body: number }> {
  const box = await dividerBox(page);
  const headerHeight = await page.locator(DIVIDER).evaluate((el) => {
    const raw = getComputedStyle(el).getPropertyValue("--sg-header-height").trim();
    return raw === "" ? 44 : parseFloat(raw);
  });
  return { header: box.y + headerHeight / 2, body: box.y + headerHeight + 24 };
}

test.describe("pane divider", () => {
  test("the whole 24 px hit band belongs to the divider, above and below the header", async ({ page, openExample }) => {
    await gotoExample(openExample, "basic-gantt.html");

    const box = await dividerBox(page);
    const y = await probeHeights(page);
    const header = await hitBand(page, y.header);
    const body = await hitBand(page, y.body);

    // The WCAG floor, in both strips. Every column of the band answers to the pointer, including
    // the ones outside the divider's own box, which overlap the neighbouring panes' positioned
    // descendants (the chart pane's canvas layers, the grid pane's scrolling body).
    expect(header.width).toBeGreaterThanOrEqual(24);
    expect(body.width).toBeGreaterThanOrEqual(24);
    await expect(page.locator(DIVIDER)).toHaveCSS("min-height", "24px");

    // The two strips take their slack from opposite sides, because the neighbour carrying edge
    // controls is different in each. Across the header strip the contributed pane does (its
    // column-resize handles), so the band starts at the painted line and reaches only into the
    // chart. Below it the chart does (a bar's start-resize handle and its connector port, once
    // scrolled to the pane's leading edge), so the band ends at the painted line's far edge and
    // reaches only into the contributed pane.
    expect(header.left).toBeGreaterThanOrEqual(box.x - 1);
    expect(header.right).toBeGreaterThan(box.x + box.width + 1);

    expect(body.left).toBeLessThan(box.x - 1);
    expect(body.right).toBeLessThanOrEqual(box.x + box.width + 1);

    // …and the two are genuinely mirror images, not accidentally the same band.
    expect(header.left).toBeGreaterThan(body.left + 5);
    expect(header.right).toBeGreaterThan(body.right + 5);
  });

  test("the enlarged target changes neither the painted line nor the pane layout", async ({ page, openExample }) => {
    await gotoExample(openExample, "basic-gantt.html");

    const painted = await page.locator(DIVIDER).evaluate((el) => {
      const style = getComputedStyle(el);
      return { token: parseFloat(style.getPropertyValue("--sg-divider-width")), box: el.getBoundingClientRect().width };
    });
    // The element itself is exactly the painted width: the enlargement is not part of its box.
    expect(painted.box).toBeCloseTo(painted.token, 1);

    // …and it takes no room in the flex layout either — the gap the divider occupies between its
    // two neighbours is the painted width and nothing more.
    const gap = await page.evaluate(() => {
      const grid = document.querySelector(".sg-pane--grid")!.getBoundingClientRect();
      const chart = document.querySelector(".sg-pane--chart")!.getBoundingClientRect();
      return { between: chart.left - grid.right, gridRight: grid.right };
    });
    expect(gap.between).toBeCloseTo(painted.token, 1);
    expect(gap.gridRight).toBeCloseTo((await dividerBox(page)).x, 1);

    // The hit band still reaches past the box on both sides below the header — the enlargement is
    // real, it is simply not in the layout.
    const y = await probeHeights(page);
    const body = await hitBand(page, y.body);
    expect(body.width).toBeGreaterThan(painted.token);
  });

  test("a drag started from the outer edge of the band resizes the grid pane", async ({ page, openExample }) => {
    await gotoExample(openExample, "basic-gantt.html");

    const grid = page.locator(".sg-pane--grid");
    const widthBefore = (await grid.boundingBox())!.width;
    const box = await dividerBox(page);
    const y = await probeHeights(page);
    const body = await hitBand(page, y.body);

    // The leftmost column of the band is the part that used to be swallowed by the grid pane's
    // body: a press there has to start a divider drag, not land in the grid.
    await page.mouse.move(body.left, y.body);
    await page.mouse.down();
    await page.mouse.move(body.left + 60, y.body, { steps: 10 });
    await page.mouse.up();

    await expect
      .poll(async () => Math.round((await grid.boundingBox())!.width - widthBefore))
      .toBeGreaterThan(50);

    // The painted line is unchanged by the drag.
    expect(Math.round((await dividerBox(page)).width)).toBe(Math.round(box.width));
  });

  test("the band leaves the grid's column-resize handle at the pane's inner edge operable", async ({ page, openExample }) => {
    await gotoExample(openExample, "tree-grid-interaction.html");

    // Scroll the grid until one of the header-boundary handles sits against the pane's inner edge,
    // inside the strip the divider's band would overhang if it were centred there.
    const scrolled = await page.evaluate(() => {
      const pane = document.querySelector(".sg-pane--grid")!.getBoundingClientRect();
      const body = document.querySelector(".sg-grid-body") as HTMLElement;
      const rects = (): DOMRect[] =>
        Array.from(document.querySelectorAll(".sg-grid-header-resize-handle"), (h) => h.getBoundingClientRect());
      const inner = pane.right - 1; // the pane's own 1px right border is not content
      const beyond = rects().find((r) => r.right > inner);
      if (beyond !== undefined) body.scrollLeft += beyond.right - (inner - 2);
      return body.scrollLeft;
    });
    // The header mirrors the body's scrollLeft from a scroll listener, so wait for it to land.
    await expect
      .poll(async () => page.locator(".sg-grid-header").evaluate((el) => el.scrollLeft))
      .toBe(scrolled);

    const target = await page.evaluate(() => {
      const pane = document.querySelector(".sg-pane--grid")!.getBoundingClientRect();
      const inner = pane.right - 1;
      const handles = Array.from(document.querySelectorAll(".sg-grid-header-resize-handle"));
      const hit = handles
        .map((h, index) => ({ index, rect: h.getBoundingClientRect() }))
        .filter((h) => h.rect.right <= inner && h.rect.left >= pane.left)
        .sort((a, b) => b.rect.right - a.rect.right)[0];
      if (hit === undefined) throw new Error("no header-resize handle is inside the grid pane");
      const columnId = handles[hit.index]!.parentElement!.getAttribute("data-column-id")!;
      return {
        columnId,
        left: hit.rect.left,
        right: hit.rect.right,
        y: hit.rect.top + hit.rect.height / 2,
        clearance: inner - hit.rect.right,
      };
    });
    expect(target.clearance).toBeLessThan(10);

    // Every column of the handle but its trailing boundary pixel hit-tests to the handle, exactly
    // as it does for the handles further left: the divider's band does not sit on top of it.
    const hits = await page.evaluate(
      ({ left, right, y }) => {
        const out: string[] = [];
        for (let x = left + 0.5; x < right - 1; x += 1) {
          const el = document.elementFromPoint(x, y);
          out.push(el ? el.className || el.tagName : "none");
        }
        return out;
      },
      target,
    );
    expect(hits.filter((cls) => !cls.includes("sg-grid-header-resize-handle"))).toEqual([]);

    // …and a real drag from its centre resizes that column, rather than starting a divider drag.
    const measure = (columnId: string): Promise<{ column: number; pane: number }> =>
      page.evaluate(
        (id) => ({
          column: document.querySelector(`.sg-grid-header-cell[data-column-id="${id}"]`)!.getBoundingClientRect().width,
          pane: document.querySelector(".sg-pane--grid")!.getBoundingClientRect().width,
        }),
        columnId,
      );
    const before = await measure(target.columnId);
    const centre = (target.left + target.right) / 2;
    await page.mouse.move(centre, target.y);
    await page.mouse.down();
    await page.mouse.move(centre + 60, target.y, { steps: 10 });
    await page.mouse.up();
    const after = await measure(target.columnId);

    expect(Math.round(after.column - before.column)).toBeGreaterThan(50);
    expect(after.pane).toBeCloseTo(before.pane, 1);
  });

  // Every resizable bottom pane carries a horizontal divider on its top edge. The page under test
  // is `examples/resources-load-chart.html`, whose loadChart contributes the two resizable strips
  // `stargantt.load-chart:total` and `stargantt.load-chart:lanes` (docs/specs/plugins/resource.md
  // §3.6/§6.5) — both composed `total: true, lanes: true, resizable: true` by this page, with 3
  // resources so the lanes strip's initial height is `min(96, 3 * 28) = 84`.
  test.describe("horizontal bottom-pane divider", () => {
    const HORIZONTAL = ".sg-pane-divider--horizontal";

    async function openLoadChart(page: Page, openExample: OpenExample): Promise<void> {
      await openExample("resources-load-chart.html", { ready: ".sg-pane--chart canvas" });
      await expect(page.locator(HORIZONTAL)).toHaveCount(2);
    }

    /** The strip (`.sg-bottom-pane`) height for the given strip index (0 = band, 1 = lanes). */
    function stripHeight(page: Page, index: number): Promise<number> {
      return page.evaluate(
        (i) => document.querySelectorAll(".sg-bottom-pane")[i]!.getBoundingClientRect().height,
        index,
      );
    }

    test("is a focusable named separator whose value triad tracks the strip height", async ({ page, openExample }) => {
      await openLoadChart(page, openExample);

      const dividers = page.locator(HORIZONTAL);
      for (const index of [0, 1]) {
        await expect(dividers.nth(index)).toHaveAttribute("role", "separator");
        await expect(dividers.nth(index)).toHaveAttribute("aria-orientation", "horizontal");
        await expect(dividers.nth(index)).toHaveAttribute("tabindex", "0");
      }
      // The accessible names come from the LoadChartMessages catalog defaults — one per strip,
      // deliberately not the panes plugin's generic "Resize panel".
      await expect(dividers.nth(0)).toHaveAttribute("aria-label", "Resize load chart band");
      await expect(dividers.nth(1)).toHaveAttribute("aria-label", "Resize resource lanes");

      // aria-valuenow mirrors the strip's height; aria-valuemin is the interactive floor.
      await expect(dividers.nth(0)).toHaveAttribute("aria-valuenow", "64");
      await expect(dividers.nth(1)).toHaveAttribute("aria-valuenow", "84");
      await expect(dividers.nth(0)).toHaveAttribute("aria-valuemin", "24");
      await expect(dividers.nth(1)).toHaveAttribute("aria-valuemin", "24");
    });

    test("a pointer drag up grows the strip below and shrinks the pane row as one", async ({ page, openExample }) => {
      await openLoadChart(page, openExample);

      const before = await page.evaluate(() => ({
        row: document.querySelector(".sg-pane-row")!.getBoundingClientRect().height,
        grid: document.querySelector(".sg-pane--grid .sg-grid-body")!.getBoundingClientRect().bottom,
        canvas: document.querySelector(".sg-pane--chart canvas.sg-layer")!.getBoundingClientRect().bottom,
      }));

      const box = await page.locator(HORIZONTAL).first().boundingBox();
      if (box === null) throw new Error("the band divider has no box");
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x, y - 40, { steps: 10 });
      await page.mouse.up();

      // Dragging the divider up grows the pane below it (delta = -dy)…
      await expect.poll(() => stripHeight(page, 0)).toBe(104);
      await expect(page.locator(HORIZONTAL).first()).toHaveAttribute("aria-valuenow", "104");

      // …and the whole pane row gave up that height as one: grid body and chart canvas both end
      // 40 px higher, still on the same line.
      const after = await page.evaluate(() => ({
        row: document.querySelector(".sg-pane-row")!.getBoundingClientRect().height,
        grid: document.querySelector(".sg-pane--grid .sg-grid-body")!.getBoundingClientRect().bottom,
        canvas: document.querySelector(".sg-pane--chart canvas.sg-layer")!.getBoundingClientRect().bottom,
      }));
      expect(Math.round(before.row - after.row)).toBe(40);
      expect(Math.round(before.grid - after.grid)).toBe(40);
      expect(Math.abs(after.grid - after.canvas)).toBeLessThanOrEqual(2);

      // A drag far past the floor clamps at the interactive floor — 24 px, the divider's own
      // minimum target size — so the strip and its divider never disappear under a gesture.
      await page.mouse.move(x, y - 40);
      await page.mouse.down();
      await page.mouse.move(x, y + 300, { steps: 10 });
      await page.mouse.up();
      await expect.poll(() => stripHeight(page, 0)).toBe(24);
      await expect(page.locator(HORIZONTAL).first()).toBeVisible();
    });

    test("the >=24 px hit band yields downward into the strip, never over the surface above", async ({ page, openExample }) => {
      await openLoadChart(page, openExample);

      // The lanes divider: above it sits the band (pointer-inert), below it the lanes strip's
      // tabindex="0" scroll surface.
      const box = await page.locator(HORIZONTAL).nth(1).boundingBox();
      if (box === null) throw new Error("the lanes divider has no box");
      const band = await page.evaluate(
        ({ x, top }) => {
          const isDivider = (y: number): boolean => {
            const el = document.elementFromPoint(x, y);
            return el !== null && el.classList.contains("sg-pane-divider--horizontal");
          };
          const centre = top + 2;
          if (!isDivider(centre)) throw new Error("the painted line does not answer");
          let first = centre;
          let last = centre;
          while (isDivider(first - 1)) first -= 1;
          while (isDivider(last + 1)) last += 1;
          return { first, last, height: last - first + 1 };
        },
        { x: box.x + box.width / 2, top: box.y },
      );

      // WCAG 2.5.8: at least 24 CSS px of vertical target…
      expect(band.height).toBeGreaterThanOrEqual(24);
      // …whose slack all lies below the painted line: it must not overhang the surface above (the
      // renderer's synthetic horizontal scrollbar thumb above the topmost divider), and the strip
      // below keeps only its interactive controls out of the band.
      expect(band.first).toBeGreaterThanOrEqual(box.y - 1);
      expect(band.last).toBeGreaterThan(box.y + box.height + 1);
    });

    test("keyboard resize: arrows step 16/64 px, Home/End jump the clamp, the floor is 24 px", async ({ page, openExample }) => {
      await openLoadChart(page, openExample);

      const divider = page.locator(HORIZONTAL).nth(1); // the lanes strip, initial height 84

      // Before the resize steps, pin the focus ring in both orientations on this same page: the
      // vertical grid|chart divider (the page mounts two vertical ones; the first is it), then the
      // horizontal one the rest of the test drives.
      await expectFocusRing(page.locator(".sg-pane-divider:not(.sg-pane-divider--horizontal)").first());
      await expectFocusRing(divider);

      await page.keyboard.press("ArrowUp");
      await expect.poll(() => stripHeight(page, 1)).toBe(100);
      await page.keyboard.press("Shift+ArrowDown");
      await expect.poll(() => stripHeight(page, 1)).toBe(36);
      // 36 - 16 = 20 would cross the interactive floor; the step clamps at 24 instead, so no
      // keystroke can drive a resizable strip into the hidden zero-height state.
      await page.keyboard.press("ArrowDown");
      await expect.poll(() => stripHeight(page, 1)).toBe(24);
      await expect(divider).toBeVisible();
      await expect(divider).toHaveAttribute("aria-valuenow", "24");

      // Home is the floor, End the effective maximum — which is bounded by the pane row's own
      // minimum-height floor, so even End cannot squeeze the row away.
      await page.keyboard.press("End");
      await expect
        .poll(async () => page.evaluate(() => document.querySelector(".sg-pane-row")!.getBoundingClientRect().height))
        .toBeGreaterThanOrEqual(119);
      const max = await stripHeight(page, 1);
      const valuenow = parseFloat((await divider.getAttribute("aria-valuenow")) ?? "NaN");
      expect(Math.abs(valuenow - max)).toBeLessThanOrEqual(1);
      await page.keyboard.press("Home");
      await expect.poll(() => stripHeight(page, 1)).toBe(24);

      // The divider handles the key alone: the chart behind must not also scroll or move focus.
      expect(await page.evaluate(() => document.activeElement?.classList.contains("sg-pane-divider") === true)).toBe(
        true,
      );
    });
  });

  // The mirror image of the "column-resize handle" test above, on the other side of the same band.
  // Below the header strip it is the *chart* that puts controls against the edge: a task bar
  // scrolled to the pane's leading edge carries a start-resize handle there, and a connector port
  // further left still. A band centred on the painted line would overhang into the chart and
  // swallow both, so the slack yields to the contributed pane instead.
  test("the band leaves the chart pane's leading edge to the chart", async ({ page, openExample }) => {
    await gotoExample(openExample, "drag-and-undo.html");

    const heights = await probeHeights(page);
    const chartLeft = await page.evaluate(() => document.querySelector(".sg-pane--chart")!.getBoundingClientRect().left);

    // Every point from the chart pane's leading edge onward must belong to the chart, not to the
    // divider: this is where a bar's own handles live once it is scrolled that far left.
    const owners = await page.evaluate(
      ({ left, y }) =>
        [0.5, 2, 5, 9, 12].map((dx) => {
          const el = document.elementFromPoint(left + dx, y);
          return { dx, cls: el === null ? "" : el.className.toString() };
        }),
      { left: chartLeft, y: heights.body },
    );
    for (const { dx, cls } of owners) {
      expect(cls, `${dx}px into the chart pane`).not.toContain("sg-pane-divider");
    }

    // …while the divider keeps its 24 px band at the same height, taken from the grid side.
    const band = await hitBand(page, heights.body);
    expect(band.width).toBeGreaterThanOrEqual(24);
    expect(band.right).toBeLessThanOrEqual(chartLeft + 0.5);
  });
});
