import { expect, test } from "./_fixtures";
import { settle } from "./_fixtures";
import type { Page } from "@playwright/test";

// E2E for the chart pane's published safe area (`--sg-safe-*`, docs/specs/plugins/view.md's
// overlay-corner-slot mechanism) as the two opt-in corner overlays this repository ships consume
// it: the schedule-diagnostics panel (top-LEFT slot, docs/specs/plugins/scheduling.md §8 "Slot
// grant") and the filter-search toolbar (top-RIGHT slot, docs/specs/plugins/interaction.md §6.8).
//
// Why this lives in E2E and not in either package's vitest suite: the placement is a `calc()` over
// custom properties the view plugin publishes at layout time. Asserting that the *string*
// `calc(var(--sg-safe-top, 0px) + 8px)` was written proves nothing about where the element lands —
// only a real layout engine resolves it. Every assertion below is therefore taken from
// `getBoundingClientRect()` against the chart pane's own box.
//
// What this pins, as a regression floor: a corner slot must clear the timeline header band and the
// synthetic scrollbar strips, and must not span the safe area's full width or height — including
// at the project's hard 720x540 viewport floor, where the chart pane clamps to
// `--sg-chart-min-width`.

const PANE = ".sg-pane--chart";

/** The two viewports every case runs at: a roomy desktop and the project's hard 720x540 floor. */
const WIDE = { width: 1440, height: 900 } as const;
const FLOOR = { width: 720, height: 540 } as const;

/** The margin both plugins own; the slot is safe-area corner + margin. */
const MARGIN = 8;

