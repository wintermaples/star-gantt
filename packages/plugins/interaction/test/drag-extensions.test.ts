/**
 * The opt-in drag-edit extensions (docs/specs/plugins/interaction.md §6.2): minimum duration, the
 * drag tooltip, summary/milestone handling, click-move, multi-task drag, row drag (from a bar and
 * from the grid pane), dependency preview, frame throttling and auto-scroll — each default-off, each
 * exercised through `createDragController` with the hostless doubles in `./_drag-fakes.ts`.
 *
 * There is no host here: the gesture arbiter (covered on its own by `arbiter.test.ts`) is what
 * decides *when* a press, a move or a Escape reaches this controller in production; every test
 * below drives the controller's own methods directly, exactly as the arbiter would call them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MS_DAY } from "@stargantt/sdk";
import type { Task, TaskId } from "@stargantt/plugin-data-store";
import { createDragController } from "../src/internal/drag/index";
import type { DragController } from "../src/internal/drag/index";
import { DRAG_TOOLTIP_CLASS } from "../src/internal/drag/drag-tooltip";
import { edgeVelocity, AUTO_SCROLL_MAX_PX, AUTO_SCROLL_ZONE_PX } from "../src/internal/gesture/auto-scroll";
import { dragHarness, recordingContext } from "./_drag-fakes";
import type { RecordingContext } from "./_drag-fakes";
import { background, barDown, barMove, barUp, gridDown, gridMove, gridUp } from "./_fakes";
import type { FakePointer } from "./_fakes";

const DAY = MS_DAY;
const BAR_TOP_OFFSET = 4;
const BAR_HEIGHT = 20;
const ROW_HEIGHT = 28;
const BAR_Y = 14;
const VP = { scrollLeft: 0, scrollTop: 0, width: 10 * DAY };

function press(
  controller: DragController,
  id: TaskId,
  x: number,
  y: number,
  overrides: FakePointer & { kind?: string } = {},
): void {
  controller.press(barDown(id, { x, y, clientX: x, clientY: y, ...overrides }));
}
function firstMove(controller: DragController, x: number, y: number, overrides: FakePointer = {}) {
  return controller.pressMove(barMove({ x, y, clientX: x, clientY: y, ...overrides }));
}
function move(controller: DragController, x: number, y: number, overrides: FakePointer = {}): void {
  controller.dragMove(barMove({ x, y, clientX: x, clientY: y, ...overrides }));
}
function release(controller: DragController, x: number, y: number, overrides: FakePointer = {}): void {
  controller.up(barUp({ x, y, clientX: x, clientY: y, ...overrides }));
}
/** A press-and-release with no intervening move — a click, not a drag. */
function click(
  controller: DragController,
  id: TaskId,
  x: number,
  y: number,
  overrides: FakePointer & { kind?: string } = {},
): void {
  press(controller, id, x, y, overrides);
  release(controller, x, y, overrides);
}
function paint(rc: RecordingContext, controller: DragController): void {
  rc.reset();
  controller.draw(rc.ctx, VP);
}

describe("minimum duration (minDuration)", () => {
  it("stops a pointer resize at the floor", () => {
    const h = dragHarness({ config: { minDuration: DAY / 2 } });
    const controller = createDragController(h.deps);
    press(controller, "t0", DAY - 1, BAR_Y, { kind: "handle" });
    firstMove(controller, -1_000, BAR_Y);
    release(controller, -1_000, BAR_Y);
    expect(h.moves).toEqual([{ id: "t0", start: 0, end: DAY / 2, coalesceKey: expect.any(String) }]);
  });

  it("ignores an unusable value, keeping the old clamp at zero duration", () => {
    const h = dragHarness({ config: { minDuration: -5 } });
    const controller = createDragController(h.deps);
    press(controller, "t0", DAY - 1, BAR_Y, { kind: "handle" });
    firstMove(controller, -1_000, BAR_Y);
    release(controller, -1_000, BAR_Y);
    expect(h.moves).toEqual([{ id: "t0", start: 0, end: 0, coalesceKey: expect.any(String) }]);
  });
});

