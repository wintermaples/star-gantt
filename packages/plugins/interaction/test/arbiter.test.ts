/**
 * The gesture arbiter's transition tables (docs/specs/plugins/interaction.md §1.3), one case per
 * cell: nine states × ten inputs, plus the per-state Escape rows and the menu's own close.
 *
 * A cell the spec marks "ignored" is asserted to be inert — the state unchanged AND nothing
 * dispatched — because "the machine happened to do nothing visible" and "the machine explicitly
 * ignores this input" are the same only when both are checked.
 */
import { describe, expect, it } from "vitest";
import { activationCounts, isMenuPress } from "../src/internal/gesture/arbiter";
import type { ArbiterState } from "../src/internal/gesture/arbiter";
import { harness } from "./_arbiter-doubles";
import type { ArbiterHarness } from "./_arbiter-doubles";
import {
  background,
  barDown,
  barHover,
  barMove,
  barUp,
  gridBackgroundMenu,
  gridDown,
  gridMove,
  gridRowMenu,
  gridUp,
} from "./_fakes";

/** Drives a fresh machine into `state` and clears the log, so a test asserts one input's effect. */
function at(state: Exclude<ArbiterState, "link-drag">): ArbiterHarness {
  const h = harness();
  switch (state) {
    case "idle":
      break;
    case "hover":
      h.arbiter.barHover(barHover(1));
      break;
    case "pressing":
      h.arbiter.barDown(barDown(1));
      break;
    case "dragging-bar":
      h.arbiter.barDown(barDown(1));
      h.axis = "bar";
      h.arbiter.barMove(barMove({ id: 1, clientX: 20 }));
      break;
    case "dragging-row":
      h.arbiter.barDown(barDown(1));
      h.axis = "row";
      h.arbiter.barMove(barMove({ id: 1, clientY: 20 }));
      break;
    case "dragging-lane":
      h.arbiter.barDown(barDown(1));
      h.axis = "lane";
      h.arbiter.barMove(barMove({ id: 1, clientY: 20 }));
      break;
    case "rubber-band":
      h.mode = "multi";
      h.arbiter.background(background());
      break;
    case "context":
      h.menuEnabled = true;
      h.arbiter.barDown(barDown(1, { button: 2 }));
      break;
  }
  expect(h.state()).toBe(state);
  h.clear();
  return h;
}

/** A machine in `dragging-row` whose row drag started from the grid pane, not from a bar. */
function gridRowDrag(): ArbiterHarness {
  const h = harness();
  h.arbiter.gridPointerDown(gridDown(1));
  h.gridAxis = "row";
  h.arbiter.gridPointerMove(gridMove({ y: 40 }));
  expect(h.state()).toBe("dragging-row");
  h.clear();
  return h;
}

/** Every input, so a table can drive "this whole row is ignored" in one loop. */
const INPUTS: readonly { name: string; fire: (h: ArbiterHarness) => void }[] = [
  { name: "pointer/barHover", fire: (h) => h.arbiter.barHover(barHover(2)) },
  { name: "pointer/barDown", fire: (h) => h.arbiter.barDown(barDown(2)) },
  { name: "pointer/barMove", fire: (h) => h.arbiter.barMove(barMove({ id: 2 })) },
  { name: "pointer/barUp", fire: (h) => h.arbiter.barUp(barUp({ id: 2 })) },
  { name: "pointer/background", fire: (h) => h.arbiter.background(background()) },
  { name: "grid/rowPointerDown", fire: (h) => h.arbiter.gridPointerDown(gridDown(2)) },
  { name: "grid/rowPointerMove", fire: (h) => h.arbiter.gridPointerMove(gridMove()) },
  { name: "grid/rowPointerUp", fire: (h) => h.arbiter.gridPointerUp(gridUp()) },
  { name: "grid/rowContextMenu", fire: (h) => h.arbiter.gridContextMenu(gridRowMenu(2)) },
  { name: "grid/backgroundContextMenu", fire: (h) => h.arbiter.gridBackgroundContextMenu(gridBackgroundMenu()) },
];

