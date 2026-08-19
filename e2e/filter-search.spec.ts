import { expect, test } from "./_fixtures";
import { settle } from "./_fixtures";

// Feature E2E for the opt-in filter/search feature (docs/specs/plugins/interaction.md §6.8,
// §2.3 `stargantt.filter` -> `FilterService`), driven by `examples/filter-search.html`.
//
// The page composes `interaction: { filterSearch: { searchBox: true, filterPanel: true } }` on
// top of the standard preset (architecture.md ch. 4.1). The spec exercises the incremental
// search end to end through the built bundle: typing into the toolbar's search box narrows the
// visible rows (hidden rows are geometric — overridden to height 0 through the public
// `rows/height` point — so visibility is asserted through the public `stargantt.filter` service
// and the grid's actual row geometry), matches keep their ancestors visible for tree context,
// and Escape clears the filter again (interaction/internal/filter/toolbar.ts's Escape handler
// reverts the query on the search input itself).
//
// interaction.spec.ts's own "filter / search" test already proves the basic contract (a query
// narrows `visibleBoxes()`, clearing by emptying the input restores it) on examples/interaction.html.
// This file is not a duplicate: it proves three things that one does not —
//  1. ancestor-chain preservation for several ids at once (a match's parent AND an unrelated
//     ancestor stay visible, several concrete non-matches are hidden);
//  2. the "hidden row is not laid out at all" invariant (a hidden row's text must not still be
//     painted, which a height-only check cannot catch);
//  3. Escape-in-the-search-box as a distinct clearing code path from emptying the input.

const PAGE = "filter-search.html";
const PANE = ".sg-pane--chart";
const SEARCH = ".sg-filter-search-input";
const GRID_ROW = ".sg-grid-row";

declare const gantt: {
  service(key: "stargantt.filter"): { isTaskVisible(id: string): boolean };
};

/** Reads `isTaskVisible` for a set of task ids through the public filter service. */
async function visibility(
  page: import("@playwright/test").Page,
  ids: readonly string[],
): Promise<Record<string, boolean>> {
  return page.evaluate((taskIds) => {
    const service = gantt.service("stargantt.filter");
    const out: Record<string, boolean> = {};
    for (const id of taskIds) out[id] = service.isTaskVisible(id);
    return out;
  }, ids);
}

/**
 * Counts the grid rows that currently occupy space.
 *
 * A row the `rows/height` reduction put at 0 gets no slot at all, so a filtered-out row is a
 * parked (`display: none`) slot still carrying the inline height of whatever it showed last.
 * Reading the inline height alone would therefore count the leftovers; a row counts here only
 * when it is displayed *and* its assigned height is positive, which is true both before and after
 * filtering.
 */
async function visibleRowCount(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate((selector) => {
    let count = 0;
    for (const row of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      if (row.style.display === "none") continue;
      if (parseFloat(row.style.height || "0") > 0) count += 1;
    }
    return count;
  }, GRID_ROW);
}

test("incremental search hides non-matches, keeps ancestors, and Escape clears", async ({ page, openExample }) => {
  await openExample(PAGE, { ready: `${PANE} canvas` });

  const search = page.locator(SEARCH);
  await expect(search).toBeVisible();

  const before = await visibleRowCount(page);
  expect(before).toBeGreaterThan(0);

  // "page" matches "Frontend pages", "Search page" and "Checkout page" by name.
  await search.fill("page");
  await settle(page);

  const state = await visibility(page, [
    "root",
    "frontend",
    "search",
    "checkout",
    "design",
    "backend",
    "qa",
    "launch",
  ]);
  // Matches are visible, and so are their ancestors (tree context).
  expect(state["frontend"], "matched parent").toBe(true);
  expect(state["search"], "matched leaf").toBe(true);
  expect(state["checkout"], "matched leaf").toBe(true);
  expect(state["root"], "ancestor of a match").toBe(true);
  // Non-matches are hidden.
  expect(state["design"], "non-match").toBe(false);
  expect(state["backend"], "non-match").toBe(false);
  expect(state["qa"], "non-match").toBe(false);
  expect(state["launch"], "non-match").toBe(false);

  // The hiding is geometric: fewer rows occupy height in the grid than before.
  const during = await visibleRowCount(page);
  expect(during).toBeLessThan(before);
  expect(during).toBeGreaterThan(0);

  // A hidden row is not merely zero-height, it is not laid out at all: every filtered-out row
  // still getting a slot would, since a grid row does not clip its cells, print all four
  // non-matching labels on top of the row that followed them. Reading the displayed rows' own
  // text is what catches that: the count above cannot, since the smeared rows were themselves
  // zero-height and so were never counted.
  const shown = await page.evaluate((selector) => {
    const out: string[] = [];
    for (const row of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      if (row.style.display === "none") continue;
      out.push((row.textContent ?? "").replace(/\s+/g, " ").trim());
    }
    return out;
  }, GRID_ROW);
  expect(shown.length).toBe(during);
  for (const name of ["Design system", "Backend API", "QA pass", "Launch"]) {
    expect(shown.some((text) => text.includes(name)), `${name} is not painted`).toBe(false);
  }

  // Escape in the search box clears the query and restores every row.
  await search.press("Escape");
  await settle(page);
  const after = await visibleRowCount(page);
  expect(after).toBe(before);
  const cleared = await visibility(page, ["design", "backend", "qa", "launch"]);
  expect(Object.values(cleared).every((v) => v)).toBe(true);
});
