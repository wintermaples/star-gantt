import { expect, test } from "./_fixtures";
import { FIXED_TIME, settle } from "./_fixtures";

// E2E for examples/export-print.html: the print/PDF facet of the merged `stargantt.export` facade
// (docs/specs/plugins/export.md §1.2), driven through the PAGE'S OWN UI buttons rather than
// programmatic service calls.
//
// Print lives in the one `stargantt.export` facade every `presetStandard()` composition already
// carries, with `printPreview()` / `toPdf()` as its two print-facing members.
//
// e2e/export.spec.ts ("print pagination and PDF" / "print preview" describe blocks) already
// verifies, against examples/scheduling.html and forced multi-page options: `pageCount()`'s exact
// conformance to export.md §1.2's documented pagination formula, `toPdf()`'s PDF-1.4 byte
// signature and §1.3's documented byte-cost bound, and the print-preview dialog's full a11y
// contract (role/aria-modal, page tally, Escape, focus return) — all driven by direct
// `page.evaluate` service calls, never through a page's own button. This file does NOT re-prove
// any of that (a pure duplicate would only weaken the pagination-formula assertion's rigor, not add
// coverage). What genuinely differs here, and is worth a real E2E for, is the PAGE'S OWN UI wiring:
// a real button click driving `printPreview()`/`toPdf()`, this page's own `paper: "a4"`/
// `orientation: "landscape"`/`header` config, and the page's own `downloadFile`-based save path (a
// code path export.spec.ts never exercises, since it only calls the service directly).
//
// No screenshot assertions: this page has no baseline image checked in.

const PAGE = "export-print.html";
const PANE = ".sg-pane--chart";

async function boot(page: import("@playwright/test").Page, openExample: import("./_fixtures").OpenExample): Promise<void> {
  await openExample(PAGE, { ready: `${PANE} canvas`, fixedTime: FIXED_TIME, settle: true });
}

test("the print preview overlay opens via the page's own button, with this page's paper/orientation config, and Esc closes it", async ({
  page,
  openExample,
}) => {
  await boot(page, openExample);

  // Service-driven: nothing of the preview exists before the click.
  await expect(page.locator(".sg-print-preview")).toHaveCount(0);

  await page.locator("#previewBtn").click();

  const dialog = page.locator(`${PANE} .sg-print-preview`);
  await expect(dialog).toHaveCount(1);
  await expect(dialog).toHaveAttribute("role", "dialog");
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  // At least one composed page sheet — this page's a4-landscape config with a configured header
  // produces a real, renderable page plan (export.md §1.2/§1.3), not merely "the dialog exists".
  await expect(dialog.locator(".sg-print-preview-page").first()).toBeVisible();
  await expect(dialog.locator("button", { hasText: "Print" })).toBeVisible();
  await expect(dialog.locator("button", { hasText: "Close" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator(".sg-print-preview")).toHaveCount(0);
});

test("the page's Download PDF button produces a real PDF blob through the page's own download path", async ({
  page,
  openExample,
}) => {
  await boot(page, openExample);

  await expect(page.locator("#pdfStatus")).toHaveText("");

  await page.locator("#pdfBtn").click();
  await expect(page.locator("#pdfStatus")).toHaveText(/^PDF ready \(\d+ kB\)$/);

  // The page's own click handler stashes the resolved Blob's own type/size on `window.lastPdf`
  // before handing it to its `downloadFile` helper — the exact code path export.spec.ts's direct
  // `toPdf()` service call never exercises (it never touches the page's own save wiring).
  const lastPdf = await page.evaluate(() => (window as unknown as { lastPdf?: { size: number; type: string } }).lastPdf);
  expect(lastPdf).toBeDefined();
  expect(lastPdf?.type).toBe("application/pdf");
  expect(lastPdf?.size).toBeGreaterThan(1000);
});
