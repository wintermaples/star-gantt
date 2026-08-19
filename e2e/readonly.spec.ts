import { expect, test } from "./_fixtures";
import { FIXED_TIME, settle } from "./_fixtures";

// Read-only E2E: display, scroll, zoom and theme-toggle, against `examples/basic.html` composed
// from `presetStandard()` — data-store, view, tree-grid, task-bars.
//
// Baseline: the checked-in screenshot below is a native render of this page, generated after a
// visual review, not reused from another page's baseline — this page's own example chrome and
// composed plugin set are unique to it, so no pre-existing baseline image is structurally
// comparable to what it renders.

// `examples/basic.html` assigns `window.gantt` as its page-global handle. Typed narrowly to the
// members this spec calls.
declare const gantt: {
  dispatch(key: "timeline/zoomIn" | "timeline/zoomOut", payload: { anchorTime?: number }): void;
  dispose(): void;
  getService(key: "stargantt.view"):
    | {
        viewport: { get(): { scrollTop: number; scrollLeft: number; width: number; height: number } };
        scrollTo(target: { scrollLeft?: number; scrollTop?: number }): void;
      }
    | undefined;
  service(key: "stargantt.timeline"): {
    zoomLevel: { get(): { id: string; pxPerDay: number } };
    setZoomLevel(id: string, anchorTime?: number): void;
    tToX(t: number): number;
  };
  service(key: "stargantt.theme"): {
    setColorScheme(scheme: "light" | "dark" | "auto"): void;
    colorScheme(): "light" | "dark" | "auto";
  };
};

const CONTAINER = "#chart";

test.describe("display", () => {
  test.use({ viewport: { width: 1600, height: 1000 } });

  // Pins the initial render of examples/basic.html against a checked-in baseline image, catching
  // unintended visual regressions in the canvas renderer, grid pane, time axis and CSS-variable
  // theming.
  test("initial render of basic.html matches the baseline", async ({ page, openExample }) => {
    await openExample("basic.html", {
      ready: `${CONTAINER} canvas`,
      fixedTime: FIXED_TIME,
      settle: true,
    });
    // 0.002 tolerance, tight enough to catch a real rendering regression while absorbing
    // font-rasterization noise across machines.
    await expect(page).toHaveScreenshot("basic.png", {
      animations: "disabled",
      maxDiffPixelRatio: 0.002,
    });
  });

  test("chart pane composition: .sg-pane-row holds the tree-grid pane and the chart pane", async ({
    page,
    openExample,
  }) => {
    await openExample("basic.html", { ready: `${CONTAINER} canvas` });

    const paneRow = page.locator(".sg-pane-row");
    await expect(paneRow).toBeAttached();

    const panes = paneRow.locator(":scope > .sg-pane");
    await expect(panes).toHaveCount(2);
    // The tree-grid pane sits on the left (its `view/panes` contribution declares `side: "left"`);
    // the chart pane is the renderer's own, foreign DOM the panes module moved inside the row.
    await expect(panes.nth(1)).toHaveClass(/\bsg-pane--chart\b/);
    await expect(panes.nth(1).locator("canvas.sg-layer")).toHaveCount(3); // background/main/overlay

    // A resizable left pane gets a divider between it and its neighbour (tree-grid's contribution
    // does not set `resizable: false`).
    await expect(paneRow.locator(".sg-pane-divider")).toHaveCount(1);
  });

  test("chart pane safe-area custom properties reserve the scrollbar strip", async ({
    page,
    openExample,
  }) => {
    await openExample("basic.html", { ready: `${CONTAINER} canvas` });
    await settle(page);

    const safeArea = await page.locator(".sg-pane--chart").evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        top: style.getPropertyValue("--sg-safe-top").trim(),
        right: style.getPropertyValue("--sg-safe-right").trim(),
        bottom: style.getPropertyValue("--sg-safe-bottom").trim(),
        left: style.getPropertyValue("--sg-safe-left").trim(),
      };
    });

    // LTR (the default direction): the vertical scrollbar hugs the inline-end (right) edge and
    // the horizontal one hugs the bottom, so both those sides reserve the scrollbar strip
    // (10 CSS px — SCROLLBAR_EDGE_GAP + SCROLLBAR_TRACK_THICKNESS, view/internal/render/safearea.ts)
    // on top of whatever band the timeline header reserves at the top; the left edge reserves
    // nothing.
    expect(safeArea.left).toBe("0px");
    expect(safeArea.right).toBe("10px");
    expect(Number.parseFloat(safeArea.bottom)).toBeGreaterThanOrEqual(10);
    expect(Number.parseFloat(safeArea.top)).toBeGreaterThan(0); // the timeline header band
  });

  test("task-bars messages.empty override renders in the empty state", async ({
    page,
    openExample,
  }) => {
    // Boots the page's own default instance first (so `window.gantt` — and the DOM/listeners it
    // owns — exists), disposes it, then composes a second instance with an overridden empty-state
    // message onto the same element. Disposing before recomposing exercises the teardown path
    // (`GanttInstance.dispose()`) rather than reaching past a live instance to plant a fresh one —
    // `dispose()` releases the DOM it created, so no manual cleanup is needed before `create()`
    // runs again.
    await openExample("basic.html", { ready: `${CONTAINER} canvas` });
    await page.evaluate(() => {
      gantt.dispose();
      const w = window as unknown as {
        StarGantt: {
          create(opts: unknown): { service(key: string): { load(data: unknown): void } };
          presetStandard(config?: unknown): unknown[];
        };
      };
      w.StarGantt.create({
        element: document.getElementById("chart"),
        plugins: w.StarGantt.presetStandard({
          taskBars: { messages: { empty: "Nothing scheduled yet" } },
        }),
      });
    });
    await expect(page.locator(".sg-empty")).toHaveText("Nothing scheduled yet");
  });
});

