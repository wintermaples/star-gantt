import { expect, test } from "./_fixtures";
import { FIXED_TIME, settle } from "./_fixtures";
import type { Page } from "@playwright/test";

// E2E for export round-trip verification: the `stargantt.export` facade
// (docs/specs/plugins/export.md), composed as the ninth preset-standard entry, exercised against
// `examples/scheduling.html` for its links-in-capture coverage — dependency lines paint on the
// same canvas band as bars, so the image-capture tests below get real non-trivial content, not
// just bare rectangles.
//
// Every assertion below is behavioral: decoded pixel data, parsed PDF byte signatures, DOM/ARIA
// dialog state, computed diffs, and structural proofs of the "nothing ever removed" MSPDI rule —
// no smoke tests. Where an absence is asserted (read-only blocking a drag), a positive control
// immediately follows with the identical gesture once read-only is lifted, so a silently broken
// gesture can never be mistaken for a successfully vetoed one.
//
// The one screenshot assertion, in the "display" describe block, is deliberately left WITHOUT a
// baseline — Playwright's own "no baseline" failure is expected there; a baseline is generated
// separately after a visual review (CLAUDE.md §7). Nothing here runs `--update-snapshots`.
//
// Deliberately out of scope here: a multi-tile range export (`"full"`/explicit `{start,end}`
// beyond one `TILE_WIDTH`/`TILE_HEIGHT` tile) and the month-caption-thinning behavior that only
// shows up across a tile seam (covered in export-image.spec.ts instead); `image.pixelRatio`
// recovery from the on-screen layer canvases at a non-1 device ratio; the eight `downloadFile`
// call sites; the import dialog's non-canonical-header inference path, its issue list rendering,
// Escape-closes-without-applying, live re-parse on a mapping `<select>` change, and the "removes
// start unchecked" default; `importJson`/`applyMsProjectXml` against a foreign-source document
// (not the store's own round-tripped export); `viewerEmbed.autoRestore`; `criticalPathOnly` print
// emphasis; and the `removeMissing`/`filter` import options.

const DAY_MS = 86_400_000;
const CONTAINER = "#chart";
const PX_PER_MM = 96 / 25.4;

interface ImportChangeLite {
  kind: "add" | "update" | "remove";
  id?: string;
  task?: { id: string; name: string; parentId: string | null };
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

interface ImportResultLite {
  document: { format: "csv" | "json"; headers?: string[]; mapping?: (string | null)[]; issues: unknown[] };
  issues: unknown[];
  changes: ImportChangeLite[];
  applied?: { added: number; updated: number; removed: number };
}

interface MsProjectApplyResultLite {
  tasksAdded: number;
  tasksUpdated: number;
  linksAdded: number;
  resourcesAdded: number;
  assignmentsSet: number;
}

interface MsProjectImportResultLite {
  document: { tasks: unknown[]; links: unknown[]; resources: unknown[]; assignments: unknown[] };
  baselineInits: unknown[];
  applied?: MsProjectApplyResultLite;
}

declare const gantt: {
  dispatch<K extends string>(cmd: K, payload: unknown): void;
  on<E>(event: string, handler: (e: E) => void): { dispose(): void };
  dispose(): void;
  service(key: "stargantt.data"): {
    getTask(id: string):
      | {
          id: string;
          name: string;
          start: number;
          end: number;
          progress?: number;
          type?: "task" | "summary" | "milestone";
        }
      | undefined;
    taskIds(): Iterable<string>;
    load(data: unknown): void;
    links: { get(): Map<string, { id: string; sourceId: string; targetId: string }> };
  };
  service(key: "stargantt.history"): {
    state: { get(): { canUndo: boolean; canRedo: boolean; depth: number } };
    undo(): void;
    redo(): void;
  };
  service(key: "stargantt.timeline"): {
    tToX(t: number): number;
    pxPerMs: number;
  };
  service(key: "stargantt.rows"): {
    rowHeight(row: number): number;
  };
  service(key: "stargantt.task-bars"): {
    barBoxOf(id: string): { x: number; y: number; width: number; height: number } | undefined;
  };
  service(key: "stargantt.view"): {
    viewport: { get(): { scrollTop: number; scrollLeft: number; width: number; height: number } };
  };
  service(key: "stargantt.export"): {
    toPng(options?: Record<string, unknown>): Promise<Blob>;
    toSvg(options?: Record<string, unknown>): Promise<string>;
    toPdf(options?: Record<string, unknown>): Promise<Blob>;
    pageCount(options?: Record<string, unknown>): number;
    printPreview(options?: Record<string, unknown> | false): boolean;
    exportCsv(options?: Record<string, unknown>): string;
    exportJson(): string;
    exportICal(options?: Record<string, unknown>): string;
    importCsv(text: string, options?: Record<string, unknown>): ImportResultLite;
    importJson(text: string, options?: Record<string, unknown>): ImportResultLite;
    toMsProjectXml(options?: Record<string, unknown>): string;
    applyMsProjectXml(text: string, options?: Record<string, unknown>): MsProjectImportResultLite;
    toXlsx(options?: Record<string, unknown>): ArrayBuffer;
    snapshot(options?: Record<string, unknown>): string;
    applySnapshot(source?: string): boolean;
    isReadOnly(): boolean;
    setReadOnly(on: boolean): void;
  };
};

async function chartBodyBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator(".sg-pane--chart canvas.sg-layer").first().boundingBox();
  if (box === null) throw new Error("chart body canvas not found");
  return box;
}

