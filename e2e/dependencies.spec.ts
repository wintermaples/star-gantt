import { expect, test } from "./_fixtures";
import { FIXED_TIME, settle } from "./_fixtures";
import type { Page } from "@playwright/test";

// E2E for examples/dependencies-scheduling.html.
//
// e2e/scheduling.spec.ts already exercises examples/scheduling.html's dependency-link rendering,
// creation-by-drag, duplicate-pair rejection, Escape-abort, click-select-delete-undo, the Alt+L
// keyboard chord, elbow-vs-straight routing, forward FS-lag propagation, mid-chain forward-only
// propagation, downstream FF re-timing via end-handle resize, cycle rejection (both via dispatch
// and via a real port drag), manual-mode pinning, working-calendar snap, critical-path
// classification and the diagnostics panel — all against the SAME underlying scheduling package.
// This file therefore covers only what is genuinely new on dependencies-scheduling.html: its own
// page-specific UI (the SS link demo button's undo-honesty regression, the live "Scheduling" row's
// preview/reschedule buttons, the reconciler switch) and scenarios scheduling.spec.ts explicitly
// declares out of scope (backward/pull-back propagation, the preview-then-apply pairing of
// `schedule/reschedule`, and snap's `pushSuccessors` stand-down interaction with propagation off).
//
// Deliberately not covered here (pure duplication of scheduling.spec.ts):
//   - forward-drag propagation across the FS chain (single-hop already covered there)
//   - mid-chain move leaves predecessors untouched (forward-only propagation)
//   - cycle rejection via a real port drag (already proven by scheduling.spec.ts's cycA/cycB case)
//   - "a port drag onto an already-linked task adds nothing" / "a port drag between unrelated ends
//     adds a link and re-schedules its target" (same mechanics as scheduling.spec.ts's wk/audit
//     and spec/impl cases)
//   - "switching a task to manual pins it against every scheduling pass" (scheduling.spec.ts's
//     "pinning a task to manual scheduling exempts it from propagation" proves the identical
//     engine behavior; this page's UI additionally drives it through a <select>/<button> pair
//     rather than a direct dispatch, which is not enough of a distinct surface to justify the
//     duplication)
//
// Every assertion below reads back through `gantt.service(...)`, the global the page's own boot
// script assigns (`window.gantt = gantt`) — the same pattern scheduling.spec.ts uses. No canvas
// pixels are inspected; no port drag is needed for any scenario kept in this file.

const DAY_MS = 86_400_000;
const CONTAINER = "#chart";

declare const gantt: {
  dispatch<K extends string>(cmd: K, payload: unknown): void;
  on(event: string, handler: (e: any) => void): () => void;
  service(key: "stargantt.data"): {
    getTask(id: string): { id: string; name: string; start: number; end: number } | undefined;
    links: {
      get(): Map<string, { id: string; sourceId: string; targetId: string; type: string; lag?: number }>;
    };
  };
  service(key: "stargantt.history"): {
    state: { get(): { canUndo: boolean; canRedo: boolean; depth: number } };
  };
  service(key: "stargantt.timeline"): {
    pxPerMs: number;
  };
  service(key: "stargantt.task-bars"): {
    barBoxOf(id: string): { x: number; y: number; width: number; height: number } | undefined;
  };
  service(key: "stargantt.scheduler"): {
    propagationEnabled(): boolean;
    previewReschedule(statusDate: number): { op: string; id?: string; after?: Record<string, unknown> }[];
  };
};

async function chartBodyBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator(".sg-pane--chart canvas.sg-layer").first().boundingBox();
  if (box === null) throw new Error("chart body canvas not found");
  return box;
}

interface Point {
  x: number;
  y: number;
}

interface BarGeometry extends Point {
  right: number;
  pxPerDay: number;
}

