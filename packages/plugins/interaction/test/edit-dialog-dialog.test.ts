// @vitest-environment happy-dom
/**
 * `internal/edit-dialog/dblclick.ts` (the double-activation detector) and
 * `internal/edit-dialog/dialog.ts` (whole-form validation and the hostless dialog controller) —
 * docs/specs/plugins/interaction.md §1.1 / §6.9.
 *
 * Covers this package's shared `InteractionMessages` catalog (the `dialog*` renamed keys) and is
 * built on real DOM (happy-dom) — the chrome itself
 * (`@stargantt/sdk`'s `createDialog`) already has its own test suite (`sdk/test/dialog.test.ts`),
 * so the header-drag / Tab-trap mechanics are not re-tested here; this file exercises the
 * edit-dialog-specific behavior layered on top of that chrome.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskId } from "@stargantt/plugin-data-store";
import { DEFAULT_MESSAGES } from "../src/messages";
import { createDoubleActivation } from "../src/internal/edit-dialog/dblclick";
import { createEditDialog, validateDialog } from "../src/internal/edit-dialog/dialog";
import type { Announcer } from "../src/internal/edit-dialog/fields";
import type { EditDialogRenderContext } from "../src/internal/edit-dialog/types";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 5);

function task(over: Partial<Task> = {}): Task {
  const base: Task = {
    id: "t1",
    parentId: null,
    name: "Design",
    start: T0,
    end: T0 + 5 * DAY,
    progress: 0.4,
  };
  return Object.assign(base, over);
}

/* ------------------------------------------------------------------ *
 * The double-activation detector (§1.1)
 * ------------------------------------------------------------------ */

