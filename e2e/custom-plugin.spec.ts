import { expect, test } from "./_fixtures";
import { settle } from "./_fixtures";
import type { OpenExample } from "./_fixtures";
import type { Page } from "@playwright/test";

// E2E for examples/custom-plugin.html: third-party plugin authoring through the PUBLIC API ONLY
// (architecture.md chapter 8 "Third-party principles" — no back-door APIs, officialness confers no
// runtime privilege), driven entirely by `sdk.md`'s published surface plus core's `PluginContext`.
// State changes are observed through store subscriptions (architecture.md §3.3), a third-party
// plugin publishes its own service via `ctx.provide()`, and the render stack is arbitrated in code
// (`ctx.claimOrder` / `host.orders()`).
//
// The page composes six third-party plugins (`custom.weekend-shading`, `custom.today-line`,
// `custom.today-line-hit-test`, `custom.today-line-tooltip`, `custom.today-marker`,
// `custom.at-risk-badge`) plus one OFFICIAL plugin configured by key
// (`presetStandard({ taskBars: { label } })`). This file covers: the DOM-overlay contract
// (`renderer/domOverlays` — `.sg-dom-overlay`/`.sg-dom-overlays`/`.sg-dom-overlay-item`/
// `data-overlay-id`, per docs/specs/plugins/view.md's extension-point table), scroll-pinning in
// content coordinates, the `taskBars.label` display-option seam, the cached `textWidth()`
// measurement plus the third-party `custom/todayCaptionExtra` extension point one plugin declares
// and another contributes to, the batched `batchRead`/`batchWrite` layout queue, and the
// `claimOrder`/`host.orders()` arbitration registry surfaced through the toolbar.
//
// One test covers a hit-test + tooltip + keyboard command trio: `renderer/hitTest`'s `first`
// strategy declining to the official task-bars tester, `tooltip/content` contributed on equal terms
// with the official provider, and a third-party `ctx.registerCommand` + `keys/bindings`
// contribution.

const PAGE = "custom-plugin.html";
const PANE = ".sg-pane--chart";
const HOST = ".sg-dom-overlay .sg-dom-overlays";
const BADGE_ITEM = `${HOST} .sg-dom-overlay-item[data-overlay-id="custom.at-risk-badge"]`;
const BADGE = `${BADGE_ITEM} .custom-at-risk-badge`;
const MARKER_ITEM = `${HOST} .sg-dom-overlay-item[data-overlay-id="custom.today-marker"]`;
const MARKER = `${MARKER_ITEM} .custom-today-marker`;

type DemoWindow = Window & {
  ganttDemo?: {
    today: {
      time(): number;
      text(): string;
      caption: { get(): string };
      setCaption(text: string): void;
      measurements(): { calls: number; lastWidth: number; lastText: string; strings: string[] };
    };
    badge: {
      replace(): void;
      phases(): string[];
      resetPhases(): void;
    };
    barLabelsDrawn: string[];
    barLabel(task: { id: string; name: string; type?: string; start: number; end: number }): string | undefined;
  };
  gantt?: {
    service(id: "stargantt.view"): {
      viewport: { get(): { scrollTop: number; scrollLeft: number; width: number; height: number } };
      batchRead(fn: () => void): void;
      batchWrite(fn: () => void): void;
    };
    orders(scope: string): readonly { key: string; order: number; pluginId: string }[];
    dispatch(command: string, payload: unknown): void;
  };
};

async function boot(page: Page, openExample: OpenExample): Promise<void> {
  await openExample(PAGE, { ready: `${PANE} canvas` });
  await expect(page.locator(BADGE)).toBeAttached();
  await expect
    .poll(async () => page.evaluate(() => (window as DemoWindow).ganttDemo !== undefined))
    .toBe(true);
}

/**
 * An overlay element's origin relative to the chart pane, paired with the view's own scroll
 * offsets — measured against the pane (not the browser viewport) so document-level scrolling can
 * never masquerade as the overlay moving, and read through `getBoundingClientRect()` (not
 * Playwright's `boundingBox()`) since a clip-hidden element still has a box.
 */
