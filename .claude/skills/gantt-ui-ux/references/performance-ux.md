# Performance as UX

## Perceived Performance > Raw Performance

An operation taking 400ms with immediate optimistic feedback (bar moves at frame 1, confirmation lands later) feels faster than a 200ms operation with no feedback until completion.

## Latency Budgets per Interaction

- Pointer-down → visual response (cursor change, hover highlight): **≤100ms**, ideally same frame (~16ms).
- Drag movement → bar position update: **every frame, ≤16ms**, no frame skipping during active drag — the highest-scrutiny path; jank here is immediately perceived as broken.
- Drop/commit → recalculated dependent positions (auto-schedule cascade): start rendering within **100ms**; if a full recompute exceeds that at 100k scale, show incremental/optimistic placement first, then reconcile.
- Virtual scroll → newly revealed rows painted **within 1 frame**; any placeholder-then-real flash breaks trust — pre-render an overscan buffer just outside the viewport.
- Zoom level change → full re-render **≤100ms**; if impossible at high task counts, show a cheap canvas/CSS scale transform immediately, then re-render crisp within ~1s. Never a blank/frozen frame.
- Undo/redo → state restored **≤100ms** — undo is a trust/safety-net feature; delay here disproportionately breaks trust.

## Frame Budget Discipline

- 60fps = ~16.6ms/frame; reserve ~8–10ms for StarGantt's own draw/layout work, leaving headroom for compositing and input.
- The 3-layer canvas split (background/main/overlay) exists for this: redraw only the layer(s) that changed — dragging one bar must not repaint the background gridline layer.

## Jank Sources to Avoid

- Synchronous layout thrash: reading DOM measurements between canvas draws.
- GC pressure: allocating new objects per frame during drag — reuse buffers.
- Recomputing Fenwick-tree row heights on every scroll tick instead of only on actual row-height changes.

## Optimistic UI

- Local edits (drag, resize, inline edit) that need no roundtrip: commit visually immediately; reconcile/rollback only on error.
- Never add artificial latency to operations the client can compute deterministically.
- Destructive or ambiguous operations (bulk delete affecting dependents) may keep a brief confirm step — optimism ≠ skipping confirmation.

## Loading / Long Operations

- For the >1s tier (large auto-schedule, big imports): determinate progress if computable, indeterminate otherwise.
- Keep the UI interactive and cancelable — never block the whole chart on a modal spinner if avoidable.
