/*
 * e2e/oa/playwright.oa.config.ts — config for the orthogonal-array combination suite only.
 *
 * The suite is kept out of the default E2E run
 * (root `playwright.config.ts` ignores `oa/**`) because it is up to 729 browser boots, not a
 * per-feature check. Run it explicitly:
 *
 *   pnpm run build
 *   OA_SHARD=1 OA_SHARDS=1 STARGANTT_E2E_PORT=4630 OA_WORKERS=4 \
 *     pnpm exec playwright test --config e2e/oa/playwright.oa.config.ts
 *
 * Every shard owns its own port so the vite servers of concurrent shards never race.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

// Playwright resolves relative config paths — including the web server's working directory —
// against the config file's own directory, which here is two levels below the repository root the
// vite server has to serve for `examples/*.html` to reach `packages/stargantt/dist/`.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = Number(process.env.STARGANTT_E2E_PORT ?? 4173);
// Wider than the default suite's 1600x1000: this composition mounts all 15 plugins at once, so the
// grid pane, the side panel and the chart pane share the row. The viewport is the same for every
// run, so it changes no comparison between them. Still comfortably above the 720x540 floor
// (CLAUDE.md §3).
const VIEWPORT = { width: 1920, height: 1200 } as const;

export default defineConfig({
  testDir: ".",
  fullyParallel: true,
  workers: Number(process.env.OA_WORKERS ?? 1),
  retries: 0,
  reporter: [
    ["list"],
    ["json", { outputFile: join(REPO_ROOT, "oa-results", `summary-shard-${process.env.OA_SHARD ?? 1}.json`) }],
  ],
  outputDir: join(REPO_ROOT, "oa-results", `pw-shard-${process.env.OA_SHARD ?? 1}`),
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: VIEWPORT },
    },
  ],
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort`,
    cwd: REPO_ROOT,
    url: `http://localhost:${PORT}/examples/hello.html`,
    reuseExistingServer: true,
  },
});
