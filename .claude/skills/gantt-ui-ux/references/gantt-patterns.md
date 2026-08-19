# Gantt-Chart-Specific UI/UX

## Timeline Scale Readability

- Always render at least two header tiers (e.g., "August 2026" above "M T W T F") so users have coarse and fine time reference without counting cells.
- Tick label density adapts to zoom — never let labels overlap or truncate silently; prefer hiding every other label over overlapping text.
- Gridline weight stays subordinate to bar weight.

## Task Bar Affordances

- **Resize handles**: visible on hover/focus at bar edges; ≥24×24px *hit area* even if visual width is 4–6px (Fitts + WCAG target size).
- **Progress fill**: distinct layer inside the bar (partial fill or overlay pattern); must not obscure the task label.
- **Dependency arrows**: orthogonal/elbow routing avoiding unrelated bars where possible; arrowheads unambiguous about direction; FS/SS/FF/SF ideally distinguished by connector attachment point, not tooltip alone.
- Milestones (diamonds) and summary bars (bracket-style) need distinct shapes from normal bars — size alone fails when summary bars are thin at some zooms.

## Tree Grid + Chart Split-Pane Conventions

- Shared vertical scroll position and identical row heights are non-negotiable — even one row of drift breaks the whole mental model.
- Resizable splitter with clear grab affordance (≥8px hit area, cursor `col-resize`).
- Collapsing a summary row in the tree grid simultaneously hides its children's bars in the chart pane — no partial states.

## Today-Line & Weekend Shading

- Today-line: thin (1–2px), high-contrast but not overpowering; a distinct hue not reused elsewhere (never the same red as critical path).
- Weekend/holiday shading: low-contrast tint (~3–8% opacity difference from base), consistent across the entire chart height including header.

## Dependency Visualization

- Highlight the full dependency chain (predecessors + successors) on hover/select — one of the highest-value discoverability features, frequently missing.
- Avoid arrow spaghetti at scale: consider auto-hiding arrows beyond N hops, or a focus mode dimming unrelated bars.

## Drag-to-Reschedule Feedback

- Show the new computed start/end date live in a small label near the cursor/bar during drag — never drop-then-check.
- If auto-scheduling cascades to dependents, show a live preview of affected downstream bars *during* the drag. Silent cascading changes are the #1 trust-breaker in gantt tools.

## Critical Path

- Distinct treatment not relying on color alone (thicker stroke or pattern).
- Toggleable — always-on critical path adds noise for non-PM users.

## Anti-Patterns (avoid explicitly)

- Zoom resets scroll position or loses selection.
- Dependency lines rendered above bar text, obscuring labels.
- Snapping with no visual snap indicator.
- Undo granularity too coarse (reverts unrelated prior edits) or too fine (per-mousemove steps).
- Today-line or weekend shading with higher contrast than task bars (inverted figure/ground).
- Tree-grid and canvas rows drifting out of vertical sync during fast scroll (virtual-scroll rounding bug).
- Resize handle hit area equal to the 1–2px visual line — bars nearly impossible to grab.
