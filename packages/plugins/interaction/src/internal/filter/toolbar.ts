// docs/specs/plugins/interaction.md §3 (overlay-corner) / §6.8 — the opt-in search box + filter
// panel DOM, mounted into a corner slot of the chart pane's safe area (top-right by default).
/**
 * Hostless: the module builds and wires DOM off a host element and callbacks; `wire.ts` owns
 * mounting, event-bus wiring and disposal. All colors come from theme tokens through `var()` with
 * fallbacks — nothing is read via `getComputedStyle` here, and every style is inline because the
 * toolbar is opt-in and must not touch the bundled stylesheet.
 */
import { styled } from "@stargantt/sdk";
import type { ReadonlyDataView, Task } from "@stargantt/plugin-data-store";
import type { FilterFieldDef } from "./types";

/** The subset of the merged message catalog the toolbar reads (`InteractionMessages`, §8). */
export interface FilterToolbarMessages {
  searchPlaceholder: string;
  searchLabel: string;
  filterButton: string;
  filterPanelLabel: string;
  clearFilters: string;
  matchCount: (count: number) => string;
}

// docs/specs/plugins/interaction.md §3 — this plugin's own slot margin.
const MARGIN = 8;

/** The four corners of the chart pane's safe area a corner-anchored overlay can occupy. */
export type FilterCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** Every corner name this feature knows, for the slot claim's candidate vocabulary. */
export const FILTER_CORNERS: readonly FilterCorner[] = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
];

/** Whether a string names one of the four corners. */
export function isFilterCorner(value: string | undefined): value is FilterCorner {
  return value !== undefined && (FILTER_CORNERS as readonly string[]).includes(value);
}

/**
 * The corner-slot positioning generalizes to all four corners: this feature follows a refused
 * claim's proposed alternative (see `wire.ts`). `100%`/`0px` fallbacks
 * resolve against the chart pane (the root's containing block) so the box shrinks with the pane
 * at the 720x540 floor instead of overhanging it, and stay meaningful on a pane that published no
 * `--sg-safe-*` lengths at all (a composition with no header band / no scrollbar to avoid).
 */
export function slotStyles(corner: FilterCorner): Record<string, string> {
  const vertical =
    corner === "top-left" || corner === "top-right"
      ? { top: `calc(var(--sg-safe-top, 0px) + ${MARGIN}px)` }
      : { bottom: `calc(var(--sg-safe-bottom, 0px) + ${MARGIN}px)` };
  const horizontal =
    corner === "top-left" || corner === "bottom-left"
      ? { left: `calc(var(--sg-safe-left, 0px) + ${MARGIN}px)` }
      : { right: `calc(var(--sg-safe-right, 0px) + ${MARGIN}px)` };
  return { ...vertical, ...horizontal };
}

const AVAILABLE_WIDTH =
  `calc(100% - var(--sg-safe-left, 0px) - var(--sg-safe-right, 0px) - ${MARGIN * 2}px)` as const;
const AVAILABLE_HEIGHT =
  `calc(100% - var(--sg-safe-top, 0px) - var(--sg-safe-bottom, 0px) - ${MARGIN * 2}px)` as const;

export interface ToolbarCallbacks {
  /** Applies a new incremental-search query. */
  setQuery(text: string): void;
  /** Replaces the per-field value selections (the `FilterCriteria.fields` member). */
  setFieldSelections(selections: Record<string, readonly string[]>): void;
  /** Reads the field's values for one task, already latched against throws. */
  fieldValues(def: FilterFieldDef, task: Readonly<Task>): readonly string[];
  /** The current data view, read when the panel opens to list the distinct values. */
  view(): ReadonlyDataView;
  /** The current match-counter text, or `""` while no filter is active. */
  counterText(): string;
}

export interface ToolbarOptions {
  searchBox: boolean;
  filterPanel: boolean;
  fields: readonly FilterFieldDef[];
  messages: FilterToolbarMessages;
  /** The corner the slot registry granted (defaults to `"top-right"`). */
  corner?: FilterCorner;
}

export interface Toolbar {
  /** The toolbar root, to be appended into the chart pane by the caller. */
  root: HTMLElement;
  /** Re-reads the match counter; called on every effective filter-state change. */
  refreshCounter(): void;
  /** Closes the filter panel when open (outside click / Escape); no-op otherwise. */
  closePanel(): void;
  /** Whether the node is inside the toolbar — drives the caller's outside-click close. */
  contains(node: unknown): boolean;
}

