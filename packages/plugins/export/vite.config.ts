import { defineConfig } from "vite";

// Dist-based build wiring shared with packages/core and packages/plugins/task-bars.
// ESM + UMD outputs, CSS embedded in JS (no external stylesheet), zero non-workspace externals.
export default defineConfig({
  build: {
    lib: {
      entry: "src/index.ts",
      name: "StarGanttPluginExport",
      formats: ["es", "umd"],
      fileName: (format) => (format === "es" ? "export.js" : "export.umd.js"),
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
