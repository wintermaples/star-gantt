// The deferred collapse of "multi" mode: an unmodified press on a bar that is already selected
// leaves the selection alone until the gesture ends, so grabbing one bar of a multi-selection to
// drag the group never dissolves the group.
//
// The decision table is exercised directly (unchanged in shape); the "through the host"
// describe block is decomposed to drive `createSelectionModule` directly through its `barPress` /
// `pointerMove` / `pointerUp` surface instead of a booted `Gantt` instance.
import { describe, expect, it } from "vitest";
import {
  COLLAPSE_SLOP_PX,
  collapseOnMove,
  collapseOnUp,
  pressDefersCollapse,
} from "../src/internal/selection/deferred-collapse";
import type { PendingCollapse } from "../src/internal/selection/deferred-collapse";
import { harness, makeBox, point, press } from "./_selection-fakes";

const PRESS: PendingCollapse = { id: "t1", pointerId: 1, clientX: 100, clientY: 100 };

function at(clientX: number, clientY: number, init: { pointerId?: number; type?: string } = {}) {
  return {
    clientX,
    clientY,
    pointerId: init.pointerId ?? 1,
    type: init.type ?? "pointerup",
  };
}

const NONE = { ctrlKey: false, metaKey: false, shiftKey: false };

describe("pressDefersCollapse", () => {
  const two = new Set(["t1", "t2"]);

  it("defers an unmodified press on a bar already in a multi-selection", () => {
    expect(pressDefersCollapse("multi", NONE, two, "t1")).toBe(true);
  });

  it("does not defer a press outside the selection", () => {
    expect(pressDefersCollapse("multi", NONE, two, "t3")).toBe(false);
  });

  it("does not defer a one-task selection — the collapse would change nothing", () => {
    expect(pressDefersCollapse("multi", NONE, new Set(["t1"]), "t1")).toBe(false);
  });

  it("does not defer a modified press", () => {
    expect(pressDefersCollapse("multi", { ...NONE, ctrlKey: true }, two, "t1")).toBe(false);
    expect(pressDefersCollapse("multi", { ...NONE, metaKey: true }, two, "t1")).toBe(false);
    expect(pressDefersCollapse("multi", { ...NONE, shiftKey: true }, two, "t1")).toBe(false);
  });

  it("never defers outside \"multi\" mode", () => {
    expect(pressDefersCollapse("single", NONE, two, "t1")).toBe(false);
    expect(pressDefersCollapse("none", NONE, two, "t1")).toBe(false);
  });
});

describe("collapseOnMove / collapseOnUp", () => {
  it("holds while the pointer stays within the slop", () => {
    expect(collapseOnMove(PRESS, at(100 + COLLAPSE_SLOP_PX, 100))).toBe("hold");
    expect(collapseOnMove(PRESS, at(102, 102))).toBe("hold"); // hypot ≈ 2.83
  });

  it("discards once the movement exceeds the slop in any direction", () => {
    expect(collapseOnMove(PRESS, at(104, 100))).toBe("discard");
    expect(collapseOnMove(PRESS, at(100, 96))).toBe("discard");
    expect(collapseOnMove(PRESS, at(103, 103))).toBe("discard"); // hypot ≈ 4.24
  });

  it("ignores another pointer's movement", () => {
    expect(collapseOnMove(PRESS, at(400, 400, { pointerId: 2 }))).toBe("hold");
  });

  it("applies on a release in place by the pressing pointer", () => {
    expect(collapseOnUp(PRESS, at(101, 102))).toBe("apply");
  });

  it("discards on a release past the slop", () => {
    expect(collapseOnUp(PRESS, at(140, 100))).toBe("discard");
  });

  it("discards on a cancelled capture, however still the pointer was", () => {
    expect(collapseOnUp(PRESS, at(100, 100, { type: "pointercancel" }))).toBe("discard");
  });

  it("discards when another pointer ends the gesture", () => {
    expect(collapseOnUp(PRESS, at(100, 100, { pointerId: 7 }))).toBe("discard");
  });
});

