// @vitest-environment happy-dom
// Covers the "trend polyline" behavior plus panel structure coverage of this area's `trend-panel.ts`.
import { describe, expect, it } from "vitest";
import type { ProgressSnapshot } from "../src/types";
import { resolveMessages } from "../src/internal/messages";
import { createTrendPanel, trendPolyline } from "../src/internal/progress/trend-panel";

const MS_DAY = 86_400_000;
const DEFAULT_MESSAGES = resolveMessages(undefined, () => undefined);

function snap(date: number, pct: number, over: Partial<ProgressSnapshot> = {}): ProgressSnapshot {
  return { date, percentComplete: pct, completedCount: 0, lateCount: 0, taskCount: 0, ...over };
}

describe("trendPolyline", () => {
  it("spreads dates across the width and maps percent to y (top = 100)", () => {
    const points = trendPolyline([snap(0, 0), snap(MS_DAY, 100)], 100, 50);
    expect(points).toEqual([
      { x: 4, y: 46 },
      { x: 96, y: 4 },
    ]);
    expect(trendPolyline([], 100, 50)).toEqual([]);
  });

  it("a single snapshot sits at the left edge", () => {
    expect(trendPolyline([snap(0, 50)], 100, 50)).toEqual([{ x: 4, y: 25 }]);
  });
});

describe("trend panel (hostless)", () => {
  it("shows the empty message with no snapshots", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    let closed = 0;
    const panel = createTrendPanel(host, [], DEFAULT_MESSAGES, { close: () => void (closed += 1) });
    expect(panel.root.getAttribute("aria-label")).toBe("Progress trend");
    expect(panel.root.textContent).toContain("No snapshots recorded");
    panel.dispose();
    expect(closed).toBe(0);
  });

  it("renders a canvas with an accessible aria-label and a per-snapshot text list", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const snapshots = [snap(0, 42), snap(MS_DAY, 80, { completedCount: 1, lateCount: 2 })];
    const panel = createTrendPanel(host, snapshots, DEFAULT_MESSAGES, { close: () => undefined });
    const body = panel.root.children[1] as HTMLElement;
    const canvas = body.querySelector("canvas");
    expect(canvas).not.toBeNull();
    expect(canvas?.getAttribute("role")).toBe("img");
    expect(canvas?.getAttribute("aria-label")).toContain("42% complete");
    const items = body.querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toBe(DEFAULT_MESSAGES.trendLine(snapshots[0] as ProgressSnapshot));
    expect(items[1]?.textContent).toContain("1 done");
  });

  it("Close calls back and the button lives inside the dialog's own subtree", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    let closed = 0;
    const panel = createTrendPanel(host, [snap(0, 10)], DEFAULT_MESSAGES, { close: () => void (closed += 1) });
    const footer = panel.root.children[3] as HTMLElement; // header, body, grip, footer
    const closeButton = footer.children[0] as HTMLButtonElement;
    expect(closeButton.textContent).toBe("Close");
    closeButton.click();
    expect(closed).toBe(1);
  });
});
