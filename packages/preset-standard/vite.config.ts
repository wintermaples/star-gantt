import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

// The preset is a thin composition package: every `@stargantt/*` package it calls stays
// external, so a consumer (and the `stargantt` bundle) links one copy of each plugin rather than
// a copy inlined here plus their own.
//
// The externals are read from this package's own manifest instead of being listed again by hand:
// a hand-written copy and the manifest have to agree by definition, and hand-written copies drift
// (a dependency added to the manifest but not to the literal external list gets silently inlined).
const manifest = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { dependencies?: Record<string, string> };
const external = Object.keys(manifest.dependencies ?? {}).sort();

/**
 * UMD global for one `@stargantt/*` package: the kernel is `StarGantt`, and everything else is
 * `StarGantt` + its name in PascalCase (`plugin-task-bars` -> `StarGanttPluginTaskBars`,
 * `sdk` -> `StarGanttSdk`).
 */
function umdGlobal(pkg: string): string {
  const name = pkg.replace(/^@stargantt\//, "");
  if (name === "core") return "StarGantt";
  const pascal = name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return `StarGantt${pascal}`;
}

export default defineConfig({
  build: {
    lib: {
      entry: "src/index.ts",
      name: "StarGanttPresetStandard",
      formats: ["es", "umd"],
      fileName: (format) => (format === "es" ? "preset-standard.js" : "preset-standard.umd.js"),
    },
    rollupOptions: {
      external,
      output: { intro: '"use strict";', globals: Object.fromEntries(external.map((pkg) => [pkg, umdGlobal(pkg)])) },
    },
    target: "es2022",
    minify: "oxc",
    sourcemap: true,
  },
});
