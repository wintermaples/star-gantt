/**
 * The date / resize / progress drag through `createDragController` (docs/specs/plugins/interaction.md
 * §1.3 "dragging-bar", §6.2): the threshold, the ghost and commit-target painting, snapping (through
 * `deps.snap`), `liveUpdate`, the gesture's `coalesceKey`, pointer ownership, the
 * `enabled` switch and teardown.
 *
 * There is no plugin-level `pointer/*` subscription: the gesture arbiter (tested on its own in
 * `arbiter.test.ts`) owns the state machine and calls this controller directly, so every test here
 * drives `DragController`'s own methods with the payloads `./_fakes.ts`'s builders produce — no host,
 * no DOM, no canvas beyond a recording double.
 */
import { describe, expect, it } from "vitest";
import { MS_DAY } from "@stargantt/sdk";
import type { TaskId } from "@stargantt/plugin-data-store";
import { createDragController } from "../src/internal/drag/index";
import type { DragController } from "../src/internal/drag/index";
import type { DragAxis } from "../src/internal/gesture/arbiter";
import {
  GHOST_FILL,
  GHOST_STROKE,
  TARGET_LINE_DASH,
  TARGET_LINE_WIDTH,
} from "../src/internal/gesture/ghost";
import { dragHarness, recordingContext } from "./_drag-fakes";
import type { CanvasOp, RecordingContext } from "./_drag-fakes";
import { barDown, barMove, barUp } from "./_fakes";
import type { FakePointer } from "./_fakes";

const DAY = MS_DAY;
/** t0's row: bar top 4px, mid 14px, per the harness's default 28px rows / 20px bars. */
const BAR_TOP_OFFSET = 4;
const BAR_HEIGHT = 20;
const ROW_HEIGHT = 28;
const BAR_Y = 14;
/** Large enough that any displacement these tests exercise (a handful of days) stays on screen. */
const VP = { scrollLeft: 0, scrollTop: 0, width: 10 * DAY };

/* ------------------------------------------------------------------ *
 * Small drivers over the controller's own method surface
 * ------------------------------------------------------------------ */

function press(
  controller: DragController,
  id: TaskId,
  x: number,
  y: number,
  overrides: FakePointer & { kind?: string } = {},
): void {
  controller.press(barDown(id, { x, y, clientX: x, clientY: y, ...overrides }));
}

/** The first move of a press: the one that decides the axis via `pressMove`. */
function firstMove(controller: DragController, x: number, y: number, overrides: FakePointer = {}): DragAxis {
  return controller.pressMove(barMove({ x, y, clientX: x, clientY: y, ...overrides }));
}

/** A subsequent move of an already-running bar drag, via `dragMove`. */
function move(controller: DragController, x: number, y: number, overrides: FakePointer = {}): void {
  controller.dragMove(barMove({ x, y, clientX: x, clientY: y, ...overrides }));
}

function release(controller: DragController, x: number, y: number, overrides: FakePointer = {}): void {
  controller.up(barUp({ x, y, clientX: x, clientY: y, ...overrides }));
}

/** A drag entirely below the 3px threshold: press, one small move, release — commits nothing. */
function clickOnly(controller: DragController, id: TaskId, x: number, y: number): void {
  press(controller, id, x, y);
  release(controller, x, y);
}

function paint(rc: RecordingContext, controller: DragController): void {
  rc.reset();
  controller.draw(rc.ctx, VP);
}

/** The ghost band's rectangles this paint drew (the undashed `strokeRect` calls). */
function ghosts(rc: RecordingContext): number[][] {
  return rc.calls("strokeRect").filter((o) => o.dash.length === 0).map((o) => [...o.args]);
}

/** The dashed commit-target rectangles this paint drew. */
function targets(rc: RecordingContext): CanvasOp[] {
  return rc.calls("strokeRect").filter((o) => o.dash.length > 0);
}

/** Rounds to the nearest day, ties rounding up — the local stand-in for `stargantt.snap`. */
function toDay(t: number): number {
  const low = Math.floor(t / DAY) * DAY;
  return t - low < low + DAY - t ? low : low + DAY;
}
const daySnap = { snap: toDay, step: (t: number, direction: 1 | -1): number => direction * DAY };

