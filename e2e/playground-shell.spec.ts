import type { Page } from "@playwright/test";
import { FIXED_TIME, expect, test } from "./_fixtures";

// Playground-shell feature spec, exercising this suite against `basic-gantt.html`.
//
// STATUS: `examples/playground.js` does not exist in this repository. The shell activates only
// when a page carries `<script id="demo-code" type="text/stargantt-demo">`, per its own
// top-level guard, and a grep of every `examples/*.html` for `id="demo-code"` returns zero
// matches — the pages that mention "playground.js" at all do so only in a header comment
// explaining that they are deliberately self-contained instead. `examples/datasets.js` and
// `examples/site.js` remain (datasets.js is an unwired reference asset; site.js is wired into
// index.html/hello.html).
//
// This blocks running the scenarios below for real (kept as a documented,
// type-checked-against-`playground-shell.d.ts` scaffold — that ambient type is itself only a
// historical transcription, see its own header) and is why `e2e/oa/`'s orthogonal-array sweep
// does not use the shell: `e2e/oa/oa.spec.ts` boots directly against `examples/hello.html`
// (dispose its own demo instance, reuse its mount, `new Function` + call the generated `boot()`),
// sidestepping the dependency entirely — see that file's header for the full account. Recreating
// this shell for real would mean: (1) writing a new implementation from
// `docs/specs/plugins/*.md` and `docs/specs/architecture.md`; (2) adding a
// `<script src="./playground.js">` tag plus a `<script id="demo-code" type="text/stargantt-demo">`
// block to whichever page(s) should carry it (`basic-gantt.html` is the natural candidate); and
// (3) un-`fixme`-ing the tests below once a real shell exists to run them against.
//
// The CDN would need to be BLOCKED for every test here once unblocked (`page.route` on
// `https://cdn.jsdelivr.net/**`, aborted): the suite must prove the shell works offline on the
// `<textarea>` fallback. Kept in the scaffold below for that reason.

const PAGE = "basic-gantt.html";
// examples/basic-gantt.html carries 12 tasks (ids 1-12) — noted for whoever wires the demo-code
// block, not verified against a running shell.
const DEFAULT_TASK_COUNT = 12;

async function taskCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const pg = window.__pg!;
    const gantt = pg.instance as {
      service(key: string): { taskIds(): Iterable<unknown> };
    };
    return [...gantt.service("stargantt.data").taskIds()].length;
  });
}

