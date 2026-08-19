import { defineConfig } from "vite";

// Dist-based build wiring: ESM + UMD outputs, CSS embedded in JS (no external
// stylesheet), zero non-workspace externals.
export default defineConfig({
  build: {
    lib: {
      entry: "src/index.ts",
      name: "StarGantt",
      formats: ["es", "umd"],
      fileName: (format) => (format === "es" ? "core.js" : "stargantt.core.iife.js"),
    },
    rollupOptions: {
      external: [],
      output: {
        intro: '"use strict";',
        globals: {

        },
      },
    },
    target: "es2022",
    minify: "oxc",
    sourcemap: true,
  },
});
