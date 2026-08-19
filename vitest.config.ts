import { configDefaults, defineConfig } from "vitest/config";

// `css: true`: `packages/stargantt` imports its default stylesheet as a string
// (`./styles/*.css?inline`); vitest stubs CSS imports out by default, so the workspace-wide run
// needs to process CSS for that import to carry real content.
//
// `exclude`: Playwright specs must not run under vitest. `.claude/worktrees/` is excluded so a
// root run stays correct if one appears instead of silently swallowing it into the vitest run.
// `user-docs/` is a standalone subpackage with its own vitest/Playwright config that a root run
// must not reach into.
//
// `passWithNoTests: true`: a package added to the workspace before its first test file lands must
// not fail a workspace-wide `vitest run`.
export default defineConfig({
  test: {
    css: true,
    exclude: [
      ...configDefaults.exclude,
      "e2e/**",
      ".claude/worktrees/**",
      "user-docs/**",
      ".pnpm-store/**",
      // The pre-v2 repository may sit here as an untracked working copy; its test suite
      // (and its own vendored stores) must never leak into a root run.
      "star-gantt-old/**",
    ],
    passWithNoTests: true,
  },
});