/** Page-absolute centre of a task's bar, plus its right edge and CSS px per calendar day. */
async function barGeometry(
  page: Page,
  taskId: string,
): Promise<{ x: number; y: number; right: number; pxPerDay: number }> {
  const pane = await chartBodyBox(page);
  const box = await page.evaluate(
    ({ id, dayMs }) => {
      const b = gantt.service("stargantt.task-bars").barBoxOf(id);
      if (b === undefined) return null;
      const pxPerDay = gantt.service("stargantt.timeline").pxPerMs * dayMs;
      return { x: b.x, y: b.y, width: b.width, height: b.height, pxPerDay };
    },
    { id: taskId, dayMs: DAY_MS },
  );
  if (box === null) throw new Error(`no visible bar for task "${taskId}"`);
  return {
    x: pane.x + box.x + box.width / 2,
    y: pane.y + box.y + box.height / 2,
    right: pane.x + box.x + box.width,
    pxPerDay: box.pxPerDay,
  };
}

async function taskOf(page: Page, id: string) {
  const task = await page.evaluate((taskId) => gantt.service("stargantt.data").getTask(taskId), id);
  if (task === undefined) throw new Error(`task "${id}" not found`);
  return task;
}

async function historyState(page: Page) {
  return page.evaluate(() => gantt.service("stargantt.history").state.get());
}

/** Rewrites one task's `progress` cell in an exported CSV by header NAME (not a hardcoded column
 *  index), so this stays correct regardless of `exportCsv`'s exact field order. */
async function csvWithProgress(page: Page, csv: string, taskId: string, value: string): Promise<string> {
  return page.evaluate(
    ({ csv, taskId, value }) => {
      const lines = csv.split("\r\n");
      const rows = lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
      const header = rows[0]!.split(",");
      const idIdx = header.indexOf("id");
      const progressIdx = header.indexOf("progress");
      const body = rows.slice(1).map((l) => l.split(","));
      const row = body.find((r) => r[idIdx] === taskId)!;
      row[progressIdx] = value;
      return [header.join(","), ...body.map((r) => r.join(","))].join("\r\n") + "\r\n";
    },
    { csv, taskId, value },
  );
}

async function bootExport(page: Page, openExample: import("./_fixtures").OpenExample): Promise<void> {
  await openExample("scheduling.html", { ready: `${CONTAINER} canvas`, fixedTime: FIXED_TIME });
  await settle(page);
  await expect.poll(async () => taskOf(page, "spec").then((t) => t.name)).toBe("Design");
}

