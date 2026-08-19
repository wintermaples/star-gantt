---
name: gantt-ui-ux
description: Use when editing, reviewing, or designing any StarGantt gantt-chart code that affects what users see or do — rendering (canvas layers, task bars, timeline scale, tree grid), interaction (drag, resize, selection, keyboard, tooltip, context menu, zoom, snapping, undo/redo), accessibility (ARIA treegrid, focus, contrast), or performance-perceived behavior (frame budget, latency, optimistic UI). Mandatory for all gantt chart UI changes in this repository.
---

# Gantt UI/UX

## Overview

UI is the surface (pixels, controls, canvas draws, DOM overlay); UX is the outcome (comprehension, efficiency, error recovery, trust). For a gantt library the dominant discipline is interaction design: task bars, dependency lines, and tree rows are interaction surfaces, not static graphics. Direct manipulation (drag a bar to reschedule) beats dialog-driven editing.

**Viewport assumption (hard constraint):** tablet or wider — width ≥ 720px, height ≥ 540px. Never add phone/mobile layouts, hamburger collapse, or sub-720px breakpoints. Touch targets still matter (tablets), but layout is desktop-class.

## When to Use

- Before editing any code under `packages/plugins/` or `packages/core/` that changes rendering, interaction, layout, colors, timing, or accessibility.
- Before reviewing a diff that touches those areas.
- When designing a new plugin, contract section, or example page.

Not needed for: pure build config, docs typos, non-UI internals with no observable behavior change.

## Workflow

1. Identify which UX dimensions the change touches (rendering / interaction / a11y / perf).
2. Read the matching reference file(s) below BEFORE writing code.
3. Implement, honoring the hard numbers (contrast ratios, hit areas, latency budgets).
4. Run the pre-ship checklist below before claiming done.

## References

Read the relevant file(s), not all of them:

- `references/foundations.md` — UI vs UX definitions, Nielsen's 10 heuristics, Fitts's/Hick's/Jakob's laws, Gestalt, Norman affordance/signifier/feedback, progressive disclosure.
- `references/visual-design.md` — typography sizes, 8px grid, row heights, WCAG contrast ratios, visual hierarchy (figure/ground for today-line & weekend shading), pixel alignment, density.
- `references/interaction.md` — drag & drop, tooltips, selection models, keyboard nav, context menus, inline editing, timeline scroll/zoom, snapping, undo/redo granularity, latency budgets (0.1s/1s/10s, RAIL).
- `references/gantt-patterns.md` — timeline scale readability, task bar affordances, split-pane conventions, today-line/weekend shading, dependency visualization, drag-to-reschedule feedback, critical path, known anti-patterns.
- `references/accessibility.md` — WCAG 2.2 AA: keyboard operability, focus visibility, ARIA treegrid + roving tabindex + virtualization, color-not-sole-indicator, 24×24px target size, reduced motion.
- `references/performance-ux.md` — perceived performance, per-interaction latency budgets, 16ms frame budget & 3-layer canvas discipline, GC pressure, optimistic UI, loading states.
- `references/code-quality.md` — **always read when writing or reviewing plugin code**: setup()-as-wiring rule, state-machine consolidation, `ctx.own()` discipline, event re-entrancy/`cause` pattern, typed seams (no hand-copied sibling types, exhaustiveness enforcement), cross-plugin duplication rules (services + plugin-toolkit), test-quality rules (shared test-utils harness, behavior-not-mock assertions, no fixed sleeps).

## Quick Reference (hard numbers)

- Pointer targets: **≥ 24×24 CSS px hit area** (WCAG 2.2 §2.5.8), even if the visual affordance is a 4px edge.
- Contrast: text **≥ 4.5:1**; UI components/graphics (bar outlines, focus ring) **≥ 3:1**; weekend shading/today-line stays *below* bar contrast (ground, not figure).
- Latency: direct-manipulation feedback **≤ 100ms** (ideally same frame); drag updates **every frame ≤ 16ms** (~8–10ms JS budget); >1s operations need progress + cancel.
- Drag threshold ~4–5px; tooltip delay ~300–500ms; context menus ≤ 9 visible items.
- One undo step per user-visible commit — never per mousemove, never zero.
- Escape cancels any in-progress interaction with full revert.
- Tree-grid rows and chart rows: identical heights, pixel-aligned, shared vertical scroll — non-negotiable.
- Row height: dense 24–28px, comfortable 32–36px; text ≥ 12px in dense rows.
- Meaning never by color alone — pair with shape/pattern/text/icon.

## Pre-Ship Checklist

Run before claiming a UI change done:

1. Draggable/resizable elements have ≥24×24px hit areas.
2. Drag feedback renders every frame, no skips.
3. Visible hover/cursor signifier exists *before* interaction starts.
4. Full interaction possible keyboard-only, with visible focus indicator.
5. ARIA treegrid stays in sync (row count, expanded, selection, roving tabindex).
6. Escape cancels new in-progress interactions with full revert.
7. Exactly one undo step per user-visible commit.
8. New colors meet WCAG contrast (4.5:1 text, 3:1 UI).
9. New status/meaning conveyed by more than color.
10. Tree-grid and chart rows still pixel-aligned in height and scroll.
11. Today-line/weekend shading contrast subordinate to task bars.
12. Tooltips delayed ~300–500ms and never obscure the target or its handles.
13. Zoom preserves scroll anchor (cursor/viewport center) and selection.
14. Menus ≤9 visible items; rare actions behind progressive disclosure.
15. `prefers-reduced-motion` respected.
16. Operations >1s show progress and are cancelable; <100ms ops get no artificial spinner.
17. Profiled at 10k rows for dropped frames; 100k sanity-checked for operability.
18. No new per-frame allocations in hot draw/drag paths.
19. Dependency arrows/labels/bars remain readable at multiple zoom levels.
20. Screenshot baselines: default config unchanged unless intentional; intentional changes regenerated with `--update-snapshots=all` and verified by eye/DOM, not just "green".
21. Owned resources (listeners, DOM, timers) registered via `ctx.own()` — exactly once per resource; re-armed timers swap a variable, never re-own.
22. Layout verified at the minimum viewport 720×540 — no mobile fallbacks added.
23. New logic lives in `internal/*.ts` pure modules testable without a host; setup() only wires.
24. No new re-entrancy flags or event feedback loops — use a `cause` field; no reliance on subscriber order.
25. No hand-copied sibling types/constants/class names — use the public services, `import type`, or `@stargantt/plugin-toolkit`; closed unions keep exhaustiveness checks.
26. Tests use the shared `@stargantt/test-utils` harness, assert behavior (not mock call counts), and contain no fixed sleeps (`waitForTimeout`).

## Common Mistakes

- Hit area equals the 1–2px visual line → bars impossible to grab (Fitts's law violation).
- Silent snapping with no highlighted gridline → feels like broken "sticky" dragging.
- Zoom resets scroll position or drops selection.
- Dependency lines drawn above bar labels, obscuring text.
- Undo granularity too coarse (reverts unrelated edits) or too fine (per-mousemove steps).
- Ground elements (weekend shading, today-line) rendered with more contrast than bars, inverting figure/ground.
- Tree-grid and canvas rows drifting out of sync during fast scroll (virtual-scroll rounding bug).
- Cascading auto-schedule changes committed silently — preview affected downstream bars *during* drag.
