// @vitest-environment happy-dom
// docs/specs/plugins/a11y.md § Dependencies — "Degradation semantics without `stargantt.selection`".
/**
 * A composition without the interaction plugin (or any other provider of `stargantt.selection`).
 * Every clause of the spec's degradation list is one test here: the multi chords report inactive,
 * `syncSelection` has nothing to sync, neither selection attribute is ever written, no
 * `selectionCount` is spoken — and everything else works unchanged.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { TaskId } from "@stargantt/plugin-data-store";
import { boot, flatTasks, treeTasks } from "./_boot";
import type { Booted } from "./_boot";

let booted: Booted | undefined;

afterEach(() => {
  booted?.dispose();
  booted = undefined;
});

function standalone(options: Parameters<typeof boot>[0] = {}): Booted {
  const b = boot({ tasks: flatTasks(5), selection: false, ...options });
  booted = b;
  b.flushFrames();
  return b;
}

function focused(b: Booted): TaskId | undefined {
  return b.focus.state.get().focused;
}

describe("without a composed selection service", () => {
  it("composes at all, with no error reported", () => {
    const b = standalone();
    expect(b.selection).toBeUndefined();
    expect(b.faults).toEqual([]);
    expect(b.mirror.getAttribute("role")).toBe("treegrid");
  });

  it("leaves the multi-selection chords inactive, so the keystrokes fall through", () => {
    const b = standalone();
    expect(b.key("ArrowDown", { shift: true })).toBe(false);
    expect(b.key("ArrowUp", { shift: true })).toBe(false);
    expect(b.key(" ", { ctrl: true })).toBe(false);
    expect(focused(b)).toBeUndefined();
  });

  it("lets another contribution win a chord the inactive multi chords would have claimed", () => {
    const seen: string[] = [];
    const b = boot({
      tasks: flatTasks(3),
      selection: false,
      plugins: [
        {
          meta: { id: "test.shift" },
          setup: (ctx) => {
            ctx.contribute("keys/bindings", { key: "Ctrl+Space", run: () => seen.push("other") });
          },
        },
      ],
    });
    booted = b;
    b.flushFrames();
    expect(b.key(" ", { ctrl: true })).toBe(true);
    expect(seen).toEqual(["other"]);
  });

  it("moves only the focus on a plain arrow, exactly as with syncSelection: false", () => {
    const b = standalone();
    b.key("ArrowDown");
    expect(focused(b)).toBe("t1");
    expect(b.faults).toEqual([]);
  });

  it("never sets aria-multiselectable on the treegrid", () => {
    expect(standalone().mirror.getAttribute("aria-multiselectable")).toBeNull();
  });

  it("never sets aria-selected on a mirror row", () => {
    const b = standalone();
    for (const row of b.rows()) expect(row.getAttribute("aria-selected")).toBeNull();
    b.key("ArrowDown");
    b.flushFrames();
    for (const row of b.rows()) expect(row.getAttribute("aria-selected")).toBeNull();
  });

  it("never speaks a selectionCount announcement", () => {
    const b = standalone();
    b.key("ArrowDown", { shift: true });
    b.key(" ", { ctrl: true });
    expect(b.live.textContent).toBe("");
  });

  it("keeps focus navigation, the roving tabindex and the grid push working", () => {
    const b = standalone();
    b.key("ArrowDown");
    b.key("ArrowDown");
    expect(focused(b)).toBe("t2");
    const focusable = b.rows().filter((r) => r.getAttribute("tabindex") === "0");
    expect(focusable.length).toBe(1);
    expect(focusable[0]?.getAttribute("aria-rowindex")).toBe("3");
    expect(b.grid.focused()).toBe("t2");
  });

  it("keeps announce(), expand/collapse and Enter-to-edit working", () => {
    const b = standalone({ tasks: treeTasks() });
    b.focus.announce("hello");
    expect(b.live.textContent).toBe("hello");
    b.key("-");
    b.flushFrames();
    expect(b.live.textContent).toBe("a, collapsed");
    b.key("Enter");
    expect(b.grid.editStarts).toEqual(["a"]);
  });

  it("keeps the opt-in features working", () => {
    const b = standalone({
      tasks: flatTasks(3),
      config: { shortcutHelp: true, summaryTable: true, zoomKeys: true },
    });
    expect(b.key("?", { shift: true })).toBe(true);
    expect(b.root.querySelector(".sg-a11y-help")).not.toBeNull();
    b.key("Escape");
    expect(b.key("s", { ctrl: true, alt: true })).toBe(true);
    expect(b.root.querySelector(".sg-a11y-summary")).not.toBeNull();
    b.key("Escape");
    expect(b.key("+")).toBe(true);
    expect(b.view.zoomSteps).toEqual(["in"]);
  });

  it("keeps the focus box painting", () => {
    const b = standalone();
    b.bars.setBox("t0", { x: 10, y: 20, width: 100, height: 16 });
    b.focus.focus("t0");
    expect(b.drawFocusLayer().strokes.length).toBe(1);
  });
});
