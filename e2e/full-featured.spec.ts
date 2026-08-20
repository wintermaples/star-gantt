import { FIXED_TIME, expect, settle, test } from "./_fixtures";

// Coverage for `examples/full-featured.html` — the one demo page that composes all fifteen
// official plugins from a single self-contained HTML file (presetStandard()'s nine plus the six
// opt-in factories: tracking, resource, dataSync, portfolio, i18n, perfTools). The suite exercises
// a settings dialog arbitrating combinations that genuinely fight each other (a bar's fill, a
// corner, the bottom region's height, the store's contents), persisted to localStorage, plus the
// built-in scheduling calendar editor and the export facade's real downloads. The calendar
// defaults (7.5h/day working hours, two default exception days, task ids "t-api"/"t-ui" for the
// assignment test) are numerically compatible with the FIXED_TIME instant this suite pins, so the
// date/duration literals below are verified against the page's own `day()`/`STATUS_DATE` helpers
// and `CALENDAR` object before being committed, not assumed.
//
// Notable facts about the page, confirmed by reading examples/full-featured.html and the relevant
// plugin sources:
//   - The status readout reads "Composed 15 plugins." (the fifteen official plugins total, and
//     the count is fixed regardless of settings — all six opt-ins are always pushed).
//   - The settings button reads "Settings"; the calendar-editor button reads "Edit"; the history
//     buttons read "Undo"/"Redo" — no emoji glyphs in the app bar.
//   - `STORAGE_KEY` is `"stargantt.example.full-featured"`.
//   - 20 settings groups exist — confirmed by counting the `SECTIONS` array's flattened `GROUPS`
//     index.
// Everything else below (radio group ids/values for barEmphasis/sidePane/replacements/barLabels,
// `.sg-side-panel`, `.sg-calendars-editor` and its `data-sg-calendars` handles, the export
// filenames "atlas-plan.png"/"atlas-plan.csv", the custom-columns header labels
// ["Task", "Window", "Done"]) is read straight from the page itself.

const STORAGE_KEY = "stargantt.example.full-featured";

/** Opens the dialog with every collapsible section expanded, as a pointer user would. */
async function openSettings(page: import("@playwright/test").Page): Promise<void> {
  await page.getByRole("button", { name: "Settings" }).click();
  for (const section of await page.locator("#settingsSections details").all()) {
    await section.evaluate((el: HTMLDetailsElement) => {
      el.open = true;
    });
  }
}

test("the page composes the whole official plugin set", async ({ page, openExample }) => {
  await openExample("full-featured.html", { fixedTime: FIXED_TIME, settle: true });
  await expect(page.locator("#status")).toHaveText("Composed 15 plugins.");
  // One overlay per corner, none of them stacked on another — cornerTL=diagnostics,
  // cornerTR=search, cornerBR=zoom are the page's own defaults.
  await expect(page.locator(".sg-diagnostics")).toBeVisible();
  await expect(page.locator(".sg-filter-toolbar")).toBeVisible();
  await expect(page.locator(".sg-zoom-controls")).toBeVisible();
});

test("the settings dialog applies, persists and cancels", async ({ page, openExample }) => {
  await openExample("full-featured.html", { fixedTime: FIXED_TIME, settle: true });
  await expect(page.locator(".sg-side-panel")).toHaveCount(1); // sidePane defaults to "details"

  // Escape is a cancel, not an apply.
  await openSettings(page);
  await page.locator('input[name="sidePane"][value="none"]').check();
  await page.keyboard.press("Escape");
  await expect(page.locator("#settingsDialog")).toBeHidden();
  await expect(page.locator(".sg-side-panel")).toHaveCount(1);

  await openSettings(page);
  await page.locator('input[name="barEmphasis"][value="critical"]').check();
  await page.locator('input[name="sidePane"][value="none"]').check();
  await page.locator('input[name="replacements"][value="custom"]').check();
  await page.getByRole("button", { name: "Apply & rebuild" }).click();
  await expect(page.locator("#settingsDialog")).toBeHidden();
  await settle(page);

  await expect(page.locator(".sg-side-panel")).toHaveCount(0);
  // The replacement switch really replaces: these are the page's own three columns, not the
  // library's defaults.
  expect(await page.locator(".sg-grid-header-cell").allTextContents()).toEqual([
    "Task",
    "Window",
    "Done",
  ]);

  await page.reload();
  await page.locator("canvas").first().waitFor();
  await settle(page);
  expect(
    await page.evaluate(
      () =>
        (window as { ganttDemo?: { settings: Record<string, string> } }).ganttDemo?.settings
          .barEmphasis,
    ),
  ).toBe("critical");
  await expect(page.locator(".sg-side-panel")).toHaveCount(0);
});

