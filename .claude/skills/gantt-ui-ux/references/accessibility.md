# Accessibility (WCAG 2.2 AA)

## Keyboard Operability (WCAG 2.1.1)

- Every canvas-rendered interactive element (task bar, dependency endpoint, resize handle) must have a keyboard-operable equivalent via the parallel ARIA DOM.
- Moving/resizing tasks via keyboard (arrow keys shift dates, Shift+arrow resizes) is required, not optional — canvas has no native focus.

## Focus Visibility (2.4.7 Focus Visible, 2.4.11 Focus Not Obscured)

- Clearly visible focus indicator: ≥3:1 contrast against adjacent colors, ≥2px outline or equivalent, rendered on canvas in sync with the ARIA DOM's focused row/cell.
- Focus must never be scrolled under or covered by sticky headers or tooltips.

## ARIA Treegrid Pattern (WAI-ARIA APG)

- Root: `role="treegrid"`.
- Rows: `role="row"` with `aria-level`, `aria-expanded` (summary tasks), and `aria-posinset`/`aria-setsize` when virtualization makes DOM index ≠ logical index.
- Cells: `role="gridcell"` with `aria-selected` where applicable.
- **Roving tabindex**: exactly one row/cell has `tabindex="0"`; all others `-1`; arrow keys move roving focus programmatically.
- Render ARIA nodes for the visible virtualized range only, but set `aria-rowcount`/`aria-colcount` to the *full* logical dataset so assistive tech announces "row 42 of 10,000" correctly.

## Color Not the Sole Indicator (1.4.1)

- Critical path, over-allocation, overdue status, dependency type — all distinguishable by shape/pattern/text/icon in addition to color.

## Target Size (2.5.8 Target Size Minimum — WCAG 2.2 AA)

- Pointer targets **≥ 24×24 CSS px**, OR equivalent spacing (a 24px circle centered on the target overlaps no other target), OR a valid exception (inline text link, essential, user-agent-controlled).
- Applies directly to: resize handles, dependency connector dots, expand/collapse carets, small toolbar icons.
- Where the visual affordance must stay thin (4px resize edge), reach 24px via padding/hit-testing.

## Reduced Motion (2.3.3, `prefers-reduced-motion`)

- Respect `prefers-reduced-motion: reduce` — disable/shorten drag-preview easing, auto-scroll acceleration curves, animated cascade highlighting.
- Provide an instant-state fallback; never remove the feedback entirely.

## Additional Practical Notes

- `aria-live="polite"` regions for asynchronous action outcomes ("3 dependent tasks rescheduled") so screen-reader users get the same feedback sighted users get visually.
- Zoom controls, undo/redo, and toolbar actions are real `<button>`s with accessible names — never canvas-drawn icons with no DOM equivalent.
- Text spacing (1.4.12): dense rows must tolerate user-agent font-size/line-height overrides without clipping; test at 200% browser zoom.
