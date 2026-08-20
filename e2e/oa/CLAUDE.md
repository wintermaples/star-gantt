# e2e/oa/ — the plugin-config combination sweep (authoring & maintenance guide)

Rules for everything under `e2e/oa/`. English only (repo-wide convention, CLAUDE.md §5).
Covers the official-plugin surface: **15 plugins** and **111 config factors**.

## 0. What this is

Every official plugin ends up in the same chart, and their config fields interact. A per-feature
page can never show that: it composes one plugin set with one config. This suite runs an
**orthogonal array** over the whole config surface instead.

- **Design.** `OA(729, 3^111, strength 2)` — 729 runs, 111 factors, 3 levels each. Every ordered
  pair of levels of any two factors appears in **exactly 81** of the 729 runs, which is what buys
  pairwise coverage from 729 configurations instead of the 3^111 a full factorial needs.
- **Construction.** Rao-Hamming over GF(3): the 729 runs are the points of GF(3)^6, each factor owns
  one proportionality class of non-zero coefficient vectors as its *column*, and run `x` puts factor
  `j` at level `dot(x, column_j) mod 3`. There are `(3^6 − 1) / 2 = 364` such classes, so 364 is the
  factor ceiling at this size (§3.4). 111 of them are in use — 253 free columns of headroom before
  `K` needs to grow.
- **Level 0 means "the config key is omitted."** Run 1 is the all-zero point and therefore the
  all-defaults baseline. Use it as the reference image.
- **Plugin presence is a constant, not a factor.** All 15 official plugins load in every run; only
  config values vary. That is a deliberate scoping choice: it keeps the array free of the "this
  field only exists when that plugin is loaded" constraints that would break the balance.

There is (as of this writing) no committed `plugin-config-orthogonal-array-L729.xlsx` design
workbook — §7 says how to build one if wanted. It was not produced as part of the initial
catalogue build, since the immediate goal was a runnable catalogue and a demonstrated smoke slice,
not a fully reviewed 729-run sweep.

## 1. The files

| File | Role |
|---|---|
| `catalog.json` | **The generated input.** 15 plugins (id, factory, category, `inPreset`, `dependsOn`) + 111 factors (id, plugin, field, type, `levels[3]`) + the shared `fixtures` source. Everything else reads this. |
| `levels.check.ts` | **Generated from `catalog.json`, committed, never imported.** Assigns every level expression to its field's declared type so `tsc -p e2e` rejects a level whose shape is wrong (§3.7). |
| `oa-array.ts` | The array itself: `RUNS`, `levelsForRun(run, factorCount)`, `shardRuns(shard, shards)`. Pure, no I/O. |
| `dataset.ts` | The single dataset every run charts, anchored on the same instant `../_fixtures.ts`'s `FIXED_TIME` uses. Deliberately small (3 tasks, 1 link, 1 resource, 1 assignment) — a large generated dataset buys no extra coverage at this factor count. |
| `boot-code.ts` | Turns a run number into playground-shell boot **source text**: `presetStandard(config)` for the 9 preset plugins, appended factories in dependency order for the other 6. |
| `oa.spec.ts` | One Playwright test per run: boot through the shell, check the machine invariants, screenshot, write `run-NNN.json`. |
| `playwright.oa.config.ts` | Its own config — the suite is excluded from the default run by `testIgnore: "oa/**"` in the root `playwright.config.ts`. |
| `report-template.html` | The shard report. One template, so every shard's report is the same document with different data. |
| `make-report.mjs` | Renders one shard's `index.html` from machine results + that shard's `visual.json`. |
| `make-index.mjs` | Renders the top-level `index.html`: findings grouped into declared clusters, machine failures, shard links. The `CLUSTERS` regex array (bar-label overprint, unreadable theme, blank-viewport window, overlay-corner stacking, header-label crowding, over-height progress line) describes recurring visual-failure patterns; it has not been validated against an actual visual review pass yet (none has run) and may need retuning once real reviewer notes exist. |