describe("deferred collapse through createSelectionModule", () => {
  it("keeps the selection intact at press time", () => {
    const h = harness({ mode: "multi" });
    h.module.service.select(["t1", "t2"]);
    h.module.barPress(press("t1"));
    expect([...h.module.selected()].sort()).toEqual(["t1", "t2"]);
  });

  it("collapses to the pressed task when the press is released in place", () => {
    const h = harness({ mode: "multi" });
    h.module.service.select(["t1", "t2"]);
    h.module.barPress(press("t1", { clientX: 50, clientY: 50 }));
    h.module.pointerUp(point({ clientX: 52, clientY: 51 }));
    expect([...h.module.selected()]).toEqual(["t1"]);
  });

  it("keeps the whole selection once the press becomes a drag", () => {
    const h = harness({ mode: "multi" });
    h.module.service.select(["t1", "t2"]);
    h.module.barPress(press("t1", { clientX: 50, clientY: 50 }));
    h.module.pointerMove(point({ clientX: 90, clientY: 50, type: "pointermove" }));
    h.module.pointerUp(point({ clientX: 90, clientY: 50 }));
    expect([...h.module.selected()].sort()).toEqual(["t1", "t2"]);
  });

  it("keeps the selection when the drag returns to the press point before release", () => {
    const h = harness({ mode: "multi" });
    h.module.service.select(["t1", "t2"]);
    h.module.barPress(press("t1", { clientX: 50, clientY: 50 }));
    h.module.pointerMove(point({ clientX: 90, clientY: 50, type: "pointermove" }));
    h.module.pointerUp(point({ clientX: 50, clientY: 50 }));
    expect([...h.module.selected()].sort()).toEqual(["t1", "t2"]);
  });

  it("keeps the selection when the capture is cancelled", () => {
    const h = harness({ mode: "multi" });
    h.module.service.select(["t1", "t2"]);
    h.module.barPress(press("t1", { clientX: 50, clientY: 50 }));
    h.module.pointerUp(point({ clientX: 50, clientY: 50, type: "pointercancel" }));
    expect([...h.module.selected()].sort()).toEqual(["t1", "t2"]);
  });

  it("drops the pending collapse when `clearPending()` is called (the Escape path)", () => {
    const h = harness({ mode: "multi" });
    h.module.service.select(["t1", "t2"]);
    h.module.barPress(press("t1", { clientX: 50, clientY: 50 }));
    h.module.clearPending();
    h.module.pointerUp(point({ clientX: 50, clientY: 50 }));
    expect([...h.module.selected()].sort()).toEqual(["t1", "t2"]);
  });

  it("drops the pending collapse when another press supersedes it", () => {
    const h = harness({ mode: "multi" });
    h.module.service.select(["t1", "t2"]);
    h.module.barPress(press("t1", { clientX: 50, clientY: 50 }));
    h.module.barPress(press("t3", { clientX: 50, clientY: 90 }));
    expect([...h.module.selected()]).toEqual(["t3"]);
    // The first press's release must not resurrect its collapse over the new selection.
    h.module.pointerUp(point({ clientX: 50, clientY: 50 }));
    expect([...h.module.selected()]).toEqual(["t3"]);
  });

  it("drops the pending collapse when the host selects programmatically mid-gesture", () => {
    const h = harness({ mode: "multi" });
    h.module.service.select(["t1", "t2"]);
    h.module.barPress(press("t1", { clientX: 50, clientY: 50 }));
    h.module.service.select(["t3"]);
    h.module.pointerUp(point({ clientX: 50, clientY: 50 }));
    expect([...h.module.selected()]).toEqual(["t3"]);
  });

  it("publishes nothing at press time and one change on the collapsing release", () => {
    const h = harness({ mode: "multi" });
    h.module.service.select(["t1", "t2"]);
    h.storeSnapshots.length = 0;
    h.invalidations.length = 0;
    h.module.barPress(press("t1", { clientX: 50, clientY: 50 }));
    expect(h.storeSnapshots).toEqual([]);
    expect(h.invalidations).toEqual([]);
    h.module.pointerUp(point({ clientX: 50, clientY: 50 }));
    expect(h.storeSnapshots.map((s) => [...s.taskIds])).toEqual([["t1"]]);
  });

  it("sets the Shift anchor only when the collapse actually happens", () => {
    const h = harness({ mode: "multi" });
    for (const id of ["t1", "t2", "t3"]) h.bars.boxes.push(makeBox(id, 0, 0));
    // The Shift range resolves through the row model now; the earlier implementation relied on
    // the visible-bar fallback here, which no longer exists.
    h.rows.rows.push({ id: "t1", height: 24 }, { id: "t2", height: 24 }, { id: "t3", height: 24 });
    h.module.service.select(["t1", "t3"]);
    // A press whose collapse is discarded leaves the anchor where it was — at t1, set by select().
    h.module.barPress(press("t3", { clientX: 50, clientY: 50 }));
    h.module.pointerUp(point({ clientX: 50, clientY: 50 })); // collapses to t3, anchor := t3
    h.module.barPress(press("t1", { shiftKey: true }));
    expect([...h.module.selected()].sort()).toEqual(["t1", "t2", "t3"]);
  });

  it("still replaces immediately on a bar outside the selection", () => {
    const h = harness({ mode: "multi" });
    h.module.service.select(["t1", "t2"]);
    h.module.barPress(press("t3"));
    expect([...h.module.selected()]).toEqual(["t3"]);
  });

  it("still replaces immediately on a grid-row press of a selected row", () => {
    const h = harness({ mode: "multi" });
    h.module.service.select(["t1", "t2"]);
    h.module.gridPress(press("t1"));
    expect([...h.module.selected()]).toEqual(["t1"]);
  });

  it("does not defer in \"single\" mode", () => {
    const h = harness({ mode: "single" });
    h.module.service.select(["t1", "t2"]);
    h.module.barPress(press("t1"));
    expect([...h.module.selected()]).toEqual(["t1"]);
  });

  // The earlier "shows the full pre-press selection to a listener registered after it" case
  // documented the guarantee a peer-capturing plugin (drag-edit's multi-task drag) rests on: a
  // `pointer/barDown` listener that runs after the selection's own still sees the full pre-press
  // selection, because registration order (not the selection's own internal state change) decided
  // it. Here there is no event bus in between — the drag controller reads `selection.selected()` directly and
  // synchronously wherever the arbiter calls into it, so the guarantee now holds by construction: a
  // deferred collapse's `apply()` never runs until the release, so any code that inspects
  // `module.selected()` between `barPress` and the resolving `pointerUp` always sees the pre-press
  // set. Asserted directly instead of through a registration-order listener.
  it("keeps `selected()` reporting the full pre-press selection until the collapse resolves", () => {
    const h = harness({ mode: "multi" });
    h.module.service.select(["t1", "t2"]);
    h.module.barPress(press("t1", { clientX: 50, clientY: 50 }));
    expect([...h.module.selected()].sort()).toEqual(["t1", "t2"]);
  });
});
