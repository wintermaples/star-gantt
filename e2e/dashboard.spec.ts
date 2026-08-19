import { expect, test } from "./_fixtures";
import { FIXED_TIME, settle } from "./_fixtures";

// E2E for examples/dashboard.html: the `stargantt.portfolio` plugin's dashboard feature area
// (docs/specs/plugins/portfolio.md §1.2/§3), composed as `StarGantt.portfolio({ dashboard: {} })`
// on top of `presetStandard()`. No other spec covers the portfolio plugin, so this file is the
// plugin's first coverage. The dashboard is one of two feature areas the `portfolio()` plugin
// provides (portfolio.md §"Purpose").
//
// This page configures `dashboard: {}` only — no `nodes`/`goals` — so it demonstrates the headless
// KPI panel alone, not the node hierarchy. A light presence check on `stargantt.portfolio`'s own
// stores (always provided per portfolio.md §"Purpose", even with no config) is included since
// nothing else touches that service yet.

const CONTAINER = "#chart";
const PANE = ".sg-pane--chart";

declare const gantt: {
  service(key: "stargantt.data"): {
    getTask(id: string): { id: string; progress?: number } | undefined;
  };
  service(key: "stargantt.history"): {
    state: { get(): { canUndo: boolean; canRedo: boolean; depth: number } };
    undo(): void;
  };
  service(key: "stargantt.dashboard"): {
    isOpen(): boolean;
    open(): boolean;
    close(): void;
  };
  service(key: "stargantt.portfolio"): {
    nodes: { get(): readonly unknown[] };
    goals: { get(): readonly unknown[] };
  };
  on(event: string, fn: () => void): { dispose(): void };
};

async function bootDashboard(page: import("@playwright/test").Page, openExample: import("./_fixtures").OpenExample): Promise<void> {
  await openExample("dashboard.html", { ready: `${PANE} canvas`, fixedTime: FIXED_TIME });
  await settle(page);
}

test.describe("portfolio service (always provided)", () => {
  test("stargantt.portfolio is composed with empty node/goal stores when the page configures none", async ({
    page,
    openExample,
  }) => {
    await bootDashboard(page, openExample);
    // portfolio.md §"Purpose": "With no config the plugin registers both services over empty sets
    // and changes nothing" — this page's `portfolio({ dashboard: {} })` call never touches `nodes`.
    const state = await page.evaluate(() => ({
      nodes: gantt.service("stargantt.portfolio").nodes.get(),
      goals: gantt.service("stargantt.portfolio").goals.get(),
    }));
    expect(state.nodes).toEqual([]);
    expect(state.goals).toEqual([]);
  });
});

test.describe("dashboard panel", () => {
  test("opens with the ten default widgets, Mark done is one undo step, Close hides it", async ({
    page,
    openExample,
  }) => {
    await bootDashboard(page, openExample);

    const panel = page.getByRole("dialog", { name: "Dashboard" });
    await expect(panel).toHaveCount(0); // default config paints nothing until opened

    await page.locator("#dash-open").click();
    await settle(page);
    await expect(panel).toBeVisible();
    expect(await panel.getAttribute("class")).toBe("sg-dashboard");

    // The default widget set (all ten, portfolio.md §Config) renders as cards; these three titles
    // come from packages/plugins/portfolio/src/internal/messages.ts's WIDGET_TITLE.
    await expect(panel.getByText("Progress", { exact: true })).toBeVisible();
    await expect(panel.getByText("Overdue tasks", { exact: true })).toBeVisible();
    await expect(panel.getByText("Tasks by status", { exact: true })).toBeVisible();

    // "Design" ended yesterday at 60% — the overdue widget's subject, with a Mark done action.
    await expect(panel.getByText(/Design/)).toBeVisible();
    expect(await page.evaluate(() => gantt.service("stargantt.data").getTask("design")?.progress)).toBe(0.6);

    const before = await page.evaluate(() => gantt.service("stargantt.history").state.get());
    await panel.getByRole("button", { name: "Mark done" }).first().click();
    await settle(page);
    expect(await page.evaluate(() => gantt.service("stargantt.data").getTask("design")?.progress)).toBe(1);
    const after = await page.evaluate(() => gantt.service("stargantt.history").state.get());
    expect(after.depth).toBe(before.depth + 1); // exactly one undo step (portfolio.md §3.5)

    await page.evaluate(() => gantt.service("stargantt.history").undo());
    await settle(page);
    expect(await page.evaluate(() => gantt.service("stargantt.data").getTask("design")?.progress)).toBe(0.6);

    await panel.getByRole("button", { name: "Close" }).click();
    await expect(panel).toHaveCount(0);
  });

  test("open()/close() emit their retained activity notifications (dashboard/opened, dashboard/closed)", async ({
    page,
    openExample,
  }) => {
    await bootDashboard(page, openExample);

    // portfolio.md §"Events": `dashboard/opened` / `dashboard/closed` are retained notifications,
    // not "…changed" events — they are plain EventBus broadcasts, distinct from
    // `portfolio/nodesChanged` / `portfolio/goalsChanged` which are superseded by the `nodes`/
    // `goals` stores asserted above.
    const events = await page.evaluate(async () => {
      const seen: string[] = [];
      const subs = [
        gantt.on("dashboard/opened", () => seen.push("opened")),
        gantt.on("dashboard/closed", () => seen.push("closed")),
      ];
      gantt.service("stargantt.dashboard").open();
      gantt.service("stargantt.dashboard").close();
      for (const s of subs) s.dispose();
      return seen;
    });
    expect(events).toEqual(["opened", "closed"]);
  });
});