describe("createDoubleActivation", () => {
  it("reports a double only for the same target within the window", () => {
    let now = 0;
    const d = createDoubleActivation(400, () => now);
    expect(d.press("bar:a")).toBe(false);
    now = 100;
    expect(d.press("bar:a")).toBe(true);
  });

  it("a different target, or a press outside the window, starts a new sequence", () => {
    let now = 0;
    const d = createDoubleActivation(400, () => now);
    d.press("bar:a");
    now = 100;
    expect(d.press("row:a")).toBe(false); // same task, different surface — not a double
    now = 600;
    expect(d.press("row:a")).toBe(false); // 500ms later — outside the window
    now = 700;
    expect(d.press("row:a")).toBe(true);
  });

  it("a detected double consumes the sequence: three presses are one double", () => {
    let now = 0;
    const d = createDoubleActivation(400, () => now);
    d.press("bar:a");
    expect(d.press("bar:a")).toBe(true);
    now = 10;
    expect(d.press("bar:a")).toBe(false);
  });

  it("a non-counting press never counts and clears any pending half-double", () => {
    let now = 0;
    const d = createDoubleActivation(400, () => now);
    expect(d.press("bar:a", true)).toBe(false);
    now = 100;
    expect(d.press("bar:a", false)).toBe(false);
    now = 150;
    expect(d.press("bar:a", true)).toBe(false);
  });

  it("two counting presses double normally even with a non-counting press before them", () => {
    let now = 0;
    const d = createDoubleActivation(400, () => now);
    d.press("bar:a", true);
    now = 50;
    d.press("bar:a", false);
    now = 100;
    expect(d.press("bar:a", true)).toBe(false);
    now = 150;
    expect(d.press("bar:a", true)).toBe(true);
  });

  it("resets uniformly no matter which filter rejected the press", () => {
    let now = 0;
    const d = createDoubleActivation(400, () => now);
    expect(d.press("bar:a", true)).toBe(false);
    now = 50;
    expect(d.press("bar:a", false)).toBe(false);
    now = 100;
    expect(d.press("bar:a", false)).toBe(false);
    now = 150;
    expect(d.press("bar:a", true)).toBe(false);
    now = 200;
    expect(d.press("bar:a", true)).toBe(true);
  });

  it("reset() clears any pending half-double with no target to press", () => {
    let now = 0;
    const d = createDoubleActivation(400, () => now);
    d.press("bar:a", true);
    now = 50;
    d.reset();
    now = 100;
    expect(d.press("bar:a", true)).toBe(false);
    now = 150;
    expect(d.press("bar:a", true)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Whole-form validation (§6.9)
 * ------------------------------------------------------------------ */

describe("validateDialog", () => {
  const raw = (over: Partial<Record<"name" | "start" | "end" | "progress", string>> = {}) => ({
    name: "Design",
    start: "2026-01-05",
    end: "2026-01-10",
    progress: "0.4",
    ...over,
  });

  it("returns only the fields that differ from the task", () => {
    const r = validateDialog(task(), raw({ name: "Build", end: "2026-01-12" }));
    expect(r.invalid).toEqual([]);
    expect(r.after).toEqual({ name: "Build", end: Date.UTC(2026, 0, 12) });
  });

  it("an unchanged form yields an empty update", () => {
    const r = validateDialog(task(), raw());
    expect(r.invalid).toEqual([]);
    expect(r.after).toEqual({});
  });

  it("compares the two dates against each other, so both can move past the old range at once", () => {
    const r = validateDialog(task(), raw({ start: "2026-02-01", end: "2026-02-03" }));
    expect(r.invalid).toEqual([]);
    expect(r.after).toEqual({ start: Date.UTC(2026, 1, 1), end: Date.UTC(2026, 1, 3) });
  });

  it("rejects an inverted range on the end field with the dateOrder reason", () => {
    const r = validateDialog(task(), raw({ end: "2026-01-05" }));
    expect(r.invalid).toEqual([{ key: "end", reason: "dateOrder" }]);
    expect(r.after).toEqual({});
  });

  it("rejects unparsable dates and out-of-range progress, each with its reason", () => {
    const r = validateDialog(task(), raw({ start: "nope", progress: "1.5" }));
    expect(r.invalid).toEqual([
      { key: "start", reason: "invalidDate" },
      { key: "progress", reason: "progressRange" },
    ]);
  });

  it("rejects a calendar-invalid date (strict ISO parsing)", () => {
    // `Date.parse` would roll "2024-02-30" over to March 1; the SDK's `parseIsoDateStrict` this
    // uses rejects it outright.
    const r = validateDialog(task(), raw({ start: "2024-02-30" }));
    expect(r.invalid).toEqual([{ key: "start", reason: "invalidDate" }]);
  });
});

/* ------------------------------------------------------------------ *
 * The dialog itself, hostless (real DOM via happy-dom)
 * ------------------------------------------------------------------ */

interface DialogRig {
  root: HTMLElement;
  applied: { id: TaskId; after: Partial<Task> }[];
  announced: string[];
  faults: unknown[];
  store: Map<TaskId, Task>;
  dialog: ReturnType<typeof createEditDialog>;
  el(selector: string): HTMLElement;
  input(key: string): HTMLInputElement;
}

interface RigOptions {
  task?: Partial<Task>;
  announcer?: () => Announcer | undefined;
  renderBody?: (host: HTMLElement, ctx: EditDialogRenderContext) => void;
}

const roots: HTMLElement[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) r.remove();
});

function rig(options: RigOptions = {}): DialogRig {
  const root = document.createElement("div");
  document.body.appendChild(root);
  roots.push(root);
  const applied: { id: TaskId; after: Partial<Task> }[] = [];
  const announced: string[] = [];
  const faults: unknown[] = [];
  const store = new Map<TaskId, Task>([["t1", task(options.task ?? {})]]);
  const dialog = createEditDialog({
    host: root,
    messages: DEFAULT_MESSAGES,
    idPrefix: "sg-edit-dialog-9",
    getTask: (id) => store.get(id),
    apply: (id, after) => applied.push({ id, after }),
    announcer:
      options.announcer ?? (() => ({ announce: (m: string) => void announced.push(m) })),
    renderBody: options.renderBody,
    fault: (error) => void faults.push(error),
  });
  return {
    root,
    applied,
    announced,
    faults,
    store,
    dialog,
    el(selector: string): HTMLElement {
      const found = root.querySelector<HTMLElement>(selector);
      if (found === null) throw new Error(`no ${selector}`);
      return found;
    },
    input(key: string): HTMLInputElement {
      const found = root.querySelector<HTMLInputElement>(`#sg-edit-dialog-9-${key}`);
      if (found === null) throw new Error(`no ${key} input`);
      return found;
    },
  };
}

describe("createEditDialog", () => {
  it("opens a modal dialog prefilled from the store, with role/aria wiring and focus on the name", () => {
    const r = rig();
    expect(r.dialog.open("t1")).toBe(true);
    const box = r.el(".sg-edit-dialog");
    expect(r.dialog.isOpen).toBe(true);
    expect(box.getAttribute("role")).toBe("dialog");
    expect(box.getAttribute("aria-modal")).toBe("true");
    expect(box.getAttribute("aria-label")).toBe("Edit task");
    expect(r.input("name").value).toBe("Design");
    expect(r.input("start").value).toBe("2026-01-05");
    expect(r.input("end").value).toBe("2026-01-10");
    expect(r.input("progress").value).toBe("0.4");
    expect(document.activeElement).toBe(r.input("name"));
  });

  it("mounts a backdrop covering the root", () => {
    const r = rig();
    r.dialog.open("t1");
    const backdrop = r.el(".sg-edit-dialog__backdrop");
    expect(backdrop.style.position).toBe("absolute");
    expect(backdrop.style.inset).toBe("0");
  });

  it("opening an id the store does not know does nothing and reports it", () => {
    const r = rig();
    expect(r.dialog.open("ghost")).toBe(false);
    expect(r.dialog.isOpen).toBe(false);
    expect(r.root.querySelector(".sg-edit-dialog")).toBeNull();
  });

  it("Save commits every changed field as one apply call and closes", () => {
    const r = rig();
    r.dialog.open("t1");
    r.input("name").value = "Build";
    r.input("end").value = "2026-01-12";
    r.el(".sg-edit-dialog-save").click();
    expect(r.applied).toEqual([{ id: "t1", after: { name: "Build", end: Date.UTC(2026, 0, 12) } }]);
    expect(r.dialog.isOpen).toBe(false);
    expect(r.root.querySelector(".sg-edit-dialog")).toBeNull();
  });

  it("Save with nothing changed closes without any apply call", () => {
    const r = rig();
    r.dialog.open("t1");
    r.el(".sg-edit-dialog-save").click();
    expect(r.applied).toEqual([]);
    expect(r.dialog.isOpen).toBe(false);
  });

  it("Cancel and Escape each close without applying", () => {
    for (const dismiss of [
      (r: DialogRig): void => r.el(".sg-edit-dialog-cancel").click(),
      (r: DialogRig): void => {
        r.el(".sg-edit-dialog__backdrop").dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
      },
    ]) {
      const r = rig();
      r.dialog.open("t1");
      r.input("name").value = "discarded";
      dismiss(r);
      expect(r.dialog.isOpen).toBe(false);
      expect(r.applied).toEqual([]);
    }
  });

  it("a press on the dim backdrop (not the box) closes without applying", () => {
    const r = rig();
    r.dialog.open("t1");
    const backdrop = r.el(".sg-edit-dialog__backdrop");
    backdrop.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(r.dialog.isOpen).toBe(false);
  });

  it("an invalid Save keeps the dialog open, marks the fields with cause text, and announces once", () => {
    const r = rig();
    r.dialog.open("t1");
    r.input("end").value = "2026-01-01"; // before start
    r.input("progress").value = "7";
    r.el(".sg-edit-dialog-save").click();

    expect(r.dialog.isOpen).toBe(true);
    expect(r.applied).toEqual([]);
    const end = r.input("end");
    expect(end.getAttribute("aria-invalid")).toBe("true");
    expect(end.getAttribute("aria-errormessage")).toBe("sg-edit-dialog-9-end-error");
    expect(r.root.querySelector("#sg-edit-dialog-9-end-error")?.textContent).toBe(
      DEFAULT_MESSAGES.dialogErrorDateOrder,
    );
    const progress = r.input("progress");
    expect(progress.getAttribute("aria-invalid")).toBe("true");
    expect(r.root.querySelector("#sg-edit-dialog-9-progress-error")?.textContent).toBe(
      DEFAULT_MESSAGES.dialogErrorProgressRange,
    );
    expect(r.announced).toEqual(["End: invalid value, edit not applied"]);
    expect(document.activeElement).toBe(end);
  });

  it("marks the rejected input by more than colour: aria-invalid, a modifier class and cause text", () => {
    const r = rig();
    r.dialog.open("t1");
    r.input("end").value = "bad";
    r.el(".sg-edit-dialog-save").click();
    const end = r.input("end");
    expect(end.getAttribute("aria-invalid")).toBe("true");
    expect(end.classList.contains("sg-edit-dialog-input--invalid")).toBe(true);
    // The cause is named in text, not only in colour (happy-dom does not retain the outline's
    // `var(..., fallback)` shorthand, so the visible-outline style itself is not asserted here —
    // it is a real CSS declaration, just one this test environment's CSSOM cannot echo back).
    expect(r.root.querySelector("#sg-edit-dialog-9-end-error")?.textContent).toBe(
      DEFAULT_MESSAGES.dialogErrorInvalidDate,
    );
  });

  it("correcting the fields after an invalid Save saves cleanly and clears the marks", () => {
    const r = rig();
    r.dialog.open("t1");
    r.input("end").value = "bad";
    r.el(".sg-edit-dialog-save").click();
    expect(r.dialog.isOpen).toBe(true);

    r.input("end").value = "2026-01-12";
    r.el(".sg-edit-dialog-save").click();
    expect(r.applied).toEqual([{ id: "t1", after: { end: Date.UTC(2026, 0, 12) } }]);
    expect(r.dialog.isOpen).toBe(false);
  });

  it("a second rejected Save drops the marking of a field that is now fine", () => {
    const r = rig();
    r.dialog.open("t1");
    r.input("start").value = "nope";
    r.input("progress").value = "7";
    r.el(".sg-edit-dialog-save").click();
    expect(r.input("start").getAttribute("aria-invalid")).toBe("true");

    r.input("start").value = "2026-01-05";
    r.el(".sg-edit-dialog-save").click();
    expect(r.input("start").getAttribute("aria-invalid")).toBeNull();
    expect(r.root.querySelector("#sg-edit-dialog-9-start-error")).toBeNull();
    expect(r.input("start").style.outline).toBe("");
    expect(r.input("progress").getAttribute("aria-invalid")).toBe("true");
  });

  it("without an announcer the invalid Save still marks, silently", () => {
    const r = rig({ announcer: () => undefined });
    r.dialog.open("t1");
    r.input("end").value = "bad";
    r.el(".sg-edit-dialog-save").click();
    expect(r.input("end").getAttribute("aria-invalid")).toBe("true");
    expect(r.announced).toEqual([]);
  });

  it("Save re-reads the store: a task deleted while the dialog was open just closes it", () => {
    const r = rig();
    r.dialog.open("t1");
    r.store.delete("t1");
    r.el(".sg-edit-dialog-save").click();
    expect(r.applied).toEqual([]);
    expect(r.dialog.isOpen).toBe(false);
  });

  it("close restores focus to where it was before open", () => {
    const r = rig();
    const outside = document.createElement("input");
    r.root.appendChild(outside);
    outside.focus();
    r.dialog.open("t1");
    expect(document.activeElement).not.toBe(outside);
    r.dialog.close();
    expect(document.activeElement).toBe(outside);
  });

  it("re-opening for another task restores focus to the pre-dialog element, not the old dialog", () => {
    const r = rig();
    r.store.set("t2", task({ id: "t2", name: "Build" }));
    const outside = document.createElement("input");
    r.root.appendChild(outside);
    outside.focus();
    r.dialog.open("t1");
    r.dialog.open("t2");
    expect(r.input("name").value).toBe("Build");
    r.dialog.close();
    expect(document.activeElement).toBe(outside);
  });

  it("dispose closes an open dialog and unmounts everything it built", () => {
    const r = rig();
    r.dialog.open("t1");
    r.dialog.dispose();
    expect(r.dialog.isOpen).toBe(false);
    expect(r.root.querySelector(".sg-edit-dialog")).toBeNull();
    expect(r.root.querySelector(".sg-edit-dialog__backdrop")).toBeNull();
  });

  it("drops the chrome's listeners with the dialog: a stale Escape after close does nothing", () => {
    const r = rig();
    r.dialog.open("t1");
    const backdrop = r.el(".sg-edit-dialog__backdrop");
    r.dialog.close();
    const stopPropagation = vi.fn();
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
    Object.defineProperty(event, "stopPropagation", { value: stopPropagation });
    backdrop.dispatchEvent(event);
    expect(stopPropagation).not.toHaveBeenCalled();
  });

  it("the built-in inputs carry the progress bounds", () => {
    const r = rig();
    r.dialog.open("t1");
    const progress = r.input("progress");
    expect(progress.getAttribute("min")).toBe("0");
    expect(progress.getAttribute("max")).toBe("1");
    expect(progress.getAttribute("type")).toBe("number");
    expect(r.input("start").getAttribute("type")).toBe("date");
  });

  it("every field's label is programmatically associated with its input", () => {
    const r = rig();
    r.dialog.open("t1");
    for (const field of Array.from(r.root.querySelectorAll<HTMLElement>(".sg-edit-dialog-field"))) {
      const label = field.querySelector<HTMLElement>(".sg-edit-dialog-label");
      const input = field.querySelector<HTMLElement>(".sg-edit-dialog-input");
      expect(label?.getAttribute("for")).toBe(input?.getAttribute("id"));
    }
  });

  it("a replaced catalog renames the title, the buttons and the labels", () => {
    const r = rig();
    r.dialog.close();
    const custom = createEditDialog({
      host: r.root,
      messages: {
        ...DEFAULT_MESSAGES,
        dialogTitle: "Aufgabe bearbeiten",
        dialogSave: "Speichern",
        dialogCancel: "Abbrechen",
        dialogNameLabel: "Name?",
      },
      idPrefix: "sg-edit-dialog-9",
      getTask: (id) => r.store.get(id),
      apply: () => {},
      announcer: () => undefined,
      fault: () => {},
    });
    custom.open("t1");
    expect(r.el(".sg-edit-dialog").getAttribute("aria-label")).toBe("Aufgabe bearbeiten");
    expect(r.el(".sg-edit-dialog-save").textContent).toBe("Speichern");
    expect(r.el(".sg-edit-dialog-cancel").textContent).toBe("Abbrechen");
    expect(r.el(".sg-edit-dialog-label").textContent).toBe("Name?");
    custom.dispose();
  });
});

/* ------------------------------------------------------------------ *
 * The `renderBody` seam
 * ------------------------------------------------------------------ */

describe("renderBody", () => {
  function seamRig(renderBody: (host: HTMLElement, ctx: EditDialogRenderContext) => void) {
    const seen: EditDialogRenderContext[] = [];
    const r = rig({
      renderBody: (host, ctx) => {
        seen.push(ctx);
        renderBody(host, ctx);
      },
    });
    return { ...r, seen, body: () => r.el(".sg-edit-dialog__body") };
  }

  it("owns the body: the built-in form is not built at all", () => {
    const r = seamRig((host) => {
      const own = document.createElement("div");
      own.className = "custom-body";
      host.appendChild(own);
    });
    r.dialog.open("t1");
    expect(Array.from(r.body().children).map((c) => c.className)).toEqual(["custom-body"]);
    expect(r.root.querySelector(".sg-edit-dialog-input")).toBeNull();
    expect(r.faults).toEqual([]);
  });

  it("is handed the task, the draft and an empty invalid map at open", () => {
    const r = seamRig(() => {});
    r.dialog.open("t1");
    const ctx = r.seen[0];
    expect(ctx?.task.name).toBe("Design");
    expect(ctx?.draft).toEqual({ name: "Design", start: "2026-01-05", end: "2026-01-10", progress: "0.4" });
    expect(ctx?.invalid).toEqual({ name: undefined, start: undefined, end: undefined, progress: undefined });
  });

  it("appending nothing is not a fallback signal — the body stays empty", () => {
    const r = seamRig(() => {});
    r.dialog.open("t1");
    expect(r.body().children).toHaveLength(0);
    expect(r.faults).toEqual([]);
    expect(r.el(".sg-edit-dialog-save")).toBeDefined();
  });

  it("setField then commit dispatches exactly what the built-in Save would", () => {
    const r = seamRig((_host, ctx) => {
      ctx.setField("name", "Build");
      ctx.setField("end", "2026-01-12");
    });
    r.dialog.open("t1");
    r.seen[0]?.commit();
    expect(r.applied).toEqual([{ id: "t1", after: { name: "Build", end: Date.UTC(2026, 0, 12) } }]);
    expect(r.dialog.isOpen).toBe(false);
  });

  it("cancel from the render context closes without dispatching", () => {
    const r = seamRig((_host, ctx) => ctx.setField("name", "discarded"));
    r.dialog.open("t1");
    r.seen[0]?.cancel();
    expect(r.applied).toEqual([]);
    expect(r.dialog.isOpen).toBe(false);
  });

  it("an unusable field key is ignored, and the draft handed on is a copy", () => {
    const r = seamRig((_host, ctx) => {
      ctx.setField("nope" as "name", "x");
      (ctx.draft as Record<string, string>)["name"] = "mutated";
    });
    r.dialog.open("t1");
    r.seen[0]?.commit();
    expect(r.applied).toEqual([]);
    expect(r.dialog.isOpen).toBe(false);
  });

  it("a rejected commit re-renders the body with the cause text and keeps the dialog open", () => {
    const r = seamRig((_host, ctx) => {
      if (r.seen.length === 1) ctx.setField("end", "2026-01-01");
    });
    r.dialog.open("t1");
    r.seen[0]?.commit();
    expect(r.dialog.isOpen).toBe(true);
    expect(r.applied).toEqual([]);
    expect(r.seen).toHaveLength(2);
    expect(r.seen[1]?.invalid.end).toBe(DEFAULT_MESSAGES.dialogErrorDateOrder);
    expect(r.seen[1]?.draft.end).toBe("2026-01-01");
    expect(r.announced).toEqual(["End: invalid value, edit not applied"]);
  });

  it("is called again on every re-open, with the draft re-read from the store", () => {
    const r = seamRig((_host, ctx) => ctx.setField("name", "typed"));
    r.dialog.open("t1");
    r.dialog.close();
    r.dialog.open("t1");
    expect(r.seen).toHaveLength(2);
    expect(r.seen[1]?.draft.name).toBe("Design");
  });

  it("a throw is reported once and the built-in form takes the body over", () => {
    const r = seamRig(() => {
      throw new Error("boom");
    });
    r.dialog.open("t1");
    expect(r.faults).toHaveLength(1);
    expect((r.faults[0] as Error).message).toBe("boom");
    expect(r.root.querySelector("#sg-edit-dialog-9-name-error")).toBeNull();
    expect(r.root.querySelector(".sg-edit-dialog-input")).not.toBeNull();
  });

  it("discards whatever the throwing renderer had already appended", () => {
    const r = seamRig((host) => {
      const half = document.createElement("div");
      half.className = "half-built";
      host.appendChild(half);
      throw new Error("boom");
    });
    r.dialog.open("t1");
    expect(r.root.querySelector(".half-built")).toBeNull();
  });

  it("latches: a second open neither calls the seam again nor reports again", () => {
    let calls = 0;
    const r = seamRig(() => {
      calls += 1;
      throw new Error("boom");
    });
    r.dialog.open("t1");
    r.dialog.close();
    r.dialog.open("t1");
    expect(calls).toBe(1);
    expect(r.faults).toHaveLength(1);
    expect(r.root.querySelector(".sg-edit-dialog-input")).not.toBeNull();
  });

  it("the built-in form works normally after the seam has latched off", () => {
    const r = seamRig(() => {
      throw new Error("boom");
    });
    r.dialog.open("t1");
    const name = r.root.querySelector<HTMLInputElement>("#sg-edit-dialog-9-name");
    if (name === null) throw new Error("no name input");
    name.value = "Build";
    r.el(".sg-edit-dialog-save").click();
    expect(r.applied).toEqual([{ id: "t1", after: { name: "Build" } }]);
  });
});
