// docs/specs/plugins/a11y.md § Default bindings.
/**
 * `internal/bindings.ts` on its own: which chords the plugin contributes, in which order, and what
 * each one does — with doubles for the row model and the store, no host
 * (`references/code-quality.md` §1). The full-composition behavior of the same bindings stays in
 * `plugin.test.ts`.
 */
import { describe, expect, it } from "vitest";
import type { Task, TaskId } from "@stargantt/plugin-data-store";
import { defaultBindings } from "../src/internal/bindings";
import { DEFAULT_MESSAGES } from "../src/messages";
import type { KeyBinding } from "../src/types";

interface Fixture {
  bindings: KeyBinding[];
  run(key: string): void;
  spoken: string[];
  toggled: { id: TaskId; expanded: boolean }[];
  edits: TaskId[];
  moves: number[];
  focuses: TaskId[];
  /** Where the roving focus sits. */
  focus(id: TaskId | undefined): void;
  /** Whether `id` is expanded, as the row model reports it. */
  expand(id: TaskId, expanded: boolean): void;
}

/** `p` with two children `c0`/`c1`, plus a top-level leaf `q`. */
const TASKS: Task[] = [
  { id: "p", parentId: null, name: "p", start: 0, end: 1 },
  { id: "c0", parentId: "p", name: "c0", start: 0, end: 1 },
  { id: "c1", parentId: "p", name: "c1", start: 0, end: 1 },
  { id: "q", parentId: null, name: "q", start: 0, end: 1 },
];

function fixture(options: { multi?: boolean } = {}): Fixture {
  const expanded = new Map<TaskId, boolean>([["p", true]]);
  const order: TaskId[] = ["p", "c0", "c1", "q"];
  let focused: TaskId | undefined = "p";
  const out = {
    spoken: [] as string[],
    toggled: [] as { id: TaskId; expanded: boolean }[],
    edits: [] as TaskId[],
    moves: [] as number[],
    focuses: [] as TaskId[],
  };

  const byId = new Map(TASKS.map((t) => [t.id, t]));
  const children = new Map<TaskId, TaskId[]>([["p", ["c0", "c1"]]]);

  const bindings = defaultBindings({
    rows: {
      rowCount: () => order.length,
      rowOf: (id) => {
        const i = order.indexOf(id);
        return i < 0 ? undefined : i;
      },
      isExpanded: (id) => expanded.get(id) ?? false,
    },
    messages: DEFAULT_MESSAGES,
    taskName: (id) => byId.get(id)?.name,
    parentOf: (id) => byId.get(id)?.parentId ?? null,
    hasChildren: (id) => (children.get(id)?.length ?? 0) > 0,
    focusedTask: () => focused,
    moveFocus: (delta) => out.moves.push(delta),
    focusTask: (id) => out.focuses.push(id),
    announce: (message) => out.spoken.push(message),
    toggleRow: (id, expand) => {
      out.toggled.push({ id, expanded: expand });
      // The real command changes the row model's state, which is what makes the announcement fire.
      expanded.set(id, expand);
    },
    startEdit: (id) => out.edits.push(id),
    multiSelection: () => options.multi === true,
    shiftMove: () => {},
    toggleFocusedSelection: () => {},
  });

  return {
    bindings,
    ...out,
    run: (key) => {
      const binding = [...bindings].reverse().find((b) => b.key === key);
      if (binding === undefined) throw new Error(`no binding for ${key}`);
      if (binding.when !== undefined && !binding.when()) return;
      binding.run();
    },
    focus: (id) => {
      focused = id;
    },
    expand: (id, value) => expanded.set(id, value),
  };
}

