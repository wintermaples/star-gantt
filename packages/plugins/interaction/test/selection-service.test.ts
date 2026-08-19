/**
 * Scope notes:
 *
 * - Plugin-identity coverage (factory shape, `meta.id`/`dependsOn`/`optional`) is out of scope
 *   here: `stargantt.selection` is not its own plugin, it is a module `createSelectionModule`
 *   assembles inside `stargantt.interaction`. That coverage belongs to `src/index.ts` /
 *   `interaction()`'s own test suite.
 * - The `renderer/layers` registration (z-index) and frame colour (reading the theme token,
 *   falling back to `SELECTION_STROKE`) are `src/index.ts` wiring, not this module:
 *   `createSelectionModule` never touches a theme service, and its callers hand the colour string
 *   to `paintSelectionFrames` themselves — not covered here.
 * - Frame painting is covered separately in `selection-paint-frames.test.ts` — not repeated.
 * - There is no `selection/changed` event: every selection-change assertion here is an assertion
 *   on `h.storeSnapshots` (a `service.state.subscribe` recording), which the harness in
 *   `_selection-fakes.ts` wires up. The effective-change rule: a snapshot is only ever pushed when
 *   the resulting id set differs from before.
 * - Whether a background drag draws a rubber band for a given mode, and whether a
 *   hit-carrying `pointer/barMove` / `pointer/barUp` routes to the right feature, is the GESTURE
 *   ARBITER's decision — `createSelectionModule`'s own `rubberBandBegin` etc. do not gate on mode
 *   themselves (the arbiter decides whether to call them at all). That machine is covered by
 *   `test/arbiter.test.ts`, not here.
 * - `selected()` is not on the service; every read here reads `service.state.get().taskIds`,
 *   exercising the store surface directly at least once per area.
 * - "teardown" is mostly `src/index.ts` plumbing (the document Escape listener, disposing the whole
 *   plugin instance); the one piece that belongs to this module — closing an open confirmation
 *   without throwing on `dispose()` — is covered in `selection-delete-flow.test.ts` /
 *   `selection-bulk-delete.test.ts`. The "no plugin faults over a session" smoke tests are covered
 *   below as "errors stays empty" checks against `h.errors`.
 */
import { describe, expect, it } from "vitest";
import { harness, makeBox, point, press } from "./_selection-fakes";

describe("service", () => {
  it("`select` replaces the whole selection", () => {
    const h = harness();
    h.module.service.select(["a", "b"]);
    expect([...h.module.service.state.get().taskIds].sort()).toEqual(["a", "b"]);
    h.module.service.select(["c"]);
    expect([...h.module.service.state.get().taskIds]).toEqual(["c"]);
  });

  it("ignores duplicates in the argument", () => {
    const h = harness();
    h.module.service.select(["a", "a", "a"]);
    expect(h.module.service.state.get().taskIds.size).toBe(1);
  });

  it("`clear` deselects everything", () => {
    const h = harness();
    h.module.service.select([1, 2, 3]);
    h.module.service.clear();
    expect(h.module.service.state.get().taskIds.size).toBe(0);
  });

  it("`toggle` is the programmatic Ctrl-click twin: adds when absent, removes when present", () => {
    const h = harness();
    h.module.service.toggle("a");
    expect(h.module.selected()).toEqual(new Set(["a"]));
    h.module.service.toggle("b");
    expect(h.module.selected()).toEqual(new Set(["a", "b"]));
    h.module.service.toggle("a");
    expect(h.module.selected()).toEqual(new Set(["b"]));
  });

  it("the store's snapshot is immutable from the outside", () => {
    const h = harness();
    h.module.service.select(["a"]);
    const snapshot = h.module.service.state.get().taskIds;
    h.module.service.select(["b"]);
    expect([...snapshot]).toEqual(["a"]);
  });

  // `Store<T>.get()` returns the literal held value with no defensive copy on read — its own
  // JSDoc says "treat it as an immutable snapshot — never mutate what it returns", a caller
  // obligation, not a runtime guard. Mutating a snapshot IS visible on the next `get()` until the
  // next real `set()`.
  it("a cast-away store snapshot is visible until the next `set()` (no defensive copy on read)", () => {
    const h = harness();
    h.module.service.select(["a"]);
    (h.module.service.state.get().taskIds as Set<string>).add("intruder");
    expect([...h.module.service.state.get().taskIds]).toEqual(["a", "intruder"]);
    // What actually matters — the module's own decisions are driven by its private `selected` Set,
    // never by a snapshot a caller mutated — still holds: the next effective change is unaffected.
    h.module.service.select(["b"]);
    expect([...h.module.service.state.get().taskIds]).toEqual(["b"]);
  });
});

