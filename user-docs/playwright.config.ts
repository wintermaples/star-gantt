import { defineConfig, devices } from "@playwright/test";

// Kept away from the library's own e2e port (4173) so both suites can run at once.
const PORT = Number(process.env["STARGANTT_DOCS_E2E_PORT"] ?? 5176);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env["CI"]),
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    ...devices["Desktop Chrome"],
    // The default viewport most of this suite runs at — comfortable for the sticky-split config
    // pages and CodeMirror panes. The actual supported *minimum*, 720x540, is checked separately,
    // at a sample of routes, by the "layout" describe block in e2e/pages.spec.ts.
    viewport: { width: 1440, height: 900 },
  },
  // The site renders real charts out of packages/stargantt/dist, so the library must be built
  // first — the same stale-artifact hazard the library's own e2e suite has.
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort`,
    port: PORT,
    reuseExistingServer: !process.env["CI"],
    timeout: 60_000,
  },
});
