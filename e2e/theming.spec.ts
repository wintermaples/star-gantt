import { expect, test } from "./_fixtures";
import type { Page } from "@playwright/test";

// Feature E2E for examples/theming-css-vars.html (docs/specs/plugins/view.md — per-chart
// colour-scheme pin, `audit()`, and task-bars.md §1.11 bar outline+bevel). `ThemeService` is
// store-shaped, with `get`/`audit`/`setPreset`/`preset`/`presets`/`setColorScheme`/`colorScheme`/
// `refresh`; theme changes surface through the `theme.tokens` store, not used directly by this
// file.
//
// Page conventions: the debug handle is the page's own `window.gantt` (every example page's own
// convention, see examples/basic.html); the mount container is `#chart`
// (examples/theming-css-vars.html mounts on `<div id="chart" class="sg-root">`); the theme buttons
// are `#themeButtons button[data-theme="..."]`.
//
// The bug this covers: a page palette overrides *part* of the token set, and before the per-chart
// scheme pin the remainder resolved against the OS. `theme-css-vars.html`'s dark theme only
// overrides `--sg-grid-nonworking`, never `--sg-grid-offhours` / `--sg-calendar-nonworking`
// (packages/stargantt/src/styles/layout.css confirms both default to the same translucent red
// pair, light/dark) — those two are what this file asks for.
test.use({ colorScheme: "light" });

const UNSET_BY_THE_PAGE = {
  "--sg-grid-offhours": {
    light: "rgba(220, 38, 38, 0.08)",
    dark: "rgba(248, 113, 113, 0.12)",
  },
  "--sg-calendar-nonworking": {
    light: "rgba(220, 38, 38, 0.08)",
    dark: "rgba(248, 113, 113, 0.12)",
  },
} as const;

interface AuditEntry {
  id: string;
  kind: string;
  measured: number;
  min: number;
  ok: boolean;
}

declare const gantt: {
  service(key: "stargantt.theme"): {
    get(token: string): string;
    audit(): readonly AuditEntry[];
  };
};

function channels(css: string): [number, number, number, number] {
  const fn = /rgba?\(([^)]+)\)/.exec(css);
  if (fn !== null && fn[1] !== undefined) {
    const parts = fn[1].split(",").map((p) => parseFloat(p.trim()));
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, Math.round((parts[3] ?? 1) * 100) / 100];
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(css.trim());
  if (hex === null || hex[1] === undefined) throw new Error(`unparseable colour: ${css}`);
  const n = Number.parseInt(hex[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
}

async function tokens(page: Page, names: readonly string[]) {
  return page.evaluate((list) => {
    const theme = gantt.service("stargantt.theme");
    return Object.fromEntries(list.map((name) => [name, theme.get(name)])) as Record<string, string>;
  }, names);
}

test.beforeEach(async ({ openExample }) => {
  await openExample("theming-css-vars.html", { ready: "#chart canvas" });
});

test("an unpinned chart follows the page, and pinning re-resolves the whole default palette", async ({
  page,
}) => {
  const names = Object.keys(UNSET_BY_THE_PAGE);

  // The page boots on "System default": no class, no overrides, so a light browser gets the light
  // half of every pair.
  const before = await tokens(page, names);
  for (const [name, pair] of Object.entries(UNSET_BY_THE_PAGE)) {
    expect(channels(before[name] ?? ""), `${name} unpinned`).toEqual(channels(pair.light));
  }

  await page.click('#themeButtons button[data-theme="dark"]');
  await expect(page.locator("#chart")).toHaveClass(/sg-scheme-dark/);

  // The tokens the page's dark block never mentions must now resolve dark — on a *light* browser.
  // Before the per-chart pin these stayed light, which is what put white columns on a dark chart.
  const after = await tokens(page, names);
  for (const [name, pair] of Object.entries(UNSET_BY_THE_PAGE)) {
    expect(channels(after[name] ?? ""), `${name} pinned dark`).toEqual(channels(pair.dark));
  }

  // Handing the scheme back leaves no trace on the host's element.
  await page.click('#themeButtons button[data-theme="light"]');
  await expect(page.locator("#chart")).not.toHaveClass(/sg-scheme-/);
});

test("each of the page's themes passes its own contrast audit", async ({ page }) => {
  for (const name of ["light", "dark", "ocean", "classic", "glass"]) {
    await page.click(`#themeButtons button[data-theme="${name}"]`);
    const failures = await page.evaluate(() =>
      gantt
        .service("stargantt.theme")
        .audit()
        .filter((entry) => !entry.ok)
        .map((entry) => `${entry.id}: ${String(entry.measured)} < ${String(entry.min)}`),
    );
    expect(failures, `theme ${name}`).toEqual([]);

    // A palette that measured nothing would pass vacuously; every theme must offer real pairs.
    const measured = await page.evaluate(() => gantt.service("stargantt.theme").audit().length);
    expect(measured).toBeGreaterThan(10);
  }
});

test("the classic theme turns on the bar outline and bevel tokens", async ({ page }) => {
  await page.click('#themeButtons button[data-theme="classic"]');
  const decoration = await tokens(page, [
    "--sg-bar-radius",
    "--sg-bar-stroke-width",
    "--sg-bar-fill-bevel",
    "--sg-header-font",
  ]);
  expect(decoration["--sg-bar-radius"]).toBe("0px");
  expect(decoration["--sg-bar-stroke-width"]).toBe("1px");
  expect(Number.parseFloat(decoration["--sg-bar-fill-bevel"] ?? "0")).toBeGreaterThan(0);
  // `--sg-header-font: 12px var(--sg-canvas-font-family)` (layout.css): the header font token,
  // which the page never declares itself, must have picked the theme's family up through `var()`.
  expect(decoration["--sg-header-font"]).toContain("Tahoma");
});

test("the glass theme keeps the chart surface translucent", async ({ page }) => {
  await page.click('#themeButtons button[data-theme="glass"]');
  const surface = await tokens(page, ["--sg-bg", "--sg-header-bg"]);
  // docs/specs/plugins/view.md / layout.css: the surfaces composite over whatever the host put
  // behind the mount element.
  expect(channels(surface["--sg-bg"] ?? "")[3]).toBeLessThan(1);
  expect(channels(surface["--sg-header-bg"] ?? "")[3]).toBeLessThan(1);
});
