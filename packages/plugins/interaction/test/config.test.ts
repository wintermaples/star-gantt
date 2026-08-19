/**
 * Configuration resolution (docs/specs/plugins/interaction.md §6): the presence semantics of the
 * ten feature nests, the per-field defaults, and the rule that an unusable value silently falls
 * back to its default rather than throwing.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_ALIGN_TOLERANCE_PX, isSnapUnit, resolveConfig } from "../src/config";

describe("presence semantics", () => {
  it("enables the four preset-bundled groups when their nest is omitted", () => {
    const resolved = resolveConfig(undefined);
    expect(resolved.selection.mode).toBe("single");
    expect(resolved.dragEdit.enabled).toBe(true);
    expect(resolved.snap.unit).toBe("scale");
    expect(resolved.enabled.tooltip).toBe(true);
  });

  it("disables the six opt-in groups when their nest is omitted", () => {
    const { enabled } = resolveConfig({});
    expect(enabled.contextMenu).toBe(false);
    expect(enabled.zoomControls).toBe(false);
    expect(enabled.clipboard).toBe(false);
    expect(enabled.filterSearch).toBe(false);
    expect(enabled.editDialog).toBe(false);
    expect(enabled.sidePanel).toBe(false);
  });

  it("enables an opt-in group by the mere presence of its nest", () => {
    const { enabled } = resolveConfig({
      contextMenu: {},
      zoomControls: {},
      clipboard: {},
      filterSearch: {},
      editDialog: {},
      sidePanel: {},
    });
    expect(enabled).toEqual({
      tooltip: true,
      contextMenu: true,
      zoomControls: true,
      clipboard: true,
      filterSearch: true,
      editDialog: true,
      sidePanel: true,
    });
  });

  it("treats a whole config that is not an object as absent", () => {
    expect(resolveConfig(null as never).selection.mode).toBe("single");
    expect(resolveConfig(7 as never).dragEdit.enabled).toBe(true);
  });
});

describe("selection", () => {
  it("defaults every shortcut off and the reveal on", () => {
    const { selection } = resolveConfig({});
    expect(selection.shortcuts).toEqual({
      selectAll: false,
      clearOnEscape: false,
      deleteSelected: false,
    });
    expect(selection.revealSelected).toBe(true);
    expect(selection.confirmDelete).toBeUndefined();
  });

  it("takes only the exact literals for the mode and only `true` for a shortcut", () => {
    expect(resolveConfig({ selection: { mode: "multi" } }).selection.mode).toBe("multi");
    expect(resolveConfig({ selection: { mode: "none" } }).selection.mode).toBe("none");
    expect(resolveConfig({ selection: { mode: "MULTI" as never } }).selection.mode).toBe("single");
    expect(
      resolveConfig({ selection: { shortcuts: { selectAll: 1 as never } } }).selection.shortcuts
        .selectAll,
    ).toBe(false);
  });

  it("switches the reveal off only for an explicit `false`", () => {
    expect(resolveConfig({ selection: { revealSelected: false } }).selection.revealSelected).toBe(
      false,
    );
    expect(
      resolveConfig({ selection: { revealSelected: 0 as never } }).selection.revealSelected,
    ).toBe(true);
  });

  it("keeps a function-shaped confirm hook and drops anything else", () => {
    const hook = (): boolean => true;
    expect(resolveConfig({ selection: { confirmDelete: hook } }).selection.confirmDelete).toBe(hook);
    expect(
      resolveConfig({ selection: { confirmDelete: "yes" as never } }).selection.confirmDelete,
    ).toBeUndefined();
  });
});

describe("dragEdit", () => {
  it("defaults every extension off and the feature itself on", () => {
    expect(resolveConfig({}).dragEdit).toEqual({
      enabled: true,
      liveUpdate: false,
      dragTooltip: false,
      minDuration: 0,
      rowDrag: false,
      clickMove: false,
      multiDrag: false,
      autoScroll: false,
      dependencyPreview: false,
      resourceDrag: false,
      frameSync: false,
    });
  });

  it("turns the whole feature off only for an explicit `false`", () => {
    expect(resolveConfig({ dragEdit: { enabled: false } }).dragEdit.enabled).toBe(false);
    expect(resolveConfig({ dragEdit: { enabled: undefined as never } }).dragEdit.enabled).toBe(true);
  });

  it("takes only a positive finite minimum duration", () => {
    expect(resolveConfig({ dragEdit: { minDuration: 3600_000 } }).dragEdit.minDuration).toBe(
      3600_000,
    );
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "1h" as never]) {
      expect(resolveConfig({ dragEdit: { minDuration: bad } }).dragEdit.minDuration).toBe(0);
    }
  });
});

describe("snap", () => {
  it("defaults to the zoom-following unit with every extension off", () => {
    const { snap } = resolveConfig({});
    expect(snap.enabled).toBe(true);
    expect(snap.unit).toBe("scale");
    expect(snap.rule).toBeUndefined();
    expect(snap.working).toBeUndefined();
    expect(snap.align).toBeUndefined();
    expect(snap.pushSuccessors).toBe(false);
  });

  it("is enabled unless the field is explicitly `false`", () => {
    expect(resolveConfig({ snap: {} }).snap.enabled).toBe(true);
    expect(resolveConfig({ snap: { enabled: true } }).snap.enabled).toBe(true);
    expect(resolveConfig({ snap: { enabled: 0 as never } }).snap.enabled).toBe(true);
    expect(resolveConfig({ snap: { enabled: false } }).snap.enabled).toBe(false);
  });

  it("resolves every extension off for a disabled nest, so no gate can be missed", () => {
    const { snap } = resolveConfig({
      snap: {
        enabled: false,
        unit: "week",
        rule: () => ({ snap: (t) => t }),
        workingDays: true,
        alignToTasks: { tolerancePx: 20 },
        pushSuccessors: true,
      },
    });
    expect(snap).toEqual({
      enabled: false,
      unit: "scale",
      rule: undefined,
      working: undefined,
      align: undefined,
      pushSuccessors: false,
    });
  });

  it("accepts a calendar unit and a positive millisecond grid", () => {
    expect(resolveConfig({ snap: { unit: "week" } }).snap.unit).toBe("week");
    expect(resolveConfig({ snap: { unit: 900_000 } }).snap.unit).toBe(900_000);
  });

  it("falls back to the default for an unusable unit", () => {
    for (const bad of [0, -5, Number.NaN, "fortnight" as never]) {
      expect(resolveConfig({ snap: { unit: bad } }).snap.unit).toBe("scale");
    }
  });

  it("folds `workingDays` into its settings", () => {
    expect(resolveConfig({ snap: { workingDays: true } }).snap.working).toEqual({
      calendar: undefined,
    });
    expect(resolveConfig({ snap: { workingDays: { calendar: "site" } } }).snap.working).toEqual({
      calendar: "site",
    });
    expect(resolveConfig({ snap: { workingDays: false } }).snap.working).toBeUndefined();
  });

  it("folds `alignToTasks` into a tolerance, defaulting an unusable one", () => {
    expect(resolveConfig({ snap: { alignToTasks: true } }).snap.align).toEqual({
      tolerancePx: DEFAULT_ALIGN_TOLERANCE_PX,
    });
    expect(resolveConfig({ snap: { alignToTasks: { tolerancePx: 20 } } }).snap.align).toEqual({
      tolerancePx: 20,
    });
    expect(resolveConfig({ snap: { alignToTasks: { tolerancePx: -3 } } }).snap.align).toEqual({
      tolerancePx: DEFAULT_ALIGN_TOLERANCE_PX,
    });
    expect(resolveConfig({ snap: { alignToTasks: false } }).snap.align).toBeUndefined();
  });
});

describe("isSnapUnit", () => {
  it("admits exactly the five calendar units", () => {
    for (const unit of ["year", "month", "week", "day", "hour"]) expect(isSnapUnit(unit)).toBe(true);
    for (const other of ["minute", "", 1, null, undefined]) expect(isSnapUnit(other)).toBe(false);
  });
});