describe("drag tooltip (dragTooltip)", () => {
  it("creates no tooltip by default", () => {
    const h = dragHarness();
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, DAY, BAR_Y);
    expect(h.mount.nodes).toHaveLength(0);
    release(controller, DAY, BAR_Y);
  });

  it("shows the commit dates while dragging and hides on release", () => {
    const h = dragHarness({ config: { dragTooltip: true } });
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, DAY, BAR_Y);
    const el = h.mount.nodes[0];
    expect(el).toBeDefined();
    expect(el?.style["display"]).toBe("block");
    expect(el?.textContent).toBe("1970-01-02 – 1970-01-03");
    release(controller, DAY, BAR_Y);
    expect(el?.style["display"]).toBe("none");
  });

  it("flips below the bar on row 0, where there is no room above", () => {
    // t0's box top is 4px, and the fake tooltip node's `offsetHeight` is 20 — nowhere near enough
    // room above for a readout GAP-8 clear of the pane's top.
    const h = dragHarness({ config: { dragTooltip: true } });
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, DAY, BAR_Y);
    const el = h.mount.nodes[0];
    expect(el?.style["top"]).toBe(`${BAR_TOP_OFFSET + BAR_HEIGHT + 8}px`);
  });

  it("sits its measured height above the bar when there is room", () => {
    const h = dragHarness({ config: { dragTooltip: true } });
    const controller = createDragController(h.deps);
    press(controller, "t2", 0, 2 * ROW_HEIGHT + BAR_Y);
    firstMove(controller, 10, 2 * ROW_HEIGHT + BAR_Y);
    const el = h.mount.nodes[0];
    expect(el).toBeDefined();
    // t2's box top is 2*28 + 4 = 60px; the tooltip's fixed 20px height leaves room above.
    expect(el?.style["top"]).toBe(`${2 * ROW_HEIGHT + BAR_TOP_OFFSET - 8 - 20}px`);
  });

  it("clamps the readout inside the pane's right and left edges", () => {
    const h = dragHarness({ config: { dragTooltip: true } });
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, DAY, BAR_Y);
    const el = h.mount.nodes[0];
    if (el === undefined) throw new Error("no tooltip");
    el.offsetWidth = 100;
    // The tooltip's anchor.x is the pointer's viewport-local `x`, independent of the client-space
    // delta that drives the date math — so `x` is set to a small, edge-relative number here while
    // `clientX` crosses a day boundary, so the readout (and so the cached width) actually refreshes;
    // the measurement cache (already covered by `drag-tooltip.test.ts`) only re-reads on a text
    // change, not on every move.
    controller.dragMove(barMove({ x: 790, y: BAR_Y, clientX: 3 * DAY, clientY: BAR_Y }));
    expect(el.style["left"]).toBe("700px"); // paneWidth(800) − width(100)
    controller.dragMove(barMove({ x: -50, y: BAR_Y, clientX: 3 * DAY, clientY: BAR_Y }));
    expect(el.style["left"]).toBe("0px");
  });

  it("hides on cancel() and speaks through a replaced dragTooltip message", () => {
    const h = dragHarness({
      config: { dragTooltip: true },
      messages: { dragTooltip: (p) => `from ${p.start} to ${p.end}` },
    });
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, DAY, BAR_Y);
    expect(h.mount.nodes[0]?.textContent).toBe(`from ${DAY} to ${2 * DAY}`);
    controller.cancel();
    expect(h.mount.nodes[0]?.style["display"]).toBe("none");
    release(controller, DAY, BAR_Y);
    expect(h.moves).toHaveLength(0);
  });
});

describe("summary bars", () => {
  it("starts no gesture on a summary bar", () => {
    const tasks: Task[] = [
      { id: "t0", parentId: null, name: "t0", start: 0, end: DAY, type: "summary" },
      { id: "t1", parentId: null, name: "t1", start: 0, end: DAY },
    ];
    const h = dragHarness({ tasks });
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    expect(firstMove(controller, 2 * DAY, BAR_Y)).toBe("none");
    release(controller, 2 * DAY, BAR_Y);
    expect(h.moves).toHaveLength(0);
  });
});