/** Asserts that every named input leaves `state` untouched and dispatches nothing at all. */
function expectIgnored(state: Exclude<ArbiterState, "link-drag">, names: readonly string[]): void {
  for (const name of names) {
    const input = INPUTS.find((i) => i.name === name);
    if (input === undefined) throw new Error(`unknown input ${name}`);
    const h = at(state);
    input.fire(h);
    expect(h.log, `${state} / ${name} must dispatch nothing`).toEqual([]);
    expect(h.state(), `${state} / ${name} must not change state`).toBe(state);
  }
}

describe("press predicates", () => {
  it("reads a secondary press and Ctrl+primary as a menu press", () => {
    expect(isMenuPress({ button: 2, ctrlKey: false })).toBe(true);
    expect(isMenuPress({ button: 0, ctrlKey: true })).toBe(true);
    expect(isMenuPress({ button: 0, ctrlKey: false })).toBe(false);
    expect(isMenuPress({ button: 1, ctrlKey: false })).toBe(false);
  });

  it("counts an unmodified primary press towards a double activation", () => {
    expect(activationCounts({ button: 0 })).toBe(true);
    expect(activationCounts({})).toBe(true); // fails open on an emitter that omits the field
    expect(activationCounts({ button: 2 })).toBe(false);
    expect(activationCounts({ button: 0, shiftKey: true })).toBe(false);
    expect(activationCounts({ button: 0, metaKey: true })).toBe(false);
  });
});

