/**
 * The resource-lane drag (docs/specs/plugins/interaction.md §6.2 "resourceDrag"): the structural
 * seam guard and the lane-targeting arithmetic as pure functions, then the whole gesture through
 * `createDragController` with a recording `LaneDragProvider` double — hostless, no `Gantt.create()`.
 *
 * Case mapping from the predecessor's lane-drag suite:
 * - `asResourceViewSeam` → `isUsableLaneProvider` (same admission rule, now a boolean type guard
 *   instead of a value-returning helper): "admits an object carrying both members and nothing else"
 *   ports directly.
 * - `laneTargetAt` unit tests port directly (same signature, same module).
 * - Every `describe("resource-lane drag (resourceDrag)", …)` case, which drove a real
 *   `Gantt.create()` over the fake DOM (`boot()` + `booted.down/move/up/press/cancelPointer`) against
 *   a `stargantt.resource-view` plugin double, is DECOMPOSED into direct calls against
 *   `createDragController(deps)` built from `dragHarness({ config, lanes })`:
 *     - `boot()` + `stubResourceView(...)` → `dragHarness({ lanes: laneProviderOf({...}) })`.
 *     - `booted.down/move/up` → `controller.press/pressMove/dragMove/up` (see the protocol note on
 *       the constant `Y` below — the harness's fake root reports `getBoundingClientRect().top === 0`,
 *       so root-relative y equals `clientY` directly, and every move/press event in this file sets
 *       `y === clientY` so the pointer's *viewport-local* y cancels out of `viewportYToRoot`, leaving
 *       the source-lane lookup keyed on the bar's own (unchanging) box — exactly as it is in v2).
 *     - `booted.press("Escape")` → `controller.cancel()` (Escape/abandonment is the ARBITER's job in
 *       v2, already covered by `test/arbiter.test.ts`'s `dragging-lane` cases; here only the
 *       controller's OWN reaction to `cancel()` — nothing written, the provider's mark cleared — is
 *       under test).
 *     - `booted.cancelPointer()` → `controller.up(barUp({ …, type: "pointercancel" }))` (a cancelled
 *       capture arrives as the gesture's own release in v2's arbiter, not as a separate cancel path).
 */
import { describe, expect, it } from "vitest";
import { isUsableLaneProvider, laneTargetAt } from "../src/internal/drag/lane-drag";
import type { LaneBox, LaneDragProvider } from "../src/types";
import { createDragController } from "../src/internal/drag";
import { dragHarness, laneProviderOf } from "./_drag-fakes";
import { barDown, barMove, barUp } from "./_fakes";

/** Three lanes stacked exactly on the harness's default three rows (28px each). */
function stackedLanes(): LaneBox[] {
  return [
    { resourceId: "r0", y: 0, height: 28 },
    { resourceId: "r1", y: 28, height: 28 },
    { resourceId: "r2", y: 56, height: 28 },
  ];
}

/** t0's bar sits at row 0 (y 4..24, mid 14) — the source lane every drag in this file starts from. */
const T0_MID_Y = 14;

describe("isUsableLaneProvider", () => {
  it("admits an object carrying both members and nothing else", () => {
    const seam = { laneAt: () => undefined, reassign: () => {} };
    expect(isUsableLaneProvider(seam)).toBe(true);
    expect(isUsableLaneProvider(undefined)).toBe(false);
    expect(isUsableLaneProvider(null)).toBe(false);
    expect(isUsableLaneProvider("stargantt.resource-view")).toBe(false);
    expect(isUsableLaneProvider({ laneAt: () => undefined })).toBe(false);
    expect(isUsableLaneProvider({ reassign: () => {} })).toBe(false);
    expect(isUsableLaneProvider({ laneAt: 1, reassign: () => {} })).toBe(false);
  });
});

describe("laneTargetAt", () => {
  const lanes: LaneBox[] = [
    { resourceId: "r0", y: 0, height: 28 },
    { resourceId: "r1", y: 28, height: 28 },
  ];
  const locator = {
    laneAt: (y: number) => lanes.find((lane) => y >= lane.y && y < lane.y + lane.height),
  };

  it("names the lane under the pointer", () => {
    expect(laneTargetAt(40, locator, "r0")?.resourceId).toBe("r1");
  });

  it("never names the source lane — dropping on it is not a reassignment", () => {
    expect(laneTargetAt(10, locator, "r0")).toBeUndefined();
  });

  it("answers undefined off every lane", () => {
    expect(laneTargetAt(500, locator, "r0")).toBeUndefined();
  });
});