async function sample(page: Page, selector: string): Promise<{ x: number; y: number; scrollTop: number; scrollLeft: number }> {
  return page.evaluate((sel) => {
    const win = window as DemoWindow;
    if (win.gantt === undefined) throw new Error("gantt is not available");
    const el = document.querySelector(sel);
    const pane = document.querySelector(".sg-pane--chart");
    if (el === null) throw new Error(`missing element: ${sel}`);
    if (pane === null) throw new Error("chart pane is missing");
    const rect = el.getBoundingClientRect();
    const paneRect = pane.getBoundingClientRect();
    const vp = win.gantt.service("stargantt.view").viewport.get();
    return { x: rect.left - paneRect.left, y: rect.top - paneRect.top, scrollTop: vp.scrollTop, scrollLeft: vp.scrollLeft };
  }, selector);
}

test("a third-party plugin's DOM overlay is mounted into the renderer-owned wrapper (unchanged public surface)", async ({
  page,
  openExample,
}) => {
  await boot(page, openExample);

  await expect(page.locator(HOST)).toHaveCount(1);
  await expect(page.locator(BADGE_ITEM)).toHaveCount(1);

  await expect(page.locator(BADGE)).toHaveText("At risk");
  await expect(page.locator(BADGE)).toBeVisible();

  const clipped = await page.evaluate((sel) => {
    const host = document.querySelector(sel);
    return host === null ? "" : getComputedStyle(host).overflow;
  }, HOST);
  expect(clipped).toBe("hidden");
});

test("the overlay stays pinned to its content coordinates when the chart scrolls", async ({ page, openExample }) => {
  await boot(page, openExample);
  const before = await sample(page, BADGE);
  expect(before.scrollTop).toBe(0);
  expect(before.scrollLeft).toBe(0);

  // This page's six rows are far shorter than the chart pane, so the vertical axis has nothing to
  // scroll — a downward wheel must leave both the viewport and the badge exactly where they were.
  await page.evaluate(() => {
    const win = window as DemoWindow & { __wheelEvents?: number };
    win.__wheelEvents = 0;
    window.addEventListener("wheel", () => (win.__wheelEvents = (win.__wheelEvents ?? 0) + 1), {
      capture: true,
      passive: true,
    });
  });
  await page.locator(PANE).hover();
  await page.mouse.wheel(0, 200);
  await expect.poll(async () => page.evaluate(() => (window as DemoWindow & { __wheelEvents?: number }).__wheelEvents ?? 0)).toBeGreaterThan(0);
  await settle(page);
  const afterVertical = await sample(page, BADGE);
  expect(afterVertical.scrollTop).toBe(0);
  expect(afterVertical.y).toBeCloseTo(before.y, 0);

  // The horizontal axis does have room, so it is what exercises content-coordinate pinning.
  await page.mouse.wheel(200, 0);
  await expect.poll(async () => (await sample(page, BADGE)).scrollLeft).toBeGreaterThan(0);
  await expect.poll(async () => (await sample(page, BADGE)).x).toBeLessThan(before.x);

  const after = await sample(page, BADGE);
  expect(after.x).toBeCloseTo(before.x - (after.scrollLeft - before.scrollLeft), 0);
  expect(after.scrollTop).toBe(before.scrollTop);
  expect(after.y).toBeCloseTo(before.y, 0);
});

// docs/specs/plugins/task-bars.md-equivalent surface — `taskBars.label` is a display option of an
// OFFICIAL plugin, reached by key through `presetStandard({ taskBars: { label } })` rather than by
// adding a plugin. The page supplies one and records every task it was asked about.
test("a display option handed to an official plugin through the preset reaches it", async ({ page, openExample }) => {
  await boot(page, openExample);

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const demo = (window as DemoWindow).ganttDemo;
        return demo === undefined ? [] : [...new Set(demo.barLabelsDrawn)].sort();
      }),
    )
    .toEqual(["be", "design", "fe", "impl", "plan", "req"]);

  const labels = await page.evaluate(() => {
    const demo = (window as DemoWindow).ganttDemo;
    if (demo === undefined) throw new Error("ganttDemo is not available");
    return {
      leaf: demo.barLabel({ id: "req", name: "Requirements", start: Date.UTC(2024, 0, 8), end: Date.UTC(2024, 0, 12) }),
      summary: demo.barLabel({
        id: "plan",
        name: "Project planning",
        type: "summary",
        start: Date.UTC(2024, 0, 8),
        end: Date.UTC(2024, 0, 15),
      }),
    };
  });
  expect(labels.leaf).toBe("Requirements (4d)");
  // Returning `undefined` is the sanctioned way to leave a bar unlabelled — not an error.
  expect(labels.summary).toBeUndefined();
});

