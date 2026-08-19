/**
 * Where the legend actually lands: the CSS declarations it writes, resolved against a safe area
 * published on the chart pane — the same `--sg-safe-*` custom properties a real chrome plugin
 * publishes there. The safe area is stood up by hand here, since composing a real chrome plugin is
 * the integration phase's job; what is proven is the arithmetic the legend's own declarations
 * resolve to, exactly as a browser would fold them, at a wide pane and at a narrow one.
 *
 * docs/specs/plugins/tree-grid.md § Extension points, § Config.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ConditionalFormatConfig } from "../src/internal/conditional-format/types";
import { boot } from "./_boot";
import type { Booted } from "./_boot";
import { declaredStyle, safeArea, slotBox } from "./_harness/index";
import type { FakeElement, PaneBox } from "./_harness/index";
import { upwardProbe } from "./_upward";

/** The margin the legend keeps between the safe-area corner and its own box. */
const MARGIN = 8;

/** A stand-in safe area: what a real chrome plugin would publish on the chart pane. */
const SAFE_AREA = { top: 44, right: 10, bottom: 10, left: 0 };

/** A config with three legend entries, so the panel is actually mounted. */
const WITH_LEGEND: ConditionalFormatConfig = {
  legend: true,
  overdue: true,
  rules: [
    { when: { field: "priority", op: "eq", value: 1 }, style: { color: "#111" }, legend: "Top" },
  ],
  priorityColors: { "2": "#222" },
};

let b: Booted | undefined;
afterEach(() => {
  b?.gantt.dispose();
  b?.dom.restore();
  b = undefined;
});

/**
 * Boots with the legend enabled, publishes the stand-in safe area on the chart pane, and hands
 * back the pane plus the mounted legend node.
 */
function bootWithLegend(): { pane: FakeElement; legend: FakeElement } {
  const probe = upwardProbe();
  b = boot([probe.plugin], {}, { conditionalFormat: WITH_LEGEND });
  const pane = b.chartPane;
  pane.style["--sg-safe-top"] = `${SAFE_AREA.top}px`;
  pane.style["--sg-safe-right"] = `${SAFE_AREA.right}px`;
  pane.style["--sg-safe-bottom"] = `${SAFE_AREA.bottom}px`;
  pane.style["--sg-safe-left"] = `${SAFE_AREA.left}px`;
  const legend = pane.find("sg-cf-legend");
  if (legend === undefined) throw new Error("the legend is not a child of the chart pane");
  return { pane, legend };
}

/** The two pane sizes the slot is measured at. */
const VIEWPORTS: { name: string; pane: PaneBox }[] = [
  { name: "a 1440×900 pane", pane: { width: 1440, height: 900 } },
  { name: "a 240×540 pane clamped to the chart's minimum width", pane: { width: 240, height: 540 } },
];

describe.each(VIEWPORTS)("the legend's slot at $name", ({ pane: paneBox }) => {
  it("resolves the safe area published on the chart pane", () => {
    const { pane } = bootWithLegend();
    expect(safeArea(pane)).toEqual(SAFE_AREA);
  });

  it("sits one 8px margin inside the safe area's bottom-right corner", () => {
    const { pane, legend } = bootWithLegend();
    const box = slotBox(legend, pane, paneBox);
    const safe = safeArea(pane);

    expect({ top: box.top, right: box.right, bottom: box.bottom, left: box.left }).toEqual({
      top: undefined,
      left: undefined,
      right: SAFE_AREA.right + MARGIN,
      bottom: SAFE_AREA.bottom + MARGIN,
    });
    // Restated as clearances: the panel's anchored edges sit inside both safe-area strips.
    expect(box.right! - safe.right).toBe(MARGIN);
    expect(box.bottom! - safe.bottom).toBe(MARGIN);
  });

  it("caps both axes against the pane so the whole panel stays inside the safe area", () => {
    const { pane, legend } = bootWithLegend();
    const box = slotBox(legend, pane, paneBox);
    const safe = safeArea(pane);
    const safeWidth = paneBox.width - safe.left - safe.right;
    const safeHeight = paneBox.height - safe.top - safe.bottom;

    // Both caps leave the margin on the far side too, so the panel can never span the safe area's
    // full width or height — in particular it never reaches the header band.
    expect(box.maxWidth).toBe(safeWidth - MARGIN * 2);
    expect(box.maxHeight).toBe(safeHeight - MARGIN * 2);
    expect(box.maxWidth).toBeGreaterThan(0);
    expect(box.maxHeight).toBeGreaterThan(0);
    // Measured from the safe area's own edges: the panel's margin plus its widest/tallest allowed
    // box still fits, with the far-side margin to spare.
    expect(box.right! - safe.right + (box.maxWidth ?? 0)).toBe(safeWidth - MARGIN);
    expect(box.bottom! - safe.bottom + (box.maxHeight ?? 0)).toBe(safeHeight - MARGIN);
  });

  it("keeps the panel out of the pointer path", () => {
    const { legend } = bootWithLegend();
    expect(declaredStyle(legend)["pointerEvents"]).toBe("none");
  });
});

describe("the caps", () => {
  it("are pane-relative, not fixed pixel maxima", () => {
    const { pane, legend } = bootWithLegend();
    const wide = slotBox(legend, pane, { width: 1440, height: 900 });
    const floor = slotBox(legend, pane, { width: 240, height: 540 });

    expect(wide.maxWidth).toBe(1440 - SAFE_AREA.right - MARGIN * 2);
    expect(floor.maxWidth).toBe(240 - SAFE_AREA.right - MARGIN * 2);
    expect(wide.maxHeight).toBe(900 - SAFE_AREA.top - SAFE_AREA.bottom - MARGIN * 2);
    expect(floor.maxHeight).toBe(540 - SAFE_AREA.top - SAFE_AREA.bottom - MARGIN * 2);
    expect(floor.maxWidth).toBeLessThan(wide.maxWidth ?? 0);
    expect(floor.maxHeight).toBeLessThan(wide.maxHeight ?? 0);
  });
});