describe("click-move (clickMove)", () => {
  it("does nothing by default", () => {
    const h = dragHarness();
    const controller = createDragController(h.deps);
    click(controller, "t0", 0, BAR_Y);
    controller.background(background({ x: 5 * DAY, y: 200 }));
    expect(h.moves).toHaveLength(0);
  });

  it("moves the clicked task's start to the next background click, keeping its duration", () => {
    const h = dragHarness({ config: { clickMove: true } });
    const controller = createDragController(h.deps);
    click(controller, "t0", 0, BAR_Y); // picks t0 up
    controller.background(background({ x: 3 * DAY, y: 200 }));
    expect(h.moves).toEqual([{ id: "t0", start: 3 * DAY, end: 4 * DAY }]);
    // The pick-up is spent: another background click moves nothing further.
    controller.background(background({ x: 5 * DAY, y: 200 }));
    expect(h.moves).toHaveLength(1);
  });

  it("forgets the pick-up on clearPress() (the arbiter's idle-state Escape)", () => {
    const h = dragHarness({ config: { clickMove: true } });
    const controller = createDragController(h.deps);
    click(controller, "t0", 0, BAR_Y);
    controller.clearPress();
    controller.background(background({ x: 3 * DAY, y: 200 }));
    expect(h.moves).toHaveLength(0);
  });

  it("rounds the placed start when a rounding rule is composed", () => {
    const toDay = (t: number): number => {
      const low = Math.floor(t / DAY) * DAY;
      return t - low < low + DAY - t ? low : low + DAY;
    };
    const h = dragHarness({ config: { clickMove: true }, snap: { snap: toDay, step: (t, d) => d * DAY } });
    const controller = createDragController(h.deps);
    click(controller, "t0", 0, BAR_Y);
    controller.background(background({ x: 3 * DAY + 12, y: 200 })); // rounds back to day 3
    expect(h.moves).toEqual([{ id: "t0", start: 3 * DAY, end: 4 * DAY }]);
  });

  it("disarms the pick-up when a different task's handle is clicked without a drag", () => {
    const h = dragHarness({ config: { clickMove: true } });
    const controller = createDragController(h.deps);
    click(controller, "t0", 0, BAR_Y); // picks t0 up
    // t1's handle, clicked without a drag: a handle press's mode is a resize, not "move", so this
    // disarms t0's pick-up without re-arming for t1 (that only happens for a body click — see below).
    click(controller, "t1", 2, ROW_HEIGHT + BAR_Y, { kind: "handle" });
    controller.background(background({ x: 3 * DAY, y: 200 }));
    expect(h.moves).toHaveLength(0);
  });

  it("re-arms for the other task when its body is clicked", () => {
    const h = dragHarness({ config: { clickMove: true } });
    const controller = createDragController(h.deps);
    click(controller, "t0", 0, BAR_Y);
    click(controller, "t1", 0, ROW_HEIGHT + BAR_Y); // t1's body: replaces t0 as the pick-up
    controller.background(background({ x: 3 * DAY, y: 200 }));
    expect(h.moves).toEqual([{ id: "t1", start: 3 * DAY, end: 4 * DAY }]);
  });

  it("a same-task handle click leaves the pick-up armed", () => {
    const h = dragHarness({ config: { clickMove: true } });
    const controller = createDragController(h.deps);
    click(controller, "t0", 0, BAR_Y);
    click(controller, "t0", 2, BAR_Y); // t0's own start handle, no drag
    controller.background(background({ x: 3 * DAY, y: 200 }));
    expect(h.moves).toEqual([{ id: "t0", start: 3 * DAY, end: 4 * DAY }]);
  });

  it("forgets the pick-up on a cancelled capture", () => {
    const h = dragHarness({ config: { clickMove: true } });
    const controller = createDragController(h.deps);
    click(controller, "t0", 0, BAR_Y);
    press(controller, "t1", 0, ROW_HEIGHT + BAR_Y);
    release(controller, 0, ROW_HEIGHT + BAR_Y, { type: "pointercancel" });
    controller.background(background({ x: 3 * DAY, y: 200 }));
    expect(h.moves).toHaveLength(0);
  });

  it("forgets the pick-up when a real drag completes", () => {
    const h = dragHarness({ config: { clickMove: true } });
    const controller = createDragController(h.deps);
    click(controller, "t0", 0, BAR_Y);
    press(controller, "t1", 0, ROW_HEIGHT + BAR_Y);
    firstMove(controller, DAY, ROW_HEIGHT + BAR_Y);
    release(controller, DAY, ROW_HEIGHT + BAR_Y);
    expect(h.moves).toHaveLength(1);
    controller.background(background({ x: 3 * DAY, y: 200 }));
    expect(h.moves).toHaveLength(1);
  });
});

describe("multi-task drag (multiDrag)", () => {
  it("carries the other selected tasks along by the same displacement, one undo entry", () => {
    const h = dragHarness({ config: { multiDrag: true }, selected: ["t0", "t1"] });
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, DAY, BAR_Y);
    release(controller, DAY, BAR_Y);
    expect(h.moves).toEqual([
      { id: "t0", start: DAY, end: 2 * DAY, coalesceKey: expect.any(String) },
      { id: "t1", start: DAY, end: 2 * DAY, coalesceKey: expect.any(String) },
    ]);
    expect(new Set(h.moves.map((m) => m.coalesceKey)).size).toBe(1);
  });

  it("moves only the dragged task without the flag, selection or not", () => {
    const h = dragHarness({ selected: ["t0", "t1"] });
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, DAY, BAR_Y);
    release(controller, DAY, BAR_Y);
    expect(h.moves.map((m) => m.id)).toEqual(["t0"]);
  });

  it("moves only the dragged task when it is outside the selection", () => {
    const h = dragHarness({ config: { multiDrag: true }, selected: ["t1", "t2"] });
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y); // t0 is not selected
    firstMove(controller, DAY, BAR_Y);
    release(controller, DAY, BAR_Y);
    expect(h.moves.map((m) => m.id)).toEqual(["t0"]);
  });
});

