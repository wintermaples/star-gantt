// @vitest-environment happy-dom
// docs/specs/plugins/a11y.md § Focus follows the pointer.
/**
 * The one subscriber-order assumption this plugin makes, pinned.
 *
 * On `grid/rowPointerDown` the plugin places the roving focus on the pressed row and deliberately
 * does **not** touch the selection (the `"pointer"` focus cause), because `stargantt.selection` has
 * *already* applied the press's own selection semantics — Ctrl toggles, Shift ranges. That ordering
 * holds only because the selection provider is registered (and so set up) before this plugin; the
 * event bus itself has no priorities. A composition-order change that reversed the two would
 * silently make a Ctrl- or Shift-click on a grid row collapse to a single-row selection, with no
 * other test failing — hence this file.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { TaskId } from "@stargantt/plugin-data-store";
import { boot, flatTasks, probe } from "./_boot";
import type { Booted } from "./_boot";

let booted: Booted | undefined;

afterEach(() => {
  booted?.dispose();
  booted = undefined;
});

/** Boots with a probe able to emit `grid/rowPointerDown` for any button. */
function bootWithPress(): { b: Booted; press: (id: TaskId, button?: number) => void } {
  let emit: ((id: TaskId, button: number) => void) | undefined;
  const b = boot({
    tasks: flatTasks(3),
    selectionMode: "multi",
    plugins: [
      probe((ctx) => {
        emit = (id, button) =>
          ctx.emit("grid/rowPointerDown", {
            id,
            row: 0,
            ctrlKey: false,
            metaKey: false,
            shiftKey: false,
            button,
            pointerId: 0,
            x: 0,
            y: 0,
            clientX: 0,
            clientY: 0,
          });
      }),
    ],
  });
  booted = b;
  b.flushFrames();
  return {
    b,
    press: (id, button = 0) => {
      if (emit === undefined) throw new Error("the probe never ran");
      emit(id, button);
    },
  };
}

describe("grid/rowPointerDown subscriber order", () => {
  it("lets the selection provider handle the press before this plugin moves the focus", () => {
    const { b, press } = bootWithPress();
    const order = b.selection?.pointerLog ?? [];
    // Registered after boot, so it fires once this plugin's own handler has run.
    b.focus.state.subscribe(() => order.push("focus"));
    press("t1");
    // If this ever reads ["focus", "selection"], the composition order changed and the pointer
    // focus placement now runs before the selection semantics it relies on.
    expect(order).toEqual(["selection", "focus"]);
  });

  it("places the focus on the pressed row without re-selecting it", () => {
    const { b, press } = bootWithPress();
    press("t2");
    expect(b.focus.state.get().focused).toBe("t2");
    // Whatever the press selected is the selection plugin's business; this plugin made no
    // `select()` call of its own.
    expect(b.selection?.selections).toEqual([]);
  });

  it("ignores a press on a row that is not in the current row order", () => {
    const { b, press } = bootWithPress();
    press("nope");
    expect(b.focus.state.get().focused).toBeUndefined();
  });

  it("does not move the focus for a secondary-button row press", () => {
    const { b, press } = bootWithPress();
    press("t2", 2);
    expect(b.focus.state.get().focused).toBeUndefined();
  });
});

/** Boots with a probe able to emit `pointer/barDown` for any hit kind and button. */
function bootWithBarPress(): {
  b: Booted;
  press: (id: TaskId, options?: { button?: number; kind?: string }) => void;
} {
  let emit: ((id: TaskId, button: number, kind: string) => void) | undefined;
  const b = boot({
    tasks: flatTasks(3),
    plugins: [
      probe((ctx) => {
        emit = (id, button, kind) =>
          ctx.emit("pointer/barDown", {
            hit: { kind, id, cursor: "pointer" },
            x: 0,
            y: 0,
            event: { button } as unknown as PointerEvent,
          });
      }),
    ],
  });
  booted = b;
  b.flushFrames();
  return {
    b,
    press: (id, options = {}) => {
      if (emit === undefined) throw new Error("the probe never ran");
      emit(id, options.button ?? 0, options.kind ?? "bar");
    },
  };
}

describe("pointer/barDown focus follows only a primary press on the bar body", () => {
  it("places the roving focus on the pressed row for a primary-button bar press", () => {
    const { b, press } = bootWithBarPress();
    press("t2");
    expect(b.focus.state.get().focused).toBe("t2");
  });

  it("does not move the focus for a secondary-button bar press", () => {
    const { b, press } = bootWithBarPress();
    press("t2", { button: 2 });
    expect(b.focus.state.get().focused).toBeUndefined();
  });

  // A press on a resize handle or the progress strip is the start of an edit gesture, not a focus
  // placement.
  it("does not move the focus for a handle or progress hit", () => {
    const { b, press } = bootWithBarPress();
    press("t2", { kind: "handle" });
    press("t2", { kind: "progress" });
    expect(b.focus.state.get().focused).toBeUndefined();
  });
});
