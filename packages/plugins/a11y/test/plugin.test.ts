// @vitest-environment happy-dom
// docs/specs/plugins/a11y.md — the plugin wired into a real core, over the recording stubs.
import { afterEach, describe, expect, it } from "vitest";
import type { AnyPlugin } from "@stargantt/core";
import type { Task, TaskId } from "@stargantt/plugin-data-store";
import { a11y } from "../src/index";
import type { A11yConfig } from "../src/index";
import { boot, flatTasks, probe, treeTasks } from "./_boot";
import type { Booted } from "./_boot";

let booted: Booted | undefined;

afterEach(() => {
  booted?.dispose();
  booted = undefined;
});

/** Boots with `tasks` already in the store and the first mirror render done. */
function withTasks(tasks: readonly Task[], options: Parameters<typeof boot>[0] = {}): Booted {
  const b = boot({ tasks, ...options });
  booted = b;
  b.flushFrames();
  return b;
}

function open(options: Parameters<typeof boot>[0] = {}): Booted {
  const b = boot(options);
  booted = b;
  b.flushFrames();
  return b;
}

function rowIndexes(rows: HTMLElement[]): number[] {
  return rows.map((r) => Number(r.getAttribute("aria-rowindex")));
}

/** The task the roving focus sits on, read through the public store. */
function focused(b: Booted): TaskId | undefined {
  return b.focus.state.get().focused;
}

describe("the parallel ARIA DOM", () => {
  it("mounts a treegrid and a polite live region under the gantt root", () => {
    const b = withTasks(flatTasks(3));
    expect(b.mirror.getAttribute("role")).toBe("treegrid");
    expect(b.live.getAttribute("aria-live")).toBe("polite");
    expect(b.live.getAttribute("aria-atomic")).toBe("true");
    // Present for screen readers, but out of sight.
    expect(b.mirror.style.position).toBe("absolute");
    expect(b.mirror.getAttribute("aria-hidden")).toBeNull();
  });

  // An unnamed grid is announced as a bare "treegrid", which on a page carrying several widgets
  // says nothing about which one the focus has landed in.
  it("gives the grid an accessible name", () => {
    expect(withTasks(flatTasks(3)).mirror.getAttribute("aria-label")).toBe("Gantt chart");
  });

  describe("`label`", () => {
    it("names the grid as configured", () => {
      expect(open({ config: { label: "Release plan" } }).mirror.getAttribute("aria-label")).toBe(
        "Release plan",
      );
    });

    it("falls back to the default for a blank label", () => {
      expect(open({ config: { label: "   " } }).mirror.getAttribute("aria-label")).toBe("Gantt chart");
    });

    it("falls back to the default for an empty label", () => {
      expect(open({ config: { label: "" } }).mirror.getAttribute("aria-label")).toBe("Gantt chart");
    });
  });

  it("is a factory producing a fresh plugin per call", () => {
    const one = a11y();
    const other = a11y({ label: "x" });
    expect(typeof a11y).toBe("function");
    expect(one).not.toBe(other);
    expect(one.meta.id).toBe("stargantt.a11y");
  });

  it("materializes only the visible row range while reporting the full count", () => {
    const b = withTasks(flatTasks(500));
    expect(b.mirror.getAttribute("aria-rowcount")).toBe("500");
    const rows = b.rows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(500);
  });

  it("numbers rows with their absolute 1-based position", () => {
    expect(rowIndexes(withTasks(flatTasks(50)).rows()).slice(0, 3)).toEqual([1, 2, 3]);
  });

  it("speaks the task name, period and progress", () => {
    const b = withTasks([
      { id: "t0", parentId: null, name: "design", start: 0, end: 86_400_000, progress: 0.25 },
    ]);
    const text = b.rows()[0]?.textContent ?? "";
    expect(text).toContain("design");
    expect(text).toContain("1970-01-01 – 1970-01-02");
    expect(text).toContain("25%");
  });

  it("omits progress from rows that carry none", () => {
    expect(withTasks(flatTasks(1)).rows()[0]?.textContent ?? "").not.toContain("%");
  });

  it("puts exactly one gridcell in each row", () => {
    const b = withTasks(flatTasks(3));
    for (const row of b.rows()) {
      const cells = row.querySelectorAll("[role='gridcell']");
      expect(cells.length).toBe(1);
    }
    expect(b.mirror.querySelectorAll("[role='columnheader']").length).toBe(0);
    expect(b.mirror.getAttribute("aria-colcount")).toBeNull();
  });

  it("reports depth and expanded state", () => {
    const b = withTasks(treeTasks());
    const [parent, child] = b.rows();
    expect(parent?.getAttribute("aria-level")).toBe("1");
    expect(parent?.getAttribute("aria-expanded")).toBe("true");
    expect(child?.getAttribute("aria-level")).toBe("2");
    // A leaf is not expandable, so it carries no `aria-expanded` at all.
    expect(child?.getAttribute("aria-expanded")).toBeNull();
  });

  it("keeps exactly one row in the tab order", () => {
    const b = withTasks(flatTasks(10));
    const focusable = b.rows().filter((r) => r.getAttribute("tabindex") === "0");
    expect(focusable.length).toBe(1);
    expect(focusable[0]?.getAttribute("aria-rowindex")).toBe("1");
  });

  it("re-renders when the data changes", () => {
    const b = withTasks(flatTasks(2));
    expect(b.mirror.getAttribute("aria-rowcount")).toBe("2");
    b.data.setTasks(flatTasks(7));
    b.flushFrames();
    expect(b.mirror.getAttribute("aria-rowcount")).toBe("7");
  });
});