describe("idle", () => {
  it("arms the tooltip on a hover and enters hover", () => {
    const h = at("idle");
    h.arbiter.barHover(barHover(1));
    expect(h.log).toEqual(["tooltip.hover"]);
    expect(h.state()).toBe("hover");
  });

  it("selects, arms the drag and counts the activation on a bar press", () => {
    const h = at("idle");
    h.arbiter.barDown(barDown(7));
    expect(h.log).toEqual([
      "selection.barPress(7)",
      "dialog.press(bar:7,counts)",
      "drag.press(7)",
      "tooltip.press",
    ]);
    expect(h.state()).toBe("pressing");
  });

  it("major M1: passes the raw (numeric) task id alongside the string detector key on a bar press", () => {
    // `target` (`"bar:7"`) is only ever a detector pairing key; the id `editDialog` actually opens
    // with must survive as the number `7`, not get reconstructed (always as a string) from `target`.
    const h = at("idle");
    h.arbiter.barDown(barDown(7));
    expect(h.lastEditDialogId).toBe(7);
    expect(h.lastEditDialogId).not.toBe("7");
  });

  it("opens the menu on a menu press when the feature is composed", () => {
    const h = at("idle");
    h.menuEnabled = true;
    h.arbiter.barDown(barDown(7, { button: 2 }));
    // A press diverted to the menu still resets the double-activation detector, exactly like an
    // ordinary filtered press would.
    expect(h.log).toEqual(["dialog.press(bar:7,filtered)", "menu.openAtHit(7)"]);
    expect(h.state()).toBe("context");
  });

  it("resets the activation detector on a menu press for a non-bar hit too", () => {
    const h = at("idle");
    h.menuEnabled = true;
    h.arbiter.barDown(barDown(7, { button: 2, kind: "handle" }));
    expect(h.log).toEqual(["dialog.reset", "menu.openAtHit(7)"]);
    expect(h.state()).toBe("context");
  });

  it("stays idle (not context) and keeps hover/tooltip live when the menu resolution is empty", () => {
    // minor-1 fix: an empty resolution must not strand the machine in `context` under no menu.
    const h = at("idle");
    h.menuEnabled = true;
    h.menuOpens = false;
    h.arbiter.barDown(barDown(7, { button: 2 }));
    expect(h.log).toEqual(["dialog.press(bar:7,filtered)", "menu.openAtHit(7)"]);
    expect(h.state()).toBe("idle");
    h.clear();
    h.arbiter.barHover(barHover(7));
    expect(h.log).toEqual(["tooltip.hover"]);
    expect(h.state()).toBe("hover");
  });

  it("treats a menu press as an ordinary press without the feature", () => {
    const h = at("idle");
    h.arbiter.barDown(barDown(7, { button: 2 }));
    expect(h.state()).toBe("pressing");
    expect(h.log).toContain("selection.barPress(7)");
    // A secondary press never counts towards a double activation.
    expect(h.log).toContain("dialog.press(bar:7,filtered)");
  });

  it("arms no gesture and resets the activation counter for a non-bar hit kind", () => {
    const h = at("idle");
    h.arbiter.barDown(barDown(7, { kind: "link" }));
    expect(h.log).toEqual(["dialog.reset", "tooltip.press"]);
    expect(h.state()).toBe("pressing");
  });

  it("arms a gesture but does not select for a handle hit", () => {
    const h = at("idle");
    h.arbiter.barDown(barDown(7, { kind: "handle" }));
    expect(h.log).toEqual(["dialog.reset", "drag.press(7)", "tooltip.press"]);
  });

  it("ignores barMove and barUp", () => {
    expectIgnored("idle", ["pointer/barMove", "pointer/barUp"]);
  });

  it("places a click-move pick-up and stays idle on a background press in single mode", () => {
    const h = at("idle");
    h.arbiter.background(background());
    expect(h.log).toEqual(["tooltip.suppress", "selection.clearPending", "drag.background"]);
    expect(h.state()).toBe("idle");
  });

  it("also begins a rubber band on the same press in multi mode", () => {
    const h = at("idle");
    h.mode = "multi";
    h.arbiter.background(background({ x: 5, y: 6 }));
    expect(h.log).toEqual([
      "tooltip.suppress",
      "selection.clearPending",
      "drag.background",
      "selection.rubberBandBegin(5,6)",
    ]);
    expect(h.state()).toBe("rubber-band");
  });

  it("opens the menu with a background target on a menu press", () => {
    const h = at("idle");
    h.menuEnabled = true;
    h.arbiter.background(background({ button: 2 }));
    expect(h.log).toEqual(["menu.openAtBackground"]);
    expect(h.state()).toBe("context");
  });

  it("selects and arms the row drag on a grid press", () => {
    const h = at("idle");
    h.arbiter.gridPointerDown(gridDown(4));
    expect(h.log).toEqual(["selection.gridPress(4)", "drag.gridPress(4)", "dialog.press(row:4,counts)"]);
    expect(h.state()).toBe("pressing");
  });

  it("major M1: passes the raw (numeric) task id alongside the string detector key on a grid press", () => {
    const h = at("idle");
    h.arbiter.gridPointerDown(gridDown(4));
    expect(h.lastEditDialogId).toBe(4);
    expect(h.lastEditDialogId).not.toBe("4");
  });

  it("ignores grid moves and releases with no armed press", () => {
    expectIgnored("idle", ["grid/rowPointerMove", "grid/rowPointerUp"]);
  });

  it("opens the menu at a grid row and at the grid background", () => {
    const row = at("idle");
    row.arbiter.gridContextMenu(gridRowMenu(9));
    expect(row.log).toEqual(["selection.clearPending", "drag.clearPress", "menu.openAtRow(9)"]);
    expect(row.state()).toBe("context");

    const blank = at("idle");
    blank.arbiter.gridBackgroundContextMenu(gridBackgroundMenu());
    expect(blank.log).toEqual([
      "selection.clearPending",
      "drag.clearPress",
      "menu.openAtGridBackground",
    ]);
    expect(blank.state()).toBe("context");
  });

  it("drops to idle instead of context when a grid-row/background menu resolves nothing (minor-1)", () => {
    const row = at("idle");
    row.menuOpens = false;
    row.arbiter.gridContextMenu(gridRowMenu(9));
    expect(row.state()).toBe("idle");

    const blank = at("idle");
    blank.menuOpens = false;
    blank.arbiter.gridBackgroundContextMenu(gridBackgroundMenu());
    expect(blank.state()).toBe("idle");
  });

  it("forgets a pick-up and dismisses the tooltip on Escape, staying idle", () => {
    const h = at("idle");
    h.arbiter.escape();
    expect(h.log).toEqual(["drag.clearPress", "tooltip.dismiss"]);
    expect(h.state()).toBe("idle");
  });
});