async function barGeometry(page: Page, taskId: string): Promise<BarGeometry> {
  const pane = await chartBodyBox(page);
  const box = await page.evaluate((id) => {
    const b = gantt.service("stargantt.task-bars").barBoxOf(id);
    if (b === undefined) return null;
    const pxPerDay = gantt.service("stargantt.timeline").pxPerMs * 86_400_000;
    return { x: b.x, y: b.y, width: b.width, height: b.height, pxPerDay };
  }, taskId);
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

async function allTasks(page: Page, ids: readonly string[]) {
  const out: Record<string, { start: number; end: number }> = {};
  for (const id of ids) {
    const t = await taskOf(page, id);
    out[id] = { start: t.start, end: t.end };
  }
  return out;
}

async function historyState(page: Page) {
  return page.evaluate(() => gantt.service("stargantt.history").state.get());
}

async function findLink(page: Page, sourceId: string, targetId: string, type?: string) {
  return page.evaluate(
    ({ sourceId, targetId, type }) => {
      for (const link of gantt.service("stargantt.data").links.get().values()) {
        if (link.sourceId === sourceId && link.targetId === targetId && (type === undefined || link.type === type)) {
          return link;
        }
      }
      return undefined;
    },
    { sourceId, targetId, type },
  );
}

/** Drags a task's bar horizontally by `days` calendar days (day-zoom default, no working-time
 *  restriction composed on this page — unlike examples/scheduling.html's "std" calendar). */
async function dragTaskBy(page: Page, id: string, days: number): Promise<void> {
  const geo = await barGeometry(page, id);
  await page.mouse.move(geo.x, geo.y);
  await page.mouse.down();
  await page.mouse.move(geo.x + geo.pxPerDay * days, geo.y, { steps: 8 });
  await page.mouse.up();
  await settle(page);
}

const TASK_IDS = ["task-1", "task-2", "task-3", "task-4"] as const;

async function bootDependencies(page: Page, openExample: import("./_fixtures").OpenExample): Promise<void> {
  await openExample("dependencies-scheduling.html", { ready: `${CONTAINER} canvas`, fixedTime: FIXED_TIME });
  await settle(page);
  await expect.poll(async () => taskOf(page, "task-1").then((t) => t.name)).toBe("Requirements");
}

test.describe("dependencies + auto-schedule: page-specific scenarios", () => {
  test("the seeded FS chain is consistent and mirrored in the ARIA grid", async ({ page, openExample }) => {
    await bootDependencies(page, openExample);

    for (const [source, target] of [
      ["task-1", "task-2"],
      ["task-2", "task-3"],
      ["task-3", "task-4"],
    ] as const) {
      const link = await findLink(page, source, target, "FS");
      expect(link, `${source} -> ${target} FS link`).toBeDefined();
      const s = await taskOf(page, source);
      const t = await taskOf(page, target);
      expect(t.start).toBe(s.end);
    }

    const rows = await page.locator(".sg-a11y-row").allInnerTexts();
    expect(rows.length).toBeGreaterThanOrEqual(TASK_IDS.length);
    expect(rows.some((r) => r.includes("Requirements"))).toBe(true);
    expect(rows.some((r) => r.includes("Testing"))).toBe(true);
  });

  // scheduling.spec.ts's file header explicitly defers "pulling a task BACK on an earlier move" to
  // this file — every scenario there only drags forward. This is the one E2E covering it.
  test("dragging the first task earlier pulls its successors back to their earliest start", async ({
    page,
    openExample,
  }) => {
    await bootDependencies(page, openExample);
    // Move the chain forward first, so there is room to drag back without leaving the viewport.
    await dragTaskBy(page, "task-1", 5);
    const before = await allTasks(page, TASK_IDS);

    await dragTaskBy(page, "task-1", -3);
    const after = await allTasks(page, TASK_IDS);

    for (const id of TASK_IDS) {
      expect(after[id]!.start, `${id} start moved earlier`).toBeLessThan(before[id]!.start);
      expect(after[id]!.end - after[id]!.start).toBe(before[id]!.end - before[id]!.start);
    }
    expect(after["task-2"]!.start).toBe(after["task-1"]!.end);
    expect(after["task-3"]!.start).toBe(after["task-2"]!.end);
    expect(after["task-4"]!.start).toBe(after["task-3"]!.end);
  });

  // A distinct case from scheduling.spec.ts's own end-handle-resize test (which resizes "qa",
  // downstream via an FF link): this one resizes a plain FS successor and checks the FS-chain
  // re-timing specifically.
  test("resizing task-2's end handle re-times only its downstream FS successors", async ({ page, openExample }) => {
    await bootDependencies(page, openExample);
    const before = await allTasks(page, TASK_IDS);
    const geo = await barGeometry(page, "task-2");
    const handleX = geo.right - 2; // well inside the end resize handle

    await page.mouse.move(handleX, geo.y);
    await page.mouse.down();
    await page.mouse.move(handleX + geo.pxPerDay * 2, geo.y, { steps: 8 });
    await page.mouse.up();
    await settle(page);

    const after = await allTasks(page, TASK_IDS);
    expect(after["task-2"]!.start).toBe(before["task-2"]!.start);
    expect(after["task-2"]!.end).toBeGreaterThan(before["task-2"]!.end);

    // Upstream untouched.
    expect(after["task-1"]).toEqual(before["task-1"]);
    // Downstream follows the new finish, durations preserved.
    expect(after["task-3"]!.start).toBe(after["task-2"]!.end);
    expect(after["task-4"]!.start).toBe(after["task-3"]!.end);
    for (const id of ["task-3", "task-4"] as const) {
      expect(after[id]!.end - after[id]!.start).toBe(before[id]!.end - before[id]!.start);
    }
  });

  // Regression coverage for page-specific UI, not a scheduling-engine behavior:
  // the demo button used to remember its own "addedLinkId", which a toolbar Undo invalidates
  // behind its back — the label kept reading "Remove" and the next click dispatched
  // link/remove for an id no longer in the store. The button must re-derive its label and action
  // from the store itself, including across undo/redo.
  test("the SS link demo button stays truthful across an undo of its own add", async ({ page, openExample }) => {
    await bootDependencies(page, openExample);

    const ssButton = page.locator("#addSsLinkBtn");
    const undoButton = page.locator("#undoBtn");

    await expect(ssButton).toHaveText("+ SS link demo");

    await ssButton.click();
    await expect(ssButton).toHaveText(/− Remove SS link demo/);
    expect(await findLink(page, "task-1", "task-3", "SS")).toBeDefined();

    // Undo through the toolbar, not the button — exactly the path that used to leave it lying.
    await undoButton.click();
    await settle(page);
    expect(await findLink(page, "task-1", "task-3", "SS")).toBeUndefined();
    await expect(ssButton).toHaveText("+ SS link demo");

    // With the label honest again, a click must re-add rather than try to remove a dead id.
    await ssButton.click();
    await expect(ssButton).toHaveText(/− Remove SS link demo/);
    expect(await findLink(page, "task-1", "task-3", "SS")).toBeDefined();
  });

  // scheduling.spec.ts's file header explicitly defers `schedule/reschedule`'s preview-then-apply
  // pairing ("headless already, and covered by the package's own unit tests"). This page's
  // Scheduling row is the one place an E2E can drive it through real UI.
  test("reschedule previews without applying, then applies in a single undo step", async ({ page, openExample }) => {
    await bootDependencies(page, openExample);
    const before = await allTasks(page, TASK_IDS);

    await page.click("#previewRescheduleBtn");
    await expect(page.locator("#statusPanel")).toContainText("Reschedule preview");
    expect(await allTasks(page, TASK_IDS)).toEqual(before);

    await page.click("#rescheduleBtn");
    await settle(page);
    const after = await allTasks(page, TASK_IDS);
    // task-1 is complete (progress 1) and never moves; task-2 is in progress (0.4), so it keeps
    // its start and has its end pushed out past the status date (T0 + 5d).
    expect(after["task-1"]).toEqual(before["task-1"]);
    expect(after["task-2"]!.start).toBe(before["task-2"]!.start);
    expect(after["task-2"]!.end).toBeGreaterThan(before["task-2"]!.end);

    await page.click("#undoBtn");
    await expect.poll(async () => allTasks(page, TASK_IDS)).toEqual(before);
  });

  // scheduling.spec.ts's file header explicitly defers snap's `pushGuards` stand-down interaction
  // with `pushSuccessors` while `autoSchedule.enabled` is `false` ("this file's example always
  // composes propagation ON"). This page's reconciler switch is the one place that composes it
  // OFF, so this is the only E2E covering the push-out reconciler.
  test("snap push-out reconciles successors when auto-schedule propagation is off", async ({ page, openExample }) => {
    await bootDependencies(page, openExample);

    // A link-rendering/reconciler option is a *construction* option on this page: selecting it
    // disposes and recreates the chart (see the page's own `boot()`).
    await page.selectOption("#optReconciler", "snap-push");
    await expect
      .poll(() => page.evaluate(() => gantt.service("stargantt.scheduler").propagationEnabled()))
      .toBe(false);
    await expect.poll(async () => taskOf(page, "task-1").then((t) => t.name)).toBe("Requirements");
    await settle(page);

    const before = await allTasks(page, TASK_IDS);
    await dragTaskBy(page, "task-1", 4);
    const after = await allTasks(page, TASK_IDS);

    // Push-out moves every violated successor forward by exactly the dragged task's own deficit,
    // start and end together, duration preserved.
    const delta = after["task-1"]!.start - before["task-1"]!.start;
    expect(delta).toBeGreaterThan(0);
    for (const id of TASK_IDS) {
      expect(after[id]!.start - before[id]!.start).toBe(delta);
      expect(after[id]!.end - after[id]!.start).toBe(before[id]!.end - before[id]!.start);
    }
  });
});
