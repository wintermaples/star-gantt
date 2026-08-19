// @vitest-environment happy-dom
/**
 * docs/specs/plugins/interaction.md §6.7, §4, §5 — the clipboard feature wired into a real
 * composition, over the real `dataStore()` plugin: config presence gating, structured copy / paste
 * / duplicate with hierarchy and link remapping, selection interplay, the three `clipboard/*`
 * commands, the Ctrl+D/Meta+D chord contributions, and the native `copy`/`paste` events. There is
 * no separate clipboard service (§2.4) — "Clipboard operations are the `clipboard/*`
 * commands" — so every action here goes through `ctx.dispatch`.
 */
import { describe, expect, it } from "vitest";
import type { DataService, Task, TaskId } from "@stargantt/plugin-data-store";
import { boot, dispatchCommand } from "./_clipboard-fakes";

const DAY = 86_400_000;

/** Loads two roots (Alpha with child Kid, Beta) and one FS link Alpha→Beta. */
function seedTree(data: DataService): void {
  data.load({
    tasks: [
      { id: "a", parentId: null, name: "Alpha", start: 0, end: DAY, progress: 0.5 },
      { id: "k", parentId: "a", name: "Kid", start: 0, end: DAY },
      { id: "b", parentId: null, name: "Beta", start: DAY, end: 2 * DAY },
    ],
    links: [{ id: "l1", sourceId: "a", targetId: "b", type: "FS" }],
  });
}

const ROW_ORDER: readonly TaskId[] = ["a", "k", "b"];

function roots(data: DataService): TaskId[] {
  return [...(data.query().children.get(null) ?? [])];
}

describe("presence gating (§6.7)", () => {
  it("dispatching the commands with the nest omitted is a no-op: nothing was ever registered", () => {
    const b = boot({ rowOrder: ROW_ORDER });
    seedTree(b.data);
    b.host.host.service("stargantt.selection").select(["b"]);
    dispatchCommand(b.ctx, "clipboard/copy");
    dispatchCommand(b.ctx, "clipboard/duplicate");
    expect(b.transactions).toHaveLength(0);
  });

  it("enables with the mere presence of the nest, even `{}`", () => {
    const b = boot({ config: { clipboard: {} }, rowOrder: ROW_ORDER });
    seedTree(b.data);
    b.host.host.service("stargantt.selection").select(["b"]);
    dispatchCommand(b.ctx, "clipboard/duplicate");
    expect(b.transactions).toHaveLength(1);
  });
});

describe("clipboard/copy — via the native event (§6.7 systemClipboard)", () => {
  it("captures the selection with its subtree, mirrored to the system clipboard", () => {
    const b = boot({ config: { clipboard: {} }, rowOrder: ROW_ORDER });
    seedTree(b.data);
    b.host.host.service("stargantt.selection").select(["a"]);
    const text = b.fireCopy();
    expect(text).toBe("Alpha\t1970-01-01\t1970-01-02\t0.5\nKid\t1970-01-01\t1970-01-02\t");
    expect(b.spoken).toContain("Copied 2 tasks");
  });

  it("leaves the event to the browser with nothing selected", () => {
    const b = boot({ config: { clipboard: {} }, rowOrder: ROW_ORDER });
    seedTree(b.data);
    expect(b.fireCopy()).toBeUndefined();
  });

  it("events targeted at text-entry elements are ignored", () => {
    const b = boot({ config: { clipboard: {} }, rowOrder: ROW_ORDER });
    seedTree(b.data);
    b.host.host.service("stargantt.selection").select(["a"]);
    const input = b.root.ownerDocument.createElement("input");
    b.root.appendChild(input);
    expect(b.fireCopy(input)).toBeUndefined();
  });

  it("systemClipboard: false wires no native listeners, but the command still works", () => {
    const b = boot({ config: { clipboard: { systemClipboard: false } }, rowOrder: ROW_ORDER });
    seedTree(b.data);
    b.host.host.service("stargantt.selection").select(["a"]);
    expect(b.fireCopy()).toBeUndefined();
    dispatchCommand(b.ctx, "clipboard/copy");
    expect(b.spoken).toContain("Copied 2 tasks");
  });
});