describe("keyboard navigation", () => {
  it("moves the roving focus with the arrow keys", () => {
    const b = withTasks(flatTasks(5));
    expect(focused(b)).toBeUndefined(); // the row-0 fallback is not a placement
    expect(b.key("ArrowDown")).toBe(true);
    expect(focused(b)).toBe("t1");
    b.key("ArrowDown");
    b.key("ArrowUp");
    expect(focused(b)).toBe("t1");
  });

  it("stops at the ends of the row list", () => {
    const b = withTasks(flatTasks(2));
    b.key("ArrowUp");
    expect(focused(b)).toBe("t0");
    b.key("ArrowDown");
    b.key("ArrowDown");
    b.key("ArrowDown");
    expect(focused(b)).toBe("t1");
  });

  it("jumps to the first and last reachable rows with Home and End", () => {
    const b = withTasks(flatTasks(30));
    expect(b.key("End")).toBe(true);
    expect(focused(b)).toBe("t29");
    b.flushFrames();
    // The end of the list is scrolled into view, so the mirrored window holds it.
    expect(b.rows().some((r) => r.getAttribute("aria-rowindex") === "30")).toBe(true);
    expect(b.key("Home")).toBe(true);
    expect(focused(b)).toBe("t0");
  });

  it("expands with ArrowRight and enters the first child of an expanded row", () => {
    const b = withTasks(treeTasks());
    b.focus.focus("a");
    b.key("ArrowLeft"); // collapse first
    b.flushFrames();
    expect(b.rows().length).toBe(2);
    expect(b.key("ArrowRight")).toBe(true);
    b.flushFrames();
    expect(b.rows().length).toBe(4);
    // A second press moves into the first child instead of toggling again.
    b.key("ArrowRight");
    expect(focused(b)).toBe("a1");
  });

  it("collapses with ArrowLeft and otherwise moves to the parent row", () => {
    const b = withTasks(treeTasks());
    b.focus.focus("a1");
    b.key("ArrowLeft"); // a leaf: move to the parent
    expect(focused(b)).toBe("a");
    expect(b.key("ArrowLeft")).toBe(true); // an expanded parent: collapse
    b.flushFrames();
    expect(b.rows().length).toBe(2);
    // A top-level leaf is a no-op on both counts.
    b.focus.focus("b");
    b.key("ArrowLeft");
    expect(focused(b)).toBe("b");
  });

  it("selects the focused task so the chart shows where the focus is", () => {
    const b = withTasks(flatTasks(3));
    b.key("ArrowDown");
    expect(b.selection?.selections.at(-1)).toEqual(["t1"]);
  });

  it("scrolls the mirrored window along with the focus", () => {
    const b = withTasks(flatTasks(500));
    const first = rowIndexes(b.rows())[0];
    for (let i = 0; i < 40; i += 1) b.key("ArrowDown");
    b.flushFrames();
    const indexes = rowIndexes(b.rows());
    expect(indexes[0]).toBeGreaterThan(first ?? 0);
    expect(indexes).toContain(41);
    expect(b.rows().length).toBeLessThan(500);
  });

  it("expands and collapses the focused row with + and -", () => {
    const b = withTasks(treeTasks());
    expect(b.rows().length).toBe(4);
    b.key("-");
    b.flushFrames();
    expect(b.rows().length).toBe(2);
    b.key("+");
    b.flushFrames();
    expect(b.rows().length).toBe(4);
  });

  it("announces the new expanded state of the focused row", () => {
    const b = withTasks(treeTasks());
    b.key("-");
    b.flushFrames();
    expect(b.live.textContent).toBe("a, collapsed");
    b.key("+");
    b.flushFrames();
    expect(b.live.textContent).toBe("a, expanded");
  });

  it("says nothing when the focused row has no children to expand", () => {
    const b = withTasks(flatTasks(3));
    b.key("-");
    b.flushFrames();
    expect(b.live.textContent).toBe("");
  });

  it("starts editing the focused row with Enter", () => {
    const b = withTasks(flatTasks(3));
    b.key("ArrowDown");
    expect(b.key("Enter")).toBe(true);
    expect(b.grid.editStarts).toEqual(["t1"]);
  });

  it("claims Enter but does nothing while no row is focused", () => {
    const b = open({ tasks: [] });
    expect(focused(b)).toBeUndefined();
    expect(b.key("Enter")).toBe(true);
    expect(b.grid.editStarts).toEqual([]);
  });

  it("leaves keys typed into an editor alone", () => {
    const b = withTasks(flatTasks(3));
    const input = b.doc.createElement("input");
    b.root.appendChild(input);
    expect(b.key("ArrowDown", {}, input)).toBe(false);
    expect(focused(b)).toBeUndefined();
  });

  it("passes unclaimed keys through", () => {
    expect(withTasks(flatTasks(3)).key("q")).toBe(false);
  });

  // A keystroke another handler already claimed (its `defaultPrevented` set on the way up, e.g. the
  // context menu's own roving arrows) is not re-dispatched into the chart bindings.
  it("does not move focus for a keystroke whose default is already prevented", () => {
    const b = withTasks(flatTasks(3));
    const event = new globalThis.KeyboardEvent("keydown", {
      key: "ArrowDown",
      bubbles: true,
      cancelable: true,
    });
    event.preventDefault();
    b.root.dispatchEvent(event);
    expect(focused(b)).toBeUndefined();
  });
});

