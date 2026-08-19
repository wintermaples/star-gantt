/*
 * e2e/oa/oa.spec.ts — the orthogonal-array combination suite.
 *
 * One test per run of OA(729, 3^111, strength 2): all 15 official plugins are composed with the
 * config values that run prescribes, and a set of machine invariants is checked, and a screenshot
 * is written for visual review. See this directory's CLAUDE.md for the full procedure.
 *
 * No `examples/*.html` page wires a playground-shell script with a `#demo-code`/
 * `window.__pg.run()` block, so this harness boots directly instead: navigate to
 * `examples/hello.html` (a real example page, not test-only HTML — same "no test-only HTML" policy
 * the rest of the suite follows), dispose its own auto-booted demo instance, and `new Function(...)`
 * + call the generated `boot({ mount, StarGantt })` against its now-empty `#chart` mount. This is
 * strictly simpler than a shell's reboot/chrome dance would be (each Playwright test already gets
 * one fresh page, so there is no "swap between runs" to manage), and needs no ambient
 * `window.__pg` typing.
 *
 * Sharding is explicit rather than Playwright's `--shard`, which splits by file: this suite is one
 * file, so `OA_SHARD` / `OA_SHARDS` select the block of runs a process owns. `OA_RUNS` overrides
 * both with an explicit comma-separated list, for pilots and for re-checking single runs.
 *
 * Results are written per run as JSON next to the screenshots, so a reporting pass can build its
 * page without re-running the browser.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { test, expect, FIXED_TIME, settle } from "../_fixtures";
import { buildRun } from "./boot-code";
import { OA_DATASET, OA_TASK_COUNT } from "./dataset";
import { RUNS, shardRuns } from "./oa-array";

// hello.html: the smallest example page, one `<div id="chart">` mount, auto-boots its own tiny
// demo instance as `window.gantt` (disposed and replaced below, per run).
const HOST_PAGE = "hello.html";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Deliberately NOT under test-results/: Playwright empties its `outputDir` at the start of every
// run, so the default suite's `test-results/` wipes anything parked inside it — including 729
// screenshots and their reviews. This tree is owned by the OA suite alone.
const OUT_ROOT = join(REPO_ROOT, "oa-results");
const SHOTS = join(OUT_ROOT, "screenshots");
const RESULTS = join(OUT_ROOT, "results");

const SHARD = Number(process.env.OA_SHARD ?? 1);
const SHARDS = Number(process.env.OA_SHARDS ?? 1);
const RUN_LIST = process.env.OA_RUNS
  ? process.env.OA_RUNS.split(",").map((s) => Number(s.trim())).filter((n) => n >= 1 && n <= RUNS)
  : shardRuns(SHARD, SHARDS);

mkdirSync(SHOTS, { recursive: true });
mkdirSync(RESULTS, { recursive: true });

const pad = (run: number): string => String(run).padStart(3, "0");

interface Probe {
  chartPaneWidth: number;
  gridPaneWidth: number;
  canvases: { width: number; height: number; blank: boolean }[];
  gridRows: number;
  ariaRows: number;
  ariaRowCount: number | null;
  hasTreegrid: boolean;
  rovingTabbable: number;
  docScrollWidth: number;
  docClientWidth: number;
  suspectText: string[];
}

/** Everything the invariants are computed from, read in one page round-trip. */
const PROBE = `() => {
  const chartPane = document.querySelector(".sg-pane--chart");
  const gridPane = document.querySelector(".sg-pane--grid");
  const canvases = Array.from(document.querySelectorAll("canvas.sg-layer")).map((c) => {
    let blank = true;
    try {
      const g = c.getContext("2d", { willReadFrequently: true });
      const data = g.getImageData(0, 0, c.width, c.height).data;
      const first = [data[0], data[1], data[2], data[3]].join(",");
      for (let i = 4; i < data.length; i += 4) {
        if ([data[i], data[i + 1], data[i + 2], data[i + 3]].join(",") !== first) { blank = false; break; }
      }
    } catch (err) {
      blank = false; // an unreadable canvas is not evidence of a blank one
    }
    return { width: c.width, height: c.height, blank };
  });
  const tree = document.querySelector('[role="treegrid"]');
  const rowText = Array.from(document.querySelectorAll(".sg-grid-row")).map((r) => r.textContent || "");
  const suspect = rowText.filter((t) => /NaN|\\[object Object\\]|undefined/.test(t)).slice(0, 5);
  return {
    chartPaneWidth: chartPane ? chartPane.getBoundingClientRect().width : 0,
    gridPaneWidth: gridPane ? gridPane.getBoundingClientRect().width : 0,
    canvases,
    gridRows: document.querySelectorAll(".sg-grid-row").length,
    ariaRows: tree ? tree.querySelectorAll('[role="row"]').length : 0,
    ariaRowCount: tree && tree.getAttribute("aria-rowcount") !== null
      ? Number(tree.getAttribute("aria-rowcount")) : null,
    hasTreegrid: Boolean(tree),
    rovingTabbable: tree ? tree.querySelectorAll('[tabindex="0"]').length : 0,
    docScrollWidth: document.documentElement.scrollWidth,
    docClientWidth: document.documentElement.clientWidth,
    suspectText: suspect,
  };
}`;