test.describe("playground shell (basic-gantt.html)", () => {
  test.fixme(
    true,
    "No examples/*.html page mounts examples/playground.js's #demo-code block " +
      "(see file header) — blocks this suite and e2e/oa/ from using the shell.",
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

  test("initial boot runs the page default dataset", async ({ page }) => {
    expect(await taskCount(page)).toBe(DEFAULT_TASK_COUNT);
  });

  test("Data selector applies a shared preset and re-boots", async ({ page }) => {
    await page.evaluate(() => {
      (window as unknown as { __booted: Promise<unknown> }).__booted = new Promise((resolve) =>
        document.addEventListener("pg:booted", () => resolve(true), { once: true }),
      );
    });
    await page.getByRole("button", { name: /^Data:/ }).click();
    await page.getByRole("button", { name: "Small (8 tasks)" }).click();
    await page.evaluate(() => (window as unknown as { __booted: Promise<unknown> }).__booted);
    expect(await taskCount(page)).toBe(8);
    await expect(page.getByRole("button", { name: /^Data: Small/ })).toBeVisible();
  });

  test("the Data column is present without opening a menu and applies a custom dataset", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Code" }).click();
    const jsonArea = page.getByLabel("Dataset JSON");
    await expect(jsonArea).toBeVisible();
    await jsonArea.fill(
      JSON.stringify({
        tasks: [
          { id: "a", parentId: null, name: "Only task A", start: 1754870400000, end: 1755043200000 },
          { id: "b", parentId: null, name: "Only task B", start: 1755043200000, end: 1755216000000 },
        ],
      }),
    );
    await page.getByRole("button", { name: "Run", exact: true }).click();
    expect(await taskCount(page)).toBe(2);
  });

  test("Code drawer edit -> Run re-executes the displayed code (textarea fallback)", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Code" }).click();
    const jsArea = page.getByLabel("Demo JavaScript source");
    await expect(jsArea).toBeVisible();
    await expect(page.locator(".pg-drawer")).toHaveAttribute("data-pg-editor", "textarea");
    await expect(page.locator(".pg-drawer .cm-editor")).toHaveCount(0);

    const source = await jsArea.inputValue();
    expect(source).toContain("function boot(");
    await jsArea.fill(
      source.replace(
        "return gantt;",
        'gantt.dispatch("task/update", { id: 1, after: { name: "Edited via playground" } });\n' +
          "      return gantt;",
      ),
    );
    await page.getByRole("button", { name: "Run", exact: true }).click();

    const renamed = await page.evaluate(() => {
      const gantt = window.__pg!.instance as {
        service(key: string): { getTask(id: number): { name: string } | undefined };
      };
      return gantt.service("stargantt.data").getTask(1)?.name;
    });
    expect(renamed).toBe("Edited via playground");
  });

  test("Reset restores the original code and default dataset", async ({ page }) => {
    await page.evaluate(() => window.__pg!.applyDataset("small"));
    expect(await taskCount(page)).toBe(8);
    await page.getByRole("button", { name: "Code" }).click();
    await page.getByRole("button", { name: "Reset" }).click();
    expect(await taskCount(page)).toBe(DEFAULT_TASK_COUNT);
  });

  test("Escape closes the drawer and returns focus to the Code button", async ({ page }) => {
    const codeButton = page.getByRole("button", { name: "Code", exact: true });
    await codeButton.click();
    await expect(page.getByLabel("Demo JavaScript source")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByLabel("Demo JavaScript source")).toBeHidden();
    await expect(codeButton).toBeFocused();
  });

  test("dispose -> re-create leaves a single clean mount", async ({ page }) => {
    const shape = () =>
      page.evaluate(() => {
        const mount = document.getElementById("gantt-root")!;
        return {
          children: mount.childElementCount,
          canvases: mount.querySelectorAll("canvas").length,
        };
      });
    const initial = await shape();
    expect(initial.canvases).toBeGreaterThan(0);

    const afterDispose = await page.evaluate(() => {
      (window.__pg!.instance as { dispose(): void }).dispose();
      const mount = document.getElementById("gantt-root")!;
      return {
        children: mount.childElementCount,
        className: mount.className,
        attributes: mount.getAttributeNames().sort(),
        inlineStyle: mount.getAttribute("style"),
      };
    });
    expect(afterDispose.children).toBe(0);
    expect(afterDispose.className).toBe("");
    expect(afterDispose.attributes).toEqual(["id"]);
    expect(afterDispose.inlineStyle).toBeNull();

    await page.evaluate(() => window.__pg!.run());
    await page.evaluate(() => window.__pg!.applyDataset("medium"));
    await page.evaluate(() => window.__pg!.reset());
    expect(await shape()).toEqual(initial);
    expect(await taskCount(page)).toBe(DEFAULT_TASK_COUNT);
  });

  test("a failing Run surfaces in the status readout and leaves __pg recoverable", async ({
    page,
  }) => {
    await page.evaluate(() => window.__pg!.run("function boot() { throw new Error('demo boom'); }"));
    await expect(page.locator(".pg-status")).toHaveText(/demo boom/);
    expect(await page.evaluate(() => window.__pg!.instance)).toBeNull();
    await page.evaluate(() => window.__pg!.applyDataset("no-such-preset"));
    await expect(page.locator(".pg-status")).toHaveText(/Unknown preset/);
    await page.evaluate(() => window.__pg!.reset());
    expect(await taskCount(page)).toBe(DEFAULT_TASK_COUNT);
    await expect(page.locator(".pg-status")).toHaveText("");
  });
});
