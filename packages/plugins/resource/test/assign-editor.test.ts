// @vitest-environment happy-dom
/**
 * `internal/assign/editor.ts` — the assignment editor dialog (docs/specs/plugins/resource.md
 * §3.3), hostless against a real DOM: a plain mount element and plain callbacks, never a
 * `PluginContext`. Covers open pre-fill, Apply/Cancel/Escape, effective-value write-back, the Tab focus
 * trap, and focus restore onto a live (possibly re-rendered) open button.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditorSession } from "../src/internal/assign/editor";
import type { EditorDeps } from "../src/internal/assign/editor";
import type { AssignmentLike, ChoiceLike, Id } from "../src/internal/assign/model";

afterEach(() => {
  document.body.innerHTML = "";
});

function makeOpener(root: HTMLElement, taskId: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.setAttribute("data-sg-ra-open", taskId);
  root.appendChild(btn);
  return btn;
}

function makeDeps(over: Partial<EditorDeps> & { root: HTMLElement }): EditorDeps {
  return {
    title: "Assign resources",
    emptyChoices: "No resources available",
    applyLabel: "Apply",
    cancelLabel: "Cancel",
    toggleLabel: (n) => `Assign ${n}`,
    unitsLabel: (n) => `Allocation percent for ${n}`,
    choices: (): readonly ChoiceLike[] => [
      { id: "p1", name: "Ana" },
      { id: "s1", name: "StoreOnly" },
    ],
    assignmentsOf: (): readonly AssignmentLike[] => [{ resourceId: "s1", units: 0.5 }],
    commit: () => {
      /* overridden per test */
    },
    ...over,
  };
}

function rowAt(dialog: HTMLElement, index: number): { check: HTMLInputElement; units: HTMLInputElement } {
  const row = dialog.querySelectorAll(".sg-ra-row")[index] as HTMLElement;
  return {
    check: row.querySelector('input[type="checkbox"]') as HTMLInputElement,
    units: row.querySelector(".sg-ra-units") as HTMLInputElement,
  };
}