describe("drag threshold", () => {
  it("ignores a press that never moves", () => {
    const h = dragHarness();
    const controller = createDragController(h.deps);
    clickOnly(controller, "t0", 0, BAR_Y);
    expect(h.moves).toEqual([]);
  });

  it("ignores movement of 3px or less", () => {
    const h = dragHarness();
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    const axis = firstMove(controller, 3, BAR_Y);
    expect(axis).toBe("none");
    release(controller, 3, BAR_Y);
    expect(h.moves).toEqual([]);
  });

  it("starts the drag once 3px is exceeded", () => {
    const h = dragHarness();
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    expect(firstMove(controller, 4, BAR_Y)).toBe("bar");
  });

  it("counts movement in both directions towards the threshold", () => {
    const h = dragHarness();
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    expect(firstMove(controller, 3, BAR_Y + 3)).toBe("bar");
  });

  it("does nothing on a pointer move with no press armed", () => {
    const h = dragHarness();
    const controller = createDragController(h.deps);
    expect(firstMove(controller, 500, BAR_Y)).toBe("none");
    release(controller, 500, BAR_Y);
    expect(h.moves).toEqual([]);
  });
});

describe("moving a bar", () => {
  it("commits one task/move with the dragged dates on release", () => {
    const h = dragHarness();
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, DAY, BAR_Y);
    release(controller, DAY, BAR_Y);
    expect(h.moves).toEqual([{ id: "t0", start: DAY, end: 2 * DAY, coalesceKey: expect.any(String) }]);
  });

  it("moves the task the press named, not the first one", () => {
    const h = dragHarness();
    const controller = createDragController(h.deps);
    press(controller, "t1", 0, ROW_HEIGHT + BAR_Y);
    firstMove(controller, DAY, ROW_HEIGHT + BAR_Y);
    release(controller, DAY, ROW_HEIGHT + BAR_Y);
    expect(h.moves[0]?.id).toBe("t1");
  });

  it("commits exactly one command however many moves the drag took", () => {
    const h = dragHarness();
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, 4, BAR_Y);
    move(controller, DAY / 2, BAR_Y);
    move(controller, DAY, BAR_Y);
    release(controller, DAY, BAR_Y);
    expect(h.moves).toHaveLength(1);
    expect(h.moves[0]?.start).toBe(DAY);
  });

  it("commits nothing when the drag ends back where it started", () => {
    const h = dragHarness();
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, DAY, BAR_Y);
    move(controller, 0, BAR_Y);
    release(controller, 0, BAR_Y);
    expect(h.moves).toEqual([]);
  });

  it("drags backwards as well as forwards", () => {
    const h = dragHarness();
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, -DAY, BAR_Y);
    release(controller, -DAY, BAR_Y);
    expect(h.moves).toEqual([{ id: "t0", start: -DAY, end: 0, coalesceKey: expect.any(String) }]);
  });

  it("keeps the duration of a task whose dates are not on the grid", () => {
    const odd = [{ id: "odd", parentId: null, name: "odd", start: 0, end: DAY + 5 }];
    const h = dragHarness({ tasks: odd });
    const controller = createDragController(h.deps);
    press(controller, "odd", 0, BAR_Y);
    firstMove(controller, DAY, BAR_Y);
    release(controller, DAY, BAR_Y);
    expect(h.moves).toEqual([{ id: "odd", start: DAY, end: 2 * DAY + 5, coalesceKey: expect.any(String) }]);
  });
});

describe("resizing a bar", () => {
  it("moves only the end when the end handle is dragged", () => {
    const h = dragHarness();
    const controller = createDragController(h.deps);
    // x near the task's own end (DAY) picks the end handle (resizeModeAt's nearer-end rule).
    press(controller, "t0", DAY - 1, BAR_Y, { kind: "handle" });
    firstMove(controller, DAY - 1 + DAY, BAR_Y);
    release(controller, DAY - 1 + DAY, BAR_Y);
    expect(h.moves).toEqual([{ id: "t0", start: 0, end: 2 * DAY, coalesceKey: expect.any(String) }]);
  });

  it("moves only the start when the start handle is dragged", () => {
    const h = dragHarness();
    const controller = createDragController(h.deps);
    press(controller, "t0", 1, BAR_Y, { kind: "handle" });
    firstMove(controller, 1 - DAY, BAR_Y);
    release(controller, 1 - DAY, BAR_Y);
    expect(h.moves).toEqual([{ id: "t0", start: -DAY, end: DAY, coalesceKey: expect.any(String) }]);
  });

  it("refuses to drag the start past the end", () => {
    const h = dragHarness();
    const controller = createDragController(h.deps);
    press(controller, "t0", 1, BAR_Y, { kind: "handle" });
    firstMove(controller, 1 + 3 * DAY, BAR_Y);
    release(controller, 1 + 3 * DAY, BAR_Y);
    expect(h.moves).toEqual([{ id: "t0", start: DAY, end: DAY, coalesceKey: expect.any(String) }]);
  });
});

