import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Structural end-to-end checks over every page the site serves.
 *
 * No screenshot baselines: at this page count they would cost more to maintain than they would
 * catch, and a baseline that passes is evidence a page did not change, not evidence it works. What
 * is asserted instead is that each page runs — no page error, a real chart mounted, an accessible
 * tree behind it — and that the interactions the docs are built on actually change the chart.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const api = JSON.parse(readFileSync(join(HERE, "../src/generated/api.json"), "utf8")) as {
  plugins: Array<{ id: string }>;
};
/**
 * Guides and core chapters are discovered from the filesystem, for the same reason the site's own
 * registry is: a page nobody remembered to add to a list is a page nobody tests.
 */
const slugsIn = (dir: string): string[] =>
  readdirSync(join(HERE, "../src/content", dir))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => /slug:\s*"([^"]+)"/.exec(readFileSync(join(HERE, "../src/content", dir, f), "utf8"))?.[1])
    .filter((slug): slug is string => slug !== undefined);

const GUIDES = slugsIn("guides");
const CORE = slugsIn("core");

const shortName = (id: string): string => id.replace(/^stargantt\./, "");
// Every plugin has a page — the coverage test enforces it, so there is no list of exceptions here.
const documented = api.plugins;

/** Fails the test on the first uncaught error, rather than letting a broken page look fine. */
function watchForErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  return errors;
}

/**
 * Screenshots an element repeatedly until two consecutive shots match, so a comparison is made
 * against a finished frame rather than whatever the chart happened to have painted after a fixed
 * sleep. A fixed delay here produced deterministic *wrong* answers: the heavier plugins had not
 * finished rebuilding at 150ms, so their demos read as inert when they were not.
 *
 * Pixel stability alone is not enough either, which is what `rendered()` below is for. Two
 * consecutive identical frames are also what a chart that has not started rebuilding yet looks
 * like, so a slow-to-start rebuild returns the *previous* value's chart — and the failure is
 * silent, because a stale frame is a perfectly valid-looking one. Every caller here waits for the
 * mount counter to move first and only then lets the pixels settle.
 */
async function settle(page: Page, target: ReturnType<Page["locator"]>): Promise<Buffer> {
  let previous = await target.screenshot();
  for (let i = 0; i < 25; i += 1) {
    await page.waitForTimeout(100);
    const next = await target.screenshot();
    if (Buffer.compare(previous, next) === 0) return next;
    previous = next;
  }
  return previous;
}

/** The preview's mount counter — `GanttPreview` bumps it once per attempted mount. */
async function renderCount(preview: ReturnType<Page["locator"]>): Promise<number> {
  return Number((await preview.getAttribute("data-render")) ?? "0");
}

/**
 * Waits for a preview to report a completed mount, then for its canvas to exist.
 *
 * `data-render` is the deterministic signal and the canvas assertion is the corroboration, in that
 * order. Waiting on the canvas alone leant on Playwright's 5 s default, which a page holding six
 * charts exceeded whenever the machine was busy with the other workers — the chart was fine, the
 * clock was not.
 */
async function mounted(preview: ReturnType<Page["locator"]>): Promise<void> {
  await expect.poll(async () => renderCount(preview), { timeout: 20_000 }).toBeGreaterThan(0);
  await expect(preview.locator("canvas").first()).toBeVisible();
}

/**
 * Runs `act`, waits for the preview to mount a new chart because of it, then waits for that chart
 * to stop moving. Returns the finished frame.
 */
async function rendered(
  page: Page,
  preview: ReturnType<Page["locator"]>,
  act: () => Promise<void>,
): Promise<Buffer> {
  const before = await renderCount(preview);
  await act();
  await expect
    .poll(async () => renderCount(preview), { timeout: 15_000 })
    .toBeGreaterThan(before);
  return settle(page, preview);
}

