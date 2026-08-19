/**
 * The package manifest of `@stargantt/plugin-resource`.
 *
 * The plugin value-imports `@stargantt/core` (`definePlugin`) and `@stargantt/sdk` (`sdk/time`,
 * `sdk/dom`'s `resolveCatalog`), so both are runtime `dependencies`. Every sibling plugin edge is
 * `import type`, erased at emit, and belongs in `devDependencies`.
 *
 * A missing manifest entry costs nothing at runtime for a type-only edge but it costs the build:
 * on a fresh clone, `pnpm install` links only what the manifest names, and `tsc` then cannot
 * resolve the undeclared packages.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");

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
  it("is the resource plugin's manifest", () => {
    expect(manifest.name).toBe("@stargantt/plugin-resource");
  });

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

  it("keeps the runtime dependency set to the kernel and the SDK", () => {
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      "@stargantt/core",
      "@stargantt/sdk",
    ]);
    for (const dep of Object.values(manifest.dependencies ?? {})) {
      expect(dep).toBe("workspace:*");
    }
  });

  it("keeps every type-only sibling edge out of `dependencies`", () => {
    const dev = Object.keys(manifest.devDependencies ?? {});
    expect(dev).toContain("@stargantt/plugin-data-store");
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain("@stargantt/plugin-data-store");
  });

  it("declares the kernel as a plain dependency, not a peer dependency", () => {
    expect(manifest.peerDependencies).toBeUndefined();
    expect(Object.keys(manifest.devDependencies ?? {})).not.toContain("@stargantt/core");
  });
});
