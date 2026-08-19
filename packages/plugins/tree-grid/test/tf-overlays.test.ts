import { describe, expect, it } from "vitest";
import type { BarBox } from "../src/internal/upward";
import { makeOverlayRenderer } from "../src/internal/task-fields/overlays";
import type { OverlayDeps } from "../src/internal/task-fields/overlays";
import type { TaskFieldValues } from "../src/types";

const NOW = 1_000_000;
const BAR: Readonly<BarBox> = {
  id: "a",
  x: 100,
  y: 10,
  width: 80,
  height: 20,
  gutterStart: 0,
  gutterEnd: 0,
};

/** Records every draw call the overlay makes; enough of a 2d context for these shapes. */
function recorder() {
  const ops: string[] = [];
  const fills: string[] = [];
  const texts: string[] = [];
  const g = {
    save: () => ops.push("save"),
    restore: () => ops.push("restore"),
    beginPath: () => ops.push("beginPath"),
    closePath: () => ops.push("closePath"),
    moveTo: () => ops.push("moveTo"),
    lineTo: () => ops.push("lineTo"),
    stroke: () => ops.push("stroke"),
    fill: () => ops.push("fill"),
    fillRect: () => ops.push("fillRect"),
    arc: () => ops.push("arc"),
    fillText: (text: string) => {
      ops.push("fillText");
      texts.push(text);
    },
    set fillStyle(v: string) {
      fills.push(v);
    },
    set strokeStyle(_v: string) {},
    set lineWidth(_v: number) {},
    set textAlign(_v: string) {},
    set textBaseline(_v: string) {},
    set font(_v: string) {},
  } as unknown as CanvasRenderingContext2D;
  return { g, ops, fills, texts };
}

function deps(
  fields: TaskFieldValues,
  names: string[] = [],
  overrides: Partial<OverlayDeps> = {},
): OverlayDeps {
  return {
    showStatus: true,
    showDeadline: true,
    showAvatars: true,
    fieldsOf: () => fields,
    assigneeNamesOf: () => names,
    // The theme is a hard dependency now, so the default double resolves every token to "".
    themeGet: () => "",
    now: () => NOW,
    ...overrides,
  };
}

describe("bar overlays", () => {
  it("draws nothing for a task with no fields and no assignees", () => {
    const r = recorder();
    makeOverlayRenderer(deps({}))(r.g, BAR);
    expect(r.ops).toEqual([]);
  });

  it("draws the status glyph per status, none for not-started, none on tiny bars", () => {
    const done = recorder();
    makeOverlayRenderer(deps({ status: "done" }))(done.g, BAR);
    expect(done.ops).toContain("stroke"); // check mark strokes

    const progress = recorder();
    makeOverlayRenderer(deps({ status: "in-progress" }))(progress.g, BAR);
    expect(progress.ops).toContain("fill"); // triangle fills

    const notStarted = recorder();
    makeOverlayRenderer(deps({ status: "not-started" }))(notStarted.g, BAR);
    expect(notStarted.ops).toEqual([]);

    const tiny = recorder();
    makeOverlayRenderer(deps({ status: "done" }))(tiny.g, { ...BAR, height: 6 });
    expect(tiny.ops).toEqual([]);
  });

  it("draws the deadline warning only when overdue, with the theme token when present", () => {
    const overdue = recorder();
    makeOverlayRenderer(deps({ deadline: NOW - 1 }))(overdue.g, BAR);
    expect(overdue.fills).toContain("#d32f2f"); // fallback color

    const themed = recorder();
    makeOverlayRenderer(
      deps({ deadline: NOW - 1 }, [], { themeGet: (token) => (token.includes("warning") ? "red" : "") }),
    )(themed.g, BAR);
    expect(themed.fills).toContain("red");

    const future = recorder();
    makeOverlayRenderer(deps({ deadline: NOW + 1 }))(future.g, BAR);
    expect(future.ops).toEqual([]);

    const doneTask = recorder();
    makeOverlayRenderer(deps({ deadline: NOW - 1, status: "done" }))(doneTask.g, BAR);
    // The status check mark draws, but no warning triangle (no fill of the warning color).
    expect(doneTask.fills).not.toContain("#d32f2f");
  });

  it("draws up to three avatar initials plus a +n circle", () => {
    const r = recorder();
    makeOverlayRenderer(deps({}, ["ann", "bob", "cid", "dee", "eve"]))(r.g, BAR);
    expect(r.texts).toEqual(["A", "B", "C", "+2"]);
  });

  it("places the warning triangle and avatars outside a non-zero end gutter", () => {
    const GUTTER = 17;
    const barWithGutter: Readonly<BarBox> = { ...BAR, gutterEnd: GUTTER };
    const arcCenters: number[] = [];
    const triangleXs: number[] = [];
    let sawWarningFill = false;
    const g = {
      save: () => {},
      restore: () => {},
      beginPath: () => {},
      closePath: () => {},
      moveTo: (x: number) => triangleXs.push(x),
      lineTo: () => {},
      stroke: () => {},
      fill: () => {
        sawWarningFill = true;
      },
      fillRect: () => {},
      arc: (cx: number) => arcCenters.push(cx),
      fillText: () => {},
      set fillStyle(_v: string) {},
      set strokeStyle(_v: string) {},
      set lineWidth(_v: number) {},
      set textAlign(_v: string) {},
      set textBaseline(_v: string) {},
      set font(_v: string) {},
    } as unknown as CanvasRenderingContext2D;

    makeOverlayRenderer(deps({ deadline: NOW - 1 }, ["ann"]))(g, barWithGutter);

    expect(sawWarningFill).toBe(true);
    // Warning triangle's own +3 offset is relative to the gutter-cleared start
    // (bar.x + bar.width + gutterEnd), per .
    const gutterStartX = barWithGutter.x + barWithGutter.width + GUTTER;
    expect(Math.min(...triangleXs)).toBe(gutterStartX + 3);
    // The avatar circle starts right of the warning triangle, which itself cleared the gutter.
    const warningRight = gutterStartX + 3 + 10; // WARNING_SIZE
    expect(arcCenters[0]).toBeGreaterThan(warningRight);
  });

  it("honors the per-part flags", () => {
    const r = recorder();
    makeOverlayRenderer(
      deps({ status: "done", deadline: NOW - 1 }, ["ann"], {
        showStatus: false,
        showDeadline: false,
        showAvatars: false,
      }),
    )(r.g, BAR);
    expect(r.ops).toEqual([]);
  });
});
