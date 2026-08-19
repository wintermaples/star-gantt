import { expect, test } from "./_fixtures";
import { FIXED_TIME, settle } from "./_fixtures";

// Feature E2E for the opt-in `scheduling.criticalPath` nest, driven by
// `examples/critical-path.html`.
//
// Critical-path is the `criticalPath` nested group inside `scheduling` (scheduling.md §11.4), one
// of the nine plugins `presetStandard()` composes. The `stargantt.critical-path` service
// (`CriticalPathService` — `floatOf`, `criticalityOf`, `paths()`) is provided UNCONDITIONALLY
// regardless of whether the `criticalPath` nest is present (scheduling.md §1.3: "the `criticalPath`
// config nest gates only the visuals"), so the service-level assertions below hold independent of
// page composition. The default critical color is `#c62828` (`--sg-critical-bar` token,
// scheduling.md §7.3). The page assigns only `window.gantt` (not `window.ganttDemo` — unlike
// task-bars-display.html's page), so `gantt.` is used directly instead of `ganttDemo.gantt`.
//
// Overlap check against e2e/scheduling.spec.ts's own "critical path" describe block (run against
// examples/scheduling.html, a different dataset): that file verifies ONLY binary
// critical/not-critical classification on a qa/ship chain and a declassifying edit, and explicitly
// documents pixel-level critical-path recolor as out of scope for that file. Neither `paths()` nor
// `nearCritical` classification nor `floatOf()` nor the recolor pixel-paint are covered there, so
// both tests below (classification incl. nearCritical/paths, and the canvas recolor) are genuinely
// new — nothing here duplicates scheduling.spec.ts.
//
// The page composes `criticalPath({ nearCriticalDays: 2 })` over the standard preset with a
// zero-float chain design → build → test → ship, a near-critical docs branch (1 day of float,
// inside the 2-day band) and a clearly slack "logo" task. Two behaviors are asserted against the
// built bundle:
//
// 1. The `stargantt.critical-path` service classifies as the data dictates
//    (scheduling.md §7.1/§7.2): the chain is critical with zero total float, docs is
//    near-critical, logo has days of float and no class, and the chain forms one connected
//    critical path.
// 2. The default-on bar recolor reaches the canvas: pixels of the default critical color
//    `#c62828` appear on some chart layer (scheduling.md §7.3). The exact, deliberately strong
//    triple keeps the check independent of bar geometry.
//
// The clock is pinned so the data (anchored at today 0:00 UTC) is deterministic within the run.

const PAGE = "critical-path.html";
const PANE = ".sg-pane--chart";

// The plugin's default critical color (#c62828) as an exact RGB triple to scan for.
const CRITICAL_COLOR = { r: 0xc6, g: 0x28, b: 0x28 };

test("the critical-path service classifies the chain, the branch and the slack task", async ({
  page,
  openExample,
}) => {
  await openExample(PAGE, { ready: `${PANE} canvas`, fixedTime: FIXED_TIME, settle: true });

  const report = await page.evaluate(() => {
    const g = (window as any).gantt;
    const svc = g.service("stargantt.critical-path");
    const ids = ["design", "build", "test", "ship", "docs", "logo"];
    return {
      criticality: Object.fromEntries(ids.map((id) => [id, svc.criticalityOf(id) ?? null])),
      designFloat: svc.floatOf("design")?.totalFloat,
      logoFloatDays: (svc.floatOf("logo")?.totalFloat ?? 0) / 86400000,
      paths: svc.paths().map((p: any) => p.tasks),
    };
  });

  expect(report.criticality.design).toBe("critical");
  expect(report.criticality.build).toBe("critical");
  expect(report.criticality.test).toBe("critical");
  expect(report.criticality.ship).toBe("critical");
  // Docs has 1 day of float — inside the page's 2-day near-critical band.
  expect(report.criticality.docs).toBe("nearCritical");
  // Logo constrains nothing and stays unclassified with days of float.
  expect(report.criticality.logo).toBeNull();
  expect(report.designFloat).toBe(0);
  expect(report.logoFloatDays).toBeGreaterThanOrEqual(2);
  // The zero-float chain forms exactly one connected critical path.
  expect(report.paths.length).toBe(1);
});

test("the critical recolor paints onto the chart canvas", async ({ page, openExample }) => {
  await openExample(PAGE, { ready: `${PANE} canvas`, fixedTime: FIXED_TIME, settle: true });
  await settle(page);

  const found = await page.evaluate(
    ({ pane, color }) => {
      const canvases = Array.from(document.querySelectorAll<HTMLCanvasElement>(`${pane} canvas`));
      for (const canvas of canvases) {
        const ctx = canvas.getContext("2d");
        if (ctx === null || canvas.width === 0 || canvas.height === 0) continue;
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] === color.r && data[i + 1] === color.g && data[i + 2] === color.b) {
            return true;
          }
        }
      }
      return false;
    },
    { pane: PANE, color: CRITICAL_COLOR },
  );

  expect(found, "a pixel of the default critical color #c62828 on some chart layer").toBe(true);
});