describe("repaint", () => {
  it("invalidates on an effective `select()`", () => {
    const h = harness();
    h.module.service.select(["a"]);
    expect(h.invalidations).toHaveLength(1);
  });

  it("does not invalidate when the selection is unchanged", () => {
    const h = harness();
    h.module.service.select(["a", "b"]);
    h.invalidations.length = 0;
    h.module.service.select(["b", "a"]);
    h.module.service.select(["a", "b"]);
    expect(h.invalidations).toEqual([]);
  });

  it("does not invalidate when clearing an already-empty selection", () => {
    const h = harness();
    h.module.service.clear();
    expect(h.invalidations).toEqual([]);
  });
});

describe("`service.state` store (the abolished `selection/changed` event's replacement)", () => {
  it("notifies after an effective programmatic `select()`", () => {
    const h = harness();
    h.module.service.select(["a", "b"]);
    expect(h.storeSnapshots).toHaveLength(1);
    expect([...(h.storeSnapshots[0]?.taskIds ?? [])].sort()).toEqual(["a", "b"]);
  });

  it("notifies after an effective `clear()`", () => {
    const h = harness();
    h.module.service.select(["a"]);
    h.module.service.clear();
    expect(h.storeSnapshots).toHaveLength(2);
    expect([...(h.storeSnapshots[1]?.taskIds ?? [])]).toEqual([]);
  });

  it("does not notify when `select()` leaves the set unchanged", () => {
    const h = harness();
    h.module.service.select(["a", "b"]);
    h.storeSnapshots.length = 0;
    h.module.service.select(["b", "a"]);
    expect(h.storeSnapshots).toEqual([]);
  });

  it("does not notify when `clear()` is called on an already-empty selection", () => {
    const h = harness();
    h.module.service.clear();
    expect(h.storeSnapshots).toEqual([]);
  });

  it("notifies after a bar press that changes the selection", () => {
    const h = harness();
    h.module.barPress(press("t1"));
    expect(h.storeSnapshots).toHaveLength(1);
    expect([...(h.storeSnapshots[0]?.taskIds ?? [])]).toEqual(["t1"]);
  });

  it("carries a snapshot that later changes do not mutate", () => {
    const h = harness();
    h.module.service.select(["a"]);
    const snapshot = h.storeSnapshots[0]?.taskIds;
    h.module.service.select(["b"]);
    expect([...(snapshot ?? [])]).toEqual(["a"]);
  });

  // Regression pin (this port found the opposite: `handlePress` used to publish before moving the
  // anchor, so every snapshot carried the PREVIOUS press's anchor). The anchor now moves first, so
  // the snapshot a subscriber receives is the one the field's own doc promises — "the task of the
  // most recent non-Shift press or Ctrl/Cmd toggle".
  it("publishes the anchor the press itself established, not the previous one", () => {
    const h = harness({ mode: "multi" });
    h.bars.boxes.push(makeBox("t1", 0, 0), makeBox("t2", 0, 30));
    h.module.barPress(press("t1"));
    expect(h.storeSnapshots[0]?.anchor).toBe("t1");
    h.module.barPress(press("t2", { ctrlKey: true }));
    expect(h.storeSnapshots[1]?.anchor).toBe("t2");
  });

  it("publishes the anchor a deferred collapse established when it resolves", () => {
    const h = harness({ mode: "multi" });
    h.bars.boxes.push(makeBox("t1", 0, 0), makeBox("t2", 0, 30));
    h.module.service.select(["t1", "t2"]);
    // An unmodified press inside the multi-selection defers; the release in place collapses it.
    h.module.barPress(press("t2", { clientX: 10, clientY: 10 }));
    h.module.pointerUp(point({ clientX: 10, clientY: 10 }));
    expect(h.storeSnapshots.at(-1)?.anchor).toBe("t2");
  });

  // §2.1 (amended): the store is published when the id set OR the anchor differs from what is
  // currently published. The regression this pins: `apply()` used to return early on an unchanged
  // id set, so a press that moved only the anchor published nothing and the exposed anchor went
  // stale — reachable with a single-task selection made through the service, where the press does
  // not defer (the deferral needs two or more selected).
  it("publishes an anchor-only press that leaves the id set alone", () => {
    const h = harness({ mode: "multi" });
    h.bars.boxes.push(makeBox("t1", 0, 0));
    h.module.service.select(["t1"]); // anchor untouched by a programmatic change
    expect(h.storeSnapshots).toHaveLength(1);
    expect(h.storeSnapshots[0]?.anchor).toBeUndefined();

    h.module.barPress(press("t1"));
    expect(h.storeSnapshots).toHaveLength(2);
    expect(h.storeSnapshots[1]?.anchor).toBe("t1");
    expect([...(h.storeSnapshots[1]?.taskIds ?? [])]).toEqual(["t1"]);
    // The set stood still, so nothing repainted and the grid was not re-marked: only the anchor
    // moved, and neither the chart nor the grid rows depend on it.
    expect(h.invalidations).toHaveLength(1);
    expect(h.mirrors).toHaveLength(1);
    // The published set is the very snapshot the previous publish carried, not a fresh copy.
    expect(h.storeSnapshots[1]?.taskIds).toBe(h.storeSnapshots[0]?.taskIds);
  });

  it("publishes nothing for a press that moves neither the id set nor the anchor", () => {
    const h = harness({ mode: "multi" });
    h.bars.boxes.push(makeBox("t1", 0, 0));
    h.module.barPress(press("t1"));
    expect(h.storeSnapshots).toHaveLength(1);
    // The same bar again: same single-task set, same anchor — an entirely ineffective press.
    h.module.barPress(press("t1"));
    expect(h.storeSnapshots).toHaveLength(1);
    expect(h.invalidations).toHaveLength(1);
    expect(h.mirrors).toHaveLength(1);
  });

  it("leaves the anchor alone on a programmatic change", () => {
    const h = harness({ mode: "multi" });
    h.bars.boxes.push(makeBox("t1", 0, 0), makeBox("t2", 0, 30));
    h.module.barPress(press("t1"));
    h.module.service.select(["t2"]);
    expect(h.storeSnapshots.at(-1)?.anchor).toBe("t1");
  });
});

