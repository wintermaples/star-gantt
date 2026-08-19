// docs/specs/plugins/a11y.md § Default bindings — the keyboard anchor and the multi chords.
/**
 * `internal/selection-chords.ts` on its own: the range anchor's lifetime, what each focus cause does
 * to it, the two multi-selection chords, and the degraded composition in which no selection service
 * resolves at all — with plain doubles, no host (`references/code-quality.md` §1).
 *
 * The selection double echoes its state change synchronously the way the real service's store does,
 * by calling the module's own `onSelectionChanged()` from inside `select()`. That is the A→B→A loop
 * the plugin never cut with a re-entrancy flag: these tests pin that the anchor survives it because
 * it is written *after* each of the module's own `select()` calls.
 */
import { describe, expect, it } from "vitest";
import { mockStore } from "@stargantt/sdk";
import type { TaskId } from "@stargantt/plugin-data-store";
import type { SelectionService, SelectionState } from "@stargantt/plugin-interaction";
import { createSelectionChords, placementEffects } from "../src/internal/selection-chords";
import type { SelectionChords } from "../src/internal/selection-chords";

interface Fixture {
  chords: SelectionChords;
  /** The current selection, as the double holds it. */
  selected(): TaskId[];
  /** Everything announced through the live region, oldest first. */
  spoken: string[];
  /** Removes a task's row from the row order, as a collapse or a data change would. */
  dropRow(id: TaskId): void;
  /** Where the roving focus sits in the double. */
  focus(id: TaskId | undefined): void;
}

interface FixtureOptions {
  order?: TaskId[];
  syncSelection?: boolean;
  hidden?: Set<TaskId>;
  mode?: "single" | "multi" | "none";
  /** `false` composes no selection service at all — the degraded composition. */
  selection?: boolean;
}

function fixture(options: FixtureOptions = {}): Fixture {
  let order: TaskId[] = options.order ?? ["t0", "t1", "t2", "t3"];
  let focused: TaskId | undefined = order[0];
  const state = mockStore<SelectionState>({ taskIds: new Set<TaskId>() });
  const spoken: string[] = [];
  let echo: (() => void) | undefined;

  const service = {
    state,
    select: (ids: readonly TaskId[]) => {
      state.set({ taskIds: new Set(ids) });
      // The real service publishes every effective change, synchronously.
      echo?.();
    },
    toggle: () => {},
    clear: () => state.set({ taskIds: new Set<TaskId>() }),
    reveal: () => {},
    mode: () => options.mode ?? "multi",
    deleteSelected: () => {},
  } as unknown as SelectionService;

  const chords = createSelectionChords({
    rows: {
      rowCount: () => order.length,
      rowOf: (id) => {
        const i = order.indexOf(id);
        return i < 0 ? undefined : i;
      },
      taskIdAt: (row) => order[row],
      // A hidden row resolves to height 0, exactly how the filter hides filtered-out rows; every
      // other row keeps the default height.
      rowHeight: (row) => {
        const id = order[row];
        return id !== undefined && (options.hidden?.has(id) ?? false) ? 0 : 28;
      },
    },
    selection: () => (options.selection === false ? undefined : service),
    syncSelection: options.syncSelection ?? true,
    shiftMoveFocus: (delta) => {
      const at = focused === undefined ? 0 : order.indexOf(focused);
      const next = Math.min(order.length - 1, Math.max(0, at + delta));
      focused = order[next];
    },
    focusedTask: () => focused,
    announce: (message) => spoken.push(message),
    selectionCount: (count) => `${count} selected`,
  });
  echo = () => chords.onSelectionChanged();

  return {
    chords,
    spoken,
    selected: () => [...state.get().taskIds],
    dropRow: (id) => {
      order = order.filter((candidate) => candidate !== id);
    },
    focus: (id) => {
      focused = id;
    },
  };
}

