import { expect, settle, test } from "./_fixtures";
import type { OpenExample } from "./_fixtures";
import type { Page } from "@playwright/test";

// Feature E2E: the WBS numbering column and the tree column's indent geometry
// (docs/specs/plugins/tree-grid.md §"Config" — `wbs`, and the tree-column indentation
// invariant).
//
// The fake-DOM suites prove the arithmetic the plugin *writes*; only a real browser lays it out.
// This spec measures the laid-out boxes: that every column's body cells cover exactly the
// interval its header cell covers, and that a WBS code keeps its room as the code grows.
//
// The page is `examples/column-editing-sort.html`, whose `#wbsToggle` checkbox is the documented
// way to compose the numbering column. There is no test-only hook or shared shell
// (docs/specs/architecture.md distribution chapter: specs open the pages under `examples/`
// directly) — this page is fully self-contained and rebuilds its own chart from checkbox state
// (`boot()`, synchronous `gantt.dispose()` + `StarGantt.create()`), so a deep chain is loaded by
// calling the public `stargantt.data` service's `load()` directly against the page's own
// `window.gantt` after the WBS toggle has (re)booted the instance.

const PAGE = "column-editing-sort.html";
const GRID = ".sg-pane--grid";

declare const gantt: {
  service(key: "stargantt.data"): { load(data: unknown): void };
};

/** One column's laid-out interval inside its own flex line, in content coordinates. */
interface Span {
  left: number;
  right: number;
}

interface RowGeometry {
  /** Column id -> the interval that column's cell covers in this row. */
  columns: Record<string, Span>;
  /** The interval the row's leading gutter covers, or `null` when the row has none. */
  gutter: Span | null;
  /** The content extent of the line: the trailing edge of its last child. */
  width: number;
}

/**
 * Reads the header row's and every painted body row's laid-out column geometry.
 *
 * Coordinates are relative to each line's own scroll container and include its `scrollLeft`, so a
 * header and a body parked at different scroll offsets are still compared on the same axis.
 */
async function geometry(page: Page): Promise<{ header: RowGeometry; rows: RowGeometry[] }> {
  return page.evaluate(() => {
    const measure = (line: Element, container: Element, gutterClass: string): RowGeometry => {
      const origin = container.getBoundingClientRect().left - (container as HTMLElement).scrollLeft;
      const columns: Record<string, { left: number; right: number }> = {};
      let gutter: { left: number; right: number } | null = null;
      for (const child of Array.from(line.children)) {
        const box = child.getBoundingClientRect();
        const span = { left: box.left - origin, right: box.right - origin };
        const id = child.getAttribute("data-column-id");
        if (id !== null) columns[id] = span;
        else if (child.classList.contains(gutterClass)) gutter = span;
      }
      // The content extent, not the element's own box: a row is `width: max-content` with a
      // `min-width: 100%` floor, so its rect stretches to the pane while the header's rect is the
      // scroll container's. Only the trailing edge of the last child compares like for like.
      const last = line.children[line.children.length - 1];
      const width = last === undefined ? 0 : last.getBoundingClientRect().right - origin;
      return { columns, gutter, width };
    };

    const header = document.querySelector(".sg-pane--grid .sg-grid-header");
    const body = document.querySelector(".sg-pane--grid .sg-grid-body");
    if (header === null || body === null) throw new Error("grid not mounted");
    return {
      header: measure(header, header, "sg-grid-header-gutter"),
      rows: Array.from(body.querySelectorAll(".sg-grid-row"))
        .filter((row) => (row as HTMLElement).style.display !== "none")
        .map((row) => measure(row, body, "sg-grid-toggle")),
    };
  });
}

/**
 * Every column's body cells cover exactly the interval its header cell covers, and a row is
 * exactly as wide as the header row.
 *
 * The tree column is the one column whose *cell* legitimately starts later than its header
 * cell — the depth inset is taken out of the column's own space, ahead of the cell — so it is
 * asserted as "ends where its header ends, and starts no earlier than its header's gutter".
 */
