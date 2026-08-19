import { expect, test } from "./_fixtures";
import { settle } from "./_fixtures";
import type { Page } from "@playwright/test";

// E2E for examples/resources-load-chart.html: the `stargantt.resource` plugin's `loadChart` nest
// (docs/specs/plugins/resource.md §3.6/§6.5) — the aggregate band, the per-resource lanes, the
// bottom-region strip layout they share with the panes plugin, the y-axis's round-tick guarantee,
// and the height/visibility service surface. Grouped by BEHAVIORAL claim rather than by page
// section.
//
// Scope: this page also hosts a side-panel / edit-dialog / view-mode-chrome suite ("editing in
// panel dispatches a command") that has nothing to do with the load chart. That suite is
// deliberately NOT covered here: e2e/interaction.spec.ts already exercises the interaction
// plugin's `sidePanel`/`editDialog` nests (confirmed by grep before writing this file), and
// covering it a second time on this page would be pure duplication of a different plugin's
// contract, not this file's job.
//
// Overlap with e2e/resource.spec.ts (read in full first): that file already covers band/lanes/
// resource-view stacking order, the heatmap's corner placement, lanes-strip visibility/height
// toggling including restore-last-height, and overallocations()/utilizationReport() basic
// agreement — all on examples/resource.html's 3-task/3-resource set. Its own header explicitly
// lists as OUT OF SCOPE there (so covered here instead, on this richer 6-task/3-resource/
// 8-assignment page): the y-scale round-tick ladder, gutter-label layout, the `resizable: false`
// divider suppression, and axis/lane-name DOM structure. This file also adds bottom-region layout
// invariants and the height-accessor clamp that resource.spec.ts never exercises at all.
//
// Rendering surface (verified by reading the real source before writing any selector,
// packages/plugins/resource/src/internal/load-chart/band-view.ts's header comment and its
// `mount()`): the band paints bars/overload/capacity entirely on ONE canvas inside
// `.sg-load-chart` (resource.md §3.6 — resource.spec.ts's header notes this too), so those
// assertions are a canvas colour-sampling probe below rather than a DOM-class check. Gridlines are
// ALSO canvas-only (no `.sg-load-chart__gridline` DOM element exists — grepped and confirmed
// absent), so gridline counts are dropped; only the DOM axis LABELS
// (`.sg-load-chart__axis-label`, real DOM, gutter-hosted) are asserted. The in-plot axis fallback
// (zero-width gutter, "gantt" view mode) is ALSO canvas-only (`axisHost.remove()` on that
// transition, read in band-view.ts), so that fallback is asserted as "the DOM axis element is
// gone".
//
// API surface (architecture.md §4): the height/visibility members live on
// `stargantt.utilization` (resource.md §1.2/§1.3); viewport comes from `stargantt.view`'s
// `viewport` store; bar-centre math is not needed here (no bar-click assertions are in this
// file's scope).
//
// No screenshot assertions: this spec has no baseline, and inventing one is out of scope here —
// every visual claim is a functional/DOM/canvas-pixel assertion.
//
// This page rebuilds the whole `gantt` instance (`dispose()` + a fresh `create()`) on every
// lane/total/resizable/dialog toolbar toggle, since those fields are setup-time-only (see the
// page's own header comment) — every helper that flips such a toggle waits for the new instance's
// canvas to remount rather than assuming a live in-place update.

const PAGE = "resources-load-chart.html";
const PANE = ".sg-pane--chart";
const GRID = ".sg-pane--grid";
const BAND = ".sg-load-chart";
const LANES = ".sg-load-lanes";

