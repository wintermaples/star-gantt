import { describe, expect, it } from "vitest";
import { undoRedo } from "../src/index";
import type { UndoRedoConfig, UndoRedoMessages } from "../src/types";
import { fakePluginContext } from "./_fake-context";
import { bindingsCollector, focusStub, makeTask, start } from "./_helpers";
import type { KeyBindingLike } from "./_helpers";

/**
 * Runs the plugin's `setup` against a stub context and returns its `keys/bindings` contributions,
 * in contribution order.
 */
function bindingsOf(config?: Parameters<typeof undoRedo>[0]): KeyBindingLike[] {
  const { ctx, contributionsTo } = fakePluginContext();
  undoRedo(config).setup(ctx, undefined);
  return contributionsTo("keys/bindings") as KeyBindingLike[];
}

describe("plugin identity", () => {
  it("declares the spec plugin id and its data-store dependency", () => {
    const plugin = undoRedo();
    expect(plugin.meta.id).toBe("stargantt.undo-redo");
    expect(plugin.meta.dependsOn).toEqual(["stargantt.data-store"]);
  });

  // docs/specs/plugins/undo-redo.md "Dependencies" — the a11y plugin's `stargantt.focus` is a soft
  // dependency: it is used to speak the outcome of a history step, and `optional` is what grants
  // the late `ctx.useOptional` lookup permission.
  it("declares the a11y plugin as a soft dependency", () => {
    expect(undoRedo().meta.optional).toEqual(["stargantt.a11y"]);
  });

  it("is a factory: each call produces a fresh plugin object", () => {
    expect(undoRedo()).not.toBe(undoRedo());
    expect(typeof undoRedo({ limit: 5 }).setup).toBe("function");
  });

  it("registers exactly the keys its declaration merging declares", () => {
    const { ctx, log } = fakePluginContext();

    undoRedo().setup(ctx, undefined);

    expect(log.provided.map((p) => p.key)).toEqual(["stargantt.history"]);
    expect(log.registered.map((r) => r.key).sort()).toEqual(["history/redo", "history/undo"]);
    expect(new Set(log.contributed.map((c) => c.key))).toEqual(new Set(["keys/bindings"]));
    expect(log.defined).toEqual([]);
    // Recording consumes `data/didApplyTransaction` directly (docs/specs/plugins/undo-redo.md
    // "Recording"); this plugin calls `ctx.use()`/`ctx.useOptional()` for nothing at `setup()` —
    // `stargantt.focus` is looked up only lazily, inside `undo()`/`redo()`.
    expect(log.used).toEqual([]);
    expect(log.usedOptional).toEqual([]);
  });

  it("contributes the default `keys/bindings` entries wired to undo and redo", () => {
    const bindings = bindingsOf();

    expect(bindings.map((b) => b.key)).toEqual([
      "Ctrl+Z",
      "Meta+Z",
      "Ctrl+Shift+Z",
      "Meta+Shift+Z",
      "Ctrl+Y",
    ]);
    for (const b of bindings) expect(typeof b.run).toBe("function");
    // Bindings on an empty history are inert, not throwing.
    for (const b of bindings) expect(() => b.run()).not.toThrow();
  });

  it("registers every resource it holds through ctx.own (CLAUDE.md constraint)", () => {
    const { ctx, log } = fakePluginContext();

    undoRedo().setup(ctx, undefined);

    // `data/didApplyTransaction` is the sole event edge (docs/specs/plugins/undo-redo.md
    // "Recording" / "Events" — `data/willApplyTransaction` is not consumed); the subscription is
    // auto-owned by `ctx.on` itself (docs/specs/architecture.md §1.4), so wrapping it again would
    // double-register. The one explicit `ctx.own()` call is the history teardown.
    expect(log.subscribed.map((s) => s.key)).toEqual(["data/didApplyTransaction"]);
    expect(log.owned).toHaveLength(1);
  });
});

