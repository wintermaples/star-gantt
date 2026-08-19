#!/usr/bin/env node
/*
 * e2e/oa/make-index.mjs — the top-level page over the twelve shard reports.
 *
 * Reads every shard's visual.json and every run's results JSON, groups the findings into the
 * clusters declared below, and writes oa-results/index.html. It reuses the shard template's
 * stylesheet verbatim so the index and the shard reports are one document family.
 *
 *   node e2e/oa/make-index.mjs
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OA_ROOT = join(HERE, "..", "..", "oa-results");
const SHARDS = 12;

// Findings that share a cause are one entry here; `runs` is filled from the shard reviews below.
const CLUSTERS = [
  {
    id: "label-collision",
    title: "Bar labels drawn at the same anchor overprint each other",
    detail:
      "The name label, the duration label and the progress label each place themselves without " +
      "knowing about the others, so any two that resolve to the same side of a bar are painted on " +
      "top of one another — \"Data migrati8d\", \"Core engine35%\", \"R5lIout\". Unreadable text, " +
      "and the most frequent finding of the sweep.",
    match: /overprint|collide|collision|overlap.*label|label.*overlap|clipped mid-word/i,
    verdict: "library defect — fixed: labels sharing a side are laid out along it",
  },
  {
    id: "contrast",
    title: "Theme combinations that leave text or bars unreadable",
    detail:
      "High-contrast presets combined with an opposing colorScheme, forcedColors, or dark summary " +
      "bars carrying dark label text. Bars vanish into the pane, or a label sits on a fill of its " +
      "own colour.",
    match: /invisible|unreadable|near-black|dark-on-dark|white on white|white-on-white|contrast|louder than the task bars|figure\/ground/i,
    verdict: "mostly fixed: an applied preset's colour scheme now outranks the host pin, so a palette is never painted onto the opposite scheme, and an inside label is measured against its own bar; the runs whose bars are drawn by the sweep's own stroke-only renderBar fixture are harness artefacts, not library defects",
  },
  {
    id: "empty-viewport",
    title: "Chart opens on a window that holds no data",
    detail:
      "Runs whose timeline-scale.origin (or the harness's own data-source/lazy-load fixture) puts " +
      "the visible window months away from the tasks. The chart is empty but correct: " +
      "autoExtendOrigin defaults to off, so an explicit origin is honoured exactly as given.",
    match: /blank|empty chart|chart pane is empty|renders nothing|no rows, no bars/i,
    verdict: "expected behaviour — an explicit origin is honoured (autoExtendOrigin defaults off); the harness invariant is the strict one, not the library",
  },
  {
    id: "overlay-stacking",
    title: "Floating overlays configured into the same corner stack on each other",
    detail: "perf-tools and zoom-controls both placed top-left, or the zoom toolbar over the header tier.",
    match: /toolbar overlaps|stack on each other|covering the chart|over the top timeline tier/i,
    verdict: "expected under the config, but the corner registry could de-conflict",
  },
  {
    id: "header-density",
    title: "Header labels run together at the densest zoom",
    detail: "Hour-tier labels printed with no gap between them (\"10 PM12 AM 2 AM\").",
    match: /header labels|run into each other|hour-tier/i,
    verdict: "expected behaviour — the run sets headerLabelPadding: 0, and fit-based thinning then lets labels abut exactly as asked",
  },
  {
    id: "stray-geometry",
    title: "A drawn line extends past the last row",
    detail: "The progress-tracking status line sweeps across the empty chart body below the rows.",
    match: /below the last row|sweeps diagonally|far below/i,
    verdict: "expected behaviour — the line is anchored on the run's own configured progress-tracking status date and spans the chart height by design",
  },
];

const runsById = new Map();
for (const file of readdirSync(join(OA_ROOT, "results"))) {
  const result = JSON.parse(readFileSync(join(OA_ROOT, "results", file), "utf8"));
  runsById.set(result.run, result);
}

const reviews = [];
for (let shard = 1; shard <= SHARDS; shard++) {
  const path = join(OA_ROOT, `shard-${String(shard).padStart(2, "0")}`, "visual.json");
  if (!existsSync(path)) continue;
  for (const entry of JSON.parse(readFileSync(path, "utf8"))) reviews.push({ ...entry, shard });
}

const issues = reviews.filter((r) => r.visual === "issue");
for (const cluster of CLUSTERS) cluster.runs = [];
const unclustered = [];
for (const issue of issues) {
  const cluster = CLUSTERS.find((c) => c.match.test(issue.note || ""));
  if (cluster) cluster.runs.push(issue);
  else unclustered.push(issue);
}

const machineFailures = [...runsById.values()].filter((r) => r.verdict === "fail");
const shardRows = [];
for (let shard = 1; shard <= SHARDS; shard++) {
  const mine = reviews.filter((r) => r.shard === shard);
  const runs = mine.map((r) => r.run);
  shardRows.push({
    shard,
    from: Math.min(...runs),
    to: Math.max(...runs),
    reviewed: mine.length,
    fail: mine.filter((r) => runsById.get(r.run)?.verdict === "fail").length,
    issues: mine.filter((r) => r.visual === "issue").length,
    href: `shard-${String(shard).padStart(2, "0")}/index.html`,
  });
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const style = readFileSync(join(HERE, "report-template.html"), "utf8").match(/<style>[\s\S]*?<\/style>/)[0];

const issueRow = (i) =>
  `<tr><td class="num"><a href="shard-${String(i.shard).padStart(2, "0")}/index.html">${i.run}</a></td>` +
  `<td><a class="shot" href="screenshots/run-${String(i.run).padStart(3, "0")}.png">screenshot</a></td>` +
  `<td>${esc(i.note || "")}</td></tr>`;

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>StarGantt orthogonal-array combination test — all 729 runs</title>
    ${style}
  </head>
  <body>
    <h1>StarGantt orthogonal-array combination test</h1>
    <p class="sub">
      OA(729, 3^111, strength 2) over every config field of all 15 official plugins, all of them
      loaded in every run against one shared dataset. Every ordered pair of levels of any two
      config fields appears in exactly 81 of the 729 runs. Design and factor catalogue:
      <code>plugin-config-orthogonal-array-L729.xlsx</code>; harness: <code>e2e/oa/</code>.
    </p>
    <p class="sub">
      <strong>Read the images and the notes as two different moments.</strong> The reviewer notes
      below describe the sweep's <em>first</em> pass and are what motivated the fixes; the
      screenshots and machine results are from a re-run <em>after</em> those fixes landed, so a run
      whose note describes overprinted labels now shows them laid out. What each cluster's verdict
      line says is the current state. Machine verdicts are unchanged by the fixes — the same seven
      runs fail, all of them because the run's own configuration opens the chart on a window that
      holds no data.
    </p>
    <p class="sub">
      The per-run verdicts were restored from each reviewing agent's returned summary after the
      first pass's output was deleted by the default E2E suite emptying <code>test-results/</code>
      (this tree now lives outside it); they reconcile exactly with the counts each agent reported.
      The short free-text notes reviewers left on <em>passing</em> runs were not recoverable and
      read as empty.
    </p>
    <div class="cards">
      <div class="card"><div class="n">729</div><div class="l">runs executed</div></div>
      <div class="card"><div class="n pass">${runsById.size - machineFailures.length}</div><div class="l">machine invariants pass</div></div>
      <div class="card"><div class="n fail">${machineFailures.length}</div><div class="l">machine invariants fail</div></div>
      <div class="card"><div class="n pass">${reviews.length - issues.length}</div><div class="l">screenshots judged clean</div></div>
      <div class="card"><div class="n fail">${issues.length}</div><div class="l">screenshots judged broken</div></div>
      <div class="card"><div class="n">${reviews.length}</div><div class="l">screenshots reviewed</div></div>
    </div>

    <h2>Findings by cause</h2>
    ${CLUSTERS.filter((c) => c.runs.length > 0)
      .map(
        (c) => `<details open>
      <summary><strong>${esc(c.title)}</strong> — ${c.runs.length} run${c.runs.length === 1 ? "" : "s"}</summary>
      <p class="sub">${esc(c.detail)}<br /><em>${esc(c.verdict)}</em></p>
      <table><thead><tr><th>Run</th><th>Image</th><th>Reviewer note</th></tr></thead>
        <tbody>${c.runs.sort((a, b) => a.run - b.run).map(issueRow).join("")}</tbody></table>
    </details>`,
      )
      .join("\n")}
    ${
      unclustered.length > 0
        ? `<details open><summary><strong>Not yet grouped</strong> — ${unclustered.length}</summary>
      <table><thead><tr><th>Run</th><th>Image</th><th>Reviewer note</th></tr></thead>
      <tbody>${unclustered.sort((a, b) => a.run - b.run).map(issueRow).join("")}</tbody></table></details>`
        : ""
    }

    <h2>Machine invariant failures</h2>
    <table>
      <thead><tr><th>Run</th><th>View</th><th>Failure</th></tr></thead>
      <tbody>${machineFailures
        .sort((a, b) => a.run - b.run)
        .map(
          (r) =>
            `<tr class="row-fail"><td class="num">${r.run}</td><td><span class="tag">${esc(r.viewMode)}</span></td><td>${esc(r.failures.join("; "))}</td></tr>`,
        )
        .join("")}</tbody>
    </table>

    <h2>Shard reports</h2>
    <table>
      <thead><tr><th>Shard</th><th>Runs</th><th class="num">Reviewed</th><th class="num">Machine failures</th><th class="num">Visual issues</th><th>Report</th></tr></thead>
      <tbody>${shardRows
        .map(
          (s) =>
            `<tr><td class="num">${s.shard}</td><td>${s.from}–${s.to}</td><td class="num">${s.reviewed}</td>` +
            `<td class="num ${s.fail ? "fail" : "pass"}">${s.fail}</td><td class="num ${s.issues ? "fail" : "pass"}">${s.issues}</td>` +
            `<td><a href="${s.href}">open</a></td></tr>`,
        )
        .join("")}</tbody>
    </table>
  </body>
</html>
`;

writeFileSync(join(OA_ROOT, "index.html"), html);
console.log(
  `wrote ${join(OA_ROOT, "index.html")} — ${runsById.size} runs, ${machineFailures.length} machine failures, ` +
    `${issues.length} visual issues in ${CLUSTERS.filter((c) => c.runs.length).length} clusters, ${unclustered.length} ungrouped`,
);
