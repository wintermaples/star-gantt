import { FIXED_TIME, expect, test } from "./_fixtures";

// Chrome-slot feature spec, exercising this suite against `drag-and-undo.html`, the page whose
// Magnet toggle is read by `boot()` and therefore exercises the control-state carry-over rule end
// to end.
//
// Same gap as playground-shell.spec.ts's header comment (read it for the full grep evidence) — no
// `examples/*.html` page mounts `examples/playground.js`'s shell. `examples/drag-and-undo.html`
// has the `#undoBtn` / `#alignToggle` controls this chrome test would drive, but it is wired as a
// fully self-contained page (its own inline `<script>` calls `StarGantt.create()` directly), not
// through a `<template id="demo-chrome">` + `<script id="demo-code" type="text/stargantt-demo">`
// pair. There is therefore no `.ex-slot-*` scaffold, no `.pg-toolbar`, and no `window.__pg` on
// this page (or any other) to assert against. Kept below as a documented, type-checked scaffold
// for once a page is wired — see playground-shell.spec.ts's header for the recommendation. The
// CDN-block route is preserved for the same offline-fallback reason.

const PAGE = "drag-and-undo.html";

test.describe("playground chrome slots (drag-and-undo.html)", () => {
  test.fixme(
    true,
    "No examples/*.html page mounts examples/playground.js's #demo-code/#demo-chrome " +
      "blocks (see playground-shell.spec.ts's header) — blocks this suite too.",
  );

  test.beforeEach(async ({ page, openExample }) => {
    await page.route("https://cdn.jsdelivr.net/**", (route) => route.abort());
    await openExample(PAGE, { fixedTime: FIXED_TIME });
    await expect
      .poll(() => page.evaluate(() => Boolean(window.__pg?.instance)), {
        message: "window.__pg published after the initial boot",
      })
      .toBe(true);
  });

  test("the chrome template renders into the shell's slots", async ({ page }) => {
    await expect(page.locator(".ex-slot-above #undoBtn")).toBeVisible();
    await expect(page.locator(".ex-main > .ex-slot-above")).toHaveCount(1);
    await expect(page.locator(".ex-main > .ex-stage > .ex-chart #gantt-root")).toHaveCount(1);
    await expect(page.locator(".ex-slot-below")).toBeHidden();
  });

  test("__pg.sources exposes all three editable sources", async ({ page }) => {
    const sources = await page.evaluate(() => window.__pg!.sources);
    expect(sources.js).toContain("function boot(");
    expect(sources.html).toContain('id="undoBtn"');
    await page.getByRole("button", { name: "Code" }).click();
    const seeded = await page.evaluate(() => window.__pg!.sources.data);
    expect(seeded).toContain('"tasks"');
  });

  test("applyChrome replaces the chrome DOM and re-wires it", async ({ page }) => {
    await page.evaluate(() => {
      const pg = window.__pg!;
      pg.applyChrome(pg.sources.html.replace("↶ Undo", "Undo it"));
    });
    await expect(page.locator("#undoBtn")).toHaveText("Undo it");
    expect(await page.evaluate(() => Boolean(window.__pg!.instance))).toBe(true);
  });

  test("chrome that drops an element boot() needs fails into the status readout", async ({
    page,
  }) => {
    await page.evaluate(() =>
      window.__pg!.applyChrome('<div data-slot="above" class="ex-toolbar">nothing here</div>'),
    );
    await expect(page.locator(".pg-status")).not.toHaveText("");
    expect(await page.evaluate(() => window.__pg!.instance)).toBeNull();

    await page.evaluate(() => window.__pg!.reset());
    expect(await page.evaluate(() => Boolean(window.__pg!.instance))).toBe(true);
    await expect(page.locator(".pg-status")).toHaveText("");
  });

  test("control state survives a reboot and resets on Reset", async ({ page }) => {
    const magnet = page.locator("#alignToggle");
    await magnet.click();
    await expect(magnet).toHaveAttribute("aria-pressed", "true");
    await expect(magnet).toHaveText("Magnet: On");

    await page.evaluate(() => window.__pg!.applyDataset("small"));
    await expect(magnet).toHaveAttribute("aria-pressed", "true");
    await expect(magnet).toHaveText("Magnet: On");

    await page.evaluate(() => window.__pg!.reset());
    await expect(page.locator("#alignToggle")).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("#alignToggle")).toHaveText("Magnet: Off");
  });

  test("listeners registered in boot() never double-register across reboots", async ({ page }) => {
    await page.evaluate(() => window.__pg!.run());
    await page.evaluate(() => window.__pg!.run());

    const moved = await page.evaluate(() => {
      const gantt = window.__pg!.instance as {
        dispatch(cmd: string, payload: unknown): void;
        service(k: string): { getTask(id: number): { start: number; end: number } | undefined };
      };
      const data = gantt.service("stargantt.data");
      const before = data.getTask(2)!;
      const day = 86400000;
      gantt.dispatch("task/move", { id: 2, start: before.start + day, end: before.end + day });
      gantt.dispatch("task/move", { id: 2, start: before.start + 2 * day, end: before.end + 2 * day });
      return { start: before.start, after: data.getTask(2)!.start };
    });
    expect(moved.after).toBe(moved.start + 2 * 86400000);

    await page.locator("#undoBtn").click();
    const afterUndo = await page.evaluate(() => {
      const gantt = window.__pg!.instance as {
        service(k: string): { getTask(id: number): { start: number } | undefined };
      };
      return gantt.service("stargantt.data").getTask(2)!.start;
    });
    expect(afterUndo).toBe(moved.start + 86400000);
  });
});
