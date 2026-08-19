// docs/specs/plugins/interaction.md §6.6 — the toolbar DOM: one `div.sg-zoom-controls` of native
// controls, corner-positioned inside the chart pane's safe area.
/**
 * Builds the zoom-controls toolbar out of native `<button>`s and one `<input type="range">`, so
 * every control is keyboard-operable and focusable with the browser's own focus outline. All
 * styling is inline with CSS-custom-property indirection (`--sg-zoom-controls-*`), so a theme can
 * restyle the toolbar without this plugin depending on one.
 *
 * The message-catalog type is a narrow slice of the merged `InteractionMessages` (§8).
 */
import { styled } from "@stargantt/sdk";

export type ToolbarPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** The seven message keys this toolbar reads out of the merged `InteractionMessages` catalog. */
export interface ToolbarMessages {
  toolbar: string;
  zoomIn: string;
  zoomOut: string;
  zoomSlider: string;
  fit: string;
  today: string;
  selection: string;
}

/** The margin this plugin owns between the safe-area corner and the toolbar's box, CSS px. */
const TOOLBAR_MARGIN_PX = 12;

// docs/specs/plugins/view.md — a corner slot is the corner of the chart pane's *safe area* (the
// pane's box minus the timeline header band and minus the synthetic scrollbars' strips), published
// on the pane as four inline `--sg-safe-*` lengths, plus this plugin's own margin. The `0px`
// fallback is normative: it is what makes the same declaration land on the plain corner when the
// view plugin has published nothing (no header, no scrollbars reserved).
/** The `<side>` offset of the slot: the published safe inset plus this plugin's margin. */
function slot(side: "top" | "right" | "bottom" | "left"): string {
  return `calc(var(--sg-safe-${side}, 0px) + ${TOOLBAR_MARGIN_PX}px)`;
}

// The viewport floor (720×540, CLAUDE.md §3) leaves the chart pane down to its narrowest; the width
// cap is expressed against the pane's own box, never as a fixed pixel maximum, and it leaves this
// plugin's margin on the far side too, so the toolbar never spans the safe area's full width.
// Beyond the cap the flex row wraps (see `flexWrap` below): every control stays visible and
// reachable instead of being pushed outside the pane and clipped.
/** The width cap: the safe area's width less this plugin's margin on both sides. */
const MAX_WIDTH = `calc(100% - var(--sg-safe-left, 0px) - var(--sg-safe-right, 0px) - ${
  TOOLBAR_MARGIN_PX * 2
}px)`;

export interface ToolbarOptions {
  doc: Document;
  messages: ToolbarMessages;
  position: ToolbarPosition;
  slider: boolean;
  zoomButtons: boolean;
  fitButton: boolean;
  todayButton: boolean;
  selectionButton: boolean;
  /** Number of ladder steps the slider spans (its `max` is `sliderSteps - 1`). */
  sliderSteps: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onSlider: (index: number) => void;
  onFit: () => void;
  onToday: () => void;
  onSelection: () => void;
}

export interface Toolbar {
  /** The `.sg-zoom-controls` element, already fully assembled; `null` when every control is off. */
  readonly element: HTMLElement | null;
  /** Moves the slider thumb and the +/− disabled states to the given ladder index (-1 = unknown). */
  syncIndex(index: number): void;
  /** Enables or disables the Selected-task button. */
  setSelectionEnabled(enabled: boolean): void;
}

// The Quick Reference hit-area floor (gantt-ui-ux skill: >=24x24 CSS px) — 28px clears it with
// margin for the pointer-target rounding a real cursor brings.
const BUTTON_STYLE: Readonly<Record<string, string>> = {
  minWidth: "28px",
  minHeight: "28px",
  padding: "2px 8px",
  font: "12px system-ui, sans-serif",
  color: "var(--sg-zoom-controls-fg, #1f2937)",
  background: "transparent",
  border: "none",
  borderRadius: "4px",
  cursor: "pointer",
};