describe("the keys/bindings extension point", () => {
  it("delivers contributions made before the point was defined", () => {
    const seen: string[] = [];
    const b = open({
      plugins: [
        probe((ctx) => {
          ctx.contribute("keys/bindings", { key: "Ctrl+Z", run: () => seen.push("undo") });
        }),
      ],
    });
    expect(b.key("z", { ctrl: true })).toBe(true);
    expect(seen).toEqual(["undo"]);
  });

  it("lets the last contribution win a chord", () => {
    const seen: string[] = [];
    const late: AnyPlugin = probe(
      (ctx) => {
        ctx.contribute("keys/bindings", { key: "ArrowDown", run: () => seen.push("late") });
      },
      "test.late",
      ["stargantt.a11y"],
    );
    const b = withTasks(flatTasks(3), { plugins: [late] });
    b.key("ArrowDown");
    expect(seen).toEqual(["late"]);
    // The built-in ArrowDown binding was overridden, so the focus stayed put.
    expect(focused(b)).toBeUndefined();
  });

  it("reports a throwing binding instead of letting it escape", () => {
    const b = open({
      plugins: [
        probe((ctx) => {
          ctx.contribute("keys/bindings", {
            key: "Ctrl+K",
            run: () => {
              throw new Error("boom");
            },
          });
        }),
      ],
    });
    expect(() => b.key("k", { ctrl: true })).not.toThrow();
    expect(b.faults.length).toBe(1);
  });
});

describe("the input guard and `when`", () => {
  it("suppresses every binding while the focus is on an input, not just the built-in ones", () => {
    const seen: string[] = [];
    const b = withTasks(flatTasks(3), {
      plugins: [
        probe((ctx) => {
          ctx.contribute("keys/bindings", { key: "Ctrl+Z", run: () => seen.push("undo") });
        }),
      ],
    });
    const input = b.doc.createElement("input");
    b.root.appendChild(input);
    expect(b.key("z", { ctrl: true }, input)).toBe(false);
    expect(seen).toEqual([]);
  });

  it("suppresses bindings while the focus is inside a contenteditable region", () => {
    const b = withTasks(flatTasks(3));
    const region = b.doc.createElement("div");
    region.setAttribute("contenteditable", "true");
    const span = b.doc.createElement("span");
    region.appendChild(span);
    b.root.appendChild(region);
    expect(b.key("ArrowDown", {}, span)).toBe(false);
    expect(focused(b)).toBeUndefined();
  });

  it("does not suppress bindings for a contenteditable='false' element", () => {
    const b = withTasks(flatTasks(3));
    const region = b.doc.createElement("div");
    region.setAttribute("contenteditable", "false");
    b.root.appendChild(region);
    b.key("ArrowDown", {}, region);
    expect(focused(b)).toBe("t1");
  });

  it("suppresses bindings on a grid columnheader and inside the grid header container", () => {
    const b = withTasks(flatTasks(3));
    const header = b.doc.createElement("div");
    header.setAttribute("role", "columnheader");
    b.root.appendChild(header);
    const container = b.doc.createElement("div");
    container.className = "sg-grid-header";
    const label = b.doc.createElement("span");
    container.appendChild(label);
    b.root.appendChild(container);
    expect(b.key("ArrowDown", {}, header)).toBe(false);
    expect(b.key("ArrowDown", {}, label)).toBe(false);
    expect(focused(b)).toBeUndefined();
  });

  it("skips a binding whose `when` returns false, absent means always active", () => {
    const seen: string[] = [];
    let active = false;
    const b = open({
      plugins: [
        probe((ctx) => {
          ctx.contribute("keys/bindings", {
            key: "Ctrl+K",
            when: () => active,
            run: () => seen.push("k"),
          });
        }),
      ],
    });
    expect(b.key("k", { ctrl: true })).toBe(false);
    expect(seen).toEqual([]);
    active = true;
    expect(b.key("k", { ctrl: true })).toBe(true);
    expect(seen).toEqual(["k"]);
  });

  it("treats a throwing `when` as false and reports core/pluginError", () => {
    const seen: string[] = [];
    const b = open({
      plugins: [
        probe((ctx) => {
          ctx.contribute("keys/bindings", {
            key: "Ctrl+K",
            when: () => {
              throw new Error("boom");
            },
            run: () => seen.push("k"),
          });
        }),
      ],
    });
    expect(() => b.key("k", { ctrl: true })).not.toThrow();
    expect(seen).toEqual([]);
    expect(b.faults.length).toBe(1);
  });

  it("falls back to an earlier contribution of the same chord when the later `when` is false", () => {
    const seen: string[] = [];
    const b = open({
      plugins: [
        probe(
          (ctx) => {
            ctx.contribute("keys/bindings", { key: "Ctrl+J", run: () => seen.push("early") });
          },
          "test.early",
          [],
        ),
        probe(
          (ctx) => {
            ctx.contribute("keys/bindings", {
              key: "Ctrl+J",
              when: () => false,
              run: () => seen.push("late"),
            });
          },
          "test.late",
          ["stargantt.a11y"],
        ),
      ],
    });
    b.key("j", { ctrl: true });
    expect(seen).toEqual(["early"]);
  });
});

