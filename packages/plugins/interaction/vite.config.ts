import { defineConfig } from "vite";

// Dist-based build wiring shared with packages/core and packages/plugins/task-bars.
// ESM + UMD outputs, CSS embedded in JS (no external stylesheet), zero non-workspace externals.
//
// `@stargantt/plugin-data-store` is external alongside core and the SDK: this plugin value-imports
// the store's own `mergeTaskUpdate` (the push-out projection) and `midKey` (row-drop order keys)
// rather than re-deriving either, and inlining a second copy of the store here would give a
// composition two of them.
export default defineConfig({
  build: {
    lib: {
      entry: "src/index.ts",
      name: "StarGanttPluginInteraction",
      formats: ["es", "umd"],
      fileName: (format) => (format === "es" ? "interaction.js" : "interaction.umd.js"),
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
