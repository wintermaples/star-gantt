#!/usr/bin/env node
// tools/lint-deps.mjs
//
// Architecture dependency-direction linter (docs/specs/architecture.md, chapter 7
// "Mechanical enforcement (CI)").
//
// SCOPE: this lint walks ONLY <repoRoot>/packages/plugins/*/src/** (official
// plugin sources). It is a development-time discipline of THIS repository, not
// a rule imposed on third-party or user code, and it is NEVER bundled into the
// runtime (core/sdk ship no lint logic). See architecture.md chapter 8
// "Third-party principles".
//
// Checks (all against the hard-coded LAYER_MAP / SERVICE_PROVIDER tables below,
// architecture.md chapter 4.1 / 5):
//   (a) import scan       — `@stargantt/plugin-X` specifiers and relative-path
//                            imports that cross into a different plugin's src
//                            tree. Flags imports that target a STRICTLY HIGHER
//                            layer than the importing plugin.
//   (b) ctx.use / ctx.useOptional scan — looks up the referenced
//                            `stargantt.<id>` service literal against the
//                            service -> providing-plugin table and flags layer
//                            violations. Hard `ctx.use` forbids same-layer AND
//                            upper-layer references; `ctx.useOptional` forbids
//                            upper-layer only (same-layer optional
//                            cross-references are the documented escape hatch,
//                            e.g. tracking <-> resource cost integration). A
//                            non-literal (dynamically computed) service id
//                            cannot be statically resolved and is reported as a
//                            warning only.
//   (c) ctx.emit / ctx.on scan — first-argument event-name literals are
//                            checked against tools/official-events.mjs. Names
//                            outside the catalog are violations (this catches
//                            migration residue such as abolished "*/changed"
//                            events). A non-literal (dynamically computed)
//                            event name cannot be statically checked and is
//                            reported as a warning only.
//   (d) directory/LAYER_MAP consistency — every directory actually present
//                            under packages/plugins/ must have a LAYER_MAP
//                            entry, and every LAYER_MAP entry must have a
//                            corresponding directory. Either direction of
//                            mismatch is a violation (silent skipping of an
//                            unmapped plugin directory would defeat the whole
//                            lint for that plugin).
//   (e) headless subtrees   — see HEADLESS_SUBTREES below.
//   (f) service-lookup aliasing — flags `ctx.use`/`ctx.useOptional` captured
//                            via `.bind(...)` or a bare variable assignment
//                            instead of called with a literal string directly:
//                            both hide the service id from check (b)'s scan,
//                            regardless of whether the underlying edge would
//                            itself be legal. See scanAliasing below for the
//                            sanctioned visible-shim fix.
//
// NOT implemented: cross-checking each plugin's package.json `dependencies`
// against LAYER_MAP, and explicit dependency-graph cycle detection. The layer
// map is a total order, so a cycle would require an edge that violates the
// order and is therefore already caught by check (a)/(b) above; a dedicated
// cycle detector would only add value for same-layer optional cross-references
// (e.g. tracking <-> resource), which are deliberately unbounded by this lint.
// Left as future work if same-layer optional cycles become a real problem.
//
// Warnings (dynamic import/service/event names, see (b)/(c) above) never
// affect the exit code — only violations do.
//
// Exit code: 1 if any violation is found, 0 otherwise. Each violation is
// printed as exactly one line on stderr.
//
// Implementation notes:
//   - This file intentionally uses only Node.js built-ins and hand-rolled
//     regex / character scanning (no external parser/AST library), per the
//     project's "no runtime dependencies, tools use Node stdlib only" rule.
//   - Comment stripping (see stripComments below) is a naive character scan
//     that does NOT tokenize string/template literals: a `//` or `/*`
//     sequence occurring inside a string literal is (incorrectly) treated as
//     a real comment start, and a comment containing quote characters is not
//     specially handled either. This is an accepted, documented limitation of
//     the regex/char-scan approach — pseudo-patterns written inside actual
//     string literals (as opposed to comments) are intentionally left
//     scanned as before (not the target of this fix).
//   - Generic type-argument lists on ctx.use/useOptional/emit/on calls (e.g.
//     `ctx.use<XService>(...)`) are matched up to ONE level of nesting (e.g.
//     `ctx.emit<Foo<Bar>>(...)`). Two or more levels of nesting are NOT
//     matched by the generic-args pattern, which makes the whole call fail to
//     match — such a call is silently skipped (not even a warning). This is a
//     narrow, documented limitation of the regex-based scanner; revisit if it
//     causes real false negatives in practice.
//   - `ctx?.use(...)`, `ctx?.emit(...)` etc. (optional chaining on `ctx`
//     itself) are matched the same as `ctx.use(...)`.
//
// Exported for testing (tools/lint-deps.test.mjs): `lintRepo(root)` runs all
// checks against an arbitrary repo root (real or a fixture temp directory)
// and returns `{ violations, warnings }` without touching stdout/stderr or
// process.exit — `main()` is the thin CLI wrapper around it used when this
// file is run directly.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OFFICIAL_EVENTS } from "./official-events.mjs";