interface SafeArea {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** A box measured as insets from each edge of the chart pane's border box. */
interface Inset {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

interface Measured {
  pane: { width: number; height: number };
  safe: SafeArea;
  boxes: Record<string, Inset>;
}

/**
 * Reads the published safe area and each named element's box, both relative to the chart pane.
 *
 * The safe area is read exactly the way a JS-side consumer is told to:
 * `getComputedStyle(chartPane).getPropertyValue("--sg-safe-*")`, parsed as px.
 */
async function measure(page: Page, selectors: Record<string, string>): Promise<Measured> {
  return page.evaluate(
    ([paneSel, sels]) => {
      const pane = document.querySelector(paneSel as string);
      if (pane === null) throw new Error("chart pane missing");
      const style = getComputedStyle(pane);
      const read = (name: string): number =>
        Number.parseFloat(style.getPropertyValue(name).trim() || "NaN");
      const pb = pane.getBoundingClientRect();
      const boxes: Record<string, Inset> = {};
      for (const [name, selector] of Object.entries(sels as Record<string, string>)) {
        const el = document.querySelector(selector);
        if (el === null) throw new Error(`missing element for ${name}: ${selector}`);
        const b = el.getBoundingClientRect();
        boxes[name] = {
          top: b.top - pb.top,
          right: pb.right - b.right,
          bottom: pb.bottom - b.bottom,
          left: b.left - pb.left,
          width: b.width,
          height: b.height,
        };
      }
      return {
        pane: { width: pb.width, height: pb.height },
        safe: {
          top: read("--sg-safe-top"),
          right: read("--sg-safe-right"),
          bottom: read("--sg-safe-bottom"),
          left: read("--sg-safe-left"),
        },
        boxes,
      };
    },
    [PANE, selectors] as const,
  );
}

/**
 * Asserts one box is wholly inside the safe area, with a per-edge message naming the chrome it
 * would otherwise be sitting on.
 */
function expectInsideSafeArea(m: Measured, name: string): void {
  const box = m.boxes[name];
  expect(box, `${name} measured`).toBeDefined();
  if (box === undefined) return;
  expect(box.top, `${name} top edge clears the timeline header band`).toBeGreaterThanOrEqual(m.safe.top);
  expect(box.right, `${name} right edge clears the vertical scrollbar strip`).toBeGreaterThanOrEqual(
    m.safe.right,
  );
  expect(box.bottom, `${name} bottom edge clears the horizontal scrollbar strip`).toBeGreaterThanOrEqual(
    m.safe.bottom,
  );
  expect(box.left, `${name} left edge is inside the pane`).toBeGreaterThanOrEqual(m.safe.left);
  // No overlay spans the safe area's full width or full height.
  expect(box.width, `${name} does not span the safe area's width`).toBeLessThan(
    m.pane.width - m.safe.left - m.safe.right,
  );
  expect(box.height, `${name} does not span the safe area's height`).toBeLessThan(
    m.pane.height - m.safe.top - m.safe.bottom,
  );
}

/** The safe area of the default composition, which both example pages compose. */
function expectDefaultSafeArea(m: Measured): void {
  expect(m.safe).toEqual({ top: 44, right: 10, bottom: 10, left: 0 });
}

/* ------------------------------------------------------------------ *
 * schedule-diagnostics — the top-LEFT slot
 * ------------------------------------------------------------------ */

const DIAGNOSTICS = {
  root: ".sg-diagnostics",
  button: ".sg-diagnostics-button",
  list: ".sg-diagnostics-panel",
} as const;

for (const vp of [WIDE, FLOOR]) {
  test(`the diagnostics panel sits in the top-left slot of the safe area at ${vp.width}x${vp.height}`, async ({
    page,
    openExample,
  }) => {
    await page.setViewportSize(vp);
    await openExample("schedule-diagnostics.html", { ready: `${PANE} canvas` });
    await settle(page);

    const closed = await measure(page, DIAGNOSTICS);
    expectDefaultSafeArea(closed);
    if (vp === FLOOR) {
      // The floor claim this test is about: the pane really is clamped to `--sg-chart-min-width`
      // here, so "it fits at 720x540" is being measured against the narrowest pane there is.
      expect(closed.pane.width, "chart pane is at its --sg-chart-min-width floor").toBe(240);
    }

    // The slot itself: safe-area corner + the plugin's own 8px margin, on both anchored sides.
    expect(closed.boxes["button"]?.top).toBe(closed.safe.top + MARGIN);
    expect(closed.boxes["button"]?.left).toBe(closed.safe.left + MARGIN);
    // The regression in numbers: pre-fix the button's top was 8, inside the 0..44 header band.
    expect(closed.boxes["button"]?.top).toBeGreaterThanOrEqual(44);
    expectInsideSafeArea(closed, "button");

    // The findings list opens from the button and must clear the header band as well — and, at
    // the floor, must not open off the bottom of a short pane.
    await page.locator(DIAGNOSTICS.button).click();
    await expect(page.locator(DIAGNOSTICS.list)).toBeVisible();
    await settle(page);

    const open = await measure(page, DIAGNOSTICS);
    expectInsideSafeArea(open, "button");
    expectInsideSafeArea(open, "list");
    expectInsideSafeArea(open, "root");
    // The list hangs below the button rather than over it.
    expect(open.boxes["list"]?.top).toBeGreaterThanOrEqual(
      (open.boxes["button"]?.top ?? 0) + (open.boxes["button"]?.height ?? 0),
    );
    // And it is actually usable, not squeezed to nothing by the clamps.
    expect(open.boxes["list"]?.width).toBeGreaterThan(120);
    expect(open.boxes["list"]?.height).toBeGreaterThan(40);
  });
}

test("a press beside the diagnostics button reaches the chart, not the slot's scaffolding", async ({
  page,
  openExample,
}) => {
  await page.setViewportSize(FLOOR);
  await openExample("schedule-diagnostics.html", { ready: `${PANE} canvas` });
  await settle(page);

  // The slot root is wider than the button (it carries the findings list's width floor), so the
  // strip beside the button is scaffolding. It must not swallow chart presses.
  const m = await measure(page, DIAGNOSTICS);
  const root = m.boxes["root"];
  const button = m.boxes["button"];
  expect(root).toBeDefined();
  expect(button).toBeDefined();
  if (root === undefined || button === undefined) return;
  expect(root.width, "the root is wider than the button it holds").toBeGreaterThan(button.width);

  const tag = await page.evaluate(
    ([paneSel, x, y]) => {
      const pane = document.querySelector(paneSel as string);
      if (pane === null) return "no-pane";
      const pb = pane.getBoundingClientRect();
      const hit = document.elementFromPoint(pb.left + (x as number), pb.top + (y as number));
      return hit === null ? "none" : hit.tagName.toLowerCase();
    },
    [
      PANE,
      // Just right of the button, still within the root's box, vertically on the button's line.
      button.left + button.width + (root.width - button.width) / 2,
      button.top + button.height / 2,
    ] as const,
  );
  expect(tag, "the point beside the button hits the chart canvas").toBe("canvas");
});

/* ------------------------------------------------------------------ *
 * filter-search — the top-RIGHT slot
 * ------------------------------------------------------------------ */

const FILTER = {
  root: ".sg-filter-toolbar",
  input: ".sg-filter-search-input",
  button: ".sg-filter-button",
  panel: ".sg-filter-panel",
} as const;

for (const vp of [WIDE, FLOOR]) {
  test(`the filter toolbar sits in the top-right slot of the safe area at ${vp.width}x${vp.height}`, async ({
    page,
    openExample,
  }) => {
    await page.setViewportSize(vp);
    await openExample("filter-search.html", { ready: `${PANE} canvas` });
    await settle(page);

    const closed = await measure(page, { root: FILTER.root, input: FILTER.input, button: FILTER.button });
    expectDefaultSafeArea(closed);
    if (vp === FLOOR) {
      expect(closed.pane.width, "chart pane is at its --sg-chart-min-width floor").toBe(240);
    }

    // The slot: safe-area corner + the plugin's own 8px margin, on both anchored sides.
    expect(closed.boxes["root"]?.top).toBe(closed.safe.top + MARGIN);
    expect(closed.boxes["root"]?.right).toBe(closed.safe.right + MARGIN);
    // The regression in numbers: pre-fix the toolbar's top was 8 (inside the 0..44 header band)
    // and its right inset 8 — 2px inside the 10px the vertical scrollbar reserves.
    expect(closed.boxes["root"]?.top).toBeGreaterThanOrEqual(44);
    expect(closed.boxes["root"]?.right).toBeGreaterThanOrEqual(10);

    // Every control, not just the container: at the floor the row wraps rather than overhanging.
    expectInsideSafeArea(closed, "root");
    expectInsideSafeArea(closed, "input");
    expectInsideSafeArea(closed, "button");
    // The search box stays typeable, not shrunk away, at either width.
    expect(closed.boxes["input"]?.width).toBeGreaterThan(120);

    // The filter panel opens downward from the button and must stay inside the safe area too.
    await page.locator(FILTER.button).click();
    await expect(page.locator(FILTER.panel)).toBeVisible();
    await settle(page);

    const open = await measure(page, FILTER);
    expectInsideSafeArea(open, "root");
    expectInsideSafeArea(open, "panel");
    expect(open.boxes["panel"]?.top).toBeGreaterThanOrEqual(
      (open.boxes["button"]?.top ?? 0) + (open.boxes["button"]?.height ?? 0),
    );
    expect(open.boxes["panel"]?.width).toBeGreaterThan(120);
    expect(open.boxes["panel"]?.height).toBeGreaterThan(40);

    // The widest the row ever gets: an active query fills the match counter, which at the floor
    // is one more thing competing for a narrow line. It wraps; it does not overhang.
    await page.keyboard.press("Escape");
    await page.locator(FILTER.input).fill("page");
    await settle(page);
    const filtering = await measure(page, {
      root: FILTER.root,
      input: FILTER.input,
      button: FILTER.button,
      counter: ".sg-filter-match-count",
    });
    expect(filtering.boxes["counter"]?.width, "the counter is showing").toBeGreaterThan(0);
    for (const part of ["root", "input", "button", "counter"]) expectInsideSafeArea(filtering, part);
  });
}