declare const gantt: {
  service(key: "stargantt.utilization"): {
    bandHeight(): number;
    setBandHeight(px: number): void;
    lanesHeight(): number;
    setLanesHeight(px: number): void;
  };
  service(key: "stargantt.data"): {
    load(input: {
      tasks: { id: string; name: string; start: number; end: number }[];
      resources?: { id: string; name: string; capacity: number }[];
    }): void;
  };
  service(key: "stargantt.rows"): {
    rowCount(): number;
    totalHeight(): number;
  };
  service(key: "stargantt.view"): {
    viewport: { get(): { scrollLeft: number; scrollTop: number; width: number; height: number } };
    scrollTo(target: { scrollLeft?: number; scrollTop?: number }): void;
  };
  on(type: "view/bottomPaneResized", fn: (e: { id: string; height: number }) => void): void;
  dispatch(cmd: string, payload?: unknown): void;
};

async function boot(page: Page, openExample: import("./_fixtures").OpenExample): Promise<void> {
  await openExample(PAGE, { ready: `${PANE} canvas` });
  await settle(page);
}

/** Waits for layout to settle after a rebuild/toggle (see e2e/resource-assign.spec.ts's copy for
 *  the full rationale — the tree-grid pane and the view's bottom region both resize through a
 *  `ResizeObserver`, so this needs box-stability polling, not a fixed frame count). */
async function settleLayout(page: Page, selectors: readonly string[]): Promise<void> {
  await page.evaluate(async (list: readonly string[]) => {
    const frame = (): Promise<void> => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const read = (): string | null => {
      const parts: string[] = [];
      for (const selector of list) {
        const el = document.querySelector(selector);
        if (el === null) return null;
        const box = el.getBoundingClientRect();
        parts.push(`${String(box.x)},${String(box.y)},${String(box.width)},${String(box.height)}`);
      }
      return parts.join("|");
    };
    let previous = read();
    if (previous === null) return;
    for (let i = 0; i < 120; i += 1) {
      await frame();
      const current = read();
      if (current !== null && current === previous) return;
      previous = current;
    }
  }, selectors);
}

/** Clicks a toolbar toggle that triggers this page's dispose()+create() rebuild, then waits for
 *  the new instance's chart canvas to remount. */
async function rebuildVia(page: Page, buttonSelector: string): Promise<void> {
  await page.locator(buttonSelector).click();
  await expect(page.locator(`${PANE} canvas`).first()).toBeVisible();
  await settle(page);
}

test.describe("boot", () => {
  test("boots with the band, the lanes and no page errors, both bottom strips after the pane row", async ({
    page,
    openExample,
  }) => {
    await boot(page, openExample);
    await expect(page.locator(BAND)).toBeVisible();
    await expect(page.locator(LANES)).toBeVisible();

    const order = await page.evaluate(() => {
      const row = document.querySelector(".sg-pane-row");
      const region = document.querySelector(".sg-bottom-region");
      if (row === null || region === null) throw new Error("pane row or bottom region missing");
      const strips = Array.from(document.querySelectorAll(".sg-bottom-pane"));
      return {
        regionAfterRow: row.compareDocumentPosition(region) === Node.DOCUMENT_POSITION_FOLLOWING,
        stripCount: strips.length,
        firstHoldsBand: strips[0]?.querySelector(".sg-load-chart") !== null,
        secondHoldsLanes: strips[1]?.querySelector(".sg-load-lanes") !== null,
      };
    });
    expect(order.regionAfterRow).toBe(true);
    // The reading order is preserved: band strip first, lanes strip second.
    expect(order.stripCount).toBe(2);
    expect(order.firstHoldsBand).toBe(true);
    expect(order.secondHoldsLanes).toBe(true);
  });
});