describe("snapping (deps.snap, §2.2)", () => {
  it("commits the date the snap service rounds to", () => {
    const h = dragHarness({ snap: daySnap });
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    const dx = 1.4 * DAY;
    firstMove(controller, dx, BAR_Y);
    release(controller, dx, BAR_Y);
    expect(h.moves).toEqual([{ id: "t0", start: DAY, end: 2 * DAY, coalesceKey: expect.any(String) }]);
  });

  it("leaves the date exactly where the pointer put it while Alt is held", () => {
    const h = dragHarness({ snap: daySnap });
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    const dx = 1.5 * DAY;
    firstMove(controller, dx, BAR_Y, { altKey: true });
    release(controller, dx, BAR_Y, { altKey: true });
    expect(h.moves).toEqual([{ id: "t0", start: 1.5 * DAY, end: 2.5 * DAY, coalesceKey: expect.any(String) }]);
  });

  it("takes Alt from the event that ends the drag, so it can be toggled mid-drag", () => {
    const h = dragHarness({ snap: daySnap });
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    const dx = 1.5 * DAY;
    firstMove(controller, dx, BAR_Y);
    release(controller, dx, BAR_Y, { altKey: true });
    expect(h.moves).toEqual([{ id: "t0", start: 1.5 * DAY, end: 2.5 * DAY, coalesceKey: expect.any(String) }]);
  });

  it("obeys whatever unit the composed snap service applies, not a fixed one", () => {
    // An hour-rounding rule, standing in for `snap.unit: "hour"`: 24.75h rounds up to 25h.
    const hourSnap = {
      snap: (t: number): number => Math.round(t / 3_600_000) * 3_600_000,
      step: (t: number, d: 1 | -1): number => d * 3_600_000,
    };
    const h = dragHarness({ snap: hourSnap });
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    const dx = DAY + DAY / 32; // 24.75 hours
    firstMove(controller, dx, BAR_Y);
    release(controller, dx, BAR_Y);
    expect(h.moves).toEqual([{ id: "t0", start: 25 * 3_600_000, end: 25 * 3_600_000 + DAY, coalesceKey: expect.any(String) }]);
  });

  it("commits the raw pointer dates when the composed snap is the identity (no rounding rule)", () => {
    const h = dragHarness(); // default snap: identity
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    const dx = 1.25 * DAY;
    firstMove(controller, dx, BAR_Y);
    release(controller, dx, BAR_Y);
    expect(h.moves).toEqual([{ id: "t0", start: 1.25 * DAY, end: 2.25 * DAY, coalesceKey: expect.any(String) }]);
  });

  it("still commits nothing when an unrounded drag ends where it started", () => {
    const h = dragHarness();
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, DAY, BAR_Y);
    move(controller, 0, BAR_Y);
    release(controller, 0, BAR_Y);
    expect(h.moves).toEqual([]);
  });
});

describe("the commit target", () => {
  const OFF_GRID = 1.25 * DAY;

  it("draws the band where the pointer is and the target where the release would land", () => {
    const h = dragHarness({ snap: daySnap });
    const controller = createDragController(h.deps);
    const rc = recordingContext();
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, OFF_GRID, BAR_Y);
    paint(rc, controller);
    expect(ghosts(rc)[0]?.[0]).toBeCloseTo(OFF_GRID, 6);
    expect(targets(rc).map((o) => o.args)).toEqual([[DAY, BAR_TOP_OFFSET, DAY, BAR_HEIGHT]]);
  });

  it("strokes the target dashed, matching the ghost's own outline width and colour", () => {
    const h = dragHarness({ snap: daySnap });
    const controller = createDragController(h.deps);
    const rc = recordingContext();
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, OFF_GRID, BAR_Y);
    paint(rc, controller);
    const target = targets(rc)[0];
    expect(target?.dash).toEqual([...TARGET_LINE_DASH]);
    expect(target?.lineWidth).toBe(TARGET_LINE_WIDTH);
    expect(target?.stroke).toBe(GHOST_STROKE);
  });

  it("gives the target no fill of its own", () => {
    const h = dragHarness({ snap: daySnap });
    const controller = createDragController(h.deps);
    const rc = recordingContext();
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, OFF_GRID, BAR_Y);
    paint(rc, controller);
    expect(rc.calls("fillRect")).toHaveLength(1);
  });

  it("draws no target while the rounded dates already match the pointer", () => {
    const h = dragHarness({ snap: daySnap });
    const controller = createDragController(h.deps);
    const rc = recordingContext();
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, DAY, BAR_Y);
    paint(rc, controller);
    expect(ghosts(rc)).toHaveLength(1);
    expect(targets(rc)).toHaveLength(0);
  });

  it("draws no target while Alt is held", () => {
    const h = dragHarness({ snap: daySnap });
    const controller = createDragController(h.deps);
    const rc = recordingContext();
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, OFF_GRID, BAR_Y, { altKey: true });
    paint(rc, controller);
    expect(targets(rc)).toHaveLength(0);
  });

  it("draws no target with an identity (no-op) snap", () => {
    const h = dragHarness(); // identity snap: `rounded` is always false
    const controller = createDragController(h.deps);
    const rc = recordingContext();
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, OFF_GRID, BAR_Y);
    paint(rc, controller);
    expect(targets(rc)).toHaveLength(0);
  });

  it("dispatches nothing while the target is only being shown", () => {
    const h = dragHarness({ snap: daySnap });
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, OFF_GRID, BAR_Y);
    expect(h.moves).toEqual([]);
  });

  it("abandons band and target alike on cancel()", () => {
    const h = dragHarness({ snap: daySnap });
    const controller = createDragController(h.deps);
    const rc = recordingContext();
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, OFF_GRID, BAR_Y);
    controller.cancel();
    paint(rc, controller);
    expect(ghosts(rc)).toHaveLength(0);
    expect(targets(rc)).toHaveLength(0);
  });
});

