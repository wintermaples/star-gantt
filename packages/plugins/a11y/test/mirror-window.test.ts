// @vitest-environment happy-dom
// docs/specs/plugins/a11y.md § Mirror generation rules — the mirror is "virtualized identically to
// the canvas": every row the viewport covers must exist in the ARIA DOM, and the window's anchor is
// the viewport, not the focus.
import { afterEach, describe, expect, it } from "vitest";
import type { TaskId } from "@stargantt/plugin-data-store";
import { boot, flatTasks } from "./_boot";
import type { Booted } from "./_boot";

let booted: Booted | undefined;

afterEach(() => {
  booted?.dispose();
  booted = undefined;
});

const ROOT_HEIGHT = 600;
const ROW_HEIGHT = 28;
/** The first row is made this tall, which is what a single-sample window size mispredicts. */
const TALL_ROW_HEIGHT = 200;

/** The task names the mirror currently exposes, in DOM order. */
function mirrored(b: Booted): (string | undefined)[] {
  return b.rows().map((row) => row.textContent?.split(",")[0]);
}

function bootTall(): Booted {
  const b = boot({ tasks: flatTasks(60), rootHeight: ROOT_HEIGHT, rowHeight: ROW_HEIGHT });
  booted = b;
  b.grid.setRowHeight("t0", TALL_ROW_HEIGHT);
  b.view.setViewport({ height: ROOT_HEIGHT });
  b.flushFrames();
  return b;
}

describe("the materialized window with variable row heights", () => {
  it("materializes every row the viewport covers", () => {
    const b = bootTall();
    const rows = b.grid.service;
    expect(rows.rowHeight(0)).toBe(TALL_ROW_HEIGHT);
    expect(rows.rowHeight(1)).toBe(ROW_HEIGHT);

    // Every row whose band starts above the viewport's bottom edge is on screen, so every one of
    // them must be in the ARIA DOM — more rows than a window sized from the first row's height
    // alone would have produced.
    const visible: TaskId[] = [];
    for (let row = 0; row < rows.rowCount(); row += 1) {
      if (rows.yOf(row) >= ROOT_HEIGHT) break;
      const id = rows.taskIdAt(row);
      if (id !== undefined) visible.push(id);
    }
    expect(visible.length).toBeGreaterThan(Math.ceil(ROOT_HEIGHT / TALL_ROW_HEIGHT));

    const names = mirrored(b);
    for (const id of visible) expect(names).toContain(id);
  });

  it("still materializes the visible rows after scrolling into the uniform region", () => {
    const b = bootTall();
    const rows = b.grid.service;
    const scrollTop = 800;
    b.view.setViewport({ height: ROOT_HEIGHT });
    b.view.scroll(scrollTop);
    b.flushFrames();

    const names = mirrored(b);
    const first = rows.rowAtY(scrollTop);
    const last = rows.rowAtY(scrollTop + ROOT_HEIGHT - 1);
    expect(last).toBeGreaterThan(first);
    for (let row = first; row <= last; row += 1) {
      expect(names).toContain(rows.taskIdAt(row));
    }
  });

  // `references/performance-ux.md` — the mirror's cost per rebuild must follow the viewport, not
  // the row count: a 10k-row chart materializes the same handful of rows a 50-row one does.
  it("keeps the materialized window bounded at 10k rows, and a focus move O(window)", () => {
    const b = boot({ tasks: flatTasks(10_000) });
    booted = b;
    b.flushFrames();
    const window = b.rows().length;
    expect(b.mirror.getAttribute("aria-rowcount")).toBe("10000");
    // 300px of viewport at 24px per row is 13 rows, plus a five-row buffer at each end.
    expect(window).toBeLessThanOrEqual(30);

    b.focus.focus("t9000");
    b.flushFrames();
    // The window is still the same size after jumping 9000 rows: nothing scales with the list.
    expect(b.rows().length).toBeLessThanOrEqual(window + 1);
    expect(b.rows().some((r) => r.getAttribute("aria-rowindex") === "9001")).toBe(true);
  });

  it("follows the viewport while the focus stays put, keeping the focused row reachable", () => {
    const b = boot({ tasks: flatTasks(500) });
    booted = b;
    b.flushFrames();
    b.focus.focus("t1"); // an effective placement inside the initial window
    b.view.scroll(300 * 24);
    b.flushFrames();

    // The window moved to the scrolled range…
    const indexes = b.rows().map((r) => Number(r.getAttribute("aria-rowindex")));
    expect(Math.max(...indexes)).toBeGreaterThan(290);
    // …the focus did not…
    expect(b.focus.state.get().focused).toBe("t1");
    // …and the focused row keeps its own slot so the roving tabindex never leaves the DOM.
    const focusedRow = b.rows().find((r) => r.getAttribute("tabindex") === "0");
    expect(focusedRow?.getAttribute("aria-rowindex")).toBe("2");
  });
});