describe("the stargantt.focus service", () => {
  it("moves the focus to a task and selects it", () => {
    const b = withTasks(flatTasks(4));
    b.focus.focus("t2");
    expect(focused(b)).toBe("t2");
    expect(b.selection?.selections.at(-1)).toEqual(["t2"]);
    const row = b.rows().find((r) => r.getAttribute("tabindex") === "0");
    expect(row?.getAttribute("aria-rowindex")).toBe("3");
  });

  it("ignores ids that are not currently a row", () => {
    const b = withTasks(flatTasks(2));
    b.focus.focus("nope");
    expect(focused(b)).toBeUndefined();
  });

  it("ignores a hidden (zero-height) row exactly like an unknown id", () => {
    const b = withTasks(flatTasks(3));
    b.grid.setHidden(["t1"]);
    b.flushFrames();
    b.focus.focus("t1");
    expect(focused(b)).toBeUndefined();
  });

  it("announces through the polite region", () => {
    const b = withTasks(flatTasks(1));
    b.focus.announce("moved to 3 March");
    expect(b.live.textContent).toBe("moved to 3 March");
  });
});

// The mirrored window is rebuilt whenever the rows change, and a rebuild may drop or repurpose the
// element the DOM focus sits on. Losing it drops a screen-reader user out of the widget entirely;
// keeping it on a repurposed element breaks the roving-tabindex invariant.
describe("the DOM focus across a rebuild", () => {
  it("keeps the focus inside the grid when the row list shrinks under it", () => {
    const b = withTasks(flatTasks(40));
    b.focus.focus("t30");
    expect(b.mirror.contains(b.doc.activeElement)).toBe(true);

    b.data.setTasks(flatTasks(2));
    b.flushFrames();

    const active = b.doc.activeElement as HTMLElement | null;
    expect(b.mirror.contains(active)).toBe(true);
    // …and on the one row the roving tabindex points at, not on a leftover element.
    expect(active?.getAttribute("tabindex")).toBe("0");
    expect(active?.getAttribute("aria-rowindex")).toBe("1");
  });

  it("follows the focused task when the window shifts and reuses the slot", () => {
    const b = withTasks(flatTasks(200));
    b.focus.focus("t100");
    expect((b.doc.activeElement as HTMLElement | null)?.getAttribute("tabindex")).toBe("0");

    // Dropping every row above it keeps `t100` a row but moves it to the top of the list, so the
    // window slides and the element that held the focus is rewritten to describe another task.
    b.data.setTasks(flatTasks(200).slice(100));
    b.flushFrames();

    const active = b.doc.activeElement as HTMLElement | null;
    expect(b.mirror.contains(active)).toBe(true);
    expect(active?.getAttribute("tabindex")).toBe("0");
    expect(active?.getAttribute("aria-rowindex")).toBe("1");
    expect(focused(b)).toBe("t100");
  });

  it("does not steal the focus when it was never inside the grid", () => {
    const b = withTasks(flatTasks(5));
    expect(b.doc.activeElement).toBe(b.doc.body);
    b.data.setTasks(flatTasks(9));
    b.flushFrames();
    expect(b.doc.activeElement).toBe(b.doc.body);
  });
});

// DOM focus entering the mirror — including the never-placed row-0 tabindex fallback — renders the
// full focus visualization without any store set; it clears again when the focus leaves before any
// effective placement, and persists after one.
describe("the visual-only placement", () => {
  it("marks and paints the fallback row while the DOM focus rests on it, setting no store", () => {
    const b = withTasks(flatTasks(3));
    b.bars.setBox("t0", { x: 10, y: 20, width: 100, height: 16 });
    b.rows()[0]?.focus();
    expect(b.grid.focused()).toBe("t0");
    expect(b.focus.state.get().focused).toBeUndefined();
    expect(b.drawFocusLayer().strokes.length).toBe(1);
  });

  it("clears the visualization when the focus leaves before any effective placement", () => {
    const b = withTasks(flatTasks(3));
    b.bars.setBox("t0", { x: 10, y: 20, width: 100, height: 16 });
    const outside = b.doc.createElement("button");
    b.doc.body.appendChild(outside);
    b.rows()[0]?.focus();
    outside.focus();
    expect(b.grid.focused()).toBeUndefined();
    expect(b.drawFocusLayer().strokes.length).toBe(0);
    outside.remove();
  });

  it("keeps the visualization after an effective placement, once the focus has left", () => {
    const b = withTasks(flatTasks(3));
    b.bars.setBox("t1", { x: 10, y: 20, width: 100, height: 16 });
    const outside = b.doc.createElement("button");
    b.doc.body.appendChild(outside);
    b.key("ArrowDown"); // an effective placement on t1
    outside.focus();
    expect(b.grid.focused()).toBe("t1");
    expect(b.drawFocusLayer().strokes.length).toBe(1);
    outside.remove();
  });
});