// ---------------------------------------------------------------------------
// Layer map (architecture.md chapter 5). Layer 0 (core, sdk) is handled
// specially below since those two are not plugin directories.
// ---------------------------------------------------------------------------
export const LAYER_MAP = Object.freeze({
  "data-store": 1,
  view: 2,
  "tree-grid": 3,
  // task-bars sits in its own layer above tree-grid: its hard dependency on
  // row geometry (stargantt.rows) must point strictly downward
  // (architecture.md chapter 5).
  "task-bars": 4,
  interaction: 5,
  "undo-redo": 5,
  a11y: 5,
  scheduling: 6,
  tracking: 7,
  resource: 7,
  export: 8,
  "data-sync": 8,
  portfolio: 8,
  i18n: 8,
  "perf-tools": 8,
});

// ---------------------------------------------------------------------------
// Service ID (without the "stargantt." prefix, which always appears in source)
// -> providing plugin directory (architecture.md chapter 4.1 / 5).
// ---------------------------------------------------------------------------
export const SERVICE_PROVIDER = Object.freeze({
  data: "data-store",
  fields: "data-store",
  view: "view",
  timeline: "view",
  theme: "view",
  rows: "tree-grid",
  grid: "tree-grid",
  "task-bars": "task-bars",
  selection: "interaction",
  snap: "interaction",
  filter: "interaction",
  history: "undo-redo",
  focus: "a11y",
  scheduler: "scheduling",
  calendars: "scheduling",
  "critical-path": "scheduling",
  baselines: "tracking",
  progress: "tracking",
  cost: "tracking",
  evm: "tracking",
  "resource-pool": "resource",
  utilization: "resource",
  export: "export",
  "data-sync": "data-sync",
  portfolio: "portfolio",
  dashboard: "portfolio",
  i18n: "i18n",
  "perf-tools": "perf-tools",
});

const SOURCE_EXT_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** @returns {string[]} absolute paths of source files under `dir`, recursively. */
function walkSourceFiles(dir) {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true, recursive: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!SOURCE_EXT_RE.test(entry.name)) continue;
    if (entry.name.endsWith(".d.ts")) continue;
    // `entry.parentPath` (Node >=20.13) falls back to `entry.path` on older 20.x.
    const parentPath = entry.parentPath ?? entry.path;
    files.push(path.join(parentPath, entry.name));
  }
  return files;
}

function relPath(root, absPath) {
  return path.relative(root, absPath).split(path.sep).join("/");
}

function lineOf(content, index) {
  return content.slice(0, index).split("\n").length;
}

/** Which plugin's src tree (relative to pluginsDir) does `filePath` live under? */
function pluginDirOf(pluginsDir, filePath) {
  const rel = path.relative(pluginsDir, filePath);
  if (rel.startsWith("..")) return null;
  return rel.split(path.sep)[0];
}

