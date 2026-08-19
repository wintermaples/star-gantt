// Opt-in keyboard shortcuts: Ctrl/Cmd+A select-all, Escape clear, Delete bulk-delete — all off by
// default. `shortcutFor` is unit-tested directly, plus the `"delete"`
// action. There is no standalone `resolveShortcuts` — shortcut resolution is folded into
// `resolveConfig(...).selection.shortcuts` (see `config.ts`'s `resolveSelection`) — so the
// "resolveShortcuts (unit)" cases are re-pointed at `resolveConfig`.
//
// The document-level keydown listener that calls `handleKey` / `runShortcut` lives in `src/index.ts`,
// not in the selection module: the higher-level cases below drive
// `module.handleKey(...)` + `module.runShortcut(...)` directly instead of a synthesized document
// `keydown`, which is exactly what `index.ts`'s listener does after resolving `editableTarget` /
// `focusInRoot` itself.
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config";
import { shortcutFor } from "../src/internal/selection/shortcuts";
import { harness, makeBox } from "./_selection-fakes";

/** What `src/index.ts`'s document `keydown` listener does: resolve, then run if resolved. */
function fire(
  h: ReturnType<typeof harness>,
  key: string,
  over: { ctrlKey?: boolean; metaKey?: boolean; editableTarget?: boolean; focusInRoot?: boolean } = {},
): "select-all" | "clear" | "delete" | undefined {
  const action = h.module.handleKey({
    key,
    ctrlKey: over.ctrlKey ?? false,
    metaKey: over.metaKey ?? false,
    editableTarget: over.editableTarget ?? false,
    focusInRoot: over.focusInRoot ?? false,
  });
  if (action !== undefined) h.module.runShortcut(action);
  return action;
}

describe("keyboard shortcuts (default off)", () => {
  it("Ctrl+A and Escape do nothing with the default config", () => {
    const h = harness({ mode: "multi" });
    h.taskIds.push("a", "b");
    h.bars.boxes.push(makeBox("a", 0, 0), makeBox("b", 0, 30));
    h.module.service.select(["a"]);

    fire(h, "a", { ctrlKey: true, focusInRoot: true });
    expect(h.module.selected()).toEqual(new Set(["a"]));

    fire(h, "Escape");
    expect(h.module.selected()).toEqual(new Set(["a"]));
  });
});

describe("select-all (Ctrl/Cmd+A)", () => {
  function bootAll(mode: "single" | "multi" | "none" = "multi") {
    const h = harness({ mode, shortcuts: { selectAll: true } });
    h.taskIds.push("a", "b", "c");
    h.bars.boxes.push(makeBox("a", 0, 0), makeBox("b", 0, 30));
    return h;
  }

  it("selects every task the data store knows while the focus is inside the chart", () => {
    const h = bootAll();
    fire(h, "a", { ctrlKey: true, focusInRoot: true });
    expect(h.module.selected()).toEqual(new Set(["a", "b", "c"]));
    expect(h.storeSnapshots).toHaveLength(1);
  });

  it("works with the Cmd modifier too", () => {
    const h = bootAll();
    fire(h, "a", { metaKey: true, focusInRoot: true });
    expect(h.module.selected()).toEqual(new Set(["a", "b", "c"]));
  });

  it("does nothing while the focus is outside the chart", () => {
    const h = bootAll();
    fire(h, "a", { ctrlKey: true, focusInRoot: false });
    expect(h.module.selected()).toEqual(new Set());
  });

  it("does nothing outside multi mode", () => {
    const single = bootAll("single");
    fire(single, "a", { ctrlKey: true, focusInRoot: true });
    expect(single.module.selected()).toEqual(new Set());

    const none = bootAll("none");
    fire(none, "a", { ctrlKey: true, focusInRoot: true });
    expect(none.module.selected()).toEqual(new Set());
  });

  it("never fires while the user is typing in an editable element", () => {
    const h = bootAll();
    fire(h, "a", { ctrlKey: true, focusInRoot: true, editableTarget: true });
    expect(h.module.selected()).toEqual(new Set());
  });

  it("plain A without a modifier is not select-all", () => {
    const h = bootAll();
    fire(h, "a", { focusInRoot: true });
    expect(h.module.selected()).toEqual(new Set());
  });

  // The data store is a hard dependency of the interaction plugin — the composition can never
  // lack one, so `taskIds()` always answers from it and there is no fallback branch to a
  // no-data-store case.
});

