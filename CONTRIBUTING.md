# Contributing to StarGantt

Thanks for your interest! Before anything else, one honest disclaimer:

> **StarGantt is a hobby project.** There is no support guarantee and no response-time
> promise. Issues are read on a best-effort basis. The intended way to get a feature or a
> fix quickly is to build it yourself — the plugin architecture exists precisely so that
> every built-in behavior can be replaced without forking the core.

## Ground rules

- **Zero runtime dependencies.** No third-party package may appear under `dependencies`
  in any package. External tools live in `devDependencies` only. Workspace-internal
  `@stargantt/*` dependencies are fine (they are bundled).
- **Public API only.** Official plugins use exactly the same public API that third-party
  plugins do. No back doors into the core, ever.
- **English only** for source code, comments, strings, tests, examples, specs, and commit
  messages.
- **Resources are owned by the core.** Listeners, DOM nodes, timers — everything a plugin
  creates must be registered through `ctx.own()` so disposal is deterministic.
- **Spec first.** The single source of truth is the spec corpus in `docs/specs/` —
  `architecture.md`, `sdk.md`, and one spec per plugin under `docs/specs/plugins/`.
  Behavior changes start with a spec revision, not with code. Where the spec is silent,
  the current implementation's behavior as pinned by tests is authoritative.
- **The core stays under 12 KB minified** — enforced mechanically by `pnpm run lint:arch`
  and CI.
- **Desktop/tablet only.** The supported viewport is 720 × 540 px and up. Do not add
  mobile-phone layouts or breakpoints below 720 px.

## Development setup

Requirements: Node.js >= 20 (CI uses 24) and pnpm 11 (`corepack enable` respects the
`packageManager` field).

```bash
pnpm install
pnpm run build          # vite library mode; builds every package
pnpm run test           # architecture lint + vitest unit tests
pnpm run typecheck      # tsc across all packages
pnpm run lint:arch      # dependency direction + event catalog + core size gate
pnpm exec tsc -p e2e --noEmit           # typecheck the E2E sources
pnpm exec playwright install chromium   # first time only
pnpm run test:e2e       # Playwright E2E (requires a prior build!)
```

### Repository layout

```
packages/core/            the micro-kernel (plugin host, services, extension points,
                          event bus, command bus — nothing else)
packages/sdk/             typed helpers for plugin authors
packages/plugins/<name>/  the 15 official plugins (flat, one directory per plugin)
packages/preset-standard/ the standard 9-plugin composition
packages/stargantt/       the single-file distribution bundle (ESM + IIFE, CSS embedded)
examples/                 47 demo pages; six of them are also E2E fixtures
e2e/                      Playwright specs (screenshots, perf regression, OA sweep in e2e/oa/)
docs/specs/               the specification — the single source of truth
user-docs/                the documentation site (separate pnpm root, see below)
```

### The documentation site (`user-docs/`)

`user-docs/` is deliberately **outside** the library's pnpm workspace and has its own
pnpm root, so its third-party dependencies can never be mistaken for library runtime
dependencies. Build the library first (the site consumes the shipped bundle), then run
everything from inside `user-docs/` — see [`user-docs/README.md`](./user-docs/README.md).

Library bugs discovered while writing documentation are filed under
`user-docs-bug-findings/`, not fixed inline.

## Testing notes (please read before running E2E)

- **Always build before E2E.** The E2E suite runs against the built bundle in
  `packages/stargantt/dist/`. A stale build produces false greens and false reds.
- **Unit tests also read built output.** After changing a workspace dependency
  (e.g. `@stargantt/core`), run `pnpm run build` before `pnpm run test`.
- **Screenshot baselines are Linux-only.** Baselines are generated and committed on
  Linux; never run `--update-snapshots` on another OS. When regenerating, always use
  `--update-snapshots=all` — the default `changed` mode leaves stale baselines behind for
  changes that stay within `maxDiffPixelRatio`.
- **The full unit suite finishes in seconds.** If a run takes minutes, suspect a hang.
- **Six example pages are E2E fixtures.** `basic.html`, `interaction.html`,
  `scheduling.html`, `tracking.html`, `resource.html`, and `data-sync.html` have DOM
  contracts (element ids, buttons, `window.gantt` / `window.__lastOp`) that E2E depends
  on — check the corresponding specs when touching them.
- **Parallel E2E runs need separate ports.** Set `STARGANTT_E2E_PORT` per run.

## Pull requests

- Target `main`. CI runs the full verification gate: build → unit tests → typecheck →
  E2E typecheck → Playwright E2E, plus a separate job for the docs site.
- Keep mechanical changes (renames, moves) and behavioral changes in separate commits —
  ideally separate PRs.
- If your change alters public behavior, update the spec in `docs/specs/` in the same PR.

## Security

Please do not open public issues for vulnerabilities — see [SECURITY.md](./SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](./LICENSE).