async function open(page: Page, route: string): Promise<string[]> {
  const errors = watchForErrors(page);
  await page.goto(`/#${route}`, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelector(".shell") !== null);
  // The shell renders before the route's content module has arrived — pages are fetched per route,
  // not shipped with the app — and while it is in flight the route renders a placeholder carrying
  // `data-loading`. Asserting before it clears reads an empty page as a page with nothing on it.
  await page.waitForFunction(() => document.querySelector("[data-loading]") === null);
  return errors;
}

test.describe("every documented page", () => {
  test("the landing page runs and mounts a chart", async ({ page }) => {
    const errors = await open(page, "/");
    await mounted(page.getByTestId("gantt-preview").first());
    expect(errors).toEqual([]);
  });

  for (const plugin of documented) {
    test(`${shortName(plugin.id)} reference page`, async ({ page }) => {
      const errors = await open(page, `/reference/${shortName(plugin.id)}`);

      // Every API kind has a tab, including the empty ones.
      const tabs = page.getByRole("tab");
      await expect(tabs).toHaveCount(7);

      // Each tab renders something rather than a blank panel.
      for (const label of ["Overview", "Config", "Services", "Events", "Commands", "Extension points", "Recipes"]) {
        await page.getByRole("tab", { name: new RegExp(`^${label}`) }).click();
        await expect(page.locator(".page")).not.toBeEmpty();
      }

      // The overview chart is a real instance, with the parallel accessible tree behind it.
      // Polled, not sampled: coming back to this tab remounts the chart, and the accessible mirror
      // is built a frame after the canvas appears — reading it once raced that frame on the pages
      // whose overview happens to compose the most plugins.
      //
      // A plugin no static chart can show says so instead, in a callout carrying its reason
      // (D-23). That page has no instance to assert on, and asserting one anyway would leave the
      // corpus with a rule it can only satisfy by faking a demo.
      await page.getByRole("tab", { name: /^Overview/ }).click();
      const preview = page.getByTestId("gantt-preview").first();
      const noDemo = page.getByTestId("overview-no-demo");
      await expect
        .poll(async () => (await preview.count()) + (await noDemo.count()))
        .toBeGreaterThan(0);
      if ((await noDemo.count()) === 0) {
        // Scrolled to, not waited for from the top of the page: a chart is built when it comes
        // within a screen of the viewport, and the longest overview tabs push it further down the
        // scroll pane than that margin reaches. A reader gets the chart by scrolling to it, so a
        // test that asserts from the top is asserting something no reader ever does.
        await preview.scrollIntoViewIfNeeded();
        await mounted(preview);
        await expect.poll(async () => page.getByRole("row").count()).toBeGreaterThan(0);
      }

      expect(errors).toEqual([]);
    });

    test(`${shortName(plugin.id)} config page`, async ({ page }) => {
      const errors = await open(page, `/reference/${shortName(plugin.id)}/config`);
      const preview = page.getByTestId("gantt-preview").first();
      await mounted(preview);

      // No example on the page may be reporting itself as broken.
      await expect(page.getByRole("alert")).toHaveCount(0);

      // Every value a picker offers must render differently from every other value it offers.
      //
      // "Different from the default" is not enough, and finding that out is why this is written the
      // hard way: a three-value picker whose second and third values were identical to each other
      // passed the weaker check on the strength of the second one alone, while presenting the
      // reader a choice between two charts that were byte-identical. A control that offers a choice
      // with no consequence is worse than no control.
      //
      // An option with no visual consequence belongs in `demo: { kind: "none", reason }` (D-09),
      // where the reason is on the record instead of hidden behind a dead button.
      const pickers = page.locator(".prop-section .seg");
      const total = await pickers.count();
      const dead: string[] = [];
      const broken: string[] = [];
      for (let i = 0; i < total; i += 1) {
        const picker = pickers.nth(i);
        const name = (await picker.getAttribute("aria-label")) ?? `picker ${i}`;
        const buttons = picker.getByRole("button");
        const count = await buttons.count();
        const seen = new Map<string, string>();
        const duplicates: string[] = [];
        for (let v = 0; v < count; v += 1) {
          const label = (await buttons.nth(v).textContent())?.trim() ?? `value ${v}`;
          const shot = (
            await rendered(page, preview, async () => {
              await buttons.nth(v).click();
            })
          ).toString("base64");

          // A value must produce a working chart, not merely a distinct picture. A demo that
          // composes a plugin without one of its dependencies fails to build, and the resulting
          // broken chart is perfectly stable and perfectly distinct — it sailed past the
          // duplicate check on every page where the values happened to break differently. The
          // parallel ARIA tree only exists when the chart actually rendered rows, so its absence
          // is the cheapest honest signal that this demo does not run.
          if ((await page.getByRole("row").count()) === 0) broken.push(`${label} — chart did not build`);

          const twin = seen.get(shot);
          if (twin !== undefined) duplicates.push(`${label} == ${twin}`);
          else seen.set(shot, label);
        }
        // Leave the page at rest for the next picker, and wait for that reset to land too.
        await rendered(page, preview, async () => {
          await buttons.first().click();
        });
        if (duplicates.length > 0) dead.push(`${name}: ${duplicates.join("; ")}`);
      }
      expect(
        broken,
        "these demo values do not produce a working chart — most often a plugin composed without one of its dependencies (progressTracking needs taskFields, which presetStandard does not include)",
      ).toEqual([]);
      expect(
        dead,
        'these values render identically to each other — drop the redundant value, or document the option as demo: { kind: "none", reason }',
      ).toEqual([]);

      expect(errors).toEqual([]);
    });
  }
});

