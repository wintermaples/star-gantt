// @vitest-environment happy-dom
// docs/specs/plugins/a11y.md § Mirror generation rules — "Hidden rows".
/**
 * A row whose resolved height is 0 (how the filter hides filtered-out rows) is left out of the ARIA
 * mirror and skipped by the roving focus, so nobody navigates rows that are not on screen.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { TaskId } from "@stargantt/plugin-data-store";
import { boot, flatTasks } from "./_boot";
import type { Booted } from "./_boot";

let booted: Booted | undefined;

afterEach(() => {
  booted?.dispose();
  booted = undefined;
});

function bootWithHidden(hidden: readonly TaskId[], selectionMode: "single" | "multi" = "single"): Booted {
  const b = boot({ tasks: flatTasks(5), selectionMode });
  booted = b;
  b.grid.setHidden(hidden);
  b.flushFrames();
  return b;
}

/** The task names the mirror currently exposes, in DOM order. */
function mirrored(b: Booted): (string | undefined)[] {
  // The row text is "<name>, <start> – <end>"; the name alone identifies the row here.
  return b.rows().map((row) => row.textContent?.split(",")[0]);
}

function focused(b: Booted): TaskId | undefined {
  return b.focus.state.get().focused;
}

describe("hidden (zero-height) rows", () => {
  it("leaves them out of the mirror and out of aria-rowcount", () => {
    const b = bootWithHidden(["t1", "t3"]);
    expect(mirrored(b)).toEqual(["t0", "t2", "t4"]);
    expect(b.mirror.getAttribute("aria-rowcount")).toBe("3");
    // aria-rowindex counts the reachable rows, so it agrees with the count above.
    expect(b.rows().map((r) => r.getAttribute("aria-rowindex"))).toEqual(["1", "2", "3"]);
  });

  it("skips them when the roving focus moves", () => {
    const b = bootWithHidden(["t1", "t2"]);
    // The roving focus rests on the first row before any interaction, so one press moves off it —
    // straight past the two hidden rows.
    b.key("ArrowDown");
    expect(focused(b)).toBe("t3");
    b.key("ArrowUp");
    expect(focused(b)).toBe("t0");
  });

  it("refuses to place the focus on a hidden row", () => {
    const b = bootWithHidden(["t1"]);
    b.focus.focus("t0");
    b.focus.focus("t1");
    expect(focused(b)).toBe("t0");
  });

  it("gives up a focus that was hidden under it, and takes the row back when it reappears", () => {
    const b = bootWithHidden([]);
    b.focus.focus("t2");
    expect(focused(b)).toBe("t2");

    b.grid.setHidden(["t2"]);
    b.flushFrames();
    expect(focused(b)).not.toBe("t2");
    expect(mirrored(b)).toEqual(["t0", "t1", "t3", "t4"]);

    b.grid.setHidden([]);
    b.flushFrames();
    expect(mirrored(b)).toEqual(["t0", "t1", "t2", "t3", "t4"]);
    b.focus.focus("t2");
    expect(focused(b)).toBe("t2");
  });

  it("keeps them out of a Shift+arrow range selection", () => {
    const b = bootWithHidden(["t1", "t2"], "multi");
    // The roving focus rests on t0; one Shift+ArrowDown skips the hidden rows and lands on t3, so
    // the range it selects spans t0..t3 in row terms but must name only the two visible rows.
    b.key("ArrowDown", { shift: true });
    expect(focused(b)).toBe("t3");
    expect([...(b.selection?.selected() ?? [])].sort()).toEqual(["t0", "t3"]);
  });

  it("is inert with no hidden row: every row is mirrored and reachable", () => {
    const b = bootWithHidden([]);
    expect(mirrored(b)).toEqual(["t0", "t1", "t2", "t3", "t4"]);
    expect(b.mirror.getAttribute("aria-rowcount")).toBe("5");
  });
});