describe("the ghost follows the pointer continuously", () => {
  it("moves the band by a fraction of a unit rather than jumping a whole one", () => {
    const h = dragHarness();
    const controller = createDragController(h.deps);
    const rc = recordingContext();
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, 4, BAR_Y);
    move(controller, 5, BAR_Y);
    paint(rc, controller);
    expect(ghosts(rc)[0]?.[0]).toBeCloseTo(5, 6);
  });
});

describe("the ghost", () => {
  it("draws the dragged bar in its proposed position", () => {
    const h = dragHarness();
    const controller = createDragController(h.deps);
    const rc = recordingContext();
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, DAY, BAR_Y);
    paint(rc, controller);
    expect(ghosts(rc)).toEqual([[DAY, BAR_TOP_OFFSET, DAY, BAR_HEIGHT]]);
  });

  it("falls back to its built-in colours when the theme defines none", () => {
    const h = dragHarness();
    const controller = createDragController(h.deps);
    const rc = recordingContext();
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, DAY, BAR_Y);
    paint(rc, controller);
    expect(rc.calls("fillRect")[0]?.fill).toBe(GHOST_FILL);
    expect(rc.calls("strokeRect")[0]?.stroke).toBe(GHOST_STROKE);
  });

  it("takes its colours from the theme service when tokens are set", () => {
    const h = dragHarness({
      themeTokens: {
        "--sg-drag-ghost-fill": "rgba(1, 2, 3, 0.2)",
        "--sg-drag-ghost-stroke": "#0f0",
      },
    });
    const controller = createDragController(h.deps);
    const rc = recordingContext();
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, DAY, BAR_Y);
    paint(rc, controller);
    expect(rc.calls("fillRect")[0]?.fill).toBe("rgba(1, 2, 3, 0.2)");
    expect(rc.calls("strokeRect")[0]?.stroke).toBe("#0f0");
  });

  it("uses the built-in colour for a token the theme resolves to the empty string", () => {
    const h = dragHarness({ themeTokens: { "--sg-drag-ghost-fill": "" } });
    const controller = createDragController(h.deps);
    const rc = recordingContext();
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, DAY, BAR_Y);
    paint(rc, controller);
    expect(rc.calls("fillRect")[0]?.fill).toBe(GHOST_FILL);
  });

  it("follows the pointer", () => {
    const h = dragHarness();
    const controller = createDragController(h.deps);
    const rc = recordingContext();
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, DAY, BAR_Y);
    move(controller, 2 * DAY, BAR_Y);
    paint(rc, controller);
    expect(ghosts(rc)).toEqual([[2 * DAY, BAR_TOP_OFFSET, DAY, BAR_HEIGHT]]);
  });

  it("only shows one end moving during a resize", () => {
    const h = dragHarness();
    const controller = createDragController(h.deps);
    const rc = recordingContext();
    press(controller, "t0", DAY - 1, BAR_Y, { kind: "handle" });
    firstMove(controller, DAY - 1 + DAY, BAR_Y);
    paint(rc, controller);
    expect(ghosts(rc)).toEqual([[0, BAR_TOP_OFFSET, 2 * DAY, BAR_HEIGHT]]);
  });

  it("keeps a milestone the size it is drawn instead of collapsing it", () => {
    const milestone = [
      { id: "m", parentId: null, name: "m", start: 2 * DAY, end: 2 * DAY, type: "milestone" as const },
    ];
    // A milestone's box is centred on its instant, `BAR_HEIGHT` wide: x = start − height/2.
    const boxes = [{ id: "m", x: 2 * DAY - BAR_HEIGHT / 2, y: BAR_TOP_OFFSET, width: BAR_HEIGHT, height: BAR_HEIGHT }];
    const h = dragHarness({ tasks: milestone, boxes });
    const controller = createDragController(h.deps);
    const rc = recordingContext();
    const centre = 2 * DAY;
    press(controller, "m", centre, BAR_Y);
    firstMove(controller, centre + DAY, BAR_Y);
    paint(rc, controller);
    expect(ghosts(rc)).toEqual([[centre + DAY - BAR_HEIGHT / 2, BAR_TOP_OFFSET, BAR_HEIGHT, BAR_HEIGHT]]);
    release(controller, centre + DAY, BAR_Y);
    expect(h.moves).toEqual([{ id: "m", start: 3 * DAY, end: 3 * DAY, coalesceKey: expect.any(String) }]);
  });

  it("goes away once the drag is committed", () => {
    const h = dragHarness();
    const controller = createDragController(h.deps);
    const rc = recordingContext();
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, DAY, BAR_Y);
    paint(rc, controller);
    expect(ghosts(rc)).toHaveLength(1);
    release(controller, DAY, BAR_Y);
    paint(rc, controller);
    expect(ghosts(rc)).toHaveLength(0);
  });
});