/** Distinct values one field takes over the whole store, sorted, capped to keep the panel usable. */
export function distinctValues(
  def: FilterFieldDef,
  view: ReadonlyDataView,
  read: (def: FilterFieldDef, task: Readonly<Task>) => readonly string[],
  cap = 200,
): string[] {
  const seen = new Set<string>();
  for (const task of view.byId.values()) {
    for (const v of read(def, task)) {
      seen.add(v);
      if (seen.size >= cap) break;
    }
    if (seen.size >= cap) break;
  }
  return [...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function createToolbar(host: HTMLElement, opts: ToolbarOptions, cb: ToolbarCallbacks): Toolbar {
  const doc = host.ownerDocument;
  const { messages } = opts;
  const corner: FilterCorner = opts.corner ?? "top-right";

  const root = doc.createElement("div");
  root.className = "sg-filter-toolbar";
  styled(root, {
    position: "absolute",
    ...slotStyles(corner),
    // The whole box — controls and open filter panel alike — stays inside the safe area, at the
    // 720x540 floor as much as at full size: the caps are pane-relative, the control row wraps
    // rather than overhanging, and the panel scrolls internally once it runs out of room. The
    // floor width keeps a value list from opening as a sliver; it yields to the slot when the slot
    // is the narrower of the two.
    minWidth: `min(180px, ${AVAILABLE_WIDTH})`,
    maxWidth: AVAILABLE_WIDTH,
    maxHeight: AVAILABLE_HEIGHT,
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: "4px",
    zIndex: "30",
    // Scaffolding, not a target. The root's box spans the widest of its children — wider than the
    // control row whenever the filter panel is open — so leaving it pointer-transparent keeps a
    // press beside the controls reaching the chart behind it. Each real control re-enables itself.
    pointerEvents: "none",
    font: "12px system-ui, sans-serif",
  });

  // The controls, on their own line above the panel. It wraps rather than overhanging the slot:
  // at the 720px floor the search box alone fills the pane's clamped width, so the counter and
  // the filter button move to a second line instead of being clipped by the pane's `overflow`.
  const controls = doc.createElement("div");
  controls.className = "sg-filter-toolbar-controls";
  styled(controls, {
    alignSelf: "stretch",
    minWidth: "0",
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: "4px",
    alignItems: "center",
    // Transparent like the root: the gaps and the slack this row leaves when it is stretched wider
    // than its controls are not targets either.
    pointerEvents: "none",
  });
  root.appendChild(controls);

  /** Per-field selected values, mirrored into the criteria on every checkbox change. */
  const selections = new Map<string, Set<string>>();

  let input: HTMLInputElement | undefined;
  if (opts.searchBox) {
    input = doc.createElement("input") as HTMLInputElement;
    input.className = "sg-filter-search-input";
    input.setAttribute("type", "search");
    input.setAttribute("placeholder", messages.searchPlaceholder);
    input.setAttribute("aria-label", messages.searchLabel);
    styled(input, {
      // ~28px tall including the border: the same order as a grid row, and comfortably inside
      // the 24px minimum pointer-target height (WCAG 2.5.8).
      padding: "5px 8px",
      // Wide enough to type a query into, but never wider than the slot: at the floor the input
      // gives up its preferred width down to `min-width` and the row wraps around it.
      flex: "0 1 auto",
      minWidth: "min(160px, 100%)",
      maxWidth: "100%",
      border: "1px solid var(--sg-grid-line, #d0d0d0)",
      borderRadius: "4px",
      background: "var(--sg-bg, #ffffff)",
      color: "var(--sg-fg, #1c1917)",
      pointerEvents: "auto",
    });
    // Incremental: apply on every input. The visible feedback lands within the same event turn
    // (well under the 100ms direct-feedback budget); the row-model rebuild is deferred by the
    // grid itself.
    input.addEventListener("input", () => {
      cb.setQuery((input as HTMLInputElement).value);
    });
    input.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Escape cancels the in-progress search with full revert to the unfiltered chart.
      (input as HTMLInputElement).value = "";
      cb.setQuery("");
      event.stopPropagation();
    });
    controls.appendChild(input);
  }

  // Only built when the search box is: the counter is meaningless without a query input, and
  // this keeps `refreshCounter()` a no-op write to nothing when it doesn't exist.
  let counter: HTMLElement | undefined;
  if (opts.searchBox) {
    counter = doc.createElement("span");
    counter.className = "sg-filter-match-count";
    // docs/specs/plugins/interaction.md §6.8 — the counter is a polite live region, so a
    // screen-reader user typing a query hears the match count change without leaving the box.
    counter.setAttribute("aria-live", "polite");
    styled(counter, { color: "var(--sg-muted-fg, #78716c)", pointerEvents: "auto" });
    controls.appendChild(counter);
  }

  let button: HTMLElement | undefined;
  let panel: HTMLElement | undefined;
  let open = false;

  function setOpen(next: boolean): void {
    if (panel === undefined || button === undefined || next === open) return;
    open = next;
    panel.style.display = next ? "block" : "none";
    button.setAttribute("aria-expanded", String(next));
    if (next) {
      rebuildPanel();
      return;
    }
    // Closing while focus is inside the panel would otherwise drop focus onto a removed/hidden
    // subtree; move it to the trigger button so keyboard use continues from a known, visible spot.
    const active = doc.activeElement;
    if (active !== null && panel.contains(active)) button.focus();
  }

  function applySelections(): void {
    const out: Record<string, readonly string[]> = {};
    for (const [id, values] of selections) {
      if (values.size > 0) out[id] = [...values];
    }
    cb.setFieldSelections(out);
  }

  function rebuildPanel(): void {
    const p = panel as HTMLElement;
    p.textContent = "";
    const view = cb.view();
    for (const def of opts.fields) {
      const section = doc.createElement("div");
      section.className = "sg-filter-panel-section";
      section.setAttribute("data-field-id", def.id);
      const heading = doc.createElement("div");
      heading.className = "sg-filter-panel-heading";
      heading.textContent = def.label;
      heading.style.fontWeight = "600";
      heading.style.margin = "6px 0 2px";
      section.appendChild(heading);
      const selected = selections.get(def.id) ?? new Set<string>();
      selections.set(def.id, selected);
      for (const value of distinctValues(def, view, cb.fieldValues)) {
        const line = doc.createElement("label");
        line.className = "sg-filter-panel-value";
        styled(line, { display: "flex", gap: "6px", alignItems: "center", padding: "2px 0" });
        const box = doc.createElement("input") as HTMLInputElement;
        box.setAttribute("type", "checkbox");
        box.checked = selected.has(value);
        box.addEventListener("change", () => {
          if (box.checked) selected.add(value);
          else selected.delete(value);
          applySelections();
        });
        const text = doc.createElement("span");
        text.textContent = value;
        line.appendChild(box);
        line.appendChild(text);
        section.appendChild(line);
      }
      p.appendChild(section);
    }
    const clear = doc.createElement("button");
    clear.className = "sg-filter-clear";
    clear.setAttribute("type", "button");
    clear.textContent = messages.clearFilters;
    clear.style.marginTop = "6px";
    clear.addEventListener("click", () => {
      for (const set of selections.values()) set.clear();
      applySelections();
      rebuildPanel();
    });
    p.appendChild(clear);
  }

  if (opts.filterPanel) {
    button = doc.createElement("button");
    button.className = "sg-filter-button";
    button.setAttribute("type", "button");
    button.setAttribute("aria-haspopup", "true");
    button.setAttribute("aria-expanded", "false");
    button.textContent = messages.filterButton;
    styled(button, {
      padding: "5px 10px",
      border: "1px solid var(--sg-grid-line, #d0d0d0)",
      borderRadius: "4px",
      background: "var(--sg-bg, #ffffff)",
      color: "var(--sg-fg, #1c1917)",
      cursor: "pointer",
      flex: "0 0 auto",
      pointerEvents: "auto",
    });
    button.addEventListener("click", () => setOpen(!open));
    controls.appendChild(button);

    panel = doc.createElement("div");
    panel.className = "sg-filter-panel";
    panel.setAttribute("aria-label", messages.filterPanelLabel);
    styled(panel, {
      // In flow under the controls (the root is the column), so the panel can never open past the
      // safe area's bottom edge: it is a flex item of a root whose height is capped against the
      // pane, and `flex-shrink: 1` with `min-height: 0` lets it give up height and scroll
      // internally rather than overhang a short pane. Its width is the slot's, already clamped.
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
    root.appendChild(panel);

    // Bound on the root, not just the panel: focus can be on the Filter button (outside the
    // panel) when the panel is open, and Escape must still close it from there. `pointerEvents:
    // "none"` on the root only affects pointer routing, not keyboard events reaching it.
    root.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !open) return;
      setOpen(false);
      event.stopPropagation();
    });
  }

  return {
    root,
    refreshCounter(): void {
      if (counter !== undefined) counter.textContent = cb.counterText();
    },
    closePanel(): void {
      setOpen(false);
    },
    contains(node: unknown): boolean {
      return root.contains(node as Node);
    },
  };
}
