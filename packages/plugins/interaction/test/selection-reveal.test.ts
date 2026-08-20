// The "revealing on selection" behavior is
// hosted on `createSelectionModule`'s hostless `SelectionDeps`, and exercises the deliberate
// design: `service.reveal(id)` is UNGATED (works even with `revealSelected: false`), which
// governs only the AUTOMATIC reveals (the grid-row press path and `select()`).
import { describe, expect, it } from "vitest";
import { REVEAL_MARGIN_PX, revealScrollLeft } from "../src/internal/selection/reveal";
import { harness, makeBox, press } from "./_selection-fakes";

const M = REVEAL_MARGIN_PX;
const VIEW = 800;

describe("revealScrollLeft (unit)", () => {
  it("leaves a bar that already clears both margins alone", () => {
    expect(revealScrollLeft(100, 40, VIEW, 0)).toBeUndefined();
    expect(revealScrollLeft(M, 40, VIEW, 0)).toBeUndefined();
    expect(revealScrollLeft(VIEW - M - 40, 40, VIEW, 0)).toBeUndefined();
  });

  it("pulls a bar clipped or hidden on the left to the left margin", () => {
    expect(revealScrollLeft(10, 40, VIEW, 500)).toBe(500 + 10 - M);
    expect(revealScrollLeft(-300, 40, VIEW, 500)).toBe(500 - 300 - M);
  });

  it("pulls a bar clipped or hidden on the right to the right margin", () => {
    expect(revealScrollLeft(VIEW - M - 30, 40, VIEW, 0)).toBe(10);
    expect(revealScrollLeft(VIEW + 200, 40, VIEW, 0)).toBe(VIEW + 240 - (VIEW - M));
  });

  it("shows the start of a bar too wide to fit, unless it already spans the viewport", () => {
    expect(revealScrollLeft(400, 2000, VIEW, 0)).toBe(400 - M);
    expect(revealScrollLeft(-500, 2000, VIEW, 0)).toBeUndefined();
  });

  it("shrinks the margin rather than pushing a bar out of a narrow viewport", () => {
    expect(revealScrollLeft(0, 40, 60, 100)).toBe(100 - 15);
  });

  it("answers nothing for a degenerate viewport or a non-finite geometry", () => {
    expect(revealScrollLeft(10, 40, 0, 0)).toBeUndefined();
    expect(revealScrollLeft(Number.NaN, 40, VIEW, 0)).toBeUndefined();
    expect(revealScrollLeft(10, Number.NaN, VIEW, 0)).toBeUndefined();
  });
});

describe("revealing on selection", () => {
  it("scrolls a grid-row press's bar into view, and leaves a visible one alone", () => {
    const h = harness();
    h.viewport.width = VIEW;
    h.bars.boxes.push(makeBox("a", -300, 0), makeBox("b", 100, 0));
    h.module.gridPress(press("a"));
    expect(h.scrolls).toEqual([-300 - M]);
    h.module.gridPress(press("b"));
    expect(h.scrolls).toHaveLength(1);
  });

  it("does not reveal on a bar press — the bar is already under the pointer", () => {
    const h = harness();
    h.viewport.width = VIEW;
    h.bars.boxes.push(makeBox("a", VIEW - 10, 0));
    h.module.barPress(press("a"));
    expect(h.module.selected().has("a")).toBe(true);
    expect(h.scrolls).toEqual([]);
  });

  it("reveals a row pressed again even though the selection did not change", () => {
    const h = harness();
    h.viewport.width = VIEW;
    h.bars.boxes.push(makeBox("a", -300, 0));
    h.module.gridPress(press("a"));
    h.module.gridPress(press("a"));
    expect(h.storeSnapshots).toHaveLength(1); // one effective change, not two
    expect(h.scrolls).toHaveLength(2); // the reveal runs on every grid press regardless
  });

  it("reveals the first id a host selects through the service", () => {
    const h = harness();
    h.viewport.width = VIEW;
    h.bars.boxes.push(makeBox("a", -300, 0), makeBox("b", -500, 0));
    h.module.service.select(["b", "a"]);
    expect(h.scrolls).toEqual([-500 - M]);
  });

  it("does not scroll for a rubber-band selection, a clear, or a handle press", () => {
    const h = harness({ mode: "multi" });
    h.viewport.width = VIEW;
    // Clipped on the right, so a reveal would be visible in `scrolls` if one happened.
    h.bars.boxes.push(makeBox("a", VIEW - 10, 0));
    h.module.rubberBandBegin(0, 0);
    h.module.rubberBandEnd(VIEW, 600, { ctrlKey: false, metaKey: false, cancelled: false });
    expect(h.module.selected().has("a")).toBe(true);
    h.module.service.clear();
    // A press on a non-bar-body hit (e.g. a resize handle) never reaches `barPress` / `gridPress`
    // at all — the arbiter routes it elsewhere — so there is nothing further to drive here.
    expect(h.scrolls).toEqual([]);
  });

  it("stays put with revealSelected off, and in mode none", () => {
    const off = harness({ revealSelected: false });
    off.viewport.width = VIEW;
    off.bars.boxes.push(makeBox("a", -300, 0));
    off.module.gridPress(press("a"));
    expect(off.scrolls).toEqual([]);

    const none = harness({ mode: "none" });
    none.viewport.width = VIEW;
    none.bars.boxes.push(makeBox("a", -300, 0));
    none.module.gridPress(press("a"));
    expect(none.scrolls).toEqual([]);
  });

  it("does nothing for a task with no bar box and no dates known", () => {
    const h = harness();
    h.module.service.select(["ghost"]);
    expect(h.scrolls).toEqual([]);
  });

  it("reads the reveal against the live scroll offset", () => {
    const h = harness();
    h.viewport.width = VIEW;
    h.viewport.scrollLeft = 250;
    h.bars.boxes.push(makeBox("a", -50, 0));
    h.module.gridPress(press("a"));
    expect(h.scrolls).toEqual([250 - 50 - M]);
  });

  // Deliberate deviation: `SelectionService.reveal(id)` is ungated — it works even with
  // `revealSelected: false`, which governs only the automatic reveals above.
  describe("`service.reveal(id)` — ungated, unlike the automatic paths (deliberate deviation)", () => {
    it("scrolls even with `revealSelected: false`", () => {
      const h = harness({ revealSelected: false });
      h.viewport.width = VIEW;
      h.bars.boxes.push(makeBox("a", -300, 0));
      h.module.service.reveal("a");
      expect(h.scrolls).toEqual([-300 - M]);
    });

    it("scrolls in mode \"none\" too", () => {
      const h = harness({ mode: "none" });
      h.viewport.width = VIEW;
      h.bars.boxes.push(makeBox("a", -300, 0));
      h.module.service.reveal("a");
      expect(h.scrolls).toEqual([-300 - M]);
    });

    it("does not itself change or publish the selection", () => {
      const h = harness();
      h.viewport.width = VIEW;
      h.bars.boxes.push(makeBox("a", -300, 0));
      h.module.service.reveal("a");
      expect(h.module.selected().size).toBe(0);
      expect(h.storeSnapshots).toEqual([]);
    });

    it("falls back to the task's own dates when no bar box is on screen", () => {
      const h = harness();
      h.viewport.width = VIEW;
      h.taskDates.set("a", { start: -300_000, end: -260_000 }); // pxPerMs 0.001 → x = -300
      h.module.service.reveal("a");
      expect(h.scrolls).toEqual([-300 - M]);
    });
  });
});