test.describe("guides", () => {
  for (const slug of GUIDES) {
    test(`${slug} runs every cell`, async ({ page }) => {
      const errors = await open(page, `/guides/${slug}`);

      // A guide's promise is that its code is live. Every output cell must therefore hold a chart
      // that actually built — a runnable cell whose demo throws renders an error, not a lesson.
      const previews = page.getByTestId("gantt-preview");
      const count = await previews.count();
      expect(count, "a guide with no runnable cell is an article").toBeGreaterThanOrEqual(1);
      // Scrolled to, one at a time, because that is when each chart is built: a guide's later cells
      // are not mounted until the reader reaches them. Scrolling here is not a workaround for the
      // deferral, it is the test of it — a chart that never builds on approach fails right here.
      for (let i = 0; i < count; i += 1) {
        await previews.nth(i).scrollIntoViewIfNeeded();
        await mounted(previews.nth(i));
      }
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect.poll(async () => page.getByRole("row").count()).toBeGreaterThan(0);

      // The editors are the point of this layout, so they have to have mounted. Polled, not
      // sampled: CodeMirror arrives in its own chunk and nothing on the page waits for it, so a
      // single read races the download whenever the other workers have the machine busy.
      await expect.poll(async () => page.locator(".cm-editor").count()).toBeGreaterThanOrEqual(1);

      expect(errors).toEqual([]);
    });
  }
});

/**
 * Listings a reader copies rather than edits. They are the same editor held read-only, so what is
 * asserted is that it mounted *and* that it coloured something — an editor whose grammar never
 * matched renders one flat colour, which is the state a plain block of text was already in and is
 * invisible in a count of editors.
 */