## 2. The pipeline

```
user-docs/src/generated/api.json          # the public API snapshot — source of truth for the surface
        │  (regeneration, §3)
        ▼
   catalog.json  ──►  boot-code.ts  ──►  oa.spec.ts  ──►  oa-results/results/run-NNN.json
        │                 ▲                                oa-results/screenshots/run-NNN.png
   oa-array.ts  ──────────┘                                        │
                                                                   ▼
                                        visual.json (a reviewer's per-run verdict)
                                                                   │
                                          make-report.mjs ─────────┴──► oa-results/shard-NN/index.html
                                          make-index.mjs   ───────────► oa-results/index.html
```

`api.json` is produced by the `user-docs/` extractor, `node user-docs/tools/extract-api.ts`.

## 3. Regenerating `catalog.json` when plugins or config change

**This is the maintenance path. A new plugin, a removed plugin, a new config field or a changed
field type all mean regenerating the catalogue.**

### 3.1 Refresh the surface snapshot first

`catalog.json` is derived from `user-docs/src/generated/api.json`, extracted from the packages'
built declarations. `api.json` is a COMMITTED file (`user-docs/` is its own subpackage,
carrying the extraction tooling and its generated output as tracked artifacts), not an
ephemeral build byproduct: it will
already exist and reflect whatever was last committed even without running the extractor, which
matters for anyone regenerating the catalogue without also touching `user-docs/`. Refresh it before
anything else regardless, or the sweep documents a stale API against uncommitted plugin changes:

```bash
pnpm run build                                    # repository root
cd user-docs && node tools/extract-api.ts && cd .. # rewrites user-docs/src/generated/api.json
```

`api.json` gives, per plugin: `id`, `factory`, `category`, `inPresetStandard`, `dependsOn`, and a
`config[]` of `{ name, type, optional, doc }`. Everything `catalog.json` needs except the level
*values* is mechanical from that. Note: `doc` is often empty for several plugins (data-sync's
top-level fields in particular) — read the plugin's `docs/specs/plugins/<name>.md` and, for a
complex/callback/adapter type, the BUILT declaration under
`packages/plugins/<dir>/dist/**/*.d.ts` rather than guessing.

### 3.2 What a factor must satisfy

Each config field is one factor, and each factor carries **exactly three levels**:

| Level | Meaning |
|---|---|
| `levels[0]` | Always the literal string `"(omit)"` — the key is not written at all, i.e. the library default. |
| `levels[1]`, `levels[2]` | Two distinct explicit values, written as **JavaScript source expressions** (they are pasted into the generated boot text, so callbacks, adapters and canvas renderers are expressible; JSON is not). |

Rules a level set must obey — breaking any of these silently damages the experiment:

1. **Three levels, never two, never four.** The array is uniform `3^n`; a factor with a different
   arity would need dummy levels and would stop being strictly orthogonal. A type with more than
   two interesting non-default values gets two of them and the rest recorded as *not covered* (this
   repo has no committed workbook yet — see §7 — so record it in the level-authoring notes / PR
   description instead), not a fourth level.
2. **No level may throw or produce an unusable chart on its own.** A run exercises 111 factors at
   once; one throwing value makes the whole run's verdict meaningless.
