import { expect, test } from "./_fixtures";
import { FIXED_TIME, settle } from "./_fixtures";

// E2E for examples/baselines.html: the `stargantt.tracking` plugin's `baselines` nest
// (docs/specs/plugins/tracking.md §1.1/§2.1/§2.3), composed as an OPT-IN plugin on top of
// `presetStandard()`.
//
// Overlap check against e2e/tracking.spec.ts (which already exercises `stargantt.baselines` on
// `examples/tracking.html`): that file covers `state.get()` (activeId/baselines list), `variance()`
// and the slip-triangle overlay, and a capture-removal control on the slip triangle — but its file
// header explicitly scopes OUT "the baseline bar underlay's own paint" as deferred here. This file
// therefore does NOT re-cover the plain `variance()`/slip-triangle assertions (already proven); it
// covers what tracking.spec.ts does not: `milestoneVariance()`, `summary()` (this page's dataset
// has a milestone and a documented project-level finish variance tracking.spec.ts's dataset does
// not exercise the same way), the baseline bar underlay's actual canvas paint (tracking.spec.ts's
// own deferral), and the `setActual`/`actualOf` actual-dates surface (§2.4), which no other spec
// touches at all.
//
// Every canvas-paint assertion is paired with a capture-removal control (deactivating the baseline
// and re-scanning), matching the canvas-probe pattern used in tracking.spec.ts.

const DAY_MS = 86_400_000;
const CONTAINER = "#chart";
const PANE = ".sg-pane--chart";

declare const gantt: {
  service(key: "stargantt.baselines"): {
    state: {
      get(): {
        baselines: readonly { id: string | number; name: string }[];
        activeId: string | number | undefined;
      };
    };
    variance(): readonly { id: string; endVarianceMs: number }[];
    milestoneVariance(): readonly { id: string; endVarianceMs: number; type: string }[];
    summary(): { finishVarianceMs: number; taskCount: number } | undefined;
    actualOf(id: string): { start?: number; end?: number } | undefined;
    setActual(id: string, actual: { start?: number | null; end?: number | null }): void;
    setActive(id: string | number | undefined): void;
  };
  service(key: "stargantt.history"): {
    state: { get(): { canUndo: boolean; canRedo: boolean; depth: number } };
    undo(): void;
  };
};

async function bootBaselines(page: import("@playwright/test").Page, openExample: import("./_fixtures").OpenExample): Promise<void> {
  await openExample("baselines.html", { ready: `${PANE} canvas`, fixedTime: FIXED_TIME });
  await settle(page);
}

/** Whether ANY `.sg-pane--chart` canvas contains a pixel of the given exact RGB triple. */
async function paneHasColor(
  page: import("@playwright/test").Page,
  color: { r: number; g: number; b: number },
): Promise<boolean> {
  return page.evaluate(
    ({ pane, color }) => {
      const canvases = Array.from(document.querySelectorAll<HTMLCanvasElement>(`${pane} canvas`));
      for (const canvas of canvases) {
        const ctx2d = canvas.getContext("2d");
        if (ctx2d === null || canvas.width === 0 || canvas.height === 0) continue;
        const data = ctx2d.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] === color.r && data[i + 1] === color.g && data[i + 2] === color.b) return true;
        }
      }
      return false;
    },
    { pane: PANE, color },
  );
}