describe("abandoning a drag (cancel())", () => {
  it("throws the drag away, leaving the task alone", () => {
    const h = dragHarness();
    const controller = createDragController(h.deps);
    const rc = recordingContext();
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, DAY, BAR_Y);
    controller.cancel();
    paint(rc, controller);
    expect(ghosts(rc)).toHaveLength(0);
    // The pointer's own release finds no gesture: cancel() already discarded it.
    release(controller, DAY, BAR_Y);
    expect(h.moves).toEqual([]);
    expect(h.tasks[0]?.start).toBe(0);
  });

  it("does not resume the abandoned drag on the next pointer move", () => {
    const h = dragHarness();
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, DAY, BAR_Y);
    controller.cancel();
    // A "move" after cancel() finds no gesture: `pressMove`/`dragMove` are no-ops when nothing runs.
    move(controller, 2 * DAY, BAR_Y);
    release(controller, 2 * DAY, BAR_Y);
    expect(h.moves).toEqual([]);
  });

  it("abandons the drag when the gesture ends as a cancelled capture", () => {
    const h = dragHarness();
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, DAY, BAR_Y);
    release(controller, DAY, BAR_Y, { type: "pointercancel" });
    expect(h.moves).toEqual([]);
  });
});

describe("what it declines to drag", () => {
  it("starts no gesture for a hit kind it does not edit", () => {
    const h = dragHarness();
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y, { kind: "link" });
    expect(firstMove(controller, DAY, BAR_Y)).toBe("none");
    release(controller, DAY, BAR_Y);
    expect(h.moves).toEqual([]);
  });

  it("stays inert when the task cannot be found (no data store composed)", () => {
    const h = dragHarness();
    h.deps.getTask = () => undefined;
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, DAY, BAR_Y);
    release(controller, DAY, BAR_Y);
    expect(h.moves).toEqual([]);
  });

  it("ignores a press by a second pointer while a drag is already running", () => {
    const h = dragHarness();
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y, { pointerId: 1 });
    firstMove(controller, DAY, BAR_Y, { pointerId: 1 });
    press(controller, "t1", 0, ROW_HEIGHT + BAR_Y, { pointerId: 2 });
    release(controller, DAY, BAR_Y, { pointerId: 1 });
    expect(h.moves).toEqual([{ id: "t0", start: DAY, end: 2 * DAY, coalesceKey: expect.any(String) }]);
  });
});