test("an unusable stored value falls back to the default", async ({ page, openExample }) => {
  await openExample("full-featured.html", { fixedTime: FIXED_TIME, settle: true });
  await page.evaluate((key) => {
    window.localStorage.setItem(key, '{"barEmphasis":"nonsense","sidePane":42}');
  }, STORAGE_KEY);
  await page.reload();
  await page.locator("canvas").first().waitFor();
  await settle(page);
  const settings = await page.evaluate(
    () => (window as { ganttDemo?: { settings: Record<string, string> } }).ganttDemo?.settings,
  );
  expect(settings?.barEmphasis).toBe("conditional");
  expect(settings?.sidePane).toBe("details");
});

test("a section holding a non-default choice opens itself", async ({ page, openExample }) => {
  await openExample("full-featured.html", { fixedTime: FIXED_TIME, settle: true });
  await page.evaluate((key) => {
    window.localStorage.setItem(key, JSON.stringify({ sidePane: "none" }));
  }, STORAGE_KEY);
  await page.reload();
  await page.locator("canvas").first().waitFor();
  // A restored choice the reader cannot see is a choice they cannot undo.
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.locator('input[name="sidePane"][value="none"]')).toBeVisible();
  await expect(page.locator(".badge")).toHaveText("1 changed");
});

test("every offered choice composes cleanly", async ({ page, openExample }) => {
  const failures: string[] = [];
  page.on("pageerror", (e) => failures.push("pageerror: " + String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") failures.push("console: " + m.text());
  });

  await openExample("full-featured.html", { fixedTime: FIXED_TIME, settle: true });

  const groups = await page.evaluate(() => {
    document.getElementById("settingsBtn")!.click();
    const out: Record<string, string[]> = {};
    document
      .querySelectorAll<HTMLInputElement>("#settingsSections input[type=radio]")
      .forEach((input) => {
        (out[input.name] ??= []).push(input.value);
      });
    (document.getElementById("settingsDialog") as HTMLDialogElement).close();
    return out;
  });
  // Guards the sweep below against a dialog that silently stopped rendering its options — the
  // page has exactly 20 groups (SECTIONS' flattened GROUPS index).
  expect(Object.keys(groups).length).toBeGreaterThanOrEqual(20);

  for (const [name, values] of Object.entries(groups)) {
    for (const value of values) {
      await page.evaluate(([groupName, optionValue]) => {
        document.getElementById("settingsBtn")!.click();
        document.querySelector<HTMLInputElement>(
          `#settingsSections input[name="${groupName}"][value="${optionValue}"]`,
        )!.checked = true;
        document.getElementById("settingsApply")!.click();
      }, [name, value] as const);
      // `settle()`'s two rAFs are not always enough here: `rebuild()` disposes the live instance
      // and recreates it synchronously, but under 8-way parallel load the new canvases can attach
      // a beat later than the second rAF fires (found via a flaky `canvases === 0` read on
      // `cornerBR=none` — reproduced standalone with a longer wait and zero failures across all 20
      // groups, confirming this is a timing gap in the test, not the page). Waiting for `attached`
      // rather than the default `visible` state: `viewMode=grid` (Table, panes hidden) legitimately
      // renders a real but zero-size, invisible chart canvas, which the visibility-default form of
      // this wait treated as a second, unrelated timeout.
      await page.locator("canvas").first().waitFor({ state: "attached" });
      await settle(page);
      const canvases = await page.locator("canvas").count();
      expect(canvases, `${name}=${value} produced no chart`).toBeGreaterThan(0);
      await page.evaluate((key) => {
        window.localStorage.removeItem(key);
      }, STORAGE_KEY);
    }
  }
  expect(failures, failures.join("\n")).toEqual([]);
});

test("Enter inside the settings dialog applies rather than discarding", async ({
  page,
  openExample,
}) => {
  await openExample("full-featured.html", { fixedTime: FIXED_TIME, settle: true });
  await openSettings(page);
  await page.locator('input[name="barLabels"][value="none"]').check();
  await page.keyboard.press("Enter");
  await expect(page.locator("#settingsDialog")).toBeHidden();
  await settle(page);
  expect(
    await page.evaluate(
      () =>
        (window as { ganttDemo?: { settings: Record<string, string> } }).ganttDemo?.settings
          .barLabels,
    ),
  ).toBe("none");
});

