/**
 * `ResourceConfig` resolution (docs/specs/plugins/resource.md §6).
 *
 * Presence semantics (normative): every OMITTED nest leaves its feature dormant — the resolved
 * nest is `undefined`, and rendered output equals a composition without that plugin — while a
 * nest passed even as `{}` enables it with the documented defaults. Unusable values silently fall
 * back and everything is read once at `setup()`.
 */
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config";

describe("presence semantics (§6)", () => {
  it("leaves every nest dormant when none is passed", () => {
    const config = resolveConfig({});
    expect(config).toEqual({
      pool: undefined,
      assign: undefined,
      view: undefined,
      utilization: undefined,
      loadChart: undefined,
    });
  });

  it("enables a nest passed as `{}` with the documented defaults", () => {
    const config = resolveConfig({
      pool: {},
      assign: {},
      view: {},
      utilization: {},
      loadChart: {},
    });
    expect(config.pool).toMatchObject({ resources: [], bookings: [], syncToStore: false });
    expect(config.assign).toMatchObject({ column: true, columnWidth: 160, dragReassign: true });
    expect(config.view).toMatchObject({ startOpen: false, resizable: true, teams: [] });
    expect(config.utilization).toMatchObject({
      bucket: "day",
      weekStart: "monday",
      threshold: 1,
      warnings: true,
      column: true,
      summaryPanel: false,
      trendPanel: false,
      range: undefined,
      resourceLoad: undefined,
      resourceCapacity: undefined,
    });
    expect(config.loadChart).toMatchObject({
      bucket: "day",
      axisLabels: false,
      valueLabels: false,
      heatmap: false,
      lanes: false,
      total: false,
      laneScale: "ratio",
      laneValueLabels: false,
      resizable: true,
    });
  });

  it("enables one nest without waking the others", () => {
    const config = resolveConfig({ utilization: {} });
    expect(config.utilization).toBeDefined();
    expect(config.pool).toBeUndefined();
    expect(config.assign).toBeUndefined();
    expect(config.view).toBeUndefined();
    expect(config.loadChart).toBeUndefined();
  });
});

describe("unusable values fall back silently", () => {
  it("falls back on unusable scalars", () => {
    const config = resolveConfig({
      assign: { columnWidth: Number.NaN, column: "yes" as unknown as boolean },
      utilization: {
        bucket: "quarter" as never,
        threshold: Number.POSITIVE_INFINITY,
        weekStart: "tuesday" as never,
      },
      loadChart: { laneScale: "wide" as never, bucket: "fortnight" as never },
    });
    expect(config.assign?.columnWidth).toBe(160);
    expect(config.assign?.column).toBe(true);
    expect(config.utilization?.bucket).toBe("day");
    expect(config.utilization?.threshold).toBe(1);
    expect(config.utilization?.weekStart).toBe("monday");
    expect(config.loadChart?.laneScale).toBe("ratio");
    // §6.5 — an unusable `bucket` falls back to `"day"`, never to `"auto"`.
    expect(config.loadChart?.bucket).toBe("day");
  });

  it("keeps `\"auto\"` when the host asks for it", () => {
    expect(resolveConfig({ loadChart: { bucket: "auto" } }).loadChart?.bucket).toBe("auto");
  });

  it("takes the `range` pair only when both members are usable (§6.4)", () => {
    expect(resolveConfig({ utilization: { range: { start: 0 } } }).utilization?.range).toBeUndefined();
    expect(
      resolveConfig({ utilization: { range: { start: Number.NaN, end: 10 } } }).utilization?.range,
    ).toBeUndefined();
    expect(resolveConfig({ utilization: { range: { start: 0, end: 10 } } }).utilization?.range).toEqual({
      start: 0,
      end: 10,
    });
  });

  it("keeps a usable value verbatim", () => {
    const config = resolveConfig({
      assign: { columnWidth: 220, dragReassign: false },
      utilization: { bucket: "minute15", threshold: 0.8, weekStart: "sunday", warnings: false },
      loadChart: { resources: ["a", 2], lanes: true, total: true },
      pool: { syncToStore: true },
      view: { startOpen: true, resizable: false },
    });
    expect(config.assign).toMatchObject({ columnWidth: 220, dragReassign: false });
    expect(config.utilization).toMatchObject({
      bucket: "minute15",
      threshold: 0.8,
      weekStart: "sunday",
      warnings: false,
    });
    expect(config.loadChart).toMatchObject({ resources: ["a", 2], lanes: true, total: true });
    expect(config.pool?.syncToStore).toBe(true);
    expect(config.view).toMatchObject({ startOpen: true, resizable: false });
  });

  it("carries the two per-consumer hook pairs independently (§2.4 / §6.4 / §6.5)", () => {
    const utilizationLoad = (): number => 1;
    const loadChartLoad = (): number => 2;
    const config = resolveConfig({
      utilization: { resourceLoad: utilizationLoad },
      loadChart: { resourceLoad: loadChartLoad },
    });
    expect(config.utilization?.resourceLoad).toBe(utilizationLoad);
    expect(config.utilization?.resourceCapacity).toBeUndefined();
    expect(config.loadChart?.resourceLoad).toBe(loadChartLoad);
    expect(config.loadChart?.resourceCapacity).toBeUndefined();
  });
});