describe("pointer selection: default / \"single\" mode", () => {
  it("a plain press on a bar selects exactly that bar", () => {
    const h = harness();
    h.module.barPress(press("t1"));
    expect(h.module.selected()).toEqual(new Set(["t1"]));
    h.module.barPress(press("t2"));
    expect(h.module.selected()).toEqual(new Set(["t2"]));
  });

  it("ctrl-press replaces the selection like a plain press", () => {
    const h = harness();
    h.module.barPress(press("t1"));
    h.module.barPress(press("t2", { ctrlKey: true }));
    expect(h.module.selected()).toEqual(new Set(["t2"]));
  });

  it("meta-press replaces the selection like a plain press", () => {
    const h = harness();
    h.module.service.select(["t1", "t2"]);
    h.module.barPress(press("t1", { metaKey: true }));
    expect(h.module.selected()).toEqual(new Set(["t1"]));
  });

  it("shift-press replaces the selection like a plain press", () => {
    const h = harness();
    h.module.service.select(["t1"]);
    h.module.barPress(press("t2", { shiftKey: true }));
    expect(h.module.selected()).toEqual(new Set(["t2"]));
  });

  it("re-pressing the only selected bar does not repaint", () => {
    const h = harness();
    h.module.barPress(press("t1"));
    h.invalidations.length = 0;
    h.module.barPress(press("t1"));
    expect(h.invalidations).toEqual([]);
  });

  it("carries numeric task ids through unchanged", () => {
    const h = harness();
    h.module.barPress(press(7));
    expect(h.module.selected()).toEqual(new Set([7]));
  });
});

