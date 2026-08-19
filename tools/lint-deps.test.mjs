// tools/lint-deps.test.mjs
//
// Unit tests for tools/lint-deps.mjs, exercised via the exported `lintRepo(root)`
// function against disposable fixture directories (temp dirs mimicking the real
// packages/plugins/<dir>/src/ layout), rather than a subprocess or mutating the
// real repo tree — this keeps tests isolated from concurrent work elsewhere in
// this shared monorepo and avoids writing into real plugin source directories.
//
// `createFixtureRoot` seeds an empty `src/` for every LAYER_MAP-known plugin
// directory by default, so the directory/LAYER_MAP consistency check (see
// lint-deps.mjs's checkDirectorySet) produces zero incidental violations and
// each scenario test can assert on exactly the violation(s) it set up.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { lintRepo, LAYER_MAP } from "./lint-deps.mjs";

let tempRoots = [];

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  tempRoots = [];
});

function createFixtureRoot({ skipDirs = [], extraDirs = [] } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "lint-deps-test-"));
  tempRoots.push(root);
  const pluginsDir = path.join(root, "packages", "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  for (const dir of Object.keys(LAYER_MAP)) {
    if (skipDirs.includes(dir)) continue;
    mkdirSync(path.join(pluginsDir, dir, "src"), { recursive: true });
  }
  for (const dir of extraDirs) {
    mkdirSync(path.join(pluginsDir, dir, "src"), { recursive: true });
  }
  return root;
}