describe("row drag from a bar press (rowDrag)", () => {
  function keyedTasks(): Task[] {
    return [
      { id: "t0", parentId: null, name: "t0", start: 0, end: DAY, orderKey: "1" },
      { id: "t1", parentId: null, name: "t1", start: 0, end: DAY, orderKey: "2" },
      { id: "t2", parentId: null, name: "t2", start: 0, end: DAY, orderKey: "3" },
    ];
  }

  it("stays a date drag without the flag, even for a vertical pull", () => {
    const h = dragHarness({ tasks: keyedTasks() });
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, 1, BAR_Y + 2 * ROW_HEIGHT);
    release(controller, 1, BAR_Y + 2 * ROW_HEIGHT);
    expect(h.updates).toHaveLength(0);
  });

  it("re-keys the task between the rows the release names, as one task/update", () => {
    const h = dragHarness({ tasks: keyedTasks(), config: { rowDrag: true } });
    const controller = createDragController(h.deps);
    const rc = recordingContext();
    press(controller, "t0", 0, BAR_Y);
    // Straight down, into the gap between t1 (row 1) and t2 (row 2): y in [42, 70).
    firstMove(controller, 0, 50);
    paint(rc, controller);
    expect(rc.calls("stroke").length).toBeGreaterThan(0); // the insertion line was drawn
    release(controller, 0, 50);
    expect(h.moves).toHaveLength(0);
    expect(h.updates).toHaveLength(1);
    const update = h.updates[0];
    expect(update?.id).toBe("t0");
    expect(update?.parentId).toBeNull();
    expect(update!.orderKey > "2" && update!.orderKey < "3").toBe(true);
  });

  it("abandons on cancel() with nothing dispatched", () => {
    const h = dragHarness({ tasks: keyedTasks(), config: { rowDrag: true } });
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, 0, BAR_Y + 2 * ROW_HEIGHT);
    controller.cancel();
    release(controller, 0, BAR_Y + 2 * ROW_HEIGHT);
    expect(h.updates).toHaveLength(0);
    expect(h.moves).toHaveLength(0);
  });

  it("commits nothing when dropped back on its own place", () => {
    const h = dragHarness({ tasks: keyedTasks(), config: { rowDrag: true } });
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, 0, BAR_Y + ROW_HEIGHT);
    move(controller, 0, BAR_Y);
    release(controller, 0, BAR_Y);
    expect(h.updates).toHaveLength(0);
  });

  // docs/specs/plugins/interaction.md §1.3 — a `collapsedSummary: "split"` parent paints
  // its children inside its own row: `p` owns row 0 and paints `c1` there, `d` owns row 1.
  describe("split rows", () => {
    function splitTasks(): Task[] {
      return [
        { id: "p", parentId: null, name: "p", start: 0, end: DAY, type: "summary", orderKey: "1" },
        { id: "c1", parentId: "p", name: "c1", start: 0, end: DAY, orderKey: "1" },
        { id: "d", parentId: null, name: "d", start: 0, end: DAY, orderKey: "2" },
      ];
    }
    const boxes = [
      { id: "c1", x: 0, y: 4, width: DAY, height: 20 },
      { id: "d", x: 0, y: 32, width: DAY, height: 20 },
    ];
    function split(): ReturnType<typeof dragHarness> {
      return dragHarness({
        tasks: splitTasks(),
        boxes,
        rowOrder: ["p", "d"], // c1 has no row of its own
        config: { rowDrag: true },
      });
    }

    it("never starts a row drag from an in-row child — it has no row of its own", () => {
      const h = split();
      const controller = createDragController(h.deps);
      press(controller, "c1", 0, BAR_Y);
      firstMove(controller, 0, BAR_Y + 2 * ROW_HEIGHT);
      release(controller, 0, BAR_Y + 2 * ROW_HEIGHT);
      expect(h.updates).toHaveLength(0);
      expect(h.tasks.find((t) => t.id === "c1")?.parentId).toBe("p");
    });

    it("keeps editing the in-row child's dates horizontally", () => {
      const h = split();
      const controller = createDragController(h.deps);
      press(controller, "c1", 0, BAR_Y);
      firstMove(controller, DAY, BAR_Y);
      release(controller, DAY, BAR_Y);
      expect(h.moves).toEqual([{ id: "c1", start: DAY, end: 2 * DAY, coalesceKey: expect.any(String) }]);
    });

    it("treats the split row as one drop target, exactly as a normal row would", () => {
      const h = split();
      const controller = createDragController(h.deps);
      press(controller, "d", 0, ROW_HEIGHT + BAR_Y);
      firstMove(controller, 0, 3); // up into the top half of the split row
      release(controller, 0, 3);
      expect(h.updates).toHaveLength(1);
      expect(h.updates[0]?.id).toBe("d");
      expect(h.updates[0]?.parentId).toBeNull();
      expect(h.updates[0]!.orderKey < "1").toBe(true);
    });
  });
});