/**
 * Naive line/block comment stripper: replaces comment characters with spaces
 * (newlines preserved, so line numbers reported elsewhere stay correct) so
 * this lint's regex scans never match import/service/event patterns written
 * inside comments. See the "Implementation notes" header above for the
 * string-literal caveat.
 */
function stripComments(content) {
  let out = "";
  let i = 0;
  const n = content.length;
  while (i < n) {
    const two = content[i] + (content[i + 1] ?? "");
    if (two === "//") {
      while (i < n && content[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (two === "/*") {
      out += "  ";
      i += 2;
      while (i < n && content[i] + (content[i + 1] ?? "") !== "*/") {
        out += content[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    out += content[i];
    i++;
  }
  return out;
}

/**
 * Classify an import specifier relative to the file that contains it.
 * @returns {{ kind: "core" | "sdk" | "plugin", pluginDir?: string, layer: number } | null}
 *   null means "not a StarGantt internal target" (external package, or a
 *   relative import that stays inside the current plugin / doesn't resolve
 *   under packages/{core,sdk,plugins}).
 */
function classifySpecifier(dirs, specifier, fromFile) {
  if (specifier.startsWith("@stargantt/plugin-")) {
    const rest = specifier.slice("@stargantt/plugin-".length);
    const pluginDir = rest.split("/")[0];
    if (pluginDir in LAYER_MAP) {
      return { kind: "plugin", pluginDir, layer: LAYER_MAP[pluginDir] };
    }
    return null;
  }
  if (specifier === "@stargantt/core" || specifier.startsWith("@stargantt/core/")) {
    return { kind: "core", layer: 0 };
  }
  if (specifier === "@stargantt/sdk" || specifier.startsWith("@stargantt/sdk/")) {
    return { kind: "sdk", layer: 0 };
  }
  if (specifier.startsWith(".")) {
    const resolved = path.resolve(path.dirname(fromFile), specifier);
    const relFromPlugins = path.relative(dirs.pluginsDir, resolved);
    if (!relFromPlugins.startsWith("..")) {
      const pluginDir = relFromPlugins.split(path.sep)[0];
      if (pluginDir in LAYER_MAP) {
        return { kind: "plugin", pluginDir, layer: LAYER_MAP[pluginDir] };
      }
      return null;
    }
    const relFromCore = path.relative(dirs.coreDir, resolved);
    if (!relFromCore.startsWith("..")) return { kind: "core", layer: 0 };
    const relFromSdk = path.relative(dirs.sdkDir, resolved);
    if (!relFromSdk.startsWith("..")) return { kind: "sdk", layer: 0 };
    return null;
  }
  return null;
}

// Matches:
//   import X from "y"; import { a, b } from "y"; import type { X } from "y";
//   export { a } from "y"; export * from "y"; export * as ns from "y";
//   import "y";  (side-effect only)
//   import("y")  (dynamic)
const IMPORT_RE =
  /\b(?:import|export)\b[^'"`;]*?\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s+["']([^"']+)["']/g;

// Type-only imports/exports (`import type …` / `export type … from`) are
// exempt from the layer rule: they erase at compile time (no runtime edge)
// and are the sanctioned way to type an upward extension-point contribution
// (architecture.md chapter 5). Value imports remain layered.
const TYPE_ONLY_RE = /^\s*(?:import|export)\s+type\b/;

// ---------------------------------------------------------------------------
// Headless subtrees (check (e)).
//
// A plugin may declare that one of its src subtrees is HEADLESS: it may import
// nothing but the listed packages and its own files, TYPE-ONLY IMPORTS
// INCLUDED (the point is that the subtree can be exercised in plain Node
// without any UI concept in scope, which a type-only edge to a rendering
// plugin would already contradict). The subtree also may not reach back up out
// of itself with a relative import.
//
// Key: "<pluginDir>/<subtree path under the plugin root>".
// docs/specs/plugins/scheduling.md §13 — "The `engine/` subtree is headless: it
// imports only `@stargantt/plugin-data-store`, `@stargantt/sdk` and its own
// files … enforced in CI (the architecture lint's import scan)".
// ---------------------------------------------------------------------------
// docs/specs/plugins/resource.md §8 — "The `engine/` subtree is headless — no
// DOM, no service reference, no `internal/` import; enforced by the architecture
// lint's import scan so vitest targets it in plain Node".
export const HEADLESS_SUBTREES = Object.freeze({
  "scheduling/src/engine": Object.freeze(["@stargantt/plugin-data-store", "@stargantt/sdk"]),
  "resource/src/internal/engine": Object.freeze([
    "@stargantt/plugin-data-store",
    "@stargantt/sdk",
  ]),
});

/** The headless-subtree key covering `filePath`, or null. */
function headlessSubtreeOf(pluginsDir, filePath) {
  const rel = path.relative(pluginsDir, filePath).split(path.sep).join("/");
  for (const key of Object.keys(HEADLESS_SUBTREES)) {
    if (rel.startsWith(`${key}/`)) return key;
  }
  return null;
}

function scanHeadlessSubtree(root, pluginsDir, filePath, content, violations) {
  const key = headlessSubtreeOf(pluginsDir, filePath);
  if (key === null) return;
  const allowed = HEADLESS_SUBTREES[key];
  const subtreeRoot = path.join(pluginsDir, key);

  IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_RE.exec(content))) {
    const specifier = m[1] ?? m[2] ?? m[3];
    const line = lineOf(content, m.index);
    if (specifier.startsWith(".")) {
      const resolved = path.resolve(path.dirname(filePath), specifier);
      if (!path.relative(subtreeRoot, resolved).startsWith("..")) continue;
      violations.push(
        `${relPath(root, filePath)}:${line}: [headless] "${specifier}" leaves the headless ` +
          `subtree "${key}" — it may import only its own files and ${allowed.join(", ")}`,
      );
      continue;
    }
    if (allowed.includes(specifier)) continue;
    violations.push(
      `${relPath(root, filePath)}:${line}: [headless] "${specifier}" is not importable from the ` +
        `headless subtree "${key}" — allowed: ${allowed.join(", ")} (type-only imports included)`,
    );
  }
}

function scanImports(root, dirs, filePath, content, currentPluginDir, currentLayer, violations) {
  IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_RE.exec(content))) {
    if (TYPE_ONLY_RE.test(m[0])) continue;
    const specifier = m[1] ?? m[2] ?? m[3];
    const target = classifySpecifier(dirs, specifier, filePath);
    if (!target) continue;
    if (target.kind === "plugin" && target.pluginDir === currentPluginDir) continue;
    if (target.layer > currentLayer) {
      const line = lineOf(content, m.index);
      const targetName = target.kind === "plugin" ? target.pluginDir : target.kind;
      violations.push(
        `${relPath(root, filePath)}:${line}: [import] "${specifier}" targets layer ${target.layer} ` +
          `(${targetName}), but this file is in layer ${currentLayer} (${currentPluginDir}) — ` +
          `imports may only target the same plugin or a lower layer`,
      );
    }
  }
}

// Optional TypeScript generic-argument list attached to a call, e.g. `<XService>`
// or one level of nesting like `<Foo<Bar>>`. See the "Implementation notes"
// header above: two or more levels of nesting are not supported, which causes
// the whole call to be silently skipped rather than mismatched.
const GENERIC_ARGS = `(?:<(?:[^<>]|<[^<>]*>)*>)?`;

// Matches ctx.use(...) / ctx.useOptional(...) / ctx?.use(...) / ctx?.useOptional(...),
// with an optional generic type argument, e.g. ctx.use<XService>("stargantt.x").
// Captures only the call head; the argument itself is read via readFirstArg so
// dynamic (non-literal) service ids are also detected (as warnings).
const SERVICE_CALL_RE = new RegExp(`\\bctx\\??\\.(useOptional|use)\\s*${GENERIC_ARGS}\\s*\\(`, "g");

function scanServiceUse(root, filePath, content, currentPluginDir, currentLayer, violations, warnings) {
  SERVICE_CALL_RE.lastIndex = 0;
  let m;
  while ((m = SERVICE_CALL_RE.exec(content))) {
    const kind = m[1]; // "use" | "useOptional"
    const parenIndex = SERVICE_CALL_RE.lastIndex - 1;
    const arg = readFirstArg(content, parenIndex + 1);
    const line = lineOf(content, m.index);
    if (arg.literal === null) {
      warnings.push(
        `${relPath(root, filePath)}:${line}: [ctx.${kind}] service id is not a static string ` +
          `literal (dynamic id) — cannot check against the layer map, skipping (warning only)`,
      );
      continue;
    }
    const literal = arg.literal;
    if (!literal.startsWith("stargantt.")) continue;
    const serviceId = literal.slice("stargantt.".length);
    const providerDir = SERVICE_PROVIDER[serviceId];
    if (!providerDir) continue; // unknown service id: not this lint's concern
    if (providerDir === currentPluginDir) continue; // self-reference is fine
    const providerLayer = LAYER_MAP[providerDir];
    const isViolation =
      kind === "use" ? providerLayer >= currentLayer : providerLayer > currentLayer;
    if (isViolation) {
      const relation = providerLayer === currentLayer ? "same layer as" : "an upper layer than";
      violations.push(
        `${relPath(root, filePath)}:${line}: [ctx.${kind}] "${literal}" is provided by "${providerDir}" ` +
          `(layer ${providerLayer}), which is ${relation} this file's layer ${currentLayer} ` +
          `(${currentPluginDir}) — ${kind === "use" ? "ctx.use forbids same-layer and upper-layer references" : "ctx.useOptional forbids upper-layer references"}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Check (f) — service-lookup aliasing evasion.
//
// `scanServiceUse` above only recognizes the LITERAL call form
// `ctx.useOptional("stargantt.x")` / `ctx?.useOptional("stargantt.x")` — it reads
// the service id string out of the call's first argument. A plugin can defeat
// that scan entirely by first capturing the method (`.bind(ctx)`, or assigning
// `ctx.useOptional` to a variable) and only THEN calling the captured reference
// with the literal string one line later: the id is still a plain string
// literal at the actual call site, but it is no longer adjacent to `ctx.use`/
// `ctx.useOptional` in the source text, so the regex above never sees it.
//
// This happened for real (a same-layer, otherwise-legal `useOptional` call that
// a `.bind()` alias hid from this exact scanner) and is flagged unconditionally
// as a VIOLATION regardless of whether the underlying edge would itself be
// legal — hiding a service lookup from the architecture gate is never
// acceptable on its own terms, independent of the edge's own layer legality.
// The fix is always a plain, visible wrapper function that calls
// `ctx.useOptional(...)` (or `ctx.use(...)`) literally, with any necessary cast
// applied to the WRAPPER's own parameter type rather than to the
// `ctx.useOptional` member expression itself (see `tools/lint-deps.test.mjs`'s
// aliasing-evasion fixtures for the sanctioned visible-shim form).
//
// Two literal patterns, kept intentionally simple (regex, no AST, matching the
// rest of this file's implementation style):
//   - `.bind(` applied directly to a `.use`/`.useOptional` member expression
//     (`ctx.useOptional.bind(ctx)`, `ctx.useOptional?.bind(ctx)`).
//   - `ctx.use`/`ctx.useOptional` assigned to a variable with no immediate call
//     (`const lookup = ctx.useOptional;`) — the negative lookahead excludes the
//     ordinary, already-scanned call form `= ctx.useOptional(...)`.
// A cast on the member expression itself (`(ctx as X).useOptional(...)`) is
// deliberately NOT flagged here — narrowing `ctx`'s own type before an
// immediate literal call is not an aliasing evasion, and over-flagging it would
// push callers toward hiding the SAME cast one line away instead of removing
// it, which is the opposite of what this check is for.
// `\??\.?` covers both a plain `.bind(` and an optional-chained `?.bind(` right after the member
// expression (`ctx.useOptional.bind(ctx)` and `ctx.useOptional?.bind(ctx)` alike).
const BIND_ALIAS_RE = /\.(use|useOptional)\s*\??\.?\s*bind\s*\(/g;
// The negative lookahead admits both call forms: plain `(` and the generic `<T>(...)` form
// that scanServiceUse already supports — otherwise `const v = ctx.useOptional<ViewService>("x")`
// would be misread as an alias assignment.
const VARIABLE_ALIAS_RE = /=\s*ctx\??\.(use|useOptional)\b(?!\s*[(<])/g;

function scanAliasing(root, filePath, content, violations) {
  BIND_ALIAS_RE.lastIndex = 0;
  let m;
  while ((m = BIND_ALIAS_RE.exec(content))) {
    const line = lineOf(content, m.index);
    violations.push(
      `${relPath(root, filePath)}:${line}: [alias] "${m[0].trim()}" binds ctx.${m[1]} instead of ` +
        `calling it with a literal string directly — this hides the service id from the ` +
        `[ctx.${m[1]}] scan above; replace it with a plain wrapper function that calls ` +
        `ctx.${m[1]}("stargantt.x") literally (cast the wrapper's parameter, not this expression)`,
    );
  }
  VARIABLE_ALIAS_RE.lastIndex = 0;
  while ((m = VARIABLE_ALIAS_RE.exec(content))) {
    const line = lineOf(content, m.index);
    violations.push(
      `${relPath(root, filePath)}:${line}: [alias] assigns ctx.${m[1]} to a variable instead of ` +
        `calling it with a literal string directly — this hides the service id from the ` +
        `[ctx.${m[1]}] scan above; replace it with a plain wrapper function that calls ` +
        `ctx.${m[1]}("stargantt.x") literally (cast the wrapper's parameter, not this expression)`,
    );
  }
}

// Reads the first top-level argument starting at `start` (index right after the
// call's opening paren). Returns { text, literal } where `literal` is the
// unescaped string content if the argument is a plain string literal, or null
// if it's a dynamic expression (variable, template with interpolation, call,
// concatenation, etc.) — dynamic names cannot be statically checked.
function readFirstArg(content, start) {
  let i = start;
  while (i < content.length && /\s/.test(content[i])) i++;
  if (i >= content.length) return { text: "", literal: null };
  const startChar = content[i];
  if (startChar === '"' || startChar === "'" || startChar === "`") {
    const quote = startChar;
    let j = i + 1;
    let buf = "";
    let hasInterpolation = false;
    while (j < content.length && content[j] !== quote) {
      if (content[j] === "\\") {
        buf += content[j] + (content[j + 1] ?? "");
        j += 2;
        continue;
      }
      if (quote === "`" && content[j] === "$" && content[j + 1] === "{") {
        hasInterpolation = true;
      }
      buf += content[j];
      j++;
    }
    return { text: content.slice(i, j + 1), literal: hasInterpolation ? null : buf };
  }
  let depth = 0;
  let j = i;
  while (j < content.length) {
    const c = content[j];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) break;
      depth--;
    } else if (c === "," && depth === 0) break;
    j++;
  }
  return { text: content.slice(i, j), literal: null };
}

// Matches ctx.emit(...) / ctx.on(...) / ctx?.emit(...) / ctx?.on(...), with an
// optional generic type argument, e.g. ctx.emit<MyPayload>("x", payload).
const EMIT_ON_CALL_RE = new RegExp(`\\bctx\\??\\.(emit|on)\\s*${GENERIC_ARGS}\\s*\\(`, "g");

function scanEvents(root, filePath, content, violations, warnings) {
  EMIT_ON_CALL_RE.lastIndex = 0;
  let m;
  while ((m = EMIT_ON_CALL_RE.exec(content))) {
    const method = m[1]; // "emit" | "on"
    const parenIndex = EMIT_ON_CALL_RE.lastIndex - 1;
    const arg = readFirstArg(content, parenIndex + 1);
    const line = lineOf(content, m.index);
    if (arg.literal === null) {
      warnings.push(
        `${relPath(root, filePath)}:${line}: [ctx.${method}] event name is not a static string literal ` +
          `(dynamic name) — cannot check against the official catalog, skipping (warning only)`,
      );
      continue;
    }
    if (!OFFICIAL_EVENTS.includes(arg.literal)) {
      violations.push(
        `${relPath(root, filePath)}:${line}: [ctx.${method}] event "${arg.literal}" is not in the ` +
          `official event catalog (tools/official-events.mjs) — likely migration residue ` +
          `(e.g. an abolished "*/changed" event) or a missing catalog entry`,
      );
    }
  }
}

/**
 * Compares the actual packages/plugins/* directory set against LAYER_MAP's
 * key set in both directions, pushing a violation for each mismatch.
 * @returns {string[]} the plugin directory names that both exist on disk and
 *   have a LAYER_MAP entry — i.e. the set that's safe to scan further.
 */
function checkDirectorySet(root, pluginsDir, violations) {
  const actualDirs = existsSync(pluginsDir)
    ? readdirSync(pluginsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    : [];
  const mapKeys = Object.keys(LAYER_MAP);
  const actualSet = new Set(actualDirs);
  const mapSet = new Set(mapKeys);

  for (const dir of actualDirs) {
    if (!mapSet.has(dir)) {
      violations.push(
        `${relPath(root, path.join(pluginsDir, dir))}: [layer-map] directory has no LAYER_MAP ` +
          `entry in tools/lint-deps.mjs — add it to LAYER_MAP, or delete the directory if it's stale`,
      );
    }
  }
  for (const key of mapKeys) {
    if (!actualSet.has(key)) {
      violations.push(
        `tools/lint-deps.mjs: [layer-map] LAYER_MAP entry "${key}" has no corresponding ` +
          `packages/plugins/${key} directory — remove the stale entry or restore the directory`,
      );
    }
  }

  return actualDirs.filter((d) => mapSet.has(d));
}

/**
 * Runs every check against `root` (an absolute path to a repo root — the real
 * repo root in production, or a fixture temp directory in tests) and returns
 * the collected violations/warnings without any I/O side effects beyond
 * reading files under `root`.
 */
export function lintRepo(root) {
  const pluginsDir = path.join(root, "packages", "plugins");
  const dirs = {
    pluginsDir,
    coreDir: path.join(root, "packages", "core"),
    sdkDir: path.join(root, "packages", "sdk"),
  };
  const violations = [];
  const warnings = [];

  const scannablePluginDirs = checkDirectorySet(root, pluginsDir, violations);

  for (const pluginDir of scannablePluginDirs) {
    const srcDir = path.join(pluginsDir, pluginDir, "src");
    const currentLayer = LAYER_MAP[pluginDir];
    for (const filePath of walkSourceFiles(srcDir)) {
      const rawContent = readFileSync(filePath, "utf8");
      const content = stripComments(rawContent);
      const owningPluginDir = pluginDirOf(pluginsDir, filePath) ?? pluginDir;
      scanImports(root, dirs, filePath, content, owningPluginDir, currentLayer, violations);
      scanHeadlessSubtree(root, pluginsDir, filePath, content, violations);
      scanServiceUse(root, filePath, content, owningPluginDir, currentLayer, violations, warnings);
      scanAliasing(root, filePath, content, violations);
      scanEvents(root, filePath, content, violations, warnings);
    }
  }

  return { violations, warnings, scannedPluginCount: scannablePluginDirs.length };
}

function main() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(__dirname, "..");
  const { violations, warnings, scannedPluginCount } = lintRepo(root);

  for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
  for (const v of violations) process.stderr.write(`${v}\n`);

  if (violations.length > 0) {
    process.stderr.write(
      `lint-deps: ${violations.length} violation(s), ${warnings.length} warning(s)\n`,
    );
    process.exit(1);
  }

  process.stdout.write(
    `lint-deps: OK (0 violations, ${warnings.length} warning(s), ` +
      `${scannedPluginCount} plugin dir(s) scanned)\n`,
  );
  process.exit(0);
}

const isMainModule =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  main();
}
