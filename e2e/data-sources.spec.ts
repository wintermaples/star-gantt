import { expect, test } from "./_fixtures";
import type { Page } from "@playwright/test";

// E2E for examples/data-sources.html: the opt-in `stargantt.data-sync` facade's REST/GraphQL
// source area and lazy-load (backlog paging) area, exercised through an in-page mock `fetch` over
// an in-memory backend — no real network.
//
// data-sync is one opt-in facade covering the source area
// (`sync.load()`/`sync.sync()`/`sync.flush()`/`sync.pending()`/`sync.setFilter()`), source
// switching (`sync.sources.activate()`/`sync.sources.active()`), and the backlog
// (`sync.lazy.ensureRange()`/`sync.lazy.loadedPages()`/`sync.lazy.total()`/
// `sync.lazy.applyChanges()`). The page exposes its chart through `window.gantt`, matching every
// other example page, and its events flow through the flat `sync/*` namespace
// (`sync/sourceSynced`, `sync/sourceRolledBack`, `sync/lazyRangeLoaded`, `sync/lazyChangesApplied`
// — this page subscribes to all four to refresh its own readouts). Scroll-driven paging below is
// driven by the page itself through `ViewService.scrollTo({ scrollTop })` and `view/scrolled`
// (view.md — "programmatic scroll: instant, clamped like wheel input").
//
// The mock backend's dataset is authored so the scenarios below are checkable end-to-end: T6/T7
// exist only on the server before a load; the queued delta revision adds T8 and removes T7;
// "migration" as a server-side filter query matches "Data migration" (T4) and the root "Platform
// migration" (P, kept as T4's ancestor) while excluding "Requirements" (T1); the backlog is 60 rows
// paged 20 at a time. Every count/id assertion below was checked against the page's own dataset() /
// backend.tasks / backend.backlog literals.
//
// The injected failures are the reason this spec also asserts the console stays clean: failures
// must surface in the page's own status readout, never as `console.error`.
//
// No screenshot assertions here — this spec covers data flow and status-readout text only.

const PAGE = "data-sources.html";
const PANE = ".sg-pane--chart";
const STATUS = "#status";

declare const gantt: {
  service(key: "stargantt.data"): {
    getTask(id: string): { id: string; name: string; start: number; end: number } | undefined;
  };
  service(key: "stargantt.view"): {
    scrollTo(target: { scrollLeft?: number; scrollTop?: number }): void;
  };
};

/** Whether the store currently holds a task, read through the page's own `window.gantt`. */
async function hasTask(page: Page, id: string): Promise<boolean> {
  return page.evaluate((taskId) => gantt.service("stargantt.data").getTask(taskId) !== undefined, id);
}

/** The stored start timestamp of a task, or `null` when it is not in the store. */
async function taskStart(page: Page, id: string): Promise<number | null> {
  return page.evaluate((taskId) => {
    const task = gantt.service("stargantt.data").getTask(taskId);
    return task === undefined ? null : task.start;
  }, id);
}

/** Opens the page with the mock transport's latency at zero, collecting `console.error` output. */
async function open(page: Page, openExample: import("./_fixtures").OpenExample): Promise<string[]> {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await openExample(PAGE, { ready: `${PANE} canvas` });
  await page.locator("#latency").fill("0");
  return consoleErrors;
}

test("REST snapshot load, delta sync and server-side filter run through the mock transport", async ({
  page,
  openExample,
}) => {
  const consoleErrors = await open(page, openExample);

  // The page's local cache is a revision behind the backend: T6/T7 exist only on the server.
  expect(await hasTask(page, "T6"), "T6 before the load").toBe(false);

  await page.locator("#load-btn").click();
  await expect(page.locator(STATUS)).toContainText("Snapshot loaded");
  expect(await hasTask(page, "T6"), "T6 after the snapshot load").toBe(true);
  expect(await hasTask(page, "T7"), "T7 after the snapshot load").toBe(true);

  // The load handed back a sync token, so the next call takes the delta path: the queued
  // revision adds T8 and removes T7.
  await page.locator("#sync-btn").click();
  await expect(page.locator(STATUS)).toContainText("Sync (delta mode)");
  expect(await hasTask(page, "T8"), "T8 added by the delta").toBe(true);
  expect(await hasTask(page, "T7"), "T7 removed by the delta").toBe(false);

  // The server-side filter narrows what the backend returns; the parent is kept for tree context.
  // "Data migration" (T4) matches "migration"; the root "Platform migration" (P) is T4's ancestor
  // and is also a direct name match; "Requirements" (T1) does not match.
  await page.locator("#filter-input").fill("migration");
  await page.locator("#filter-btn").click();
  await expect(page.locator(STATUS)).toContainText("Server-side filter");
  expect(await hasTask(page, "T4"), "matching task after the filtered load").toBe(true);
  expect(await hasTask(page, "P"), "parent of a match").toBe(true);
  expect(await hasTask(page, "T1"), "non-matching task after the filtered load").toBe(false);

  expect(consoleErrors, "console.error output").toEqual([]);
});