describe("row drag from the grid pane", () => {
  function keyedTasks(): Task[] {
    return [
      { id: "t0", parentId: null, name: "t0", start: 0, end: DAY, orderKey: "1" },
      { id: "t1", parentId: null, name: "t1", start: 0, end: DAY, orderKey: "2" },
      { id: "t2", parentId: null, name: "t2", start: 0, end: DAY, orderKey: "3" },
    ];
  }
  function nestedTasks(): Task[] {
    return [
      { id: "p", parentId: null, name: "p", start: 0, end: DAY, orderKey: "1" },
      { id: "c", parentId: "p", name: "c", start: 0, end: DAY, orderKey: "1" },
      { id: "r", parentId: null, name: "r", start: 0, end: DAY, orderKey: "2" },
    ];
  }

  it("commits a re-key from a press that started on a grid row, not a bar", () => {
    const h = dragHarness({ tasks: keyedTasks(), config: { rowDrag: true } });
    const controller = createDragController(h.deps);
    controller.gridPress(gridDown("t0", { row: 0, y: BAR_Y, clientX: 40, clientY: BAR_Y }));
    const axis = controller.gridPressMove(
      gridMove({ y: 2 * ROW_HEIGHT - 10, clientX: 40, clientY: 2 * ROW_HEIGHT - 10 }),
    );
    expect(axis).toBe("row");
    controller.gridUp(gridUp({ y: 2 * ROW_HEIGHT - 10, clientX: 40, clientY: 2 * ROW_HEIGHT - 10 }));
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]?.id).toBe("t0");
    expect(h.updates[0]!.orderKey > "2" && h.updates[0]!.orderKey < "3").toBe(true);
    // The gap was marked in the grid pane while the drag ran, and cleared when it ended.
    expect(h.indicators.length).toBeGreaterThan(1);
    expect(h.indicators.at(-1)).toBeNull();
  });

  it("commits nothing for a press that never passes the threshold", () => {
    const h = dragHarness({ tasks: keyedTasks(), config: { rowDrag: true } });
    const controller = createDragController(h.deps);
    controller.gridPress(gridDown("t0", { row: 0, y: BAR_Y, clientX: 40, clientY: BAR_Y }));
    const axis = controller.gridPressMove(gridMove({ y: BAR_Y + 1, clientX: 41, clientY: BAR_Y + 1 }));
    expect(axis).toBe("none");
    controller.gridUp(gridUp({ y: BAR_Y + 1, clientX: 41, clientY: BAR_Y + 1 }));
    expect(h.updates).toHaveLength(0);
  });

  it("abandons a cancelled capture with nothing dispatched", () => {
    const h = dragHarness({ tasks: keyedTasks(), config: { rowDrag: true } });
    const controller = createDragController(h.deps);
    controller.gridPress(gridDown("t0", { row: 0, y: BAR_Y, clientX: 40, clientY: BAR_Y }));
    controller.gridPressMove(gridMove({ y: 2 * ROW_HEIGHT - 10, clientX: 40, clientY: 2 * ROW_HEIGHT - 10 }));
    controller.gridUp(gridUp({ y: 2 * ROW_HEIGHT - 10, clientX: 40, clientY: 2 * ROW_HEIGHT - 10, cancelled: true }));
    expect(h.updates).toHaveLength(0);
  });

  it("ignores the whole seam without the flag", () => {
    const h = dragHarness({ tasks: keyedTasks() });
    const controller = createDragController(h.deps);
    controller.gridPress(gridDown("t0", { row: 0, y: BAR_Y, clientX: 40, clientY: BAR_Y }));
    const axis = controller.gridPressMove(
      gridMove({ y: 2 * ROW_HEIGHT - 10, clientX: 40, clientY: 2 * ROW_HEIGHT - 10 }),
    );
    expect(axis).toBe("none");
    controller.gridUp(gridUp({ y: 2 * ROW_HEIGHT - 10, clientX: 40, clientY: 2 * ROW_HEIGHT - 10 }));
    expect(h.updates).toHaveLength(0);
    expect(h.indicators).toHaveLength(0);
  });

  // The bug this guards against — a task filed one level in could not be filed back out,
  // because every gap resolved to the parent of the row below it.
  it("lifts a nested task back to the root when the pointer travels left", () => {
    const h = dragHarness({ tasks: nestedTasks(), config: { rowDrag: true } });
    const controller = createDragController(h.deps);
    // Drag c (row 1, depth 1) down past r — the last gap of the chart — and 16px left.
    controller.gridPress(gridDown("c", { row: 1, y: ROW_HEIGHT + BAR_Y, clientX: 60, clientY: ROW_HEIGHT + BAR_Y }));
    controller.gridPressMove(gridMove({ y: 3 * ROW_HEIGHT, clientX: 60 - 16, clientY: 3 * ROW_HEIGHT }));
    controller.gridUp(gridUp({ y: 3 * ROW_HEIGHT, clientX: 60 - 16, clientY: 3 * ROW_HEIGHT }));
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]?.id).toBe("c");
    expect(h.updates[0]?.parentId).toBeNull();
  });

  it("keeps the dragged task's own depth, filing it under the row above the gap", () => {
    const h = dragHarness({ tasks: nestedTasks(), config: { rowDrag: true } });
    const controller = createDragController(h.deps);
    controller.gridPress(gridDown("c", { row: 1, y: ROW_HEIGHT + BAR_Y, clientX: 60, clientY: ROW_HEIGHT + BAR_Y }));
    controller.gridPressMove(gridMove({ y: 3 * ROW_HEIGHT, clientX: 60, clientY: 3 * ROW_HEIGHT }));
    controller.gridUp(gridUp({ y: 3 * ROW_HEIGHT, clientX: 60, clientY: 3 * ROW_HEIGHT }));
    // No sideways travel keeps depth 1, and at the last gap the row above is the root r — so c
    // stays one level deep, now as r's child rather than p's.
    expect(h.updates[0]?.parentId).toBe("r");
  });
});

