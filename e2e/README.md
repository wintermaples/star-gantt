# E2E tests

Playwright end-to-end tests for StarGantt.

- **Target the build, not the source.** Specs load the `examples/*.html` pages, which pull in the
  built bundle from `../packages/stargantt/dist/stargantt.iife.js`. Run `pnpm run build` before
  `pnpm run test:e2e` — testing against a stale or missing `dist/` produces false greens or false
  reds.
- **Config:** `../playwright.config.ts` (repo root). It starts a Vite dev server over the repo root
  so the examples' relative `../packages/...` paths resolve unchanged.
- **Port isolation:** the dev server defaults to port 4173. Set `STARGANTT_E2E_PORT` to run on a
  different port — useful when multiple agents or CI jobs run `pnpm run test:e2e` concurrently and
  would otherwise race on the same port.
- **`readonly.spec.ts`** is the foundation spec: display, scroll, zoom and theme-toggle
  coverage for `examples/basic.html`, composed from the foundation preset (data-store, view,
  tree-grid, task-bars). `--pass-with-no-tests` is removed from the root `test:e2e` script so a
  broken `testDir`/glob matching zero tests fails instead of reporting a false green.
  `_fixtures.ts` carries the shared `openExample` / `settle` / page-error-collection helpers every
  spec should import `test`/`expect` from.
- **`interaction.spec.ts`** covers `examples/interaction.html`: pointer/keyboard bar drag
  and resize with undo, selection (click/Ctrl/Shift/rubber-band), roving-focus keyboard editing,
  tooltip, context menu, the edit dialog, the side panel, filter/search and the zoom toolbar —
  every interaction/undo-redo/a11y peripheral feature turned on.
- **`scheduling.spec.ts`** covers `examples/scheduling.html`: dependency links (creation,
  selection, routing), the auto-scheduling engine's propagation, schedule modes, working-calendar
  snapping, critical-path classification, the schedule-diagnostics panel and a 10k-task reschedule
  performance budget — link-line assertions are canvas pixel probes, since StarGantt paints links rather
  than mounting per-link DOM nodes.
- **`export.spec.ts`** covers the `stargantt.export` facade composed onto
  `examples/scheduling.html`: PNG/JPEG/SVG capture, PDF pagination, the print preview dialog,
  CSV/JSON/iCal/Excel/MSPDI interchange, read-only vetoes and snapshot restore — decoded pixel
  data and parsed byte signatures throughout, no smoke tests.
- **`tracking.spec.ts`** covers `examples/tracking.html`: the opt-in tracking plugin's four
  nests — baseline capture and slip-triangle painting, RAG badges and the status-date progress
  line, the cost table panel (modal, one undo step) and the EVM KPI dashboard — composed on top of
  `presetStandard()`.
- **`resource.spec.ts`** covers `examples/resource.html`: the opt-in resource plugin's pool
  and assignment editing (including lane-drag reassignment through the interaction arbiter),
  overallocation warnings (glyph + grid column), the resource-view strip and the load chart (band,
  lanes, heatmap corner, service-driven strip toggling with restore-last-height).
- **`data-sync.spec.ts`** covers `examples/data-sync.html`: the bundle surface for the four
  opt-in data-sync plugins (factories + data-sync's hostless adapter/transport factories +
  `createDictionary`), the offline snapshot round-trip through real IndexedDB across a real page
  reload (save → reload → restore, with a clear-offline negative arm using the identical gesture),
  the pending-tracker 1→0 pair around the bulk-replacement clear, and an in-page i18n
  `createDictionary`/`catalog()` smoke. No screenshot baselines; lazy/realtime areas are unit-only
  (zero-server E2E policy).
