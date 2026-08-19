import { defineConfig } from "vite";

// Dist-based build wiring: ESM + UMD outputs, CSS embedded in JS (no external
// stylesheet), zero non-workspace externals.
export default defineConfig({
  build: {
    lib: {
      entry: "src/index.ts",
      name: "StarGanttPluginPortfolio",
      formats: ["es", "umd"],
      fileName: (format) => (format === "es" ? "portfolio.js" : "portfolio.umd.js"),
    },
    rollupOptions: {
      external: ["@stargantt/core", "@stargantt/sdk"],
      output: {
        intro: '"use strict";',
        globals: {
          "@stargantt/core": "StarGantt",
          "@stargantt/sdk": "StarGanttSdk",
        },
      },
    },
    target: "es2022",
    minify: "oxc",
    sourcemap: true,
  },
});