describe("the focus layer, composed", () => {
  it("claims the documented paint order in the renderer/layers scope", () => {
    const b = withTasks(flatTasks(1));
    const orders = b.gantt.orders("renderer/layers");
    const claim = orders.find((o) => o.key === "stargantt.a11y:focus");
    expect(claim?.order).toBe(75);
    expect(claim?.pluginId).toBe("stargantt.a11y");
  });

  it("strokes a box around the focused task's bar, outside its edges", () => {
    const b = withTasks(flatTasks(3));
    b.bars.setBox("t0", { x: 10, y: 20, width: 100, height: 16 });
    b.focus.focus("t0");
    const g = b.drawFocusLayer();
    expect(g.strokes.length).toBe(1);
    expect(g.strokes[0]).toMatchObject({ x: 8, y: 18, width: 104, height: 20 });
  });

  it("draws nothing before the focus has been placed, even though a row is implicitly focused", () => {
    const b = withTasks(flatTasks(3));
    b.bars.setBox("t0", { x: 10, y: 20, width: 100, height: 16 });
    expect(b.drawFocusLayer().strokes.length).toBe(0);
  });

  it("draws nothing when the focused task has no visible bar", () => {
    const b = withTasks(flatTasks(3));
    b.focus.focus("t0");
    expect(b.drawFocusLayer().strokes.length).toBe(0);
  });

  it("draws nothing while nothing is focused", () => {
    expect(open({ tasks: [] }).drawFocusLayer().strokes.length).toBe(0);
  });

  it("uses the --sg-focus-stroke theme token when the theme resolves one", () => {
    const b = withTasks(flatTasks(1));
    b.view.setToken("--sg-focus-stroke", "rgb(1, 2, 3)");
    b.bars.setBox("t0", { x: 0, y: 0, width: 10, height: 10 });
    b.focus.focus("t0");
    expect(b.drawFocusLayer().strokes[0]?.strokeStyle).toBe("rgb(1, 2, 3)");
  });

  it("falls back to the built-in colour for an empty token", () => {
    const b = withTasks(flatTasks(1));
    b.bars.setBox("t0", { x: 0, y: 0, width: 10, height: 10 });
    b.focus.focus("t0");
    expect(b.drawFocusLayer().strokes[0]?.strokeStyle).toBe("#0f766e");
  });

  it("invalidates the main canvas when the focus moves", () => {
    const b = withTasks(flatTasks(3));
    b.view.invalidations.length = 0;
    b.key("ArrowDown");
    expect(b.view.invalidations).toContain("main");
  });
});

// docs/specs/plugins/a11y.md § Service — the focus store.
describe("the focus store", () => {
  it("publishes the newly focused task on a keyboard move", () => {
    const b = withTasks(flatTasks(3));
    const seen: (TaskId | undefined)[] = [];
    b.focus.state.subscribe((next) => seen.push(next.focused));
    b.key("ArrowDown");
    expect(seen).toEqual(["t1"]);
  });

  it("publishes on a `FocusService.focus` call", () => {
    const b = withTasks(flatTasks(3));
    const seen: (TaskId | undefined)[] = [];
    b.focus.state.subscribe((next) => seen.push(next.focused));
    b.focus.focus("t2");
    expect(seen).toEqual(["t2"]);
  });

  it("stays unset for the internal row-0 fallback of a never-interacted-with chart", () => {
    const b = withTasks(flatTasks(3));
    expect(b.focus.state.get()).toEqual({ focused: undefined });
  });

  it("does not publish again when the resulting focus equals the previous one", () => {
    const b = withTasks(flatTasks(3));
    b.key("ArrowUp"); // t0 -> t0, the first real placement, which does publish once
    const seen: (TaskId | undefined)[] = [];
    b.focus.state.subscribe((next) => seen.push(next.focused));
    b.key("ArrowUp"); // clamped, still t0 — no effective change from here on
    expect(seen).toEqual([]);
  });

  it("publishes when the focused row disappears under a collapsing ancestor", () => {
    const b = withTasks(treeTasks());
    b.key("ArrowDown"); // a -> a1
    const seen: (TaskId | undefined)[] = [];
    b.focus.state.subscribe((next) => seen.push(next.focused));
    b.gantt.dispatch("view/rowToggle", { id: "a", expanded: false });
    b.flushFrames();
    expect(seen).toEqual(["a"]);
  });

  it("publishes `undefined` when every row disappears", () => {
    const b = withTasks(flatTasks(3));
    b.key("ArrowDown");
    const seen: (TaskId | undefined)[] = [];
    b.focus.state.subscribe((next) => seen.push(next.focused));
    b.data.setTasks([]);
    b.flushFrames();
    expect(seen).toEqual([undefined]);
  });
});

// The `GridService.setFocused` half of the same choke point: pushed alongside every store set, from
// an arrow move, a `FocusService.focus` call, and the mirror's own relocation and clearing.
describe("the grid focus push", () => {
  it("marks the newly focused task in the grid pane on a keyboard move", () => {
    const b = withTasks(flatTasks(3));
    b.key("ArrowDown");
    expect(b.grid.focused()).toBe("t1");
  });

  it("marks it on a `FocusService.focus` call", () => {
    const b = withTasks(flatTasks(3));
    b.focus.focus("t2");
    expect(b.grid.focused()).toBe("t2");
  });

  it("marks nothing before the focus has been placed by real interaction", () => {
    const b = withTasks(flatTasks(3));
    expect(b.grid.focusPushes).toEqual([]);
  });

  it("marks the relocated task when the focused row disappears under a collapsing ancestor", () => {
    const b = withTasks(treeTasks());
    b.key("ArrowDown"); // a -> a1
    expect(b.grid.focused()).toBe("a1");
    b.gantt.dispatch("view/rowToggle", { id: "a", expanded: false });
    b.flushFrames();
    expect(b.grid.focused()).toBe("a");
  });

  it("clears the mark when every row disappears", () => {
    const b = withTasks(flatTasks(3));
    b.key("ArrowDown");
    expect(b.grid.focused()).toBe("t1");
    b.data.setTasks([]);
    b.flushFrames();
    expect(b.grid.focused()).toBeUndefined();
  });
});

