// docs/specs/plugins/interaction.md §6.6 — the toolbar DOM in isolation: control set, corner
// anchoring, boolean-flag gating, and the disabled-control focus rescue. Adapted to the merged
// `InteractionMessages` catalog and to a fake DOM (`_zoom-dom.ts`) that keeps
// `calc(var(--sg-safe-*))` position assignments observable — see that file's header for why a
// real happy-dom `document` cannot be used for the anchoring test.
import { describe, expect, it, vi } from "vitest";
import { createToolbar } from "../src/internal/zoom/toolbar";
import type { ToolbarMessages } from "../src/internal/zoom/toolbar";
import { fakeDocument } from "./_zoom-dom";
import type { FakeDocument, FakeElement } from "./_zoom-dom";

const MESSAGES: ToolbarMessages = {
  toolbar: "Zoom controls",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  zoomSlider: "Zoom level",
  fit: "Fit",
  today: "Today",
  selection: "Selected task",
};

function baseOptions(doc: FakeDocument): Parameters<typeof createToolbar>[0] {
  return {
    doc: doc as unknown as Document,
    messages: MESSAGES,
    position: "bottom-right",
    slider: true,
    zoomButtons: true,
    fitButton: true,
    todayButton: true,
    selectionButton: true,
    sliderSteps: 6,
    onZoomIn: vi.fn(),
    onZoomOut: vi.fn(),
    onSlider: vi.fn(),
    onFit: vi.fn(),
    onToday: vi.fn(),
    onSelection: vi.fn(),
  };
}

function build(over: Partial<ReturnType<typeof baseOptions>> = {}) {
  const doc = fakeDocument();
  const toolbar = createToolbar({ ...baseOptions(doc), ...over });
  return { doc, toolbar, bar: toolbar.element as unknown as FakeElement | null };
}

