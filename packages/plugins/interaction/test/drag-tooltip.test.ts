// Unit behavior of the drag tooltip manager over a minimal element stub — the module takes only a
// document and a pane, so no chart boot is needed.
import { describe, expect, it } from "vitest";
import { createDragTooltip, DRAG_TOOLTIP_GAP_PX } from "../src/internal/drag/drag-tooltip";

/** A minimal element whose offsetWidth/offsetHeight reads are counted (each is a forced layout). */
function stubDom(width = 80, height = 20) {
  let measures = 0;
  const style: Record<string, string> = {};
  const node = {
    className: "",
    textContent: "",
    style,
    get offsetWidth() {
      measures += 1;
      return width;
    },
    get offsetHeight() {
      measures += 1;
      return height;
    },
    remove() {},
  };
  const pane = { appendChild: () => {} };
  const doc = { createElement: () => node };
  return {
    node,
    measureCount: () => measures,
    tooltip: createDragTooltip(doc as unknown as Document, pane as unknown as HTMLElement),
  };
}

const anchor = (x: number) => ({ x, yAbove: 100, yBelow: 120, paneWidth: 600 });

describe("drag tooltip measurement cache", () => {
  it("re-measures only when the text changes, not on every move", () => {
    const d = stubDom();
    d.tooltip.show("Jan 1 – Jan 2", anchor(50));
    const afterFirst = d.measureCount();
    expect(afterFirst).toBeGreaterThan(0);
    // Same readout, new pointer position: no forced layout in the per-move path.
    d.tooltip.show("Jan 1 – Jan 2", anchor(60));
    d.tooltip.show("Jan 1 – Jan 2", anchor(70));
    expect(d.measureCount()).toBe(afterFirst);
    // A new readout (next snapped step) measures again.
    d.tooltip.show("Jan 2 – Jan 3", anchor(80));
    expect(d.measureCount()).toBeGreaterThan(afterFirst);
  });

  it("still positions with the cached size on cache hits", () => {
    const d = stubDom(80, 20);
    d.tooltip.show("t", anchor(50));
    d.tooltip.show("t", anchor(590));
    // Right-clamped using the cached width: paneWidth 600 − width 80 = 520.
    expect(d.node.style["left"]).toBe("520px");
    expect(d.node.style["top"]).toBe(`${100 - DRAG_TOOLTIP_GAP_PX - 20}px`);
  });

  it("hide resets the cache so the next drag re-measures", () => {
    const d = stubDom();
    d.tooltip.show("t", anchor(50));
    const afterFirst = d.measureCount();
    d.tooltip.hide();
    d.tooltip.show("t", anchor(50));
    expect(d.measureCount()).toBeGreaterThan(afterFirst);
  });
});