describe("hover", () => {
  it("retargets the tooltip on another hover and stays in hover", () => {
    const h = at("hover");
    h.arbiter.barHover(barHover(2));
    expect(h.log).toEqual(["tooltip.hover"]);
    expect(h.state()).toBe("hover");
  });

  it("handles a press exactly as idle does", () => {
    const h = at("hover");
    h.arbiter.barDown(barDown(3));
    expect(h.log).toEqual([
      "selection.barPress(3)",
      "dialog.press(bar:3,counts)",
      "drag.press(3)",
      "tooltip.press",
    ]);
    expect(h.state()).toBe("pressing");
  });

  it("suppresses the tooltip and falls back to idle on a defensive barMove", () => {
    const h = at("hover");
    h.arbiter.barMove(barMove({ id: 1 }));
    expect(h.log).toEqual(["tooltip.suppress"]);
    expect(h.state()).toBe("idle");
  });

  it("ignores barUp", () => {
    expectIgnored("hover", ["pointer/barUp", "grid/rowPointerMove", "grid/rowPointerUp"]);
  });

  it("handles background, grid press and both menu requests as idle does", () => {
    const bg = at("hover");
    bg.arbiter.background(background());
    expect(bg.state()).toBe("idle");
    expect(bg.log).toContain("drag.background");

    const grid = at("hover");
    grid.arbiter.gridPointerDown(gridDown(4));
    expect(grid.state()).toBe("pressing");

    const row = at("hover");
    row.arbiter.gridContextMenu(gridRowMenu(4));
    expect(row.state()).toBe("context");

    const blank = at("hover");
    blank.arbiter.gridBackgroundContextMenu(gridBackgroundMenu());
    expect(blank.state()).toBe("context");
  });

  it("dismisses the tooltip on Escape and stays put", () => {
    const h = at("hover");
    h.arbiter.escape();
    expect(h.log).toEqual(["drag.clearPress", "tooltip.dismiss"]);
    expect(h.state()).toBe("hover");
  });
});

describe("pressing", () => {
  it("ignores a hover sample and a second press", () => {
    expectIgnored("pressing", ["pointer/barHover", "pointer/barDown"]);
  });

  it("abandons on a move with no buttons held, before any threshold test", () => {
    const h = at("pressing");
    h.axis = "bar";
    h.arbiter.barMove(barMove({ id: 1, buttons: 0, clientX: 50 }));
    expect(h.log).toEqual(["drag.cancel", "selection.clearPending"]);
    expect(h.state()).toBe("idle");
  });

  it("holds while the drag module reports no axis yet", () => {
    const h = at("pressing");
    h.arbiter.barMove(barMove({ id: 1, clientX: 2 }));
    expect(h.log).toEqual(["selection.pointerMove", "drag.pressMove"]);
    expect(h.state()).toBe("pressing");
  });

  it.each([
    ["bar", "dragging-bar"],
    ["row", "dragging-row"],
    ["lane", "dragging-lane"],
  ] as const)("enters %s past the threshold", (axis, expected) => {
    const h = at("pressing");
    h.axis = axis;
    h.arbiter.barMove(barMove({ id: 1, clientX: 20 }));
    expect(h.log).toEqual(["selection.pointerMove", "drag.pressMove", "tooltip.suppress"]);
    expect(h.state()).toBe(expected);
  });

  it("resolves the click on a release", () => {
    const h = at("pressing");
    h.arbiter.barUp(barUp({ id: 1 }));
    expect(h.log).toEqual(["selection.pointerUp", "drag.up"]);
    expect(h.state()).toBe("idle");
  });

  it("ignores a background press and a second grid press", () => {
    expectIgnored("pressing", ["pointer/background", "grid/rowPointerDown"]);
  });

  it("ignores a grid move that belongs to no grid press", () => {
    const h = at("pressing");
    h.gridAxis = "row";
    h.arbiter.gridPointerMove(gridMove());
    expect(h.log).toEqual([]);
    expect(h.state()).toBe("pressing");
  });

  it("starts a row drag from a grid press that travels", () => {
    const h = harness();
    h.arbiter.gridPointerDown(gridDown(1));
    h.clear();
    h.gridAxis = "row";
    h.arbiter.gridPointerMove(gridMove({ clientY: 20 }));
    expect(h.log).toEqual(["drag.gridPressMove"]);
    expect(h.state()).toBe("dragging-row");
  });

  it("stays pressing while a grid press has not travelled far enough", () => {
    const h = harness();
    h.arbiter.gridPointerDown(gridDown(1));
    h.clear();
    h.arbiter.gridPointerMove(gridMove({ clientY: 1 }));
    expect(h.log).toEqual(["drag.gridPressMove"]);
    expect(h.state()).toBe("pressing");
  });

  it("clears a grid press on its release", () => {
    const h = harness();
    h.arbiter.gridPointerDown(gridDown(1));
    h.clear();
    h.arbiter.gridPointerUp(gridUp());
    expect(h.log).toEqual(["drag.gridUp"]);
    expect(h.state()).toBe("idle");
  });

  it("drops the press bookkeeping when a menu request arrives", () => {
    const row = at("pressing");
    row.arbiter.gridContextMenu(gridRowMenu(5));
    expect(row.log).toEqual(["selection.clearPending", "drag.clearPress", "menu.openAtRow(5)"]);
    expect(row.state()).toBe("context");

    const blank = at("pressing");
    blank.arbiter.gridBackgroundContextMenu(gridBackgroundMenu());
    expect(blank.state()).toBe("context");
  });

  it("drops everything on Escape without dispatching an edit", () => {
    const h = at("pressing");
    h.arbiter.escape();
    expect(h.log).toEqual([
      "drag.cancel",
      "drag.clearPress",
      "selection.clearPending",
      "tooltip.dismiss",
    ]);
    expect(h.state()).toBe("idle");
  });
});