// The today marker (`custom.today-marker`) is placed at the same content x as the canvas-drawn
// today line, offset by `view.timeline.origin: day(-5)` so it lands inside the pane instead of at
// its clipped left edge.
test("the today marker lands inside the chart pane instead of at its clipped left edge", async ({ page, openExample }) => {
  await boot(page, openExample);
  await expect(page.locator(MARKER)).toBeAttached();

  const geometry = await page.evaluate((sel) => {
    const marker = document.querySelector(sel);
    const pane = document.querySelector(".sg-pane--chart");
    if (marker === null) throw new Error(`missing element: ${sel}`);
    if (pane === null) throw new Error("chart pane is missing");
    const markerRect = marker.getBoundingClientRect();
    const paneRect = pane.getBoundingClientRect();
    return { x: markerRect.left - paneRect.left, paneWidth: paneRect.width };
  }, MARKER);

  expect(geometry.x).toBeGreaterThan(20);
  expect(geometry.x).toBeLessThan(geometry.paneWidth - 20);

  // Keyboard access: the marker is focusable and carries the same date text the tooltip shows.
  await expect(page.locator(MARKER)).toHaveAttribute("tabindex", "0");
  await expect(page.locator(MARKER)).toHaveAttribute("aria-label", /^Today: /);
});

// A third-party painter measures its label once per font-and-string pair through
// `ViewService.textWidth()` and lays its caption pill out from the result. The caption always
// includes the `custom/todayCaptionExtra` extension point's contribution from `custom.at-risk-badge`
// ("1 at risk" — the "impl" summary task carries `meta.customAtRisk: true` from first paint), which
// is itself a genuinely distinct mechanism: a third-party plugin (`custom.today-line`) DECLARES its
// own extension point and a second third-party plugin (`custom.at-risk-badge`) contributes to it,
// on exactly the terms an official point would offer.
test("the painter's caption includes the contributed extension-point text and measures it through the cache", async ({
  page,
  openExample,
}) => {
  await boot(page, openExample);

  const measurement = async () =>
    page.evaluate(() => {
      const demo = (window as DemoWindow).ganttDemo;
      if (demo === undefined) throw new Error("ganttDemo is not available");
      return demo.today.measurements();
    });

  await expect.poll(async () => (await measurement()).calls).toBeGreaterThan(0);
  const short = await measurement();
  // "impl" carries `meta.customAtRisk: true`, so the extension point's contribution is present from
  // the very first paint — the caption is never the bare "Today" on this page's dataset.
  expect(short.strings).toEqual(["Today · 1 at risk"]);
  expect(short.lastWidth).toBeGreaterThan(0);

  const toggle = page.locator("#btn-caption");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  await expect.poll(async () => (await measurement()).strings.length).toBe(2);
  const long = await measurement();
  expect(long.strings[1]).toBe("Today · measured caption · 1 at risk");
  expect(long.lastWidth).toBeGreaterThan(short.lastWidth);
  expect(long.calls).toBeGreaterThan(short.calls);

  // Toggling back restores the short caption and its cached width.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect.poll(async () => (await measurement()).lastWidth).toBeCloseTo(short.lastWidth, 3);
  expect((await measurement()).strings).toHaveLength(2); // still only two distinct strings ever measured
});

// `batchRead`/`batchWrite` (view.md's layout queue) drain once per paint pass, every queued read
// before every queued write, regardless of queue order. The page queues deliberately interleaved
// (W0 R0 W1 R1 W2 R2) and prints the order they actually ran in.
test("queued layout reads all run before queued layout writes", async ({ page, openExample }) => {
  await boot(page, openExample);

  await page.locator("#btn-batch").click();
  const readout = page.locator("#readout");
  await expect(readout).toContainText("ran as R0 R1 R2 W0 W1 W2");

  // The badge overlay's own re-placement went through the same queue in the same pass.
  const phases = await page.evaluate(() => {
    const demo = (window as DemoWindow).ganttDemo;
    if (demo === undefined) throw new Error("ganttDemo is not available");
    return demo.badge.phases();
  });
  expect(phases).toEqual(["read", "write"]);
  await expect(page.locator(BADGE)).toBeVisible();
});

