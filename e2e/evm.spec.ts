import { expect, test } from "./_fixtures";
import { settle } from "./_fixtures";

// E2E for examples/evm.html: the `stargantt.tracking` plugin's `evm` nest
// (docs/specs/plugins/tracking.md §1.4/§2.14/§2.15), composed as an OPT-IN plugin on top of
// `presetStandard()`.
//
// Overlap check against e2e/tracking.spec.ts (which already exercises `stargantt.evm` on
// `examples/tracking.html`): that file reads the dashboard's ten tiles against
// `EvmService.projectMetrics()` but its dataset has AC = 0 everywhere (CPI is undefined, never
// exercised) and its file header explicitly defers "EVM's S-curve panel, its own Close button, and
// the SPI-behind/CPI-over textual flags" here. This file therefore does NOT re-cover the
// tile-vs-service-numbers comparison; it covers exactly what tracking.spec.ts defers: both textual
// flags together (this page's dataset is deliberately behind schedule AND over cost), Escape-close,
// the S-curve panel end to end, and the page's own status-date re-boot mechanic (unique to this
// page — no other example recreates the instance to change a fixed status date).

const CONTAINER = "#chart";
const DAY_MS = 86_400_000;

declare const gantt: {
  service(key: "stargantt.evm"): {
    statusDate(): number;
    projectMetrics(): { bac: number; pv: number; ev: number; ac: number; spi?: number; cpi?: number };
  };
};

async function bootEvm(page: import("@playwright/test").Page, openExample: import("./_fixtures").OpenExample): Promise<void> {
  // No fixedTime here: the page itself computes "today" via `Math.floor(Date.now()/DAY)*DAY` and
  // then re-derives all its offsets from that, so an unpinned real clock is fine — every assertion
  // reads figures back through the same service the page seeded, never a hardcoded calendar date.
  await openExample("evm.html", { ready: `${CONTAINER} canvas` });
  await settle(page);
}

test.describe("EVM dashboard panel", () => {
  test("shows KPI tiles with BOTH textual flags (behind schedule AND over cost); Escape closes", async ({
    page,
    openExample,
  }) => {
    await bootEvm(page, openExample);

    const dashboard = page.getByRole("dialog", { name: "Earned value" });
    await expect(dashboard).toHaveCount(0); // default-off: opens only on request

    await page.locator("#evm-dashboard").click();
    await settle(page);
    await expect(dashboard).toBeVisible();
    expect(await dashboard.getAttribute("class")).toBe("sg-evm-dashboard");

    for (const label of ["BAC", "PV", "EV", "AC", "SV", "CV", "SPI", "CPI", "EAC", "ETC"]) {
      await expect(dashboard.getByText(label, { exact: true })).toBeVisible();
    }
    // BAC = 4000 (plan) + 8000 (design) + 12000 (impl).
    await expect(dashboard.getByText("24,000", { exact: true })).toBeVisible();

    // The seeded data is deliberately behind schedule (EV < PV) AND over cost (EV < AC) at the
    // "Today" status date — both textual flags fire together, never color alone
    // (packages/plugins/tracking/src/internal/evm/panels.ts renders `⚠ ${flag}`).
    await expect(dashboard.getByText("⚠ behind schedule")).toBeVisible();
    await expect(dashboard.getByText("⚠ over cost")).toBeVisible();

    await dashboard.press("Escape");
    await expect(dashboard).toHaveCount(0);
  });
});

test.describe("EVM S-curve panel", () => {
  test("opens with an accessible per-point list and closes via its own Close button", async ({
    page,
    openExample,
  }) => {
    await bootEvm(page, openExample);

    const curve = page.getByRole("dialog", { name: "EVM S-curve" });
    await expect(curve).toHaveCount(0);

    await page.locator("#evm-curve").click();
    await settle(page);
    await expect(curve).toBeVisible();
    expect(await curve.getAttribute("class")).toBe("sg-evm-curve");

    // The accessible equivalent of the plotted PV/EV/AC lines: a per-point text list
    // (tracking.md §2.15's `evmCurvePoint` builder — "<date> — PV <pv>" at minimum).
    await expect(curve.getByText(/PV/).first()).toBeVisible();

    await curve.getByRole("button", { name: "Close" }).click();
    await expect(curve).toHaveCount(0);
  });
});

test.describe("status-date re-boot", () => {
  test("the status-date buttons re-create the chart at a different resolved EVM status date", async ({
    page,
    openExample,
  }) => {
    await bootEvm(page, openExample);

    const T0 = (await page.evaluate(() => Math.floor(Date.now() / 86_400_000) * 86_400_000)) as number;
    expect(await page.evaluate(() => gantt.service("stargantt.evm").statusDate())).toBe(T0);

    const metricsAtToday = await page.evaluate(() => gantt.service("stargantt.evm").projectMetrics());

    const backButton = page.locator("#status-back");
    await expect(backButton).toHaveAttribute("aria-pressed", "false");
    await backButton.click();
    // `boot()` disposes the old GanttInstance and creates a fresh one into the same #chart element.
    await expect(page.locator(`${CONTAINER} canvas`).first()).toBeVisible();
    await settle(page);

    await expect(backButton).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#status-today")).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("#status-readout")).toContainText("Status date:");

    expect(await page.evaluate(() => gantt.service("stargantt.evm").statusDate())).toBe(T0 - 3 * DAY_MS);
    // An earlier status date resolves a smaller (or equal) planned value than "today" for a task
    // whose plan has not finished yet — this dataset's PV strictly decreases going back 3 days.
    const metricsAt3DaysAgo = await page.evaluate(() => gantt.service("stargantt.evm").projectMetrics());
    expect(metricsAt3DaysAgo.pv).toBeLessThan(metricsAtToday.pv);

    // Returning to "Today" re-creates the chart again and restores the original resolved date.
    await page.locator("#status-today").click();
    await expect(page.locator(`${CONTAINER} canvas`).first()).toBeVisible();
    await settle(page);
    await expect(page.locator("#status-today")).toHaveAttribute("aria-pressed", "true");
    expect(await page.evaluate(() => gantt.service("stargantt.evm").statusDate())).toBe(T0);
  });
});
