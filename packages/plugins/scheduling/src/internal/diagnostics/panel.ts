// docs/specs/plugins/scheduling.md §8 — the opt-in diagnostics panel DOM: a toggle button opening
// the findings list, mounted into whichever corner slot the `overlay-corner` claim resolves to.
//
// Hostless: the module builds and wires DOM off a host element, a corner and callbacks; `wire.ts`
// owns mounting, the slot claim, rAF coalescing and disposal. All colors come from theme tokens
// through `var()` with fallbacks, and every style is inline because the panel is opt-in and must not
// touch the bundled stylesheet. One deliberate change from the earlier implementation, which
// hardcoded the top-left corner: this arbitrates it (§3.2's `overlay-corner` claim, the same
// four-corner precedent — `slotStyles` below mirrors
// `@stargantt/plugin-interaction`'s `internal/filter/toolbar.ts` `slotStyles`, generalized the same
// way to all four corners) and positions through whichever corner the grant resolves to.
const MARGIN = 8;

/** The four corners of the chart pane's safe area a corner-anchored overlay can occupy. */
export type DiagnosticsCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** Every corner name this feature knows, for the slot claim's candidate vocabulary. */
export const DIAGNOSTICS_CORNERS: readonly DiagnosticsCorner[] = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
];

export function isDiagnosticsCorner(value: string | undefined): value is DiagnosticsCorner {
  return value !== undefined && (DIAGNOSTICS_CORNERS as readonly string[]).includes(value);
}

/**
 * The corner-slot positioning, generalized to all four corners (the earlier implementation
 * hardcoded top-left) — the same generalization `@stargantt/plugin-interaction`'s filter toolbar
 * applies to its own top-right default.
 */
export function slotStyles(corner: DiagnosticsCorner): Record<string, string> {
  const vertical =
    corner === "top-left" || corner === "top-right"
      ? { top: `calc(var(--sg-safe-top, 0px) + ${String(MARGIN)}px)` }
      : { bottom: `calc(var(--sg-safe-bottom, 0px) + ${String(MARGIN)}px)` };
  const horizontal =
    corner === "top-left" || corner === "bottom-left"
      ? { left: `calc(var(--sg-safe-left, 0px) + ${String(MARGIN)}px)` }
      : { right: `calc(var(--sg-safe-right, 0px) + ${String(MARGIN)}px)` };
  return { ...vertical, ...horizontal };
}

/**
 * The width the slot has between its own edges and the safe area's opposite edges. `100%` resolves
 * against the chart pane (the root's containing block), so this is a pane-relative cap rather than a
 * fixed pixel maximum: at the 720x540 floor, where the pane is clamped to `--sg-chart-min-width`, it
 * shrinks with the pane instead of overhanging it.
 */
const AVAILABLE_WIDTH =
  `calc(100% - var(--sg-safe-left, 0px) - var(--sg-safe-right, 0px) - ${String(MARGIN * 2)}px)` as const;
const AVAILABLE_HEIGHT =
  `calc(100% - var(--sg-safe-top, 0px) - var(--sg-safe-bottom, 0px) - ${String(MARGIN * 2)}px)` as const;

/** One rendered category of the findings list. */
export interface PanelSection {
  /** The section heading, already built (the shared catalog's own throw-guard applies — §12). */
  heading: string;
  /** One line per finding, already built. */
  items: readonly string[];
}

export interface PanelCallbacks {
  /** The toggle button's current text (contains the finding count). */
  buttonText(): string;
  /** The non-empty sections of the current report, in issue order. */
  sections(): readonly PanelSection[];
}

export interface PanelOptions {
  /** The accessible label of the findings list. */
  panelLabel: string;
  /** Shown instead of sections when the report is clean. */
  noIssues: string;
  /** The corner the `overlay-corner` claim resolved to. */
  corner: DiagnosticsCorner;
}

export interface Panel {
  /** The panel root, to be appended into the chart pane by the caller. */
  root: HTMLElement;
  /** Re-derives the button text and, when the list is open, rebuilds it (data changed). */
  refresh(): void;
  /** Closes the findings list when open (outside click / Escape); no-op otherwise. */
  close(): void;
  /** Whether the node is inside the panel — drives the caller's outside-click close. */
  contains(node: unknown): boolean;
}

