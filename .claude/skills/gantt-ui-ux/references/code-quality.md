# Code Quality for StarGantt Plugins

Hard-won rules from the 2026-08 whole-repo refactoring audit (24 targets, 21 smell categories). These are about *how* to build UI code that stays correct, not how it looks. Apply them when writing or reviewing any plugin code.

## 1. setup()/activate() is wiring, not logic

The single worst repo-wide smell was 275–965-line setup closures holding 6–18 mutable variables. Symptoms and rules:

- **setup() registers things; internal modules do things.** Extract pure logic (geometry, state machines, formatting, caching) into `internal/*.ts` files that can be unit-tested without booting a host. If testing a helper requires `Gantt.create()` plus 8 plugins, the helper is in the wrong place.
- `/* --- §x --- */` section comments inside one function are a confession that module boundaries already exist — make them files.
- A local function inside setup() cannot be unit-tested; its bugs surface only through a 1,000+-line integration test file. Test-file bloat is a *symptom* of setup bloat.
- One feature = one internal module + a registration line in setup (e.g. scrollbar, insets, pointer routing). Never let a feature smear across four regions of a god function.

## 2. State machines: one object, named transitions

- Multiple cooperating mutable flags (`isApplying`, `suppressNext`, `inShiftRange` …) with `try/finally` resets are an event-loop smell (see §4). Six such flags coexisted in one plugin.
- Model interaction state (hover, drag, edit session) as **one** object/closure with explicit transitions (`onHit/onLeave/onDismiss/onClick`, or an edit-session `open/commit/cancel`), not 5–6 free variables read and written from several handlers.
- If two pointer state machines coexist (gesture vs. thumb-drag vs. hover), their mutual exclusion must be code (single owner/claim), not a comment.

## 3. Lifecycle and `ctx.own()` discipline

- Register each long-lived resource with `ctx.own()` **exactly once**. For re-armed timers, own one disposable in setup that clears "the current timer variable"; re-arm by swapping the variable. Registering a new disposable per re-arm leaks monotonically (real bug: today-line).
- `ctx.on()` already auto-owns its subscription — wrapping it again in `ctx.own(ctx.on(...))` double-disposes. Know what the core owns for you.
- Anything evaluated once at setup that refers to DOM created later (pane lookups, ResizeObserver targets) must be re-resolved on `lifecycle/ready` — plugin activation order is not layout order.

## 4. Event discipline

- **Never build A→B→A loops cut by re-entrancy flags.** If handling your own downstream event needs suppression, pass a `cause` field (`"keyboard" | "pointer" | "api"`) in the call/event instead and branch on it. This deletes flags and `finally` blocks with identical behavior.
- Never rely on subscriber execution order — the EventBus has no priorities. If a behavior depends on "selection's handler runs first", it is a latent bug; restructure or pin it with a regression test that documents the dependency.
- Do not overload an event's meaning. `rows/changed` ("visible row set changed") must not double as "column width changed" — subscribers recompute row geometry at pointer frequency. New meaning ⇒ new event, and pointer-driven emissions are throttled to once per animation frame.
- Payload shapes are contracts: don't assume `Set` vs array beyond what the contract states.

## 5. Typed seams — make drift a compile error

- **Never hand-copy a sibling's type or constant.** The hand-written `ExportTile` copy silently missed the `rangeStart`/`rangeEnd` extension and shipped a real rendering bug (tile-seam discontinuity). `import type` the real thing.
- Contributing to another plugin's extension point requires its augmentation to be loaded: `import type {} from "@stargantt/plugin-<owner>"`. Without it the contribution type-checks as `unknown` — i.e., not at all. Extension-point keys are closed (`keyof ExtensionPoints`), so an undeclared key is a type error; keep it that way.
- Type-only cross-plugin imports are devDependencies; runtime value imports are dependencies. `@stargantt/core` used as a value belongs in `dependencies` — a peer/dev-only entry breaks standalone installs (real bug: auto-schedule).
- Closed unions (`Patch`, `ScaleUnit`, …) get **exhaustiveness enforcement**: table-driven dispatch typed `satisfies Record<Union["op"], …>`, or at minimum a `never` check in every switch. A switch without one turns a future variant into a silent no-op (e.g. partial undo).

## 6. Cross-plugin duplication

- Geometry, calendar math, and DOM-shape knowledge cross plugin boundaries only through public services: `TaskBarsService.barBoxOf()`, `TimelineService` unit boundaries, `ViewService.chartPaneElement()`. Never re-derive a sibling's pixel math or hardcode its class names (`.sg-pane--chart` was copied in 5 packages; a renderer DOM change would break them all silently).
- Micro-helpers (`listen`, `isoDay`, `MS_DAY`, numeric token parsing) live in `@stargantt/sdk`. Don't fork another copy.
- Numeric layout constants shared with CSS are CSS custom properties read via `getComputedStyle`, not TS literals manually mirrored in `styles.css`. The theme registry has a 1:1 consistency test — add new tokens there.
- If duplication is temporarily unavoidable, add a conformance test asserting the two implementations agree, in the same change.

## 7. Test quality

- Use the shared `@stargantt/sdk` testing harness (`createTestHost` and friends). Forked per-package fake-DOM copies drift apart and each fork's gaps become invisible test holes — extend the shared harness upstream instead of forking it.
- Assert **behavior, not implementation**: real host + real plugin, observe DOM/events/service output. Mock-call-count assertions (`own` called N times) and monkey-patching provided services break on harmless refactors and pass on real bugs.
- Never assert on source text (`readFileSync` + regex) — a comment edit breaks it and a real regression can pass it.
- A fake-DOM fixed rect (400×300) proves arithmetic, not layout. Anything that depends on real layout (clamps, pane widths, font measuring) gets its final verification in E2E against `examples/*.html`.
- Test snapshot helpers must cover *all* stores they claim to snapshot — a `snapshot()` that omits resources lets rollback corruption pass.
- E2E: no fixed `waitForTimeout` — use web-first assertions (`toBeVisible`) or `expect.poll`. A timeout that "skips politely" under CI load silently shrinks coverage. Screenshot green means "not broken", never "fixed" — pair every screenshot with at least one structural/numeric assertion (zoom-levels regression precedent).
- Export/encoding paths (`toBlob`, `toDataURL`, SVG output) must be exercised in a real browser at least once; unit doubles cannot vouch for them.

## 8. Perceived-performance hygiene in code structure

- No per-frame/per-item service lookups in hot draw loops — resolve once, cache, and keep the pattern symmetric with sibling code.
- No O(tasks × buckets) scans when equal spacing allows direct index computation (real case: 8.2×10⁸ iterations at 100k tasks).
- One truth source per measurement (e.g. pane width = `state.width`); parallel sources (state vs. `getBoundingClientRect`) diverge exactly when it matters.
- Forced layout reads (`getComputedStyle`, `getBoundingClientRect`) don't belong inside per-frame loops — hoist and cache against resize/theme events.