describe("resource-lane drag (resourceDrag)", () => {
  it("reassigns the task to the lane under the release, dispatching no task/move", () => {
    const provider = laneProviderOf({ lanes: stackedLanes() });
    const h = dragHarness({ config: { resourceDrag: true }, lanes: provider });
    const controller = createDragController(h.deps);

    controller.press(barDown("t0", { clientX: 10, clientY: T0_MID_Y, x: 10, y: T0_MID_Y }));
    // Straight down, out of r0 and into r1: dy dominates, past the 3px threshold.
    const axis = controller.pressMove(
      barMove({ id: "t0", clientX: 10, clientY: 54, x: 10, y: 54 }),
    );
    expect(axis).toBe("lane");
    // The provider marks the targeted lane while the drag runs…
    expect(provider.marks).toEqual(["r1"]);

    controller.up(barUp({ id: "t0", clientX: 10, clientY: 54, x: 10, y: 54 }));
    // …and the mark is cleared on release, with the reassignment recorded.
    expect(provider.marks).toEqual(["r1", null]);
    expect(provider.reassigns).toEqual([{ taskId: "t0", from: "r0", to: "r1" }]);
    expect(h.moves).toHaveLength(0);
    expect(h.updates).toHaveLength(0);
  });

  it("commits nothing when dropped back on its own lane", () => {
    const provider = laneProviderOf({ lanes: stackedLanes() });
    const h = dragHarness({ config: { resourceDrag: true }, lanes: provider });
    const controller = createDragController(h.deps);

    controller.press(barDown("t0", { clientX: 10, clientY: T0_MID_Y, x: 10, y: T0_MID_Y }));
    controller.pressMove(barMove({ id: "t0", clientX: 10, clientY: 54, x: 10, y: 54 })); // into r1…
    controller.dragMove(barMove({ id: "t0", clientX: 10, clientY: T0_MID_Y, x: 10, y: T0_MID_Y })); // …and back onto r0
    controller.up(barUp({ id: "t0", clientX: 10, clientY: T0_MID_Y, x: 10, y: T0_MID_Y }));

    expect(provider.reassigns).toHaveLength(0);
    expect(h.moves).toHaveLength(0);
  });

  it("commits nothing when released off every lane", () => {
    const provider = laneProviderOf({ lanes: stackedLanes() });
    const h = dragHarness({ config: { resourceDrag: true }, lanes: provider });
    const controller = createDragController(h.deps);

    controller.press(barDown("t0", { clientX: 10, clientY: T0_MID_Y, x: 10, y: T0_MID_Y }));
    controller.pressMove(barMove({ id: "t0", clientX: 10, clientY: 54, x: 10, y: 54 }));
    controller.up(barUp({ id: "t0", clientX: 10, clientY: 900, x: 10, y: 900 })); // well past r2

    expect(provider.reassigns).toHaveLength(0);
  });

  it("abandons on cancel() (the arbiter's Escape) with nothing dispatched", () => {
    const provider = laneProviderOf({ lanes: stackedLanes() });
    const h = dragHarness({ config: { resourceDrag: true }, lanes: provider });
    const controller = createDragController(h.deps);

    controller.press(barDown("t0", { clientX: 10, clientY: T0_MID_Y, x: 10, y: T0_MID_Y }));
    controller.pressMove(barMove({ id: "t0", clientX: 10, clientY: 54, x: 10, y: 54 }));
    controller.cancel();
    // The eventual release the arbiter would never route here anyway finds no gesture and is inert.
    controller.up(barUp({ id: "t0", clientX: 10, clientY: 54, x: 10, y: 54 }));

    expect(provider.reassigns).toHaveLength(0);
    expect(h.moves).toHaveLength(0);
    expect(provider.marks.at(-1)).toBeNull();
  });

  it("abandons on a cancelled capture with nothing dispatched", () => {
    const provider = laneProviderOf({ lanes: stackedLanes() });
    const h = dragHarness({ config: { resourceDrag: true }, lanes: provider });
    const controller = createDragController(h.deps);

    controller.press(barDown("t0", { clientX: 10, clientY: T0_MID_Y, x: 10, y: T0_MID_Y }));
    controller.pressMove(barMove({ id: "t0", clientX: 10, clientY: 54, x: 10, y: 54 }));
    controller.up(
      barUp({ id: "t0", clientX: 10, clientY: 54, x: 10, y: 54, type: "pointercancel" }),
    );

    expect(provider.reassigns).toHaveLength(0);
    expect(provider.marks.at(-1)).toBeNull();
  });

  it("stays off by default: with the service present but the flag out, no reassignment happens", () => {
    const provider = laneProviderOf({ lanes: stackedLanes() });
    const h = dragHarness({ lanes: provider }); // resourceDrag defaults false
    const controller = createDragController(h.deps);

    controller.press(barDown("t0", { clientX: 10, clientY: T0_MID_Y, x: 10, y: T0_MID_Y }));
    const axis = controller.pressMove(
      barMove({ id: "t0", clientX: 10, clientY: 54, x: 10, y: 54 }),
    );
    controller.up(barUp({ id: "t0", clientX: 10, clientY: 54, x: 10, y: 54 }));

    // The vertical pull never became a lane gesture — it stayed an ordinary date drag, and a purely
    // vertical pointer path proposes the task's own dates, so nothing is dispatched.
    expect(axis).toBe("bar");
    expect(provider.reassigns).toHaveLength(0);
    expect(h.moves).toHaveLength(0);
  });

  it("stays inert without the service: the vertical drag is an ordinary date drag", () => {
    const h = dragHarness({ config: { resourceDrag: true } }); // no `lanes` provider at all
    const controller = createDragController(h.deps);

    controller.press(barDown("t0", { clientX: 10, clientY: T0_MID_Y, x: 10, y: T0_MID_Y }));
    controller.pressMove(barMove({ id: "t0", clientX: 10, clientY: 54, x: 10, y: 54 }));
    // A further, purely horizontal move: the gesture stayed a date drag and commits it.
    controller.dragMove(barMove({ id: "t0", clientX: 1_010, clientY: 54, x: 1_010, y: 54 }));
    controller.up(barUp({ id: "t0", clientX: 1_010, clientY: 54, x: 1_010, y: 54 }));

    expect(h.moves).toHaveLength(1);
    expect(h.moves[0]).toMatchObject({ id: "t0", start: 1_000, end: 1_000 + 86_400_000 });
  });

  it("falls back to the row drag while the view shows no lanes and rowDrag is on", () => {
    const keyed = [
      { id: "t0", parentId: null, name: "t0", start: 0, end: 86_400_000, orderKey: "1" },
      { id: "t1", parentId: null, name: "t1", start: 0, end: 86_400_000, orderKey: "2" },
      { id: "t2", parentId: null, name: "t2", start: 0, end: 86_400_000, orderKey: "3" },
    ];
    // A provider whose `laneAt` always answers undefined models a view showing no lane layout.
    const provider = laneProviderOf({ lanes: [] });
    const h = dragHarness({
      tasks: keyed,
      config: { resourceDrag: true, rowDrag: true },
      lanes: provider,
    });
    const controller = createDragController(h.deps);

    controller.press(barDown("t0", { clientX: 10, clientY: T0_MID_Y, x: 10, y: T0_MID_Y }));
    // Into the gap between t1 (row 1) and t2 (row 2).
    const axis = controller.pressMove(
      barMove({ id: "t0", clientX: 10, clientY: 56, x: 10, y: 56 }),
    );
    controller.up(barUp({ id: "t0", clientX: 10, clientY: 56, x: 10, y: 56 }));

    expect(axis).toBe("row");
    expect(provider.reassigns).toHaveLength(0);
    expect(h.updates).toHaveLength(1);
  });

  it("takes precedence over the row drag while the view shows lanes", () => {
    const keyed = [
      { id: "t0", parentId: null, name: "t0", start: 0, end: 86_400_000, orderKey: "1" },
      { id: "t1", parentId: null, name: "t1", start: 0, end: 86_400_000, orderKey: "2" },
      { id: "t2", parentId: null, name: "t2", start: 0, end: 86_400_000, orderKey: "3" },
    ];
    const provider = laneProviderOf({ lanes: stackedLanes() });
    const h = dragHarness({
      tasks: keyed,
      config: { resourceDrag: true, rowDrag: true },
      lanes: provider,
    });
    const controller = createDragController(h.deps);

    controller.press(barDown("t0", { clientX: 10, clientY: T0_MID_Y, x: 10, y: T0_MID_Y }));
    const axis = controller.pressMove(
      barMove({ id: "t0", clientX: 10, clientY: 54, x: 10, y: 54 }),
    );
    controller.up(barUp({ id: "t0", clientX: 10, clientY: 54, x: 10, y: 54 }));

    expect(axis).toBe("lane");
    expect(provider.reassigns).toEqual([{ taskId: "t0", from: "r0", to: "r1" }]);
    expect(h.updates).toHaveLength(0);
  });

  it("ignores a service that lacks the seam's members", () => {
    const broken = { laneAt: () => undefined } as unknown as LaneDragProvider;
    const h = dragHarness({ config: { resourceDrag: true }, lanes: broken });
    const controller = createDragController(h.deps);

    controller.press(barDown("t0", { clientX: 10, clientY: T0_MID_Y, x: 10, y: T0_MID_Y }));
    expect(() => {
      controller.pressMove(barMove({ id: "t0", clientX: 10, clientY: 54, x: 10, y: 54 }));
      controller.up(barUp({ id: "t0", clientX: 10, clientY: 54, x: 10, y: 54 }));
    }).not.toThrow();

    // No usable seam, so the vertical drag stayed a (no-op) date drag and nothing threw.
    expect(h.moves).toHaveLength(0);
  });
});