describe("`mode`", () => {
  it("defaults to \"single\"", () => {
    const h = harness();
    h.module.barPress(press("t1"));
    expect(h.module.selected()).toEqual(new Set(["t1"]));
    expect(h.module.service.mode()).toBe("single");
  });

  it("\"single\" is spelled-out default behaviour", () => {
    const h = harness({ mode: "single" });
    h.module.barPress(press("t1"));
    expect(h.module.selected()).toEqual(new Set(["t1"]));
  });

  it("\"none\" makes a bar press change nothing", () => {
    const h = harness({ mode: "none" });
    h.module.barPress(press("t1"));
    expect(h.module.selected().size).toBe(0);
    expect(h.invalidations).toEqual([]);
  });

  it("\"none\" never clears a selection the host made either", () => {
    const h = harness({ mode: "none" });
    h.module.service.select(["t1"]);
    h.module.barPress(press("t2"));
    expect(h.module.selected()).toEqual(new Set(["t1"]));
  });

  it("\"none\" leaves the service fully usable", () => {
    const h = harness({ mode: "none" });
    h.module.service.select(["t1", "t2"]);
    expect(h.module.selected()).toEqual(new Set(["t1", "t2"]));
    expect(h.invalidations).toHaveLength(1);
    h.module.service.clear();
    expect(h.module.selected().size).toBe(0);
  });
});

describe("\"multi\" mode: modifier selection", () => {
  it("plain press replaces the selection", () => {
    const h = harness({ mode: "multi" });
    h.module.service.select(["t1", "t2"]);
    h.module.barPress(press("t3"));
    expect(h.module.selected()).toEqual(new Set(["t3"]));
  });

  it("ctrl-press toggles the pressed bar into the selection", () => {
    const h = harness({ mode: "multi" });
    h.module.barPress(press("t1"));
    h.module.barPress(press("t2", { ctrlKey: true }));
    expect([...h.module.selected()].sort()).toEqual(["t1", "t2"]);
  });

  it("ctrl-press toggles the pressed bar out of the selection", () => {
    const h = harness({ mode: "multi" });
    h.module.service.select(["t1", "t2"]);
    h.module.barPress(press("t1", { ctrlKey: true }));
    expect(h.module.selected()).toEqual(new Set(["t2"]));
  });

  it("cmd (meta)-press toggles exactly like ctrl-press", () => {
    const h = harness({ mode: "multi" });
    h.module.barPress(press("t1"));
    h.module.barPress(press("t2", { metaKey: true }));
    expect([...h.module.selected()].sort()).toEqual(["t1", "t2"]);
  });

  it("shift-press with no anchor acts as a plain press", () => {
    const h = harness({ mode: "multi" });
    h.bars.boxes.push(makeBox("t1", 0, 0), makeBox("t2", 0, 30));
    h.module.barPress(press("t2", { shiftKey: true }));
    expect(h.module.selected()).toEqual(new Set(["t2"]));
  });

  it("shift-press extends over the row range from the anchor, inclusive both ends", () => {
    const h = harness({ mode: "multi" });
    h.rows.rows.push({ id: "t1", height: 24 }, { id: "t2", height: 24 }, { id: "t3", height: 24 }, { id: "t4", height: 24 });
    h.module.barPress(press("t1")); // anchor = t1 (row 0)
    h.module.barPress(press("t3", { shiftKey: true })); // row 2
    expect([...h.module.selected()].sort()).toEqual(["t1", "t2", "t3"]);
  });

  it("a second shift-press re-extends from the same anchor, replacing the previous range", () => {
    const h = harness({ mode: "multi" });
    h.rows.rows.push({ id: "t1", height: 24 }, { id: "t2", height: 24 }, { id: "t3", height: 24 }, { id: "t4", height: 24 });
    h.module.barPress(press("t1"));
    h.module.barPress(press("t2", { shiftKey: true }));
    h.module.barPress(press("t4", { shiftKey: true }));
    expect([...h.module.selected()].sort()).toEqual(["t1", "t2", "t3", "t4"]);
  });

  it("ctrl-press also sets the anchor for a later shift-press", () => {
    const h = harness({ mode: "multi" });
    h.rows.rows.push({ id: "t1", height: 24 }, { id: "t2", height: 24 }, { id: "t3", height: 24 });
    h.module.barPress(press("t1", { ctrlKey: true })); // anchor = t1
    h.module.barPress(press("t3", { shiftKey: true }));
    expect([...h.module.selected()].sort()).toEqual(["t1", "t2", "t3"]);
  });

  it("notifies the store for a ctrl-press toggle", () => {
    const h = harness({ mode: "multi" });
    h.module.barPress(press("t1"));
    h.storeSnapshots.length = 0;
    h.module.barPress(press("t2", { ctrlKey: true }));
    expect(h.storeSnapshots).toHaveLength(1);
  });
});

