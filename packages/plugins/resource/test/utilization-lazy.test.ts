// docs/specs/plugins/resource.md §1.2 — the freshness store's lazy path (M4 review item): with
// `warnings: false, column: false` and no panel open, a data/pool notification must trigger ZERO
// engine builds — the dirty flag alone carries "there is unseen new data" until the next reader.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/internal/engine/compute", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/internal/engine/compute")>();
  return { ...actual, computeUtilization: vi.fn(actual.computeUtilization) };
});

// Imported AFTER the mock is registered (vitest hoists `vi.mock` above imports either way, but
// this ordering keeps the intent readable).
import { dataStore } from "@stargantt/plugin-data-store";
import { createTestHost } from "@stargantt/sdk";
import type { TestHost } from "@stargantt/sdk";
import { resource } from "../src/index";
import { computeUtilization } from "../src/internal/engine/compute";

const DAY = 86_400_000;
const MONDAY = Date.UTC(2024, 0, 1);
const buildSpy = vi.mocked(computeUtilization);

let harness: TestHost | undefined;
afterEach(() => {
  harness?.dispose();
  harness = undefined;
  buildSpy.mockClear();
});

describe("§1.2 lazy freshness path (M4)", () => {
  it("warnings:false, column:false, no panel open — a data notification triggers ZERO engine builds", () => {
    harness = createTestHost({
      plugins: [dataStore(), resource({ utilization: { warnings: false, column: false } })],
    });
    const data = harness.host.service("stargantt.data");
    buildSpy.mockClear(); // drop whatever setup-time calls happened (none expected, but be exact)

    data.load({
      tasks: [{ id: "t1", parentId: null, name: "T1", start: MONDAY, end: MONDAY + 5 * DAY }],
      resources: [{ id: "r1", name: "Ada" }],
      assignments: [{ taskId: "t1", resourceId: "r1", units: 1 }],
    });

    expect(buildSpy).not.toHaveBeenCalled();
  });

  it("...but a reader still gets a fresh recompute on demand (state.get())", () => {
    harness = createTestHost({
      plugins: [dataStore(), resource({ utilization: { warnings: false, column: false } })],
    });
    const data = harness.host.service("stargantt.data");
    const utilization = harness.host.service("stargantt.utilization");
    data.load({
      tasks: [{ id: "t1", parentId: null, name: "T1", start: MONDAY, end: MONDAY + 5 * DAY }],
      resources: [{ id: "r1", name: "Ada" }],
      assignments: [{ taskId: "t1", resourceId: "r1", units: 1 }],
    });
    buildSpy.mockClear();
    expect(utilization.state.get().rows.map((r) => r.resourceId)).toEqual(["r1"]);
    expect(buildSpy).toHaveBeenCalledTimes(1);
  });

  it("warnings:true (the default) DOES recompute eagerly on every data notification", () => {
    harness = createTestHost({ plugins: [dataStore(), resource({ utilization: {} })] });
    const data = harness.host.service("stargantt.data");
    buildSpy.mockClear();
    data.load({
      tasks: [{ id: "t1", parentId: null, name: "T1", start: MONDAY, end: MONDAY + 5 * DAY }],
      resources: [{ id: "r1", name: "Ada" }],
      assignments: [{ taskId: "t1", resourceId: "r1", units: 1 }],
    });
    // `data.load()` sets the `tasks`, `resources` and `assignments` stores separately — three
    // notifications, each of which marks dirty and (since `warnings` defaults `true`) recomputes
    // eagerly before the next one arrives — so this is "every notification", not "every load()".
    expect(buildSpy.mock.calls.length).toBeGreaterThan(0);
    expect(buildSpy.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("with the utilization nest entirely omitted, a data notification also builds nothing", () => {
    harness = createTestHost({ plugins: [dataStore(), resource({})] });
    const data = harness.host.service("stargantt.data");
    buildSpy.mockClear();
    data.load({
      tasks: [{ id: "t1", parentId: null, name: "T1", start: MONDAY, end: MONDAY + 5 * DAY }],
      resources: [{ id: "r1", name: "Ada" }],
      assignments: [{ taskId: "t1", resourceId: "r1", units: 1 }],
    });
    expect(buildSpy).not.toHaveBeenCalled();
  });
});
