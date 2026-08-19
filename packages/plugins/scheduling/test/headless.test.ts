/**
 * The headless demonstration and the mechanical `dependsOn` ⇄ `ctx.use` check.
 *
 * docs/specs/plugins/scheduling.md §2 / §13: the engine is headless — pure functions over a
 * `ReadonlyDataView`, unit-testable in plain Node — and `engine/` imports only
 * `@stargantt/plugin-data-store`, `@stargantt/sdk` and its own files. The cases below boot a REAL
 * core through `sdk/testing`'s `createTestHost` with no `element`, no view plugin, no renderer and
 * no DOM at all, and drive the whole propagation pipeline through it.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHost, expectDepsConsistency } from "@stargantt/sdk";
import { dataStore } from "@stargantt/plugin-data-store";
import type { DataService } from "@stargantt/plugin-data-store";
import { describe, expect, it } from "vitest";
import { scheduling } from "../src/index";
import { DAY, task } from "./_helpers";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");

describe("headless composition (no DOM, no view)", () => {
  it("propagates, reschedules and refuses cycles under a bare createTestHost", () => {
    // No `element` is passed: the harness boots headless, so nothing a layout query would see can
    // exist. No view / tree-grid / task-bars plugin is composed either.
    const harness = createTestHost({
      plugins: [dataStore(), scheduling({ autoSchedule: { enabled: true } })],
    });
    try {
      const host = harness.host;
      const data = host.service("stargantt.data") as DataService;
      data.load({
        tasks: [task("a", 0, DAY), task("b", DAY, 2 * DAY), task("c", 2 * DAY, 3 * DAY)],
        links: [
          { id: "L1", sourceId: "a", targetId: "b", type: "FS" },
          { id: "L2", sourceId: "b", targetId: "c", type: "FS" },
        ],
      });

      // 1. Forward propagation through the will hook.
      host.dispatch("task/move", { id: "a", start: 5 * DAY, end: 6 * DAY });
      expect(data.getTask("b")).toMatchObject({ start: 6 * DAY, end: 7 * DAY });
      expect(data.getTask("c")).toMatchObject({ start: 7 * DAY, end: 8 * DAY });

      // 2. The published service answers over the live view.
      const scheduler = host.service("stargantt.scheduler");
      expect(scheduler.propagationEnabled()).toBe(true);
      expect(scheduler.taskScheduleMode("a")).toBe("auto");
      expect(scheduler.latestTimes(data.query()).get("c")).toEqual({
        latestStart: 7 * DAY,
        latestFinish: 8 * DAY,
      });

      // 3. The status-date reschedule, one transaction, no UI in sight.
      host.dispatch("schedule/reschedule", { statusDate: 20 * DAY });
      expect(data.getTask("a")).toMatchObject({ start: 20 * DAY, end: 21 * DAY });

      // 4. Cycle rejection.
      const chains: string[][] = [];
      host.on("schedule/cycleRejected", (e) => chains.push(e.chain.map(String)));
      host.dispatch("link/add", { id: "back", sourceId: "c", targetId: "a", type: "FS" });
      expect(chains).toEqual([["back", "L1", "L2"]]);
    } finally {
      harness.dispose();
    }
  });

  it("registers the two snap contributions even with no interaction plugin composed", () => {
    // The core buffers a contribution to a point nobody has defined yet; composing scheduling alone
    // must therefore neither throw nor need interaction present.
    const harness = createTestHost({ plugins: [dataStore(), scheduling()] });
    expect(() => harness.ctxOf("stargantt.scheduling")).not.toThrow();
    harness.dispose();
  });
});

describe("declared dependencies", () => {
  it("match the plugin's non-optional ctx.use() calls exactly", () => {
    expectDepsConsistency(scheduling(), { "stargantt.data": "stargantt.data-store" });
  });
});

/* ------------------------------------------------------------------ *
 * The engine subtree's import purity (§13)
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

describe("engine/ view-independence", () => {
  const files = sourceFiles(resolve(PACKAGE_ROOT, "src/engine"));

  it("covers the twelve engine modules the spec's file plan names", () => {
    expect(files.map((f) => f.slice(f.lastIndexOf("/") + 1)).sort()).toEqual([
      "constraints.ts",
      "effort.ts",
      "engine.ts",
      "graph.ts",
      "links.ts",
      "modes.ts",
      "projection.ts",
      "reschedule.ts",
      "seeds.ts",
      "service.ts",
      "topo-cache.ts",
      "types.ts",
    ]);
  });

  it("imports only the data store, the SDK and its own files", () => {
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(MODULE_SPECIFIER)) {
        const specifier = match[2];
        if (specifier === undefined) continue;
        if (specifier.startsWith(".")) {
          // A relative import must stay inside `engine/`: no `../internal/…`, no `../types`.
          expect(specifier.startsWith("../"), `${file} imports ${specifier}`).toBe(false);
          continue;
        }
        expect(["@stargantt/plugin-data-store", "@stargantt/sdk"], `${file}`).toContain(specifier);
      }
    }
  });

  it("names no DOM global", () => {
    // A blunt but effective guard: the engine must not reference the document, the window or a
    // rendering surface, directly or through a type annotation.
    const forbidden = /\b(document|window|HTMLElement|CanvasRenderingContext2D|requestAnimationFrame)\b/;
    for (const file of files) {
      expect(forbidden.test(readFileSync(file, "utf8")), `${file}`).toBe(false);
    }
  });
});