describe("clear on Escape", () => {
  it("clears a non-empty selection and publishes one change", () => {
    const h = harness({ mode: "multi", shortcuts: { clearOnEscape: true } });
    h.bars.boxes.push(makeBox("a", 0, 0));
    h.module.service.select(["a"]);
    const before = h.storeSnapshots.length;

    fire(h, "Escape");
    expect(h.module.selected()).toEqual(new Set());
    expect(h.storeSnapshots).toHaveLength(before + 1);

    // Already empty: no further change.
    fire(h, "Escape");
    expect(h.storeSnapshots).toHaveLength(before + 1);
  });

  it("yields to a rubber-band drag in flight: first Escape cancels the drag only", () => {
    const h = harness({ mode: "multi", shortcuts: { clearOnEscape: true } });
    h.bars.boxes.push(makeBox("a", 10, 10));
    h.module.service.select(["a"]);

    h.module.rubberBandBegin(0, 0);
    h.module.rubberBandMove(50, 50);
    // `index.ts` always calls `arbiter.escape()` (which cancels a band in flight) BEFORE consulting
    // `handleKey`'s resolved action, and `shortcutFor` itself declines Escape while
    // `state.rubberBandActive` is true — so the drag-cancel path owns the first Escape and the
    // module reports no shortcut action for it.
    expect(h.module.handleKey({ key: "Escape", ctrlKey: false, metaKey: false, editableTarget: false, focusInRoot: false })).toBeUndefined();
    h.module.rubberBandCancel();
    expect(h.module.selected()).toEqual(new Set(["a"]));

    fire(h, "Escape"); // no drag any more: clears
    expect(h.module.selected()).toEqual(new Set());
  });

  it("is inert in none mode", () => {
    const h = harness({ mode: "none", shortcuts: { clearOnEscape: true } });
    h.bars.boxes.push(makeBox("a", 0, 0));
    h.module.service.select(["a"]);
    fire(h, "Escape");
    expect(h.module.selected()).toEqual(new Set(["a"]));
  });
});

describe("resolveConfig(...).selection.shortcuts / shortcutFor (unit)", () => {
  it("ignores unusable config values silently", () => {
    expect(resolveConfig(undefined).selection.shortcuts).toEqual({
      selectAll: false,
      clearOnEscape: false,
      deleteSelected: false,
    });
    expect(resolveConfig({ selection: "yes" as never }).selection.shortcuts).toEqual({
      selectAll: false,
      clearOnEscape: false,
      deleteSelected: false,
    });
    expect(
      resolveConfig({
        selection: { shortcuts: { selectAll: 1 as never, clearOnEscape: "true" as never, deleteSelected: true } },
      }).selection.shortcuts,
    ).toEqual({
      selectAll: false,
      clearOnEscape: false,
      deleteSelected: true,
    });
  });

  it("keeps every shortcut inert while a confirmation is in flight", () => {
    const flags = { selectAll: true, clearOnEscape: true, deleteSelected: true };
    const state = {
      mode: "multi" as const,
      rubberBandActive: false,
      hasSelection: true,
      focusInRoot: true,
      confirmInFlight: true,
    };
    expect(shortcutFor({ key: "a", ctrlKey: true, metaKey: false, editableTarget: false }, flags, state)).toBeUndefined();
    expect(shortcutFor({ key: "Delete", ctrlKey: false, metaKey: false, editableTarget: false }, flags, state)).toBeUndefined();
    expect(shortcutFor({ key: "Escape", ctrlKey: false, metaKey: false, editableTarget: false }, flags, state)).toBeUndefined();
  });
});
