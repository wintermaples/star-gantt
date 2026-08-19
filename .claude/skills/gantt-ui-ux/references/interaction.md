# Interaction Patterns for Data-Dense Desktop Apps

## Drag & Drop

- Always show a **live preview** (ghost bar, drop-line indicator) during drag — never wait until drop.
- Use a **drag threshold** (~4–5px) before starting a drag, to distinguish from click.
- Provide persistent **cursor signifiers** (`grab`/`grabbing`, `ew-resize`, `col-resize`) — canvas rendering requires manual hit-testing to swap the CSS cursor.
- Cancel-on-Escape must fully revert state, no partial commit.

## Hover & Tooltip

- Delay tooltip appearance ~300–500ms (avoid spam while scanning); dismiss instantly on mouseout.
- A tooltip must never block the element it describes or the adjacent draggable edge.
- On dense charts, prefer a status-bar/inline detail panel over tooltip-only for critical info — tooltips fail for keyboard focus and touch.

## Selection Models

- Single click = select/replace; Shift+click = range; Ctrl/Cmd+click = toggle add (spreadsheet/file-manager convention).
- Rubber-band (marquee) select on empty chart canvas drag.
- Selection state visually distinct from hover state — different stroke weight or fill, not just color.

## Keyboard Navigation

- Arrow keys move focus row/column in the treegrid; Enter opens inline edit; Escape cancels; Tab moves between panes/controls in DOM tab order via a roving-tabindex anchor.
- Space/Enter on a bar or milestone opens the same edit affordance as double-click.
- Ctrl/Cmd+Z and Shift+Ctrl/Cmd+Z for undo/redo, matching OS convention.

## Context Menus

- Right-click offers scoped actions only (no global actions mixed with row actions).
- ≤9 visible items; submenu for rare actions.

## Inline Editing

- Double-click or F2 enters edit mode; commit on blur/Enter, cancel on Escape.
- Validate live, not just on commit.

## Scrolling & Zooming (Timeline)

- Vertical scroll = rows (virtualized); horizontal scroll = time. They must not fight — support independent trackpad axes and explicit scrollbar trays.
- Zoom uses **discrete named levels** (day/week/month/quarter/year), not continuous — continuous zoom causes label overlap/thrash near breakpoints.
- Zoom anchors on cursor position or viewport center — never reset to chart start. Losing place while zooming is a top gantt UX complaint.
- Ctrl/Cmd+scroll or a dedicated zoom control — never bare scroll wheel (accidental zoom while reading).

## Snapping

- Drag/resize snaps to the active timeline grid unit with a **visible snap indicator** (highlighted gridline). Silent snapping feels like "sticky" broken dragging.

## Undo/Redo Expectations

- Every discrete user-visible change (move, resize, link, delete, bulk edit) = exactly one undo step.
- Intermediate drag frames must NOT create undo steps — commit only on drop.
- Selection state should be reasonably preserved across undo; scroll position restoration is not required.

## Feedback Latency Budgets

Nielsen's classic thresholds, baseline for the RAIL model:

- **0.1s** — feels instantaneous; required for direct-manipulation feedback (drag preview, hover highlight, keypress echo). Miss this and dragging feels laggy.
- **1.0s** — noticeable delay but flow of thought uninterrupted; acceptable for opening a context menu, committing an edit, single filter apply. No spinner needed, but never block the main thread.
- **10s** — attention limit; anything near it (bulk import, 100k auto-schedule) **must** show progress and remain cancelable.
- **RAIL** (Google): Response ≤100ms; Animation frames ≤16ms (treat 8–10ms as the actual JS budget, leaving compositing headroom); Idle work chunked in ~50ms tasks; Load fast.