test.describe("image capture: toPng", () => {
  test("round-trips a real, decodable PNG: dimensions match the viewport (+ the header band), and the bar's own pixel differs from the SAME x on two other, bar-free rows that agree with each other", async ({
    page,
    openExample,
  }) => {
    await bootExport(page, openExample);

    // Varying BOTH x and row between the two sample points would confound the result: different x
    // means a different calendar band (weekday vs. weekend shading), so an RGBA inequality could
    // come from that banding alone and would hold even with the task-bars layer removed. Instead x
    // is held CONSTANT at "spec"'s own bar-centre x and only the ROW varies: "spec" (has a bar at
    // this x) vs. "qa" and "succ" (two bar-free rows at this exact x — day 0..3 is well before
    // either task's own span, and no link route crosses it either). The REQUIRED control is the
    // qa/succ pair: same x, two different bar-free rows of matching stripe parity (row 3 and row 9,
    // two apart is not needed here — both merely need to be bar-free and painted consistently) must
    // read as the SAME color; only then does the spec-vs-qa inequality prove the bar itself, not
    // incidental row-background variation.
    const geometry = await page.evaluate(() => {
      const view = gantt.service("stargantt.view");
      const bars = gantt.service("stargantt.task-bars");
      const vp = view.viewport.get();
      const layer = document.querySelector(".sg-pane--chart canvas.sg-layer") as HTMLCanvasElement;
      const cssWidth = layer.clientWidth || layer.getBoundingClientRect().width;
      const ratio = layer.width / cssWidth;
      const headerHeight =
        parseFloat(getComputedStyle(document.getElementById("chart")!).getPropertyValue("--sg-header-height")) ||
        44;
      const specBox = bars.barBoxOf("spec")!;
      const qaBox = bars.barBoxOf("qa")!;
      const succBox = bars.barBoxOf("succ")!;
      // "spec"'s own bar-centre x, reused for every row: "qa" (day 8..11) and "succ" (day 9..10)
      // have no bar and no link route anywhere near "spec"'s day 0..3 span.
      const x = Math.round((specBox.x + specBox.width / 2) * ratio);
      const yOf = (box: { y: number; height: number }): number =>
        Math.round((headerHeight + box.y + box.height / 2) * ratio);
      return {
        expectedWidth: Math.max(1, Math.round(Math.round(vp.width) * ratio)),
        expectedHeight: Math.max(1, Math.round((headerHeight + Math.round(vp.height)) * ratio)),
        x,
        barPy: yOf(specBox),
        clearAPy: yOf(qaBox),
        clearBPy: yOf(succBox),
      };
    });

    const sample = await page.evaluate(async (g) => {
      const blob = await gantt.service("stargantt.export").toPng();
      const bitmap = await createImageBitmap(blob);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(bitmap, 0, 0);
      const at = (y: number): number[] => Array.from(ctx.getImageData(g.x, y, 1, 1).data);
      return {
        width: bitmap.width,
        height: bitmap.height,
        bar: at(g.barPy),
        clearA: at(g.clearAPy),
        clearB: at(g.clearBPy),
      };
    }, geometry);

    expect(sample.width).toBe(geometry.expectedWidth);
    expect(sample.height).toBe(geometry.expectedHeight);
    // Control: same x, two different bar-free rows — must read identically. This is what makes the
    // next assertion trustworthy (it rules out "the two rows just happen to look different").
    expect(sample.clearA).toEqual(sample.clearB);
    // The bar's own row, same x, is a genuinely different color from both bar-free rows.
    expect(sample.bar).not.toEqual(sample.clearA);
  });

  // The JPEG encoder path is a format-only difference from PNG per §1.1, but with a real behavior
  // PNG does not have: with `image.background` omitted, JPEG's lack of an alpha channel forces an
  // opaque-WHITE substitution painted before the layers composite, in place of PNG's transparency.
  // A naive probe here is a tautology twice over: `cornerAlpha === 255` holds for ANY decoded JPEG
  // pixel regardless of content (JPEG has no alpha channel at all), and image pixel (0,0) sits
  // inside the header band, which the header itself paints — in PNG too. This instead samples a
  // point that is GENUINELY transparent in the PNG export (below the last row, inside the
  // drawing-layers band but past every row's content) to establish the region, then compares JPEG's
  // default (near-white) against an explicit `background: "#000"` control (near-black) at the exact
  // same point — proving the assertion tracks the background substitution itself, not an incidental
  // format quirk.
  test("toPng({format:'jpeg'}) substitutes an opaque background where PNG leaves transparency, honors an explicit background, and a lower `quality` produces fewer bytes", async ({
    page,
    openExample,
  }) => {
    await bootExport(page, openExample);

    const probe = await page.evaluate(async () => {
      const svc = gantt.service("stargantt.export");
      const [pngBlob, jpegBlob, blackBgBlob] = await Promise.all([
        svc.toPng(),
        svc.toPng({ format: "jpeg" }),
        svc.toPng({ format: "jpeg", background: "#000" }),
      ]);
      const pixelAt = async (blob: Blob, x: number, y: number): Promise<number[]> => {
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement("canvas");
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(bitmap, 0, 0);
        // Below the last row, near the left edge: past every row's own content and every
        // auxiliary band, inside the drawing-layers area — genuinely unpainted in the PNG export.
        return Array.from(ctx.getImageData(x, y, 1, 1).data);
      };
      const pngBitmap = await createImageBitmap(pngBlob);
      const x = 2;
      const y = Math.max(0, pngBitmap.height - 3);
      const png = await pixelAt(pngBlob, x, y);
      const jpeg = await pixelAt(jpegBlob, x, y);
      const blackBg = await pixelAt(blackBgBlob, x, y);
      return { type: jpegBlob.type, png, jpeg, blackBg };
    });

    expect(probe.type).toBe("image/jpeg");
    // Establishes the region: PNG really is transparent there (no layer paints past the last row).
    expect(probe.png[3]).toBe(0);
    // Default (background omitted): JPEG substitutes opaque white — every channel bright. A tight
    // "===255" would be brittle under chroma-subsampling artifacts, so this allows headroom while
    // still being far from any painted chart color.
    expect(probe.jpeg[0]).toBeGreaterThan(200);
    expect(probe.jpeg[1]).toBeGreaterThan(200);
    expect(probe.jpeg[2]).toBeGreaterThan(200);
    // Control: an explicit `background: "#000"` at the SAME point reads near-black — proving the
    // two probes above track the configured substitution, not some fixed, format-driven constant.
    expect(probe.blackBg[0]).toBeLessThan(60);
    expect(probe.blackBg[1]).toBeLessThan(60);
    expect(probe.blackBg[2]).toBeLessThan(60);

    // `quality` forwarding: a real compression-level discrimination, not a structural "the option
    // was accepted" check.
    const sizes = await page.evaluate(async () => {
      const svc = gantt.service("stargantt.export");
      const high = await svc.toPng({ format: "jpeg", quality: 0.95 });
      const low = await svc.toPng({ format: "jpeg", quality: 0.1 });
      return { high: high.size, low: low.size };
    });
    expect(sizes.low).toBeLessThan(sizes.high);
  });
});

