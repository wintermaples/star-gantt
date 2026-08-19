import { readFileSync } from "node:fs";

import { expect, test } from "./_fixtures";
import { FIXED_TIME } from "./_fixtures";
import type { Page } from "@playwright/test";

// E2E for examples/file-io.html: the CSV/JSON/iCal/xlsx/MSPDI interchange facets of the merged
// `stargantt.export` facade.
//
// All five interchange formats (CSV/JSON/iCal/xlsx/MSPDI) are served by ONE `stargantt.export`
// facade that `presetStandard()` always includes. `importCsv(text)`/`importJson(text)` apply
// directly in one call; `{ dialog: true }` opens the interactive dialog, and `{ dryRun: true }`
// stops short of applying — the page's own "Skip the dialog" checkbox drives this directly.
// `export.toXlsx()` and `export.toMsProjectXml()` cover the Excel and MS Project surfaces.
// Every export button here downloads through the page's own `downloadFile` helper (there are no
// `download*` service members on the facade itself — export.md §1.9 KNOWN GAP), so
// `page.waitForEvent("download")` is how every download below is captured.
// The page's dataset is a fixed shape (6 tasks including one summary, 2 resources, 3
// assignments) — every count assertion below is read from the page's own `dataset()`, not
// hardcoded blindly.
//
// No screenshot assertions: this page has no baseline image checked in.

const PAGE = "file-io.html";
const PANE = ".sg-pane--chart";
const DIALOG = `${PANE} .sg-ie-dialog`;

/** The page's default dataset — six tasks (one summary + five leaves), before any import. */
const DEFAULT_TASKS = 6;

declare const gantt: {
  service(key: "stargantt.data"): {
    query(): { byId: ReadonlyMap<string, { id: string; type?: string; parentId: string | null }> };
  };
  service(key: "stargantt.history"): {
    state: { get(): { canUndo: boolean } };
    undo(): void;
  };
};

async function taskCount(page: Page): Promise<number> {
  return page.evaluate(() => gantt.service("stargantt.data").query().byId.size);
}

async function boot(page: Page, openExample: import("./_fixtures").OpenExample): Promise<void> {
  await openExample(PAGE, { ready: `${PANE} canvas`, fixedTime: FIXED_TIME, settle: true });
}