describe("toolbar DOM", () => {
  it("builds one .sg-zoom-controls toolbar with every control by default", () => {
    const { bar } = build();
    expect(bar).not.toBeNull();
    expect(bar!.getAttribute("role")).toBe("toolbar");
    expect(bar!.getAttribute("aria-label")).toBe("Zoom controls");
    expect(bar!.query("sg-zoom-controls__in")).toBeTruthy();
    expect(bar!.query("sg-zoom-controls__out")).toBeTruthy();
    expect(bar!.query("sg-zoom-controls__fit")).toBeTruthy();
    expect(bar!.query("sg-zoom-controls__today")).toBeTruthy();
    expect(bar!.query("sg-zoom-controls__selection")).toBeTruthy();
    expect(bar!.query("sg-zoom-controls__slider")?.getAttribute("aria-label")).toBe("Zoom level");
  });

  it("anchors the configured corner's two sides and neither of the others", () => {
    const anchored = (bar: FakeElement): string[] =>
      (["top", "right", "bottom", "left"] as const).filter((side) => bar.style[side] !== undefined);
    expect(anchored(build().bar!)).toEqual(["right", "bottom"]);
    expect(anchored(build({ position: "top-left" }).bar!)).toEqual(["top", "left"]);
    expect(anchored(build({ position: "top-right" }).bar!)).toEqual(["top", "right"]);
    expect(anchored(build({ position: "bottom-left" }).bar!)).toEqual(["bottom", "left"]);
  });

  it("boolean flags omit individual controls; all-off creates no toolbar at all", () => {
    const { bar: partial } = build({ slider: false, selectionButton: false });
    expect(partial!.query("sg-zoom-controls__slider")).toBeNull();
    expect(partial!.query("sg-zoom-controls__selection")).toBeNull();
    expect(partial!.query("sg-zoom-controls__fit")).not.toBeNull();

    const none = build({
      slider: false,
      zoomButtons: false,
      fitButton: false,
      todayButton: false,
      selectionButton: false,
    });
    expect(none.bar).toBeNull();
    // Both methods stay safe no-ops with no DOM behind them.
    expect(() => none.toolbar.syncIndex(0)).not.toThrow();
    expect(() => none.toolbar.setSelectionEnabled(true)).not.toThrow();
  });

  it("clicking a control runs its callback", () => {
    const options = baseOptions(fakeDocument());
    const toolbar = createToolbar(options);
    const bar = toolbar.element as unknown as FakeElement;
    bar.query("sg-zoom-controls__in")!.click();
    expect(options.onZoomIn).toHaveBeenCalledTimes(1);
    bar.query("sg-zoom-controls__out")!.click();
    expect(options.onZoomOut).toHaveBeenCalledTimes(1);
    bar.query("sg-zoom-controls__fit")!.click();
    expect(options.onFit).toHaveBeenCalledTimes(1);
    bar.query("sg-zoom-controls__today")!.click();
    expect(options.onToday).toHaveBeenCalledTimes(1);
  });

  it("the slider's input event reports its integer index", () => {
    const options = baseOptions(fakeDocument());
    const toolbar = createToolbar(options);
    const bar = toolbar.element as unknown as FakeElement;
    const slider = bar.query("sg-zoom-controls__slider")!;
    slider.value = "3";
    slider.fire("input");
    expect(options.onSlider).toHaveBeenCalledWith(3);
  });

  it("syncIndex moves the slider thumb and disables the +/- ends", () => {
    const { bar, toolbar } = build();
    const slider = bar!.query("sg-zoom-controls__slider")!;
    const zoomOut = bar!.query("sg-zoom-controls__out")!;
    const zoomIn = bar!.query("sg-zoom-controls__in")!;

    toolbar.syncIndex(0);
    expect(slider.value).toBe("0");
    expect(zoomOut.disabled).toBe(true);
    expect(zoomIn.disabled).toBe(false);

    toolbar.syncIndex(5); // the finest of 6 steps (0..5)
    expect(zoomIn.disabled).toBe(true);
    expect(zoomOut.disabled).toBe(false);

    // -1 (unknown/off-ladder) enables both ends and leaves the slider where it was.
    toolbar.syncIndex(-1);
    expect(zoomOut.disabled).toBe(false);
    expect(zoomIn.disabled).toBe(false);
  });

  it("selection button starts disabled and toggles with setSelectionEnabled", () => {
    const { bar, toolbar } = build();
    const selection = bar!.query("sg-zoom-controls__selection")!;
    expect(selection.disabled).toBe(true);
    toolbar.setSelectionEnabled(true);
    expect(selection.disabled).toBe(false);
    toolbar.setSelectionEnabled(false);
    expect(selection.disabled).toBe(true);
  });

  it("messages populate the accessible labels", () => {
    const { bar } = build({ messages: { ...MESSAGES, zoomIn: "Vergrößern", fit: "" } });
    expect(bar!.query("sg-zoom-controls__in")!.getAttribute("aria-label")).toBe("Vergrößern");
    // The empty string is usable and taken verbatim.
    expect(bar!.query("sg-zoom-controls__fit")!.textContent).toBe("");
  });

  it("moves focus to a still-enabled control before disabling the focused zoom button", () => {
    const { doc, bar, toolbar } = build();
    const zoomIn = bar!.query("sg-zoom-controls__in")!;
    const slider = bar!.query("sg-zoom-controls__slider")!;
    zoomIn.focus();
    toolbar.syncIndex(5); // the finest step disables zoomIn while it holds focus
    expect(zoomIn.disabled).toBe(true);
    expect(doc.activeElement).toBe(slider);
  });

  it("falls back to the toolbar root when no other control remains enabled", () => {
    const { doc, bar, toolbar } = build({
      slider: false,
      zoomButtons: false,
      fitButton: false,
      todayButton: false,
    });
    const selection = bar!.query("sg-zoom-controls__selection")!;
    toolbar.setSelectionEnabled(true);
    selection.focus();
    toolbar.setSelectionEnabled(false);
    expect(doc.activeElement).toBe(bar);
  });
});