/** Reads an answer straight off the composed calendars service, by UTC date key. */
async function calendarAnswer<T>(
  page: import("@playwright/test").Page,
  member: "isWorkingDay" | "workingMsBetween",
  from: string,
  to?: string,
): Promise<T> {
  return (await page.evaluate(
    ([name, a, b]) => {
      const demo = window as unknown as {
        ganttDemo: { instance: { service(key: string): Record<string, (...args: never[]) => unknown> } };
      };
      const service = demo.ganttDemo.instance.service("stargantt.calendars");
      const args = b === undefined ? [Date.parse(a)] : [Date.parse(a), Date.parse(b)];
      return (service[name] as (...args: unknown[]) => unknown)("standard", ...args);
    },
    [member, from, to] as const,
  )) as T;
}

// The calendars plugin's own editor, opened from the app bar (`#calendarBtn`, text "Edit").
/** One of the editor's controls, by its `data-sg-calendars` handle. */
function editor(page: import("@playwright/test").Page, handle: string) {
  return page.locator(`.sg-calendars-editor [data-sg-calendars="${handle}"]`);
}

/** The editor's live region — the sentence the last edit reported. */
function editorStatus(page: import("@playwright/test").Page) {
  return editor(page, "status");
}

async function openCalendarEditor(page: import("@playwright/test").Page): Promise<void> {
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.locator(".sg-calendars-editor")).toBeVisible();
}

test("the calendar editor can be dragged off the bars it is about", async ({
  page,
  openExample,
}) => {
  await openExample("full-featured.html", { fixedTime: FIXED_TIME, settle: true });
  await openCalendarEditor(page);
  const panel = page.locator(".sg-calendars-editor");
  const header = page.locator(".sg-calendars-editor__header");

  const before = await panel.boundingBox();
  expect(before).not.toBeNull();
  // It opens narrower than the pane it floats over — the whole point of leaving the corner slot.
  const pane = await page.locator(".sg-pane--chart").boundingBox();
  expect(before!.width).toBeLessThan(pane!.width * 0.95);

  const grip = await header.boundingBox();
  const from = { x: grip!.x + grip!.width / 2, y: grip!.y + grip!.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 120, from.y + 90, { steps: 8 });
  await page.mouse.up();

  const after = await panel.boundingBox();
  expect(Math.round(after!.x - before!.x)).toBeGreaterThan(40);
  expect(Math.round(after!.y - before!.y)).toBeGreaterThan(40);
  // Clamped to the pane: the header can never be dragged out of reach.
  expect(after!.x).toBeGreaterThanOrEqual(pane!.x - 1);
  expect(after!.y + 24).toBeLessThanOrEqual(pane!.y + pane!.height + 1);

  // The editor still works where it was dropped.
  await editor(page, "hours-clear").click();
  await expect(editorStatus(page)).toContainText("Working hours cleared");
});

test("an exception row states its designation in words beside a labelled Remove", async ({
  page,
  openExample,
}) => {
  await openExample("full-featured.html", { fixedTime: FIXED_TIME, settle: true });
  await openCalendarEditor(page);
  // T0 (FIXED_TIME's UTC day) + 17 days == 2026-08-24 — the page's own `day(17)` default exception.
  const first = editor(page, "exceptions").locator("li").first();
  await expect(first).toContainText("2026-08-24");
  await expect(first).toContainText("Non-working");

  const remove = first.getByRole("button", { name: "Remove exception 2026-08-24" });
  const box = await remove.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(24);
  expect(box!.width).toBeGreaterThanOrEqual(24);
  await expect(remove).toHaveText("Remove");

  await remove.click();
  await expect(editor(page, "exceptions").locator("li")).toHaveCount(1);
  await expect(editorStatus(page)).toHaveText("Exception on 2026-08-24 removed.");
});

test("the built-in calendar editor designates and removes a special period", async ({
  page,
  openExample,
}) => {
  await openExample("full-featured.html", { fixedTime: FIXED_TIME, settle: true });
  await openCalendarEditor(page);
  // The two default exceptions: T0 + 17d (2026-08-24) and T0 + 18d (2026-08-25).
  await expect(editor(page, "exceptions").locator("li")).toHaveCount(2);

  // Monday to Wednesday shut down — one gesture, three days.
  await editor(page, "period-from").fill("2026-08-10");
  await editor(page, "period-to").fill("2026-08-12");
  await editor(page, "period-apply").click();

  await expect(editor(page, "exceptions").locator("li")).toHaveCount(5);
  await expect(editorStatus(page)).toContainText("3 days from 2026-08-10");
  expect(await calendarAnswer<boolean>(page, "isWorkingDay", "2026-08-10")).toBe(false);
  expect(await calendarAnswer<boolean>(page, "isWorkingDay", "2026-08-12")).toBe(false);
  expect(await calendarAnswer<boolean>(page, "isWorkingDay", "2026-08-13")).toBe(true);

  // The inverse takes the whole period back, leaving the days outside it alone.
  await editor(page, "period-remove").click();
  await expect(editor(page, "exceptions").locator("li")).toHaveCount(2);
  expect(await calendarAnswer<boolean>(page, "isWorkingDay", "2026-08-10")).toBe(true);
});