test.describe("static listings", () => {
  test("are highlighted, and stay out of the tab order", async ({ page }) => {
    const errors = await open(page, "/guides/your-first-chart");
    const listings = page.locator(".static-code .cm-editor");
    await expect(listings.first()).toBeVisible();
    expect(await listings.count()).toBeGreaterThanOrEqual(2);

    // The complete-page listing is HTML, and its grammar is not the TypeScript one every cell uses.
    const colours = await page.evaluate(() => {
      const editor = document.querySelector(".static-code .cm-editor");
      const spans = editor?.querySelectorAll(".cm-line span") ?? [];
      return new Set([...spans].map((span) => getComputedStyle(span).color)).size;
    });
    expect(colours, "a listing showing one colour is a listing with no highlighting").toBeGreaterThan(1);

    // A reference page carries a dozen recipes; if each were focusable, reaching the next link
    // would mean tabbing through all of them.
    expect(await page.locator(".static-code .cm-content[contenteditable='true']").count()).toBe(0);

    expect(errors).toEqual([]);
  });
});

/**
 * A runnable cell holds a `DemoSpec` — this site's own shape, which appears in no reader's project.
 * The disclosure under it is where that shape is cashed out into the call a reader would write, so
 * what matters is that it names `create()` and reflects the cell that actually ran.
 */
test.describe("the call a runnable cell makes", () => {
  test("opens, shows the whole call, and follows the cell", async ({ page }) => {
    const errors = await open(page, "/guides/your-first-chart");
    const disclosures = page.locator("details.call-made");
    await expect(disclosures.first()).toBeVisible();

    // Closed on arrival: the chart is what the prose is pointing at.
    expect(await disclosures.first().evaluate((node: HTMLDetailsElement) => node.open)).toBe(false);

    await disclosures.first().locator("summary").click();
    const call = disclosures.first().locator(".static-code");
    await expect(call.locator(".cm-editor")).toBeVisible();
    const text = await call.innerText();
    expect(text).toContain("StarGantt.create({");
    expect(text).toContain("StarGantt.presetStandard(");
    // The first cell of this guide raises the row height, so the call has to carry it.
    expect(text).toContain("rowHeight: 36");
    expect(text).toContain('gantt.service("stargantt.data").load(tasks);');

    // Asking once asks for the page: every other cell's pane is open too.
    const second = disclosures.nth(1);
    await second.scrollIntoViewIfNeeded();
    expect(await second.evaluate((node: HTMLDetailsElement) => node.open)).toBe(true);
    // And that one adds an opt-in plugin, which has to be named rather than elided.
    await expect(second.locator(".static-code")).toContainText("StarGantt.perfTools()");

    expect(errors).toEqual([]);
  });
});

/**
 * The theme button. Two things are worth asserting and neither is visible in a screenshot: that the
 * choice survives a reload, and that a chart already on screen repaints into the new scheme. The
 * second is the one that broke first — a chart watches its own element for a theme change, never
 * the `<html>` this button writes to, so without the host telling it the tokens move underneath a
 * chart that has already cached them and it paints half in each scheme.
 */
test.describe("theme", () => {
  test("cycles, persists, and repaints a chart that is already mounted", async ({ page }) => {
    const errors = await open(page, "/");
    const preview = page.getByTestId("gantt-preview").first();
    await mounted(preview);

    const button = page.getByRole("button", { name: /^Theme:/ });
    await expect(button).toHaveAttribute("aria-label", /follows your system/);

    // Headless Chromium reports a light OS scheme, so the chart starts light.
    const light = await paintedBrightness(page);

    // system -> light -> dark, and back round.
    await button.click();
    await expect.poll(async () => page.evaluate(() => document.documentElement.dataset["theme"])).toBe("light");
    await button.click();
    await expect.poll(async () => page.evaluate(() => document.documentElement.dataset["theme"])).toBe("dark");

    // The pixels already on the canvas, not the variables behind them: the CSS follows the button
    // on its own, and a chart that was never told would keep painting the light palette over them.
    await expect.poll(async () => paintedBrightness(page), { timeout: 10_000 }).toBeLessThan(light - 0.3);

    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => document.querySelector("[data-loading]") === null);
    expect(await page.evaluate(() => document.documentElement.dataset["theme"])).toBe("dark");

    await page.getByRole("button", { name: /^Theme:/ }).click();
    await expect.poll(async () => page.evaluate(() => document.documentElement.dataset["theme"])).toBe(undefined);

    expect(errors).toEqual([]);
  });
});

