import { defineConfig } from "vite";

// Dist-based build wiring shared with the other packages (core, task-bars, ...).
// ESM + UMD outputs, CSS embedded in JS (no external stylesheet), zero non-workspace externals.
export default defineConfig({
  build: {
    lib: {
      entry: "src/index.ts",
      name: "StarGanttPluginView",
      formats: ["es", "umd"],
      fileName: (format) => (format === "es" ? "view.js" : "view.umd.js"),
    },
    rollupOptions: {
      external: ["@stargantt/core", "@stargantt/sdk", "@stargantt/plugin-data-store"],
      output: {
        intro: '"use strict";',
        globals: {
          "@stargantt/core": "StarGantt",
          "@stargantt/sdk": "StarGanttSdk",
          "@stargantt/plugin-data-store": "StarGanttPluginDataStore",
        },
      },
    },
    target: "es2022",
    minify: "oxc",
    sourcemap: true,
  },
});