describe("dragging-bar", () => {
  it("ignores hover, a second press and every grid input", () => {
    expectIgnored("dragging-bar", [
      "pointer/barHover",
      "pointer/barDown",
      "pointer/background",
      "grid/rowPointerDown",
      "grid/rowPointerMove",
      "grid/rowPointerUp",
      "grid/rowContextMenu",
      "grid/backgroundContextMenu",
    ]);
  });

  it("advances on its own pointer's move", () => {
    const h = at("dragging-bar");
    h.arbiter.barMove(barMove({ id: 1, clientX: 30 }));
    expect(h.log).toEqual(["drag.dragMove"]);
    expect(h.state()).toBe("dragging-bar");
  });

  it("ignores another pointer's move and release", () => {
    const h = at("dragging-bar");
    h.arbiter.barMove(barMove({ id: 1, pointerId: 9, clientX: 30 }));
    h.arbiter.barUp(barUp({ id: 1, pointerId: 9 }));
    expect(h.log).toEqual([]);
    expect(h.state()).toBe("dragging-bar");
  });

  it("abandons when the buttons are released outside the window", () => {
    const h = at("dragging-bar");
    h.arbiter.barMove(barMove({ id: 1, buttons: 0, clientX: 30 }));
    expect(h.log).toEqual(["drag.cancel", "selection.clearPending"]);
    expect(h.state()).toBe("idle");
  });

  it("commits on its own pointer's release", () => {
    const h = at("dragging-bar");
    h.arbiter.barUp(barUp({ id: 1 }));
    expect(h.log).toEqual(["drag.up"]);
    expect(h.state()).toBe("idle");
  });

  it("abandons on Escape", () => {
    const h = at("dragging-bar");
    h.arbiter.escape();
    expect(h.log).toEqual(["drag.cancel", "drag.clearPress", "tooltip.dismiss"]);
    expect(h.state()).toBe("idle");
  });
});

describe("dragging-row", () => {
  it("ignores everything but its own move and release", () => {
    expectIgnored("dragging-row", [
      "pointer/barHover",
      "pointer/barDown",
      "pointer/background",
      "grid/rowPointerDown",
      "grid/rowContextMenu",
      "grid/backgroundContextMenu",
    ]);
  });

  it("advances a bar-originated row drag on the pointer stream", () => {
    const h = at("dragging-row");
    h.arbiter.barMove(barMove({ id: 1, clientY: 40 }));
    expect(h.log).toEqual(["drag.dragMove"]);
    expect(h.state()).toBe("dragging-row");
  });

  it("ignores the grid's move stream for a bar-originated row drag", () => {
    const h = at("dragging-row");
    h.arbiter.gridPointerMove(gridMove({ y: 40 }));
    h.arbiter.gridPointerUp(gridUp());
    expect(h.log).toEqual([]);
    expect(h.state()).toBe("dragging-row");
  });

  it("advances a grid-originated row drag on the grid's own stream", () => {
    const h = gridRowDrag();
    h.arbiter.gridPointerMove(gridMove({ y: 60 }));
    expect(h.log).toEqual(["drag.gridDragMove"]);
    expect(h.state()).toBe("dragging-row");

    h.clear();
    h.arbiter.gridPointerUp(gridUp({ y: 60 }));
    expect(h.log).toEqual(["drag.gridUp"]);
    expect(h.state()).toBe("idle");
  });

  it("ignores the pointer stream for a grid-originated row drag", () => {
    const h = gridRowDrag();
    h.arbiter.barMove(barMove({ id: 1, clientY: 40 }));
    h.arbiter.barUp(barUp({ id: 1 }));
    expect(h.log).toEqual([]);
    expect(h.state()).toBe("dragging-row");
  });

  it("commits a bar-originated row drop on its release", () => {
    const h = at("dragging-row");
    h.arbiter.barUp(barUp({ id: 1 }));
    expect(h.log).toEqual(["drag.up"]);
    expect(h.state()).toBe("idle");
  });

  it("abandons on Escape, dropping a grid press that had not become a drag", () => {
    const h = at("dragging-row");
    h.arbiter.escape();
    expect(h.log).toEqual(["drag.cancel", "drag.clearPress", "tooltip.dismiss"]);
    expect(h.state()).toBe("idle");
  });
});

