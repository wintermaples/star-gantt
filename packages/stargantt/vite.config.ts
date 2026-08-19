import { defineConfig } from "vitest/config";

// `stargantt` ships `dist/stargantt.js` (ESM) and `dist/stargantt.iife.js` (global `StarGantt`)
// with **no externals**: the kernel, every plugin currently wired in (data-store, view,
// tree-grid, task-bars), the preset and the stylesheet are inlined into each artifact.
export default defineConfig({
  build: {
    lib: {
      entry: "src/index.ts",
      name: "StarGantt",
      formats: ["es", "iife"],
      fileName: (format) => (format === "es" ? "stargantt.js" : "stargantt.iife.js"),
    },
    rollupOptions: {
      // Explicitly empty: everything is bundled in.
      external: [],
      // rolldown emits IIFE/UMD wrappers WITHOUT "use strict" (unlike rollup, whose
      // output.strict defaults to true). Our inputs are prebuilt, oxc-mangled ESM whose scoping
      // is only valid under strict semantics — this avoids a failure
      // mode from Annex B block-level function hoisting shadowing an outer binding.
      output: { intro: '"use strict";' },
    },
    target: "es2022",
    // `build.cssTarget` defaults to `build.target`; es2022 predates `light-dark()`, and letting
    // Lightning CSS downlevel it would resolve against `prefers-color-scheme` instead of the
    // documented `color-scheme` override path (see styles/tokens.css's theme-token section).
    // `false` disables target-driven CSS transformation while leaving minification on.
    cssTarget: false,
    minify: "oxc",
    sourcemap: true,
  },
  test: {
    // Vitest stubs CSS imports out by default; `src/index.ts` needs the real contents of the
    // `./styles/*.css?inline` imports.
    css: true,
  },
});