describe("dependency preview (dependencyPreview)", () => {
  const link = { sourceId: "t0", targetId: "t1" };

  it("outlines each direct successor displaced by the drag's delta", () => {
    const h = dragHarness({ links: [link], config: { dependencyPreview: true } });
    const controller = createDragController(h.deps);
    const rc = recordingContext();
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, DAY, BAR_Y);
    paint(rc, controller);
    const dashed = rc.calls("strokeRect").filter((o) => o.dash.length > 0);
    expect(dashed.some((o) => o.args[0] === DAY)).toBe(true);
    release(controller, DAY, BAR_Y);
  });

  it("draws no successor outline without the flag", () => {
    const h = dragHarness({ links: [link] });
    const controller = createDragController(h.deps);
    const rc = recordingContext();
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, DAY, BAR_Y);
    paint(rc, controller);
    expect(rc.calls("strokeRect").filter((o) => o.dash.length > 0)).toHaveLength(0);
    release(controller, DAY, BAR_Y);
  });
});

describe("auto-scroll arithmetic (autoScroll)", () => {
  it("is zero outside the edge zones and ramps toward the edges", () => {
    expect(edgeVelocity(200, 400)).toBe(0);
    expect(edgeVelocity(0, 400)).toBeLessThan(0);
    expect(edgeVelocity(400, 400)).toBeGreaterThan(0);
    expect(Math.abs(edgeVelocity(16, 400))).toBeLessThan(Math.abs(edgeVelocity(0, 400)));
    expect(edgeVelocity(0, 40)).toBe(0); // a degenerate pane never scrolls
    expect(edgeVelocity(0, 400)).toBe(-AUTO_SCROLL_MAX_PX);
    expect(edgeVelocity(AUTO_SCROLL_ZONE_PX, 400)).toBe(0);
  });
});

