#!/usr/bin/env node
// tools/core-size-gate.mjs
//
// Core size gate (docs/specs/architecture.md, chapter 7 "Mechanical enforcement
// (CI)" / CLAUDE.md section 3): the core must stay at or under 12KB (12,288
// bytes) after minification. The core's smallness is a hard design constraint
// (docs/specs/architecture.md chapter 1: "Size target: under 12KB after
// minification"), so this gate is mechanical, not advisory.
//
// The measured artifact is the ESM entry of the ALREADY-MINIFIED build output
// (packages/core builds via oxc minify per its vite config — see
// packages/core/package.json "build" script), resolved from
// packages/core/package.json's `exports["."].import` field rather than a
// hard-coded filename, so a future rename of the dist entry doesn't silently
// stop being checked.
//
// If packages/core/dist doesn't exist yet (core hasn't been built in this
// checkout), or the resolved entry file is missing, this gate SKIPS with a
// warning and exits 0 — it is not this script's job to force a build.

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CORE_DIR = path.join(ROOT, "packages", "core");
const CORE_DIST_DIR = path.join(CORE_DIR, "dist");
const CORE_PKG_JSON = path.join(CORE_DIR, "package.json");

const SIZE_LIMIT_BYTES = 12288; // 12KB

function skip(message) {
  process.stdout.write(`core-size-gate: SKIPPED — ${message}\n`);
  process.exit(0);
}

function resolveEsmEntry() {
  if (!existsSync(CORE_PKG_JSON)) return null;
  const pkg = JSON.parse(readFileSync(CORE_PKG_JSON, "utf8"));
  const importEntry = pkg?.exports?.["."]?.import ?? pkg?.module;
  if (!importEntry) return null;
  return path.resolve(CORE_DIR, importEntry);
}

function main() {
  if (!existsSync(CORE_DIST_DIR)) {
    skip(`${path.relative(ROOT, CORE_DIST_DIR)} does not exist (core not built yet)`);
    return;
  }

  const entryPath = resolveEsmEntry();
  if (!entryPath || !existsSync(entryPath)) {
    skip(
      `could not resolve an existing ESM entry from packages/core/package.json ` +
        `exports["."].import (got: ${entryPath ? path.relative(ROOT, entryPath) : "none"})`,
    );
    return;
  }

  const { size } = statSync(entryPath);
  const relEntry = path.relative(ROOT, entryPath);

  if (size > SIZE_LIMIT_BYTES) {
    process.stderr.write(
      `core-size-gate: FAIL — ${relEntry} is ${size} bytes, over the ${SIZE_LIMIT_BYTES}-byte ` +
        `(12KB) minified size limit (docs/specs/architecture.md chapter 1 / 7)\n`,
    );
    process.exit(1);
  }

  process.stdout.write(
    `core-size-gate: OK — ${relEntry} is ${size} bytes (limit ${SIZE_LIMIT_BYTES} bytes)\n`,
  );
  process.exit(0);
}

main();
