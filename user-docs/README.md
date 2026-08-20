# StarGantt user documentation

The user-facing documentation site. Every chart on it is a real StarGantt instance created through
the public API from the shipped bundle — no screenshots, no mocks, no documentation-only back door.

Authoring rules and the reasoning behind them: [`CLAUDE.md`](./CLAUDE.md) and
[`docs-policy.md`](./docs-policy.md) (the **D-nn** ruling ledger).

## Running it

The site reads the **built** library, so build it first or the site documents a stale artifact:

```bash
# repository root
pnpm install
pnpm run build

# here
pnpm install
pnpm run dev          # http://localhost:4175
pnpm run generate     # re-extract src/generated/*.json (API snapshot + search index)
pnpm run test         # vitest — coverage and consistency
pnpm run test:e2e     # Playwright — every page runs
pnpm run typecheck    # src + e2e
pnpm run build
```

There are no root-level `docs:*` convenience scripts and no VS Code launch target for this site —
`user-docs` is a separate pnpm root (see below), so every command above is run from inside this
directory, not the repository root.

`user-docs` is deliberately outside the library's pnpm workspace and has its own pnpm root, so its
third-party dependencies can never be mistaken for library runtime dependencies (D-02).

## Layouts

Three, one per question a reader arrives with.

| Layout | Used for | What it is |
|---|---|---|
| Notebook | Guides | Prose cell, editable demo cell, live output cell. Edit the code and the chart under it re-renders. |
| Tabbed reference | `/reference/<plugin>` | One tab per API kind — config, services, events, commands, extension points, recipes. The tab strip is generated, so an empty surface gets a tab that says so rather than no tab at all. |
| Sticky split | `/reference/<plugin>/config` | Prose scrolls, one chart stays pinned. Choosing an option's value re-applies it to that instance instead of re-mounting a new one. |

The landing page is hand-written and is the only page with neither generated tables nor per-option
demos.

## What loads when

The initial script is 404 kB (118 kB gzipped) and holds the shell, the router and the nav. Nothing
else is in it: a page's prose arrives with the route, the StarGantt bundle with the first chart,
CodeMirror with the first editor, the search index with the first search, and a chart below the fold
when the reader scrolls to it. The reasoning, and the bug the first attempt shipped, are in D-16.

## How it is put together

```
tools/extract-api.ts    TypeScript Compiler API walk over packages/**/src
tools/build-content-index.ts  imports the content modules; writes the manifest and the search index
src/generated/api.json  the result — committed, and re-checked by the test suite
src/generated/content-manifest.json  each page's slug, title and module — the nav without the prose
src/generated/search-index.json  identifiers + one-line summaries, fetched on first search, never on load
src/content/types.ts    the shapes an author fills in
src/content/plugins/    one module per plugin
src/content/guides/     one module per guide
src/content/core/       one module per core chapter
src/content/registry.ts import.meta.glob, lazy — nothing is listed by hand, nothing loads early
src/pages/              three layouts; no page has its own implementation
test/_all-content.ts    every content module, eagerly — for the tests only (D-16)
test/coverage.test.ts   what the documentation is not allowed to omit
e2e/pages.spec.ts       every page actually runs
```

## What the tests enforce

- `api.json` matches what the extractor produces from the current sources — an API change the docs
  have not caught up with is a diff, not a silence. `search-index.json` follows the same rule.
- Every plugin has a page. There is no allowance list — `docs-debt.json` existed while the pages
  were being written and was deleted when it reached zero, which is what D-04 says to do with it.
- A plugin's documented options are exactly the options in `api.json` — no extras, none missing.
- Every option either carries at least two demo values, the first of which configures nothing, or
  states in more than a sentence why it cannot be demonstrated.
- Every empty API surface is explained rather than omitted.
- Every guide has at least one runnable cell.
- Every page loads with no page error, mounts a real chart with its accessible tree, and changing an
  option's value visibly changes the chart.
- Nothing overflows horizontally at 720×540, the minimum supported viewport.
- Search finds every plugin by its short name and every documented option by name, and a hit
  lands on the tab or the option it names — not merely on the right page.

What the tests deliberately do **not** check is whether the prose is any good — that is the review
agent's job, and the reasoning is written down in D-10.

## Found a bug in the library?

Do not fix it here. Write it up in [`../user-docs-bug-findings/`](../user-docs-bug-findings/) and
carry on (D-12).

## Known tooling gap

`tools/extract-api.ts` walks each service's own `declare module "@stargantt/core"` augmentation —
one `key: Type` pair per service — but does not resolve into the named `Type` and list *its*
members. A service's individual methods (`save()`, `state`, `metricsOf()`, ...) are therefore
invisible to `api.json`, to `test/coverage.test.ts`'s "annotates only API members that exist"
check, and to the search index. Nothing catches an author naming a method a service does not
actually have, or missing one it does — both happened in this corpus (a `list()`/`snapshots()`
method neither `BaselinesService` nor `EvmService` has; four real `ExportService` members never
named anywhere on the page) and were only caught by manual review, not by a test. A next increment
worth doing: extend the extractor to resolve each service's named interface and list its members
(signature + TSDoc) the same way `config`/`events`/`commands`/`extensionPoints` already work, so a
`notes.services` entry — or its absence — can be checked against real member names mechanically.