test.describe("image capture: toSvg", () => {
  test("returns a well-formed SVG document with layer groups, a header-band text contribution, and a plausible shape count", async ({
    page,
    openExample,
  }) => {
    await bootExport(page, openExample);

    const expectedCssSize = await page.evaluate(() => {
      const vp = gantt.service("stargantt.view").viewport.get();
      const headerHeight =
        parseFloat(getComputedStyle(document.getElementById("chart")!).getPropertyValue("--sg-header-height")) ||
        44;
      return { width: Math.round(vp.width), height: headerHeight + Math.round(vp.height) };
    });

    const svg = await page.evaluate(() => gantt.service("stargantt.export").toSvg());

    expect(svg.startsWith("<svg xmlns=")).toBe(true);
    expect(svg).toContain(`width="${expectedCssSize.width}"`);
    expect(svg).toContain(`height="${expectedCssSize.height}"`);
    // Well-formed XML: parsed in-page, zero `<parsererror>` elements (a truncated/mis-escaped
    // emitter would surface here even when the string-level checks below all still pass).
    const parserErrorCount = await page.evaluate((svgText) => {
      const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
      return doc.getElementsByTagName("parsererror").length;
    }, svg);
    expect(parserErrorCount).toBe(0);
    // Structural markers: at least one per-tile/per-layer group, and the header band's own text
    // (view.md's `export/auxiliarySurfaces` contribution — the timeline date labels).
    expect(svg).toContain("<g transform=");
    expect(svg).toContain("<text");
    // Vector-path proof: every official layer here stays inside the
    // recording proxy's subset (§1.1 "True-vector SVG"), so nothing falls back to a rasterized
    // `<image>` embed — this dataset never exercises that fallback.
    expect(svg.match(/<image/g) ?? []).toHaveLength(0);
    // Sanity bound on the shape count. The lower bound (>5) fails an empty/broken capture. The
    // upper bound (<400) is loose by design — it does NOT catch a subtle duplication artifact (a
    // 2x count would still clear it); it only catches a wholesale failure, e.g. a tiling bug that
    // renders every tile of a far larger area than this single-viewport export requests.
    const rectCount = (svg.match(/<rect/g) ?? []).length;
    const pathCount = (svg.match(/<path/g) ?? []).length;
    expect(rectCount + pathCount).toBeGreaterThan(5);
    expect(rectCount + pathCount).toBeLessThan(400);
  });
});

/**
 * Print options forcing a genuine multi-page layout, plus the expected page count computed from
 * export.md §1.2's own documented formula — shared by the pagination/PDF test and the print-preview
 * test so the preview's page tally is exercised against a real >1 sheet count instead of whatever a
 * default single-page composition happens to produce.
 */
async function multiPagePrintPlan(page: Page): Promise<{ options: Record<string, unknown>; expectedPages: number }> {
  const t0 = Math.floor(FIXED_TIME.getTime() / DAY_MS) * DAY_MS;

  // §1.2's pagination geometry, computed from the spec's own documented constants (paper mm, band
  // heights, table column widths) — hardcoded here exactly as e2e/scheduling.spec.ts hardcodes
  // `PORT_OFFSET` from scheduling's own documented geometry, never imported from the plugin's
  // internal module.
  const marginPx = 10 * PX_PER_MM;
  const pageWidthPx = 297 * PX_PER_MM; // a4 landscape
  const pageHeightPx = 210 * PX_PER_MM;
  const dateBandPx = 24; // present: the explicit `range` below resolves both bounds
  const chartWidthPx = pageWidthPx - 2 * marginPx; // `columns: []` -> no printed table
  const chartHeightPx = pageHeightPx - 2 * marginPx - dateBandPx; // no header/legend/footer bands

  // Choose a time span landing the horizontal page count in (1, 2] regardless of the chart's live
  // zoom level: read the current px/day and aim for the bracket's midpoint.
  const pxPerDayNow = await page.evaluate(
    (dayMs) => gantt.service("stargantt.timeline").tToX(dayMs) - gantt.service("stargantt.timeline").tToX(0),
    DAY_MS,
  );
  const days = Math.max(1, Math.round((1.5 * chartWidthPx) / pxPerDayNow));
  const range = { start: t0, end: t0 + days * DAY_MS };
  const options = {
    paper: "a4",
    orientation: "landscape",
    pixelRatio: 1, // keeps the raster/PDF work light; pageCount ignores it entirely (§1.3)
    columns: [],
    legend: false,
    // `footer` is one of `PrintOptions`' own top-level keys, so §1's per-key shallow override
    // REPLACES the whole footer nest wholesale (not a deep per-field merge with any factory-level
    // footer) — this is not merely "no default footer text": it explicitly states `center: ""`,
    // overriding the built-in page-number default that an OMITTED `footer` would have kept, which
    // is what actually suppresses the footer band (`textPresent("")` is false).
    footer: { center: "" },
    rows: { from: 0, to: 0 }, // row 0 only: one row band, trivially inside the page height
    range,
  };

  // The exact §1.2 formula (`max(1, ceil(spanX/sliceW))`), evaluated from the outside using the
  // SAME `tToX` the plugin itself reads — not a re-guess of the algorithm's output.
  const spanX = await page.evaluate(
    (r) => {
      const t = gantt.service("stargantt.timeline");
      return Math.max(1, t.tToX(r.end) - t.tToX(r.start));
    },
    range,
  );
  const expectedCols = Math.max(1, Math.ceil(spanX / chartWidthPx));
  const rowHeight0 = await page.evaluate(() => gantt.service("stargantt.rows").rowHeight(0));
  const expectedBands = Math.max(1, Math.ceil(rowHeight0 / chartHeightPx));
  const expectedPages = expectedCols * expectedBands;
  // Proves this genuinely forces multiple pages, not a trivial always-1 pass.
  expect(expectedCols).toBeGreaterThan(1);
  expect(expectedBands).toBe(1);

  return { options, expectedPages };
}