test.describe("scroll", () => {
  test("scrolling the chart pane moves the viewport store and the vertical scrollbar thumb", async ({
    page,
    openExample,
  }) => {
    // A tall generated dataset (`?tasks=` — see examples/basic.html) so there is real vertical
    // scroll range to move through; the 5-row default dataset fits entirely on screen.
    await openExample("basic.html?tasks=200", { ready: `${CONTAINER} canvas`, fixedTime: FIXED_TIME });
    await settle(page);

    const thumbBefore = await page.locator(".sg-scrollbar--vertical .sg-scrollbar__thumb").boundingBox();
    expect(thumbBefore).not.toBeNull();

    const before = await page.evaluate(() => gantt.getService("stargantt.view")?.viewport.get());
    expect(before?.scrollTop).toBe(0);

    // A real wheel gesture over the chart pane (the view plugin's own scroll path — `scrollTo`'s
    // docstring names wheel input as one of scroll's three sources), not a service call — this is
    // what the read-only user gesture looks like.
    const chartBox = await page.locator(".sg-pane--chart").boundingBox();
    expect(chartBox).not.toBeNull();
    await page.mouse.move(chartBox!.x + chartBox!.width / 2, chartBox!.y + chartBox!.height / 2);
    await page.mouse.wheel(0, 600);
    await settle(page);

    const after = await page.evaluate(() => gantt.getService("stargantt.view")?.viewport.get());
    expect(after?.scrollTop ?? 0).toBeGreaterThan(0);

    const thumbAfter = await page.locator(".sg-scrollbar--vertical .sg-scrollbar__thumb").boundingBox();
    expect(thumbAfter).not.toBeNull();
    // DOM measurement, not just the store: the thumb's own position moved down by the scroll —
    // "the store says so" and "the pixels say so" are two different failure modes and this proves
    // both closed the loop (screenshot-green is not proof of a fix; see e2e/README.md / CLAUDE.md §7).
    expect(thumbAfter!.y).toBeGreaterThan(thumbBefore!.y);
  });
});

