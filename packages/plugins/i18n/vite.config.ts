import { defineConfig } from "vite";

// Dist-based build wiring: ESM + UMD outputs, CSS embedded in JS (no external
// stylesheet), zero non-workspace externals.
export default defineConfig({
  build: {
    lib: {
      entry: "src/index.ts",
      name: "StarGanttPluginI18n",
      formats: ["es", "umd"],
      fileName: (format) => (format === "es" ? "i18n.js" : "i18n.umd.js"),
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