describe("placementEffects", () => {
  it("states what each cause does to the anchor and to the selection", () => {
    expect(placementEffects("keyboard")).toEqual({ anchor: true, select: true });
    expect(placementEffects("api")).toEqual({ anchor: true, select: true });
    // A click re-anchors but leaves the selection to `stargantt.selection`.
    expect(placementEffects("pointer")).toEqual({ anchor: true, select: false });
    // The Shift chord drives both itself.
    expect(placementEffects("shift")).toEqual({ anchor: false, select: false });
  });
});

describe("the range anchor", () => {
  it("follows a keyboard placement and survives the plugin's own selection echo", () => {
    const f = fixture();
    f.focus("t1");
    f.chords.onFocusPlaced("t1", "keyboard");
    expect(f.selected()).toEqual(["t1"]);
    expect(f.chords.anchor()).toBe("t1");
  });

  it("follows a pointer placement without touching the selection", () => {
    const f = fixture();
    f.chords.onFocusPlaced("t2", "pointer");
    expect(f.selected()).toEqual([]);
    expect(f.chords.anchor()).toBe("t2");
  });

  it("is left alone by a Shift placement", () => {
    const f = fixture();
    f.chords.onFocusPlaced("t1", "keyboard");
    f.chords.onFocusPlaced("t2", "shift");
    expect(f.chords.anchor()).toBe("t1");
  });

  it("is dropped by a selection change the plugin did not make", () => {
    const f = fixture();
    f.chords.onFocusPlaced("t1", "keyboard");
    f.chords.onSelectionChanged(); // a pointer or programmatic selection elsewhere
    expect(f.chords.anchor()).toBeUndefined();
  });

  it("moves the focus without selecting when syncSelection is off", () => {
    const f = fixture({ syncSelection: false });
    f.chords.onFocusPlaced("t1", "keyboard");
    expect(f.selected()).toEqual([]);
    expect(f.chords.anchor()).toBe("t1");
  });

  it("is invalidated the moment the focus moves off a row that no longer exists", () => {
    const f = fixture();
    f.chords.onFocusPlaced("t1", "keyboard");
    f.dropRow("t1");
    f.chords.onFocusChanged();
    expect(f.chords.anchor()).toBeUndefined();
  });
});

describe("Shift+arrow", () => {
  it("selects the inclusive visible-row range between the anchor and the new focus", () => {
    const f = fixture();
    f.focus("t1");
    f.chords.onFocusPlaced("t1", "keyboard");
    f.chords.shiftMove(1);
    expect(f.selected()).toEqual(["t1", "t2"]);
    f.chords.shiftMove(1);
    expect(f.selected()).toEqual(["t1", "t2", "t3"]);
    // The anchor stayed put across both chords, echo or no echo.
    expect(f.chords.anchor()).toBe("t1");
    expect(f.spoken).toEqual(["2 selected", "3 selected"]);
  });

  it("re-anchors on the row the focus is leaving when the anchor's row is gone", () => {
    const f = fixture();
    f.focus("t1");
    f.chords.onFocusPlaced("t1", "keyboard");
    f.dropRow("t1");
    f.focus("t2");
    f.chords.shiftMove(1);
    expect(f.selected()).toEqual(["t2", "t3"]);
    expect(f.chords.anchor()).toBe("t2");
  });

  it("says nothing when the resulting selection is unchanged", () => {
    const f = fixture({ order: ["t0"] });
    f.chords.onFocusPlaced("t0", "keyboard");
    f.spoken.length = 0;
    f.chords.shiftMove(-1); // clamped at the first row, the range is still {t0}
    expect(f.selected()).toEqual(["t0"]);
    expect(f.spoken).toEqual([]);
  });

  it("leaves rows hidden at height 0 out of the selected range", () => {
    const f = fixture({ hidden: new Set<TaskId>(["t1", "t2"]) });
    f.focus("t0");
    f.chords.onFocusPlaced("t0", "keyboard");
    f.spoken.length = 0;
    // The roving focus skips the hidden rows, so one Shift press lands on t3 — and the range it
    // spans must name only the rows a user can actually see.
    f.focus("t3");
    f.chords.shiftMove(0);
    expect(f.selected()).toEqual(["t0", "t3"]);
    expect(f.spoken).toEqual(["2 selected"]);
  });

  it("does nothing at all without rows", () => {
    const f = fixture({ order: [] });
    f.focus(undefined);
    f.chords.shiftMove(1);
    expect(f.selected()).toEqual([]);
    expect(f.spoken).toEqual([]);
  });
});

