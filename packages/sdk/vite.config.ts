import { defineConfig } from "vite";

// Dist-based build wiring: ESM + UMD outputs, CSS embedded in JS (no external
// stylesheet), zero non-workspace externals.
export default defineConfig({
  build: {
    lib: {
      entry: "src/index.ts",
      name: "StarGanttSdk",
      formats: ["es", "umd"],
      fileName: (format) => (format === "es" ? "sdk.js" : "sdk.umd.js"),
    },
    rollupOptions: {
      external: ["@stargantt/core"],
      output: {
        intro: '"use strict";',
        globals: {
          "@stargantt/core": "StarGantt",
        },
      },
    },
    target: "es2022",
    minify: "oxc",
    sourcemap: true,
  },
});