test.describe("bottom region layout", () => {
  test("the region is a full-width sibling below the pane row, and the grid body/chart canvas end on the same line", async ({
    page,
    openExample,
  }) => {
    await boot(page, openExample);

    const layout = await page.evaluate(() => {
      const rect = (selector: string): DOMRect => {
        const el = document.querySelector(selector);
        if (el === null) throw new Error(`${selector} is missing`);
        return el.getBoundingClientRect();
      };
      const row = document.querySelector(".sg-pane-row");
      if (row === null || row.parentElement === null) throw new Error("the pane row is missing");
      return {
        root: row.parentElement.getBoundingClientRect(),
        row: rect(".sg-pane-row"),
        region: rect(".sg-bottom-region"),
        gridBody: rect(".sg-pane--grid .sg-grid-body"),
        canvas: rect(".sg-pane--chart canvas.sg-layer"),
      };
    });

    expect(Math.abs(layout.region.top - layout.row.bottom)).toBeLessThanOrEqual(2);
    expect(Math.abs(layout.region.width - layout.root.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(layout.region.bottom - layout.root.bottom)).toBeLessThanOrEqual(2);
    // The chart canvas and the grid body share one vertical extent inside the same root, rather
    // than diverging in height as separately-sized surfaces would.
    expect(Math.abs(layout.gridBody.height - layout.canvas.height)).toBeLessThanOrEqual(2);
    expect(Math.abs(layout.gridBody.bottom - layout.canvas.bottom)).toBeLessThanOrEqual(2);
  });

  test("the same guarantee under scroll: the grid and the chart run out of scroll at the same place", async ({
    page,
    openExample,
  }) => {
    await boot(page, openExample);

    // The default six tasks don't overflow a ~560px pane, so replace them with enough rows to
    // force real scrolling, loaded directly through the public data service. Resources are kept
    // (not dropped) so the load chart's band/lanes stay populated rather than erroring on an empty
    // pool mid-session.
    await page.evaluate(() => {
      const DAY = 86_400_000;
      const T0 = Date.now();
      const tasks = [];
      for (let i = 0; i < 60; i += 1) {
        tasks.push({ id: `t${String(i)}`, name: `Task ${String(i)}`, start: T0 + i * DAY, end: T0 + (i + 2) * DAY });
      }
      gantt.service("stargantt.data").load({
        tasks,
        resources: [
          { id: "alice", name: "Alice", capacity: 1 },
          { id: "bob", name: "Bob", capacity: 1 },
          { id: "carol", name: "Carol", capacity: 0.5 },
        ],
      });
    });
    await expect.poll(() => page.evaluate(() => gantt.service("stargantt.rows").rowCount())).toBeGreaterThan(20);

    await page.evaluate(() => gantt.service("stargantt.view").scrollTo({ scrollTop: 1_000_000 }));
    await expect
      .poll(() => page.evaluate(() => gantt.service("stargantt.view").viewport.get().scrollTop))
      .toBeGreaterThan(0);

    // The row transforms follow the viewport's `scrollTop` one frame behind it, so the very frame
    // that first reports the clamped scroll can still have the rows parked short of where they
    // settle — measuring that frame would read the lag as a layout bug.
    await settleLayout(page, [".sg-pane--grid .sg-grid-body", ".sg-pane--grid .sg-grid-row:last-child"]);

    const parity = await page.evaluate(() => {
      const rows = gantt.service("stargantt.rows");
      const vp = gantt.service("stargantt.view").viewport.get();
      const gridBody = document.querySelector(".sg-pane--grid .sg-grid-body");
      if (gridBody === null) throw new Error("the grid body is missing");
      const bodyRect = gridBody.getBoundingClientRect();
      // The bottommost grid row the virtualizer materialized — at the shared maximum scroll it has
      // to end on the grid body's own bottom edge, as the chart's last row ends on the canvas's.
      let lastRowBottom = 0;
      for (const el of Array.from(document.querySelectorAll(".sg-grid-row"))) {
        lastRowBottom = Math.max(lastRowBottom, el.getBoundingClientRect().bottom);
      }
      return {
        scrollTop: vp.scrollTop,
        viewportHeight: vp.height,
        totalHeight: rows.totalHeight(),
        gridBodyHeight: bodyRect.height,
        gridBodyBottom: bodyRect.bottom,
        lastRowBottom,
      };
    });
    // The chart's clamp: scrollTop stopped exactly at totalHeight − viewportHeight.
    expect(Math.abs(parity.scrollTop - (parity.totalHeight - parity.viewportHeight))).toBeLessThanOrEqual(1);
    // The grid shares that extent, so the same clamp exhausts it too: its body is the viewport's
    // height and the last materialized row ends flush on its bottom edge.
    expect(Math.abs(parity.gridBodyHeight - parity.viewportHeight)).toBeLessThanOrEqual(2);
    expect(Math.abs(parity.lastRowBottom - parity.gridBodyBottom)).toBeLessThanOrEqual(2);
  });
});

test.describe("strip gutter presentation", () => {
  test("each strip's body tracks the chart pane and its gutter hosts the axis / lane names", async ({
    page,
    openExample,
  }) => {
    await boot(page, openExample);

    const columns = await page.evaluate(() => {
      const rect = (selector: string): DOMRect => {
        const el = document.querySelector(selector);
        if (el === null) throw new Error(`${selector} is missing`);
        return el.getBoundingClientRect();
      };
      const within = (inner: DOMRect, outer: DOMRect): boolean =>
        inner.left >= outer.left - 1 &&
        inner.right <= outer.right + 1 &&
        inner.top >= outer.top - 1 &&
        inner.bottom <= outer.bottom + 1;
      const strips = Array.from(document.querySelectorAll(".sg-bottom-pane"), (pane) => ({
        gutter: pane.querySelector(".sg-bottom-pane__gutter")!.getBoundingClientRect(),
        body: pane.querySelector(".sg-bottom-pane__body")!.getBoundingClientRect(),
      }));
      return {
        strips,
        chart: rect(".sg-pane--chart"),
        row: rect(".sg-pane-row"),
        axisInGutter: strips[0] === undefined ? false : within(rect(".sg-load-chart__axis"), strips[0].gutter),
        namesInGutter: strips[1] === undefined ? false : within(rect(".sg-load-lanes__names"), strips[1].gutter),
        axisLabelCount: document.querySelectorAll(".sg-load-chart__axis-label").length,
        laneLabelCount: document.querySelectorAll(".sg-load-lanes__label").length,
      };
    });

    expect(columns.strips).toHaveLength(2);
    for (const strip of columns.strips) {
      expect(Math.abs(strip.body.left - columns.chart.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(strip.body.width - columns.chart.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(strip.gutter.left - columns.row.left)).toBeLessThanOrEqual(1);
    }
    expect(columns.axisInGutter).toBe(true);
    expect(columns.namesInGutter).toBe(true);
    expect(columns.axisLabelCount).toBeGreaterThan(0);
    // Three resources (alice, bob, carol) -> three lane name labels.
    expect(columns.laneLabelCount).toBe(3);
  });

  // A divider drag that resizes the grid pane also drives a live recompute of the gutter/body
  // columns. That recompute path (gutter/body/trailing widths rewritten from the row's live
  // layout) is deliberately NOT covered here via a real-pointer-drag E2E: it's already covered at
  // the unit level in packages/plugins/view/test/panes/bottom-panes.test.ts — "rewrites the
  // columns from the live layout on a divider keyboard step" (line 374) and "rewrites when the row
  // resizes, through a ResizeObserver on the row" (line 397), the latter being the exact mechanism
  // a pointer drag ultimately triggers (the divider drag resizes the pane, the row's
  // ResizeObserver fires, the columns are rewritten) — so a real-drag E2E here would duplicate that
  // coverage through a strictly more expensive and more flake-prone path, for no additional
  // signal.
  //
  // One layout case genuinely has NO cover at either level, recorded here rather than
  // silently dropped: a NONZERO `.sg-bottom-pane__trailing` column (a strip's gutter/body/trailing
  // three-way split when there's a pane to the chart's right, not just its left). This page's
  // `interaction.sidePanel` only opens on demand (it's not a persistent right-hand pane on boot),
  // so nothing in this file's fixed boot state exercises that geometry, and neither does
  // bottom-panes.test.ts's suite — every example there lays out a left-only pane and asserts
  // `trailing: "0px"`. A future task that opens the side panel and re-asserts these columns (or a
  // unit test that lays out a right-side pane) would close this gap; noting it rather than
  // asserting something this page's current state can't actually prove.
});

test.describe("y-axis round ticks", () => {
  test("every rendered tick label is a round multiple of one round step, in minimal decimal form, at more than one band height", async ({
    page,
    openExample,
  }) => {
    await boot(page, openExample);

    const probe = () =>
      page.evaluate(() => {
        const band = document.querySelector(".sg-load-chart");
        const labels = Array.from(document.querySelectorAll(".sg-load-chart__axis-label"), (el) => {
          const r = el.getBoundingClientRect();
          return { text: el.textContent ?? "", top: r.top, bottom: r.bottom, display: (el as HTMLElement).style.display };
        }).filter((l) => l.display !== "none");
        return { bandHeight: band === null ? -1 : band.getBoundingClientRect().height, labels };
      });

    const isMultipleOf = (value: number, step: number): boolean =>
      Math.abs(value / step - Math.round(value / step)) < 1e-6;

    const seenLabelCounts = new Set<number>();
    for (const height of [64, 110, 132]) {
      await page.evaluate((px) => gantt.service("stargantt.utilization").setBandHeight(px), height);
      // `bandHeight()` reads a store that updates synchronously with `setBandHeight()`, but the
      // canvas + axis-label repaint is batched through `createFrameScheduler` (packages/sdk/src/
      // frame/schedule.ts) — one requestAnimationFrame after `schedule()` is called. Polling only
      // on `bandHeight` races that repaint: the height can already read as the new value while the
      // axis labels DOM still shows the previous height's ladder. `settle(page)` (two rAF turns)
      // guarantees the scheduled repaint has fired before the labels are read, and the follow-up
      // poll on `labels.length` is a second belt-and-braces check that the DOM actually holds a
      // populated (re-rendered) axis before the snapshot below is taken.
      await expect.poll(async () => (await probe()).bandHeight).toBe(height);
      await settle(page);
      await expect.poll(async () => (await probe()).labels.length).toBeGreaterThan(0);
      const axis = await probe();
      seenLabelCounts.add(axis.labels.length);
      expect(axis.labels.length).toBeGreaterThanOrEqual(2);

      const values = axis.labels.map((l) => Number(l.text));
      for (const label of axis.labels) {
        // Minimal decimal form: "5", "2.5" — never "3.50", and nothing unparsable.
        expect(label.text).toMatch(/^\d+(\.\d+)?$/);
        expect(String(Number(label.text))).toBe(label.text);
      }
      const ceiling = Math.max(...values);
      const step = ceiling / (axis.labels.length - 1);
      const mantissa = step / Math.pow(10, Math.floor(Math.log10(step)));
      expect([1, 2, 2.5, 5].some((m) => Math.abs(m - mantissa) < 1e-6)).toBe(true);
      for (const value of values) expect(isMultipleOf(value, step)).toBe(true);

      // No two label boxes overlap vertically — they share one axis column.
      const sorted = [...axis.labels].sort((a, b) => a.top - b.top);
      for (let i = 1; i < sorted.length; i += 1) {
        expect(sorted[i]!.top).toBeGreaterThanOrEqual(sorted[i - 1]!.bottom - 0.5);
      }
    }
    // The sweep genuinely covered more than one branch of the tick-count ladder.
    expect(seenLabelCounts.size).toBeGreaterThanOrEqual(2);
  });
});

test.describe("view mode interplay", () => {
  test("the bottom region hides in table view, and the gutter (with its DOM axis) collapses in chart-only view", async ({
    page,
    openExample,
  }) => {
    await boot(page, openExample);

    const probe = () =>
      page.evaluate(() => {
        const region = document.querySelector(".sg-bottom-region");
        const gutter = document.querySelector(".sg-bottom-pane__gutter");
        const shown = (el: Element | null) => el !== null && getComputedStyle(el).display !== "none";
        return {
          regionShown: shown(region),
          gutterWidth: gutter === null ? -1 : gutter.getBoundingClientRect().width,
          axisDomExists: document.querySelector(".sg-load-chart__axis") !== null,
        };
      });

    const split = await probe();
    expect(split.regionShown).toBe(true);
    expect(split.gutterWidth).toBeGreaterThan(0);
    expect(split.axisDomExists).toBe(true);

    // Table view hides the chart pane, and the bottom region follows it.
    await page.locator("#view-grid").click();
    await expect.poll(async () => (await probe()).regionShown).toBe(false);

    // Chart-only view shows the region again; with no left panes the gutter resolves to zero
    // width, and the axis presentation falls back to the canvas-only in-plot overlay — its DOM
    // gutter host is torn down (band-view.ts's `syncAxisGutter`/mount transition).
    await page.locator("#view-gantt").click();
    await expect.poll(async () => (await probe()).regionShown).toBe(true);
    await expect.poll(async () => (await probe()).gutterWidth).toBe(0);
    await expect.poll(async () => (await probe()).axisDomExists).toBe(false);

    // Back to split: the gutter presentation is restored — the switch is not one-way.
    await page.locator("#view-split").click();
    await expect.poll(async () => (await probe()).gutterWidth).toBeGreaterThan(0);
    await expect.poll(async () => (await probe()).axisDomExists).toBe(true);
  });
});

// The toolbar's view modes drive view/setViewMode and follow view/modeChanged — the generic
// toolbar/panel contract behind the view-mode switching the test above already exercises for the
// load-chart-specific bottom region. Kept as its own test rather than folded into that one: the
// two are different claims (a page's generic view-mode chrome vs. this plugin's own bottom-region
// reaction to it) that happen to share a page and a gesture.
test.describe("view-mode toolbar contract", () => {
  test("aria-pressed tri-state, grid width, panel mount stability, the #view-readout text and keyboard activation", async ({
    page,
    openExample,
  }) => {
    await boot(page, openExample);

    // docs/specs/plugins/view.md — view modes are display-only; the grid pane takes the freed
    // width in "grid" mode, and "gantt" hides every side/bottom pane.
    const layout = () =>
      page.evaluate(() => {
        const shown = (el: Element | null): boolean | null =>
          el === null ? null : getComputedStyle(el).display !== "none";
        const panel = document.querySelector(".sg-side-panel")?.closest(".sg-pane") ?? null;
        const grid = document.querySelector(".sg-pane--grid");
        return {
          chart: shown(document.querySelector(".sg-pane--chart")),
          panel: shown(panel),
          gridWidth: grid === null ? 0 : Math.round(grid.getBoundingClientRect().width),
          // The panel's content stays mounted across every switch — only its visibility changes.
          panelMounted: document.querySelectorAll(".sg-side-panel").length,
        };
      });
    const pressed = () =>
      page.evaluate(() =>
        ["view-split", "view-grid", "view-gantt"].map((id) => document.getElementById(id)?.getAttribute("aria-pressed")),
      );

    const split = await layout();
    expect(split.chart).toBe(true);
    expect(split.panel).toBe(true);
    expect(await pressed()).toEqual(["true", "false", "false"]);

    await page.locator("#view-grid").click();
    await expect.poll(async () => (await layout()).chart).toBe(false);
    const grid = await layout();
    expect(grid.panel).toBe(false);
    expect(grid.gridWidth).toBeGreaterThan(split.gridWidth);
    expect(grid.panelMounted).toBe(split.panelMounted);
    expect(await pressed()).toEqual(["false", "true", "false"]);
    await expect(page.locator("#view-readout")).toContainText("Table");

    await page.locator("#view-gantt").click();
    await expect.poll(async () => (await layout()).chart).toBe(true);
    const gantt = await layout();
    expect(gantt.panel).toBe(false);
    expect(gantt.gridWidth).toBe(0);
    expect(gantt.panelMounted).toBe(split.panelMounted);
    expect(await pressed()).toEqual(["false", "false", "true"]);

    // Keyboard operability: the buttons are real buttons, so Enter activates them.
    await page.locator("#view-split").focus();
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await layout()).panel).toBe(true);
    const back = await layout();
    expect(back.gridWidth).toBe(split.gridWidth);
    expect(await pressed()).toEqual(["true", "false", "false"]);
    await expect(page.locator("#view-readout")).toContainText("Split");
  });
});

test.describe("height service accessors + clamp", () => {
  test("setBandHeight/setLanesHeight drive the strips through the layout's clamp and notify view/bottomPaneResized", async ({
    page,
    openExample,
  }) => {
    await boot(page, openExample);

    const heights = () =>
      page.evaluate(() => {
        const svc = gantt.service("stargantt.utilization");
        const strip = (index: number): number => {
          const el = document.querySelectorAll(".sg-bottom-pane")[index];
          return el === undefined ? -1 : el.getBoundingClientRect().height;
        };
        return { band: svc.bandHeight(), lanes: svc.lanesHeight(), bandStrip: strip(0), lanesStrip: strip(1) };
      });

    const initial = await heights();
    expect(initial.band).toBeGreaterThan(0);
    expect(initial.lanes).toBeGreaterThan(0);
    expect(Math.abs(initial.bandStrip - initial.band)).toBeLessThanOrEqual(1);
    expect(Math.abs(initial.lanesStrip - initial.lanes)).toBeLessThanOrEqual(1);

    await page.evaluate(() => {
      const w = window as unknown as { __resizeEvents?: { id: string; height: number }[] };
      w.__resizeEvents = [];
      gantt.on("view/bottomPaneResized", (e) => w.__resizeEvents!.push({ id: e.id, height: e.height }));
      gantt.service("stargantt.utilization").setBandHeight(100);
      gantt.service("stargantt.utilization").setLanesHeight(48);
    });
    await expect.poll(async () => (await heights()).band).toBe(100);
    await expect.poll(async () => (await heights()).lanes).toBe(48);
    expect(
      await page.evaluate(() => (window as unknown as { __resizeEvents?: { id: string; height: number }[] }).__resizeEvents),
    ).toEqual([
      { id: "stargantt.load-chart:total", height: 100 },
      { id: "stargantt.load-chart:lanes", height: 48 },
    ]);

    // The row alignment holds through a programmatic resize too.
    const aligned = await page.evaluate(() => {
      const gridBody = document.querySelector(".sg-pane--grid .sg-grid-body");
      const canvas = document.querySelector(".sg-pane--chart canvas.sg-layer");
      if (gridBody === null || canvas === null) throw new Error("a surface is missing");
      return { grid: gridBody.getBoundingClientRect().bottom, canvas: canvas.getBoundingClientRect().bottom };
    });
    expect(Math.abs(aligned.grid - aligned.canvas)).toBeLessThanOrEqual(2);

    // The interactive floor (max(minHeight, 24)) applies to a positive value; exactly 0 is a
    // release, not a resize, and goes all the way down. Asked for a huge lanes height at
    // the same time (100,000px — the ceiling side of the clamp): the setter itself takes
    // the request, but the layout never lets the pane row (grid + chart) get squeezed below its own
    // `--sg-pane-row-min-height` floor (120px) to make room for it — `lanesHeight()` settles at
    // whatever the remaining space actually is, not the raw requested value.
    await page.evaluate(() => {
      gantt.service("stargantt.utilization").setBandHeight(10);
      gantt.service("stargantt.utilization").setLanesHeight(100_000);
    });
    await expect.poll(async () => (await heights()).band).toBe(24);
    const ceilingClamped = await page.evaluate(() => {
      const row = document.querySelector(".sg-pane-row");
      if (row === null) throw new Error("the pane row is missing");
      return row.getBoundingClientRect().height;
    });
    expect(ceilingClamped).toBeGreaterThanOrEqual(119);

    await page.evaluate(() => gantt.service("stargantt.utilization").setBandHeight(0));
    await expect.poll(async () => (await heights()).band).toBe(0);
  });
});

test.describe("resizable: false", () => {
  test("removes the strip dividers but keeps the height setters working", async ({ page, openExample }) => {
    await boot(page, openExample);
    await expect(page.locator(".sg-pane-divider--horizontal")).toHaveCount(2);

    // Setup-time toggle: rebuilds the whole instance with `resizable: false`.
    await rebuildVia(page, "#resize-toggle");
    await expect(page.locator("#resize-toggle")).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator(".sg-pane-divider--horizontal")).toHaveCount(0);
    await expect(page.locator(BAND)).toBeVisible();
    await expect(page.locator(LANES)).toBeVisible();

    // `resizable` gates only the divider — the command path keeps working, which is what
    // lets a host drive a height the reader cannot drag.
    await page.evaluate(() => gantt.service("stargantt.utilization").setBandHeight(100));
    await expect.poll(async () => page.evaluate(() => gantt.service("stargantt.utilization").bandHeight())).toBe(100);

    await rebuildVia(page, "#resize-toggle");
    await expect(page.locator("#resize-toggle")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".sg-pane-divider--horizontal")).toHaveCount(2);
  });
});

