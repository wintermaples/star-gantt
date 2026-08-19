// @vitest-environment happy-dom
/**
 * The confirm-then-delete flow, exercised directly (no host) for the paths a full composition
 * cannot easily produce. `createDeleteFlow` is built on the SDK's `sdk/dialog` rather than a
 * hand-rolled backdrop: the dialog box carries class `sg-selection-confirm`, its
 * buttons `sg-selection-confirm__cancel` / `sg-selection-confirm__delete`, and the whole thing is
 * wrapped in a `sg-selection-confirm__backdrop` (BEM-style).
 *
 * `DeleteFlowOptions` carries no `canDelete` gate — the data store is a hard dependency, so "does
 * nothing without something to delete into" has no scenario to test; replaced with a plain
 * empty-selection no-op check.
 */
import { describe, expect, it } from "vitest";
import { createDeleteFlow } from "../src/internal/selection/delete-flow";
import type { DeleteFlow } from "../src/internal/selection/delete-flow";
import { DEFAULT_MESSAGES } from "../src/messages";

interface Harness {
  flow: DeleteFlow;
  root: HTMLElement;
  removals: (string | number)[][];
  selection: Set<string | number>;
  errors: unknown[];
  dialog(): HTMLElement | null;
}

function harness(opts: { throwOnRemove?: boolean } = {}): Harness {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const removals: (string | number)[][] = [];
  const errors: unknown[] = [];
  let selection = new Set<string | number>(["a", "b"]);

  const h: Harness = {
    root,
    removals,
    errors,
    get selection(): Set<string | number> {
      return selection;
    },
    dialog: () => root.querySelector<HTMLElement>(".sg-selection-confirm__backdrop"),
    flow: createDeleteFlow({
      host: root,
      title: (n) => DEFAULT_MESSAGES.deleteConfirmTitle(n),
      confirmLabel: DEFAULT_MESSAGES.deleteConfirmButton,
      cancelLabel: DEFAULT_MESSAGES.deleteCancelButton,
      confirmHook: undefined,
      selected: () => selection,
      remove: (ids) => {
        if (opts.throwOnRemove === true) throw new Error("command rejected");
        removals.push([...ids]);
      },
      applySelection: (next) => {
        selection = new Set(next);
      },
      reportError: (e) => void errors.push(e),
    }),
  } as Harness;
  return h;
}

describe("delete flow", () => {
  it("removes the whole selection in exactly one call, then drops those ids", () => {
    const h = harness();
    h.flow.request();
    h.dialog()?.querySelector<HTMLElement>(".sg-selection-confirm__delete")?.click();
    expect(h.removals).toEqual([["a", "b"]]);
    expect(h.selection).toEqual(new Set());
    expect(h.flow.inFlight()).toBe(false);
  });

  it("leaves the selection alone and reports the failure when the remove command throws", () => {
    const h = harness({ throwOnRemove: true });
    h.flow.request();
    h.dialog()?.querySelector<HTMLElement>(".sg-selection-confirm__delete")?.click();
    // The tasks are still there, so the selection must still name them.
    expect(h.selection).toEqual(new Set(["a", "b"]));
    expect(h.errors).toHaveLength(1);
    expect(h.dialog()).toBeNull();
    expect(h.flow.inFlight()).toBe(false);
  });

  it("is in flight only while the dialog is open, and disposal closes it without deleting", () => {
    const h = harness();
    expect(h.flow.inFlight()).toBe(false);
    h.flow.request();
    expect(h.flow.inFlight()).toBe(true);
    h.flow.dispose();
    expect(h.dialog()).toBeNull();
    expect(h.removals).toEqual([]);
    expect(h.selection).toEqual(new Set(["a", "b"]));
    expect(h.flow.inFlight()).toBe(false);
  });

  it("does nothing with an empty selection", () => {
    const h = harness();
    h.selection.clear(); // mutates the Set the closure reads `selected()` from
    h.flow.request();
    expect(h.dialog()).toBeNull();
  });
});