test("every export button downloads a file its own format's bytes identify", async ({ page, openExample }) => {
  await boot(page, openExample);

  async function grab(buttonId: string): Promise<{ name: string; bytes: Buffer }> {
    const [download] = await Promise.all([page.waitForEvent("download"), page.locator(`#${buttonId}`).click()]);
    const path = await download.path();
    expect(path, `download path for #${buttonId}`).not.toBeNull();
    return { name: download.suggestedFilename(), bytes: readFileSync(path as string) };
  }

  const csv = await grab("csvBtn");
  expect(csv.name).toBe("stargantt-tasks.csv");
  // BOM (the page passes `bom: true`) then the seven-field header row, then one row per task.
  const csvText = csv.bytes.toString("utf8");
  expect(csvText.charCodeAt(0)).toBe(0xfeff);
  expect(csvText.slice(1).startsWith("id,parentId,name,start,end,progress,type\r\n")).toBe(true);
  expect(csvText.trimEnd().split("\r\n")).toHaveLength(DEFAULT_TASKS + 1);

  const json = await grab("jsonBtn");
  expect(json.name).toBe("stargantt-project.json");
  const project = JSON.parse(json.bytes.toString("utf8"));
  expect(project.schema).toBe("stargantt/v1");
  expect(project.tasks).toHaveLength(DEFAULT_TASKS);
  expect(project.resources).toHaveLength(2);
  expect(project.assignments).toHaveLength(3);

  const ics = await grab("icalBtn");
  expect(ics.name).toBe("stargantt-tasks.ics");
  const icsText = ics.bytes.toString("utf8");
  expect(icsText.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
  expect(icsText).toContain("X-WR-CALNAME:Website relaunch");
  // Summary tasks are excluded by default, so the one summary of the six tasks is not an event.
  expect((icsText.match(/BEGIN:VEVENT/g) ?? []).length).toBe(DEFAULT_TASKS - 1);

  const xlsx = await grab("xlsxBtn");
  expect(xlsx.name).toBe("stargantt-tasks.xlsx");
  // "PK\x03\x04" — the plugin writes the OOXML ZIP container itself.
  expect(xlsx.bytes.subarray(0, 2).toString("latin1")).toBe("PK");
  expect(xlsx.bytes.toString("latin1")).toContain("xl/worksheets/sheet1.xml");

  const xml = await grab("mspBtn");
  expect(xml.name).toBe("stargantt-project.xml");
  const xmlText = xml.bytes.toString("utf8");
  expect(xmlText).toContain('xmlns="http://schemas.microsoft.com/project"');
  expect(xmlText).toContain("<Name>Website relaunch</Name>");
  // Tasks are written depth-first, including the root summary — one <Task> per store task.
  expect((xmlText.match(/<Task>/g) ?? []).length).toBe(DEFAULT_TASKS);
});

test("the sample CSV opens the mapping dialog with inferred columns, issues and a diff", async ({
  page,
  openExample,
}) => {
  await boot(page, openExample);

  // Service-driven: no dialog exists until a button is pressed.
  await expect(page.locator(".sg-ie-dialog")).toHaveCount(0);
  expect(await taskCount(page)).toBe(DEFAULT_TASKS);

  await page.locator("#sampleCsvBtn").click();

  const dialog = page.locator(DIALOG);
  await expect(dialog).toHaveCount(1);
  await expect(dialog).toHaveAttribute("role", "dialog");
  await expect(dialog).toHaveAttribute("aria-modal", "true");

  // One mapping row per CSV header, inferred from the sample's deliberately non-canonical headers
  // ("Task ID" -> id, "% Complete" -> progress, "Parent" -> parentId, ...). The page's sample has
  // six columns (Task ID, Title, Start Date, Finish, % Complete, Parent).
  await expect(dialog.locator(".sg-ie-mapping-row")).toHaveCount(6);
  const selected = await dialog
    .locator(".sg-ie-mapping-select")
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLSelectElement).value));
  expect(selected).toEqual(["id", "name", "start", "end", "progress", "parentId"]);

  // The sample's last row ("broken") has no dates on purpose, so the issue list is non-empty.
  await expect(dialog.locator(".sg-ie-issues li")).not.toHaveCount(0);

  // Diff preview: two updates of existing tasks ("content", "qa"), one add ("seo") — the sample's
  // fourth row ("broken") carries no usable dates, so it contributes the issue above rather than a
  // clean add/update row. Every proposed change is pre-checked.
  await expect(dialog.locator('.sg-ie-change[data-kind="update"]')).toHaveCount(2);
  await expect(dialog.locator('.sg-ie-change[data-kind="add"]')).toHaveCount(1);

  // The dialog's focus contract (export.md §1.6, `sdk/dialog`'s foundation): the root holds focus
  // on open and Shift+Tab wraps to the last control — the apply button.
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.locator(".sg-ie-apply")).toBeFocused();
});

test("Escape closes the import dialog with nothing applied", async ({ page, openExample }) => {
  await boot(page, openExample);

  await page.locator("#sampleCsvBtn").click();
  await expect(page.locator(DIALOG)).toHaveCount(1);

  await page.keyboard.press("Escape");
  await expect(page.locator(".sg-ie-dialog")).toHaveCount(0);
  expect(await taskCount(page)).toBe(DEFAULT_TASKS);
});