test.describe("overload paint", () => {
  test("the band canvas paints at least two distinct non-background colours — the normal fill and the overload fill", async ({
    page,
    openExample,
  }) => {
    await boot(page, openExample);
    // The first band render is scheduled on lifecycle/ready.
    await settleLayout(page, [`${BAND} canvas`]);

    // Days 8-11 (impl + test + review overlapping) sum units 3.5 > capacity 2.5 (the page's own
    // dataset comment), so the band must paint at least one overload-coloured pixel alongside the
    // normal fill colour. Sampled directly from the canvas (resolveBandColors reads CSS custom
    // properties at paint time — a JS token read cannot see them, per band-view.ts's own doc
    // comment), not asserted by position, since this file doesn't reconstruct the timeline's tToX.
    const colors = await page.evaluate(() => {
      const canvas = document.querySelector(".sg-load-chart canvas") as HTMLCanvasElement | null;
      if (canvas === null) return null;
      const ctx2d = canvas.getContext("2d");
      if (ctx2d === null) return null;
      const data = ctx2d.getImageData(0, 0, canvas.width, canvas.height).data;
      const seen = new Set<string>();
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i]!;
        const g = data[i + 1]!;
        const b = data[i + 2]!;
        const a = data[i + 3]!;
        if (a === 0) continue;
        seen.add(`${String(r)},${String(g)},${String(b)}`);
      }
      // A reddish (overload) pixel: red channel clearly dominant over blue/green.
      let hasReddish = false;
      // A blueish (normal fill) pixel: blue channel clearly dominant over red.
      let hasBlueish = false;
      for (const rgb of seen) {
        const [r, g, b] = rgb.split(",").map(Number) as [number, number, number];
        if (r > b + 30 && r > g + 10) hasReddish = true;
        if (b > r + 20) hasBlueish = true;
      }
      return { distinctColors: seen.size, hasReddish, hasBlueish };
    });
    expect(colors).not.toBeNull();
    expect(colors!.distinctColors).toBeGreaterThan(1);
    expect(colors!.hasReddish).toBe(true);
    expect(colors!.hasBlueish).toBe(true);
  });
});