test.describe("print pagination and PDF", () => {
  test("pageCount matches the documented §1.2 pagination formula for a forced multi-page layout, and toPdf yields a plausible PDF byte signature", async ({
    page,
    openExample,
  }) => {
    await bootExport(page, openExample);
    const { options: printOptions, expectedPages } = await multiPagePrintPlan(page);

    const pageCount = await page.evaluate(
      (opts) => gantt.service("stargantt.export").pageCount(opts),
      printOptions,
    );
    expect(pageCount).toBe(expectedPages);

    const pageWidthPx = 297 * PX_PER_MM; // a4 landscape — restated for the byte-band estimate below
    const pageHeightPx = 210 * PX_PER_MM;
    const pdf = await page.evaluate(async (opts) => {
      const blob = await gantt.service("stargantt.export").toPdf(opts);
      const buf = await blob.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const head = new TextDecoder("ascii").decode(bytes.slice(0, 16));
      const tail = new TextDecoder("ascii").decode(bytes.slice(-64));
      return { type: blob.type, size: blob.size, head, tail };
    }, printOptions);

    expect(pdf.type).toBe("application/pdf");
    expect(pdf.head.startsWith("%PDF-1.4")).toBe(true);
    expect(pdf.tail).toContain("%%EOF");
    // §1.3's own documented byte-cost formula: each page is an UNCOMPRESSED (stored-block Flate)
    // raster, ~3 bytes/pixel at `pixelRatio`. Stored-block Flate applies zero compression, so a
    // blank page and a fully-painted one cost the same — this band proves the raster geometry and
    // PDF framing are right (page size × page count × bytes/pixel), NOT that anything was actually
    // painted onto the pages; it is a ±50% guard against a broken encoder (near-empty or wildly
    // bloated output), not a content check.
    const pageBytes = Math.round(pageWidthPx) * Math.round(pageHeightPx) * 3;
    const expectedTotal = pageBytes * pageCount;
    expect(pdf.size).toBeGreaterThan(expectedTotal * 0.5);
    expect(pdf.size).toBeLessThan(expectedTotal * 1.5 + 100_000);
  });
});

test.describe("print preview", () => {
  test("opens as an accessible modal with a genuine multi-page tally, Escape closes it, and focus returns to the opener", async ({
    page,
    openExample,
  }) => {
    await bootExport(page, openExample);

    // The same forced multi-page options the pagination test itself verifies against export.md
    // §1.2's formula — a default single-page composition would let a broken preview (rendering one
    // page regardless of the plan) pass a `toHaveCount(1)` trivially.
    const { options: printOptions, expectedPages } = await multiPagePrintPlan(page);

    // A real, previously-focused element to prove focus actually returns to it (WCAG 2.4.3), not
    // merely "focus left the dialog". scheduling.html's own chrome carries no <summary> (its
    // instructions render as a static .ex-note, not a <details> disclosure), so this uses the
    // a11y mirror's first row instead — the same stable, always-present focus target
    // e2e/scheduling.spec.ts's own "Alt+L two-step keyboard chord" test focuses.
    const opener = page.locator(".sg-a11y-row").first();
    await opener.focus();

    const opened = await page.evaluate(
      (opts) => gantt.service("stargantt.export").printPreview(opts),
      printOptions,
    );
    expect(opened).toBe(true);

    const dialog = page.locator(".sg-print-preview");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("role", "dialog");
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(page.locator(".sg-print-preview-page")).toHaveCount(expectedPages);

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    expect(await opener.evaluate((el) => el === document.activeElement)).toBe(true);

    // `printPreview(false)` closes any open preview; calling it with nothing open is a harmless
    // no-op returning `false` ("is a preview open after this call").
    const closedAgain = await page.evaluate(() => gantt.service("stargantt.export").printPreview(false));
    expect(closedAgain).toBe(false);
  });
});

