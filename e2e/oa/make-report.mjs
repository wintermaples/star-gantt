#!/usr/bin/env node
/*
 * e2e/oa/make-report.mjs — renders one shard's HTML report from the shared template.
 *
 * Every shard's report is produced by this script, so the reports are the same document with
 * different data rather than each reviewer's own idea of a report.
 *
 *   node e2e/oa/make-report.mjs --shard 3 --shards 12
 *   node e2e/oa/make-report.mjs --runs 1,2,729 --out oa-results/pilot
 *
 * Inputs, all under oa-results/:
 *   results/run-NNN.json   written by the suite — machine verdict, probe, config, screenshot path
 *   shard-NN/visual.json   written by the reviewer — [{ run, visual: "ok"|"issue", note }]
 * Output:
 *   shard-NN/index.html
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const OA_ROOT = join(REPO_ROOT, "oa-results");

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const shard = arg("shard") === undefined ? undefined : Number(arg("shard"));
const shards = Number(arg("shards") ?? 12);
const explicitRuns = arg("runs")?.split(",").map((s) => Number(s.trim()));
const outDir = arg("out")
  ? join(REPO_ROOT, arg("out"))
  : join(OA_ROOT, `shard-${String(shard).padStart(2, "0")}`);

/** Same contiguous blocks the suite's shardRuns() hands out. */
function shardRuns(index, total) {
  const RUNS = 729;
  const size = Math.ceil(RUNS / total);
  const start = (index - 1) * size + 1;
  const out = [];
  for (let r = start; r <= Math.min(RUNS, start + size - 1); r++) out.push(r);
  return out;
}

const runs = explicitRuns ?? shardRuns(shard, shards);
if (!runs || runs.length === 0) throw new Error("no runs selected — pass --shard or --runs");

mkdirSync(outDir, { recursive: true });

const visualPath = join(outDir, "visual.json");
const visual = new Map();
if (existsSync(visualPath)) {
  for (const entry of JSON.parse(readFileSync(visualPath, "utf8"))) {
    visual.set(Number(entry.run), entry);
  }
}

const rows = [];
const missing = [];
for (const run of runs) {
  const file = join(OA_ROOT, "results", `run-${String(run).padStart(3, "0")}.json`);
  if (!existsSync(file)) {
    missing.push(run);
    continue;
  }
  const result = JSON.parse(readFileSync(file, "utf8"));
  const review = visual.get(run) ?? {};
  const shot = join(OA_ROOT, "screenshots", `run-${String(run).padStart(3, "0")}.png`);
  rows.push({
    run,
    viewMode: result.viewMode,
    verdict: result.verdict,
    failures: result.failures,
    warnings: result.warnings,
    nonDefault: result.nonDefault,
    nonDefaultCount: result.nonDefaultCount,
    screenshot: relative(outDir, shot).split("\\").join("/"),
    visual: review.visual,
    note: review.note,
  });
}

const label = shard === undefined ? `runs ${runs[0]}–${runs[runs.length - 1]}` : `shard ${shard} of ${shards}`;
const data = {
  title: `StarGantt orthogonal-array combination test — ${label}`,
  subtitle:
    `Runs ${runs[0]}–${runs[runs.length - 1]} of OA(729, 3^111, strength 2). ` +
    `All 15 official plugins load in every run; only config values vary. ` +
    `${rows.length} of ${runs.length} runs have results${missing.length ? ` (missing: ${missing.join(", ")})` : ""}.`,
  runs: rows,
};

const template = readFileSync(join(HERE, "report-template.html"), "utf8");
const html = template
  .split("__TITLE__").join(data.title)
  .replace("/*__DATA__*/ null", JSON.stringify(data));

writeFileSync(join(outDir, "index.html"), html);
console.log(
  `wrote ${join(outDir, "index.html")} — ${rows.length} runs, ` +
    `${rows.filter((r) => r.verdict === "fail").length} machine failures, ` +
    `${rows.filter((r) => r.visual === "issue").length} visual issues, ` +
    `${rows.filter((r) => !r.visual).length} not visually reviewed`,
);