describe("liveUpdate", () => {
  it("dispatches nothing until the release by default", () => {
    const h = dragHarness();
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, 4, BAR_Y);
    move(controller, DAY / 2, BAR_Y);
    move(controller, DAY, BAR_Y);
    expect(h.moves).toEqual([]);
    release(controller, DAY, BAR_Y);
    expect(h.moves).toEqual([{ id: "t0", start: DAY, end: 2 * DAY, coalesceKey: expect.any(String) }]);
  });

  it("dispatches the snapped proposal per pointer move when it is on", () => {
    const h = dragHarness({ config: { liveUpdate: true } });
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, DAY, BAR_Y);
    expect(h.moves).toEqual([{ id: "t0", start: DAY, end: 2 * DAY, coalesceKey: expect.any(String) }]);
    move(controller, 2 * DAY, BAR_Y);
    expect(h.moves).toHaveLength(2);
    expect(h.moves[1]).toEqual({ id: "t0", start: 2 * DAY, end: 3 * DAY, coalesceKey: expect.any(String) });
  });

  it("dispatches the rounded dates, not the raw pointer ones", () => {
    const h = dragHarness({ config: { liveUpdate: true }, snap: daySnap });
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, 1.25 * DAY, BAR_Y);
    expect(h.moves).toEqual([{ id: "t0", start: DAY, end: 2 * DAY, coalesceKey: expect.any(String) }]);
  });

  it("still draws the unsnapped ghost while it dispatches the snapped dates", () => {
    const h = dragHarness({ config: { liveUpdate: true }, snap: daySnap });
    const controller = createDragController(h.deps);
    const rc = recordingContext();
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, 1.25 * DAY, BAR_Y);
    paint(rc, controller);
    expect(ghosts(rc)[0]?.[0]).toBeCloseTo(1.25 * DAY, 6);
  });

  it("skips the moves that would re-dispatch what the store already holds", () => {
    const h = dragHarness({ config: { liveUpdate: true }, snap: daySnap });
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, 4, BAR_Y);
    move(controller, DAY / 2, BAR_Y);
    move(controller, DAY, BAR_Y);
    expect(h.moves).toHaveLength(1);
    release(controller, DAY, BAR_Y);
    expect(h.moves).toHaveLength(1);
  });

  it("leaves what it already dispatched in place when cancel() abandons the drag", () => {
    const h = dragHarness({ config: { liveUpdate: true } });
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, DAY, BAR_Y);
    controller.cancel();
    move(controller, 2 * DAY, BAR_Y);
    release(controller, 2 * DAY, BAR_Y);
    expect(h.moves).toHaveLength(1);
    expect(h.tasks[0]?.start).toBe(DAY);
  });
});

describe("the gesture's coalesceKey", () => {
  it("puts a key on the command a drag commits", () => {
    const h = dragHarness();
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, DAY, BAR_Y);
    release(controller, DAY, BAR_Y);
    expect(h.moves).toHaveLength(1);
    expect(typeof h.moves[0]?.coalesceKey).toBe("string");
    expect(h.moves[0]?.coalesceKey).not.toBe("");
  });

  it("shares one key across every command of a live-updating drag", () => {
    const h = dragHarness({ config: { liveUpdate: true } });
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, DAY, BAR_Y);
    move(controller, 2 * DAY, BAR_Y);
    release(controller, 3 * DAY, BAR_Y);
    expect(h.moves.length).toBeGreaterThan(1);
    expect(new Set(h.moves.map((m) => m.coalesceKey)).size).toBe(1);
  });

  it("mints a different key for each drag, so two drags stay two undo entries", () => {
    const h = dragHarness();
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, DAY, BAR_Y);
    release(controller, DAY, BAR_Y);
    press(controller, "t0", DAY, BAR_Y);
    firstMove(controller, 2 * DAY, BAR_Y);
    release(controller, 2 * DAY, BAR_Y);
    expect(h.moves).toHaveLength(2);
    expect(h.moves[0]?.coalesceKey).not.toBe(h.moves[1]?.coalesceKey);
  });
});

