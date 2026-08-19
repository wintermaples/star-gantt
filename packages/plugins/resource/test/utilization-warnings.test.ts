// docs/specs/plugins/resource.md §3.5 — the overload warning glyph's exact geometry (M2), and the
// warned-task index's resource-order name list (the CELL-NAME ORDER review item).
import { describe, expect, it } from "vitest";
import { createWarningIndex, paintWarningTriangle } from "../src/internal/utilization/warnings";
import type { ResourceAreaDeps } from "../src/internal/areas";
import type { UtilizationState } from "../src/index";

const DAY = 86_400_000;
const MONDAY = Date.UTC(2024, 0, 1);

/** A minimal `CanvasRenderingContext2D` double that records every call, in order. */
function fakeContext(): CanvasRenderingContext2D & { calls: string[] } {
  const calls: string[] = [];
  const ctx = {
    calls,
    beginPath: () => calls.push("beginPath"),
    moveTo: (x: number, y: number) => calls.push(`moveTo(${x},${y})`),
    lineTo: (x: number, y: number) => calls.push(`lineTo(${x},${y})`),
    closePath: () => calls.push("closePath"),
    fill: () => calls.push("fill"),
    fillText: (text: string, x: number, y: number) => calls.push(`fillText(${text},${x},${y})`),
    set fillStyle(v: string) {
      calls.push(`fillStyle=${v}`);
    },
    set font(v: string) {
      calls.push(`font=${v}`);
    },
    set textAlign(v: string) {
      calls.push(`textAlign=${v}`);
    },
    set textBaseline(v: string) {
      calls.push(`textBaseline=${v}`);
    },
  };
  return ctx as unknown as CanvasRenderingContext2D & { calls: string[] };
}

describe("paintWarningTriangle geometry (M2)", () => {
  it("centers the triangle at bar.x + bar.width + bar.gutterEnd + 8, apex up, half-size 5.5", () => {
    const g = fakeContext();
    paintWarningTriangle(
      g,
      { id: "t1", x: 100, y: 20, width: 40, height: 20, gutterStart: 0, gutterEnd: 6 },
      "#c62828",
    );
    // cx = 100 + 40 + 6 + 8 = 154; cy = 20 + 20/2 = 30; half = 5.5
    expect(g.calls).toContain("moveTo(154,24.5)"); // cy - half (apex, pointing up)
    expect(g.calls).toContain("lineTo(159.5,35.5)"); // cx + half, cy + half
    expect(g.calls).toContain("lineTo(148.5,35.5)"); // cx - half, cy + half
  });

  it("the '!' glyph is centered on cx at baseline cy + 2 (not the earlier cy + half*0.15 draft)", () => {
    const g = fakeContext();
    paintWarningTriangle(
      g,
      { id: "t1", x: 0, y: 0, width: 0, height: 10, gutterStart: 0, gutterEnd: 0 },
      "#c62828",
    );
    // cx = 0 + 0 + 0 + 8 = 8; cy = 0 + 10/2 = 5; baseline = cy + 2 = 7
    expect(g.calls).toContain("fillText(!,8,7)");
  });

  it("no bar.gutterEnd contribution beyond the flat 8px gap — TRIANGLE_SIZE/2 is not added to cx", () => {
    const g = fakeContext();
    paintWarningTriangle(
      g,
      { id: "t1", x: 0, y: 0, width: 100, height: 20, gutterStart: 0, gutterEnd: 0 },
      "#c62828",
    );
    // cx = 0 + 100 + 0 + 8 = 108 exactly (not 108 + 5.5 = 113.5, the pre-fix formula).
    expect(g.calls).toContain("fillText(!,108,12)");
  });
});

/** A `deps.data.query()` double carrying only the two members `buildIndex` reads. */
function fakeDeps(view: {
  byId: Map<string, { start: number; end: number }>;
  assignmentsByTask: Map<string, { resourceId: string; units: number }[]>;
}): ResourceAreaDeps {
  return {
    data: { query: () => view },
    ctx: { own: () => undefined },
  } as unknown as ResourceAreaDeps;
}

function fakeStateStore(snapshot: UtilizationState): { get: () => UtilizationState; subscribe: () => { dispose(): void } } {
  return { get: () => snapshot, subscribe: () => ({ dispose: () => undefined }) };
}

describe("warned-task name order (CELL-NAME ORDER review item)", () => {
  it("lists names in RESOURCE (union roster / snapshot.rows) order, not the task's own assignment order", () => {
    // `snapshot.rows` order is roster order (Zed before Ada); the task's OWN assignment order is
    // reversed (Ada before Zed). The warned-name list must follow the roster, not the assignments.
    const snapshot: UtilizationState = {
      rows: [
        {
          resourceId: "zed",
          name: "Zed",
          buckets: [{ start: MONDAY, end: MONDAY + DAY, allocated: 2 * DAY, capacity: DAY, ratio: 2, overallocated: true }],
        },
        {
          resourceId: "ada",
          name: "Ada",
          buckets: [{ start: MONDAY, end: MONDAY + DAY, allocated: 2 * DAY, capacity: DAY, ratio: 2, overallocated: true }],
        },
      ],
    };
    const view = {
      byId: new Map([["t1", { start: MONDAY, end: MONDAY + DAY }]]),
      assignmentsByTask: new Map([
        ["t1", [{ resourceId: "ada", units: 1 }, { resourceId: "zed", units: 1 }]],
      ]),
    };
    const index = createWarningIndex(fakeDeps(view), fakeStateStore(snapshot));
    expect(index.overResourceNamesFor("t1")).toEqual(["Zed", "Ada"]);
    expect(index.isWarned("t1")).toBe(true);
  });

  it("a resource assigned but not over-allocated is excluded; a clean task lists nothing", () => {
    const snapshot: UtilizationState = {
      rows: [
        {
          resourceId: "zed",
          name: "Zed",
          buckets: [{ start: MONDAY, end: MONDAY + DAY, allocated: DAY, capacity: 2 * DAY, ratio: 0.5, overallocated: false }],
        },
      ],
    };
    const view = {
      byId: new Map([["t1", { start: MONDAY, end: MONDAY + DAY }]]),
      assignmentsByTask: new Map([["t1", [{ resourceId: "zed", units: 1 }]]]),
    };
    const index = createWarningIndex(fakeDeps(view), fakeStateStore(snapshot));
    expect(index.overResourceNamesFor("t1")).toEqual([]);
    expect(index.isWarned("t1")).toBe(false);
  });
});
