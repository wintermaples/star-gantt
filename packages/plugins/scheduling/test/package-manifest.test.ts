/**
 * The package manifest of `@stargantt/plugin-scheduling`.
 *
 * The plugin value-imports `@stargantt/core` (`definePlugin`, `first`, `createStore`),
 * `@stargantt/sdk` (`sdk/time`, `resolveCatalog`) and `@stargantt/plugin-data-store` (the store's
 * own `mergeTaskUpdate`, which the per-transaction projection replays rather than re-implementing),
 * so all three are runtime `dependencies`. Every other sibling import is `import type`, erased at
 * emit, and belongs in `devDependencies`.
 *
 * A missing manifest entry costs nothing at runtime for a type-only edge but it costs the build: on
 * a fresh clone, `pnpm install` links only what the manifest names, and `tsc` then cannot resolve
 * the undeclared packages. A workspace that happens to have stale links in `node_modules` hides
 * this completely, which is why it is asserted from the manifest rather than from a build.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");

/**
 * The module specifier of every import form a TypeScript source file can use: `from "…"` (named,
 * default, namespace, type-only and `export … from`), a bare `import "…"`, a dynamic `import("…")`
 * and a `require("…")`. An `import type` counts too — it still has to resolve at build time.
 */
const MODULE_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(["'])([^"'\n]*)\1/g;

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const manifest = JSON.parse(
  readFileSync(resolve(PACKAGE_ROOT, "package.json"), "utf8"),
) as Manifest;

/** Every `.ts` file under the given directories. */
function sourceFiles(dirs: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) out.push(full);
    }
  };
  for (const dir of dirs) walk(resolve(PACKAGE_ROOT, dir));
  return out;
}

/** The `@stargantt/*` packages the given files import, by any import form, minus this package. */
function importedWorkspacePackages(files: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(MODULE_SPECIFIER)) {
      const specifier = match[2];
      if (specifier === undefined) continue;
      if (!specifier.startsWith("@stargantt/")) continue;
      if (specifier === manifest.name) continue;
      found.add(specifier);
    }
  }
  return found;
}

const declared = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.devDependencies ?? {}),
]);

describe("package.json", () => {
  it("declares every workspace package the plugin's source imports", () => {
    for (const pkg of importedWorkspacePackages(sourceFiles(["src"]))) {
      expect(declared, `${pkg} is imported by src/ but not declared`).toContain(pkg);
    }
  });

  it("declares every workspace package the plugin's tests import", () => {
    for (const pkg of importedWorkspacePackages(sourceFiles(["test"]))) {
      expect(declared, `${pkg} is imported by test/ but not declared`).toContain(pkg);
    }
  });

  it("keeps the runtime dependency set to the kernel, the SDK and the data store", () => {
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      "@stargantt/core",
      "@stargantt/plugin-data-store",
      "@stargantt/sdk",
    ]);
    for (const dep of Object.values(manifest.dependencies ?? {})) {
      expect(dep).toBe("workspace:*");
    }
  });

  it("keeps every type-only sibling edge out of `dependencies`", () => {
    const dev = Object.keys(manifest.devDependencies ?? {});
    expect(dev).toContain("@stargantt/plugin-tree-grid");
    expect(dev).toContain("@stargantt/plugin-interaction");
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain("@stargantt/plugin-tree-grid");
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain("@stargantt/plugin-interaction");
  });

  it("declares the kernel as a plain dependency, not a peer dependency", () => {
    expect(manifest.peerDependencies).toBeUndefined();
    expect(Object.keys(manifest.devDependencies ?? {})).not.toContain("@stargantt/core");
  });
});