test.describe("baselines service", () => {
  test("reports the preloaded snapshot's variance, milestone variance and project summary", async ({
    page,
    openExample,
  }) => {
    await bootBaselines(page, openExample);

    const state = await page.evaluate(() => gantt.service("stargantt.baselines").state.get());
    expect(state.activeId).toBe("b1");
    expect(state.baselines.map((b) => ({ id: b.id, name: b.name }))).toEqual([
      { id: "b1", name: "Plan of record" },
    ]);

    const variance = await page.evaluate(() => gantt.service("stargantt.baselines").variance());
    const byId = new Map(variance.map((row) => [row.id, row]));
    // The page's own comments document these exact whole-day drifts.
    expect(byId.get("spec")?.endVarianceMs).toBe(0);
    expect(byId.get("impl")?.endVarianceMs).toBe(3 * DAY_MS);
    expect(byId.get("qa")?.endVarianceMs).toBe(2 * DAY_MS);
    expect(byId.get("docs")?.endVarianceMs).toBe(-2 * DAY_MS);

    // milestoneVariance(): only "ship" is milestone-typed, in either the store or the baseline.
    const milestones = await page.evaluate(() => gantt.service("stargantt.baselines").milestoneVariance());
    expect(milestones.map((row) => [row.id, row.endVarianceMs])).toEqual([["ship", 3 * DAY_MS]]);

    // summary(): the project envelope (root included) runs 3 days later than planned, and all six
    // of the page's tasks are present on both sides of the comparison.
    const summary = await page.evaluate(() => gantt.service("stargantt.baselines").summary());
    expect(summary?.finishVarianceMs).toBe(3 * DAY_MS);
    expect(summary?.taskCount).toBe(6);
  });
});

test.describe("baseline bar underlay", () => {
  test("the active baseline's bars paint the baseline-bar token color; deactivating clears them", async ({
    page,
    openExample,
  }) => {
    await bootBaselines(page, openExample);

    // tracking.md §2.3: `--sg-baseline-bar` (`#9aa5b1`) — the underlay's token color.
    const BASELINE_BAR = { r: 0x9a, g: 0xa5, b: 0xb1 };

    expect(
      await paneHasColor(page, BASELINE_BAR),
      "a pixel of the baseline-bar color #9aa5b1 on some chart layer while a baseline is active",
    ).toBe(true);

    // Capture-removal control: deactivating the baseline stops the underlay from painting at all.
    await page.evaluate(() => gantt.service("stargantt.baselines").setActive(undefined));
    await settle(page);
    expect(
      await paneHasColor(page, BASELINE_BAR),
      "the baseline-bar color should be gone once no baseline is active",
    ).toBe(false);
  });
});

test.describe("actual dates", () => {
  test("actualOf reflects the page's seeded actuals; setActual is one undoable transaction", async ({
    page,
    openExample,
  }) => {
    await bootBaselines(page, openExample);

    // "spec" and "docs" were seeded with actualStart/actualEnd meta at load time (baselines.html).
    const specActual = await page.evaluate(() => gantt.service("stargantt.baselines").actualOf("spec"));
    // "impl" was seeded with only actualStart (still in progress — no actualEnd).
    const implActual = await page.evaluate(() => gantt.service("stargantt.baselines").actualOf("impl"));
    // "qa" carries no actuals at all.
    const qaActual = await page.evaluate(() => gantt.service("stargantt.baselines").actualOf("qa"));

    expect(specActual).toBeDefined();
    expect(specActual?.end).toBeDefined();
    expect(implActual?.start).toBeDefined();
    expect(implActual?.end).toBeUndefined();
    expect(qaActual).toBeUndefined();

    const before = await page.evaluate(() => gantt.service("stargantt.history").state.get());
    await page.evaluate(() => {
      gantt.service("stargantt.baselines").setActual("qa", { start: Date.now(), end: Date.now() + 86_400_000 });
    });
    await settle(page);
    const after = await page.evaluate(() => gantt.service("stargantt.history").state.get());
    expect(after.depth).toBe(before.depth + 1); // one undoable transaction

    const qaAfter = await page.evaluate(() => gantt.service("stargantt.baselines").actualOf("qa"));
    expect(qaAfter?.start).toBeDefined();
    expect(qaAfter?.end).toBeDefined();

    // The single undo reverts the whole write, back to "no actuals recorded".
    await page.evaluate(() => gantt.service("stargantt.history").undo());
    await settle(page);
    const qaUndone = await page.evaluate(() => gantt.service("stargantt.baselines").actualOf("qa"));
    expect(qaUndone).toBeUndefined();
  });
});