/** Mean brightness (0..1) of the first preview's background canvas, read back from its own pixels. */
async function paintedBrightness(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(".preview-mount canvas");
    if (!canvas) return Number.NaN;
    const context = canvas.getContext("2d");
    if (!context) return Number.NaN;
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let sum = 0;
    // Every 400th pixel: enough of a sample to tell two palettes apart, cheap enough to poll.
    const stride = 400 * 4;
    let n = 0;
    for (let i = 0; i < data.length; i += stride) {
      sum += (0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!) / 255;
      n += 1;
    }
    return n === 0 ? Number.NaN : sum / n;
  });
}

/**
 * The demo cells run on arrival and then only on demand. Both halves matter: a reader who only
 * reads still gets a working chart, and a reader who types does not rebuild a gantt instance per
 * keystroke.
 */
test.describe("runnable cells", () => {
  test("run on arrival, then only when Run is pressed", async ({ page }) => {
    const errors = await open(page, "/guides/your-first-chart");
    const preview = page.getByTestId("gantt-preview").first();
    await mounted(preview);

    const run = page.getByRole("button", { name: /Run/ }).first();
    await expect(run).toBeDisabled();

    // An edit alone must not rebuild anything.
    const before = await renderCount(preview);
    // `.card` is the runnable cell's own frame. Plain `.cm-content` now finds the guide's first
    // *listing*, which is the same editor held read-only — typing into it changes nothing and the
    // assertions below would be measuring the wrong cell.
    await page.locator(".card .cm-content").first().click();
    await page.keyboard.type("  ");
    await expect(page.locator(".card-head .hint").first()).toBeVisible();
    await expect(run).toBeEnabled();
    await page.waitForTimeout(600);
    expect(await renderCount(preview)).toBe(before);

    // Pressing Run does.
    await rendered(page, preview, async () => {
      await run.click();
    });
    await expect(run).toBeDisabled();

    expect(errors).toEqual([]);
  });
});

/**
 * A demo that paints its own HTML has to land where a reader can see it. The first draft of the
 * event guide's badge was appended to a `renderer/domOverlays` wrapper — a zero-size anchor in
 * content coordinates — and positioned with `right`/`bottom`, which put it outside the pane, where
 * the overlay host's `overflow: hidden` swallowed it. The badge was in the DOM and its text was
 * updating the whole time, so every existing assertion passed while nothing was on screen.
 */
test.describe("a demo's own HTML", () => {
  test("the event guide's badge sits inside the chart pane", async ({ page }) => {
    const errors = await open(page, "/guides/listening-to-events");
    const preview = page.getByTestId("gantt-preview").first();
    await preview.scrollIntoViewIfNeeded();
    await mounted(preview);

    const badge = preview.locator(".sg-pane--chart > div[style*='border-radius']").first();
    await expect(badge).toBeVisible();

    const fits = await badge.evaluate((el) => {
      const b = el.getBoundingClientRect();
      const pane = (el.parentElement as HTMLElement).getBoundingClientRect();
      return {
        inside:
          b.left >= pane.left && b.right <= pane.right && b.top >= pane.top && b.bottom <= pane.bottom,
        painted: b.width > 0 && b.height > 0,
      };
    });
    expect(fits).toEqual({ inside: true, painted: true });
    expect(errors).toEqual([]);
  });
});

