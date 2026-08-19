import { describe, expect, it } from "vitest";
import { DEFAULT_LIMIT, History } from "../src/history";
import { tx, updatePatch } from "./_helpers";

describe("History — stack bookkeeping", () => {
  it("defaults to a limit of 200", () => {
    expect(DEFAULT_LIMIT).toBe(200);
    expect(new History().limit).toBe(200);
  });

  it("starts empty", () => {
    const h = new History();
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(false);
  });

  it("records a transaction and exposes it for undo", () => {
    const h = new History();
    h.record(tx({ id: "x", label: "Add task" }));
    expect(h.canUndo()).toBe(true);
    expect(h.undoEntries()).toHaveLength(1);
    expect(h.undoEntries()[0]?.label).toBe("Add task");
  });

  it("copies the patch list, so later `will`-handler appends cannot rewrite history", () => {
    const h = new History();
    const t = tx();
    h.record(t);
    t.patches.push(updatePatch("a", { start: 0 }, { start: 5 }));
    expect(h.undoEntries()[0]?.patches).toHaveLength(1);
  });

  it("drops the oldest entry beyond the configured limit", () => {
    const h = new History(3);
    for (let i = 0; i < 5; i++) h.record(tx({ id: `t${String(i)}`, label: `L${String(i)}` }));
    expect(h.undoEntries().map((e) => e.label)).toEqual(["L2", "L3", "L4"]);
  });

  it("clamps a non-positive limit to one entry", () => {
    expect(new History(0).limit).toBe(1);
    expect(new History(-5).limit).toBe(1);
  });

  it("merges consecutive entries that share a coalesceKey", () => {
    const h = new History();
    h.record(tx({ id: "a", label: "Move task", coalesceKey: "drag-1" }));
    h.record(tx({ id: "b", label: "Move task", coalesceKey: "drag-1" }));
    expect(h.undoEntries()).toHaveLength(1);
    expect(h.undoEntries()[0]?.patches).toHaveLength(2);
    expect(h.undoEntries()[0]?.id).toBe("a");
  });

  it("does not merge when the coalesceKey differs or is absent", () => {
    const h = new History();
    h.record(tx({ id: "a", coalesceKey: "drag-1" }));
    h.record(tx({ id: "b", coalesceKey: "drag-2" }));
    h.record(tx({ id: "c" }));
    h.record(tx({ id: "d" }));
    expect(h.undoEntries()).toHaveLength(4);
  });

  it("only merges with the *previous* entry", () => {
    const h = new History();
    h.record(tx({ id: "a", coalesceKey: "k" }));
    h.record(tx({ id: "b" }));
    h.record(tx({ id: "c", coalesceKey: "k" }));
    expect(h.undoEntries().map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("moves entries between the undo and redo stacks", () => {
    const h = new History();
    h.record(tx({ id: "a" }));
    expect(h.popUndo()?.id).toBe("a");
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(true);
    expect(h.popRedo()?.id).toBe("a");
    expect(h.canUndo()).toBe(true);
    expect(h.canRedo()).toBe(false);
  });

  it("returns undefined when a stack is empty", () => {
    const h = new History();
    expect(h.popUndo()).toBeUndefined();
    expect(h.popRedo()).toBeUndefined();
  });

  it("a new recording invalidates the redo stack", () => {
    const h = new History();
    h.record(tx({ id: "a" }));
    h.popUndo();
    expect(h.canRedo()).toBe(true);
    h.record(tx({ id: "b" }));
    expect(h.canRedo()).toBe(false);
  });

  it("clear() empties both stacks", () => {
    const h = new History();
    h.record(tx({ id: "a" }));
    h.record(tx({ id: "b" }));
    h.popUndo();
    h.clear();
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(false);
  });
});

describe("History — label introspection", () => {
  it("peekUndo/peekRedo return undefined on an empty history", () => {
    const h = new History();
    expect(h.peekUndo()).toBeUndefined();
    expect(h.peekRedo()).toBeUndefined();
  });

  it("peekUndo returns the label of the entry the next undo() would revert", () => {
    const h = new History();
    h.record(tx({ id: "a", label: "Add task" }));
    h.record(tx({ id: "b", label: "Move task" }));
    expect(h.peekUndo()).toBe("Move task");
  });

  it("peekRedo returns the label of the entry the next redo() would re-apply", () => {
    const h = new History();
    h.record(tx({ id: "a", label: "Add task" }));
    h.record(tx({ id: "b", label: "Move task" }));
    h.popUndo();
    expect(h.peekRedo()).toBe("Move task");
  });

  it("undoLabels() lists labels next-step-first, oldest last", () => {
    const h = new History();
    h.record(tx({ id: "a", label: "First" }));
    h.record(tx({ id: "b", label: "Second" }));
    h.record(tx({ id: "c", label: "Third" }));
    expect(h.undoLabels()).toEqual(["Third", "Second", "First"]);
  });

  it("redoLabels() lists labels next-step-first onward", () => {
    const h = new History();
    h.record(tx({ id: "a", label: "First" }));
    h.record(tx({ id: "b", label: "Second" }));
    h.record(tx({ id: "c", label: "Third" }));
    h.popUndo();
    h.popUndo();
    expect(h.redoLabels()).toEqual(["Second", "Third"]);
  });

  it("undoLabels()/redoLabels() are empty on an empty history", () => {
    const h = new History();
    expect(h.undoLabels()).toEqual([]);
    expect(h.redoLabels()).toEqual([]);
  });

  it("a merged entry contributes one label (the first entry's), not two", () => {
    const h = new History();
    h.record(tx({ id: "a", label: "Move task", coalesceKey: "drag-1" }));
    h.record(tx({ id: "b", label: "Move task (2)", coalesceKey: "drag-1" }));
    expect(h.undoLabels()).toEqual(["Move task"]);
  });
});

describe("History — onChange callback", () => {
  it("fires once per record() call, whether a plain push or a coalescing merge", () => {
    let calls = 0;
    const h = new History(200, () => {
      calls++;
    });
    h.record(tx({ id: "a", coalesceKey: "k" }));
    expect(calls).toBe(1);
    h.record(tx({ id: "b", coalesceKey: "k" }));
    expect(calls).toBe(2);
  });

  it("fires on limit-eviction as part of the same record() call, not twice", () => {
    let calls = 0;
    const h = new History(1, () => {
      calls++;
    });
    h.record(tx({ id: "a" }));
    h.record(tx({ id: "b" }));
    expect(calls).toBe(2);
    expect(h.undoEntries()).toHaveLength(1);
  });

  it("fires on popUndo() and popRedo()", () => {
    let calls = 0;
    const h = new History(200, () => {
      calls++;
    });
    h.record(tx({ id: "a" }));
    expect(calls).toBe(1);
    h.popUndo();
    expect(calls).toBe(2);
    h.popRedo();
    expect(calls).toBe(3);
  });

  it("does not fire when popUndo()/popRedo() find an empty stack", () => {
    let calls = 0;
    const h = new History(200, () => {
      calls++;
    });
    expect(h.popUndo()).toBeUndefined();
    expect(h.popRedo()).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("fires on clear()", () => {
    let calls = 0;
    const h = new History(200, () => {
      calls++;
    });
    h.record(tx({ id: "a" }));
    calls = 0;
    h.clear();
    expect(calls).toBe(1);
  });

  it("defaults to a no-op callback when none is given", () => {
    const h = new History();
    // Must not throw with no callback supplied.
    expect(() => {
      h.record(tx({ id: "a" }));
      h.popUndo();
      h.clear();
    }).not.toThrow();
  });

  it("reset() empties both stacks without firing the callback", () => {
    let calls = 0;
    const h = new History(200, () => {
      calls++;
    });
    h.record(tx({ id: "a" }));
    h.record(tx({ id: "b" }));
    h.popUndo();
    calls = 0;
    h.reset();
    expect(calls).toBe(0);
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(false);
  });
});

// docs/specs/plugins/undo-redo.md "Snapshot serialize/restore"
describe("History — serialize()/restore()", () => {
  it("serialize() carries a version and both stacks in JSON-safe form", () => {
    const h = new History();
    h.record(tx({ id: "a", label: "Add task" }));
    h.record(tx({ id: "b", label: "Move task" }));
    h.popUndo();

    const snap = h.serialize();
    expect(snap.version).toBe(1);
    expect(snap.undo.map((e) => e.id)).toEqual(["a"]);
    expect(snap.redo.map((e) => e.id)).toEqual(["b"]);
    // Round-trips through JSON with nothing lost or turned into a class instance.
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
  });

  it("restore() replaces both stacks and fires the change callback exactly once", () => {
    const source = new History();
    source.record(tx({ id: "a", label: "Add task" }));
    source.record(tx({ id: "b", label: "Move task" }));
    source.popUndo();
    const snap = source.serialize();

    let calls = 0;
    const target = new History(200, () => {
      calls++;
    });
    const ok = target.restore(snap);

    expect(ok).toBe(true);
    expect(calls).toBe(1);
    expect(target.undoEntries().map((e) => e.id)).toEqual(["a"]);
    expect(target.redoEntries().map((e) => e.id)).toEqual(["b"]);
  });

  it("restore() through a JSON string round trip reproduces the same stacks", () => {
    const source = new History();
    source.record(tx({ id: "a", label: "Add", coalesceKey: "k" }));
    source.record(tx({ id: "b", label: "Add again", coalesceKey: "k" }));
    const wire = JSON.stringify(source.serialize());

    const target = new History();
    expect(target.restore(JSON.parse(wire) as unknown)).toBe(true);
    expect(target.undoEntries()).toEqual(source.undoEntries());
  });

  it("restore() enforces the target's own configured limit on the restored undo stack", () => {
    const source = new History();
    for (let i = 0; i < 5; i++) source.record(tx({ id: `t${String(i)}`, label: `L${String(i)}` }));
    const snap = source.serialize();

    const target = new History(2);
    target.restore(snap);
    expect(target.undoEntries().map((e) => e.label)).toEqual(["L3", "L4"]);
  });

  it("rejects a non-object value wholesale, leaving history untouched", () => {
    for (const bad of [null, undefined, "snapshot", 42, [], true]) {
      let calls = 0;
      const h = new History(200, () => {
        calls++;
      });
      h.record(tx({ id: "keep" }));
      calls = 0;

      expect(h.restore(bad)).toBe(false);
      expect(calls).toBe(0);
      expect(h.undoEntries().map((e) => e.id)).toEqual(["keep"]);
    }
  });

  it("rejects a snapshot with the wrong version, leaving history untouched", () => {
    const source = new History();
    source.record(tx({ id: "a" }));
    const snap = { ...source.serialize(), version: 2 };

    let calls = 0;
    const target = new History(200, () => {
      calls++;
    });
    target.record(tx({ id: "keep" }));
    calls = 0;

    expect(target.restore(snap)).toBe(false);
    expect(calls).toBe(0);
    expect(target.undoEntries().map((e) => e.id)).toEqual(["keep"]);
  });

  it("rejects a snapshot missing a stack, leaving history untouched", () => {
    const target = new History();
    target.record(tx({ id: "keep" }));

    expect(target.restore({ version: 1, undo: [] })).toBe(false);
    expect(target.restore({ version: 1, redo: [] })).toBe(false);
    expect(target.undoEntries().map((e) => e.id)).toEqual(["keep"]);
  });

  it("rejects a snapshot whose entry carries a malformed patch, leaving history untouched", () => {
    const target = new History();
    target.record(tx({ id: "keep" }));

    // "task/add" requires a `task` object; this entry has none.
    const malformed = {
      version: 1,
      undo: [{ id: "x", label: "Bad", patches: [{ op: "task/add" }] }],
      redo: [],
    };
    expect(target.restore(malformed)).toBe(false);
    expect(target.undoEntries().map((e) => e.id)).toEqual(["keep"]);

    // Same, but the malformed entry sits in `redo`.
    const malformed2 = {
      version: 1,
      undo: [],
      redo: [{ id: "x", label: "Bad", patches: [{ op: "task/update", id: "a" }] }],
    };
    expect(target.restore(malformed2)).toBe(false);
    expect(target.undoEntries().map((e) => e.id)).toEqual(["keep"]);
  });

  it("rejects an entry with a non-string label or id, or a non-array patches list", () => {
    const target = new History();
    target.record(tx({ id: "keep" }));

    const cases: unknown[] = [
      { version: 1, undo: [{ id: 1, label: "L", patches: [] }], redo: [] },
      { version: 1, undo: [{ id: "x", label: 5, patches: [] }], redo: [] },
      { version: 1, undo: [{ id: "x", label: "L", patches: "nope" }], redo: [] },
      { version: 1, undo: [{ id: "x", label: "L" }], redo: [] },
      { version: 1, undo: "nope", redo: [] },
    ];
    for (const bad of cases) {
      expect(target.restore(bad)).toBe(false);
    }
    expect(target.undoEntries().map((e) => e.id)).toEqual(["keep"]);
  });
});

// docs/specs/plugins/undo-redo.md "Coalescing and net-zero compression" — a coalesced
// entry whose merged patches have net-zero effect is dropped from the history.
describe("History — net-zero coalesced entries", () => {
  const move = (id: string, key: string, from: number, to: number) =>
    tx({
      id,
      label: "Move task",
      coalesceKey: key,
      patches: [updatePatch("a", { start: from, end: from + 5 }, { start: to, end: to + 5 })],
    });

  it("drops the entry when a liveUpdate drag returns to its origin", () => {
    let changes = 0;
    const h = new History(200, () => void (changes += 1));
    h.record(move("a", "drag-1", 0, 10)); // first live commit
    h.record(move("b", "drag-1", 10, 20)); // further along
    h.record(move("c", "drag-1", 20, 0)); // released back at the origin
    expect(h.undoEntries()).toHaveLength(0);
    expect(h.canUndo()).toBe(false);
    // The drop itself notified, like any other stack change.
    expect(changes).toBe(3);
  });

  it("keeps a coalesced run that ends somewhere else (normal drags unaffected)", () => {
    const h = new History();
    h.record(move("a", "drag-1", 0, 10));
    h.record(move("b", "drag-1", 10, 5));
    expect(h.undoEntries()).toHaveLength(1);
    expect(h.undoEntries()[0]?.patches).toHaveLength(2);
  });

  it("never drops a non-coalesced entry, even a self-identical one", () => {
    const h = new History();
    h.record(tx({ id: "a", patches: [updatePatch("a", { start: 0 }, { start: 0 })] }));
    expect(h.undoEntries()).toHaveLength(1);
  });

  it("keeps a merged run containing an add/remove patch (conservative)", () => {
    const h = new History();
    h.record(tx({ id: "a", coalesceKey: "k" })); // default patches: task/add
    h.record(tx({ id: "b", coalesceKey: "k", patches: [] }));
    expect(h.undoEntries()).toHaveLength(1);
  });

  it("a fresh gesture after a dropped one starts its own entry normally", () => {
    const h = new History();
    h.record(move("a", "drag-1", 0, 10));
    h.record(move("b", "drag-1", 10, 0)); // dropped: net zero
    expect(h.undoEntries()).toHaveLength(0);
    h.record(move("c", "drag-2", 0, 7));
    expect(h.undoEntries()).toHaveLength(1);
    expect(h.undoEntries()[0]?.id).toBe("c");
  });
});