describe("Ctrl+Space", () => {
  it("toggles the focused row in and out, leaving the anchor and the focus alone", () => {
    const f = fixture();
    f.focus("t2");
    f.chords.onFocusPlaced("t1", "keyboard"); // anchor: t1
    f.spoken.length = 0;
    f.chords.toggleFocused();
    expect(f.selected()).toEqual(["t1", "t2"]);
    expect(f.chords.anchor()).toBe("t1");
    f.chords.toggleFocused();
    expect(f.selected()).toEqual(["t1"]);
    expect(f.spoken).toEqual(["2 selected", "1 selected"]);
  });

  it("does nothing while no row is focused", () => {
    const f = fixture();
    f.focus(undefined);
    f.chords.toggleFocused();
    expect(f.selected()).toEqual([]);
    expect(f.spoken).toEqual([]);
  });
});

// docs/specs/plugins/a11y.md § Dependencies — degradation semantics.
describe("without a composed selection service", () => {
  it("reports the multi gate inactive, so the chords fall through", () => {
    expect(fixture({ selection: false }).chords.multiSelection()).toBe(false);
  });

  it("reports the multi gate from the resolved service's mode otherwise", () => {
    expect(fixture({ mode: "multi" }).chords.multiSelection()).toBe(true);
    expect(fixture({ mode: "single" }).chords.multiSelection()).toBe(false);
    expect(fixture({ mode: "none" }).chords.multiSelection()).toBe(false);
  });

  it("moves the focus alone on a syncSelection placement, without erroring", () => {
    const f = fixture({ selection: false });
    expect(() => f.chords.onFocusPlaced("t1", "keyboard")).not.toThrow();
    expect(f.chords.anchor()).toBe("t1");
    expect(f.selected()).toEqual([]);
  });

  it("leaves both chords inert and silent", () => {
    const f = fixture({ selection: false });
    f.focus("t1");
    f.chords.shiftMove(1);
    f.chords.toggleFocused();
    expect(f.selected()).toEqual([]);
    expect(f.spoken).toEqual([]);
  });
});

// The service is optional and same-layer: any plugin may provide it, so an `taskIds` that is not
// the `Set` the contract states must not throw out of a chord mid-keystroke.
describe("a foreign provider's payload shape", () => {
  it("reads an array-shaped taskIds without throwing", () => {
    const state = mockStore({ taskIds: ["t0"] as unknown as ReadonlySet<TaskId> });
    const service = {
      state,
      select: (ids: readonly TaskId[]) => state.set({ taskIds: [...ids] as unknown as ReadonlySet<TaskId> }),
      toggle: () => {},
      clear: () => {},
      reveal: () => {},
      mode: () => "multi" as const,
      deleteSelected: () => {},
    } as unknown as SelectionService;
    const order: TaskId[] = ["t0", "t1"];
    const spoken: string[] = [];
    const chords = createSelectionChords({
      rows: {
        rowCount: () => order.length,
        rowOf: (id) => {
          const i = order.indexOf(id);
          return i < 0 ? undefined : i;
        },
        taskIdAt: (row) => order[row],
        rowHeight: () => 28,
      },
      selection: () => service,
      syncSelection: true,
      shiftMoveFocus: () => {},
      focusedTask: () => "t1",
      announce: (message) => spoken.push(message),
      selectionCount: (count) => `${count} selected`,
    });
    expect(() => chords.toggleFocused()).not.toThrow();
    expect([...(state.get().taskIds as unknown as TaskId[])]).toEqual(["t0", "t1"]);
    expect(spoken).toEqual(["2 selected"]);
  });
});