test("the CSV service path applies its whole batch as one undo step", async ({ page, openExample }) => {
  await boot(page, openExample);

  // parse -> validate -> diff -> apply, the same pipeline the dialog drives, but skipping the
  // dialog ("Skip the dialog" checked) so `importCsv` applies directly.
  await page.locator("#directApply").check();
  await page.locator("#sampleCsvBtn").click();

  await expect(page.locator("#ioStatus")).toContainText("Imported via the service API");
  await expect(page.locator("#ioStatus")).toContainText("1 added, 2 updated, 0 removed");
  // The sample's last row carries no dates on purpose, so the page lists the parse issue.
  await expect(page.locator("#issueList li")).not.toHaveCount(0);
  expect(await taskCount(page)).toBe(DEFAULT_TASKS + 1);

  // export.md §1.5: however many changes one apply() carries, it is a single history entry.
  await page.locator("#undoBtn").click();
  await expect(page.locator("#ioStatus")).toContainText("one step");
  expect(await taskCount(page)).toBe(DEFAULT_TASKS);
});

test("the service path applies a foreign JSON file without the dialog", async ({ page, openExample }) => {
  await boot(page, openExample);

  await page.locator("#directApply").check();
  await page.locator("#sampleJsonBtn").click();

  // The sample uses foreign keys (uid/title/begin/due/percentComplete/parent): one task the store
  // already has ("build") is updated, one ("handover") is added.
  await expect(page.locator("#ioStatus")).toContainText("Imported via the service API");
  await expect(page.locator("#ioStatus")).toContainText("1 added, 1 updated, 0 removed");
  expect(await taskCount(page)).toBe(DEFAULT_TASKS + 1);
});

test("the sample MSPDI file imports its outline tree, links, resources and assignments", async ({
  page,
  openExample,
}) => {
  await boot(page, openExample);

  await page.locator("#sampleMspBtn").click();

  // The page's own `importMsProject` sets the status TWICE for this sample (its baselineInits
  // array is non-empty — the sample's two `<Baseline number="0">` entries group into one
  // generation): first indirectly via the `msprojectio/applied` event listener ("MS Project
  // applied: N tasks added, ..."), then its own code immediately overwrites that with the baseline
  // message, both inside the same synchronous handler. Only the FINAL text is ever observable in a
  // real browser, so this asserts that one (robust) and proves the counts the transient message
  // would have carried through the store directly instead (robust either way the two setStatus
  // calls end up ordered).
  const status = page.locator("#ioStatus");
  await expect(status).toContainText("baseline generation(s) parsed");

  // UID 0 (MS Project's hidden project-summary task) is skipped; the other four land.
  expect(await taskCount(page)).toBe(DEFAULT_TASKS + 4);
  const counts = await page.evaluate(() => {
    const g = gantt as unknown as {
      service(key: "stargantt.data"): {
        links: { get(): ReadonlyMap<string, unknown> };
        resources: { get(): ReadonlyMap<string, unknown> };
        assignments: { get(): ReadonlyMap<string, unknown[]> };
      };
    };
    const data = g.service("stargantt.data");
    return {
      links: data.links.get().size,
      resources: data.resources.get().size,
      assignments: [...data.assignments.get().values()].reduce((n, list) => n + list.length, 0),
    };
  });
  // Base dataset: 4 links, 2 resources, 3 assignments. The sample adds 2 links (task3<-task2,
  // task4<-task3), 1 resource ("Ops team" — UID 0 "Unassigned" is skipped), 1 assignment.
  expect(counts.links).toBe(4 + 2);
  expect(counts.resources).toBe(2 + 1);
  expect(counts.assignments).toBe(3 + 1);

  const tree = await page.evaluate(() => {
    const byId = gantt.service("stargantt.data").query().byId;
    return {
      migration: byId.get("1")?.type,
      childOfMigration: byId.get("2")?.parentId,
      cutover: byId.get("4")?.type,
    };
  });
  expect(tree.migration).toBe("summary");
  expect(tree.childOfMigration).toBe("1");
  expect(tree.cutover).toBe("milestone");
});