// docs/specs/plugins/undo-redo.md "Config"
describe("`keys`", () => {
  it("binds both platform families out of the box", () => {
    expect(bindingsOf().map((b) => b.key)).toEqual([
      "Ctrl+Z",
      "Meta+Z",
      "Ctrl+Shift+Z",
      "Meta+Shift+Z",
      "Ctrl+Y",
    ]);
    expect(bindingsOf({}).map((b) => b.key)).toEqual(bindingsOf().map((b) => b.key));
    expect(bindingsOf({ keys: {} }).map((b) => b.key)).toEqual(bindingsOf().map((b) => b.key));
  });

  it("a given list replaces its default in full, leaving the other default alone", () => {
    expect(bindingsOf({ keys: { undo: ["Alt+Backspace"] } }).map((b) => b.key)).toEqual([
      "Alt+Backspace",
      "Ctrl+Shift+Z",
      "Meta+Shift+Z",
      "Ctrl+Y",
    ]);
    expect(bindingsOf({ keys: { redo: ["F4"] } }).map((b) => b.key)).toEqual([
      "Ctrl+Z",
      "Meta+Z",
      "F4",
    ]);
  });

  it("an empty list leaves that operation with no chord", () => {
    expect(bindingsOf({ keys: { undo: [] } }).map((b) => b.key)).toEqual([
      "Ctrl+Shift+Z",
      "Meta+Shift+Z",
      "Ctrl+Y",
    ]);
    expect(bindingsOf({ keys: { undo: [], redo: [] } })).toEqual([]);
  });

  it("wires each configured chord to the operation it names", () => {
    const collector = bindingsCollector();
    const { gantt, data, history } = start({ keys: { undo: ["U"], redo: ["R"] } }, [
      collector.plugin,
    ]);
    try {
      expect(collector.bindings().map((b) => b.key)).toEqual(["U", "R"]);

      gantt.dispatch("task/add", { task: makeTask("a") });
      expect(data.toJSON().tasks.length).toBe(1);
      history.undo();
      expect(data.toJSON().tasks.length).toBe(0);
      history.redo();
      expect(data.toJSON().tasks.length).toBe(1);
    } finally {
      gantt.dispose();
    }
  });

  it("commands stay reachable even with every chord removed", () => {
    const { gantt, data, history } = start({ keys: { undo: [], redo: [] } });
    try {
      gantt.dispatch("task/add", { task: makeTask("a") });
      gantt.dispatch("history/undo", undefined);
      expect(data.toJSON().tasks.length).toBe(0);
      gantt.dispatch("history/redo", undefined);
      expect(data.toJSON().tasks.length).toBe(1);
      expect(history.state.get().canUndo).toBe(true);
    } finally {
      gantt.dispose();
    }
  });
});

// docs/specs/plugins/undo-redo.md "Config" — a limit that is not a positive finite integer is
// ignored, so the 200-step default stands.
describe("`limit`", () => {
  function depth(config?: Parameters<typeof undoRedo>[0]): number {
    const { gantt, history } = start(config);
    try {
      for (let i = 0; i < 5; i += 1) gantt.dispatch("task/add", { task: makeTask(`t${String(i)}`) });
      let undone = 0;
      while (history.state.get().canUndo) {
        history.undo();
        undone += 1;
      }
      return undone;
    } finally {
      gantt.dispose();
    }
  }

  it("keeps every step within the configured limit", () => {
    expect(depth({ limit: 2 })).toBe(2);
  });

  it("keeps all five steps with the default limit", () => {
    expect(depth()).toBe(5);
  });

  it("ignores a limit that is not a positive finite integer", () => {
    expect(depth({ limit: 0 })).toBe(5);
    expect(depth({ limit: -3 })).toBe(5);
    expect(depth({ limit: 2.5 })).toBe(5);
    expect(depth({ limit: Number.NaN })).toBe(5);
    expect(depth({ limit: Number.POSITIVE_INFINITY })).toBe(5);
  });
});