function expectParity(header: RowGeometry, rows: RowGeometry[], treeColumn: string): void {
  expect(rows.length).toBeGreaterThan(0);
  for (const [index, row] of rows.entries()) {
    expect(Object.keys(row.columns), `row ${index} columns`).toEqual(Object.keys(header.columns));
    for (const [id, span] of Object.entries(row.columns)) {
      const head = header.columns[id];
      expect(head, `header cell for ${id}`).toBeDefined();
      if (head === undefined) continue;
      expect(span.right, `row ${index}: right edge of ${id}`).toBeCloseTo(head.right, 1);
      if (id === treeColumn) {
        expect(span.left, `row ${index}: left edge of ${id}`).toBeGreaterThanOrEqual(
          (header.gutter?.left ?? head.left) - 0.5,
        );
      } else {
        expect(span.left, `row ${index}: left edge of ${id}`).toBeCloseTo(head.left, 1);
      }
    }
    expect(row.width, `row ${index}: total width`).toBeCloseTo(header.width, 1);
  }
}

/** A single chain `1 -> 1.1 -> 1.1.1 -> …`, so row *n* sits at depth *n*. */
function chain(levels: number): { tasks: unknown[] } {
  const DAY = 86_400_000;
  const T0 = Date.UTC(2026, 7, 3);
  return {
    tasks: Array.from({ length: levels }, (_, i) => ({
      id: `d${i}`,
      parentId: i === 0 ? null : `d${i - 1}`,
      name: `Level ${i + 1}`,
      start: T0 + i * DAY,
      end: T0 + (i + 3) * DAY,
      type: i === levels - 1 ? "task" : "summary",
    })),
  };
}

/** Opens the page with the WBS column composed and a `levels`-deep chain loaded. */
async function openWithWbs(page: Page, openExample: OpenExample, levels: number): Promise<void> {
  await openExample(PAGE, { ready: `${GRID} .sg-grid-row` });
  // Checking the toggle reboots the chart (`boot()`, synchronous dispose + create) with the
  // default 9-task dataset; the deep chain is then loaded onto the *new* instance.
  await page.locator("#wbsToggle").check();
  await settle(page);
  await page.evaluate((data) => gantt.service("stargantt.data").load(data), chain(levels));
  // The row count comes from the ARIA mirror, which carries the TRUE count — the painted rows are
  // windowed to the viewport, so a deep chain paints fewer of them than it has.
  await expect(page.locator('[role="treegrid"]')).toHaveAttribute("aria-rowcount", String(levels));
  await expect(page.locator(`${GRID} .sg-grid-row`).first()).toBeVisible();
}

/** The text and the `title` of every painted WBS cell, in row order. */
async function wbsCells(page: Page): Promise<{ text: string; title: string | null }[]> {
  return page.$$eval(`${GRID} .sg-grid-body .sg-grid-cell[data-column-id="wbs"]`, (cells) =>
    cells
      .filter((cell) => (cell.closest(".sg-grid-row") as HTMLElement | null)?.style.display !== "none")
      .map((cell) => ({
        text: cell.textContent ?? "",
        title: cell.getAttribute("title"),
      })),
  );
}