describe("\"multi\" mode: rubber-band selection", () => {
  it("selects the tasks whose bar boxes intersect the drag rectangle on release", () => {
    const h = harness({ mode: "multi" });
    h.bars.boxes.push(makeBox("t1", 10, 10), makeBox("t2", 100, 100), makeBox("t3", 300, 300));
    h.module.rubberBandBegin(0, 0);
    h.module.rubberBandMove(150, 150); // rectangle (0,0)-(150,150) covers t1 and t2, not t3
    h.module.rubberBandEnd(150, 150, { ctrlKey: false, metaKey: false, cancelled: false });
    expect([...h.module.selected()].sort()).toEqual(["t1", "t2"]);
  });

  it("replaces the previous selection on a plain rubber-band release", () => {
    const h = harness({ mode: "multi" });
    h.bars.boxes.push(makeBox("t1", 10, 10), makeBox("t2", 500, 500));
    h.module.service.select(["t2"]);
    h.module.rubberBandBegin(0, 0);
    h.module.rubberBandMove(60, 40);
    h.module.rubberBandEnd(60, 40, { ctrlKey: false, metaKey: false, cancelled: false });
    expect(h.module.selected()).toEqual(new Set(["t1"]));
  });

  it("adds to the selection instead of replacing it when ctrl/cmd is held on release", () => {
    const h = harness({ mode: "multi" });
    h.bars.boxes.push(makeBox("t1", 10, 10), makeBox("t2", 500, 500));
    h.module.service.select(["t2"]);
    h.module.rubberBandBegin(0, 0);
    h.module.rubberBandMove(60, 40);
    h.module.rubberBandEnd(60, 40, { ctrlKey: true, metaKey: false, cancelled: false });
    expect([...h.module.selected()].sort()).toEqual(["t1", "t2"]);
  });

  it("clears the selection when the rectangle touches nothing and no modifier is held", () => {
    const h = harness({ mode: "multi" });
    h.bars.boxes.push(makeBox("t1", 500, 500));
    h.module.service.select(["t1"]);
    h.module.rubberBandBegin(0, 0);
    h.module.rubberBandMove(10, 10);
    h.module.rubberBandEnd(10, 10, { ctrlKey: false, metaKey: false, cancelled: false });
    expect(h.module.selected().size).toBe(0);
  });

  it("normalizes the rectangle regardless of drag direction", () => {
    const h = harness({ mode: "multi" });
    h.bars.boxes.push(makeBox("t1", 10, 10));
    h.module.rubberBandBegin(200, 200);
    h.module.rubberBandMove(0, 0); // dragged up-and-left back over the bar
    h.module.rubberBandEnd(0, 0, { ctrlKey: false, metaKey: false, cancelled: false });
    expect(h.module.selected()).toEqual(new Set(["t1"]));
  });

  it("abandons the gesture on a cancelled capture: rectangle disappears, selection untouched", () => {
    const h = harness({ mode: "multi" });
    h.bars.boxes.push(makeBox("t1", 10, 10));
    h.module.service.select(["nope"]);
    h.module.rubberBandBegin(0, 0);
    h.module.rubberBandMove(200, 200);
    h.module.rubberBandEnd(200, 200, { ctrlKey: false, metaKey: false, cancelled: true });
    expect(h.module.selected()).toEqual(new Set(["nope"]));
    expect(h.module.rubberBandRect()).toBeUndefined();
  });

  it("reports the drag rectangle while the gesture is in progress", () => {
    const h = harness({ mode: "multi" });
    h.module.rubberBandBegin(10, 20);
    h.module.rubberBandMove(60, 90);
    expect(h.module.rubberBandRect()).toEqual({ x: 10, y: 20, width: 50, height: 70 });
  });

  it("reports no rectangle once the gesture ends", () => {
    const h = harness({ mode: "multi" });
    h.module.rubberBandBegin(10, 20);
    h.module.rubberBandMove(60, 90);
    h.module.rubberBandEnd(60, 90, { ctrlKey: false, metaKey: false, cancelled: false });
    expect(h.module.rubberBandRect()).toBeUndefined();
  });
});