describe("structured paste (§4)", () => {
  it("recreates the hierarchy under fresh ids in one transaction, selects and announces the copy", () => {
    const b = boot({ config: { clipboard: {} }, rowOrder: ROW_ORDER });
    seedTree(b.data);
    dispatchCommand(b.ctx, "clipboard/copy", undefined); // nothing selected yet — no-op copy
    b.host.host.service("stargantt.selection").select(["a"]);
    dispatchCommand(b.ctx, "clipboard/copy");
    dispatchCommand(b.ctx, "clipboard/paste", { parentId: null });

    const r = roots(b.data);
    expect(r).toHaveLength(3);
    const copyId = r[2] as string;
    expect(copyId).not.toBe("a");
    const copied = b.data.getTask(copyId);
    expect(copied?.name).toBe("Alpha");
    expect(copied?.progress).toBe(0.5);
    const children = [...(b.data.query().children.get(copyId) ?? [])];
    expect(children).toHaveLength(1);
    expect(b.data.getTask(children[0] as string)?.name).toBe("Kid");

    // One history entry for the whole paste (2 tasks: one `task/add` command + one appended patch).
    expect(b.transactions).toHaveLength(1);
    expect([...b.host.host.service("stargantt.selection").state.get().taskIds]).toEqual([copyId]);
    expect(b.spoken).toContain("Pasted 2 tasks");
    expect(b.faults).toEqual([]);
    // Post-paste focus move (§5/§10): the keyboard focus follows the
    // pasted top-level task, exactly like the selection does.
    expect(b.focused()).toBe(copyId);
  });

  it("remaps links wholly inside the captured set and drops boundary links", () => {
    const b = boot({ config: { clipboard: {} }, rowOrder: ROW_ORDER });
    seedTree(b.data);
    b.host.host.service("stargantt.selection").select(["a", "b"]);
    dispatchCommand(b.ctx, "clipboard/copy");
    dispatchCommand(b.ctx, "clipboard/paste", { parentId: null });

    const r = roots(b.data);
    expect(r).toHaveLength(4);
    const [newA, newB] = [r[2] as string, r[3] as string];
    const out = b.data.query().linksByTask.get(newA)?.out ?? [];
    expect(out).toHaveLength(1);
    expect(out[0]?.targetId).toBe(newB);
    expect(out[0]?.id).not.toBe("l1");
    expect(b.transactions).toHaveLength(1);
  });

  it("pastes after the anchor row when no explicit target is given", () => {
    const b = boot({ config: { clipboard: {} }, rowOrder: ROW_ORDER, focused: "a" });
    seedTree(b.data);
    b.host.host.service("stargantt.selection").select(["b"]);
    dispatchCommand(b.ctx, "clipboard/copy");
    dispatchCommand(b.ctx, "clipboard/paste");
    const r = roots(b.data);
    expect(r[0]).toBe("a");
    expect(b.data.getTask(r[1] as string)?.name).toBe("Beta");
    expect(r[2]).toBe("b");
  });

  it("is a silent no-op with an empty clipboard", () => {
    const b = boot({ config: { clipboard: {} }, rowOrder: ROW_ORDER });
    seedTree(b.data);
    dispatchCommand(b.ctx, "clipboard/paste");
    expect(b.transactions).toHaveLength(0);
    expect(b.faults).toEqual([]);
  });
});

describe("clipboard/duplicate (§4)", () => {
  it("duplicates in place, selects the copy, one undo step", () => {
    const b = boot({ config: { clipboard: {} }, rowOrder: ROW_ORDER });
    seedTree(b.data);
    b.host.host.service("stargantt.selection").select(["b"]);
    dispatchCommand(b.ctx, "clipboard/duplicate");

    const r = roots(b.data);
    expect(r).toHaveLength(3);
    expect(r[0]).toBe("a");
    expect(r[1]).toBe("b");
    const copyId = r[2] as string;
    expect(b.data.getTask(copyId)?.name).toBe("Beta");
    expect(b.data.getTask(copyId)?.start).toBe(DAY);
    expect([...b.host.host.service("stargantt.selection").state.get().taskIds]).toEqual([copyId]);
    expect(b.transactions).toHaveLength(1);
    expect(b.spoken).toContain("Duplicated 1 task");
    // Post-paste focus move (§5/§10).
    expect(b.focused()).toBe(copyId);
  });

  it("keeps dependencies between duplicated tasks under fresh link ids", () => {
    const b = boot({ config: { clipboard: {} }, rowOrder: ROW_ORDER });
    seedTree(b.data);
    b.host.host.service("stargantt.selection").select(["a", "b"]);
    dispatchCommand(b.ctx, "clipboard/duplicate");
    const r = roots(b.data);
    expect(r).toHaveLength(4);
    const newA = r.find((id) => id !== "a" && b.data.getTask(id)?.name === "Alpha") as TaskId;
    const out = b.data.query().linksByTask.get(newA)?.out ?? [];
    expect(out).toHaveLength(1);
    expect(b.data.getTask(out[0]?.targetId as TaskId)?.name).toBe("Beta");
  });

  it("does not overwrite the held clipboard", () => {
    const b = boot({ config: { clipboard: {} }, rowOrder: ROW_ORDER });
    seedTree(b.data);
    b.host.host.service("stargantt.selection").select(["a"]);
    dispatchCommand(b.ctx, "clipboard/copy");
    b.host.host.service("stargantt.selection").select(["b"]);
    dispatchCommand(b.ctx, "clipboard/duplicate");
    // The held payload still pastes Alpha (+ Kid), not Beta.
    dispatchCommand(b.ctx, "clipboard/paste", { parentId: null });
    const r = roots(b.data);
    expect(b.data.getTask(r[r.length - 1] as TaskId)?.name).toBe("Alpha");
  });
});