test.describe("`wbs` + tree indentation", () => {
  test("the numbering column keeps its full width at every depth", async ({ page, openExample }) => {
    await openWithWbs(page, openExample, 5);

    // Every code is painted in full: the column no longer pays the depth gutter, so a deeper
    // row's longer code has at least the room the shallowest row's has.
    const cells = await wbsCells(page);
    expect(cells.map((c) => c.text)).toEqual(["1", "1.1", "1.1.1", "1.1.1.1", "1.1.1.1.1"]);
    // The full code is on every cell as a `title`, so an ellipsised code is never lossy.
    expect(cells.map((c) => c.title)).toEqual(cells.map((c) => c.text));

    const { header, rows } = await geometry(page);
    const code = rows.map((row) => row.columns["wbs"]);
    expect(code.every((span) => span !== undefined)).toBe(true);
    // Identical box on every row.
    for (const span of code) {
      expect(span?.left).toBeCloseTo(code[0]!.left, 1);
      expect(span?.right).toBeCloseTo(code[0]!.right, 1);
    }
    expect(header.gutter).not.toBeNull();
    // The gutter is laid out *after* the numbering column, not at the row's leading edge.
    expect(header.gutter!.left).toBeGreaterThanOrEqual(header.columns["wbs"]!.right - 0.5);
  });

  test("the indentation moves onto the tree column and grows with depth", async ({ page, openExample }) => {
    await openWithWbs(page, openExample, 5);
    const { rows } = await geometry(page);
    const inset = rows.map((row) => row.columns["name"]!.left);
    for (let i = 1; i < inset.length; i += 1) {
      expect(inset[i]! - inset[i - 1]!).toBeCloseTo(16, 1);
    }
  });

  test("every column covers its own header's interval, at every depth", async ({ page, openExample }) => {
    await openWithWbs(page, openExample, 5);
    const { header, rows } = await geometry(page);
    expect(rows.length).toBe(5);
    expectParity(header, rows, "name");
  });

  // At the minimum supported viewport (720x540 - CLAUDE.md §3 viewport floor) the grid pane
  // clamps against the chart pane's floor, so the pane is narrower than the column track and the
  // body scrolls horizontally. Parity has to survive that, and the gutter still may not be
  // charged to the numbering column.
  test("parity holds at the 720x540 floor, with the grid pane clamped", async ({ page, openExample }) => {
    await page.setViewportSize({ width: 720, height: 540 });
    await openWithWbs(page, openExample, 5);

    const paneWidth = await page.locator(GRID).evaluate((pane) => pane.getBoundingClientRect().width);
    // The page asks for a 760px grid pane; 720px of viewport cannot give it that and still leave
    // the chart its floor, so the pane is clamped well below its requested width.
    expect(paneWidth).toBeLessThan(760);
    expect(paneWidth).toBeGreaterThanOrEqual(120);

    const cells = await wbsCells(page);
    expect(cells.map((c) => c.title)).toEqual(["1", "1.1", "1.1.1", "1.1.1.1", "1.1.1.1.1"]);

    const { header, rows } = await geometry(page);
    expectParity(header, rows, "name");
  });

  // On a tree deeper than the tree column affords, the inset stops growing rather than the row
  // outgrowing its header — and depth stays fully conveyed by the ARIA mirror's `aria-level`.
  test("the inset saturates on a deep tree without breaking parity", async ({ page, openExample }) => {
    await openWithWbs(page, openExample, 18);
    const { header, rows } = await geometry(page);
    expectParity(header, rows, "name");

    const inset = rows.map((row) => row.columns["name"]!.left - header.gutter!.left);
    // Growth stops: the deepest painted rows share one inset instead of stepping past the column.
    expect(inset[inset.length - 1]).toBeCloseTo(inset[inset.length - 2]!, 1);
    expect(inset[1]! - inset[0]!).toBeCloseTo(16, 1);

    // Saturation is a visual limit only: depth stays fully conveyed by the mirror's `aria-level`,
    // which keeps counting past the depth at which the inset stops moving.
    const levels = await page.$$eval('[role="treegrid"] [role="row"]', (list) =>
      list.map((row) => row.getAttribute("aria-level")),
    );
    expect(levels.length).toBeGreaterThan(13);
    expect(levels).toEqual(levels.map((_, i) => String(i + 1)));
  });
});

// The composition every other test in this repository is built on: `wbs` off, where the tree
// column is simply the first column. Its leading structure and geometry must be exactly what
// they are with the numbering column absent.
test("with `wbs` off the gutter still leads the row", async ({ page, openExample }) => {
  await openExample(PAGE, { ready: `${GRID} .sg-grid-row` });
  await page.evaluate((data) => gantt.service("stargantt.data").load(data), chain(4));
  // The row pool does not shrink to match a smaller dataset (only the visible slots do) — the
  // true count is the ARIA mirror's `aria-rowcount`, and the DOM checks below filter out the
  // hidden pool leftovers themselves (`style.display !== "none"`), same as `geometry()` does.
  await expect(page.locator('[role="treegrid"]')).toHaveAttribute("aria-rowcount", "4");

  const leading = await page.$$eval(`${GRID} .sg-grid-row`, (rows) =>
    rows
      .filter((row) => (row as HTMLElement).style.display !== "none")
      .map((row) => row.firstElementChild?.className ?? ""),
  );
  expect(leading).toEqual(["sg-grid-toggle", "sg-grid-toggle", "sg-grid-toggle", "sg-grid-toggle"]);

  const headerLeading = await page.$eval(
    `${GRID} .sg-grid-header`,
    (header) => header.firstElementChild?.className ?? "",
  );
  expect(headerLeading).toBe("sg-grid-header-gutter");

  const { header, rows } = await geometry(page);
  expect(header.columns["wbs"]).toBeUndefined();
  expectParity(header, rows, "name");
  const inset = rows.map((row) => row.columns["name"]!.left - header.gutter!.left);
  // 24px first-row inset, 16px per level, straight off the row's leading edge — verified against
  // the actual render (empirically measured, not assumed). A per-step-only check (the delta
  // between consecutive rows) can pass even if every row shifted by
  // the same constant offset — e.g. the gutter widened and the whole column moved with it — so the
  // absolute first value matters as much as the step.
  expect(inset.map((v) => Math.round(v))).toEqual([24, 40, 56, 72]);
});