// docs/specs/architecture.md §1.2 — the arbitration registries are public core APIs, open to every
// plugin on equal terms: `custom.weekend-shading` and `custom.today-line` claim orders in
// `renderer/layers` alongside the official plugins, and `host.orders(scope)` returns them all in one
// ascending-by-order snapshot, official and third-party claims sitting in the same table.
test("claimOrder registrations from third-party AND official plugins share one orders() registry", async ({
  page,
  openExample,
}) => {
  await boot(page, openExample);

  await page.locator("#btn-orders").click();
  const readout = page.locator("#readout");
  await expect(readout).toContainText("renderer/layers");

  const orders = await page.evaluate(() => {
    const win = window as DemoWindow;
    if (win.gantt === undefined) throw new Error("gantt is not available");
    return win.gantt.orders("renderer/layers");
  });
  const byKey = new Map(orders.map((entry) => [entry.key, entry]));

  expect(byKey.get("custom:weekend-shading")).toMatchObject({ order: 5, pluginId: "custom.weekend-shading" });
  expect(byKey.get("custom:today-line")).toMatchObject({ order: 1000, pluginId: "custom.today-line" });
  // At least one official plugin's layer claim sits in the very same registry.
  const officialEntry = orders.find((entry) => entry.pluginId.startsWith("stargantt."));
  expect(officialEntry).toBeDefined();

  // Sorted ascending by order (architecture.md §1.2's normative introspection rule).
  const sortedOrders = orders.map((entry) => entry.order);
  expect(sortedOrders).toEqual([...sortedOrders].sort((a, b) => a - b));
});

// `renderer/hitTest` (`first` strategy — the official task-bars tester runs first and this
// contribution only sees a hit that the bar tester declined), `tooltip/content` (contributed on
// equal terms with the built-in fallback), a plugin's own `ctx.registerCommand`, and the a11y
// plugin's `keys/bindings` extension point all in one interaction: pressing the today line shows a
// tooltip built from the third-party `custom.today-line` service, and Alt+T runs the very same
// command the toolbar button dispatches.
test("the today line is hit-testable, tooltip-able, and reachable by its own command and Alt+T binding", async ({
  page,
  openExample,
}) => {
  await boot(page, openExample);

  const todayX = await page.evaluate(() => {
    const win = window as DemoWindow;
    const demo = win.ganttDemo;
    if (win.gantt === undefined || demo === undefined) throw new Error("not ready");
    const view = win.gantt.service("stargantt.view");
    const vp = view.viewport.get();
    // `custom.today-line-hit-test`'s target is `timeline.tToX(today.time()) - scrollLeft`; the page
    // exposes `today.time()` but not `timeline` directly, so this reads the same coordinate the
    // marker plugin already renders at (the marker sits at `tToX(today) - 12`, so `+12` recovers it).
    const marker = document.querySelector(".custom-today-marker") as HTMLElement | null;
    if (marker === null) throw new Error("marker not found");
    return parseFloat(marker.style.left) + 12 - vp.scrollLeft;
  });

  const pane = await page.locator(PANE).boundingBox();
  if (pane === null) throw new Error("chart pane not found");
  await page.mouse.click(pane.x + todayX, pane.y + pane.height / 2);

  // The default tooltip trigger is "click" (interaction.md); the today-line tooltip renders a
  // "Today" heading plus the prose date text the `custom.today-line` service computes.
  const todayText = await page.evaluate(() => {
    const demo = (window as DemoWindow).ganttDemo;
    if (demo === undefined) throw new Error("ganttDemo is not available");
    return demo.today.text();
  });
  await expect(page.getByText("Today", { exact: true })).toBeVisible();
  await expect(page.getByText(todayText)).toBeVisible();

  // Alt+T dispatches the same `custom/scroll-to-today` command the toolbar button does.
  await page.mouse.wheel(400, 0); // scroll away first so the command has visible work to do
  await settle(page);
  const scrolledAway = (await page.evaluate(() => {
    const win = window as DemoWindow;
    if (win.gantt === undefined) throw new Error("not ready");
    return win.gantt.service("stargantt.view").viewport.get().scrollLeft;
  })) as number;
  expect(scrolledAway).toBeGreaterThan(0);

  await page.locator(PANE).click(); // move focus/press away from any open tooltip first
  await page.keyboard.press("Alt+T");
  await settle(page);
  const afterShortcut = await page.evaluate(() => {
    const win = window as DemoWindow;
    if (win.gantt === undefined) throw new Error("not ready");
    return win.gantt.service("stargantt.view").viewport.get().scrollLeft;
  });
  // The chart re-centered on today — a different (and, for this dataset, smaller) scroll offset.
  expect(afterShortcut).not.toBe(scrolledAway);
});
