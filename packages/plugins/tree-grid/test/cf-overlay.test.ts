/**
 * The bar overlay the conditional-formatting feature hands to the bar pass through
 * `taskbars/overlays`: progress-status coloring of the progress fill and the overdue warning icon,
 * reached the way the bar pass itself reaches it — through the composed extension point, drawing
 * into a recording 2d context.
 *
 * docs/specs/plugins/tree-grid.md § Extension points, § Internal modules.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Task } from "@stargantt/plugin-data-store";
import type { TreeGridConfig } from "../src/index";
import { resolveConfig } from "../src/internal/conditional-format/config";
import { overlayActive, progressStatus } from "../src/internal/conditional-format/overlay";
import { boot } from "./_boot";
import type { Booted } from "./_boot";
import { asContext, FakeContext2D } from "./_harness/index";
import { barBox, upwardProbe } from "./_upward";
import type { UpwardProbe } from "./_upward";

const DAY = 86_400_000;

function task(partial: Partial<Task>): Task {
  return { id: "t1", parentId: null, name: "T", start: 0, end: 10 * DAY, ...partial } as Task;
}

let b: Booted | undefined;
afterEach(() => {
  b?.gantt.dispose();
  b?.dom.restore();
  b = undefined;
});

/** Boots with the given `conditionalFormat` nest and hands back the upward probe wired to it. */
function bootWith(
  conditionalFormat: NonNullable<TreeGridConfig["conditionalFormat"]>,
): { b: Booted; probe: UpwardProbe } {
  const probe = upwardProbe();
  b = boot([probe.plugin], {}, { conditionalFormat });
  return { b, probe };
}

/** A fresh recording context, plus the double a test reads its calls off. */
function ctx(): { fake: FakeContext2D; g: CanvasRenderingContext2D } {
  const fake = new FakeContext2D();
  return { fake, g: asContext(fake) };
}

describe("progressStatus", () => {
  it("classifies complete, behind and on-track against the expected fraction", () => {
    expect(progressStatus(task({ progress: 1 }), 5 * DAY)).toBe("complete");
    // Halfway through, 20% done → behind.
    expect(progressStatus(task({ progress: 0.2 }), 5 * DAY)).toBe("behind");
    // Halfway through, 60% done → on track.
    expect(progressStatus(task({ progress: 0.6 }), 5 * DAY)).toBe("onTrack");
    // Before the start nothing is expected yet.
    expect(progressStatus(task({ progress: 0 }), -DAY)).toBe("onTrack");
    // A zero-length span expects nothing.
    expect(progressStatus(task({ progress: 0, end: 0 }), 5 * DAY)).toBe("onTrack");
  });
});

describe("the overlay contribution — progress coloring", () => {
  it("repaints the progress portion in the status color", () => {
    const { b, probe } = bootWith({ progress: { behind: "beh" }, now: () => 5 * DAY });
    b.data.load([{ id: "t0", parentId: null, name: "T", start: 0, end: 10 * DAY, progress: 0.25 }]);
    const { fake, g } = ctx();
    probe.paintOverlays(g, barBox({ x: 100, width: 200 }));
    const fill = fake.calls("fillRect")[0];
    expect(fill?.args).toEqual([100, 4, 50, 20]);
    expect(fill?.fill).toBe("beh");
  });

  it("draws nothing for milestones, summaries, or tasks without numeric progress", () => {
    const { b, probe } = bootWith({ progress: true, now: () => 5 * DAY });
    b.data.load([
      { id: "m", parentId: null, name: "M", start: 0, end: 10 * DAY, type: "milestone", progress: 0.5 },
      { id: "s", parentId: null, name: "S", start: 0, end: 10 * DAY, type: "summary", progress: 0.5 },
      { id: "n", parentId: null, name: "N", start: 0, end: 10 * DAY },
    ]);
    const { fake, g } = ctx();
    probe.paintOverlays(g, barBox({ id: "m", x: 100, width: 200 }));
    probe.paintOverlays(g, barBox({ id: "s", x: 100, width: 200 }));
    probe.paintOverlays(g, barBox({ id: "n", x: 100, width: 200 }));
    probe.paintOverlays(g, barBox({ id: "unknown", x: 100, width: 200 }));
    expect(fake.calls("fillRect")).toHaveLength(0);
  });
});

describe("the overlay contribution — warning icon", () => {
  it("draws the triangle and glyph for an overdue task, inside a wide bar", () => {
    const { b, probe } = bootWith({ overdue: { color: "warn" }, now: () => 5 * DAY });
    b.data.load([{ id: "t0", parentId: null, name: "T", start: 0, end: DAY, progress: 0.5 }]);
    const { fake, g } = ctx();
    const bar = barBox({ x: 100, width: 200 });
    probe.paintOverlays(g, bar);
    // The triangle: one fill() whose path state carries the warning color.
    const fills = fake.calls("fill");
    expect(fills).toHaveLength(1);
    expect(fills[0]?.fill).toBe("warn");
    // The glyph: two white rects, anchored inside the bar's right end.
    const rects = fake.calls("fillRect");
    expect(rects).toHaveLength(2);
    expect(rects.every((o) => o.fill === "#ffffff")).toBe(true);
    const cx = bar.x + bar.width - 7;
    expect(rects[0]?.args[0]).toBeCloseTo(cx - 0.75);
  });

  it("draws no icon when the task is not overdue or icon is disabled", () => {
    const { b, probe } = bootWith({ overdue: true, now: () => 5 * DAY });
    b.data.load([{ id: "t0", parentId: null, name: "T", start: 0, end: 20 * DAY, progress: 0.5 }]);
    const { fake, g } = ctx();
    probe.paintOverlays(g, barBox({ x: 100, width: 200 }));
    expect(fake.calls("fill")).toHaveLength(0);

    const rOff = resolveConfig({ overdue: { icon: false }, now: () => 5 * DAY });
    expect(overlayActive({ progress: rOff.progress, overdue: rOff.overdue })).toBe(false);
  });
});

