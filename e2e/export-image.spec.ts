import { expect, test } from "./_fixtures";
import { settle } from "./_fixtures";
import type { Page } from "@playwright/test";

// E2E for examples/export-range.html: the `range` option of `stargantt.export`'s image capture
// (`toPng`/`toSvg`, docs/specs/plugins/export.md §1.1 — `"viewport"` | `"full"` | an explicit
// `{ start, end }`), plus the page's own PNG/JPEG UI.
//
// `range` is a per-call option on `toPng()`/`toSvg()` (export.md §1's resolution note: "the design
// card writes `toPng(range)` ... resolved to a per-call options object") — switching it never
// rebuilds the chart, and carries no scroll/collapsed-row bookkeeping or rebuild-in-flight guard.
// Every range switch below is either a plain click on the page's own range buttons (which just flip
// a JS variable) or a direct `{ range }` argument to a service call.
//
// COVERAGE SPLIT WITH e2e/export.spec.ts: that file's "image capture: toPng" / "toSvg" describe
// blocks already prove, against examples/scheduling.html: PNG dimensions matching viewport+header
// band, the JPEG background-substitution behavior (`format: "jpeg"`, default vs. explicit
// `background`), `quality` forwarding by byte-size discrimination, and SVG well-formedness (parses,
// layer groups, header text, vector-only shape counts). None of that is re-proven here — re-testing
// the exact same facade behavior on a second page would only be coverage theater. What genuinely
// differs on THIS page and is covered below:
//   1. the page's own PNG/JPEG export UI (buttons, the JPEG quality <select> and its
//      omitted-vs-explicit call-shape distinction) — export.spec.ts only ever calls the service
//      directly via `page.evaluate`, never through a page's UI;
//   2. the `range: "full"` multi-tile composition and its month-caption-dedup behavior (one
//      caption, one x, across tile seams) — export.spec.ts never exercises `range` at all, always
//      exporting the default viewport;
//   3. an explicit `{ start, end }` object range exporting exactly that span.
// Deliberately not covered here (already covered by export.spec.ts): the standalone "toPng
// width/height matches viewport+header" test, the JPEG background-substitution pixel probe, the
// low-level quality->byte-size discrimination test, and the standalone SVG well-formedness/
// shape-count test.
//
// No screenshot assertions: this page has no baseline image checked in.

const PAGE = "export-range.html";
const CONTAINER = "#chart";
const DAY_MS = 86_400_000;
const T0 = Date.UTC(2026, 7, 3);
const FULL_SPAN_DAYS = 60;
const CUSTOM_SPAN_DAYS = 20;

declare const gantt: {
  service(key: "stargantt.data"): {
    getTask(id: string): { id: string; start: number; end: number } | undefined;
  };
  service(key: "stargantt.view"): {
    viewport: { get(): { width: number; height: number } };
  };
  service(key: "stargantt.timeline"): {
    tToX(t: number): number;
  };
  service(key: "stargantt.rows"): {
    totalHeight(): number;
  };
  service(key: "stargantt.export"): {
    toPng(options?: Record<string, unknown>): Promise<Blob>;
    toSvg(options?: Record<string, unknown>): Promise<string>;
  };
};

async function boot(page: Page, openExample: import("./_fixtures").OpenExample): Promise<void> {
  await openExample(PAGE, { ready: `${CONTAINER} canvas` });
  await expect.poll(async () => page.evaluate(() => gantt.service("stargantt.data").getTask("p1")?.start)).toBe(T0);
  await settle(page);
}

interface ChartGeometry {
  viewportWidth: number;
  viewportHeight: number;
  headerHeight: number;
  pixelRatio: number;
  pxPerDay: number;
  totalHeight: number;
}

/**
 * The on-screen numbers an exported image has to agree with, all read through public services and
 * the stylesheet's own tokens (`stargantt.view`/`stargantt.timeline`/`stargantt.rows`).
 *
 * `pixelRatio` is recovered the way export-image itself recovers it when the option is omitted
 * (export.md §1.1: "the largest `canvas.width / cssWidth` among the renderer's layers"), so the
 * expectations below hold on a HiDPI machine as well as on a 1x one.
 */
async function chartGeometry(page: Page): Promise<ChartGeometry> {
  return page.evaluate((dayMs) => {
    const view = gantt.service("stargantt.view");
    const pane = document.querySelector(".sg-pane--chart");
    if (pane === null) throw new Error("chart pane is missing");
    const vp = view.viewport.get();
    const layers = Array.from(pane.querySelectorAll("canvas")) as HTMLCanvasElement[];
    const ratios = layers
      .map((c) => c.width / c.getBoundingClientRect().width)
      .filter((r) => Number.isFinite(r) && r > 0);
    return {
      viewportWidth: vp.width,
      viewportHeight: vp.height,
      headerHeight: Number.parseFloat(getComputedStyle(pane).getPropertyValue("--sg-header-height")),
      pixelRatio: ratios.length === 0 ? 1 : Math.max(...ratios),
      pxPerDay: gantt.service("stargantt.timeline").tToX(dayMs) - gantt.service("stargantt.timeline").tToX(0),
      totalHeight: gantt.service("stargantt.rows").totalHeight(),
    };
  }, DAY_MS);
}