describe("frame-driven behaviour (frameSync, autoScroll)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("frame throttling (frameSync)", () => {
    it("collapses moves of one running-drag frame to the latest, committing the same result", () => {
      // The axis-deciding first move (`pressMove`) is always synchronous — the arbiter needs the
      // decision in the same turn as the threshold-crossing event — so with `liveUpdate` on it
      // dispatches immediately; only the SUBSEQUENT `dragMove` calls are frame-batched.
      const h = dragHarness({ config: { frameSync: true, liveUpdate: true } });
      const controller = createDragController(h.deps);
      press(controller, "t0", 0, BAR_Y);
      firstMove(controller, 10, BAR_Y);
      expect(h.moves).toHaveLength(1); // the synchronous first dispatch
      move(controller, 10, BAR_Y); // both queued for the same frame
      move(controller, DAY, BAR_Y);
      expect(h.moves).toHaveLength(1); // still nothing new: the frame has not run yet
      vi.advanceTimersByTime(16);
      expect(h.moves).toHaveLength(2);
      expect(h.moves[1]).toMatchObject({ id: "t0", start: DAY, end: 2 * DAY, coalesceKey: expect.any(String) });
      release(controller, DAY, BAR_Y);
      expect(h.moves).toHaveLength(2); // the release matches what is already dispatched
    });

    it("commits the release position even when the last move never got its frame", () => {
      const h = dragHarness({ config: { frameSync: true } });
      const controller = createDragController(h.deps);
      press(controller, "t0", 0, BAR_Y);
      firstMove(controller, DAY, BAR_Y); // establishes the drag past the threshold
      move(controller, 2 * DAY, BAR_Y); // queued, and the frame never runs
      release(controller, 2 * DAY, BAR_Y);
      expect(h.moves).toEqual([{ id: "t0", start: 2 * DAY, end: 3 * DAY, coalesceKey: expect.any(String) }]);
    });
  });

  describe("auto-scroll integration", () => {
    it("scrolls the view and extends the origin while the pointer sits in the left edge zone", () => {
      const tasks: Task[] = [{ id: "t0", parentId: null, name: "t0", start: 10 * DAY, end: 11 * DAY }];
      const h = dragHarness({ tasks, config: { autoScroll: true } });
      const controller = createDragController(h.deps);
      // Grab the start handle and park the pointer at the pane's very left edge.
      press(controller, "t0", 10 * DAY + 3, BAR_Y, { kind: "handle" });
      firstMove(controller, 10 * DAY + 3 - 8, BAR_Y);
      move(controller, 0, BAR_Y); // x = 0: deep in the left edge zone
      const before = h.viewport.scrollLeft;
      vi.advanceTimersByTime(16 * 5);
      expect(h.viewport.scrollLeft).toBeLessThan(before);
      expect(h.timeline.extensions.length).toBeGreaterThan(0);
      expect(h.timeline.extensions.at(-1)).toBeLessThan(10 * DAY);
    });

    it("stops the loop once scrollTo can no longer move the view (a wall)", () => {
      const h = dragHarness({
        config: { autoScroll: true },
        scrollClamp: (target) => Math.max(0, target), // never scrolls left of content x 0
      });
      const controller = createDragController(h.deps);
      press(controller, "t0", 0, BAR_Y, { kind: "handle" });
      firstMove(controller, -8, BAR_Y);
      move(controller, 0, BAR_Y); // the left edge, already at the wall
      const scrollCallsBefore = h.scrolls.length;
      vi.advanceTimersByTime(16 * 5);
      // The wall is reached on the very first step and the loop does not re-arm forever.
      expect(h.scrolls.length).toBeLessThanOrEqual(scrollCallsBefore + 1);
      expect(h.viewport.scrollLeft).toBe(0);
    });

    it("does not disturb an ordinary drag well inside the pane", () => {
      const h = dragHarness({ config: { autoScroll: true } });
      const controller = createDragController(h.deps);
      // The auto-scroll edge zone is read off the pointer's viewport-local `x` (compared against
      // `deps.viewport().width`, a few hundred px), which is a different scale from `clientX` (the
      // ms-as-px date delta) — so `x` is pinned at the pane's middle throughout while `clientX` still
      // carries the day-long displacement.
      press(controller, "t0", 400, BAR_Y, { clientX: 0 });
      firstMove(controller, 400, BAR_Y, { clientX: DAY }); // far from either edge zone
      vi.advanceTimersByTime(16 * 3);
      release(controller, 400, BAR_Y, { clientX: DAY });
      expect(h.moves).toEqual([{ id: "t0", start: DAY, end: 2 * DAY, coalesceKey: expect.any(String) }]);
      expect(h.scrolls).toHaveLength(0);
    });
  });

  describe("origin extension while dragging", () => {
    it("extends the axis without liveUpdate, and commits nothing until release", () => {
      const h = dragHarness();
      const controller = createDragController(h.deps);
      press(controller, "t0", 0, BAR_Y);
      firstMove(controller, -3 * DAY, BAR_Y);
      expect(h.timeline.extensions.at(-1)).toBe(-3 * DAY);
      expect(h.moves).toEqual([]);
    });

    it("extends by the leftmost member of a multi-drag, not by the grabbed one", () => {
      const tasks: Task[] = [
        { id: "t0", parentId: null, name: "t0", start: 5 * DAY, end: 6 * DAY },
        { id: "t1", parentId: null, name: "t1", start: 2 * DAY, end: 3 * DAY },
      ];
      const h = dragHarness({ tasks, config: { multiDrag: true }, selected: ["t0", "t1"] });
      const controller = createDragController(h.deps);
      const grabX = 5 * DAY + DAY / 2;
      press(controller, "t0", grabX, BAR_Y);
      firstMove(controller, grabX - 4 * DAY, BAR_Y);
      // t0 lands on day 1, t1 on day −2 (same displacement): the axis has to reach t1's.
      expect(h.timeline.extensions.at(-1)).toBe(-2 * DAY);
    });

    it("releases the hold when cancel() abandons the drag", () => {
      const h = dragHarness();
      const controller = createDragController(h.deps);
      press(controller, "t0", 0, BAR_Y);
      firstMove(controller, -3 * DAY, BAR_Y);
      expect(h.timeline.releases()).toBe(0);
      controller.cancel();
      expect(h.timeline.releases()).toBeGreaterThan(0);
    });

    it("holds the axis for the whole gesture and releases it on commit", () => {
      const h = dragHarness();
      const controller = createDragController(h.deps);
      press(controller, "t0", 0, BAR_Y);
      firstMove(controller, -3 * DAY, BAR_Y);
      expect(h.timeline.releases()).toBe(0);
      release(controller, -3 * DAY, BAR_Y);
      expect(h.timeline.releases()).toBe(1);
    });
  });

  describe("a committed date drag reveals its result", () => {
    const tenDaysIn = (): Task[] => [
      { id: "t0", parentId: null, name: "t0", start: 10 * DAY, end: 11 * DAY },
    ];

    it("scrolls left by the minimum amount when the commit lands behind the left edge", () => {
      const h = dragHarness({ tasks: tenDaysIn() });
      h.viewport.scrollLeft = 10 * DAY - 100;
      const controller = createDragController(h.deps);
      press(controller, "t0", 130, BAR_Y);
      firstMove(controller, 130 - 5 * DAY, BAR_Y);
      release(controller, 130 - 5 * DAY, BAR_Y);
      expect(h.moves).toEqual([{ id: "t0", start: 5 * DAY, end: 6 * DAY, coalesceKey: expect.any(String) }]);
      expect(h.viewport.scrollLeft).toBe(5 * DAY);
    });

    it("leaves the view alone when the commit is already visible", () => {
      const h = dragHarness({ tasks: tenDaysIn() });
      h.viewport.scrollLeft = 10 * DAY - 100;
      const before = h.viewport.scrollLeft;
      const controller = createDragController(h.deps);
      press(controller, "t0", 130, BAR_Y);
      firstMove(controller, 130 + DAY, BAR_Y);
      release(controller, 130 + DAY, BAR_Y);
      expect(h.moves).toEqual([{ id: "t0", start: 11 * DAY, end: 12 * DAY, coalesceKey: expect.any(String) }]);
      expect(h.viewport.scrollLeft).toBe(before);
    });

    it("leaves the view alone for an end resize, which never reaches earlier", () => {
      const h = dragHarness({ tasks: tenDaysIn() });
      h.viewport.scrollLeft = 10 * DAY + 20;
      const before = h.viewport.scrollLeft;
      const controller = createDragController(h.deps);
      const endHandleX = 11 * DAY - (10 * DAY + 20) - 3;
      press(controller, "t0", endHandleX, BAR_Y, { kind: "handle" });
      firstMove(controller, endHandleX + 4 * DAY, BAR_Y);
      release(controller, endHandleX + 4 * DAY, BAR_Y);
      expect(h.moves).toEqual([{ id: "t0", start: 10 * DAY, end: 15 * DAY, coalesceKey: expect.any(String) }]);
      expect(h.viewport.scrollLeft).toBe(before);
    });

    it("reveals nothing when the drag is abandoned", () => {
      const h = dragHarness({ tasks: tenDaysIn() });
      h.viewport.scrollLeft = 10 * DAY - 100;
      const before = h.viewport.scrollLeft;
      const controller = createDragController(h.deps);
      press(controller, "t0", 130, BAR_Y);
      firstMove(controller, 130 - 5 * DAY, BAR_Y);
      controller.cancel();
      release(controller, 130 - 5 * DAY, BAR_Y);
      expect(h.moves).toEqual([]);
      expect(h.viewport.scrollLeft).toBe(before);
    });
  });
});

describe("teardown: the drag tooltip's element class", () => {
  it("is created with the shared DRAG_TOOLTIP_CLASS", () => {
    const h = dragHarness({ config: { dragTooltip: true } });
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, DAY, BAR_Y);
    expect(h.mount.nodes[0]?.className).toBe(DRAG_TOOLTIP_CLASS);
  });
});
