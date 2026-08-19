import { afterEach, describe, expect, it } from "vitest";
import { boot, flatTasks, treeTasks } from "./_boot";
import type { Booted } from "./_boot";

let b: Booted | undefined;
afterEach(() => {
  b?.gantt.dispose();
  b?.dom.restore();
  b = undefined;
});

describe("the boot harness", () => {
  it("mounts the grid pane, header and body", () => {
    b = boot();
    b.data.load(flatTasks(3));
    b.dom.flushFrames();
    expect(b.header.findAll("sg-grid-cell sg-grid-header-cell").map((c) => c.textContent)).toEqual([
      "Name",
      "Start",
      "End",
      "Progress",
    ]);
    expect(b.visibleRows()).toHaveLength(3);
    expect(b.rows.rowCount()).toBe(3);
    expect(b.contentHeight()).toBe(3 * 28);
    expect(b.rowGeometry()?.rowCount()).toBe(3);
  });

  it("follows the shared viewport and requests scrolls through it", () => {
    b = boot();
    b.data.load(treeTasks(20, 0));
    b.dom.flushFrames();
    b.viewport.set({ ...b.viewport.get(), scrollTop: 56 });
    b.dom.flushFrames();
    expect(b.body.findAll("sg-grid-row").length).toBeGreaterThan(0);
  });
});