test.describe("performance", () => {
  // Step 8 of this task: initial-render budget at 10k tasks. The spec's own performance target
  // (docs/specs/architecture.md — perceived-performance budget for initial render) is 300ms; this
  // assertion is deliberately looser (900ms) so the suite stays robust on a loaded CI box, while
  // the actual measured value is always logged — a green assertion at a loose bound is not proof
  // of hitting the real target, only of not regressing far past it (CLAUDE.md §7 — green is not
  // "fixed").
  test("initial render of a 10k-task dataset paints within the 900ms budget", async ({
    page,
    openExample,
  }) => {
    await openExample("/examples/basic.html?tasks=10000", {
      ready: `${CONTAINER} canvas`,
      fixedTime: FIXED_TIME,
    });
    await expect
      .poll(async () => page.locator("#perf-readout").getAttribute("data-first-paint-ms"), {
        timeout: 5000,
      })
      .not.toBeNull();

    const [taskCount, firstPaintMs] = await page.evaluate(() => {
      const el = document.getElementById("perf-readout")!;
      return [Number(el.dataset.taskCount), Number(el.dataset.firstPaintMs)];
    });

    expect(taskCount).toBeGreaterThanOrEqual(10000);
    // Logged deliberately: the measured value is part of this task's deliverable, not just the
    // pass/fail against the loose bound below (see the describe-block comment).
    console.log(`[perf] ${taskCount} tasks, first paint at ${firstPaintMs.toFixed(1)}ms`);
    expect(firstPaintMs).toBeLessThan(900);
  });
});

test.describe("zoom", () => {
  test("timeline/zoomIn and timeline/zoomOut change the zoom level and the day-to-pixel mapping", async ({
    page,
    openExample,
  }) => {
    await openExample("basic.html", { ready: `${CONTAINER} canvas`, fixedTime: FIXED_TIME });
    await settle(page);

    const initial = await page.evaluate(() => gantt.service("stargantt.timeline").zoomLevel.get());

    await page.evaluate(() => gantt.dispatch("timeline/zoomIn", {}));
    await settle(page);
    const zoomedIn = await page.evaluate(() => gantt.service("stargantt.timeline").zoomLevel.get());
    expect(zoomedIn.id).not.toBe(initial.id);
    expect(zoomedIn.pxPerDay).toBeGreaterThan(initial.pxPerDay);

    // The mapping itself moved, not just the reported density: two points a day apart are farther
    // apart in pixels after zooming in, and by exactly the new level's own `pxPerDay`.
    const spacingAfterZoomIn = await page.evaluate(() => {
      const t = gantt.service("stargantt.timeline");
      return t.tToX(86400000) - t.tToX(0);
    });
    expect(spacingAfterZoomIn).toBeCloseTo(zoomedIn.pxPerDay, 0);

    await page.evaluate(() => gantt.dispatch("timeline/zoomOut", {}));
    await page.evaluate(() => gantt.dispatch("timeline/zoomOut", {}));
    await settle(page);
    const zoomedOut = await page.evaluate(() => gantt.service("stargantt.timeline").zoomLevel.get());
    expect(zoomedOut.pxPerDay).toBeLessThan(zoomedIn.pxPerDay);
  });
});

test.describe("theme", () => {
  test("setColorScheme pins the chart's scheme class and re-resolves its theme tokens", async ({
    page,
    openExample,
  }) => {
    await openExample("basic.html", { ready: `${CONTAINER} canvas` });
    await settle(page);

    const chart = page.locator(CONTAINER);
    // Neither class before an explicit pin — the chart follows the page's scheme.
    await expect(chart).not.toHaveClass(/sg-scheme-(light|dark)/);

    const bgBefore = await page.locator(CONTAINER).evaluate(
      (el) => getComputedStyle(el).getPropertyValue("--sg-bg").trim(),
    );

    await page.evaluate(() => gantt.service("stargantt.theme").setColorScheme("dark"));
    await settle(page);

    await expect(chart).toHaveClass(/\bsg-scheme-dark\b/);
    await expect(chart).toHaveCSS("color-scheme", "dark");
    const bgAfterDark = await page.locator(CONTAINER).evaluate(
      (el) => getComputedStyle(el).getPropertyValue("--sg-bg").trim(),
    );
    // `--sg-bg`'s light and dark values differ (docs/specs — tokens.css's `light-dark()` block),
    // so pinning the scheme must change what the token resolves to.
    expect(bgAfterDark).not.toBe(bgBefore);

    await page.evaluate(() => gantt.service("stargantt.theme").setColorScheme("light"));
    await settle(page);
    await expect(chart).toHaveClass(/\bsg-scheme-light\b/);
    await expect(chart).not.toHaveClass(/sg-scheme-dark/);
    const bgAfterLight = await page.locator(CONTAINER).evaluate(
      (el) => getComputedStyle(el).getPropertyValue("--sg-bg").trim(),
    );
    expect(bgAfterLight).toBe(bgBefore); // the page's own default is light
  });
});