describe("scrolling the focused row into view", () => {
  it("does not scroll a focus move that stays inside the viewport", () => {
    const b = withTasks(flatTasks(500));
    b.key("ArrowDown");
    expect(b.view.scrolls).toEqual([]);
  });

  it("scrolls down by the minimum amount once the focused row leaves the viewport", () => {
    const b = withTasks(flatTasks(500));
    // rowHeight 24, viewport height 300 -> rows 0..11 fit (11*24 + 24 = 288 <= 300).
    for (let i = 0; i < 12; i += 1) b.key("ArrowDown");
    // row 12: top = 288, bottom = 312 > 300 -> scrollTop = 312 - 300 = 12
    expect(b.view.scrolls).toEqual([{ scrollTop: 12 }]);
  });

  it("scrolls up by the minimum amount once the focused row leaves the viewport above", () => {
    const b = withTasks(flatTasks(500));
    for (let i = 0; i < 20; i += 1) b.key("ArrowDown");
    b.view.scrolls.length = 0;
    for (let i = 0; i < 20; i += 1) b.key("ArrowUp");
    expect(b.view.scrolls.at(-1)).toEqual({ scrollTop: 0 });
  });

  it("scrolls on a `FocusService.focus` call to an off-screen row", () => {
    const b = withTasks(flatTasks(500));
    b.focus.focus("t100");
    expect(b.view.scrolls).toEqual([{ scrollTop: 100 * 24 + 24 - 300 }]);
  });

  it("does not scroll when the viewport reports no height (detached container)", () => {
    const b = withTasks(flatTasks(500));
    b.view.setViewport({ height: 0 });
    b.focus.focus("t100");
    expect(b.view.scrolls).toEqual([]);
  });
});

describe("multi-selection chords", () => {
  it("reports aria-multiselectable exactly while the selection mode is multi", () => {
    const multi = open({ tasks: flatTasks(3), selectionMode: "multi" });
    expect(multi.mirror.getAttribute("aria-multiselectable")).toBe("true");
    multi.dispose();
    booted = undefined;

    const single = open({ tasks: flatTasks(3), selectionMode: "single" });
    expect(single.mirror.getAttribute("aria-multiselectable")).toBeNull();
  });

  it("Shift+ArrowDown extends the selection from the keyboard anchor over the visible rows", () => {
    const b = open({ tasks: flatTasks(5), selectionMode: "multi" });
    b.key("ArrowDown"); // anchor <- t1
    b.key("ArrowDown", { shift: true });
    b.key("ArrowDown", { shift: true });
    expect(focused(b)).toBe("t3");
    expect(b.selection?.selected()).toEqual(new Set(["t1", "t2", "t3"]));
  });

  it("a following plain arrow move collapses the selection back to one row and resets the anchor", () => {
    const b = open({ tasks: flatTasks(5), selectionMode: "multi" });
    b.key("ArrowDown"); // t0 -> t1, anchor <- t1, selected {t1}
    b.key("ArrowDown", { shift: true }); // t1 -> t2, range {t1, t2}
    b.key("ArrowDown"); // plain move: t2 -> t3, anchor <- t3, selection replaced with {t3}
    expect(focused(b)).toBe("t3");
    expect(b.selection?.selected()).toEqual(new Set(["t3"]));
    // The anchor moved on with it: a further Shift+ArrowDown ranges from t3, not t1.
    b.key("ArrowDown", { shift: true });
    expect(b.selection?.selected()).toEqual(new Set(["t3", "t4"]));
  });

  it("Ctrl+Space toggles the focused row without moving the focus", () => {
    const b = open({ tasks: flatTasks(3), selectionMode: "multi" });
    b.key(" ", { ctrl: true });
    expect(b.selection?.selected()).toEqual(new Set(["t0"]));
    expect(focused(b)).toBeUndefined(); // the toggle places no focus of its own
    b.key(" ", { ctrl: true });
    expect(b.selection?.selected()).toEqual(new Set());
  });

  it("announces the resulting selection size, but only on an effective change", () => {
    const b = open({ tasks: flatTasks(3), selectionMode: "multi" });
    b.key(" ", { ctrl: true }); // t0 toggled in: {} -> {t0}
    expect(b.live.textContent).toBe("1 selected");
    b.live.textContent = "";
    // Shift+ArrowUp at the already-first row: focus stays at t0, the range is still {t0}, and the
    // selection was already exactly {t0} — a genuine no-op.
    b.key("ArrowUp", { shift: true });
    expect(b.live.textContent).toBe("");
  });

  it("is inert in single-selection mode: the chords fall through unclaimed", () => {
    const b = withTasks(flatTasks(3));
    expect(b.key("ArrowDown", { shift: true })).toBe(false);
    expect(b.key(" ", { ctrl: true })).toBe(false);
    expect(b.selection?.selected()).toEqual(new Set());
  });

  // The mirror's own render fallback can relocate or clear an already-placed focus entirely on its
  // own. A stale anchor left pointing at a row that no longer exists must be treated as no anchor.
  describe("a keyboard anchor invalidated without going through a placement", () => {
    it("re-anchors on the current focus when a collapse removes the anchor row", () => {
      const b = open({ tasks: treeTasks(), selectionMode: "multi" });
      b.key("ArrowDown"); // a -> a1, anchor <- a1
      b.key("ArrowDown", { shift: true }); // a1 -> a2, anchor stays a1, selected {a1, a2}
      expect(b.selection?.selected()).toEqual(new Set(["a1", "a2"]));
      b.gantt.dispatch("view/rowToggle", { id: "a", expanded: false });
      b.flushFrames();
      expect(focused(b)).toBe("a");
      // The stale anchor ("a1") no longer has a row: a further Shift+ArrowDown ranges from the
      // current focus.
      b.key("ArrowDown", { shift: true });
      expect(focused(b)).toBe("b");
      expect(b.selection?.selected()).toEqual(new Set(["a", "b"]));
    });

    it("re-anchors on the current focus when a data change removes the anchor row but not the focus", () => {
      const b = open({ tasks: flatTasks(5), selectionMode: "multi" });
      b.key("ArrowDown"); // t0 -> t1, anchor <- t1
      b.key("ArrowDown", { shift: true }); // t1 -> t2, anchor stays t1
      expect(b.selection?.selected()).toEqual(new Set(["t1", "t2"]));
      b.data.setTasks(flatTasks(5).filter((t) => t.id !== "t1" && t.id !== "t4"));
      b.flushFrames();
      expect(focused(b)).toBe("t2");
      b.key("ArrowUp", { shift: true });
      expect(focused(b)).toBe("t0");
      expect(b.selection?.selected()).toEqual(new Set(["t0", "t2"]));
    });

    it("does not resurrect an anchor whose row disappears and comes back", () => {
      const b = open({ tasks: treeTasks(), selectionMode: "multi" });
      b.key("ArrowDown"); // a -> a1, anchor <- a1
      b.key("ArrowDown", { shift: true }); // a1 -> a2, anchor stays a1
      expect(b.selection?.selected()).toEqual(new Set(["a1", "a2"]));

      b.gantt.dispatch("view/rowToggle", { id: "a", expanded: false });
      b.flushFrames();
      b.gantt.dispatch("view/rowToggle", { id: "a", expanded: true });
      b.flushFrames();
      expect(focused(b)).toBe("a");

      b.key("ArrowDown", { shift: true });
      expect(focused(b)).toBe("a1");
      expect(b.selection?.selected()).toEqual(new Set(["a", "a1"]));
    });
  });
});

