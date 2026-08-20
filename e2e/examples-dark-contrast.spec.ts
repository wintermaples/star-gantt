import { expect, expectNoPageErrors, settle, test, watchPageErrors } from "./_fixtures";
import type { Page } from "@playwright/test";

// Dark-scheme contrast regression. Computes the actual on-screen contrast ratio of specific
// floating/dialog surfaces (not an assumed one) against WCAG 1.4.3's 4.5:1 floor for normal text,
// in a real `colorScheme: "dark"` context.
//
// examples/site.js loads ONLY on index.html (see examples-smoke.spec.ts's header for the full
// explanation) and injects `.ex-footer` into it at runtime — index.html's own markup carries no
// such element. A handful of demo pages (STATIC_FOOTER_PAGES below) additionally carry their own
// static `.ex-footer` markup; `grep -rl "ex-footer" examples/*.html` is the source of truth for
// that list and must be re-run whenever a page gains or loses the shared footer chrome.
//
// The remaining checks are four *component-level* contrast checks (the task-edit dialog, the
// resource-assign editor, the resource-utilization panel, zoom-levels' active button) — none of
// these depend on the shared chrome; each pins a specific plugin surface's own inline
// `--sg-*`-token-driven colors against the library's own dark-scheme resolution. Selectors were
// confirmed against the actual example pages and plugin source (see each test's own comment).

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const toLinear = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

function parseRgb(css: string): [number, number, number] {
  const m = css.match(/rgba?\(([^)]+)\)/);
  if (!m || m[1] === undefined) throw new Error(`unparseable color: ${css}`);
  const parts = m[1].split(",").map((p) => parseFloat(p.trim()));
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function contrastRatio(fg: string, bg: string): number {
  const l1 = relativeLuminance(parseRgb(fg));
  const l2 = relativeLuminance(parseRgb(bg));
  const [lighter, darker] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (lighter + 0.05) / (darker + 0.05);
}

// Demo pages whose own markup carries a static `.ex-footer` (distinct from index.html, which
// gets it injected by site.js at runtime — see the file header).
const STATIC_FOOTER_PAGES = ["basic.html", "hello.html", "load-chart-config.html"];

// Confirms a page outside STATIC_FOOTER_PAGES carries no `.ex-footer`, so the per-page contrast
// checks below are not silently under-covering a page that (re)gained the shared chrome.
test("a page outside STATIC_FOOTER_PAGES carries no .ex-footer", async ({ page }) => {
  await page.goto("/examples/basic-gantt.html");
  await expect(page.locator(".ex-footer")).toHaveCount(0);
});

async function footerContrast(page: Page, url: string): Promise<number> {
  await page.goto(url);
  const footer = page.locator(".ex-footer").first();
  await expect(footer).toBeVisible();
  const { fg, bg } = await footer.evaluate((el) => {
    const style = getComputedStyle(el);
    let bgEl: Element | null = el;
    let bg = "";
    while (bgEl) {
      const c = getComputedStyle(bgEl).backgroundColor;
      if (c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent") {
        bg = c;
        break;
      }
      bgEl = bgEl.parentElement;
    }
    return { fg: style.color, bg };
  });
  // A page that sets no background anywhere leaves the text on the browser canvas, whose color
  // comes from `color-scheme` rather than from any element — the library's stylesheet declares
  // `color-scheme: light dark`, so it follows the OS. Chromium paints #121212 there in the dark
  // scheme; the suite is chromium-only and pinned, so naming it is exact rather than a guess.
  return contrastRatio(fg, bg === "" ? "rgb(18, 18, 18)" : bg);
}

test("index.html — .ex-footer clears 4.5:1 text contrast in the dark scheme", async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: "dark" });
  const page = await context.newPage();
  const errors = watchPageErrors(page);
  const ratio = await footerContrast(page, "/examples/index.html");
  await context.close();
  expectNoPageErrors(errors);
  expect(ratio).toBeGreaterThanOrEqual(4.5);
});