interface SvgExport {
  parserErrors: number;
  rootName: string;
  width: string | null;
  height: string | null;
  texts: string[];
  /**
   * Every `<text>` with its x resolved into whole-document coordinates. Tiles are emitted as
   * `<g transform="translate(tileX 0)">` groups with their own clip, so a label's own `x`
   * attribute is tile-local and says nothing on its own about where the label lands in the
   * finished image. Resolving the ancestor translations is what makes "the same caption in two
   * tiles" distinguishable from "the same caption painted twice in two different places".
   */
  positioned: { text: string; x: number }[];
}

/** Calls `toSvg()` and parses the markup in the page, so "it parses" is a browser's verdict. */
async function exportSvg(page: Page, options: Record<string, unknown>): Promise<SvgExport> {
  return page.evaluate((opts) => {
    return gantt
      .service("stargantt.export")
      .toSvg(opts)
      .then((svgText) => {
        const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
        const translateX = (el: Element): number => {
          let sum = 0;
          let node: Element | null = el;
          while (node !== null) {
            const match = /translate\(\s*(-?[\d.]+)/.exec(node.getAttribute("transform") ?? "");
            if (match !== null) sum += Number.parseFloat(match[1]!);
            node = node.parentElement;
          }
          return sum;
        };
        return {
          parserErrors: doc.getElementsByTagName("parsererror").length,
          rootName: doc.documentElement.nodeName,
          width: doc.documentElement.getAttribute("width"),
          height: doc.documentElement.getAttribute("height"),
          texts: Array.from(doc.querySelectorAll("text"), (el) => el.textContent ?? ""),
          positioned: Array.from(doc.querySelectorAll("text"), (el) => ({
            text: (el.textContent ?? "").trim(),
            x: Number.parseFloat(el.getAttribute("x") ?? "0") + translateX(el),
          })),
        };
      });
  }, options);
}

function svgSize(svg: SvgExport): { width: number; height: number } {
  return { width: Number.parseFloat(svg.width ?? ""), height: Number.parseFloat(svg.height ?? "") };
}

/** The coarse header row's captions at the `day` zoom level are `"<Month> <year>"` (`en` locale). */
const MONTH_CAPTION = /^[A-Z][a-z]+ \d{4}$/;

test.use({ viewport: { width: 1280, height: 900 } });

test.describe("export UI: PNG button", () => {
  test("the page's PNG button exports a decodable image and offers it for download", async ({ page, openExample }) => {
    await boot(page, openExample);

    // Nothing has been exported yet, so no preview and no live download link.
    await expect(page.locator("#exportStatus")).toHaveText("No export yet.");
    await expect(page.locator("#exportPreview")).toBeHidden();

    await page.locator("#exportPngBtn").click();

    await expect(page.locator("#exportStatus")).toHaveText(/^range="viewport" → image\/png, [\d.]+ KB$/);
    await expect(page.locator("#exportStatus")).not.toHaveClass(/error/);

    const preview = page.locator("#exportPreview");
    await expect(preview).toBeVisible();
    await expect(preview).toHaveAttribute("src", /^blob:/);
    const intrinsic = await preview.evaluate((el) => ({
      width: (el as HTMLImageElement).naturalWidth,
      height: (el as HTMLImageElement).naturalHeight,
    }));
    expect(intrinsic.width).toBeGreaterThan(0);
    expect(intrinsic.height).toBeGreaterThan(0);

    const download = page.locator("#exportDownload");
    await expect(download).toBeVisible();
    await expect(download).toHaveAttribute("download", "stargantt-export-viewport.png");
  });
});

test.describe("export UI: JPEG quality picker", () => {
  test("the quality <select> feeds an explicit-vs-omitted call shape into toPng({format:'jpeg'})", async ({
    page,
    openExample,
  }) => {
    await boot(page, openExample);

    // Default option is the explicit mid quality.
    await expect(page.locator("#jpegQuality")).toHaveValue("0.5");
    await page.locator("#exportJpegBtn").click();
    await expect(page.locator("#exportStatus")).toHaveText(
      /^range="viewport" → image\/jpeg, [\d.]+ KB \(quality 0\.5\)$/,
    );
    await expect(page.locator("#exportStatus")).not.toHaveClass(/error/);
    const preview = page.locator("#exportPreview");
    await expect(preview).toBeVisible();
    const midIntrinsic = await preview.evaluate((el) => (el as HTMLImageElement).naturalWidth);
    expect(midIntrinsic).toBeGreaterThan(0);

    // The empty option omits `quality` entirely — a distinct call shape from an unusable number
    // (export.md §1.1) — and this page's own status wording names it. `quality` is a per-call
    // argument on this facade, not a factory option, so switching it must not touch the chart at
    // all (there is no rebuild-in-flight guard to break in the first place).
    await page.selectOption("#jpegQuality", "");
    await page.locator("#exportJpegBtn").click();
    await expect(page.locator("#exportStatus")).toHaveText(
      /^range="viewport" → image\/jpeg, [\d.]+ KB \(quality omitted → encoder default\)$/,
    );

    await expect(page.locator("#exportDownload")).toHaveAttribute("download", "stargantt-export-viewport.jpg");
  });
});

test.describe("range: full (multi-tile composition)", () => {
  // Composing a 60-day export tile by tile through virtual viewports is real work.
  test.setTimeout(120_000);

  test("range 'full' spans the whole task extent and its tiles compose without a duplicated header caption", async ({
    page,
    openExample,
  }) => {
    await boot(page, openExample);

    const geometry = await chartGeometry(page);
    const svg = await exportSvg(page, { range: "full" });
    const size = svgSize(svg);

    expect(svg.parserErrors).toBe(0);
    expect(svg.rootName).toBe("svg");

    // export.md §1.1: the exported span is the store's whole task extent — 60 days at this page's
    // data.
    const expectedWidth = FULL_SPAN_DAYS * geometry.pxPerDay;
    expect(size.width).toBeGreaterThanOrEqual(expectedWidth - 2);
    expect(size.width).toBeLessThanOrEqual(expectedWidth + 2);
    // Comfortably wider than the internal tile size, so this export is genuinely multi-tile — the
    // precondition for the seam behavior asserted below.
    expect(size.width).toBeGreaterThan(2_000);

    // Export tiles do not apply the sticky-leading-label rule, and fit-based thinning is
    // computed over the whole exported span, so every month caption is painted at its TRUE
    // calendar boundary — at the same place in the finished image no matter which tile emitted it.
    // A tile does re-emit a caption whose boundary lies to its left (its own clip hides it), so the
    // element count alone proves nothing; what matters is the POSITION: one caption, one x.
    const captions = svg.positioned.filter((label) => MONTH_CAPTION.test(label.text));
    const byText = new Map<string, Set<number>>();
    for (const { text, x } of captions) {
      const positions = byText.get(text) ?? new Set<number>();
      positions.add(Math.round(x));
      byText.set(text, positions);
    }
    // 2026-08-03 -> 2026-10-02 covers August, September and October.
    expect([...byText.keys()].sort()).toEqual(["August 2026", "October 2026", "September 2026"]);
    for (const [text, positions] of byText) {
      expect([...positions], `"${text}" is painted at one x only`).toHaveLength(1);
    }
    // Non-vacuous: at least one caption really was emitted by more than one tile.
    expect(captions.length).toBeGreaterThan(byText.size);

    // The raster path composes the same span: a decodable image of the same CSS footprint,
    // covering every row (row-tiling too, export.md §1.1's "row coverage" clause).
    const decoded = await page.evaluate(async (opts) => {
      const blob = await gantt.service("stargantt.export").toPng(opts);
      const bitmap = await createImageBitmap(blob);
      const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
      return { width: bitmap.width, height: bitmap.height, signature: [...head] };
    }, { range: "full" });

    expect(decoded.signature).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const expectedPngWidth = Math.round(expectedWidth * geometry.pixelRatio);
    expect(decoded.width).toBeGreaterThanOrEqual(expectedPngWidth - 4);
    expect(decoded.width).toBeLessThanOrEqual(expectedPngWidth + 4);
    expect(geometry.totalHeight).toBeGreaterThan(0);
    const expectedPngHeight =
      Math.round(geometry.totalHeight * geometry.pixelRatio) + Math.round(geometry.headerHeight * geometry.pixelRatio);
    expect(decoded.height).toBeGreaterThanOrEqual(expectedPngHeight - 4);
    expect(decoded.height).toBeLessThanOrEqual(expectedPngHeight + 4);
  });
});

test.describe("range: explicit { start, end }", () => {
  test("an explicit { start, end } range exports exactly that span", async ({ page, openExample }) => {
    await boot(page, openExample);

    const customRange = { start: T0, end: T0 + CUSTOM_SPAN_DAYS * DAY_MS };
    const geometry = await chartGeometry(page);
    const svg = await exportSvg(page, { range: customRange });
    const size = svgSize(svg);

    expect(svg.parserErrors).toBe(0);
    const expectedWidth = CUSTOM_SPAN_DAYS * geometry.pxPerDay;
    expect(size.width).toBeGreaterThanOrEqual(expectedWidth - 2);
    expect(size.width).toBeLessThanOrEqual(expectedWidth + 2);

    // The header of that span names only the one month it covers (2026-08-03 -> 2026-08-23),
    // which a range silently falling back to "viewport" or widening to "full" would not.
    const captions = [...new Set(svg.texts.map((t) => t.trim()).filter((t) => MONTH_CAPTION.test(t)))];
    expect(captions).toEqual(["August 2026"]);

    // The page's fixture data really is anchored where this test assumes: "t1" ("Planning") runs
    // T0 to T0 + 10 days.
    const planning = await page.evaluate(() => gantt.service("stargantt.data").getTask("t1"));
    expect(planning?.start).toBe(T0);
    expect(planning?.end).toBe(T0 + 10 * DAY_MS);
  });
});