test("the built-in calendar editor edits the working hours and the weekly pattern", async ({
  page,
  openExample,
}) => {
  const HOUR = 3_600_000;
  await openExample("full-featured.html", { fixedTime: FIXED_TIME, settle: true });
  await openCalendarEditor(page);

  // The page ships 09:00-12:00 and 13:00-17:30.
  await expect(editor(page, "hour-start")).toHaveCount(2);
  expect(
    await calendarAnswer<number>(page, "workingMsBetween", "2026-08-10", "2026-08-11"),
  ).toBe(7.5 * HOUR);

  await editor(page, "hours-clear").click();
  await expect(editor(page, "hour-start")).toHaveCount(0);
  // With no window at all a working day counts in full.
  expect(
    await calendarAnswer<number>(page, "workingMsBetween", "2026-08-10", "2026-08-11"),
  ).toBe(24 * HOUR);

  await editor(page, "hours-add").click();
  await expect(editor(page, "hour-start")).toHaveCount(1);
  // A freshly added window defaults to 09:00-17:00 (editor.ts's `hours-add` handler).
  expect(
    await calendarAnswer<number>(page, "workingMsBetween", "2026-08-10", "2026-08-11"),
  ).toBe(8 * HOUR);

  // Monday off: the weekly pattern, not an exception day, so nothing joins the list.
  await editor(page, "day-1").uncheck();
  expect(await calendarAnswer<boolean>(page, "isWorkingDay", "2026-08-10")).toBe(false);
  await expect(editor(page, "exceptions").locator("li")).toHaveCount(2);
});

test("the built-in calendar editor puts the selected tasks on another calendar", async ({
  page,
  openExample,
}) => {
  await openExample("full-featured.html", { fixedTime: FIXED_TIME, settle: true });
  await openCalendarEditor(page);
  await expect(editor(page, "assign")).toBeVisible();
  await editor(page, "assign").click();
  await expect(editorStatus(page)).toHaveText("Select one or more tasks first.");

  await page.evaluate(() => {
    const demo = window as unknown as {
      ganttDemo: { instance: { service(key: string): { select(ids: string[]): void } } };
    };
    demo.ganttDemo.instance.service("stargantt.selection").select(["t-api", "t-ui"]);
  });
  // The editor edits whichever calendar its picker names; the shift calendar's id is "early-shift".
  await editor(page, "picker").selectOption("early-shift");
  await editor(page, "assign").click();
  await expect(editorStatus(page)).toContainText("2 tasks now on");

  const assigned = await page.evaluate(() => {
    const demo = window as unknown as {
      ganttDemo: {
        instance: {
          service(key: string): { getTask(id: string): { calendarId?: string } | undefined };
        };
      };
    };
    const data = demo.ganttDemo.instance.service("stargantt.data");
    return [data.getTask("t-api")?.calendarId, data.getTask("t-ui")?.calendarId];
  });
  expect(assigned).toEqual(["early-shift", "early-shift"]);

  // An ordinary task edit, so history takes it back.
  await page.getByRole("button", { name: "Undo" }).click();
  expect(
    await page.evaluate(() => {
      const demo = window as unknown as {
        ganttDemo: {
          instance: {
            service(key: string): { getTask(id: string): { calendarId?: string } | undefined };
          };
        };
      };
      return demo.ganttDemo.instance.service("stargantt.data").getTask("t-ui")?.calendarId;
    }),
  ).toBeUndefined();
});

// `StarGantt.downloadFile` is re-exported from @stargantt/sdk per export.md §1.9 and the dist
// carries it, so this suite runs for real.
test.describe("export buttons", () => {

  test("the export buttons save through the services' own download members", async ({
    page,
    openExample,
  }) => {
    await openExample("full-featured.html", { fixedTime: FIXED_TIME, settle: true });

    const csv = page.waitForEvent("download");
    await page.getByRole("button", { name: "CSV" }).click();
    expect((await csv).suggestedFilename()).toBe("atlas-plan.csv");
    await expect(page.locator("#status")).toHaveText("CSV downloaded.");

    const png = page.waitForEvent("download");
    await page.getByRole("button", { name: "PNG" }).click();
    expect((await png).suggestedFilename()).toBe("atlas-plan.png");
    await expect(page.locator("#status")).toHaveText("PNG downloaded.");
  });
});