test.describe("core chapters", () => {
  for (const slug of CORE) {
    test(`${slug} renders`, async ({ page }) => {
      const errors = await open(page, `/core/${slug}`);
      await expect(page.locator(".page")).not.toBeEmpty();
      // Scrolled to one at a time, for the same reason the guides are: a chapter's charts are
      // built on approach, so reaching them is part of what this asserts.
      const previews = page.getByTestId("gantt-preview");
      for (let i = 0; i < (await previews.count()); i += 1) {
        await previews.nth(i).scrollIntoViewIfNeeded();
        await mounted(previews.nth(i));
      }
      await expect(page.getByRole("alert")).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  }
});

test.describe("layout", () => {
  test.use({ viewport: { width: 720, height: 540 } });

  const sample = [
    "/",
    ...documented.slice(0, 3).flatMap((p) => [
      `/reference/${shortName(p.id)}`,
      `/reference/${shortName(p.id)}/config`,
    ]),
  ];

  for (const route of sample) {
    test(`${route} fits the 720x540 minimum`, async ({ page }) => {
      const errors = await open(page, route);
      const overflow = await page.evaluate(() => {
        const main = document.querySelector(".main");
        return {
          page: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          main: main ? main.scrollWidth > main.clientWidth + 1 : false,
        };
      });
      expect(overflow).toEqual({ page: false, main: false });
      expect(errors).toEqual([]);
    });
  }
});


/**
 * Search. What is worth asserting here is what a unit test cannot reach: that the index is fetched
 * at all (it is a dynamic import, so a build that failed to emit its chunk fails here and nowhere
 * else), that the keyboard path works end to end, and that a hit lands on the page it names — the
 * tab and option deep links in particular, which are the only reason those query parameters exist.
 */
test.describe("search", () => {
  test("finds a plugin and opens its page from the keyboard alone", async ({ page }) => {
    const errors = await open(page, "/");
    const box = page.getByRole("combobox", { name: "Search the documentation" });

    // The index is not loaded until the box is used: nothing here should be fetched on page load.
    await expect(box).toBeVisible();
    await box.press("u");
    await box.fill("undo-redo");

    const results = page.getByRole("listbox", { name: "Search results" });
    await expect(results).toBeVisible();
    await expect(results.getByRole("option").first()).toContainText("undo-redo");

    await box.press("Enter");
    await expect(page).toHaveURL(/#\/reference\/undo-redo$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("stargantt.undo-redo");
    expect(errors).toEqual([]);
  });

  test("lands on the option a config hit names, not just its page", async ({ page }) => {
    const errors = await open(page, "/");
    const box = page.getByRole("combobox", { name: "Search the documentation" });
    await box.fill("tree-grid rowHeight");

    const option = page.getByRole("option").filter({ hasText: "rowHeight" }).first();
    await expect(option).toBeVisible();
    await option.click();

    await expect(page).toHaveURL(/#\/reference\/tree-grid\/config\?p=rowHeight$/);
    // The page scrolls that option's section into view rather than opening at the top.
    const section = page.locator('[data-prop="rowHeight"]');
    await expect(section).toBeVisible();
    const offset = await section.evaluate((el) => el.getBoundingClientRect().top);
    expect(offset).toBeLessThan(400);
    expect(errors).toEqual([]);
  });

  test("opens the tab a member hit names", async ({ page }) => {
    const errors = await open(page, "/");
    const box = page.getByRole("combobox", { name: "Search the documentation" });
    await box.fill("view/rowToggle");
    await page.getByRole("option").first().click();

    await expect(page).toHaveURL(/#\/reference\/tree-grid\?tab=commands$/);
    await expect(page.getByRole("tab", { name: /Commands/ })).toHaveAttribute("aria-selected", "true");
    expect(errors).toEqual([]);
  });

  test("moves the selection with the arrow keys and closes on Escape", async ({ page }) => {
    const errors = await open(page, "/");
    const box = page.getByRole("combobox", { name: "Search the documentation" });
    await box.fill("export");

    const options = page.getByRole("option");
    await expect(options.first()).toHaveAttribute("aria-selected", "true");
    await box.press("ArrowDown");
    await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(options.first()).toHaveAttribute("aria-selected", "false");
    // `aria-activedescendant` is what moves for a screen reader; focus itself never leaves the box.
    await expect(box).toHaveAttribute("aria-activedescendant", "search-hit-1");
    await expect(box).toBeFocused();

    await box.press("Escape");
    await expect(page.getByRole("listbox", { name: "Search results" })).toBeHidden();
    expect(errors).toEqual([]);
  });

  test("says so when nothing matches", async ({ page }) => {
    await open(page, "/");
    const box = page.getByRole("combobox", { name: "Search the documentation" });
    await box.fill("zzzznotathing");
    await expect(page.getByRole("status")).toContainText("No match");
    await expect(page.getByRole("option")).toHaveCount(0);
  });

  test("`/` focuses the box from the page, but not from inside a code editor", async ({ page }) => {
    await open(page, "/guides/your-first-chart");
    const box = page.getByRole("combobox", { name: "Search the documentation" });

    await page.getByRole("heading", { level: 1 }).click();
    await page.keyboard.press("/");
    await expect(box).toBeFocused();
    await box.press("Escape");

    // The editable cell, not a read-only listing: what this asserts is that a keystroke meant for
    // the editor is not stolen by the page.
    const editor = page.locator(".card .cm-content").first();
    await editor.click();
    await page.keyboard.press("/");
    await expect(box).not.toBeFocused();
    await expect(editor).toContainText("/");
  });
});

/**
 * The CSS token reference.
 *
 * Its promise — every token the library has is on this page — is enforced by the unit tests, which
 * compare the generated snapshot against the library's own sources. What can only be checked in a
 * browser is that the page actually renders all of them: a list this long is exactly the kind that
 * silently loses its tail to a filter, a virtualiser or a layout mistake.
 */
test.describe("the token reference", () => {
  const tokens = JSON.parse(readFileSync(join(HERE, "../src/generated/tokens.json"), "utf8")) as {
    tokens: Array<{ name: string }>;
    retired: Array<{ name: string }>;
  };

  test("lists every token, and filters without losing any", async ({ page }) => {
    const errors = await open(page, "/tokens");

    const rows = page.locator("[data-token]");
    await expect(rows).toHaveCount(tokens.tokens.length);
    // Each one by name, not by count: a page rendering the right number of the wrong rows would
    // pass a count and fail a reader looking for one specific property.
    for (const token of tokens.tokens.slice(0, 5)) {
      await expect(page.locator(`[data-token="${token.name}"]`)).toHaveCount(1);
    }
    await expect(page.getByRole("status")).toContainText(`${tokens.tokens.length} tokens`);

    const filter = page.getByRole("searchbox", { name: /filter tokens/i });
    await filter.fill("bar");
    const narrowed = await rows.count();
    expect(narrowed).toBeGreaterThan(0);
    expect(narrowed).toBeLessThan(tokens.tokens.length);
    await expect(page.getByRole("status")).toContainText(`of ${tokens.tokens.length} tokens`);

    // An empty result says so rather than looking like a page that failed to load.
    await filter.fill("zzzznotatoken");
    await expect(rows).toHaveCount(0);
    await expect(page.locator(".token-empty")).toBeVisible();

    await filter.fill("");
    await expect(rows).toHaveCount(tokens.tokens.length);

    // The retired names are on the page too, and deliberately outside the live table.
    for (const retired of tokens.retired) {
      await expect(page.locator(`[data-token="${retired.name}"]`)).toHaveCount(0);
      await expect(page.locator(".page")).toContainText(retired.name);
    }

    expect(errors).toEqual([]);
  });

  test("a search hit for a token name lands on its row", async ({ page }) => {
    const target = tokens.tokens[0]?.name ?? "--sg-bg";
    const errors = await open(page, `/tokens?t=${target}`);
    const row = page.locator(`[data-token="${target}"]`);
    await expect(row).toHaveAttribute("aria-current", "true");
    await expect(row).toBeInViewport();
    expect(errors).toEqual([]);
  });
});