// docs/specs/plugins/a11y.md § Mirror generation rules — the `aria-selected` mirroring.
describe("aria-selected on the mirror rows", () => {
  it("marks the selected row true and every other materialized row false", () => {
    const b = withTasks(flatTasks(3));
    b.selection?.select(["t1"]);
    expect(b.rows().map((r) => r.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
  });

  it("updates in place when the selection changes, without a mirror rebuild", () => {
    const b = withTasks(flatTasks(3));
    b.selection?.select(["t0"]);
    expect(b.rows().map((r) => r.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    b.selection?.select(["t2"]);
    expect(b.rows().map((r) => r.getAttribute("aria-selected"))).toEqual(["false", "false", "true"]);
    b.selection?.select([]);
    expect(b.rows().map((r) => r.getAttribute("aria-selected"))).toEqual([
      "false",
      "false",
      "false",
    ]);
  });

  it("gives a row scrolled into view after the selection changed the right state", () => {
    const b = withTasks(flatTasks(500));
    b.selection?.select(["t100"]);
    expect(b.rows().some((r) => r.getAttribute("aria-rowindex") === "101")).toBe(false);
    b.focus.focus("t100");
    const row = b.rows().find((r) => r.getAttribute("aria-rowindex") === "101");
    expect(row?.getAttribute("aria-selected")).toBe("true");
  });

  it("reflects a keyboard-driven selection (Ctrl+Space) the same way as a direct service call", () => {
    const b = open({ tasks: flatTasks(3), selectionMode: "multi" });
    b.key(" ", { ctrl: true }); // toggles t0 in
    expect(b.rows()[0]?.getAttribute("aria-selected")).toBe("true");
  });

  it("does not announce anything through the live region on its own", () => {
    const b = withTasks(flatTasks(3));
    b.selection?.select(["t1"]);
    expect(b.live.textContent).toBe("");
  });
});

// A keydown reaches the dispatcher after a pointer gesture even though the gesture never moved the
// DOM focus.
describe("keyboard reachability after a pointer gesture", () => {
  it("runs a chord at body focus after a pointerdown inside the chart", () => {
    const b = withTasks(flatTasks(3));
    b.pointerDown(b.root);
    expect(b.key("ArrowDown", {}, b.doc.body)).toBe(true);
    expect(focused(b)).toBe("t1");
  });

  it("does not run without a prior pointer interaction in the chart", () => {
    const b = withTasks(flatTasks(3));
    expect(b.key("ArrowDown", {}, b.doc.body)).toBe(false);
    expect(focused(b)).toBeUndefined();
  });

  it("does not run for a target outside the chart, even with the claim held", () => {
    const b = withTasks(flatTasks(3));
    const outside = b.doc.createElement("div");
    b.doc.body.appendChild(outside);
    b.pointerDown(b.root);
    expect(b.key("ArrowDown", {}, outside)).toBe(false);
    expect(focused(b)).toBeUndefined();
    outside.remove();
  });

  it("releases the claim when the DOM focus moves outside the chart", () => {
    const b = withTasks(flatTasks(3));
    const outside = b.doc.createElement("div");
    b.doc.body.appendChild(outside);
    b.pointerDown(b.root);
    b.focusIn(outside);
    expect(b.key("ArrowDown", {}, b.doc.body)).toBe(false);
    expect(focused(b)).toBeUndefined();
    outside.remove();
  });

  it("releases the claim when a pointerdown lands outside the chart", () => {
    const b = withTasks(flatTasks(3));
    const outside = b.doc.createElement("div");
    b.doc.body.appendChild(outside);
    b.pointerDown(b.root);
    b.pointerDown(outside);
    expect(b.key("ArrowDown", {}, b.doc.body)).toBe(false);
    expect(focused(b)).toBeUndefined();
    outside.remove();
  });
});

describe("`syncSelection`", () => {
  it("defaults to true: focus movement still selects the focused task", () => {
    const b = withTasks(flatTasks(3));
    b.key("ArrowDown");
    expect(b.selection?.selections.at(-1)).toEqual(["t1"]);
  });

  it("set to false: focus moves without touching the selection", () => {
    const b = open({ tasks: flatTasks(3), config: { syncSelection: false } });
    b.key("ArrowDown");
    expect(focused(b)).toBe("t1");
    expect(b.selection?.selections).toEqual([]);
  });

  it("set to false: FocusService.focus also leaves the selection alone", () => {
    const b = open({ tasks: flatTasks(3), config: { syncSelection: false } });
    b.focus.focus("t2");
    expect(focused(b)).toBe("t2");
    expect(b.selection?.selections).toEqual([]);
  });
});

describe("teardown", () => {
  it("releases the mirror and the document-level listeners", () => {
    const b = withTasks(flatTasks(3));
    b.host.dispose();
    expect(b.root.querySelector(".sg-a11y")).toBeNull();
    expect(b.root.querySelector(".sg-a11y-live")).toBeNull();
    // The document-level dispatcher is gone with it: a keystroke claims nothing any more.
    expect(b.key("ArrowDown")).toBe(false);
    booted = undefined;
    b.root.remove();
  });
});

// docs/specs/plugins/a11y.md § Messages — the row text and the announcements are replaceable
// builders, and omitting `messages` reproduces the English defaults byte for byte.
describe("the message catalog", () => {
  function withMessages(config: A11yConfig, tasks: readonly Task[]): Booted {
    return open({ config, tasks });
  }

  it("keeps the English defaults with no messages, or an empty catalog", () => {
    const withProgress: Task[] = [
      { id: "t0", parentId: null, name: "design", start: 0, end: 86_400_000, progress: 0.25 },
    ];
    const a = withMessages({}, withProgress);
    expect(a.rows()[0]?.textContent).toBe("design, 1970-01-01 – 1970-01-02, 25%");
    a.dispose();
    booted = undefined;

    const b = withMessages({ messages: {} }, withProgress);
    expect(b.rows()[0]?.textContent).toBe("design, 1970-01-01 – 1970-01-02, 25%");
  });

  it("replaces the row text, receiving the task's fields rather than rendered text", () => {
    const b = withMessages(
      {
        messages: {
          rowText: (parts) => `${parts.name}|${parts.start}|${parts.end}|${parts.progress ?? "none"}`,
        },
      },
      [
        { id: "t0", parentId: null, name: "design", start: 0, end: 86_400_000, progress: 0.25 },
        { id: "t1", parentId: null, name: "build", start: 0, end: 86_400_000 },
      ],
    );
    expect(b.rows()[0]?.textContent).toBe("design|0|86400000|0.25");
    // A task carrying no progress leaves the member absent rather than passing `undefined` on.
    expect(b.rows()[1]?.textContent).toBe("build|0|86400000|none");
  });

  it("replaces the toggle announcements, per key", () => {
    const b = withMessages({ messages: { rowCollapsed: (name) => `zu: ${name ?? "?"}` } }, treeTasks());
    b.key("-");
    b.flushFrames();
    expect(b.live.textContent).toBe("zu: a");
    // `rowExpanded` was not given, so it kept its default.
    b.key("+");
    b.flushFrames();
    expect(b.live.textContent).toBe("a, expanded");
  });

  it("ignores a member that is not a function and keeps its default", () => {
    const b = withMessages({ messages: { rowText: "nope" } } as unknown as A11yConfig, flatTasks(1));
    expect(b.rows()[0]?.textContent).toBe("t0, 1970-01-01 – 1970-01-02");
  });

  it("contains a throwing builder: reports core/pluginError and uses the default for that call", () => {
    const b = open({
      tasks: flatTasks(1),
      config: {
        messages: {
          rowText: () => {
            throw new Error("boom");
          },
        },
      },
    });
    expect(b.rows()[0]?.textContent).toBe("t0, 1970-01-01 – 1970-01-02");
    expect(b.faults.length).toBeGreaterThan(0);
    expect((b.faults[0] as { pluginId: string }).pluginId).toBe("stargantt.a11y");
  });

  it("resolves the catalog once at setup, so mutating it afterwards changes nothing", () => {
    const messages = { rowExpanded: (name: string | undefined) => `first ${name ?? ""}` };
    const b = withMessages({ messages }, treeTasks());
    messages.rowExpanded = (name) => `second ${name ?? ""}`;
    b.key("-");
    b.flushFrames();
    b.key("+");
    b.flushFrames();
    expect(b.live.textContent).toBe("first a");
  });

  it("snapshots the configuration, so a later mutation cannot change a running chart", () => {
    const config: A11yConfig = { label: "first" };
    const plugin = a11y(config);
    config.label = "second";
    expect(plugin.meta.id).toBe("stargantt.a11y");
  });
});