describe("dragging-lane", () => {
  it("ignores everything but its own move and release", () => {
    expectIgnored("dragging-lane", [
      "pointer/barHover",
      "pointer/barDown",
      "pointer/background",
      "grid/rowPointerDown",
      "grid/rowPointerMove",
      "grid/rowPointerUp",
      "grid/rowContextMenu",
      "grid/backgroundContextMenu",
    ]);
  });

  it("advances and commits on its own pointer", () => {
    const h = at("dragging-lane");
    h.arbiter.barMove(barMove({ id: 1, clientY: 60 }));
    expect(h.log).toEqual(["drag.dragMove"]);
    h.clear();
    h.arbiter.barUp(barUp({ id: 1 }));
    expect(h.log).toEqual(["drag.up"]);
    expect(h.state()).toBe("idle");
  });

  it("abandons on a lost button and on Escape", () => {
    const lost = at("dragging-lane");
    lost.arbiter.barMove(barMove({ id: 1, buttons: 0 }));
    expect(lost.log).toEqual(["drag.cancel", "selection.clearPending"]);
    expect(lost.state()).toBe("idle");

    const escaped = at("dragging-lane");
    escaped.arbiter.escape();
    expect(escaped.log).toEqual(["drag.cancel", "drag.clearPress", "tooltip.dismiss"]);
    expect(escaped.state()).toBe("idle");
  });
});

describe("rubber-band", () => {
  it("ignores every input but the background gesture's own move and release", () => {
    expectIgnored("rubber-band", [
      "pointer/barHover",
      "pointer/barDown",
      "pointer/background",
      "grid/rowPointerDown",
      "grid/rowPointerMove",
      "grid/rowPointerUp",
      "grid/rowContextMenu",
      "grid/backgroundContextMenu",
    ]);
  });

  it("extends the rectangle on a hitless move and ignores one carrying a hit", () => {
    const h = at("rubber-band");
    h.arbiter.barMove(barMove({ x: 40, y: 50 }));
    expect(h.log).toEqual(["selection.rubberBandMove(40,50)"]);

    h.clear();
    h.arbiter.barMove(barMove({ id: 3, x: 60, y: 70 }));
    expect(h.log).toEqual([]);
    expect(h.state()).toBe("rubber-band");
  });

  it("finalizes on the release's own coordinates", () => {
    const h = at("rubber-band");
    h.arbiter.barUp(barUp({ x: 80, y: 90 }));
    expect(h.log).toEqual(["selection.rubberBandEnd(80,90,release)"]);
    expect(h.state()).toBe("idle");
  });

  it("abandons a cancelled capture", () => {
    const h = at("rubber-band");
    h.arbiter.barUp(barUp({ x: 80, y: 90, type: "pointercancel" }));
    expect(h.log).toEqual(["selection.rubberBandEnd(80,90,cancelled)"]);
    expect(h.state()).toBe("idle");
  });

  it("ignores a release carrying a hit", () => {
    const h = at("rubber-band");
    h.arbiter.barUp(barUp({ id: 2 }));
    expect(h.log).toEqual([]);
    expect(h.state()).toBe("rubber-band");
  });

  it("abandons on Escape exactly as a cancelled capture does", () => {
    const h = at("rubber-band");
    h.bandInFlight = true;
    h.arbiter.escape();
    expect(h.log).toEqual([
      "selection.rubberBandCancel",
      "selection.clearPending",
      "tooltip.dismiss",
    ]);
    expect(h.state()).toBe("idle");
    // The eventual release finds no gesture and is a no-op.
    h.clear();
    h.arbiter.barUp(barUp({ x: 10, y: 10 }));
    expect(h.log).toEqual([]);
  });
});