export function createPanel(host: HTMLElement, opts: PanelOptions, cb: PanelCallbacks): Panel {
  const doc = host.ownerDocument;

  const root = doc.createElement("div");
  root.className = "sg-diagnostics";
  Object.assign(root.style, {
    position: "absolute",
    ...slotStyles(opts.corner),
    // The whole box — button and open findings list alike — stays inside the safe area, at the
    // 720x540 floor as much as at full size: the caps below are pane-relative, and the list scrolls
    // internally once it runs out of room (see its `flex` / `overflow-y` below).
    minWidth: `min(220px, ${AVAILABLE_WIDTH})`,
    maxWidth: `min(360px, ${AVAILABLE_WIDTH})`,
    maxHeight: AVAILABLE_HEIGHT,
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: "4px",
    zIndex: "30",
    // Scaffolding, not a target. The root's box is as wide as the widest child — wider than the
    // toggle button whenever the list is open or the 220px floor applies — so leaving it
    // pointer-transparent keeps a press beside the button reaching the chart behind it. Each real
    // control re-enables itself.
    pointerEvents: "none",
    font: "12px system-ui, sans-serif",
  });

  const button = doc.createElement("button");
  button.className = "sg-diagnostics-button";
  button.setAttribute("type", "button");
  button.setAttribute("aria-haspopup", "true");
  button.setAttribute("aria-expanded", "false");
  Object.assign(button.style, {
    // ~28px tall including the border — comfortably above the 24px minimum pointer-target height;
    // the finding count lives in the text, so status is never color-only.
    padding: "5px 10px",
    border: "1px solid var(--sg-grid-line, #d0d0d0)",
    borderRadius: "4px",
    background: "var(--sg-bg, #ffffff)",
    color: "var(--sg-fg, #1c1917)",
    cursor: "pointer",
    flex: "0 0 auto",
    maxWidth: "100%",
    pointerEvents: "auto",
  });
  root.appendChild(button);

  const list = doc.createElement("div");
  list.className = "sg-diagnostics-panel";
  // `aria-label` on a generic (role-less) element is not exposed by assistive technology;
  // `role="group"` makes the accessible name mandated by §8 actually reach AT.
  list.setAttribute("role", "group");
  list.setAttribute("aria-label", opts.panelLabel);
  // Programmatically/click focusable (not in the tab order): a press inside the findings moves
  // focus into the list, so its Escape handler can genuinely fire.
  list.tabIndex = -1;
  Object.assign(list.style, {
    alignSelf: "stretch",
    flex: "0 1 auto",
    minHeight: "0",
    maxHeight: "320px",
    overflowY: "auto",
    pointerEvents: "auto",
    padding: "8px 10px",
    border: "1px solid var(--sg-grid-line, #d0d0d0)",
    borderRadius: "4px",
    background: "var(--sg-bg, #ffffff)",
    color: "var(--sg-fg, #1c1917)",
    boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
    display: "none",
  });
  root.appendChild(list);

  let open = false;

  function rebuildList(): void {
    list.textContent = "";
    const sections = cb.sections();
    if (sections.length === 0) {
      const empty = doc.createElement("div");
      empty.className = "sg-diagnostics-empty";
      empty.textContent = opts.noIssues;
      empty.style.color = "var(--sg-muted-fg, #78716c)";
      list.appendChild(empty);
      return;
    }
    for (const section of sections) {
      const heading = doc.createElement("div");
      heading.className = "sg-diagnostics-heading";
      heading.textContent = section.heading;
      heading.style.fontWeight = "600";
      heading.style.margin = "6px 0 2px";
      list.appendChild(heading);
      const ul = doc.createElement("ul");
      ul.className = "sg-diagnostics-items";
      Object.assign(ul.style, { margin: "0", padding: "0 0 0 16px" });
      for (const item of section.items) {
        const li = doc.createElement("li");
        li.textContent = item;
        li.style.padding = "1px 0";
        ul.appendChild(li);
      }
      list.appendChild(ul);
    }
  }

  function setOpen(next: boolean): void {
    if (next === open) return;
    open = next;
    list.style.display = next ? "block" : "none";
    button.setAttribute("aria-expanded", String(next));
    if (next) rebuildList();
  }

  function refreshButton(): void {
    button.textContent = cb.buttonText();
  }

  button.addEventListener("click", () => setOpen(!open));
  // Escape cancels the in-progress interaction: the open list closes, focus returns to the toggle
  // button, nothing else changes. Attached to both the button and the list directly (not delegated)
  // so it works the same whether focus sits on the toggle or inside the findings — the list's
  // `tabIndex = -1` above is what lets a pointer press move focus into it, making its handler
  // genuinely reachable.
  const onEscape = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || !open) return;
    setOpen(false);
    button.focus();
    event.stopPropagation();
  };
  button.addEventListener("keydown", onEscape);
  list.addEventListener("keydown", onEscape);

  refreshButton();

  return {
    root,
    refresh(): void {
      refreshButton();
      if (open) rebuildList();
    },
    close(): void {
      setOpen(false);
    },
    contains(node: unknown): boolean {
      return root.contains(node as Node);
    },
  };
}
