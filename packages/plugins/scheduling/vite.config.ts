import { defineConfig } from "vite";

// Dist-based build wiring, matching the pattern used by packages/core and packages/plugins/basic/task-bars.
// ESM + UMD outputs, CSS embedded in JS (no external stylesheet), zero non-workspace externals.
//
// `@stargantt/plugin-data-store` is external alongside core and the SDK: the engine's
// per-transaction projection value-imports the store's own `mergeTaskUpdate` (data-store.md — the
// store publishes the merge so a projection can never disagree with the post-transaction state)
// rather than re-deriving it, and inlining a second copy of the store here would give a
// composition two of them.
export default defineConfig({
  build: {
    lib: {
      entry: "src/index.ts",
      name: "StarGanttPluginScheduling",
      formats: ["es", "umd"],
      fileName: (format) => (format === "es" ? "scheduling.js" : "scheduling.umd.js"),
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