describe("the progress drag", () => {
  // A function, not a shared array: the fake store writes committed progress straight into the task
  // object it was given, so a module-level fixture would carry one test's edit into the next.
  /** A half-complete one-day task; the boundary sits mid-bar (default box width == DAY). */
  const halfDone = (): { id: string; parentId: null; name: string; start: number; end: number; progress: number }[] => [
    { id: "p", parentId: null, name: "p", start: 0, end: DAY, progress: 0.5 },
  ];
  const BOUNDARY = DAY / 2;

  it("commits one task/setProgress with the fraction the pointer reached", () => {
    const h = dragHarness({ tasks: halfDone() });
    const controller = createDragController(h.deps);
    press(controller, "p", BOUNDARY, BAR_Y, { kind: "progress" });
    firstMove(controller, DAY * 0.75, BAR_Y);
    release(controller, DAY * 0.75, BAR_Y);
    expect(h.moves).toEqual([]);
    expect(h.progresses).toEqual([{ id: "p", progress: 0.75, coalesceKey: expect.any(String) }]);
  });

  it("clamps to 1 off the bar's right edge and to 0 off its left edge", () => {
    const right = dragHarness({ tasks: halfDone() });
    const rightController = createDragController(right.deps);
    press(rightController, "p", BOUNDARY, BAR_Y, { kind: "progress" });
    firstMove(rightController, 10 * DAY, BAR_Y);
    release(rightController, 10 * DAY, BAR_Y);
    expect(right.progresses).toEqual([{ id: "p", progress: 1, coalesceKey: expect.any(String) }]);

    const left = dragHarness({ tasks: halfDone() });
    const leftController = createDragController(left.deps);
    press(leftController, "p", BOUNDARY, BAR_Y, { kind: "progress" });
    firstMove(leftController, -10 * DAY, BAR_Y);
    release(leftController, -10 * DAY, BAR_Y);
    expect(left.progresses).toEqual([{ id: "p", progress: 0, coalesceKey: expect.any(String) }]);
  });

  it("respects the 3px threshold before it edits anything", () => {
    const h = dragHarness({ tasks: halfDone() });
    const controller = createDragController(h.deps);
    press(controller, "p", BOUNDARY, BAR_Y, { kind: "progress" });
    expect(firstMove(controller, BOUNDARY + 2, BAR_Y)).toBe("none");
    release(controller, BOUNDARY + 2, BAR_Y);
    expect(h.progresses).toEqual([]);
  });

  it("dispatches nothing when the drag lands back on the stored fraction", () => {
    const h = dragHarness({ tasks: halfDone() });
    const controller = createDragController(h.deps);
    press(controller, "p", BOUNDARY, BAR_Y, { kind: "progress" });
    firstMove(controller, BOUNDARY + DAY / 4, BAR_Y);
    move(controller, BOUNDARY, BAR_Y);
    release(controller, BOUNDARY, BAR_Y);
    expect(h.progresses).toEqual([]);
  });

  it("does not consult the snap service — progress is not an instant", () => {
    const h = dragHarness({ tasks: halfDone(), snap: daySnap });
    const controller = createDragController(h.deps);
    press(controller, "p", BOUNDARY, BAR_Y, { kind: "progress" });
    firstMove(controller, BOUNDARY + 5, BAR_Y);
    release(controller, BOUNDARY + 5, BAR_Y);
    expect(h.progresses[0]?.progress).toBeCloseTo(0.5 + 5 / DAY, 10);
  });

  it("carries the gesture's coalesceKey", () => {
    const h = dragHarness({ tasks: halfDone() });
    const controller = createDragController(h.deps);
    press(controller, "p", BOUNDARY, BAR_Y, { kind: "progress" });
    firstMove(controller, BOUNDARY + 10, BAR_Y);
    release(controller, BOUNDARY + 10, BAR_Y);
    expect(typeof h.progresses[0]?.coalesceKey).toBe("string");
  });

  it("dispatches per move under liveUpdate, all under one key", () => {
    const h = dragHarness({ tasks: halfDone(), config: { liveUpdate: true } });
    const controller = createDragController(h.deps);
    press(controller, "p", BOUNDARY, BAR_Y, { kind: "progress" });
    firstMove(controller, BOUNDARY + 5, BAR_Y);
    move(controller, BOUNDARY + 10, BAR_Y);
    release(controller, BOUNDARY + 10, BAR_Y);
    expect(h.progresses).toHaveLength(2);
    expect(new Set(h.progresses.map((p) => p.coalesceKey)).size).toBe(1);
  });

  it("paints no ghost: the progress strip is a hit zone, not a glyph", () => {
    const h = dragHarness({ tasks: halfDone() });
    const controller = createDragController(h.deps);
    const rc = recordingContext();
    press(controller, "p", BOUNDARY, BAR_Y, { kind: "progress" });
    firstMove(controller, BOUNDARY + 10, BAR_Y);
    paint(rc, controller);
    expect(ghosts(rc)).toHaveLength(0);
    expect(targets(rc)).toHaveLength(0);
    expect(rc.calls("fillRect")).toHaveLength(0);
  });

  it("abandons the progress drag on cancel()", () => {
    const h = dragHarness({ tasks: halfDone() });
    const controller = createDragController(h.deps);
    press(controller, "p", BOUNDARY, BAR_Y, { kind: "progress" });
    firstMove(controller, BOUNDARY + 10, BAR_Y);
    controller.cancel();
    release(controller, BOUNDARY + 10, BAR_Y);
    expect(h.progresses).toEqual([]);
  });
});

