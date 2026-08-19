import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const dist = fileURLToPath(new URL("../packages/stargantt/dist/stargantt.js", import.meta.url));

export default defineConfig({
  // Same alias as the app, so content modules that reference the library's types resolve here too.
  resolve: { alias: { stargantt: dist } },
  test: {
    include: ["test/**/*.test.ts"],
    // `e2e/` is Playwright's; running it under vitest would report phantom passes.
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
    environment: "node",
  },
});