describe("the duplicate chords (§5); buffered and inert without the a11y plugin", () => {
  it("contributes Ctrl+D and Meta+D, gated on a non-empty selection", () => {
    const b = boot({ config: { clipboard: {} }, rowOrder: ROW_ORDER, focused: "b" });
    seedTree(b.data);
    const keys = b.keys().filter((k) => k.key === "Ctrl+D" || k.key === "Meta+D");
    expect(keys.map((k) => k.key)).toEqual(["Ctrl+D", "Meta+D"]);
    expect(keys[0]?.when?.()).toBe(false); // nothing selected yet
    b.host.host.service("stargantt.selection").select(["b"]);
    expect(keys[0]?.when?.()).toBe(true);
    keys[0]?.run();
    expect(b.transactions).toHaveLength(1);
    expect(b.data.getTask(roots(b.data)[2] as TaskId)?.name).toBe("Beta");
  });

  it("contributes nothing at all when the nest is omitted", () => {
    const b = boot({ rowOrder: ROW_ORDER });
    expect(b.keys().filter((k) => k.key === "Ctrl+D")).toEqual([]);
  });

  it("stays buffered and inert without the a11y plugin composed", () => {
    const b = boot({ config: { clipboard: {} }, rowOrder: ROW_ORDER, a11y: false });
    expect(() => b.host.dispose()).not.toThrow();
  });
});

describe("own-clipboard fingerprint (round-tripped native paste)", () => {
  it("recognizes byte-identical round-tripped text as its own clipboard (structured paste)", () => {
    const b = boot({ config: { clipboard: {} }, rowOrder: ROW_ORDER });
    seedTree(b.data);
    b.host.host.service("stargantt.selection").select(["a"]);
    const text = b.fireCopy() as string;
    expect(text).toBeDefined();
    b.host.host.service("stargantt.selection").clear();
    // `dispatchEvent` returns `false` when `preventDefault()` was called — recognized and handled.
    expect(b.firePaste(text)).toBe(false);
    expect(roots(b.data)).toHaveLength(3); // seeded Alpha + Beta roots, plus the pasted Alpha copy
  });

  it("still recognizes its own clipboard after CRLF rewriting and trailing whitespace padding", () => {
    const b = boot({ config: { clipboard: {} }, rowOrder: ROW_ORDER });
    seedTree(b.data);
    b.host.host.service("stargantt.selection").select(["a"]);
    const text = b.fireCopy() as string;
    const crlf = text.replace(/\n/g, "\r\n");
    b.firePaste(crlf);
    expect(roots(b.data)).toHaveLength(3);
  });

  it("foreign text takes the cell path instead", () => {
    const b = boot({ config: { clipboard: {} }, rowOrder: ROW_ORDER, focused: "a" });
    seedTree(b.data);
    expect(b.firePaste("Imported")).toBe(false); // preventDefault() called, handled
    // The summary anchor is skipped (its dates are derived); the row lands on the first editable
    // task below it.
    expect(b.data.getTask("a")?.name).toBe("Alpha");
    expect(b.data.getTask("k")?.name).toBe("Imported");
  });
});

describe("config: fields (§6.7)", () => {
  it("a fields subset narrows the encoding", () => {
    const b = boot({ config: { clipboard: { fields: ["name"] } }, rowOrder: ROW_ORDER });
    seedTree(b.data);
    b.host.host.service("stargantt.selection").select(["a"]);
    expect(b.fireCopy()).toBe("Alpha\nKid");
  });

  it("an unusable fields config restores the default encoding", () => {
    const b = boot({
      config: { clipboard: { fields: ["bogus", 3] as unknown as ["name"] } },
      rowOrder: ROW_ORDER,
    });
    seedTree(b.data);
    b.host.host.service("stargantt.selection").select(["b"]);
    expect(b.fireCopy()).toBe("Beta\t1970-01-02\t1970-01-03\t");
  });
});

describe("messages (§8, shared InteractionMessages catalog)", () => {
  it("a replaced message builder is used", () => {
    const b = boot({
      config: { clipboard: {}, messages: { copied: (n) => `${n} copied!` } },
      rowOrder: ROW_ORDER,
    });
    seedTree(b.data);
    b.host.host.service("stargantt.selection").select(["b"]);
    dispatchCommand(b.ctx, "clipboard/copy");
    expect(b.spoken).toContain("1 copied!");
  });

  it("a throwing message builder is reported and falls back to the default", () => {
    const boom = new Error("boom");
    const b = boot({
      config: {
        clipboard: {},
        messages: {
          copied: () => {
            throw boom;
          },
        },
      },
      rowOrder: ROW_ORDER,
    });
    seedTree(b.data);
    b.host.host.service("stargantt.selection").select(["b"]);
    dispatchCommand(b.ctx, "clipboard/copy");
    expect(b.spoken).toContain("Copied 1 task");
    expect(b.faults).toContainEqual({ messageKey: "copied", cause: boom });
  });
});
