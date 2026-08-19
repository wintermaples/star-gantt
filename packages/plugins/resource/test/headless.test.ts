/**
 * The headless demonstration, the mechanical `dependsOn` ⇄ `ctx.use` check and
 * the engine subtree's import purity (docs/specs/plugins/resource.md §8 / §9).
 *
 * §9: `data` (L1) is the only hard edge; every chart-surface edge is optional with inert
 * degradation, so `dataStore() + resource()` must boot with no `element`, no view plugin and no
 * DOM at all. §8: `internal/engine/` is headless — no DOM, no service reference, no `internal/`
 * import — which is what lets vitest target it in plain Node, and what the architecture lint's
 * `HEADLESS_SUBTREES` entry enforces repo-wide.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHost, expectDepsConsistency } from "@stargantt/sdk";
import { dataStore } from "@stargantt/plugin-data-store";
import { describe, expect, it } from "vitest";
import { resource } from "../src/index";
import { computeUtilization } from "../src/internal/engine/compute";
import { MS_DAY, engineResource } from "./_engine";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");
const MONDAY = Date.UTC(2024, 0, 1);

describe("headless composition (no DOM, no view)", () => {
  it("boots under a bare createTestHost with only the data store beside it", () => {
    // No `element` is passed: the harness boots headless, so nothing a layout query would see can
    // exist. No view / tree-grid / task-bars plugin is composed either.
    const harness = createTestHost({ plugins: [dataStore(), resource()] });
    try {
      expect(() => harness.ctxOf("stargantt.resource")).not.toThrow();
    } finally {
      harness.dispose();
    }
  });

  it("boots with every nest passed, all of them dormant of any chart surface", () => {
    const harness = createTestHost({
      plugins: [
        dataStore(),
        resource({
          pool: {},
          assign: {},
          view: {},
          utilization: {},
          loadChart: {},
        }),
      ],
    });
    expect(() => harness.ctxOf("stargantt.resource")).not.toThrow();
    harness.dispose();
  });

  it("aggregates in plain Node, with no host at all", () => {
    const matrix = computeUtilization({
      resources: [engineResource({ id: "r", name: "Ada" })],
      demands: new Map([["r", [{ start: MONDAY, end: MONDAY + 5 * MS_DAY, units: 1 }]]]),
      start: MONDAY,
      end: MONDAY + 7 * MS_DAY,
      bucket: "week",
      edges: "clamped",
      weekStartDay: 1,
    });
    expect(matrix.rows[0]!.cells[0]).toMatchObject({
      allocated: 5 * MS_DAY,
      capacity: 5 * MS_DAY,
      ratio: 1,
      overallocated: false,
    });
  });
});

describe("declared dependencies", () => {
  it("match the plugin's non-optional ctx.use() calls exactly", () => {
    expectDepsConsistency(resource(), { "stargantt.data": "stargantt.data-store" });
  });

  it("match with EVERY nest enabled too — a bare resource() boot cannot see a ctx.use() bug hiding behind a nest guard", () => {
    // §6 — `assign`/`view`'s `wire*` functions return before touching a single service call when
    // their own nest is `undefined`; `resource()` with no config leaves every nest `undefined`, so
    // `expectDepsConsistency(resource())` above never actually executes their bodies at all. Only
    // `utilization`/`load-chart`'s pool lookups run unconditionally (§6: the two services stay
    // provided regardless), so a bare boot happened to catch those two but not `assign`/`view` —
    // exactly the false-green this test closes. Every nest present exercises every area's body.
    expectDepsConsistency(
      resource({ pool: {}, assign: {}, view: {}, utilization: {}, loadChart: {} }),
      { "stargantt.data": "stargantt.data-store" },
    );
  });

  it("declares data-store as its only hard edge, the chart providers optional (§9)", () => {
    const meta = resource().meta;
    expect(meta.id).toBe("stargantt.resource");
    expect(meta.dependsOn).toEqual(["stargantt.data-store"]);
    expect(meta.optional).toEqual([
      "stargantt.view",
      "stargantt.tree-grid",
      "stargantt.task-bars",
      "stargantt.interaction",
      "stargantt.export",
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * The engine subtree's import purity (§8)
 * ------------------------------------------------------------------ */

/** Every module specifier a TypeScript source file can name. */
const MODULE_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(["'])([^"'\n]*)\1/g;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("internal/engine/ view-independence", () => {
  const files = sourceFiles(resolve(PACKAGE_ROOT, "src/internal/engine"));

  it("covers the six engine modules the spec's file plan names", () => {
    expect(files.map((f) => f.slice(f.lastIndexOf("/") + 1)).sort()).toEqual([
      "buckets.ts",
      "compute.ts",
      "memo.ts",
      "range.ts",
      "rollups.ts",
      "working-time.ts",
    ]);
  });

  it("imports only the data store, the SDK and its own files", () => {
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(MODULE_SPECIFIER)) {
        const specifier = match[2];
        if (specifier === undefined) continue;
        if (specifier.startsWith(".")) {
          // A relative import must stay inside `engine/`: no `../pool/…`, no `../../types`.
          expect(specifier.startsWith("../"), `${file} imports ${specifier}`).toBe(false);
          continue;
        }
        expect(["@stargantt/plugin-data-store", "@stargantt/sdk"], `${file}`).toContain(specifier);
      }
    }
  });

  it("names no DOM global", () => {
    // A blunt but effective guard: the engine must not reference the document, the window or a
    // rendering surface, directly or through a type annotation. Comments are stripped first —
    // "working-time window" is this module's own domain vocabulary, not a global.
    const forbidden =
      /\b(document|window|HTMLElement|CanvasRenderingContext2D|requestAnimationFrame)\b/;
    const COMMENTS = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
    for (const file of files) {
      const code = readFileSync(file, "utf8").replace(COMMENTS, "");
      expect(forbidden.test(code), `${file}`).toBe(false);
    }
  });

  it("keeps every engine file inside the 800-line ceiling (§8)", () => {
    for (const file of files) {
      expect(readFileSync(file, "utf8").split("\n").length, `${file}`).toBeLessThanOrEqual(800);
    }
  });
});
