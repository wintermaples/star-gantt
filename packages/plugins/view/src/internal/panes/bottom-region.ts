/**
 * Bottom-region wiring — one feature, one module (`.claude/skills/gantt-ui-ux/references/
 * code-quality.md` §1): creates the region element and its panes below the pane row, owns each
 * pane's horizontal divider (pointer and keyboard resize), applies height changes and publishes
 * them, and writes the gutter/body/trailing column widths the caller measures. The pure decisions
 * (normalization, clamping) live in `./bottom-panes`; the plugin's `setup()` only calls
 * {@link mountBottomRegion} and forwards its triggers.
 */
// docs/specs/plugins/view.md — "Bottom region" / "Bottom-pane columns" /
// "Horizontal divider" / "Bottom-pane height ownership" —
// docs/specs/plugins/view.md —.
import type { PluginContext } from "@stargantt/core";
import { listen } from "@stargantt/sdk";
import { bottomResizeBounds, normalizeBottomContributions } from "./bottom-panes";
import type { BottomPaneContribution, NormalizedBottomPane } from "./bottom-panes";
import { CLICK_THRESHOLD_PX } from "./drag-owner";
import type { DragClaim } from "./drag-owner";

/** What the plugin's wiring needs to hand the region at mount time. */
export interface BottomRegionDeps {
  ctx: PluginContext;
  /** The `.sg-pane-row` element the region sits under; also the drag clamp's `room` source. */
  row: HTMLElement;
  /** The collected `view/bottomPanes` contributions, in registration order. */
  contributions: readonly BottomPaneContribution[];
  /** Reports a contributor fault through `core/pluginError` with `{ point: "view/bottomPanes" }`. */
  fault(error: unknown): void;
  /** Measures the widths the three columns must take, from the live pane-row layout. */
  measureColumns(): { gutter: number; body: number; trailing: number };
  /** Called after every applied height change — the hook through which the side panes learn. */
  // docs/specs/plugins/view.md — "Side panes learn of a height change"
  onHeightApplied(id: string, height: number): void;
  /** Claims the plugin's single drag owner for a divider drag; refused while another drag runs. */
  claimDrag(claim: DragClaim): boolean;
  /** Installs the shared document-level pointer listeners the drag owner is fed from. */
  installDocListeners(doc: Document): void;
  /**
   * Moves focus to a still-visible anchor when `document.activeElement` sits inside any element
   * of `hiding` — the plugin's view-mode focus policy, invoked here before a pane whose height
   * reached 0 is hidden, so focus held on a surface a contribution mounted (or on the pane's
   * divider) never falls through to `<body>`.
   */
  // docs/specs/plugins/view.md — (the policy) (the hide it now guards).
  reanchorFocus(hiding: readonly HTMLElement[]): void;
  /**
   * Handed the mounted region after its panes and dividers exist but **before** any
   * contribution's `mount` runs, so the caller can wire `view/setBottomPaneHeight` and its
   * column refresh in time for a mount that dispatches them (the first-paint shape).
   */
  connect(region: BottomRegion): void;
}

/** The handle the plugin's wiring keeps: visibility, column rewrites and the height command. */
export interface BottomRegion {
  /** The region element — a direct child of the root, right after the pane row. */
  element: HTMLElement;
  /** Rewrites every pane's gutter/body/trailing widths from a fresh `measureColumns()` read. */
  writeColumns(): void;
  /** Shows or hides the whole region (the view-mode coupling: hidden whenever the chart is). */
  setHidden(hidden: boolean): void;
  /**
   * The `view/setBottomPaneHeight` implementation: clamps `height` to the pane's effective range
   * and applies it. An unknown id or a non-finite height is a no-op.
   */
  setHeight(id: string, height: number): void;
}