test.describe("CSV interchange", () => {
  test("exportCsv -> importCsv dryRun round-trips to zero changes; a modified CSV produces one detected update; the import dialog applies it as one undo step", async ({
    page,
    openExample,
  }) => {
    await bootExport(page, openExample);
    const before = await taskOf(page, "spec");
    expect(before.progress).toBeUndefined();

    const roundTrip = await page.evaluate(() => {
      const svc = gantt.service("stargantt.export");
      const csv = svc.exportCsv();
      const dry = svc.importCsv(csv, { dryRun: true });
      return { csv, changes: dry.changes, applied: dry.applied };
    });
    expect(roundTrip.changes).toEqual([]);
    expect(roundTrip.applied).toBeUndefined();

    const modified = await csvWithProgress(page, roundTrip.csv, "spec", "0.5");

    const dryModified = await page.evaluate(
      (csv) => gantt.service("stargantt.export").importCsv(csv, { dryRun: true }),
      modified,
    );
    expect(dryModified.applied).toBeUndefined();
    expect(dryModified.changes).toHaveLength(1);
    expect(dryModified.changes[0]!.kind).toBe("update");
    expect(dryModified.changes[0]!.id).toBe("spec");
    expect(dryModified.changes[0]!.after?.["progress"]).toBe(0.5);

    // Apply through the interactive dialog (§1.6): opens, shows the CSV mapping selects and the
    // one-change preview, and applies as one undoable transaction.
    const depthBefore = (await historyState(page)).depth;
    await page.evaluate((csv) => {
      gantt.service("stargantt.export").importCsv(csv, { dialog: true });
    }, modified);

    const dialog = page.locator(".sg-ie-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("role", "dialog");
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    // Seven mapping rows: one per CSV column (id/parentId/name/start/end/progress/type).
    await expect(page.locator(".sg-ie-mapping-row")).toHaveCount(7);
    await expect(page.locator(".sg-ie-change")).toHaveCount(1);
    await expect(page.locator('.sg-ie-change[data-kind="update"]')).toHaveCount(1);

    await page.locator(".sg-ie-apply").click();
    await expect(dialog).toBeHidden();

    const afterApply = await taskOf(page, "spec");
    expect(afterApply.progress).toBe(0.5);
    expect((await historyState(page)).depth).toBe(depthBefore + 1); // one commit == one undo step

    await page.evaluate(() => gantt.service("stargantt.history").undo());
    const reverted = await taskOf(page, "spec");
    expect(reverted.progress).toBeUndefined(); // the one undo step reverted everything
  });
});

test.describe("JSON interchange", () => {
  test("exportJson -> importJson dryRun round-trips to zero changes", async ({ page, openExample }) => {
    await bootExport(page, openExample);

    const result = await page.evaluate(() => {
      const svc = gantt.service("stargantt.export");
      const json = svc.exportJson();
      const dry = svc.importJson(json, { dryRun: true });
      return { json, changes: dry.changes, applied: dry.applied };
    });

    const parsed = JSON.parse(result.json) as { schema: string; tasks: unknown[] };
    expect(parsed.schema).toBe("stargantt/v1");
    expect(Array.isArray(parsed.tasks)).toBe(true);
    expect(parsed.tasks.length).toBeGreaterThan(0);
    expect(result.changes).toEqual([]);
    expect(result.applied).toBeUndefined();
  });
});

// iCal is export-only (§1.5), so there is no round-trip to verify — the observable is the VEVENT
// count against the store's own task-type split.
test.describe("iCal export", () => {
  test("exportICal writes one VEVENT per non-summary task", async ({ page, openExample }) => {
    await bootExport(page, openExample);

    const result = await page.evaluate(() => {
      const svc = gantt.service("stargantt.export");
      const data = gantt.service("stargantt.data");
      const ical = svc.exportICal();
      const ids = [...data.taskIds()];
      const nonSummaryCount = ids.filter((id) => data.getTask(id)?.type !== "summary").length;
      return { ical, taskCount: ids.length, nonSummaryCount };
    });

    expect(result.ical).toContain("BEGIN:VCALENDAR");
    expect(result.ical).toContain("END:VCALENDAR");
    expect(result.nonSummaryCount).toBeGreaterThan(0);
    expect(result.nonSummaryCount).toBeLessThan(result.taskCount); // scheduling.html has one summary ("root")
    expect((result.ical.match(/BEGIN:VEVENT/g) ?? []).length).toBe(result.nonSummaryCount);
  });
});

// xlsx is export-only (§1.8), self-implemented ZIP — verified as a byte-level container proof,
// not a spreadsheet-library round-trip.
test.describe("Excel export (xlsx)", () => {
  test("toXlsx returns a well-formed .xlsx ZIP: the PK signature and the worksheet entry name", async ({
    page,
    openExample,
  }) => {
    await bootExport(page, openExample);

    const result = await page.evaluate(() => {
      const buf = gantt.service("stargantt.export").toXlsx();
      const bytes = new Uint8Array(buf);
      const head = String.fromCharCode(bytes[0]!, bytes[1]!);
      // latin1 (not utf-8): the buffer is arbitrary binary ZIP data, and a strict utf-8 decode
      // would throw on invalid byte sequences outside the ASCII filename/text runs being scanned.
      const text = new TextDecoder("latin1").decode(bytes);
      return { head, byteLength: bytes.length, containsWorksheetEntry: text.includes("xl/worksheets/sheet1.xml") };
    });

    expect(result.head).toBe("PK"); // ZIP local-file-header signature (0x50 0x4B)
    expect(result.byteLength).toBeGreaterThan(0);
    expect(result.containsWorksheetEntry).toBe(true);
  });
});

test.describe("MS Project interchange (MSPDI)", () => {
  test("round-tripping the store's own export only adds — re-minted UIDs never collide with the original ids, so nothing is ever removed and the originals stay untouched", async ({
    page,
    openExample,
  }) => {
    await bootExport(page, openExample);

    const before = await page.evaluate(() => ({
      taskCount: [...gantt.service("stargantt.data").taskIds()].length,
      linkCount: gantt.service("stargantt.data").links.get().size,
      spec: gantt.service("stargantt.data").getTask("spec"),
    }));

    const xml = await page.evaluate(() => gantt.service("stargantt.export").toMsProjectXml());
    expect(xml).toContain("<Project");
    expect(xml).toContain('xmlns="http://schemas.microsoft.com/project"');

    const dry = await page.evaluate(
      (x) => gantt.service("stargantt.export").applyMsProjectXml(x, { dryRun: true }),
      xml,
    );
    expect(dry.applied).toBeUndefined();
    expect(dry.document.tasks.length).toBe(before.taskCount);
    const afterDryCount = await page.evaluate(() => [...gantt.service("stargantt.data").taskIds()].length);
    expect(afterDryCount).toBe(before.taskCount); // dry run touched nothing

    const applied = await page.evaluate((x) => gantt.service("stargantt.export").applyMsProjectXml(x), xml);
    expect(applied.applied).toBeDefined();
    // Structural proof of the "nothing-ever-removed" rule: `MsProjectApplyResult` has no removal
    // field at all — the type this facade returns cannot express a delete.
    expect(Object.keys(applied.applied!).sort()).toEqual(
      ["assignmentsSet", "linksAdded", "resourcesAdded", "tasksAdded", "tasksUpdated"].sort(),
    );
    // Behavioral proof: the re-minted UIDs never collide with the original string ids, so every
    // task in the round-tripped document reads as unknown-id -> add, never update.
    expect(applied.applied!.tasksAdded).toBe(before.taskCount);
    expect(applied.applied!.tasksUpdated).toBe(0);
    expect(applied.applied!.linksAdded).toBe(before.linkCount);

    const after = await page.evaluate(() => ({
      taskCount: [...gantt.service("stargantt.data").taskIds()].length,
      spec: gantt.service("stargantt.data").getTask("spec"),
    }));
    expect(after.taskCount).toBe(before.taskCount * 2); // doubled, never shrank
    expect(after.spec).toEqual(before.spec); // the original task is untouched by the round-trip
  });
});

test.describe("read-only mode", () => {
  test("setReadOnly(true) blocks a real drag and marks the chart `sg-readonly`; setReadOnly(false) restores editing (positive control on the identical gesture)", async ({
    page,
    openExample,
  }) => {
    await bootExport(page, openExample);
    const before = await taskOf(page, "wk"); // unlinked task: no auto-schedule propagation noise
    const depthBefore = (await historyState(page)).depth;

    await page.evaluate(() => gantt.service("stargantt.export").setReadOnly(true));
    expect(await page.evaluate(() => gantt.service("stargantt.export").isReadOnly())).toBe(true);
    await expect(page.locator(CONTAINER)).toHaveClass(/\bsg-readonly\b/);

    const geoBlocked = await barGeometry(page, "wk");
    await page.mouse.move(geoBlocked.x, geoBlocked.y);
    await page.mouse.down();
    await page.mouse.move(geoBlocked.x + geoBlocked.pxPerDay * 3, geoBlocked.y, { steps: 8 });
    await page.mouse.up();
    await settle(page);

    const afterBlockedDrag = await taskOf(page, "wk");
    expect(afterBlockedDrag.start).toBe(before.start);
    expect(afterBlockedDrag.end).toBe(before.end);
    expect((await historyState(page)).depth).toBe(depthBefore); // nothing committed

    await page.evaluate(() => gantt.service("stargantt.export").setReadOnly(false));
    expect(await page.evaluate(() => gantt.service("stargantt.export").isReadOnly())).toBe(false);
    await expect(page.locator(CONTAINER)).not.toHaveClass(/\bsg-readonly\b/);

    // Positive control: the SAME gesture, now that read-only is off, must actually change
    // something — proving the earlier no-op was the veto, not a dead gesture.
    const geoAllowed = await barGeometry(page, "wk");
    await page.mouse.move(geoAllowed.x, geoAllowed.y);
    await page.mouse.down();
    await page.mouse.move(geoAllowed.x + geoAllowed.pxPerDay * 3, geoAllowed.y, { steps: 8 });
    await page.mouse.up();
    await settle(page);

    const afterAllowedDrag = await taskOf(page, "wk");
    expect(afterAllowedDrag.start).not.toBe(before.start);
    expect((await historyState(page)).depth).toBeGreaterThan(depthBefore);
  });

  // The read-only veto applies to this plugin's OWN imports too (export.md §1.5, "Read-only
  // interplay"), exercised here directly against the spec text. Proving the event never fires
  // WHILE BLOCKED is unfalsifiable on its own (a dead/never-wired subscription would look
  // identical) — a listener that can never fire proves nothing about the veto specifically. The
  // fix: keep the SAME subscription alive across both halves, re-running the IDENTICAL import once
  // read-only is lifted, so `fired === true` there proves the subscription mechanism genuinely
  // works, which is what makes `fired === false` while blocked meaningful.
  test("read-only vetoes a CSV import (applies nothing, no event); the identical import succeeds and fires once lifted, under the same subscription", async ({
    page,
    openExample,
  }) => {
    await bootExport(page, openExample);
    const csv = await page.evaluate(() => gantt.service("stargantt.export").exportCsv());
    const modified = await csvWithProgress(page, csv, "spec", "0.4");
    const before = await taskOf(page, "spec");
    const taskCountBefore = await page.evaluate(() => [...gantt.service("stargantt.data").taskIds()].length);
    const depthBefore = (await historyState(page)).depth;

    const result = await page.evaluate((csv) => {
      const svc = gantt.service("stargantt.export");
      const data = gantt.service("stargantt.data");
      const events: true[] = [];
      // One subscription spans both halves below — the "fired" reading in each half comes from
      // the exact same listener, so the blocked half's `false` cannot be explained by a listener
      // that was simply never going to fire at all.
      const subscription = gantt.on("importexport/applied", () => {
        events.push(true);
      });

      svc.setReadOnly(true);
      const blocked = svc.importCsv(csv, { dryRun: false });
      const blockedFired = events.length > 0;
      const taskCountAfterBlocked = [...data.taskIds()].length;
      const specAfterBlocked = data.getTask("spec");

      svc.setReadOnly(false);
      events.length = 0;
      const allowed = svc.importCsv(csv, { dryRun: false });
      const allowedFired = events.length > 0;

      subscription.dispose();
      return { blocked, blockedFired, taskCountAfterBlocked, specAfterBlocked, allowed, allowedFired };
    }, modified);

    // Blocked half: nothing applied, nothing touched, nothing emitted.
    expect(result.blocked.applied).toEqual({ added: 0, updated: 0, removed: 0 });
    expect(result.blockedFired).toBe(false);
    expect(result.taskCountAfterBlocked).toBe(taskCountBefore);
    expect(result.specAfterBlocked?.progress).toBe(before.progress); // untouched, not "still 0.4-ish"

    // Allowed half (positive control, same shape as the read-only drag test above): the IDENTICAL
    // call now applies the one update and fires the event — proving the blocked half's silence was
    // the veto, not a subscription that can never fire.
    expect(result.allowed.applied).toEqual({ added: 0, updated: 1, removed: 0 });
    expect(result.allowedFired).toBe(true);

    const after = await taskOf(page, "spec");
    expect(after.progress).toBe(0.4);
    expect((await historyState(page)).depth).toBe(depthBefore + 1);

    await page.evaluate(() => gantt.service("stargantt.history").undo());
    const reverted = await taskOf(page, "spec");
    expect(reverted.progress).toBe(before.progress);
  });
});

test.describe("snapshot", () => {
  test("snapshot() restores a fully cleared store, with zero dropped tasks", async ({ page, openExample }) => {
    await bootExport(page, openExample);

    const result = await page.evaluate(() => {
      const svc = gantt.service("stargantt.export");
      const data = gantt.service("stargantt.data");
      const before = [...data.taskIds()].sort();
      const specBefore = data.getTask("spec");
      const token = svc.snapshot();

      let dropped: number | undefined;
      const subscription = gantt.on<{ droppedTasks: number }>("viewerembed/snapshotApplied", (e) => {
        dropped = e.droppedTasks;
      });

      data.load([]);
      const cleared = [...data.taskIds()];
      const applied = svc.applySnapshot(token);
      const after = [...data.taskIds()].sort();
      const specAfter = data.getTask("spec");
      subscription.dispose();

      return { before, cleared, applied, after, dropped, specBefore, specAfter };
    });

    expect(result.cleared).toEqual([]); // the store really was empty mid-test
    expect(result.applied).toBe(true);
    expect(result.after).toEqual(result.before);
    expect(result.dropped).toBe(0);
    expect(result.specAfter).toEqual(result.specBefore);
  });
});

test.describe("display", () => {
  // Deliberately no committed baseline (see the file header): expect Playwright's own
  // "no baseline"/"Snapshot doesn't exist" failure here, not a pass. This is also a meaningful
  // check in its own right: export.md §9/§11 promise the plugin paints nothing until a service
  // member is called, so composing it into `presetStandard()` should leave the default chart
  // pixel-identical to every other suite's own baseline of the same page. Do not generate one
  // with `--update-snapshots`; a maintainer does that after a visual review.
  test("initial render of scheduling.html with export composed in matches a baseline (none committed yet)", async ({
    page,
    openExample,
  }) => {
    await bootExport(page, openExample);
    await expect(page).toHaveScreenshot("export.png", {
      animations: "disabled",
      maxDiffPixelRatio: 0.002,
    });
  });
});