// The status fill is clipped to the bar's rounded-corner outline inside save/clip/restore, and the
// behind/complete defaults are translucent so a label drawn into the bar before the overlay stays
// readable through the wash.
describe("the overlay contribution — rounded-corner clip and translucent defaults", () => {
  it("clips the status fill to the bar's rounded path — no paint outside the corner curve", () => {
    const { b, probe } = bootWith({ progress: { behind: "beh" }, now: () => 5 * DAY });
    b.themeTokens.set({ "--sg-bar-radius": "4px" });
    b.data.load([{ id: "t0", parentId: null, name: "T", start: 0, end: 10 * DAY, progress: 0.25 }]);
    const { fake, g } = ctx();
    const bar = barBox({ x: 100, width: 200 });
    probe.paintOverlays(g, bar);
    // Recorded op order: save → (rounded path) → clip → the status fillRect → restore, so every
    // status pixel is confined to the bar's own shape and the clip cannot leak past the overlay.
    const ops = fake.opNames();
    const save = ops.indexOf("save");
    const clip = ops.indexOf("clip");
    const fill = ops.indexOf("fillRect");
    const restore = ops.indexOf("restore");
    expect(save).toBeGreaterThanOrEqual(0);
    expect(clip).toBeGreaterThan(save);
    expect(fill).toBeGreaterThan(clip);
    expect(restore).toBeGreaterThan(fill);
    // The clip path is the bar body's rounded rectangle: four arcTo corners at the bar's edges
    // with the configured radius, traced between the save and the clip.
    const arcs = fake.calls("arcTo");
    expect(arcs).toHaveLength(4);
    expect(arcs.every((o) => o.args[4] === 4)).toBe(true);
    expect(arcs[0]?.args.slice(0, 4)).toEqual([
      bar.x + bar.width,
      bar.y,
      bar.x + bar.width,
      bar.y + bar.height,
    ]);
    // The fill itself still covers exactly the progress portion; the clip does the shaping.
    expect(fake.calls("fillRect")[0]?.args).toEqual([100, 4, 50, 20]);
  });

  it("clamps the clip radius to half the bar's smaller side", () => {
    const { b, probe } = bootWith({ progress: { behind: "beh" }, now: () => 5 * DAY });
    b.themeTokens.set({ "--sg-bar-radius": "100px" });
    b.data.load([{ id: "t0", parentId: null, name: "T", start: 0, end: 10 * DAY, progress: 0.5 }]);
    const { fake, g } = ctx();
    probe.paintOverlays(g, barBox({ x: 100, width: 200 })); // height 20 → radius clamps to 10
    expect(fake.calls("arcTo").every((o) => o.args[4] === 10)).toBe(true);
  });

  it("still clips with radius 0 (square path) and never leaks the clip onto the icon", () => {
    const { b, probe } = bootWith({ progress: true, overdue: true, now: () => 5 * DAY });
    b.data.load([{ id: "t0", parentId: null, name: "T", start: 0, end: DAY, progress: 0.5 }]);
    const { fake, g } = ctx();
    probe.paintOverlays(g, barBox({ x: 100, width: 200 }));
    // The status fill's restore precedes the warning triangle's fill(), so the icon — allowed to
    // sit just outside a narrow bar — is not caught by the progress clip.
    const ops = fake.opNames();
    expect(ops.indexOf("restore")).toBeGreaterThan(ops.indexOf("clip"));
    expect(ops.indexOf("fill")).toBeGreaterThan(ops.indexOf("restore"));
  });

  it("defaults behind and complete to translucent washes so an inside label stays readable", () => {
    const r = resolveConfig({ progress: true });
    expect(r.progress).toEqual({
      behind: "rgba(197, 48, 48, 0.35)",
      onTrack: "var(--sg-bar-fill, #0f766e)",
      complete: "rgba(47, 133, 90, 0.35)",
    });
    // A host may still configure opaque colors — they pass through unchanged.
    const opaque = resolveConfig({ progress: { behind: "#c53030", complete: "#2f855a" } });
    expect(opaque.progress?.behind).toBe("#c53030");
    expect(opaque.progress?.complete).toBe("#2f855a");
  });

  it("paints the default behind wash translucently over whatever was drawn before it", () => {
    const { b, probe } = bootWith({ progress: true, now: () => 5 * DAY });
    b.data.load([{ id: "t0", parentId: null, name: "T", start: 0, end: 10 * DAY, progress: 0.2 }]);
    const { fake, g } = ctx();
    // A stand-in for the bar label the bar pass painted earlier in the frame.
    g.fillStyle = "#111111";
    g.fillRect(110, 8, 40, 12);
    probe.paintOverlays(g, barBox({ x: 100, width: 200 }));
    const fills = fake.calls("fillRect");
    // The label op precedes the status fill, and the status fill carries alpha — the earlier label
    // pixels remain visible through it.
    expect(fills[0]?.fill).toBe("#111111");
    expect(fills[1]?.fill).toBe("rgba(197, 48, 48, 0.35)");
  });
});