describe("context", () => {
  it("ignores a hover and a release", () => {
    expectIgnored("context", ["pointer/barHover", "pointer/barUp"]);
  });

  it("closes and re-processes a bar press as from idle", () => {
    const h = at("context");
    h.arbiter.barDown(barDown(8));
    expect(h.log).toEqual([
      "menu.close",
      "selection.barPress(8)",
      "dialog.press(bar:8,counts)",
      "drag.press(8)",
      "tooltip.press",
    ]);
    expect(h.state()).toBe("pressing");
  });

  it("closes and re-opens on another menu press", () => {
    const h = at("context");
    h.arbiter.barDown(barDown(8, { button: 2 }));
    expect(h.log).toEqual(["menu.close", "dialog.press(bar:8,filtered)", "menu.openAtHit(8)"]);
    expect(h.state()).toBe("context");
  });

  it("closes and falls back to idle when the re-open resolves nothing", () => {
    const h = at("context");
    h.menuOpens = false;
    h.arbiter.barDown(barDown(8, { button: 2 }));
    expect(h.log).toEqual(["menu.close", "dialog.press(bar:8,filtered)", "menu.openAtHit(8)"]);
    expect(h.state()).toBe("idle");
  });

  it("closes on a pointer move, because the anchor is about to move", () => {
    const h = at("context");
    h.arbiter.barMove(barMove({ id: 1 }));
    expect(h.log).toEqual(["menu.close"]);
    expect(h.state()).toBe("idle");
  });

  it("closes and re-processes a background press", () => {
    const h = at("context");
    h.arbiter.background(background());
    expect(h.log).toEqual([
      "menu.close",
      "tooltip.suppress",
      "selection.clearPending",
      "drag.background",
    ]);
    expect(h.state()).toBe("idle");
  });

  it("keeps the menu open on a grid press while still applying it", () => {
    const h = at("context");
    h.arbiter.gridPointerDown(gridDown(6));
    expect(h.log).toEqual([
      "selection.gridPress(6)",
      "drag.gridPress(6)",
      "dialog.press(row:6,counts)",
    ]);
    expect(h.state()).toBe("context");
  });

  it("ignores grid moves and releases", () => {
    expectIgnored("context", ["grid/rowPointerMove", "grid/rowPointerUp"]);
  });

  it("closes and re-opens for both grid menu requests", () => {
    const row = at("context");
    row.arbiter.gridContextMenu(gridRowMenu(2));
    expect(row.log).toEqual(["menu.close", "menu.openAtRow(2)"]);
    expect(row.state()).toBe("context");

    const blank = at("context");
    blank.arbiter.gridBackgroundContextMenu(gridBackgroundMenu());
    expect(blank.log).toEqual(["menu.close", "menu.openAtGridBackground"]);
    expect(blank.state()).toBe("context");
  });

  it("closes on Escape and returns to idle", () => {
    const h = at("context");
    h.arbiter.escape();
    expect(h.log).toEqual(["menu.close", "drag.clearPress", "tooltip.dismiss"]);
    expect(h.state()).toBe("idle");
  });

  it("returns to idle when the menu widget closed itself", () => {
    const h = at("context");
    h.arbiter.menuClosed();
    expect(h.log).toEqual([]);
    expect(h.state()).toBe("idle");
  });

  it("ignores a self-close report outside the context state", () => {
    const h = at("pressing");
    h.arbiter.menuClosed();
    expect(h.state()).toBe("pressing");
  });
});

describe("link-drag (reserved)", () => {
  it("is unreachable: a port or link hit falls through the idle press row", () => {
    for (const kind of ["link", "port-start", "port-end", "third-party"]) {
      const h = at("idle");
      h.arbiter.barDown(barDown(1, { kind }));
      expect(h.state()).toBe("pressing");
      expect(h.log).not.toContain("drag.press(1)");
    }
  });
});