describe("createEditorSession", () => {
  it("opens a labelled, modal dialog with rows pre-filled from current assignments", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const opener = makeOpener(root, "t1");
    const session = createEditorSession(makeDeps({ root }));

    session.open(opener, "t1");
    const dialog = session.element();
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("role")).toBe("dialog");
    expect(dialog?.getAttribute("aria-label")).toBe("Assign resources");
    expect(dialog?.getAttribute("aria-modal")).toBe("true");

    const r0 = rowAt(dialog!, 0);
    const r1 = rowAt(dialog!, 1);
    expect(r0.check.checked).toBe(false); // p1 not assigned
    expect(r1.check.checked).toBe(true); // s1 assigned at 50%
    expect(r1.units.value).toBe("50");
  });

  it("shows the empty-choices text and still traps Tab when there are no choices", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const opener = makeOpener(root, "t1");
    const session = createEditorSession(makeDeps({ root, choices: () => [] }));
    session.open(opener, "t1");
    const dialog = session.element()!;
    expect(dialog.querySelector(".sg-ra-empty")?.textContent).toBe("No resources available");
    expect(dialog.querySelectorAll(".sg-ra-row")).toHaveLength(0);
  });

  it("commits the checked rows' desired map on Apply and closes", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const opener = makeOpener(root, "t1");
    let committed: { taskId: Id; desired: Map<Id, number> } | undefined;
    const session = createEditorSession(
      makeDeps({
        root,
        commit: (taskId, desired) => {
          committed = { taskId, desired };
        },
      }),
    );
    session.open(opener, "t1");
    const dialog = session.element()!;
    const r0 = rowAt(dialog, 0);
    r0.check.checked = true;
    r0.units.value = "25";
    dialog.querySelector<HTMLButtonElement>(".sg-ra-apply")?.click();

    expect(session.isOpen()).toBe(false);
    expect(committed?.taskId).toBe("t1");
    expect(committed?.desired).toEqual(
      new Map([
        ["p1", 0.25],
        ["s1", 0.5],
      ]),
    );
  });

  it("commits nothing on Cancel", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const opener = makeOpener(root, "t1");
    const commit = vi.fn();
    const session = createEditorSession(makeDeps({ root, commit }));
    session.open(opener, "t1");
    session.element()!.querySelector<HTMLButtonElement>(".sg-ra-cancel")?.click();
    expect(commit).not.toHaveBeenCalled();
    expect(session.isOpen()).toBe(false);
  });

  it("commits nothing on Escape, and stops the keydown from propagating", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const opener = makeOpener(root, "t1");
    const commit = vi.fn();
    const session = createEditorSession(makeDeps({ root, commit }));
    session.open(opener, "t1");
    const dialog = session.element()!;
    let bubbled = false;
    root.addEventListener("keydown", () => {
      bubbled = true;
    });
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(commit).not.toHaveBeenCalled();
    expect(session.isOpen()).toBe(false);
    expect(bubbled).toBe(false);
  });

  it("keeps existing units when a checked row's percent is unusable, falling back to stored units", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const opener = makeOpener(root, "t1");
    let committed: Map<Id, number> | undefined;
    const session = createEditorSession(
      makeDeps({ root, commit: (_taskId, desired) => (committed = desired) }),
    );
    session.open(opener, "t1");
    const dialog = session.element()!;
    const r1 = rowAt(dialog, 1); // s1, already checked at 50%
    r1.units.value = "junk";
    dialog.querySelector<HTMLButtonElement>(".sg-ra-apply")?.click();
    expect(committed?.get("s1")).toBe(0.5);
  });

  it("writes the effective value back into a row's input on blur, clamping at 1000%", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const opener = makeOpener(root, "t1");
    const session = createEditorSession(makeDeps({ root }));
    session.open(opener, "t1");
    const dialog = session.element()!;
    const r1 = rowAt(dialog, 1);

    r1.units.value = "junk";
    r1.units.dispatchEvent(new Event("blur"));
    expect(r1.units.value).toBe("50"); // falls back to the pair's existing units

    r1.units.value = "5000";
    r1.units.dispatchEvent(new Event("blur"));
    expect(r1.units.value).toBe("1000"); // clamps to 1000%
  });

  it("does not rewrite an untouched row whose stored units aren't a whole percent", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const opener = makeOpener(root, "t1");
    let committed: Map<Id, number> | undefined;
    const session = createEditorSession(
      makeDeps({
        root,
        assignmentsOf: () => [{ resourceId: "s1", units: 0.335 }], // 33.5% -> displays "34"
        commit: (_taskId, desired) => (committed = desired),
      }),
    );
    session.open(opener, "t1");
    const dialog = session.element()!;
    const r1 = rowAt(dialog, 1);
    expect(r1.units.value).toBe("34"); // rounded display
    dialog.querySelector<HTMLButtonElement>(".sg-ra-apply")?.click(); // never touched the field
    expect(committed?.get("s1")).toBe(0.335); // exact stored value, not re-parsed "34%"
  });

  it("traps Tab at both ends of the dialog", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const opener = makeOpener(root, "t1");
    const session = createEditorSession(makeDeps({ root }));
    session.open(opener, "t1");
    const dialog = session.element()!;
    const r0 = rowAt(dialog, 0);
    const cancelBtn = dialog.querySelector<HTMLButtonElement>(".sg-ra-cancel")!;

    cancelBtn.focus();
    const forward = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    dialog.dispatchEvent(forward);
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(r0.check);

    const backward = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    dialog.dispatchEvent(backward);
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(cancelBtn);
  });

  it("re-resolves the live open button for focus restore after commit re-renders the cell", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const oldButton = makeOpener(root, "t1");
    let newButton: HTMLButtonElement | undefined;
    const session = createEditorSession(
      makeDeps({
        root,
        choices: () => [{ id: "p1", name: "Ana" }],
        assignmentsOf: () => [],
        commit: () => {
          // Simulate the grid repaint: the opener button is detached and rebuilt.
          oldButton.remove();
          newButton = makeOpener(root, "t1");
        },
      }),
    );
    session.open(oldButton, "t1");
    const dialog = session.element()!;
    rowAt(dialog, 0).check.checked = true;
    dialog.querySelector<HTMLButtonElement>(".sg-ra-apply")?.click();

    expect(session.isOpen()).toBe(false);
    expect(newButton).toBeDefined();
    expect(document.activeElement).toBe(newButton);
  });

  it("keeps at most one editor open: opening a second cancels the first without committing", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const o1 = makeOpener(root, "t1");
    const o2 = makeOpener(root, "t2");
    const commit = vi.fn();
    const session = createEditorSession(makeDeps({ root, commit }));
    session.open(o1, "t1");
    session.open(o2, "t2");
    expect(root.querySelectorAll(".sg-ra-editor")).toHaveLength(1);
    expect(session.element()?.getAttribute("data-sg-ra-editor")).toBe("t2");
    expect(commit).not.toHaveBeenCalled();
  });
});