export function createToolbar(options: ToolbarOptions): Toolbar {
  const { doc, messages } = options;
  const anyControl =
    options.slider ||
    options.zoomButtons ||
    options.fitButton ||
    options.todayButton ||
    options.selectionButton;
  if (!anyControl) {
    return { element: null, syncIndex: () => undefined, setSelectionEnabled: () => undefined };
  }

  const root = doc.createElement("div");
  root.className = "sg-zoom-controls";
  root.setAttribute("role", "toolbar");
  root.setAttribute("aria-label", messages.toolbar);
  styled(root, {
    position: "absolute",
    display: "flex",
    alignItems: "center",
    // Wrapping is inert at ordinary widths and only engages once `maxWidth` bites (a narrow chart
    // pane at the viewport floor), where it keeps every control inside the pane rather than letting
    // the row run past its edge.
    flexWrap: "wrap",
    // Wrapped rows stay flush with the edge the toolbar is anchored to.
    justifyContent: options.position.endsWith("left") ? "flex-start" : "flex-end",
    gap: "4px",
    padding: "4px",
    maxWidth: MAX_WIDTH,
    background: "var(--sg-zoom-controls-bg, #ffffff)",
    border: "1px solid var(--sg-zoom-controls-border, #767676)",
    borderRadius: "6px",
    boxShadow: "0 1px 4px rgba(0, 0, 0, 0.15)",
    zIndex: "40",
  });
  if (options.position.startsWith("top")) root.style.top = slot("top");
  else root.style.bottom = slot("bottom");
  if (options.position.endsWith("left")) root.style.left = slot("left");
  else root.style.right = slot("right");

  function button(
    className: string,
    text: string,
    label: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const el = doc.createElement("button") as HTMLButtonElement;
    el.className = className;
    el.type = "button";
    el.textContent = text;
    el.setAttribute("aria-label", label);
    el.setAttribute("title", label);
    styled(el, BUTTON_STYLE);
    el.addEventListener("click", onClick);
    root.appendChild(el);
    return el;
  }

  let zoomOut: HTMLButtonElement | null = null;
  let zoomIn: HTMLButtonElement | null = null;
  let slider: HTMLInputElement | null = null;
  let fit: HTMLButtonElement | null = null;
  let today: HTMLButtonElement | null = null;
  let selection: HTMLButtonElement | null = null;

  if (options.zoomButtons) {
    // The "−"/"+" glyphs are iconography; the words live in the aria-label/title.
    zoomOut = button("sg-zoom-controls__out", "−", messages.zoomOut, options.onZoomOut);
  }
  if (options.slider) {
    slider = doc.createElement("input") as HTMLInputElement;
    slider.className = "sg-zoom-controls__slider";
    slider.type = "range";
    slider.min = "0";
    slider.max = String(Math.max(0, options.sliderSteps - 1));
    slider.step = "1";
    slider.setAttribute("aria-label", messages.zoomSlider);
    slider.setAttribute("title", messages.zoomSlider);
    // No `aria-valuetext` (e.g. naming the active ladder level, "Month") — a screen-reader user
    // hears only the numeric range value. Deferred to a later polish pass.
    styled(slider, { width: "96px", minHeight: "28px", margin: "0", cursor: "pointer" });
    slider.addEventListener("input", () => {
      const index = Number((slider as HTMLInputElement).value);
      if (Number.isInteger(index)) options.onSlider(index);
    });
    root.appendChild(slider);
  }
  if (options.zoomButtons) {
    zoomIn = button("sg-zoom-controls__in", "+", messages.zoomIn, options.onZoomIn);
  }
  if (options.fitButton) {
    fit = button("sg-zoom-controls__fit", messages.fit, messages.fit, options.onFit);
  }
  if (options.todayButton) {
    today = button("sg-zoom-controls__today", messages.today, messages.today, options.onToday);
  }
  if (options.selectionButton) {
    selection = button(
      "sg-zoom-controls__selection",
      messages.selection,
      messages.selection,
      options.onSelection,
    );
    selection.disabled = true;
    selection.setAttribute("disabled", "");
  }

  // docs/specs/plugins/interaction.md §6.6 — disabling a control that currently holds keyboard
  // focus would drop DOM focus to <body>; focus is moved to the nearest still-enabled toolbar
  // control first. When no toolbar control remains enabled, the toolbar root itself takes focus as
  // a last resort so a keyboard user stays inside the toolbar instead of being dumped onto <body>.
  function rescueFocus(from: HTMLElement, candidates: readonly (HTMLElement | null)[]): void {
    if (doc.activeElement !== from) return;
    for (const c of candidates) {
      if (c === null || c === from || (c as HTMLButtonElement).disabled === true) continue;
      if (typeof c.focus === "function") c.focus();
      return;
    }
    root.tabIndex = -1;
    root.focus();
  }

  function setDisabled(
    el: HTMLButtonElement,
    off: boolean,
    fallbacks: readonly (HTMLElement | null)[],
  ): void {
    if (off && !el.disabled) rescueFocus(el, fallbacks);
    el.disabled = off;
    if (off) el.setAttribute("disabled", "");
    else el.removeAttribute("disabled");
  }

  function syncIndex(index: number): void {
    const known = index >= 0;
    if (slider !== null && known) slider.value = String(index);
    if (zoomOut !== null) {
      setDisabled(zoomOut, known && index === 0, [slider, zoomIn, fit, today, selection]);
    }
    if (zoomIn !== null) {
      setDisabled(zoomIn, known && index === options.sliderSteps - 1, [
        slider,
        zoomOut,
        fit,
        today,
        selection,
      ]);
    }
  }

  function setSelectionEnabled(enabled: boolean): void {
    if (selection === null) return;
    setDisabled(selection, !enabled, [slider, zoomIn, zoomOut, fit, today]);
  }

  return { element: root, syncIndex, setSelectionEnabled };
}
