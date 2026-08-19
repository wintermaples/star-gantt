import { defineConfig, devices } from "@playwright/test";

// E2E strategy: tests open the `examples/` HTML pages, which load the built IIFE bundle via
// `../packages/stargantt/dist/stargantt.iife.js`. Vite's dev server serves the repo root as-is, so
// those relative paths resolve without any test-only HTML.
// Run `pnpm run build` first — the E2E suite exercises the built bundle, not the sources.
// STARGANTT_E2E_PORT overrides the port so concurrent `playwright test` runs (e.g. parallel
// spec-authoring agents) can each own an isolated server instead of racing on the default one.
const PORT = Number(process.env.STARGANTT_E2E_PORT ?? 4173);

// 720x540 is the documented viewport floor (CLAUDE.md §3): tablet-and-up, no mobile breakpoints.
// Widened past the bare floor to leave geometry-sensitive tests (drag distances, pane-edge probes)
// comfortable room.
const VIEWPORT = { width: 1600, height: 1000 } as const;

export default defineConfig({
  testDir: "./e2e",
  // The orthogonal-array combination suite has its own config (e2e/oa/playwright.oa.config.ts)
  // and is run explicitly, never as part of the default suite.
  testIgnore: "oa/**",
  fullyParallel: true,
  // Set by tools/e2e-in-container.sh on non-x86_64 hosts: screenshot baselines form a single
  // amd64 lineage, so toHaveScreenshot() assertions are skipped there and the visual verdict
  // is left to CI. Functional assertions still run.
  ignoreSnapshots: !!process.env.STARGANTT_SKIP_VISUAL,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  ...(process.env.CI ? { workers: 1 } : {}),
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      // The viewport goes *after* the device preset: `devices["Desktop Chrome"]` carries its own
      // 1280x720, and a project's `use` wins over the top-level one, so declaring it only up there
      // would leave tests running at the device's size.
      use: { ...devices["Desktop Chrome"], viewport: VIEWPORT },
    },
  ],
  webServer: {
    // npx (not pnpm exec) so the config also works inside the pinned Playwright container
    // image (tools/e2e-in-container.sh), which ships node/npx but not pnpm. npx resolves the
    // workspace-local vite from node_modules/.bin either way.
    command: `npx vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/examples/basic.html`,
    reuseExistingServer: !process.env.CI,
  },
});