// docs/specs/plugins/undo-redo.md "Replay" — what an undo did is visible on the chart but says
// nothing to a screen reader; the outcome is spoken through whatever plugin owns the keyboard
// focus.
describe("announcing the outcome of a history step", () => {
  it("speaks after an undo and after a redo", () => {
    const spoken: string[] = [];
    const { gantt, history } = start(undefined, [focusStub(spoken)]);
    try {
      gantt.dispatch("task/add", { task: makeTask("a") });
      history.undo();
      expect(spoken).toEqual(["Undone"]);
      history.redo();
      expect(spoken).toEqual(["Undone", "Redone"]);
    } finally {
      gantt.dispose();
    }
  });

  it("stays silent when there was nothing to undo or redo", () => {
    const spoken: string[] = [];
    const { gantt, history } = start(undefined, [focusStub(spoken)]);
    try {
      history.undo();
      history.redo();
      expect(spoken).toEqual([]);
    } finally {
      gantt.dispose();
    }
  });

  it("works unchanged in a composition with no focus owner", () => {
    const { gantt, history } = start();
    try {
      gantt.dispatch("task/add", { task: makeTask("a") });
      expect(() => history.undo()).not.toThrow();
      expect(history.state.get().canRedo).toBe(true);
    } finally {
      gantt.dispose();
    }
  });
});

// docs/specs/plugins/undo-redo.md "Messages" — the announcements are a replaceable catalog, and
// omitting `messages` reproduces the English defaults byte for byte.
describe("the announcement catalog", () => {
  /** Runs one undo and one redo over a single added task, returning what was spoken. */
  function speak(config?: UndoRedoConfig): string[] {
    const spoken: string[] = [];
    const { gantt, history } = start(config, [focusStub(spoken)]);
    try {
      gantt.dispatch("task/add", { task: makeTask("a") });
      history.undo();
      history.redo();
      return spoken;
    } finally {
      gantt.dispose();
    }
  }

  it("keeps the English defaults with no messages, or an empty catalog", () => {
    expect(speak()).toEqual(["Undone", "Redone"]);
    expect(speak({})).toEqual(["Undone", "Redone"]);
    expect(speak({ messages: {} })).toEqual(["Undone", "Redone"]);
  });

  it("replaces only the keys it is given, per key", () => {
    expect(speak({ messages: { undone: "Rückgängig" } })).toEqual(["Rückgängig", "Redone"]);
    expect(speak({ messages: { redone: "Wiederholt" } })).toEqual(["Undone", "Wiederholt"]);
    expect(speak({ messages: { undone: "A", redone: "B" } })).toEqual(["A", "B"]);
  });

  it("suppresses an announcement set to the empty string, leaving the region untouched", () => {
    // Not an announcement of blank text: nothing reaches the live region for that step at all.
    expect(speak({ messages: { undone: "" } })).toEqual(["Redone"]);
    expect(speak({ messages: { undone: "", redone: "" } })).toEqual([]);
  });

  it("ignores a member that is not a string and keeps its default", () => {
    expect(speak({ messages: { undone: 42 as unknown as string } })).toEqual(["Undone", "Redone"]);
    expect(
      speak({ messages: { redone: undefined } as unknown as Partial<UndoRedoMessages> }),
    ).toEqual(["Undone", "Redone"]);
  });

  it("resolves the catalog once at setup, so mutating it afterwards changes nothing", () => {
    const messages = { undone: "first" };
    const spoken: string[] = [];
    const { gantt, history } = start({ messages }, [focusStub(spoken)]);
    try {
      gantt.dispatch("task/add", { task: makeTask("a") });
      messages.undone = "second";
      history.undo();
      expect(spoken).toEqual(["first"]);
    } finally {
      gantt.dispose();
    }
  });
});
