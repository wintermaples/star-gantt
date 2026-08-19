/**
 * Shift-click range resolution in model row indices. The range spans every row between the anchor
 * row and the target row in the composed row order: rows without a drawn bar are included,
 * height-0 hidden rows are excluded, and the anchor stays usable while its row is scrolled
 * off-screen.
 *
 * The tree grid is a hard dependency (`stargantt.tree-grid` is in `interaction()`'s `dependsOn`,
 * not `optional`), so the Shift range ALWAYS resolves through the row model now — a "no row model
 * composed → fall back to visible bar order" branch no longer exists, and the whole "shift-click
 * fallback without a row model" case is out of scope: what it would exercise (`b.visible` order
 * used as the range) is unreachable code, since `SelectionDeps.rows` is a required, always-present
 * accessor rather than an optional composed plugin. This is recorded here rather than silently
 * dropped.
 */
import { describe, expect, it } from "vitest";
import { harness, makeBox, press } from "./_selection-fakes";

/** Boots in "multi" mode with four ordinary 24px rows, t1..t4. */
function bootRows() {
  const h = harness({ mode: "multi" });
  h.rows.rows.push({ id: "t1", height: 24 }, { id: "t2", height: 24 }, { id: "t3", height: 24 }, { id: "t4", height: 24 });
  return h;
}

describe("shift-click range via the row model", () => {
  it("includes rows whose bars are scrolled out of view or not drawn", () => {
    const h = bootRows();
    // Only t1, t2 and t4 have visible bars; t3's row is between them but its bar is absent
    // (scrolled sideways out of the composite, or a summary shown without a bar of its own).
    h.bars.boxes.push(makeBox("t1", 10, 0), makeBox("t2", 10, 24), makeBox("t4", 10, 72));
    h.module.barPress(press("t1")); // anchor = t1
    h.module.barPress(press("t4", { shiftKey: true }));
    expect(h.module.selected()).toEqual(new Set(["t1", "t2", "t3", "t4"]));
  });

  it("keeps the anchor usable while its own row is scrolled off-screen", () => {
    const h = bootRows();
    h.bars.boxes.push(makeBox("t1", 10, 0), makeBox("t3", 10, 48));
    h.module.barPress(press("t1")); // anchor = t1
    // The chart scrolls: t1's bar leaves the visible composite, but its row index is still known.
    h.bars.boxes.length = 0;
    h.bars.boxes.push(makeBox("t3", 10, 0));
    h.module.barPress(press("t3", { shiftKey: true }));
    expect(h.module.selected()).toEqual(new Set(["t1", "t2", "t3"]));
  });

  it("excludes height-0 hidden rows, matching the keyboard Shift-range rule", () => {
    const h = bootRows();
    const hidden = h.rows.rows[1];
    if (hidden !== undefined) hidden.height = 0; // t2 filtered out
    h.bars.boxes.push(makeBox("t1", 10, 0), makeBox("t3", 10, 24), makeBox("t4", 10, 48));
    h.module.barPress(press("t1")); // anchor = t1
    h.module.barPress(press("t4", { shiftKey: true }));
    expect(h.module.selected()).toEqual(new Set(["t1", "t3", "t4"]));
  });

  it("treats a shift-press whose anchor left the row order as a plain press", () => {
    const h = bootRows();
    h.bars.boxes.push(makeBox("t1", 10, 0), makeBox("t3", 10, 48));
    h.module.barPress(press("t1")); // anchor = t1
    h.rows.rows.shift(); // t1 leaves the row order (its branch collapsed / it was removed)
    h.module.barPress(press("t3", { shiftKey: true }));
    expect(h.module.selected()).toEqual(new Set(["t3"]));
  });

  it("resolves a grid-row shift-press through the same row order as a bar press", () => {
    const h = bootRows();
    h.bars.boxes.push(makeBox("t2", 10, 24));
    h.module.gridPress(press("t1")); // anchor = t1, no bar drawn for it
    h.module.gridPress(press("t4", { shiftKey: true }));
    expect(h.module.selected()).toEqual(new Set(["t1", "t2", "t3", "t4"]));
  });
});
