// docs/specs/plugins/tracking.md §5 — the four configuration nests and their presence semantics
// (all four dormant when omitted, unlike scheduling's always-on `dependencies` nest).
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config";
import type { TrackingConfig } from "../src/config";

const raw = (config: unknown): TrackingConfig => config as TrackingConfig;

describe("presence semantics", () => {
  it("leaves all four nests dormant when omitted", () => {
    const config = resolveConfig({});
    expect(config.baselines).toBeUndefined();
    expect(config.progress).toBeUndefined();
    expect(config.cost).toBeUndefined();
    expect(config.evm).toBeUndefined();
  });

  it("enables each nest with its defaults when passed even empty", () => {
    const config = resolveConfig({ baselines: {}, progress: {}, cost: {}, evm: {} });
    expect(config.baselines).toBeDefined();
    expect(config.progress).toBeDefined();
    expect(config.cost).toBeDefined();
    expect(config.evm).toBeDefined();
  });
});

describe("baselines (8 fields)", () => {
  it("carries every documented default", () => {
    expect(resolveConfig({ baselines: {} }).baselines).toEqual({
      baselines: [],
      active: undefined,
      bars: true,
      barStyle: "under",
      actualBars: true,
      slipIndicators: true,
      slipThresholdMs: 86_400_000,
      criticalPath: false,
    });
  });

  it("takes usable values and falls back per field on unusable ones", () => {
    const config = resolveConfig(
      raw({
        baselines: {
          bars: false,
          barStyle: "overlay",
          actualBars: "yes",
          slipThresholdMs: Number.NaN,
          criticalPath: true,
        },
      }),
    ).baselines;
    expect(config?.bars).toBe(false);
    expect(config?.barStyle).toBe("overlay");
    expect(config?.actualBars).toBe(true); // unusable -> default
    expect(config?.slipThresholdMs).toBe(86_400_000); // unusable -> default
    expect(config?.criticalPath).toBe(true);
  });
});

describe("progress (6 fields)", () => {
  it("carries every documented default", () => {
    expect(resolveConfig({ progress: {} }).progress).toEqual({
      statusDate: undefined,
      progressLine: false,
      colorBars: false,
      progressWeighting: "count",
      showRagOnBars: true,
      snapshots: [],
    });
  });

  it("falls back on an unusable progressWeighting", () => {
    expect(
      resolveConfig(raw({ progress: { progressWeighting: "duration" } })).progress
        ?.progressWeighting,
    ).toBe("duration");
    expect(
      resolveConfig(raw({ progress: { progressWeighting: "nope" } })).progress?.progressWeighting,
    ).toBe("count");
  });
});

describe("cost (8 fields)", () => {
  it("carries every documented default", () => {
    expect(resolveConfig({ cost: {} }).cost).toEqual({
      rates: [],
      hoursPerDay: 8,
      budget: undefined,
      budgets: {},
      alertThreshold: 1,
      statusDate: undefined,
      formulas: [],
      renderPanel: undefined,
    });
  });

  it("falls back to 1 on a non-positive alertThreshold", () => {
    expect(resolveConfig(raw({ cost: { alertThreshold: 0 } })).cost?.alertThreshold).toBe(1);
    expect(resolveConfig(raw({ cost: { alertThreshold: -2 } })).cost?.alertThreshold).toBe(1);
    expect(resolveConfig(raw({ cost: { alertThreshold: 2.5 } })).cost?.alertThreshold).toBe(2.5);
  });

  it("drops unusable budgets entries and keeps finite ones", () => {
    expect(
      resolveConfig(raw({ cost: { budgets: { a: 100, b: "x", c: Number.NaN } } })).cost?.budgets,
    ).toEqual({ a: 100 });
  });
});

describe("evm (7 fields)", () => {
  it("carries every documented default", () => {
    expect(resolveConfig({ evm: {} }).evm).toEqual({
      method: "percentComplete",
      eacMethod: "cpi",
      formulas: [],
      renderPanel: undefined,
      statusDate: undefined,
      projectBac: undefined,
      snapshots: [],
    });
  });

  it("accepts an enum value or a function for method / eacMethod", () => {
    expect(resolveConfig(raw({ evm: { method: "zeroHundred" } })).evm?.method).toBe("zeroHundred");
    const fn = (): number => 0;
    expect(resolveConfig(raw({ evm: { method: fn } })).evm?.method).toBe(fn);
    expect(resolveConfig(raw({ evm: { method: "bogus" } })).evm?.method).toBe("percentComplete");
    expect(resolveConfig(raw({ evm: { eacMethod: "remaining" } })).evm?.eacMethod).toBe(
      "remaining",
    );
    expect(resolveConfig(raw({ evm: { eacMethod: fn } })).evm?.eacMethod).toBe(fn);
  });
});