describe("the default binding set", () => {
  it("contributes exactly the documented chords, in contribution order", () => {
    expect(fixture().bindings.map((b) => b.key)).toEqual([
      "ArrowDown",
      "ArrowUp",
      "+",
      "-",
      "Home",
      "End",
      "ArrowRight",
      "ArrowLeft",
      "Enter",
      "Shift+ArrowDown",
      "Shift+ArrowUp",
      "Ctrl+Space",
    ]);
  });

  it("describes the chords the shortcut-help dialog lists, and leaves the aliases undescribed", () => {
    const described = new Map(fixture().bindings.map((b) => [b.key, b.description]));
    expect(described.get("ArrowDown")).toBe("Move focus down");
    expect(described.get("ArrowUp")).toBe("Move focus up");
    expect(described.get("+")).toBe("Expand the focused row");
    expect(described.get("-")).toBe("Collapse the focused row");
    expect(described.get("Home")).toBe("Focus the first row");
    expect(described.get("End")).toBe("Focus the last row");
    expect(described.get("Enter")).toBe("Edit the focused row");
    expect(described.get("ArrowRight")).toBeUndefined();
    expect(described.get("ArrowLeft")).toBeUndefined();
    expect(described.get("Ctrl+Space")).toBeUndefined();
  });

  it("moves the focus one row per arrow, and to the ends of the list for Home/End", () => {
    const f = fixture();
    f.run("ArrowDown");
    f.run("ArrowUp");
    f.run("Home");
    f.run("End");
    expect(f.moves).toEqual([1, -1, -4, 4]);
  });

  it("gates the multi-selection chords on the reported mode", () => {
    const single = fixture();
    for (const key of ["Shift+ArrowDown", "Shift+ArrowUp", "Ctrl+Space"]) {
      const binding = single.bindings.find((b) => b.key === key);
      expect(binding?.when?.()).toBe(false);
    }
    const multi = fixture({ multi: true });
    for (const key of ["Shift+ArrowDown", "Shift+ArrowUp", "Ctrl+Space"]) {
      expect(multi.bindings.find((b) => b.key === key)?.when?.()).toBe(true);
    }
  });
});

describe("expand / collapse and their announcements", () => {
  it("announces the new state of a summary row", () => {
    const f = fixture();
    f.run("-");
    expect(f.toggled).toEqual([{ id: "p", expanded: false }]);
    expect(f.spoken).toEqual(["p, collapsed"]);
    f.run("+");
    expect(f.spoken).toEqual(["p, collapsed", "p, expanded"]);
  });

  it("stays silent for a leaf, and for a state that did not change", () => {
    const f = fixture();
    f.focus("q"); // a top-level leaf
    f.run("-");
    expect(f.spoken).toEqual([]);
    f.focus("p");
    f.run("+"); // already expanded
    expect(f.spoken).toEqual([]);
  });

  it("does nothing at all while no row is focused", () => {
    const f = fixture();
    f.focus(undefined);
    f.run("+");
    f.run("Enter");
    expect(f.toggled).toEqual([]);
    expect(f.edits).toEqual([]);
  });
});

describe("the APG treegrid aliases", () => {
  it("ArrowRight expands a collapsed parent and enters the first child of an expanded one", () => {
    const f = fixture();
    f.expand("p", false);
    f.run("ArrowRight");
    expect(f.toggled).toEqual([{ id: "p", expanded: true }]);
    f.run("ArrowRight");
    expect(f.moves).toEqual([1]);
  });

  it("ArrowRight is a no-op on a leaf", () => {
    const f = fixture();
    f.focus("q");
    f.run("ArrowRight");
    expect(f.toggled).toEqual([]);
    expect(f.moves).toEqual([]);
  });

  it("ArrowLeft collapses an expanded parent, and otherwise moves to the parent row", () => {
    const f = fixture();
    f.run("ArrowLeft");
    expect(f.toggled).toEqual([{ id: "p", expanded: false }]);
    f.focus("c0");
    f.run("ArrowLeft");
    expect(f.focuses).toEqual(["p"]);
  });

  it("ArrowLeft is a no-op on a top-level leaf", () => {
    const f = fixture();
    f.focus("q");
    f.run("ArrowLeft");
    expect(f.toggled).toEqual([]);
    expect(f.focuses).toEqual([]);
  });
});

describe("Enter", () => {
  it("starts editing the focused row", () => {
    const f = fixture();
    f.focus("c1");
    f.run("Enter");
    expect(f.edits).toEqual(["c1"]);
  });
});