// The bundled date editor fills its cell, so the native calendar icon sits inside the cell being
// edited — where the press-inside-editor guard protects it. An unsized `<input type="date">` kept
// its ~150px intrinsic width would overflow the narrow "Due" column and put the icon under the
// neighbouring cell, where the press was a row gesture whose focus consequences would cancel the
// very edit it belonged to.
test("the bundled date editor fills its cell and survives a press on its calendar-icon zone", async ({
  page,
  openExample,
}) => {
  await openExample(PAGE, { ready: `${GRID} .sg-grid-row` });

  // The page composes seven grid columns (~790px) — at the default viewport the divider clamps
  // against the chart pane's minimum width before the grid can fit them, so widen the window
  // first, then the pane.
  await page.setViewportSize({ width: 1760, height: 800 });
  await settle(page);

  // The Due column sits beyond the grid pane's default width, half-under the pane divider —
  // widen the pane by dragging the divider right so the whole cell (and the editor it will host)
  // lies inside the pane, clear of the divider that would otherwise take the press and pull focus
  // out of the editor.
  const divider = page.locator(".sg-pane-divider").first();
  const dividerBox = await divider.boundingBox();
  if (dividerBox === null) throw new Error("the pane divider has no layout box");
  const grabX = dividerBox.x + dividerBox.width / 2;
  const grabY = dividerBox.y + dividerBox.height / 2;
  await page.mouse.move(grabX, grabY);
  await page.mouse.down();
  await page.mouse.move(grabX + 420, grabY, { steps: 8 });
  await page.mouse.up();
  await settle(page);

  const cellBox = await page.evaluate(() => {
    const header = document.querySelector(".sg-pane--grid .sg-grid-header");
    const cells = Array.from(header?.querySelectorAll(".sg-grid-header-cell") ?? []);
    const index = cells.findIndex((c) => c.textContent?.trim() === "Due");
    if (index < 0) return null;
    const row = document.querySelector(".sg-pane--grid .sg-grid-row");
    const cell = row?.querySelectorAll(".sg-grid-cell")[index];
    if (!(cell instanceof HTMLElement)) return null;
    const r = cell.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  if (cellBox === null) throw new Error("the Due cell has no layout box");
  await page.mouse.dblclick(cellBox.x + cellBox.width / 2, cellBox.y + cellBox.height / 2);

  const input = page.locator(`${GRID} input.sg-grid-date`);
  await expect(input).toBeVisible();

  // The input's box stays inside its cell's box — the icon cannot land under a neighbour.
  const inputBox = await input.boundingBox();
  if (inputBox === null) throw new Error("the date input has no layout box");
  expect(inputBox.x).toBeGreaterThanOrEqual(cellBox.x - 1);
  expect(inputBox.x + inputBox.width).toBeLessThanOrEqual(cellBox.x + cellBox.width + 1);

  // A press on the calendar-icon zone (right edge, inside the input) leaves the editor mounted.
  await page.mouse.click(inputBox.x + inputBox.width - 6, inputBox.y + inputBox.height / 2);
  await expect(input).toBeVisible();

  // Escape still cancels — the editor closes and nothing was written. The icon press may have
  // opened the platform's calendar popup, which consumes the first Escape; a second one then
  // reaches the input.
  await page.keyboard.press("Escape");
  if ((await input.count()) > 0) await page.keyboard.press("Escape");
  await expect(input).toHaveCount(0);
});