/** Bookkeeping per mounted bottom pane. */
interface BottomPaneState {
  n: NormalizedBottomPane;
  /** The pane's current height in CSS px — the single width-of-truth for every resize path. */
  height: number;
  pane: HTMLElement;
  gutter: HTMLElement;
  body: HTMLElement;
  trailing: HTMLElement;
  /** The pane's `role="separator"` divider; `null` for `resizable: false`. */
  divider: HTMLElement | null;
}

/**
 * Creates the bottom region under the pane row and mounts every usable contribution into it.
 * Returns `null` — and creates no element at all — when no usable contribution exists, so a
 * composition without bottom panes renders exactly as it did before the region existed.
 */
export function mountBottomRegion(deps: BottomRegionDeps): BottomRegion | null {
  const { ctx, row, fault } = deps;
  const { panes: normalized, duplicateIds } = normalizeBottomContributions(deps.contributions);
  // Duplicate ids keep the first contribution; later ones are reported and dropped.
  for (const id of duplicateIds) {
    fault(new Error(`duplicate view/bottomPanes contribution id "${id}"`));
  }
  if (normalized.length === 0) return null;

  const doc = row.ownerDocument;
  const region = doc.createElement("div");
  region.className = "sg-bottom-region";
  // Directly after the pane row: the root is a vertical stack, the row takes the
  // remaining height and the region's strips stack downward under it.
  ctx.root.insertBefore(region, row.nextSibling);
  // One disposer removes the region and, with it, every pane and divider inside.
  ctx.own({ dispose: () => region.remove() });

  const states: BottomPaneState[] = [];
  const byId = new Map<string, BottomPaneState>();

  // The token-read pattern: the stylesheet is the single source of truth for the
  // row's `min-height`; this reads the same `--sg-pane-row-min-height` value back so the drag
  // floor and the layout floor cannot diverge. `null` (no getComputedStyle, or an unparsable
  // value) drops the row-derived bound and the clamp degrades to `[floor, maxHeight]`.
  function readRowMinHeight(): number | null {
    if (typeof globalThis.getComputedStyle !== "function") return null;
    const raw = globalThis
      .getComputedStyle(ctx.root)
      .getPropertyValue("--sg-pane-row-min-height")
      .trim();
    const value = parseFloat(raw);
    return Number.isFinite(value) ? value : null;
  }

  function boundsFor(s: BottomPaneState): { min: number; max: number } {
    const rowMinHeight = readRowMinHeight();
    return bottomResizeBounds({
      resizable: s.n.resizable,
      minHeight: s.n.minHeight,
      maxHeight: s.n.maxHeight,
      currentHeight: s.height,
      rowHeight: rowMinHeight === null ? null : row.getBoundingClientRect().height,
      rowMinHeight,
    });
  }

  /**
   * Keeps the divider's `aria-value*` triad in sync with the clamp and the current height.
   * Callers that already computed the clamp (a drag captures it once at `pointerdown`, a keyboard
   * step computes it for its own clamp) pass it through as `bounds`, so the `getComputedStyle`
   * and rect reads inside `boundsFor` never run per pointermove frame
   * (`.claude/skills/gantt-ui-ux/references/code-quality.md` §8 — no forced layout reads in
   * per-frame paths).
   */
  function updateAria(s: BottomPaneState, bounds?: { min: number; max: number }): void {
    if (s.divider === null) return;
    const { min, max } = bounds ?? boundsFor(s);
    s.divider.setAttribute("aria-valuemin", String(min));
    if (Number.isFinite(max)) s.divider.setAttribute("aria-valuemax", String(max));
    else s.divider.removeAttribute("aria-valuemax");
    s.divider.setAttribute("aria-valuenow", String(s.height));
  }

  // A zero-height pane is not painted: `display: none` on the strip and its divider, so
  // neither occupies space nor holds a tab stop; both reappear the moment the height turns
  // positive. The pane stays mounted throughout. keeps every user gesture away from this
  // state, but a contributor can still drive a `resizable: false` pane to 0 — the
  // empty-roster lanes strip — while focus legitimately sits on a focusable surface the
  // contribution mounted, so before anything is hidden, focus held inside the strip or on its
  // divider is moved to a still-visible anchor through the caller's policy.
  function syncVisibility(s: BottomPaneState): void {
    const hidden = s.height === 0;
    if (hidden) {
      deps.reanchorFocus(s.divider === null ? [s.pane] : [s.pane, s.divider]);
    }
    s.pane.style.display = hidden ? "none" : "";
    if (s.divider !== null) s.divider.style.display = hidden ? "none" : "";
  }

  /**
   * Applies one already-clamped height and publishes it: the contribution's `onResize` (guarded),
   * the `view/bottomPaneResized` event, and the side-pane hook — but only when the height
   * actually changed. A non-finite target (`End` under an unbounded clamp) is a no-op.
   * `bounds` — when the caller already holds the clamp — is forwarded to `updateAria` so the
   * aria rewrite does not recompute it.
   */
  function applyHeight(
    s: BottomPaneState,
    height: number,
    bounds?: { min: number; max: number },
  ): void {
    if (!Number.isFinite(height) || height === s.height) return;
    s.height = height;
    s.pane.style.height = `${height}px`;
    syncVisibility(s);
    updateAria(s, bounds);
    if (s.n.onResize !== undefined) {
      // Foreign code behind the same fault barrier as `mount` (docs/specs/architecture.md §1.4).
      try {
        s.n.onResize(height);
      } catch (error) {
        fault(error);
      }
    }
    ctx.emit("view/bottomPaneResized", { id: s.n.id, height });
    deps.onHeightApplied(s.n.id, height);
  }

  for (const n of normalized) {
    // Every resizable pane gets one divider on its top edge; `resizable: false` renders
    // no divider at all — it gates the affordance only, never the command or the callbacks
    //.
    const divider = n.resizable ? doc.createElement("div") : null;
    if (divider !== null) {
      divider.className = "sg-pane-divider sg-pane-divider--horizontal";
      divider.setAttribute("role", "separator");
      divider.setAttribute("aria-orientation", "horizontal");
      divider.setAttribute("aria-label", n.label);
      divider.tabIndex = 0;
      region.appendChild(divider);
    }

    const pane = doc.createElement("div");
    pane.className = "sg-bottom-pane";
    pane.style.height = `${n.height}px`;
    const gutter = doc.createElement("div");
    gutter.className = "sg-bottom-pane__gutter";
    const body = doc.createElement("div");
    body.className = "sg-bottom-pane__body";
    const trailing = doc.createElement("div");
    trailing.className = "sg-bottom-pane__trailing";
    pane.appendChild(gutter);
    pane.appendChild(body);
    pane.appendChild(trailing);
    region.appendChild(pane);

    const state: BottomPaneState = { n, height: n.height, pane, gutter, body, trailing, divider };
    states.push(state);
    byId.set(n.id, state);
    syncVisibility(state);
    updateAria(state);

    if (divider !== null) {
      deps.installDocListeners(doc);
      // Pointer drag tracks `clientY`; dragging the divider up grows the pane below it
      // (delta = −dy). A press that never crosses the click threshold is a no-op — bottom panes
      // have no collapse. The clamp is captured once at pointerdown, like the side
      // dividers': its floor is the interactive floor, so no drag can hide the pane. The
      // captured clamp is also forwarded to each step's aria rewrite — it is invariant for the
      // whole drag (the room the pane gains is exactly the room the row loses), and forwarding
      // it keeps `getComputedStyle` and rect reads out of the pointermove frames.
      listen(ctx, divider, "pointerdown", (e: PointerEvent) => {
        const bounds = boundsFor(state);
        const startHeight = state.height;
        const startY = e.clientY;
        let moved = false;
        const claimed = deps.claimDrag({
          pointerId: e.pointerId,
          move: (ev) => {
            const dy = ev.clientY - startY;
            if (Math.abs(dy) >= CLICK_THRESHOLD_PX) moved = true;
            if (!moved) return;
            applyHeight(
              state,
              Math.min(bounds.max, Math.max(bounds.min, startHeight - dy)),
              bounds,
            );
          },
          up: () => {
            /* sub-threshold press: a click on a bottom divider does nothing (no collapse) */
          },
        });
        if (!claimed) return;
        // Keeps move/up flowing to this document when the pointer leaves the window mid-drag.
        try {
          divider.setPointerCapture(e.pointerId);
        } catch {
          /* pointer already gone — the pointercancel path releases the claim */
        }
      });

      // Keyboard resize: ArrowUp grows, ArrowDown shrinks, by the same 16 / 64 px
      // (with Shift) steps as the side dividers; Home / End jump to the effective range's ends.
      // Every handled key calls both preventDefault (no page scroll) and stopPropagation (no
      // in-chart binding on the same key may also fire).
      listen(ctx, divider, "keydown", (e: KeyboardEvent) => {
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          e.stopPropagation();
          const step = e.shiftKey ? 64 : 16;
          const delta = e.key === "ArrowUp" ? step : -step;
          const bounds = boundsFor(state);
          applyHeight(
            state,
            Math.min(bounds.max, Math.max(bounds.min, state.height + delta)),
            bounds,
          );
        } else if (e.key === "Home" || e.key === "End") {
          e.preventDefault();
          e.stopPropagation();
          const bounds = boundsFor(state);
          applyHeight(state, e.key === "Home" ? bounds.min : bounds.max, bounds);
        }
      });
    }
  }

  const controller: BottomRegion = {
    element: region,
    writeColumns(): void {
      const { gutter, body, trailing } = deps.measureColumns();
      for (const s of states) {
        s.gutter.style.width = `${gutter}px`;
        s.body.style.width = `${body}px`;
        s.trailing.style.width = `${trailing}px`;
      }
    },
    setHidden(hidden: boolean): void {
      region.style.display = hidden ? "none" : "";
    },
    setHeight(id: string, height: number): void {
      const s = byId.get(id);
      if (s === undefined || typeof height !== "number" || !Number.isFinite(height)) return;
      // Exactly 0 releases the strip: it is hidden outright, divider included, rather than being
      // floored at the interactive minimum. The floor exists so that no *gesture* can destroy the
      // affordance that performed it — a drag, a keyboard step or `Home` still stops at 24 — but a
      // programmatic 0 is a contributor or a host saying "this strip is not showing right now",
      // which is reversible by the same command and is the only way an opt-in strip can cost no
      // height at all. Anything strictly between 0 and the floor is still a gesture-shaped value
      // and clamps up.
      // docs/specs/plugins/view.md
      //.
      if (height === 0) {
        applyHeight(s, 0);
        return;
      }
      const bounds = boundsFor(s);
      applyHeight(s, Math.min(bounds.max, Math.max(bounds.min, height)), bounds);
    },
  };

  // The column widths are also rewritten when the row itself resizes — a host-container
  // resize changes the chart pane's flex-grown width without any divider moving. Guarded: a
  // headless environment without ResizeObserver simply skips the observer (the other rewrite
  // triggers still run).
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(() => controller.writeColumns());
    observer.observe(row);
    ctx.own({ dispose: () => observer.disconnect() });
  }

  // Wired — and the initial columns written — **before** any contribution's `mount` runs below:
  // a mount that dispatches `view/setBottomPaneHeight` (the roster formula's first-paint
  // shape) must hit the live command implementation, and one that dispatches `view/paneToggle`
  // must have its column refresh land on real writes, not the caller's pre-wiring no-ops.
  deps.connect(controller);
  controller.writeColumns();

  // Called exactly once per contribution, after the side panes are mounted and after the command
  // surface above is live, guarded by the same fault barrier as `view/panes` mounts
  // (docs/specs/architecture.md §1.4).
  for (const s of states) {
    try {
      s.n.mount({ pane: s.pane, gutter: s.gutter, body: s.body, trailing: s.trailing });
    } catch (error) {
      fault(error);
    }
  }

  return controller;
}
