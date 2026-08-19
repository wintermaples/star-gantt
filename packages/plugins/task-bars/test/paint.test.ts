/**
 * `src/internal/paint.ts` and `src/internal/paint-text.ts` — the drawing calls a bar body and a
 * single label produce, against the recording context double.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Task } from "@stargantt/plugin-data-store";
import {
  DEFAULT_BAR_COLOR,
  DEFAULT_MILESTONE_COLOR,
  DEFAULT_SUMMARY_COLOR,
  DEFAULT_TRACK_ALPHA,
  LABEL_COLOR,
  LABEL_FONT,
  SUMMARY_BODY_RATIO,
  defaultColorFor,
  paintBar,
} from "../src/internal/paint";
import { LABEL_GAP, drawLabel } from "../src/internal/paint-text";
import { FakeContext2D, asContext } from "./_utils/canvas";

const BOX = { x: 100, y: 10, width: 80, height: 20 };

function task(over: Partial<Task> = {}): Task {
  return { id: "t", parentId: null, name: "t", start: 0, end: 86_400_000, ...over };
}

let g: FakeContext2D;

beforeEach(() => {
  g = new FakeContext2D();
});

describe("defaultColorFor", () => {
  it("gives each task type its own built-in fill", () => {
    expect(defaultColorFor(task())).toBe(DEFAULT_BAR_COLOR);
    expect(defaultColorFor(task({ type: "task" }))).toBe(DEFAULT_BAR_COLOR);
    expect(defaultColorFor(task({ type: "summary" }))).toBe(DEFAULT_SUMMARY_COLOR);
    expect(defaultColorFor(task({ type: "milestone" }))).toBe(DEFAULT_MILESTONE_COLOR);
  });
});

// A bar is a full-length track of its own fill at `--sg-bar-track-alpha` with the completed part
// painted over it at full opacity, so progress reads as more of the same colour rather than as a
// darker second colour.
describe("paintBar — ordinary task", () => {
  it("paints an unstarted bar as a track in the given colour", () => {
    paintBar(asContext(g), BOX, task(), "#abc");
    expect(g.calls("fillRect")).toHaveLength(1);
    expect(g.calls("fillRect")[0]).toMatchObject({
      op: "fillRect",
      args: [100, 10, 80, 20],
      fill: "#abc",
      globalAlpha: DEFAULT_TRACK_ALPHA,
    });
  });

  it("paints the completed fraction over the track at full opacity", () => {
    paintBar(asContext(g), BOX, task({ progress: 0.25 }), "#abc");
    const rects = g.calls("fillRect");
    expect(rects).toHaveLength(2);
    expect(rects[0]).toMatchObject({ args: [100, 10, 80, 20], globalAlpha: DEFAULT_TRACK_ALPHA });
    expect(rects[1]).toMatchObject({
      op: "fillRect",
      args: [100, 10, 20, 20],
      fill: "#abc",
      globalAlpha: 1,
    });
  });

  it("paints only the track for zero, missing or negative progress", () => {
    for (const progress of [undefined, 0, -1, Number.NaN]) {
      g = new FakeContext2D();
      paintBar(asContext(g), BOX, task(progress === undefined ? {} : { progress }), "#abc");
      expect(g.calls("fillRect")).toHaveLength(1);
      expect(g.calls("fillRect")[0]?.globalAlpha).toBe(DEFAULT_TRACK_ALPHA);
    }
  });

  // A fully complete bar has no remainder to show, so it skips the track entirely and paints one
  // solid rectangle — byte-identical to what a plain opaque bar would have painted.
  it("paints a fully complete bar as one solid rectangle", () => {
    paintBar(asContext(g), BOX, task({ progress: 1 }), "#abc");
    const rects = g.calls("fillRect");
    expect(rects).toHaveLength(1);
    expect(rects[0]).toMatchObject({ args: [100, 10, 80, 20], fill: "#abc", globalAlpha: 1 });
  });

  it("uses the given track alpha, defaulting to the built-in one", () => {
    paintBar(asContext(g), BOX, task({ progress: 0.25 }), "#abc", 0.5);
    expect(g.calls("fillRect")[0]?.globalAlpha).toBe(0.5);

    g = new FakeContext2D();
    paintBar(asContext(g), BOX, task({ progress: 0.25 }), "#abc");
    expect(g.calls("fillRect")[0]?.globalAlpha).toBe(DEFAULT_TRACK_ALPHA);
  });

  it("restores the context's alpha after painting", () => {
    const ctx = asContext(g);
    paintBar(ctx, BOX, task({ progress: 0.25 }), "#abc");
    expect(g.globalAlpha).toBe(1);
  });

  it("clamps a progress above 1 to the full bar width", () => {
    paintBar(asContext(g), BOX, task({ progress: 4 }), "#abc");
    expect(g.calls("fillRect")[0]?.args).toEqual([100, 10, 80, 20]);
    expect(g.calls("fillRect")[0]?.globalAlpha).toBe(1);
  });
});

describe("drawLabel", () => {
  it("draws one line to the right of the box, vertically centred on it", () => {
    drawLabel(asContext(g), BOX, "hello");
    expect(g.texts).toMatchObject([
      {
        text: "hello",
        x: BOX.x + BOX.width + LABEL_GAP,
        y: BOX.y + BOX.height / 2,
        fill: LABEL_COLOR,
        font: LABEL_FONT,
        align: "left",
        baseline: "middle",
      },
    ]);
  });

  it("uses the given colour and measures nothing", () => {
    drawLabel(asContext(g), BOX, "hello", "#0a0b0c");
    expect(g.texts[0]?.fill).toBe("#0a0b0c");
    expect(g.calls("fillText")).toHaveLength(1);
    expect(g.ops.map((o) => o.op)).toEqual(["fillText"]);
  });

  // The font shorthand is assigned verbatim, and the default is the canvas default, so an unthemed
  // chart paints what it painted before the token existed.
  it("assigns the given font, defaulting to the canvas default", () => {
    g.font = "12px serif";
    drawLabel(asContext(g), BOX, "hello");
    expect(g.font).toBe(LABEL_FONT);
    expect(LABEL_FONT).toBe("12px system-ui, sans-serif");

    drawLabel(asContext(g), BOX, "hello", LABEL_COLOR, "italic 700 14px/1.2 Inter, serif");
    expect(g.font).toBe("italic 700 14px/1.2 Inter, serif");
    expect(g.texts[1]?.font).toBe("italic 700 14px/1.2 Inter, serif");
  });
});

describe("paintBar — milestone", () => {
  it("fills a diamond inscribed in the box and no rectangle", () => {
    paintBar(asContext(g), BOX, task({ type: "milestone" }), "#123");
    expect(g.calls("fillRect")).toHaveLength(0);
    expect(g.calls("fill")).toHaveLength(1);
    const points = [...g.calls("moveTo"), ...g.calls("lineTo")].map((o) => o.args);
    expect(points).toEqual([
      [140, 10],
      [180, 20],
      [140, 30],
      [100, 20],
    ]);
    expect(g.calls("closePath")).toHaveLength(1);
  });
});

describe("paintBar — summary", () => {
  it("draws a thin body across the box with a cap at each end", () => {
    paintBar(asContext(g), BOX, task({ type: "summary" }), "#456");
    const body = g.calls("fillRect");
    expect(body).toHaveLength(1);
    expect(body[0]?.args).toEqual([100, 10, 80, 20 * SUMMARY_BODY_RATIO]);
    expect(g.calls("fill")).toHaveLength(2);
    expect(g.calls("beginPath")).toHaveLength(2);
  });

  it("never lets the two caps overlap on a very narrow summary", () => {
    const narrow = { x: 0, y: 0, width: 6, height: 40 };
    paintBar(asContext(g), narrow, task({ type: "summary" }), "#456");
    const xs = [...g.calls("moveTo"), ...g.calls("lineTo")].map((o) => o.args[0] ?? 0);
    expect(Math.max(...xs)).toBeLessThanOrEqual(6);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
  });

  it("shows no progress fill, since summary dates roll up from children", () => {
    paintBar(asContext(g), BOX, task({ type: "summary", progress: 0.5 }), "#456");
    expect(g.ops.every((o) => o.globalAlpha === 1)).toBe(true);
  });
});

// The outline and the bevel are theme-driven and both default to off, so the first thing to pin is
// that a bar painted with no decoration options is byte-identical to before.
describe("bar decoration: outline and bevel", () => {
  it("paints neither by default", () => {
    paintBar(asContext(g), BOX, task(), DEFAULT_BAR_COLOR);
    expect(g.calls("stroke")).toHaveLength(0);
    expect(g.gradients).toHaveLength(0);
  });

  it("ignores a stroke width of zero and a stroke with no colour", () => {
    paintBar(asContext(g), BOX, task(), DEFAULT_BAR_COLOR, undefined, {
      stroke: "#000000",
      strokeWidth: 0,
    });
    paintBar(asContext(g), BOX, task(), DEFAULT_BAR_COLOR, undefined, {
      stroke: "",
      strokeWidth: 2,
    });
    expect(g.calls("stroke")).toHaveLength(0);
  });

  it("outlines an ordinary bar on the path its fill used, and restores the entry stroke state", () => {
    g.strokeStyle = "#entry";
    g.lineWidth = 7;
    paintBar(asContext(g), BOX, task(), DEFAULT_BAR_COLOR, undefined, {
      stroke: "#1f3f63",
      strokeWidth: 1,
    });
    const strokes = g.calls("stroke");
    expect(strokes).toHaveLength(1);
    expect(strokes[0]?.stroke).toBe("#1f3f63");
    expect(strokes[0]?.lineWidth).toBe(1);
    // A decoration must not leak its own stroke state into whatever the layer paints next.
    expect(g.strokeStyle).toBe("#entry");
    expect(g.lineWidth).toBe(7);
  });

  it("outlines summaries and milestones too", () => {
    paintBar(asContext(g), BOX, task({ type: "summary" }), DEFAULT_SUMMARY_COLOR, undefined, {
      stroke: "#000080",
      strokeWidth: 1,
    });
    expect(g.calls("stroke")).toHaveLength(1);

    const g2 = new FakeContext2D();
    paintBar(asContext(g2), BOX, task({ type: "milestone" }), DEFAULT_MILESTONE_COLOR, undefined, {
      stroke: "#000000",
      strokeWidth: 1,
    });
    expect(g2.calls("stroke")).toHaveLength(1);
  });

  it("overlays a white→transparent→black bevel and restores the entry fill", () => {
    paintBar(asContext(g), BOX, task(), DEFAULT_BAR_COLOR, undefined, { bevel: 0.2 });
    expect(g.gradients).toHaveLength(1);
    // Vertical, spanning exactly the bar's own height — the bevel follows the shape, not the box
    // of whatever was painted before it.
    expect(g.gradients[0]?.line).toEqual([0, BOX.y, 0, BOX.y + BOX.height]);
    expect(g.gradients[0]?.stops).toEqual([
      { offset: 0, color: "rgba(255, 255, 255, 0.2)" },
      { offset: 0.5, color: "rgba(255, 255, 255, 0)" },
      { offset: 1, color: "rgba(0, 0, 0, 0.2)" },
    ]);
    expect(g.fillStyle).toBe(DEFAULT_BAR_COLOR);
  });

  it("paints the bevel over the whole bar, not only the completed part", () => {
    paintBar(asContext(g), BOX, task({ progress: 0.5 }), DEFAULT_BAR_COLOR, undefined, {
      bevel: 0.2,
    });
    // One gradient for the bar, spanning its full height; the completed part is not bevelled
    // separately, which is what keeps a half-finished bar wearing one continuous gloss.
    expect(g.gradients).toHaveLength(1);
    expect(g.gradients[0]?.line).toEqual([0, BOX.y, 0, BOX.y + BOX.height]);
  });
});
