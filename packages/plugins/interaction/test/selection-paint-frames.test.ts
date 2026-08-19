// `paintSelectionFrames`'s two traversal strategies (per-id lookup vs. scanning the visible band)
// must paint the same thing, exercised against this package's own recording canvas and geometry
// doubles. Rather than driving a real `Gantt.create()` composite, this drives
// `createSelectionModule` + `paintSelectionFrames` directly, exactly what `src/index.ts`'s
// `renderer/layers` contribution does (that wiring itself is out of this file's scope).
import { describe, expect, it } from "vitest";
import { DIRECT_LOOKUP_MAX, SELECTION_OUTSET, paintSelectionFrames } from "../src/internal/selection/paint";
import type { BarGeometry } from "../src/internal/selection/paint";
import type { BarBox } from "@stargantt/plugin-task-bars";
import { fakeCanvas, harness } from "./_selection-fakes";

function box(id: string, x: number, y: number): BarBox {
  return { id, x, y, width: 40, height: 20, gutterStart: 0, gutterEnd: 0 };
}

/** A geometry double that counts which of its two reads the pass used. */
function geometry(boxes: BarBox[]): BarGeometry & { lookups: number; scans: number } {
  const index = new Map(boxes.map((b) => [b.id, b]));
  const g = {
    lookups: 0,
    scans: 0,
    barBoxOf(id: string | number): BarBox | undefined {
      g.lookups += 1;
      return index.get(id);
    },
    visibleBoxes(): readonly BarBox[] {
      g.scans += 1;
      return boxes.slice();
    },
  };
  return g;
}

/** Every frame the pass drew, as `[x, y, w, h]` tuples sorted so traversal order does not matter. */
function frames(g: ReturnType<typeof fakeCanvas>): number[][] {
  return g.ops
    .filter((op) => op.op === "strokeRect")
    .map((op) => [...op.args])
    .sort((a, b) => (a[1] ?? 0) - (b[1] ?? 0) || (a[0] ?? 0) - (b[0] ?? 0));
}

function paint(
  selected: Iterable<string | number>,
  boxes: BarBox[],
): { frames: number[][]; geo: ReturnType<typeof geometry> } {
  const g = fakeCanvas();
  const geo = geometry(boxes);
  paintSelectionFrames(g, new Set(selected), geo, "#000");
  return { frames: frames(g), geo };
}

describe("paintSelectionFrames", () => {
  it("looks each selected bar up directly for a small selection, without materializing the band", () => {
    const boxes = [box("a", 0, 0), box("b", 0, 30), box("c", 0, 60)];
    const { frames: drawn, geo } = paint(["a", "c"], boxes);

    expect(geo.scans).toBe(0); // the visible band was never walked
    expect(geo.lookups).toBe(2); // one lookup per selected id
    expect(drawn).toEqual([
      [-SELECTION_OUTSET, -SELECTION_OUTSET, 40 + SELECTION_OUTSET * 2, 20 + SELECTION_OUTSET * 2],
      [-SELECTION_OUTSET, 60 - SELECTION_OUTSET, 40 + SELECTION_OUTSET * 2, 20 + SELECTION_OUTSET * 2],
    ]);
  });

  it("walks the visible band instead once the selection outgrows it, painting the same frames", () => {
    // A screenful of bars with a select-all-sized selection behind it — the Ctrl+A case.
    const boxes = Array.from({ length: 20 }, (_, i) => box(`t${i}`, 0, i * 30));
    const huge = Array.from({ length: 5000 }, (_, i) => `t${i}`);

    const big = paint(huge, boxes);
    expect(big.geo.scans).toBe(1);
    // The whole point: work is bounded by the visible band, not by the selection.
    expect(big.geo.lookups).toBe(0);
    expect(big.frames).toHaveLength(20);

    // Same visible bars, selected one by one through the other branch: identical output.
    const small = paint(
      boxes.map((b) => b.id),
      boxes,
    );
    expect(small.geo.scans).toBe(0);
    expect(small.frames).toEqual(big.frames);
  });

  it("draws nothing for an empty selection and skips ids with no bar on screen", () => {
    const boxes = [box("a", 0, 0)];
    expect(paint([], boxes).frames).toEqual([]);
    expect(paint(["a", "off-screen"], boxes).frames).toHaveLength(1);

    // The scanning branch never draws a frame for an id it has no box for either.
    const many = Array.from({ length: DIRECT_LOOKUP_MAX + 5 }, (_, i) => `ghost${i}`);
    expect(paint([...many, "a"], boxes).frames).toHaveLength(1);
  });
});

describe("the selection layer through the selection module", () => {
  it("paints one frame per visible selected bar whichever branch the selection size takes", () => {
    const h = harness({ mode: "multi" });
    const boxes = Array.from({ length: 6 }, (_, i) => box(`t${i}`, 10, i * 30));
    h.bars.boxes.push(...boxes.map((b) => ({ id: b.id, x: b.x, y: b.y, width: b.width, height: b.height })));

    h.module.service.select(["t1", "t4"]);
    const g1 = fakeCanvas();
    paintSelectionFrames(g1, h.module.selected(), h.bars);
    expect(frames(g1)).toHaveLength(2);

    // A selection far larger than the visible band — every visible bar is framed, once.
    const all = [...boxes.map((x) => x.id), ...Array.from({ length: 200 }, (_, i) => `hidden${i}`)];
    h.module.service.select(all);
    const g2 = fakeCanvas();
    paintSelectionFrames(g2, h.module.selected(), h.bars);

    const g3 = fakeCanvas();
    paintSelectionFrames(g3, new Set(boxes.map((x) => x.id)), geometry(boxes));
    expect(frames(g2)).toEqual(frames(g3));
  });
});