function writeSource(root, pluginDir, fileName, content) {
  const filePath = path.join(root, "packages", "plugins", pluginDir, "src", fileName);
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

describe("lintRepo", () => {
  it("detects an import that targets a strictly higher layer", () => {
    const root = createFixtureRoot();
    // data-store is layer 1; scheduling is layer 5.
    writeSource(
      root,
      "data-store",
      "index.ts",
      `import { something } from "@stargantt/plugin-scheduling";\nexport const x = something;\n`,
    );
    const { violations } = lintRepo(root);
    expect(violations.some((v) => v.includes("[import]") && v.includes("scheduling"))).toBe(true);
  });

  it("detects an off-catalog event emitted via ctx.emit<T>(...) (generic type arg)", () => {
    const root = createFixtureRoot();
    writeSource(
      root,
      "view",
      "index.ts",
      `export function trigger(ctx) {\n  ctx.emit<{ foo: number }>("theme/changed", { foo: 1 });\n}\n`,
    );
    const { violations } = lintRepo(root);
    expect(
      violations.some((v) => v.includes("[ctx.emit]") && v.includes("theme/changed")),
    ).toBe(true);
  });

  it("detects an off-catalog event emitted via one level of nested generics", () => {
    const root = createFixtureRoot();
    writeSource(
      root,
      "view",
      "index.ts",
      `export function trigger(ctx) {\n  ctx.emit<Foo<Bar>>("theme/changed", {});\n}\n`,
    );
    const { violations } = lintRepo(root);
    expect(
      violations.some((v) => v.includes("[ctx.emit]") && v.includes("theme/changed")),
    ).toBe(true);
  });

  it("detects an off-catalog event emitted via optional chaining ctx?.emit(...)", () => {
    const root = createFixtureRoot();
    writeSource(
      root,
      "view",
      "index.ts",
      `export function trigger(ctx) {\n  ctx?.emit("theme/changed", {});\n}\n`,
    );
    const { violations } = lintRepo(root);
    expect(
      violations.some((v) => v.includes("[ctx.emit]") && v.includes("theme/changed")),
    ).toBe(true);
  });

  it("does not flag import/service/event patterns written inside comments", () => {
    const root = createFixtureRoot();
    writeSource(
      root,
      "view",
      "index.ts",
      [
        `// ctx.emit("theme/changed", {});`,
        `/* ctx.use("stargantt.scheduler"); import { x } from "@stargantt/plugin-scheduling"; */`,
        `export {};`,
        ``,
      ].join("\n"),
    );
    const { violations, warnings } = lintRepo(root);
    expect(violations).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("flags packages/plugins directory / LAYER_MAP mismatches in both directions", () => {
    const root = createFixtureRoot({ skipDirs: ["i18n"], extraDirs: ["mystery-plugin"] });
    const { violations } = lintRepo(root);
    expect(
      violations.some((v) => v.includes("[layer-map]") && v.includes("mystery-plugin")),
    ).toBe(true);
    expect(violations.some((v) => v.includes("[layer-map]") && v.includes('"i18n"'))).toBe(true);
  });

  it("flags a hard ctx.use referencing a same-layer plugin's service", () => {
    const root = createFixtureRoot();
    // tracking and resource are both layer 6.
    writeSource(
      root,
      "tracking",
      "index.ts",
      `export function setup(ctx) {\n  return ctx.use("stargantt.resource-pool");\n}\n`,
    );
    const { violations } = lintRepo(root);
    expect(
      violations.some((v) => v.includes("[ctx.use]") && v.includes("stargantt.resource-pool")),
    ).toBe(true);
  });

  it("allows the same same-layer reference via ctx.useOptional", () => {
    const root = createFixtureRoot();
    writeSource(
      root,
      "tracking",
      "index.ts",
      `export function setup(ctx) {\n  return ctx.useOptional("stargantt.resource-pool");\n}\n`,
    );
    const { violations } = lintRepo(root);
    expect(violations).toEqual([]);
  });

  it("warns (without failing) on a dynamic ctx.use service id", () => {
    const root = createFixtureRoot();
    writeSource(
      root,
      "tree-grid",
      "index.ts",
      `export function setup(ctx, SERVICE_ID) {\n  return ctx.use(SERVICE_ID);\n}\n`,
    );
    const { violations, warnings } = lintRepo(root);
    expect(violations).toEqual([]);
    expect(
      warnings.some((w) => w.includes("[ctx.use]") && w.includes("dynamic id")),
    ).toBe(true);
  });

  // Check (e) — headless subtrees (docs/specs/plugins/scheduling.md §13).
  it("detects a package import a headless subtree may not name", () => {
    const root = createFixtureRoot();
    mkdirSync(path.join(root, "packages", "plugins", "scheduling", "src", "engine"), {
      recursive: true,
    });
    writeSource(
      root,
      "scheduling",
      "engine/engine.ts",
      `import { paint } from "@stargantt/plugin-view";\nexport const x = paint;\n`,
    );
    const { violations } = lintRepo(root);
    expect(
      violations.some((v) => v.includes("[headless]") && v.includes("@stargantt/plugin-view")),
    ).toBe(true);
  });

  it("detects a type-only import a headless subtree may not name either", () => {
    const root = createFixtureRoot();
    mkdirSync(path.join(root, "packages", "plugins", "scheduling", "src", "engine"), {
      recursive: true,
    });
    writeSource(
      root,
      "scheduling",
      "engine/engine.ts",
      `import type { Renderer } from "@stargantt/plugin-view";\nexport type R = Renderer;\n`,
    );
    const { violations } = lintRepo(root);
    expect(violations.some((v) => v.includes("[headless]"))).toBe(true);
  });

  it("detects a relative import that leaves the headless subtree", () => {
    const root = createFixtureRoot();
    mkdirSync(path.join(root, "packages", "plugins", "scheduling", "src", "engine"), {
      recursive: true,
    });
    writeSource(
      root,
      "scheduling",
      "engine/engine.ts",
      `import { wire } from "../internal/links/wire";\nexport const x = wire;\n`,
    );
    const { violations } = lintRepo(root);
    expect(
      violations.some((v) => v.includes("[headless]") && v.includes("leaves the headless")),
    ).toBe(true);
  });

  it("accepts the headless subtree's own files and its allowed packages", () => {
    const root = createFixtureRoot();
    mkdirSync(path.join(root, "packages", "plugins", "scheduling", "src", "engine"), {
      recursive: true,
    });
    writeSource(
      root,
      "scheduling",
      "engine/engine.ts",
      `import type { Task } from "@stargantt/plugin-data-store";\n` +
        `import { MS_DAY } from "@stargantt/sdk";\n` +
        `import { topoOrder } from "./graph";\n` +
        `export const x = [MS_DAY, topoOrder];\nexport type T = Task;\n`,
    );
    const { violations } = lintRepo(root);
    expect(violations).toEqual([]);
  });

  // Check (e) for the resource plugin's own headless subtree
  // (docs/specs/plugins/resource.md §8 — `internal/engine/`).
  it("guards the resource plugin's internal/engine subtree on the same terms", () => {
    const root = createFixtureRoot();
    const engineDir = path.join(
      root,
      "packages",
      "plugins",
      "resource",
      "src",
      "internal",
      "engine",
    );
    mkdirSync(engineDir, { recursive: true });
    writeSource(
      root,
      "resource",
      "internal/engine/compute.ts",
      `import type { Resource } from "@stargantt/plugin-data-store";\n` +
        `import { MS_DAY } from "@stargantt/sdk";\n` +
        `import { bucketsInRange } from "./buckets";\n` +
        `export const x = [MS_DAY, bucketsInRange];\nexport type R = Resource;\n`,
    );
    expect(lintRepo(root).violations).toEqual([]);

    // A sibling AREA is out of bounds: the engine may not reach back up into `internal/`.
    writeSource(
      root,
      "resource",
      "internal/engine/leak.ts",
      `import { wirePool } from "../pool/wire";\nexport const y = wirePool;\n`,
    );
    expect(
      lintRepo(root).violations.some(
        (v) => v.includes("[headless]") && v.includes("leaves the headless"),
      ),
    ).toBe(true);
  });

  it("rejects a view import from the resource engine, type-only included", () => {
    const root = createFixtureRoot();
    mkdirSync(
      path.join(root, "packages", "plugins", "resource", "src", "internal", "engine"),
      { recursive: true },
    );
    writeSource(
      root,
      "resource",
      "internal/engine/compute.ts",
      `import type { ViewService } from "@stargantt/plugin-view";\nexport type V = ViewService;\n`,
    );
    expect(
      lintRepo(root).violations.some(
        (v) => v.includes("[headless]") && v.includes("@stargantt/plugin-view"),
      ),
    ).toBe(true);
  });

  // Check (f) — service-lookup aliasing evasion.
  it("flags .bind() applied to a ctx.useOptional member expression", () => {
    const root = createFixtureRoot();
    writeSource(
      root,
      "tracking",
      "index.ts",
      `export function setup(ctx) {\n` +
        `  const lookup = ctx.useOptional.bind(ctx);\n` +
        `  return lookup("stargantt.resource-pool");\n` +
        `}\n`,
    );
    const { violations } = lintRepo(root);
    expect(violations.some((v) => v.includes("[alias]") && v.includes("bind"))).toBe(true);
  });

  it("flags .bind() applied via optional chaining (ctx.useOptional?.bind(ctx))", () => {
    const root = createFixtureRoot();
    writeSource(
      root,
      "tracking",
      "index.ts",
      `export function setup(ctx) {\n` +
        `  const lookup = ctx.useOptional?.bind(ctx);\n` +
        `  return lookup?.("stargantt.resource-pool");\n` +
        `}\n`,
    );
    const { violations } = lintRepo(root);
    expect(violations.some((v) => v.includes("[alias]") && v.includes("bind"))).toBe(true);
  });

  it("flags .bind() applied to a hard ctx.use member expression", () => {
    const root = createFixtureRoot();
    writeSource(
      root,
      "tracking",
      "index.ts",
      `export function setup(ctx) {\n` +
        `  const lookup = ctx.use.bind(ctx);\n` +
        `  return lookup("stargantt.data");\n` +
        `}\n`,
    );
    const { violations } = lintRepo(root);
    expect(violations.some((v) => v.includes("[alias]") && v.includes("bind"))).toBe(true);
  });

  it("flags a bare variable assignment of ctx.useOptional with no immediate call", () => {
    const root = createFixtureRoot();
    writeSource(
      root,
      "tracking",
      "index.ts",
      `export function setup(ctx) {\n` +
        `  const lookup = ctx.useOptional;\n` +
        `  return lookup("stargantt.resource-pool");\n` +
        `}\n`,
    );
    const { violations } = lintRepo(root);
    expect(
      violations.some((v) => v.includes("[alias]") && v.includes("assigns ctx.useOptional")),
    ).toBe(true);
  });

  it("does not flag the ordinary, already-scanned literal call form (= ctx.useOptional(...))", () => {
    const root = createFixtureRoot();
    writeSource(
      root,
      "tracking",
      "index.ts",
      `export function setup(ctx) {\n` +
        `  const result = ctx.useOptional("stargantt.resource-pool");\n` +
        `  return result;\n` +
        `}\n`,
    );
    const { violations } = lintRepo(root);
    expect(violations.filter((v) => v.includes("[alias]"))).toEqual([]);
  });

  it("does not flag the generic call form (= ctx.useOptional<T>(...)) — scanServiceUse's own supported syntax", () => {
    const root = createFixtureRoot();
    writeSource(
      root,
      "tracking",
      "index.ts",
      `export function setup(ctx) {\n` +
        `  const view = ctx.useOptional<ViewService>("stargantt.view");\n` +
        `  return view;\n` +
        `}\n`,
    );
    const { violations } = lintRepo(root);
    expect(violations.filter((v) => v.includes("[alias]"))).toEqual([]);
  });

  it("accepts the sanctioned visible-shim form: a wrapper calling ctx.useOptional literally", () => {
    const root = createFixtureRoot();
    writeSource(
      root,
      "tracking",
      "index.ts",
      `function lookupResourcePool(ctx) {\n` +
        `  return ctx.useOptional("stargantt.resource-pool");\n` +
        `}\n` +
        `export function setup(ctx) {\n` +
        `  return lookupResourcePool(ctx);\n` +
        `}\n`,
    );
    const { violations } = lintRepo(root);
    expect(violations).toEqual([]);
  });

  it("does not flag a cast applied to ctx itself ahead of an immediate literal call", () => {
    const root = createFixtureRoot();
    writeSource(
      root,
      "tracking",
      "index.ts",
      `export function setup(ctx) {\n` +
        `  return (ctx as unknown as { useOptional(key: string): unknown }).useOptional(` +
        `"stargantt.resource-pool");\n` +
        `}\n`,
    );
    const { violations } = lintRepo(root);
    expect(violations.filter((v) => v.includes("[alias]"))).toEqual([]);
  });

  it("reports a clean fixture as violation- and warning-free", () => {
    const root = createFixtureRoot();
    writeSource(root, "data-store", "index.ts", `export {};\n`);
    const { violations, warnings } = lintRepo(root);
    expect(violations).toEqual([]);
    expect(warnings).toEqual([]);
  });
});
