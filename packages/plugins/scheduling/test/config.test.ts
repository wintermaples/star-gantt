// docs/specs/plugins/scheduling.md §11 — the five configuration nests and their presence semantics.
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config";
import type { SchedulingConfig } from "../src/config";

const raw = (config: unknown): SchedulingConfig => config as SchedulingConfig;

describe("presence semantics", () => {
  it("enables the dependencies nest with its defaults when omitted", () => {
    const config = resolveConfig({});
    expect(config.dependencies.allowLinkCreate).toBe(true);
    expect(config.dependencies.showLinks).toBe(true);
    expect(config.dependencies.routingStyle).toBe("elbow");
  });

  it("leaves calendars, criticalPath and diagnostics dormant when omitted", () => {
    const config = resolveConfig({});
    expect(config.calendars).toBeUndefined();
    expect(config.criticalPath).toBeUndefined();
    expect(config.diagnostics).toBeUndefined();
  });

  it("enables each dormant nest with its defaults when passed even empty", () => {
    const config = resolveConfig({ calendars: {}, criticalPath: {}, diagnostics: {} });
    expect(config.calendars).toEqual({
      calendars: [],
      shadeCalendar: undefined,
      scheduling: true,
      editor: undefined,
    });
    expect(config.criticalPath?.enabled).toBe(true);
    expect(config.criticalPath?.highlightBars).toBe(true);
    expect(config.criticalPath?.highlightLinks).toBe(true);
    expect(config.criticalPath?.showFloat).toBe(false);
    expect(config.diagnostics).toEqual({ panel: false });
  });

  it("needs no presence gating for autoSchedule", () => {
    expect(resolveConfig({}).autoSchedule).toEqual({ enabled: false, modeColumn: false });
  });
});

describe("dependencies (16 fields)", () => {
  it("carries every documented default", () => {
    expect(resolveConfig({}).dependencies).toEqual({
      allowLinkCreate: true,
      routingStyle: "elbow",
      defaultLinkType: "FS",
      defaultLag: undefined,
      showLinks: true,
      linkStyle: { width: 1.5, dash: undefined, arrowHead: "filled" },
      typeColors: {},
      linkEditing: false,
      highlightPaths: false,
      inspector: false,
      highlightDropTargets: false,
      highlightConflicts: false,
      conflictColor: "#dc2626",
      highlightDriving: false,
      cullLines: false,
      avoidBars: false,
    });
  });

  it("takes usable values and falls back per field on unusable ones", () => {
    const config = resolveConfig(
      raw({
        dependencies: {
          allowLinkCreate: false,
          routingStyle: "sideways",
          defaultLinkType: "SS",
          defaultLag: Number.NaN,
          linkStyle: { width: -1, dash: [4, "x"], arrowHead: "open" },
          typeColors: { FS: "#111", SS: "", FF: 7 },
          conflictColor: "",
          avoidBars: "yes",
        },
      }),
    ).dependencies;
    expect(config.allowLinkCreate).toBe(false);
    expect(config.routingStyle).toBe("elbow");
    expect(config.defaultLinkType).toBe("SS");
    expect(config.defaultLag).toBeUndefined();
    expect(config.linkStyle).toEqual({ width: 1.5, dash: undefined, arrowHead: "open" });
    expect(config.typeColors).toEqual({ FS: "#111" });
    expect(config.conflictColor).toBe("#dc2626");
    expect(config.avoidBars).toBe(false);
  });

  it("keeps a usable dash pattern verbatim", () => {
    expect(
      resolveConfig({ dependencies: { linkStyle: { dash: [4, 3] } } }).dependencies.linkStyle.dash,
    ).toEqual([4, 3]);
  });
});

describe("autoSchedule (2 fields)", () => {
  it("turns propagation on only for exactly `true`", () => {
    expect(resolveConfig({ autoSchedule: { enabled: true } }).autoSchedule.enabled).toBe(true);
    expect(resolveConfig({ autoSchedule: { enabled: false } }).autoSchedule.enabled).toBe(false);
    expect(
      resolveConfig(raw({ autoSchedule: { enabled: "yes" } })).autoSchedule.enabled,
    ).toBe(false);
  });

  it("gates the mode column on exactly `true`", () => {
    expect(resolveConfig({ autoSchedule: { modeColumn: true } }).autoSchedule.modeColumn).toBe(true);
    expect(
      resolveConfig(raw({ autoSchedule: { modeColumn: 1 } })).autoSchedule.modeColumn,
    ).toBe(false);
  });
});

describe("calendars (4 fields)", () => {
  it("keeps usable registry entries in order and drops unusable ones", () => {
    const config = resolveConfig(
      raw({
        calendars: {
          calendars: [
            { id: "a", workingDays: [1, 2] },
            { workingDays: [1] },
            { id: "b" },
            { id: "c", workingDays: [] },
            null,
          ],
        },
      }),
    ).calendars;
    expect(config?.calendars.map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("reads the shade calendar and the scheduling reflection", () => {
    expect(resolveConfig({ calendars: { shadeCalendar: "a" } }).calendars?.shadeCalendar).toBe("a");
    expect(
      resolveConfig(raw({ calendars: { shadeCalendar: {} } })).calendars?.shadeCalendar,
    ).toBeUndefined();
    expect(resolveConfig({ calendars: { scheduling: false } }).calendars?.scheduling).toBe(false);
  });

  it("resolves the editor to its canonical section order", () => {
    expect(resolveConfig({ calendars: { editor: true } }).calendars?.editor).toEqual([
      "days",
      "hours",
      "periods",
      "assign",
    ]);
    expect(
      resolveConfig({ calendars: { editor: { sections: ["assign", "days"] } } }).calendars?.editor,
    ).toEqual(["days", "assign"]);
    expect(
      resolveConfig(raw({ calendars: { editor: { sections: ["nope"] } } })).calendars?.editor,
    ).toBeUndefined();
    expect(resolveConfig({ calendars: { editor: false } }).calendars?.editor).toBeUndefined();
  });
});

describe("criticalPath (10 fields)", () => {
  it("keeps finite non-negative day thresholds and drops the rest", () => {
    const config = resolveConfig(
      raw({ criticalPath: { thresholdDays: 2, nearCriticalDays: -1 } }),
    ).criticalPath;
    expect(config?.thresholdDays).toBe(2);
    expect(config?.nearCriticalDays).toBe(0);
  });

  it("keeps only non-empty colour strings", () => {
    const config = resolveConfig(
      raw({ criticalPath: { criticalColor: "#111", nearCriticalColor: "", floatColor: 5 } }),
    ).criticalPath;
    expect(config?.criticalColor).toBe("#111");
    expect(config?.nearCriticalColor).toBeUndefined();
    expect(config?.floatColor).toBeUndefined();
  });

  it("treats `enabled` as a master switch defaulting to on", () => {
    expect(resolveConfig({ criticalPath: { enabled: false } }).criticalPath?.enabled).toBe(false);
    expect(resolveConfig(raw({ criticalPath: { enabled: 0 } })).criticalPath?.enabled).toBe(true);
  });
});

describe("diagnostics (1 field)", () => {
  it("counts as false unless exactly true", () => {
    expect(resolveConfig({ diagnostics: { panel: true } }).diagnostics?.panel).toBe(true);
    expect(resolveConfig(raw({ diagnostics: { panel: "yes" } })).diagnostics?.panel).toBe(false);
  });
});
