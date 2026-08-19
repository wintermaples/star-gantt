import { expect, FIXED_TIME, test } from "./_fixtures";

// Feature E2E for examples/offline-realtime.html.
//
// The page composes ONE OPT-IN `dataSync({ offline, realtime })` call, driven through one
// `gantt.service("stargantt.data-sync")` facade (`sync.offline.*`, `sync.realtime.*`).
//
// ZERO-SERVER E2E POLICY (docs/specs/architecture.md distribution chapter; e2e/README.md;
// e2e/data-sync.spec.ts's header): no real WebSocket/HTTP server is started anywhere in this file.
// The "peer" the realtime tests talk to is `examples/offline-realtime.html`'s in-page
// `createLoopbackHub()` — a plain JS class handed to `StarGantt.webSocketTransport({ webSocket:
// hub.Socket })` as the socket *constructor* (verified by reading the page: `LoopbackSocket` never
// touches `new WebSocket(...)`, only `setTimeout`-based latency simulation) — so this is exactly
// the "client-side simulated transport" shape the zero-server policy allows; no network is
// involved.
//
// This file does NOT duplicate e2e/data-sync.spec.ts's offline round-trip: that suite exercises a
// different page/dataset (`data-sync.html`, a 2-task `localAdapter` source with a manual
// save/reload/restore gesture) and explicitly defers realtime as "unit-only" — because that page
// wires no realtime area at all. This page wires the realtime area, plus a different offline
// lifecycle nuance (auto-save with a 400ms debounce, driven by both local and remote edits) that
// data-sync.spec.ts does not cover.

const PAGE = "offline-realtime.html";

declare const gantt: {
  service(key: "stargantt.data"): {
    getTask(id: string): { name: string; start: number } | undefined;
  };
};

async function task(
  page: import("@playwright/test").Page,
  id: string,
): Promise<{ name: string; start: number } | undefined> {
  return page.evaluate(
    (taskId) => (window as unknown as { gantt: typeof gantt }).gantt.service("stargantt.data").getTask(taskId),
    id,
  );
}

test("remote changes apply, an unchanged echo is suppressed, and a drop reconnects", async ({
  page,
  openExample,
}) => {
  await openExample(PAGE, { fixedTime: FIXED_TIME });

  // The `connect` config option opens the transport at startup; the status readout follows
  // `sync.realtime.status`.
  await expect(page.locator("#rt-status")).toContainText('Connected via "loopback"');

  // An `upsert` of a known id becomes one `task/update`.
  await page.locator("#peer-rename").click();
  await expect(page.locator("#rt-applied")).toContainText("0 added, 1 updated, 0 removed");
  await expect.poll(async () => (await task(page, "design"))?.name).toBe("Design (peer 1)");

  // A row shallow-equal to the current task produces no command at all, so the counts are all
  // zero rather than reporting a no-op update.
  await page.locator("#peer-echo").click();
  await expect(page.locator("#rt-applied")).toContainText("echo suppressed");

  // An `upsert` of an unknown id becomes `task/add`; a `remove` of a known id becomes `task/remove`.
  await page.locator("#peer-add").click();
  await expect.poll(async () => (await task(page, "peer-2"))?.name).toBe("Peer hotfix 2");
  await page.locator("#peer-remove").click();
  await expect.poll(async () => await task(page, "peer-2")).toBeUndefined();

  // An unexpected close schedules an automatic retry, which reopens the loopback socket
  // (data-sync's `RealtimeStatusCause` "reconnect" -> "close"/"open").
  await page.locator("#rt-drop").click();
  await expect(page.locator("#event-log")).toContainText("cause reconnect");
  await expect(page.locator("#rt-status")).toContainText('Connected via "loopback"');
});

test("the peer-offline switch exhausts the retries, and Connect recovers", async ({
  page,
  openExample,
}) => {
  await openExample(PAGE, { fixedTime: FIXED_TIME });
  await expect(page.locator("#rt-status")).toContainText("Connected");

  const offlineSwitch = page.locator("#rt-offline");
  await expect(offlineSwitch).toHaveAttribute("aria-pressed", "false");
  await offlineSwitch.click();
  await expect(offlineSwitch).toHaveAttribute("aria-pressed", "true");

  // Every retry now fails to open: after `maxReconnectAttempts` the status settles on
  // disconnected with cause `close`.
  await page.locator("#rt-drop").click();
  await expect(page.locator("#rt-status")).toContainText("Disconnected", { timeout: 15000 });
  await expect(page.locator("#rt-status")).toContainText("cause: close");

  // A message with nobody connected is reported in the page's own log, never on the console.
  await page.locator("#peer-rename").click();
  await expect(page.locator("#event-log")).toContainText("no client is connected");

  await offlineSwitch.click();
  await page.locator("#rt-connect").click();
  await expect(page.locator("#rt-status")).toContainText('Connected via "loopback"');
});

test("the IndexedDB snapshot saves, clears, auto-saves and restores", async ({
  page,
  openExample,
}) => {
  await openExample(PAGE, { fixedTime: FIXED_TIME });

  // `available()` is the synchronous capability predicate; `persisted()` reports the snapshot.
  await expect(page.locator("#off-status")).toContainText("IndexedDB: available");

  // Auto-save is on, so the bootstrap load itself persists the document.
  await expect(page.locator("#event-log")).toContainText("Snapshot saved: 6 tasks");
  await page.locator("#off-refresh").click();
  await expect(page.locator("#off-status")).toContainText("snapshot: present");

  // Clearing removes it; a restore with nothing stored resolves `{ ok: false }` without touching
  // the store, which the page surfaces as a failed restore rather than an exception.
  await page.locator("#off-clear").click();
  await expect(page.locator("#off-status")).toContainText("clear ok");
  await expect(page.locator("#off-status")).toContainText("snapshot: none");
  await page.locator("#off-restore").click();
  await expect(page.locator("#off-status")).toContainText("restore failed");
  await expect(page.locator("#event-log")).toContainText("restore failed: no snapshot");

  // A remote edit lands in the store and, through auto-save, in the snapshot; restoring it back
  // reloads all five entity lists.
  await page.locator("#peer-shift").click();
  await expect(page.locator("#rt-applied")).toContainText("0 added, 1 updated, 0 removed");
  const shifted = await task(page, "design");
  // The debounced auto-save re-persists the document; the readout is refreshed on demand.
  await expect(page.locator("#event-log p", { hasText: "Snapshot saved" })).toHaveCount(2, {
    timeout: 10000,
  });
  await page.locator("#off-refresh").click();
  await expect(page.locator("#off-status")).toContainText("snapshot: present");

  await page.locator("#off-restore").click();
  await expect(page.locator("#off-status")).toContainText("restore ok (6 tasks)");
  await expect(page.locator("#event-log")).toContainText("Snapshot restored: 6 tasks");
  expect((await task(page, "design"))?.start).toBe(shifted?.start);
});