describe("grid-row presses", () => {
  it("a plain row press selects exactly that row's task, like a bar press", () => {
    const h = harness();
    h.module.gridPress(press("t1"));
    expect(h.module.selected()).toEqual(new Set(["t1"]));
    h.module.gridPress(press("t2"));
    expect(h.module.selected()).toEqual(new Set(["t2"]));
  });

  it("in \"none\" mode a row press changes nothing", () => {
    const h = harness({ mode: "none" });
    h.module.gridPress(press("t1"));
    expect(h.module.selected().size).toBe(0);
  });

  it("ctrl/cmd on a row press toggles membership in \"multi\" mode", () => {
    const h = harness({ mode: "multi" });
    h.module.gridPress(press("t1"));
    h.module.gridPress(press("t2", { ctrlKey: true }));
    expect([...h.module.selected()].sort()).toEqual(["t1", "t2"]);
    h.module.gridPress(press("t1", { ctrlKey: true }));
    expect(h.module.selected()).toEqual(new Set(["t2"]));
  });

  it("shift on a row press extends the row range from the anchor", () => {
    const h = harness({ mode: "multi" });
    h.rows.rows.push({ id: "t1", height: 24 }, { id: "t2", height: 24 }, { id: "t3", height: 24 });
    h.module.gridPress(press("t1")); // anchor = t1
    h.module.gridPress(press("t3", { shiftKey: true }));
    expect([...h.module.selected()].sort()).toEqual(["t1", "t2", "t3"]);
  });

  it("a bar press sets the anchor a later row shift-press extends from, and vice versa", () => {
    const h = harness({ mode: "multi" });
    h.rows.rows.push({ id: "t1", height: 24 }, { id: "t2", height: 24 }, { id: "t3", height: 24 });
    h.module.barPress(press("t1")); // anchor = t1, set on the bar surface
    h.module.gridPress(press("t3", { shiftKey: true })); // extended from the grid surface
    expect([...h.module.selected()].sort()).toEqual(["t1", "t2", "t3"]);
  });

  it("notifies the store for an effective row press", () => {
    const h = harness();
    h.module.gridPress(press("t1"));
    expect(h.storeSnapshots).toHaveLength(1);
    expect([...(h.storeSnapshots[0]?.taskIds ?? [])]).toEqual(["t1"]);
  });
});