describe("which pointer owns the drag", () => {
  const OTHER: FakePointer = { pointerId: 2 };

  it("ignores a release by a different pointer", () => {
    const h = dragHarness();
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, DAY, BAR_Y);
    release(controller, 10 * DAY, BAR_Y, OTHER);
    expect(h.moves).toEqual([]);
    release(controller, DAY, BAR_Y);
    expect(h.moves).toEqual([{ id: "t0", start: DAY, end: 2 * DAY, coalesceKey: expect.any(String) }]);
  });

  it("ignores movement by a different pointer", () => {
    const h = dragHarness();
    const controller = createDragController(h.deps);
    const rc = recordingContext();
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, DAY, BAR_Y);
    move(controller, 5 * DAY, BAR_Y, OTHER);
    paint(rc, controller);
    expect(ghosts(rc)).toEqual([[DAY, BAR_TOP_OFFSET, DAY, BAR_HEIGHT]]);
  });

  it("does not start a drag from a press whose threshold another pointer crossed", () => {
    const h = dragHarness();
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    expect(firstMove(controller, 10 * DAY, BAR_Y, OTHER)).toBe("none");
    release(controller, 10 * DAY, BAR_Y, OTHER);
    expect(h.moves).toEqual([]);
  });
});

describe("losing the pointer mid-drag: buttons==0", () => {
  it("is now the arbiter's job — a dragMove with no buttons held is silently ignored here", () => {
    // decideMove(...) reports `{type:"abandon"}` for `buttons:0`, and `move()` simply returns: the
    // gesture is untouched. The arbiter calls `cancel()` before this can ever run (see
    // arbiter.test.ts, "abandons on a move with no buttons held"); this test documents what the
    // controller does if driven directly.
    const h = dragHarness();
    const controller = createDragController(h.deps);
    const rc = recordingContext();
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, DAY, BAR_Y);
    move(controller, 2 * DAY, BAR_Y, { buttons: 0 });
    paint(rc, controller);
    // The ghost is exactly where the last *effective* move left it — the buttons:0 move changed
    // nothing.
    expect(ghosts(rc)).toEqual([[DAY, BAR_TOP_OFFSET, DAY, BAR_HEIGHT]]);
  });

  it("cancel() is what actually discards it, and does so fully", () => {
    const h = dragHarness();
    const controller = createDragController(h.deps);
    const rc = recordingContext();
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, DAY, BAR_Y);
    controller.cancel();
    paint(rc, controller);
    expect(ghosts(rc)).toHaveLength(0);
    move(controller, 2 * DAY, BAR_Y);
    release(controller, 2 * DAY, BAR_Y);
    expect(h.moves).toEqual([]);
  });
});

describe("the enabled switch", () => {
  it("starts no gesture at all: a press, move and release do nothing", () => {
    const h = dragHarness({ config: { enabled: false } });
    const controller = createDragController(h.deps);
    const rc = recordingContext();
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, DAY, BAR_Y);
    release(controller, DAY, BAR_Y);
    paint(rc, controller);
    expect(h.moves).toEqual([]);
    expect(ghosts(rc)).toHaveLength(0);
  });

  it("starts no progress gesture either", () => {
    const halfDone = [{ id: "t0", parentId: null, name: "t0", start: 0, end: DAY, progress: 0.5 }];
    const h = dragHarness({ tasks: halfDone, config: { enabled: false } });
    const controller = createDragController(h.deps);
    press(controller, "t0", DAY / 2, BAR_Y, { kind: "progress" });
    firstMove(controller, DAY, BAR_Y);
    release(controller, DAY, BAR_Y);
    expect(h.progresses).toEqual([]);
  });

  it("behaves exactly as when omitted, once turned back on", () => {
    const h = dragHarness({ config: { enabled: true } });
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, DAY, BAR_Y);
    release(controller, DAY, BAR_Y);
    expect(h.moves).toEqual([{ id: "t0", start: DAY, end: 2 * DAY, coalesceKey: expect.any(String) }]);
  });
});

describe("teardown (dispose)", () => {
  it("removes the drag tooltip element", () => {
    const h = dragHarness({ config: { dragTooltip: true } });
    const controller = createDragController(h.deps);
    press(controller, "t0", 0, BAR_Y);
    firstMove(controller, DAY, BAR_Y);
    expect(h.mount.nodes).toHaveLength(1);
    let removed = false;
    h.mount.nodes[0]!.remove = () => {
      removed = true;
    };
    controller.dispose();
    expect(removed).toBe(true);
  });
});