test("the GraphQL source serves the same chart once it is made active", async ({ page, openExample }) => {
  const consoleErrors = await open(page, openExample);

  await page.locator("#source-select").selectOption("graphql");
  await expect(page.locator(STATUS)).toContainText('Active source is now "graphql"');

  await page.locator("#load-btn").click();
  await expect(page.locator(STATUS)).toContainText('Snapshot loaded from "graphql"');
  expect(await hasTask(page, "T6"), "T6 loaded over GraphQL").toBe(true);

  expect(consoleErrors, "console.error output").toEqual([]);
});

test("a local edit is pending, and a rejected push rolls it back", async ({ page, openExample }) => {
  const consoleErrors = await open(page, openExample);

  await page.locator("#load-btn").click();
  await expect(page.locator(STATUS)).toContainText("Snapshot loaded");

  const before = await taskStart(page, "T3");
  expect(before).not.toBeNull();

  // The move is one user transaction. `autoSchedule.enabled` defaults to `false` (scheduling.md
  // §11.2 — "composed, propagation off"), so this composition (no scheduling override) does not
  // cascade the edit to T3's FS-linked downstream tasks; the pending count is asserted as "at
  // least one update, nothing created or removed" rather than pinned to an exact count, since
  // data-sync's own change-tracking granularity (e.g. whether it coalesces) is not part of its
  // published contract.
  await page.locator("#edit-btn").click();
  await expect(page.locator("#pending-out")).toHaveText(/^pending: 0 creates, [1-9]\d* updates, 0 removes$/);
  expect(await taskStart(page, "T3"), "the optimistic edit is already in the store").toBe(
    (before as number) + 86400000,
  );

  // Arm the injected failure: the push is rejected, so the taken batch is rolled back.
  await page.locator("#fail-next").check();
  await page.locator("#flush-btn").click();
  await expect(page.locator(STATUS)).toContainText("rolled back");
  expect(await taskStart(page, "T3"), "the rollback restored the pre-edit value").toBe(before);
  await expect(page.locator("#pending-out")).toHaveText("pending: 0 creates, 0 updates, 0 removes");

  // The failure was reported in the page's own status readout, not the console.
  expect(consoleErrors, "console.error output").toEqual([]);

  // A second, unarmed flush after re-editing succeeds.
  await page.locator("#edit-btn").click();
  await page.locator("#flush-btn").click();
  await expect(page.locator(STATUS)).toContainText(/Pushed 0 creates, [1-9]\d* updates, 0 removes/);
  await expect(page.locator("#pending-out")).toHaveText("pending: 0 creates, 0 updates, 0 removes");
});

test("the backlog pages in on demand and accepts streamed changes", async ({ page, openExample }) => {
  const consoleErrors = await open(page, openExample);

  expect(await hasTask(page, "BL-01"), "backlog row before any paging").toBe(false);

  await page.locator("#page-btn").click();
  await expect(page.locator(STATUS)).toContainText("Fetched 1 backlog page(s)");
  await expect(page.locator("#lazy-out")).toHaveText("pages loaded: 1, total: 60 rows");
  expect(await hasTask(page, "BL-01"), "first page row").toBe(true);
  expect(await hasTask(page, "BL-20"), "last row of the first page").toBe(true);
  expect(await hasTask(page, "BL-21"), "row of the not-yet-fetched second page").toBe(false);

  // A streamed batch applies as ordinary store patches — no request, no rebuild.
  await page.locator("#stream-btn").click();
  await expect(page.locator(STATUS)).toContainText("0 added, 1 updated, 1 removed");
  expect(await hasTask(page, "BL-05"), "row removed by the streamed batch").toBe(false);

  // Scroll-driven paging: reaching the last loaded row fetches the next page at its real dataset
  // offset (the page drives this itself via `view/scrolled`, not `lazyLoad.followViewport` — see
  // this file's header note).
  await page.locator("#auto-page-toggle").check();
  await page.evaluate(() => {
    gantt.service("stargantt.view").scrollTo({ scrollTop: 10000 });
  });
  await expect(page.locator("#lazy-out")).toHaveText("pages loaded: 2, total: 60 rows");
  expect(await hasTask(page, "BL-21"), "row of the scroll-fetched second page").toBe(true);

  // A full snapshot load resets the paging bookkeeping (the store was replaced wholesale).
  await page.locator("#load-btn").click();
  await expect(page.locator(STATUS)).toContainText("Snapshot loaded");
  await expect(page.locator("#lazy-out")).toHaveText("pages loaded: 0, total: unknown");

  expect(consoleErrors, "console.error output").toEqual([]);
});