describe("grid reflection", () => {
  it("mirrors every effective selection change through `deps.setGridSelected`", () => {
    const h = harness();
    h.module.service.select(["t1", "t2"]);
    expect(h.mirrors).toHaveLength(1);
    expect([...(h.mirrors[0] ?? [])].sort()).toEqual(["t1", "t2"]);
    h.module.service.clear();
    expect(h.mirrors).toHaveLength(2);
    expect([...(h.mirrors[1] ?? [])]).toEqual([]);
  });

  it("mirrors a bar selection and a grid-row selection alike", () => {
    const h = harness();
    h.module.barPress(press("t1"));
    h.module.gridPress(press("t2"));
    expect(h.mirrors).toEqual([["t1"], ["t2"]]);
  });

  it("does not mirror when the mutation leaves the selection unchanged", () => {
    const h = harness();
    h.module.service.select(["t1"]);
    h.mirrors.length = 0;
    h.module.service.select(["t1"]);
    expect(h.mirrors).toEqual([]);
  });
});

describe("rubber-band gesture surface (Escape / cancel path)", () => {
  it("`rubberBandCancel()` abandons the gesture: rectangle disappears, selection untouched", () => {
    const h = harness({ mode: "multi" });
    h.bars.boxes.push(makeBox("t1", 10, 10));
    h.module.service.select(["nope"]);
    h.module.rubberBandBegin(0, 0);
    h.module.rubberBandMove(200, 200);
    expect(h.module.rubberBandCancel()).toBe(true);
    expect(h.module.rubberBandRect()).toBeUndefined();
    expect(h.module.selected()).toEqual(new Set(["nope"]));
  });

  it("makes the eventual `rubberBandEnd` a no-op", () => {
    const h = harness({ mode: "multi" });
    h.bars.boxes.push(makeBox("t1", 10, 10));
    h.module.rubberBandBegin(0, 0);
    h.module.rubberBandMove(200, 200);
    h.module.rubberBandCancel();
    h.module.rubberBandEnd(200, 200, { ctrlKey: false, metaKey: false, cancelled: false });
    expect(h.module.selected().size).toBe(0);
  });

  it("reports `false` (nothing to cancel) when no rubber band is in flight", () => {
    const h = harness({ mode: "multi" });
    h.module.service.select(["t1"]);
    expect(h.module.rubberBandCancel()).toBe(false);
    expect(h.module.selected()).toEqual(new Set(["t1"]));
  });

  it("a fresh rubber band after an abandoned one starts and completes normally", () => {
    const h = harness({ mode: "multi" });
    h.bars.boxes.push(makeBox("t1", 10, 10));
    h.module.rubberBandBegin(0, 0);
    h.module.rubberBandMove(200, 200);
    h.module.rubberBandCancel();
    h.module.rubberBandBegin(0, 0);
    h.module.rubberBandMove(60, 40);
    h.module.rubberBandEnd(60, 40, { ctrlKey: false, metaKey: false, cancelled: false });
    expect(h.module.selected()).toEqual(new Set(["t1"]));
  });
});

describe("session smoke tests (no reported faults)", () => {
  it("a full single-mode session reports no errors", () => {
    const h = harness();
    h.bars.boxes.push(makeBox("t1", 0, 0));
    h.module.barPress(press("t1", { ctrlKey: true }));
    h.module.service.clear();
    expect(h.errors).toEqual([]);
  });

  it("a full \"multi\"-mode session with rubber-band drags reports no errors", () => {
    const h = harness({ mode: "multi" });
    h.bars.boxes.push(makeBox("t1", 0, 0), makeBox("t2", 30, 30));
    h.module.barPress(press("t1"));
    h.module.barPress(press("t2", { shiftKey: true }));
    h.module.rubberBandBegin(500, 500);
    h.module.rubberBandMove(600, 600);
    h.module.rubberBandEnd(600, 600, { ctrlKey: false, metaKey: false, cancelled: false });
    h.module.rubberBandBegin(0, 0);
    h.module.rubberBandMove(10, 10);
    h.module.rubberBandEnd(10, 10, { ctrlKey: false, metaKey: false, cancelled: true });
    expect(h.errors).toEqual([]);
  });
});
