// @vitest-environment happy-dom
/**
 * Bulk delete of the selected tasks behind a confirmation: the built-in dialog is built on the
 * SDK's `sdk/dialog` (`createDialog`, `modal: true`) instead of a hand-rolled backdrop. The box
 * carries class `sg-selection-confirm` and `role="alertdialog"`; the backdrop (BEM-style, not the
 * hyphenated `sg-selection-confirm-backdrop` naming) is `sg-selection-confirm__backdrop`; the
 * buttons are `sg-selection-confirm__cancel` / `sg-selection-confirm__delete`, cancel appended
 * first so the dialog's own "focus the first focusable element" rule lands on the safe choice.
 *
 * There is no `canDelete()` gate any more (the data store is a hard dependency), so the earlier
 * "storeless" no-op case is dropped.
 *
 * The document-level `Delete` keydown listener lives in `src/index.ts`, not in the selection
 * module: the shortcut cases below drive `module.handleKey(...)` + `module.runShortcut(...)`
 * directly, exactly what that listener does after resolving `editableTarget` / `focusInRoot` itself.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_MESSAGES, resolveMessages } from "../src/messages";
import { harness, makeBox, press } from "./_selection-fakes";

function bootDelete(config: Parameters<typeof harness>[0] = {}, messages?: Parameters<typeof harness>[1]) {
  const root = document.createElement("div");
  root.tabIndex = -1;
  document.body.appendChild(root);
  const h = harness({ mode: "multi", ...config }, { root, ...messages });
  h.taskIds.push("a", "b", "c");
  h.bars.boxes.push(makeBox("a", 0, 0), makeBox("b", 0, 30), makeBox("c", 0, 60));
  return h;
}

function backdrop(h: ReturnType<typeof bootDelete>): HTMLElement | null {
  return h.root.querySelector<HTMLElement>(".sg-selection-confirm__backdrop");
}

function box(h: ReturnType<typeof bootDelete>): HTMLElement | null {
  return h.root.querySelector<HTMLElement>(".sg-selection-confirm");
}

function cancelBtn(h: ReturnType<typeof bootDelete>): HTMLElement | null {
  return h.root.querySelector<HTMLElement>(".sg-selection-confirm__cancel");
}

function deleteBtn(h: ReturnType<typeof bootDelete>): HTMLElement | null {
  return h.root.querySelector<HTMLElement>(".sg-selection-confirm__delete");
}

describe("deleteSelected() with the built-in dialog", () => {
  it("opens a modal alertdialog naming the count, deletes on confirm, and drops the ids from the selection", () => {
    const h = bootDelete();
    h.module.service.select(["a", "b"]);
    h.module.service.deleteSelected();

    const bd = backdrop(h);
    expect(bd).not.toBeNull();
    const dialogBox = box(h);
    expect(dialogBox?.getAttribute("role")).toBe("alertdialog");
    expect(dialogBox?.textContent).toContain("Delete 2 tasks?");

    deleteBtn(h)?.click();
    expect(h.removed).toEqual([["a", "b"]]);
    expect(h.module.selected()).toEqual(new Set());
    expect(backdrop(h)).toBeNull();
  });

  it("removes the whole selection in one call, never one dispatch per id", () => {
    const h = bootDelete();
    h.module.service.select(["a", "b", "c"]);
    h.module.service.deleteSelected();
    deleteBtn(h)?.click();
    // One transaction, so one undo brings all three back.
    expect(h.removed).toHaveLength(1);
    expect(h.removed[0]).toEqual(["a", "b", "c"]);
  });

  it("uses the singular form for one task", () => {
    const h = bootDelete();
    h.module.service.select(["a"]);
    h.module.service.deleteSelected();
    expect(box(h)?.textContent).toContain("Delete 1 task?");
  });

  it("cancel leaves tasks and selection untouched", () => {
    const h = bootDelete();
    h.module.service.select(["a", "b"]);
    h.module.service.deleteSelected();
    cancelBtn(h)?.click();
    expect(h.removed).toEqual([]);
    expect(h.module.selected()).toEqual(new Set(["a", "b"]));
    expect(backdrop(h)).toBeNull();
  });

  it("Escape inside the dialog cancels", () => {
    const h = bootDelete();
    h.module.service.select(["a"]);
    h.module.service.deleteSelected();
    backdrop(h)?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(h.removed).toEqual([]);
    expect(backdrop(h)).toBeNull();
  });

  it("returns focus to the previously focused element on close, cancel and confirm alike", () => {
    const h = bootDelete();
    h.root.focus();
    h.module.service.select(["a", "b"]);
    h.module.service.deleteSelected();
    expect(document.activeElement).not.toBe(h.root); // the dialog took focus
    cancelBtn(h)?.click();
    expect(document.activeElement).toBe(h.root);

    h.module.service.deleteSelected();
    deleteBtn(h)?.click();
    expect(document.activeElement).toBe(h.root);
  });

  it("focus starts on the cancel button (the safe default)", () => {
    const h = bootDelete();
    h.module.service.select(["a"]);
    h.module.service.deleteSelected();
    expect(document.activeElement).toBe(cancelBtn(h));
  });

  it("is a no-op with an empty selection, or while a dialog is already open", () => {
    const empty = bootDelete();
    empty.module.service.deleteSelected();
    expect(backdrop(empty)).toBeNull();

    const h = bootDelete();
    h.module.service.select(["a"]);
    h.module.service.deleteSelected();
    h.module.service.deleteSelected();
    expect(h.root.querySelectorAll(".sg-selection-confirm__backdrop")).toHaveLength(1);
  });

  it("deletes the snapshot taken at request time, subtracting only those ids from the selection", () => {
    const h = bootDelete();
    h.module.service.select(["a", "b"]);
    h.module.service.deleteSelected();
    h.module.service.select(["b", "c"]); // the selection moves on while the dialog is up
    deleteBtn(h)?.click();
    expect(h.removed).toEqual([["a", "b"]]);
    expect(h.module.selected()).toEqual(new Set(["c"]));
  });

  it("honors message overrides and contains a throwing title builder", () => {
    const h = bootDelete(
      {},
      { messages: { deleteConfirmTitle: (n) => `Remove ${n}?`, deleteConfirmButton: "Yes" } },
    );
    h.module.service.select(["a"]);
    h.module.service.deleteSelected();
    expect(box(h)?.textContent).toContain("Remove 1?");
    expect(deleteBtn(h)?.textContent).toBe("Yes");
    expect(cancelBtn(h)?.textContent).toBe("Cancel");
    cancelBtn(h)?.click();

    const throwing = bootDelete(
      {},
      {
        messages: {
          deleteConfirmTitle: () => {
            throw new Error("boom");
          },
        },
      },
    );
    throwing.module.service.select(["a"]);
    throwing.module.service.deleteSelected();
    expect(box(throwing)?.textContent).toContain("Delete 1 task?"); // built-in default
    expect(throwing.errors).toHaveLength(1);
  });
});

describe("the dialog owns the keyboard and the pointer while it is up", () => {
  it("Escape closes the dialog and stops its own propagation", () => {
    const h = bootDelete();
    h.module.service.select(["a"]);
    h.module.service.deleteSelected();
    const bd = backdrop(h);
    expect(bd).not.toBeNull();

    let reachedDocument = false;
    const onDocKeydown = (): void => {
      reachedDocument = true;
    };
    document.addEventListener("keydown", onDocKeydown);
    try {
      bd?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    } finally {
      document.removeEventListener("keydown", onDocKeydown);
    }
    expect(backdrop(h)).toBeNull(); // the dialog closed
    expect(reachedDocument).toBe(false); // and its own keydown handler stopped it there
    expect(h.removed).toEqual([]);
  });

  // A modal owns the keyboard while it is up: `internal/selection/confirm.ts` stops every key on
  // the box except the two the dialog itself answers (Escape and Tab), which have to keep
  // bubbling to the SDK dialog's own handler on the backdrop — otherwise a keydown fired inside it
  // could reach the chart underneath.
  it("keeps a non-Escape key pressed inside the dialog from reaching the chart", () => {
    const h = bootDelete();
    h.module.service.select(["a"]);
    h.module.service.deleteSelected();
    // Real presses land on the focused element inside the box, not on the backdrop around it.
    const focused = cancelBtn(h);
    expect(focused).not.toBeNull();

    for (const key of ["ArrowDown", "ArrowUp", "Enter", "Delete", "a", "Home"]) {
      let reachedDocument = false;
      const onDocKeydown = (): void => {
        reachedDocument = true;
      };
      document.addEventListener("keydown", onDocKeydown);
      try {
        focused?.dispatchEvent(
          new KeyboardEvent("keydown", { key, ctrlKey: key === "a", bubbles: true }),
        );
      } finally {
        document.removeEventListener("keydown", onDocKeydown);
      }
      expect(reachedDocument, `"${key}" must stop at the dialog`).toBe(false);
    }
    // None of them acted on the chart module either: no deletion, no selection change, dialog up.
    expect(h.removed).toEqual([]);
    expect(h.module.selected()).toEqual(new Set(["a"]));
    expect(backdrop(h)).not.toBeNull();
  });

  it("lets Escape and Tab through to the dialog's own handler", () => {
    const h = bootDelete();
    h.module.service.select(["a"]);
    h.module.service.deleteSelected();
    const focused = cancelBtn(h);
    // Tab reaches the backdrop's trap and wraps focus rather than being swallowed by the box.
    focused?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(backdrop(h)).not.toBeNull();
    // Escape reaches the same handler and closes the dialog without deleting.
    focused?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(backdrop(h)).toBeNull();
    expect(h.removed).toEqual([]);
  });

  it("wraps Tab focus between the two buttons at both ring boundaries, never leaving the dialog", () => {
    const h = bootDelete();
    h.module.service.select(["a"]);
    h.module.service.deleteSelected();
    const bd = backdrop(h);
    const cancel = cancelBtn(h);
    const del = deleteBtn(h);
    expect(document.activeElement).toBe(cancel);

    // Only the two wrap-around transitions are driven by the dialog's own code (a plain forward Tab
    // from a non-last element defers to the browser's native tab order, which a synthetic keydown
    // does not simulate in a headless DOM — see the note above).
    const shiftTab = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    bd?.dispatchEvent(shiftTab);
    expect(shiftTab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(del); // wrapped backward from the first button to the last

    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    bd?.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(cancel); // wrapped forward from the last button to the first
  });

  it("a press on the backdrop outside the box cancels; one inside it does not", () => {
    const h = bootDelete();
    h.module.service.select(["a", "b"]);
    h.module.service.deleteSelected();
    const bd = backdrop(h);
    const dialogBox = box(h);

    dialogBox?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(backdrop(h)).not.toBeNull();

    bd?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(backdrop(h)).toBeNull();
    expect(h.removed).toEqual([]);
    expect(h.module.selected()).toEqual(new Set(["a", "b"]));
  });
});

describe("confirmDelete host hook", () => {
  it("a synchronous true deletes without any dialog", () => {
    const seen: { ids: ReadonlySet<string | number>; count: number }[] = [];
    const h = bootDelete({
      confirmDelete: (req) => {
        seen.push(req);
        return true;
      },
    });
    h.module.service.select(["a", "b"]);
    h.module.service.deleteSelected();
    expect(backdrop(h)).toBeNull();
    expect(seen).toEqual([{ ids: new Set(["a", "b"]), count: 2 }]);
    expect(h.removed).toEqual([["a", "b"]]);
  });

  it("a synchronous false (or any non-true value) cancels", () => {
    const h = bootDelete({ confirmDelete: () => false });
    h.module.service.select(["a"]);
    h.module.service.deleteSelected();
    expect(h.removed).toEqual([]);
    expect(h.module.selected()).toEqual(new Set(["a"]));
  });

  it("an async hook deletes on resolve(true) and blocks re-entry while pending", async () => {
    let resolve!: (ok: boolean) => void;
    const h = bootDelete({ confirmDelete: () => new Promise<boolean>((r) => (resolve = r)) });
    h.module.service.select(["a"]);
    h.module.service.deleteSelected();
    h.module.service.deleteSelected(); // ignored: a confirmation is in flight
    resolve(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.removed).toEqual([["a"]]);
    expect(h.module.selected()).toEqual(new Set());
  });

  it("a throwing hook cancels and reports a plugin error", () => {
    const h = bootDelete({
      confirmDelete: () => {
        throw new Error("host bug");
      },
    });
    h.module.service.select(["a"]);
    h.module.service.deleteSelected();
    expect(h.removed).toEqual([]);
    expect(h.errors).toHaveLength(1);
  });

  it("a rejecting hook cancels and reports a plugin error", async () => {
    const h = bootDelete({ confirmDelete: () => Promise.reject(new Error("nope")) });
    h.module.service.select(["a"]);
    h.module.service.deleteSelected();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.removed).toEqual([]);
    expect(h.errors).toHaveLength(1);
  });
});

describe("Delete-key shortcut", () => {
  function fire(
    h: ReturnType<typeof bootDelete>,
    focusInRoot: boolean,
  ): "select-all" | "clear" | "delete" | undefined {
    const action = h.module.handleKey({
      key: "Delete",
      ctrlKey: false,
      metaKey: false,
      editableTarget: false,
      focusInRoot,
    });
    if (action !== undefined) h.module.runShortcut(action);
    return action;
  }

  it("opens the confirmation while enabled, selection non-empty and focus inside the chart", () => {
    const h = bootDelete({ shortcuts: { deleteSelected: true } });
    h.module.service.select(["a"]);
    fire(h, true);
    expect(backdrop(h)).not.toBeNull();
  });

  it("does nothing by default, without focus, or with an empty selection", () => {
    const off = bootDelete();
    off.module.service.select(["a"]);
    fire(off, true);
    expect(backdrop(off)).toBeNull();

    const unfocused = bootDelete({ shortcuts: { deleteSelected: true } });
    unfocused.module.service.select(["a"]);
    fire(unfocused, false);
    expect(backdrop(unfocused)).toBeNull();

    const empty = bootDelete({ shortcuts: { deleteSelected: true } });
    fire(empty, true);
    expect(backdrop(empty)).toBeNull();
  });
});

describe("message catalog (unit)", () => {
  it("defaults are byte-exact and unusable overrides are ignored", () => {
    expect(DEFAULT_MESSAGES.deleteConfirmTitle(1)).toBe("Delete 1 task?");
    expect(DEFAULT_MESSAGES.deleteConfirmTitle(3)).toBe("Delete 3 tasks?");
    const faults: unknown[] = [];
    const m = resolveMessages(
      { deleteConfirmButton: 5 as unknown as string, deleteCancelButton: "Keep", deleteConfirmTitle: "x" as unknown as never },
      (key, error) => faults.push({ key, error }),
    );
    expect(m.deleteConfirmButton).toBe("Delete");
    expect(m.deleteCancelButton).toBe("Keep");
    expect(m.deleteConfirmTitle(2)).toBe("Delete 2 tasks?");
    expect(faults).toEqual([]); // a wrong-kind member is silently ignored, not reported
  });
});