3. **No level may create a cross-factor constraint.** Two factors must never combine into an invalid
   configuration, because excluding rows would break the balance the orthogonality rests on. In
   practice this means id-referencing fields (`data-sync.active`, `data-sync.lazyLoad.active`,
   `data-sync.realtime.connect`, `scheduling.calendars`'s `shadeCalendar`, `tracking.baselines`'s
   `active`, `portfolio`'s node/goal references) are only safe because their contracts say an
   unknown id is *ignored* — verify that per-plugin in `docs/specs/plugins/*.md` before relying on
   it.
4. **Levels are chosen for behaviour, not for coverage theatre.** A number gets a boundary and a
   large value; an enum gets two values that take different code paths; a callback gets one working
   implementation and one degenerate one; an array gets `[]` and a seeded list; a message catalogue
   gets `{}` and one overridden key.
5. **Shared fixtures go in `catalog.json`'s `fixtures` string**, which is emitted once at the top of
   every boot. Anything a level expression references (the data-sync adapter/transport constants,
   any plugin-cluster-prefixed helper constant) must be defined there. Fixtures are grouped by
   plugin cluster (data-store/task-bars/tree-grid/view; interaction/a11y/undo-redo/export/
   scheduling; data-sync/portfolio/resource/tracking/i18n/perf-tools) — check `catalog.json`'s
   `fixtures` string directly if a constant's provenance is unclear.

Per-type defaults that have worked so far:

| Type in `api.json` | `levels[1]`, `levels[2]` |
|---|---|
| `boolean` | `true`, `false` |
| `number` | a boundary (`0`, `1`) and a large or negative value |
| `string` | two valid values; a sanitisation-exercising one where the contract documents sanitising |
| literal union | two of its members (prefer ones with distinct code paths over the default) |
| `Partial<XMessages>` | `{}` and `{ <first member>: … }` — a builder-function member gets a function |
| provider / callback | one working implementation, one degenerate one (`() => undefined`, stroke-only renderer) |
| array | `[]` and a seeded list of one or two entries |
| `Record<…>` / adapter map | `{}` and one entry wired to a fixture |
| `boolean \| {…}` union | `true` and the object form with its fields set |

### 3.3 The regeneration recipe

There is deliberately **no committed generator script**: the mechanical half is five lines, and the
level values are a judgement call that must be reviewed by a human or a reasoning pass, not
regenerated blindly (a generator would happily invent a level that violates rule 3).

1. Emit the mechanical half from `api.json`:

   ```js
   // scratch script — plugins + factor skeletons, levels left null
   const api = JSON.parse(readFileSync("user-docs/src/generated/api.json", "utf8"));
   const plugins = api.plugins.map((p) => ({
     id: p.id, factory: p.factory, category: p.category,
     inPreset: !!p.inPresetStandard, dependsOn: p.dependsOn ?? [],
   }));
   const factors = api.plugins.flatMap((p) =>
     p.config.map((f) => ({ id: `${p.id.replace("stargantt.", "")}.${f.name}`,
       plugin: p.id, field: f.name, type: f.type, levels: null })));
   ```

2. **Diff against the committed `catalog.json`** and only author levels for factors whose `id` is
   new or whose `type` changed. Carry every unchanged factor's levels over verbatim — re-authoring
   them churns the array for nothing (§3.5).
3. Author the new levels against §3.2, reading each field's `doc` from `api.json` for its documented
   default, bounds and "unusable values are ignored" clauses. For a complex type, read the type's
   declaration out of the built `packages/plugins/*/*/dist/**/*.d.ts` rather than guessing its shape.
4. Write `catalog.json` with the key order `generatedFrom`, `fixtures`, `plugins`, `factors`,
   at `JSON.stringify(…, null, 1)` with no trailing newline — the committed formatting, so a level
   edit is a one-line diff rather than a whole-file rewrite.
5. **Regenerate `levels.check.ts` (§3.7) and compile.** Do this before anything below: it is what
   catches a level whose *shape* does not match the config type.
6. Sanity-check before running the sweep:

   ```bash
   node -e "const c=require('./e2e/oa/catalog.json');
     const bad=c.factors.filter(f=>f.levels?.length!==3||f.levels[0]!=='(omit)');
     console.log(c.plugins.length,'plugins',c.factors.length,'factors','| malformed:',bad.map(f=>f.id));"
   pnpm run build && pnpm exec tsc -p e2e --noEmit
   OA_RUNS=1,2,729 STARGANTT_E2E_PORT=4630 pnpm exec playwright test --config e2e/oa/playwright.oa.config.ts
   ```

   Run 1 (all defaults) failing means the composition itself broke, not the array.

### 3.4 The 364-factor ceiling

`oa-array.ts` builds columns from GF(3)^`K` with `K = 6`: 729 runs, 364 usable columns. 111 are in
use, so **253 config fields can be added with no change at all** before `K` needs to grow.

Past 364 factors, raise `K` to 7 in `oa-array.ts`: 2187 runs and 1093 columns. Nothing else in the
suite changes — `RUNS` is exported and every consumer reads it — but the sweep's wall-clock and its
screenshot count triple, and `make-report.mjs`'s local `shardRuns` copy has a hard-coded `RUNS = 729`
that must be raised with it. Do not attempt a mixed-level or partially-balanced array to squeeze
under the ceiling; the strict balance is the property the whole design is defended on.

### 3.5 Run numbers are not stable across catalogue changes

Columns are assigned to factors **in catalogue order** (`COLUMNS.slice(0, factorCount)`). Inserting
a factor in the middle therefore shifts every later factor onto a different column, and every run's
configuration changes. Consequences:

- **Append new factors at the end of `factors[]`** where you can — the existing factors keep their
  columns and the array stays comparable with the previous sweep.
- Removing a factor, or reordering, invalidates comparisons with earlier reports. Say so in the
  report rather than presenting run 217 as the same experiment it was before.
- The screenshots are *not* baselines. They are evidence attached to a report; nothing compares them
  across sweeps automatically.

### 3.6 When a plugin is added or removed

- `boot-code.ts` needs no edit: preset membership comes from `inPreset` and the append order is a
  topological sort of `dependsOn` computed at load.
- A new plugin whose factory needs an argument to be useful still gets instantiated bare
  (`StarGantt.factory()`) in the level-0 case, so its config fields must all be optional. Every
  official plugin's config is fully optional today; if that ever stops being true, that
  plugin needs its required fields written into the boot text unconditionally, outside the array.
- Check the plugin does not fight for a chart-pane overlay corner already claimed — see
  `docs/specs/architecture.md`'s overlay-corner claim mechanism. Two
  overlays in one corner is a real composition problem, but it shows up as a *visual* finding and
  wastes a review cycle if nobody expected it.

### 3.7 `levels.check.ts` — the type guard on level expressions

`catalog.json`'s level values are JavaScript source, pasted into generated boot text. Nothing in
the pipeline checks their *shape* on its own — a level whose shape does not match its field's type
(for example, a `task-bars.renderBar` level reading `a.color/a.x/a.y/a.width/a.height` from a
`BarRenderArgs` that actually carries `{ box, task, defaultPaint }`, or a `task-bars.patternFill`
level returning `{ kind: "hatch" }` against a string-union `BarPattern`) photographs an unchanged
chart, indistinguishable from a feature that does not work. Level authors must read the real
declaration before writing any callback/adapter/renderer level.

`levels.check.ts` closes the gap mechanically. It is **generated** from `catalog.json` and
**committed**: one `const … : Pick<Config, "field"> = { field: <level expression> }` per non-`(omit)`
level, so `pnpm exec tsc -p e2e --noEmit` rejects any level whose shape does not match the plugin's
config type. The file is never imported and never runs.

Config types reach `e2e/` through the root `stargantt` workspace devDependency: the bundle
re-exports each opt-in plugin's `<Name>Config`, and the nine preset plugins' configs are
`NonNullable<PresetStandardConfig["<factoryName>"]>`. The dependency resolves through the **built**
declarations, so `pnpm run build` must precede the check.

One constraint the check cannot state and an author must hold: **a level expression is pasted into
plain JavaScript**, so it may not contain TypeScript syntax. No `as` casts, no type annotations, no
generics. A level that only type-checks with a cast is the wrong level — write one a library user
could write.

As with the catalogue itself there is deliberately no committed generator: the emitter is five lines
of scratch work (read `catalog.json`, map plugin → config type, emit one const per level), and only
its output is tracked.

## 4. Running the sweep

The suite runs the **built** bundle, so build first or it documents a stale artifact.

```bash
pnpm run build

# whole sweep in one process — the normal way
OA_SHARD=1 OA_SHARDS=1 STARGANTT_E2E_PORT=4630 OA_WORKERS=8 \
  pnpm exec playwright test --config e2e/oa/playwright.oa.config.ts

# one shard, for a per-shard reviewer
OA_SHARD=3 OA_SHARDS=12 STARGANTT_E2E_PORT=4633 OA_WORKERS=1 \
  pnpm exec playwright test --config e2e/oa/playwright.oa.config.ts

# named runs, for a pilot or a re-check (a smoke-slice form)
OA_RUNS=1,2,729 STARGANTT_E2E_PORT=4630 \
  pnpm exec playwright test --config e2e/oa/playwright.oa.config.ts
```

| Variable | Meaning |
|---|---|
| `OA_SHARD` / `OA_SHARDS` | Contiguous block of runs this process owns. Sharding is explicit because Playwright's own `--shard` splits by *file*, and this suite is one file. |
| `OA_RUNS` | Comma-separated run numbers; overrides the shard selection. |
| `OA_WORKERS` | Playwright workers (default 1). |
| `STARGANTT_E2E_PORT` | The vite port. |

**Do not start twelve shards in twelve processes.** Each spawns its own vite dev server, and many
of them exhaust the inotify watcher limit (`ENOSPC`), which kills servers mid-run and produces a
sweep that looks like a mass failure. Either run one process with more workers, or point every shard
at one already-running server on the same port (`reuseExistingServer` is on).

## 5. What a run checks

`oa.spec.ts` boots directly on `examples/hello.html` (a real example page — **no test-only HTML**,
matching the E2E policy the rest of the suite follows): the page's own tiny demo instance is
disposed, its `#chart` mount reused, and the generated `function boot({ mount, StarGantt })` is
evaluated once via an isolated `new Function` scope and called, with any throw caught and reported
rather than left to fail the page-eval call. (No `examples/*.html` page wires a playground-shell
script with a `#demo-code`/`window.__pg.run()` block; see `oa.spec.ts`'s own header comment for
details.) It then asserts:

- the boot call returned an instance and did not throw (its error, if any, surfaces in the record);
- no uncaught page errors and no `console.error` during the run;
- a `[role="treegrid"]` mirror exists and holds rows;
- with the chart pane shown: canvas layers mounted, non-zero size, not all blank, pane wider than 0;
- with the grid pane shown: pane wider than 0 and holding rows;
- no horizontal page overflow (WCAG 1.4.10);
- no `NaN` / `undefined` / `[object Object]` in grid row text.

`view.panes` (`PanesConfig`, `{ initialViewMode: "gantt" | "grid" }`) legitimately drops one pane,
so the pane-and-canvas checks are read against the view mode the run asked for (pane management
lives in `stargantt.view`, and the field is a nested object). **Any new invariant must be written
the same way**: conditional on
the factors that legitimately change it, or it will fire on configurations that are working exactly
as specified. Everything else — anything about *looks* — belongs in the visual review, not here.

Weaker signals go in `warnings` and never fail a run.

## 6. Review and reports

A run's `results/run-NNN.json` carries the machine verdict, the probe, the screenshot path, the
generated boot source and `nonDefault` — the exact list of factors this run moved off default, with
their values. **`nonDefault` is what a reviewer reasons from**: a finding is only a library defect if
nothing in that list explains it.

A visual reviewer (one per shard) writes `oa-results/shard-NN/visual.json`:

```json
[{ "run": 85, "visual": "ok" | "issue", "note": "what is wrong and which config value is suspected" }]
```

Then `node e2e/oa/make-report.mjs --shard 3 --shards 12` renders that shard's page and
`node e2e/oa/make-index.mjs` renders the top-level page. **Reports are always generated, never
hand-written** — that is what keeps twelve reviewers' output one document family. To change how a
report looks, change `report-template.html`; to change how findings are grouped, edit the `CLUSTERS`
array in `make-index.mjs` (each cluster is a title, a detail, a regex over reviewer notes, and a
verdict line that says what was decided about it).

## 7. Output tree

Everything lands in **`oa-results/` at the repository root**, gitignored, and deliberately **not**
under `test-results/`: Playwright empties its `outputDir` at the start of every run, so the default
E2E suite deletes anything parked there.

```
oa-results/
  index.html            aggregate report
  shard-NN/index.html   per-shard report (+ visual.json, the reviewer's input)
  results/run-NNN.json  machine verdict, probe, nonDefault config, boot source
  screenshots/run-NNN.png
  pw-shard-N/           Playwright's own per-test artifacts
```

No design workbook has been built yet. If one is wanted, build it from `catalog.json` +
`oa-array.ts` with `python3` + `openpyxl` (system Python, not a repo
dependency) — sheet 1 the factors with their levels and assigned columns, sheet 2 the 729×111 level
matrix, sheet 3 the design notes and the verification (per-factor level balance = `RUNS/3` each;
every factor pair's nine level pairs each appearing `RUNS/9` times). Rebuild it whenever
`catalog.json` changes, or delete it rather than let it describe a different array than the one the
suite runs.

## 8. Reading findings: the known non-defects

The sweep produces configurations no human would write, and several findings are the *configuration*
working correctly, not a defect:

- **Empty chart because the viewport holds no data.** A run that sets `view.timeline`'s origin
  explicitly opens there, and `autoExtendOrigin` defaults to off (this factor's level author
  paired an explicit origin with `autoExtendOrigin: true` specifically to avoid manufacturing this
  case pointlessly — but a *different* factor combination could still produce it legitimately).
- **Header labels abutting.** A run that sets a zero label-padding field gets labels with no gap;
  fit-based thinning honours the padding it was given.
- **A progress line spanning the chart height.** It is anchored on that run's configured
  progress-tracking status date, by design.
- **Overlays stacked in one corner.** Two plugins configured into the same corner (see
  `docs/specs/architecture.md`'s overlay corner-claim mechanism for the corner map).
- **Barely-visible bars under the sweep's own `renderBar` fixture.** A stroke-only degenerate level
  draws a thin outline; that is the harness, not the library.
- **Extra rows / replaced data on data-sync/lazy-load factors.** The `data-sync.sources` /
  `data-sync.lazyLoad.sources` fixtures (`OA_C_DATA_SOURCE` / `OA_C_LAZY_SOURCE`, see the fixtures
  string) serve the same small `OA_DATASET` the boot's own `load()` call uses, so a mismatched
  dataset producing extra or replaced rows should not occur; if it does anyway, that is worth
  investigating rather than waving off.

No sweep has been fully run and visually reviewed yet — only a runnable catalogue and a
demonstrated three-run smoke slice exist so far. Calibration examples for what a *real* finding
looks like: mislabeled overprinting, an inside label matching its bar's colour, a palette painted
onto the wrong colour scheme.

## 9. Checklist when the plugin or config surface changes

1. `pnpm run build && cd user-docs && node tools/extract-api.ts && cd ..` — refresh `api.json`.
2. Regenerate `catalog.json` (§3): mechanical half from `api.json`, levels authored only for new or
   retyped factors, everything else carried over, appended rather than inserted.
3. Regenerate `levels.check.ts` (§3.7) — the type guard on the level expressions themselves.
4. Malformed-level check + `pnpm exec tsc -p e2e --noEmit` + a three-run pilot (§3.3 step 6).
5. If the factor count passed 364, raise `K` in `oa-array.ts` and `RUNS` in `make-report.mjs` (§3.4).
6. Run the sweep (§4), review, report (§6).
7. Build or skip the workbook (§7) — none exists yet.
8. Anything the sweep finds that the contracts do not cover: get a decision on the right fix
   before changing code — a combination finding is exactly the kind of gap this sweep exists to
   close.