interface BootResult {
  ok: boolean;
  error: string | null;
}

test.describe.configure({ mode: "parallel" });

for (const run of RUN_LIST) {
  test(`OA run ${pad(run)}`, async ({ page, pageErrors, openExample }) => {
    const built = buildRun(run, OA_DATASET);
    const consoleErrors: string[] = [];

    await openExample(HOST_PAGE, { fixedTime: FIXED_TIME });
    // Attached after the host page's own boot so only this run's output is attributed to it.
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    // Dispose hello.html's own demo instance and reuse its (now-empty) #chart mount, grown to
    // 760px so every row of OA_DATASET's small fixture stays above the fold in the screenshot.
    // The generated `function boot({ mount, StarGantt })` (boot-code.ts) is evaluated via an
    // isolated `new Function` scope, called once, its thrown error (if any) caught and reported
    // rather than left to reject the outer `page.evaluate` — a run that throws must still get an
    // evidenced JSON record, not an unhandled Playwright evaluation error.
    const bootResult = (await page.evaluate((code) => {
      try {
        const prev = (window as unknown as { gantt?: { dispose?: () => void } }).gantt;
        if (prev && typeof prev.dispose === "function") prev.dispose();
        const mount = document.getElementById("chart");
        if (!mount) throw new Error("#chart mount not found on host page");
        mount.innerHTML = "";
        mount.style.height = "760px";
        const factory = new Function(
          '"use strict";\n' + code + '\n;return typeof boot === "function" ? boot : null;',
        ) as () => ((args: { mount: Element; StarGantt: unknown }) => unknown) | null;
        const boot = factory();
        if (!boot) throw new Error("generated boot() not found");
        const instance = boot({ mount, StarGantt: (window as unknown as { StarGantt: unknown }).StarGantt });
        return { ok: Boolean(instance), error: null };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }, built.code)) as BootResult;

    // A `settleLayout` helper to wait out a transient one-frame grid/canvas height disagreement is
    // not implemented yet (see _fixtures.ts's header) pending the bottom-region plugins that would
    // trigger it. A double-rAF `settle()` is used instead — if a production (full 729-run) sweep
    // sees flaky layout probes, adding such a helper is the first thing to try.
    await settle(page);
    await settle(page);

    // A string argument is evaluated as an *expression*, so the probe is called rather than merely
    // named — naming it would hand back an unserializable function and read as `undefined` here.
    const probe = (await page.evaluate(`(${PROBE})()`)) as Probe;
    const shot = join(SHOTS, `run-${pad(run)}.png`);
    const chart = page.locator("#chart").first();
    await (await chart.count() > 0 ? chart : page.locator("body")).screenshot({ path: shot });

    // `view.panes` (`PanesConfig`, `{ initialViewMode: "gantt" | "grid" }`) legitimately drops one
    // of the two panes, so the pane-and-canvas invariants are read against the view mode this run
    // asked for rather than against "split". The factor's value is a JS source string (level 1 is
    // `{ initialViewMode: "gantt" }`, level 2 `{ initialViewMode: "grid" }` — see catalog.json),
    // not a structured object, so it's matched textually rather than parsed.
    const viewFactor = built.nonDefault.find((f) => f.id === "view.panes");
    const viewMode = viewFactor === undefined
      ? "split"
      : viewFactor.value.includes('"grid"')
        ? "grid"
        : viewFactor.value.includes('"gantt"')
          ? "gantt"
          : "split";
    const chartShown = viewMode !== "grid";
    const gridShown = viewMode !== "gantt";

    const failures: string[] = [];
    if (!bootResult.ok) failures.push(`boot failed: ${bootResult.error ?? "no instance returned"}`);
    if (pageErrors.length > 0) {
      failures.push(...pageErrors.map((e) => `uncaught: ${e.name}: ${e.message}`));
    }
    if (consoleErrors.length > 0) failures.push(...consoleErrors.map((t) => `console.error: ${t}`));
    if (!probe.hasTreegrid) failures.push('no [role="treegrid"] mirror');
    if (probe.ariaRows === 0) failures.push("the ARIA mirror holds no rows");
    if (chartShown) {
      if (probe.canvases.length === 0) failures.push("no canvas layer mounted");
      if (probe.canvases.some((c) => c.width === 0 || c.height === 0)) {
        failures.push("a canvas layer has zero size");
      }
      if (probe.canvases.length > 0 && probe.canvases.every((c) => c.blank)) {
        failures.push("every canvas layer is blank — nothing was drawn");
      }
      if (probe.chartPaneWidth <= 0) failures.push("chart pane collapsed to zero width");
    }
    if (gridShown) {
      if (probe.gridPaneWidth <= 0) failures.push("grid pane collapsed to zero width");
      if (probe.gridRows === 0) failures.push("the grid pane holds no rows");
    }
    if (probe.docScrollWidth > probe.docClientWidth) {
      failures.push(`horizontal page overflow: ${probe.docScrollWidth} > ${probe.docClientWidth}`);
    }
    if (probe.suspectText.length > 0) {
      failures.push(`placeholder text in grid rows: ${probe.suspectText.join(" | ")}`);
    }

    const warnings: string[] = [];
    if (probe.hasTreegrid && probe.rovingTabbable !== 1) {
      warnings.push(`roving tabindex: ${probe.rovingTabbable} tabbable nodes, expected 1`);
    }
    if (probe.ariaRowCount !== null && (probe.ariaRowCount < 1 || probe.ariaRowCount > OA_TASK_COUNT)) {
      warnings.push(`aria-rowcount ${probe.ariaRowCount} outside 1..${OA_TASK_COUNT}`);
    }
    if (probe.canvases.some((c) => c.blank)) {
      warnings.push(`${probe.canvases.filter((c) => c.blank).length} of ${probe.canvases.length} canvas layers blank`);
    }

    writeFileSync(
      join(RESULTS, `run-${pad(run)}.json`),
      JSON.stringify(
        {
          run,
          viewMode,
          verdict: failures.length === 0 ? "pass" : "fail",
          failures,
          warnings,
          probe,
          screenshot: `../screenshots/run-${pad(run)}.png`,
          nonDefault: built.nonDefault,
          nonDefaultCount: built.nonDefault.length,
          code: built.code,
        },
        null,
        1,
      ),
    );

    // Page errors are reported through the JSON above as well, so the record survives the failure
    // the `pageErrors` fixture raises during teardown.
    expect(failures, `machine invariants for run ${pad(run)}`).toEqual([]);
  });
}