for (const pageFile of STATIC_FOOTER_PAGES) {
  test(`${pageFile} — .ex-footer clears 4.5:1 text contrast in the dark scheme`, async ({
    browser,
  }) => {
    const context = await browser.newContext({ colorScheme: "dark" });
    const page = await context.newPage();
    const errors = watchPageErrors(page);
    const ratio = await footerContrast(page, `/examples/${pageFile}`);
    await context.close();
    expectNoPageErrors(errors);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
}

// docs/specs/plugins/interaction.md — the task-edit dialog is styled inline from the shared
// `--sg-dialog-*` custom properties; a dark-scheme page falling back to their light literals would
// read as a white dialog over a dark chart. resources-load-chart.html toggles the dialog with
// `#dialog-toggle` (confirmed by reading the page); the dialog itself is `.sg-edit-dialog` /
// `.sg-edit-dialog-input` (confirmed against
// packages/plugins/interaction/src/internal/edit-dialog/dialog.ts's `DIALOG_CLASS` and fields.ts).
test("resources-load-chart.html — the task-edit dialog follows the color scheme", async ({
  browser,
}) => {
  for (const colorScheme of ["light", "dark"] as const) {
    const context = await browser.newContext({ colorScheme });
    const page = await context.newPage();
    const errors = watchPageErrors(page);
    await page.goto("/examples/resources-load-chart.html");
    await expect(page.locator(".sg-pane--chart canvas").first()).toBeVisible();

    await page.locator("#dialog-toggle").click();
    await expect(page.locator("#dialog-toggle")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".sg-pane--grid .sg-grid-row").first()).toBeVisible();
    const point = await page.evaluate(() => {
      const row = document.querySelector(".sg-pane--grid .sg-grid-row");
      if (row === null) throw new Error("the grid has no rows");
      const r = row.getBoundingClientRect();
      return { x: r.left + 60, y: r.top + r.height / 2 };
    });
    await page.mouse.dblclick(point.x, point.y);

    const dialog = page.locator(".sg-edit-dialog");
    await expect(dialog).toBeVisible();
    const probe = await dialog.evaluate((el) => {
      const dialogStyle = getComputedStyle(el);
      const input = el.querySelector(".sg-edit-dialog-input");
      if (input === null) throw new Error("the dialog has no fields");
      const inputStyle = getComputedStyle(input);
      return {
        dialogFg: dialogStyle.color,
        dialogBg: dialogStyle.backgroundColor,
        inputFg: inputStyle.color,
        inputBg: inputStyle.backgroundColor,
      };
    });
    await context.close();
    expectNoPageErrors(errors);

    expect(
      contrastRatio(probe.dialogFg, probe.dialogBg),
      `${colorScheme}: dialog text on the dialog surface`,
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(probe.inputFg, probe.inputBg),
      `${colorScheme}: field text on the field background`,
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(probe.dialogBg, probe.inputBg),
      `${colorScheme}: dialog surface against the chart background`,
    ).toBeLessThan(3);
  }
});

// Floating panels whose colors are read inline from `--sg-ra-editor-*` (resource-assign's
// assignment editor) and `--sg-ru-panel-*` (resource-utilization's summary/trend cards). Selectors
// confirmed against plugin source: `.sg-ra-editor` / `[data-sg-ra-open]`
// (packages/plugins/resource/src/internal/assign/editor.ts, cell.ts) and `.sg-ru-panel`, triggered
// by `#btn-summary` (packages/plugins/resource/src/internal/utilization/panels.ts, confirmed by
// reading examples/resource-utilization.html).
const FLOATING_SURFACES = [
  {
    name: "resource-assign's assignment editor",
    url: "/examples/resource-assign.html",
    surface: ".sg-ra-editor",
    async open(page: Page): Promise<void> {
      await expect(page.locator("button[data-sg-ra-open]").first()).toBeVisible();
      await page.locator("button[data-sg-ra-open]").first().click();
    },
  },
  {
    name: "resource-utilization's team-capacity panel",
    url: "/examples/resource-utilization.html",
    surface: ".sg-ru-panel",
    async open(page: Page): Promise<void> {
      await page.locator("#btn-summary").click();
    },
  },
] as const;

for (const surface of FLOATING_SURFACES) {
  test(`${surface.name} follows the color scheme`, async ({ browser }) => {
    for (const colorScheme of ["light", "dark"] as const) {
      const context = await browser.newContext({ colorScheme });
      const page = await context.newPage();
      const errors = watchPageErrors(page);
      await page.goto(surface.url);
      await expect(page.locator(".sg-pane--chart canvas").first()).toBeVisible();
      await settle(page);
      await surface.open(page);

      const panel = page.locator(surface.surface).first();
      await expect(panel).toBeVisible();
      const probe = await panel.evaluate((el) => {
        const style = getComputedStyle(el);
        const pane = document.querySelector(".sg-pane--chart");
        const row = pane?.closest(".sg-pane-row") ?? null;
        const chart = row === null ? pane?.parentElement : row.parentElement;
        if (chart === null || chart === undefined) throw new Error("the widget root is missing");
        return {
          fg: style.color,
          bg: style.backgroundColor,
          chartBg: getComputedStyle(chart).backgroundColor,
        };
      });
      await context.close();
      expectNoPageErrors(errors);

      expect(
        contrastRatio(probe.fg, probe.bg),
        `${colorScheme}: panel text on the panel surface`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(probe.bg, probe.chartBg),
        `${colorScheme}: panel surface against the chart background`,
      ).toBeLessThan(3);
    }
  });
}

// zoom-levels.html marks the active zoom-level button with a `.active` class (confirmed by reading
// the page: `btn.classList.toggle("active", isActive)`), styled the same as `[aria-pressed="true"]`.
test("zoom-levels.html — button.active label clears 4.5:1 in both color schemes", async ({
  browser,
}) => {
  for (const colorScheme of ["light", "dark"] as const) {
    const context = await browser.newContext({ colorScheme });
    const page = await context.newPage();
    const errors = watchPageErrors(page);
    await page.goto("/examples/zoom-levels.html");
    const activeBtn = page.locator("button.active").first();
    await expect(activeBtn).toBeVisible();
    const { fg, bg } = await activeBtn.evaluate((el) => {
      const style = getComputedStyle(el);
      return { fg: style.color, bg: style.backgroundColor };
    });
    const ratio = contrastRatio(fg, bg);
    await context.close();
    expectNoPageErrors(errors);
    expect(ratio, `${colorScheme} scheme`).toBeGreaterThanOrEqual(4.5);
  }
});
