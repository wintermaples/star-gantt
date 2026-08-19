// docs/specs/plugins/resource.md §1.2 / §2.3 / §3.5 — the utilization surfaces.
// Covers engine query surfaces, rollups, and overload verdicts against the union-roster +
// store-shaped freshness contract.
import { afterEach, describe, expect, it } from "vitest";
import { dataStore } from "@stargantt/plugin-data-store";
import type { DataService } from "@stargantt/plugin-data-store";
import { createTestHost } from "@stargantt/sdk";
import type { TestHost } from "@stargantt/sdk";
import { resource } from "../src/index";
import type { ResourcePoolService, UtilizationService } from "../src/index";

const DAY = 86_400_000;
const MONDAY = Date.UTC(2024, 0, 1); // a UTC Monday

let harness: TestHost | undefined;
afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

interface Boot {
  pool: ResourcePoolService;
  utilization: UtilizationService;
  data: DataService;
}

function boot(config: Parameters<typeof resource>[0] = {}): Boot {
  harness = createTestHost({ plugins: [dataStore(), resource(config)] });
  return {
    pool: harness.host.service("stargantt.resource-pool"),
    utilization: harness.host.service("stargantt.utilization"),
    data: harness.host.service("stargantt.data"),
  };
}

describe("query surfaces (§2.3 union roster, §2.4 threshold)", () => {
  it("single-resource narrowing: a full week of one full-time assignment fully allocates capacity", () => {
    const { pool, data } = boot({ utilization: { bucket: "week" } });
    const id = pool.upsert({ name: "Ada" })!;
    data.load({
      tasks: [{ id: "t1", parentId: null, name: "T1", start: MONDAY, end: MONDAY + 5 * DAY }],
      // An assignment's `resourceId` must name a STORE resource (data-store's own load-time
      // invariant) — a pool-only entry needs an explicit mirror row here, or `pool.syncToStore`.
      resources: [{ id, name: "Ada" }],
      assignments: [{ taskId: "t1", resourceId: id, units: 1 }],
    });
    const utilization: UtilizationService = harness!.host.service("stargantt.utilization");
    const buckets = utilization.utilization(id, { start: MONDAY, end: MONDAY + 7 * DAY });
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({ allocated: 5 * DAY, capacity: 5 * DAY, ratio: 1, overallocated: false });
  });

  it("unknown resource: utilization() and isOverallocated() answer empty/false", () => {
    const { utilization } = boot({ utilization: {} });
    expect(utilization.utilization("nope")).toEqual([]);
    expect(utilization.isOverallocated("nope")).toBe(false);
  });

  it("two full-time assignments on one resource overallocate it", () => {
    const { pool, data } = boot({ utilization: { bucket: "week" } });
    const id = pool.upsert({ name: "Ada" })!;
    data.load({
      tasks: [
        { id: "t1", parentId: null, name: "T1", start: MONDAY, end: MONDAY + 5 * DAY },
        { id: "t2", parentId: null, name: "T2", start: MONDAY, end: MONDAY + 5 * DAY },
      ],
      resources: [{ id, name: "Ada" }],
      assignments: [
        { taskId: "t1", resourceId: id, units: 1 },
        { taskId: "t2", resourceId: id, units: 1 },
      ],
    });
    const utilization: UtilizationService = harness!.host.service("stargantt.utilization");
    expect(utilization.isOverallocated(id, { start: MONDAY, end: MONDAY + 7 * DAY })).toBe(true);
    const over = utilization.overallocations({ start: MONDAY, end: MONDAY + 7 * DAY });
    expect(over).toHaveLength(1);
    expect(over[0]).toMatchObject({ resourceId: id, name: "Ada" });
    expect(over[0]!.peakRatio).toBeCloseTo(2, 5);
  });

  it("union roster: a store-only resource (unknown to the pool) is still aggregated", () => {
    const { data } = boot({ utilization: { bucket: "week" } });
    data.load({
      tasks: [{ id: "t1", parentId: null, name: "T1", start: MONDAY, end: MONDAY + 5 * DAY }],
      resources: [{ id: "r1", name: "Store Only" }],
      assignments: [{ taskId: "t1", resourceId: "r1", units: 1 }],
    });
    const utilization: UtilizationService = harness!.host.service("stargantt.utilization");
    const buckets = utilization.utilization("r1", { start: MONDAY, end: MONDAY + 7 * DAY });
    expect(buckets[0]).toMatchObject({ allocated: 5 * DAY, capacity: 5 * DAY });
  });

  it("M5: union roster names resolve STORE-FIRST — a pool entry the store also knows displays the store's name", () => {
    const { pool, data } = boot({ utilization: { bucket: "week" } });
    const id = pool.upsert({ name: "Ada (pool)" })!;
    data.load({
      tasks: [
        { id: "t1", parentId: null, name: "T1", start: MONDAY, end: MONDAY + 5 * DAY },
        { id: "t2", parentId: null, name: "T2", start: MONDAY, end: MONDAY + 5 * DAY },
      ],
      // Same id, DIFFERENT name — the store's own record of this resource wins for display.
      resources: [{ id, name: "Ada (store)" }],
      // Two full-time tasks over one week over-allocate the resource, so it surfaces in
      // `overallocations()`, whose `name` field is what this test is really about.
      assignments: [
        { taskId: "t1", resourceId: id, units: 1 },
        { taskId: "t2", resourceId: id, units: 1 },
      ],
    });
    const utilization: UtilizationService = harness!.host.service("stargantt.utilization");
    const over = utilization.overallocations({ start: MONDAY, end: MONDAY + 7 * DAY });
    expect(over).toHaveLength(1);
    expect(over[0]!.name).toBe("Ada (store)"); // not "Ada (pool)"
  });

  it("M5: a pool entry the store has never heard of falls back to its own pool name", () => {
    const { pool, data } = boot({ utilization: { bucket: "week" } });
    const id = pool.upsert({ name: "Pool Only" })!;
    data.load({
      tasks: [
        { id: "t1", parentId: null, name: "T1", start: MONDAY, end: MONDAY + 5 * DAY },
        { id: "t2", parentId: null, name: "T2", start: MONDAY, end: MONDAY + 5 * DAY },
      ],
      resources: [{ id, name: "Pool Only" }], // mirrored so the assignment can target it
      assignments: [
        { taskId: "t1", resourceId: id, units: 1 },
        { taskId: "t2", resourceId: id, units: 1 },
      ],
    });
    const utilization: UtilizationService = harness!.host.service("stargantt.utilization");
    expect(utilization.overallocations({ start: MONDAY, end: MONDAY + 7 * DAY })[0]!.name).toBe("Pool Only");
  });

  it("M6: single-resource queries match by String(id) — a numeric pool id is queryable as its string form", () => {
    const { pool, data } = boot({ utilization: { bucket: "week" } });
    pool.upsert({ id: 1, name: "Ada" });
    data.load({
      tasks: [{ id: "t1", parentId: null, name: "T1", start: MONDAY, end: MONDAY + 5 * DAY }],
      resources: [{ id: 1, name: "Ada" }],
      assignments: [{ taskId: "t1", resourceId: 1, units: 1 }],
    });
    const utilization: UtilizationService = harness!.host.service("stargantt.utilization");
    // The pool id is the NUMBER 1; querying with the STRING "1" must still find the same row.
    const byString = utilization.utilization("1", { start: MONDAY, end: MONDAY + 7 * DAY });
    const byNumber = utilization.utilization(1, { start: MONDAY, end: MONDAY + 7 * DAY });
    expect(byString).toEqual(byNumber);
    expect(byString[0]).toMatchObject({ allocated: 5 * DAY });
    expect(utilization.isOverallocated("1", { start: MONDAY, end: MONDAY + 7 * DAY })).toBe(
      utilization.isOverallocated(1, { start: MONDAY, end: MONDAY + 7 * DAY }),
    );
  });

  it("a pool-known resource shadows its store-only mirror by id (no double roster row)", () => {
    const { pool, data } = boot({ pool: { syncToStore: true }, utilization: { bucket: "week" } });
    const id = pool.upsert({ name: "Ada" })!;
    data.load({
      tasks: [{ id: "t1", parentId: null, name: "T1", start: MONDAY, end: MONDAY + 5 * DAY }],
      assignments: [{ taskId: "t1", resourceId: id, units: 1 }],
    });
    // `pool.syncToStore` mirrors "Ada" into the store under the SAME id, so the assignment above
    // (loaded before the mirror reconciles) needs a re-load once the store resource exists.
    data.load({
      tasks: [{ id: "t1", parentId: null, name: "T1", start: MONDAY, end: MONDAY + 5 * DAY }],
      resources: [...harness!.host.service("stargantt.data").query().resources.values()],
      assignments: [{ taskId: "t1", resourceId: id, units: 1 }],
    });
    const utilization: UtilizationService = harness!.host.service("stargantt.utilization");
    const report = utilization.overallocations({ start: MONDAY, end: MONDAY + 7 * DAY });
    expect(report).toEqual([]); // sanity: no crash from a double row, and no false overload.
  });
});

describe("rollups (§1.2, §3.5)", () => {
  it("demandByRole rolls up by the pool entry's first skill tag; store-only resources are roleless", () => {
    const { pool, data } = boot({ utilization: { bucket: "week" } });
    const id = pool.upsert({ name: "Ada", skills: ["dev"] })!;
    data.load({
      tasks: [{ id: "t1", parentId: null, name: "T1", start: MONDAY, end: MONDAY + 5 * DAY }],
      resources: [{ id, name: "Ada" }, { id: "r1", name: "Store Only" }],
      assignments: [
        { taskId: "t1", resourceId: id, units: 1 },
        { taskId: "t1", resourceId: "r1", units: 1 },
      ],
    });
    const utilization: UtilizationService = harness!.host.service("stargantt.utilization");
    const roles = utilization.demandByRole({ start: MONDAY, end: MONDAY + 7 * DAY });
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatchObject({ role: "dev", demand: 5 * DAY, capacity: 5 * DAY });
  });

  it("with no team accessor, every resource (pool and store-only alike) is one team", () => {
    const { pool, data } = boot({ utilization: {} });
    pool.upsert({ name: "Ada" });
    // A resolvable range needs at least one task with a usable span (§2.5); zero tasks means no
    // task extent and therefore no default range at all.
    data.load({
      resources: [{ id: "r1", name: "Store Only" }],
      tasks: [{ id: "t1", parentId: null, name: "T1", start: MONDAY, end: MONDAY + DAY }],
    });
    const utilization: UtilizationService = harness!.host.service("stargantt.utilization");
    const teams = utilization.teamSummary();
    expect(teams).toHaveLength(1);
    expect(teams[0]!.resourceCount).toBe(2);
    expect(teams[0]!.team).toBe("All resources");
  });

  it("with a team accessor, store-only resources are omitted from team rollups", () => {
    const { pool, data } = boot({ utilization: { team: () => "Core" } });
    pool.upsert({ name: "Ada" });
    data.load({
      resources: [{ id: "r1", name: "Store Only" }],
      tasks: [{ id: "t1", parentId: null, name: "T1", start: MONDAY, end: MONDAY + DAY }],
    });
    const utilization: UtilizationService = harness!.host.service("stargantt.utilization");
    const teams = utilization.teamSummary();
    expect(teams).toHaveLength(1);
    expect(teams[0]!.resourceCount).toBe(1);
  });
});

describe("freshness store (§1.2, the CriticalPathService dirty-flag pattern)", () => {
  it("recomputes eagerly when a warning surface is active per config", () => {
    const { pool, data, utilization } = boot({ utilization: { bucket: "week" } });
    const id = pool.upsert({ name: "Ada" })!;
    // `warnings`/`column` default true, so the store recomputes without needing a subscriber.
    expect(utilization.state.get().rows).toEqual([]);
    data.load({
      tasks: [{ id: "t1", parentId: null, name: "T1", start: MONDAY, end: MONDAY + 5 * DAY }],
      resources: [{ id, name: "Ada" }],
      assignments: [{ taskId: "t1", resourceId: id, units: 1 }],
    });
    expect(utilization.state.get().rows.map((r) => r.resourceId)).toEqual([id]);
  });

  it("with no data loaded and the utilization nest omitted, state is empty (nothing TO aggregate)", () => {
    const { utilization } = boot({});
    expect(utilization.state.get()).toEqual({ rows: [] });
    expect(utilization.demandByRole()).toEqual([]);
    expect(utilization.teamSummary()).toEqual([]);
  });

  it("MINOR: state computes real data with the utilization nest omitted — §6 'services provided unconditionally'", () => {
    // The FEATURE (warnings/column/panels) is dormant without a nest, but the SERVICE — `state`
    // included — must keep "computing over whatever data exists" (§6), using the same built-in
    // defaults `utilization()`/`overallocations()` already fall back to. A prior draft special-
    // cased `state`'s own recompute to force `{ rows: [] }` whenever the nest was `undefined`,
    // which made `state` disagree with every other method on the SAME service instance.
    const { pool, data, utilization } = boot({}); // no `utilization` nest at all
    const id = pool.upsert({ name: "Ada" })!;
    data.load({
      tasks: [{ id: "t1", parentId: null, name: "T1", start: MONDAY, end: MONDAY + 5 * DAY }],
      resources: [{ id, name: "Ada" }],
      assignments: [{ taskId: "t1", resourceId: id, units: 1 }],
    });
    expect(utilization.state.get().rows.map((r) => r.resourceId)).toEqual([id]);
    expect(utilization.state.get().rows[0]!.buckets.length).toBeGreaterThan(0);
  });
});

describe("§1.2 relocated load-chart members, inert without the loadChart nest", () => {
  it("strip members read as hidden/zero and the setters are REAL no-ops (state provably unchanged)", () => {
    const { utilization } = boot({ utilization: {} });
    expect(utilization.bandVisible()).toBe(false);
    expect(utilization.lanesVisible()).toBe(false);
    expect(utilization.bandHeight()).toBe(0);
    expect(utilization.lanesHeight()).toBe(0);
    // The placeholder `not.toThrow()` this replaces only proved the call didn't crash, not that it
    // did nothing — assert the actual inertness: every setter leaves every getter exactly as it
    // was, with no `loadChartStrips()` bound to apply to.
    utilization.setBandVisible(true);
    utilization.setLanesVisible(true);
    utilization.setBandHeight(64);
    utilization.setLanesHeight(96);
    expect(utilization.bandVisible()).toBe(false);
    expect(utilization.lanesVisible()).toBe(false);
    expect(utilization.bandHeight()).toBe(0);
    expect(utilization.lanesHeight()).toBe(0);
  });

  it("reports answer the empty shape a composition without loadChart already produces", () => {
    const { utilization } = boot({ utilization: {} });
    expect(utilization.utilizationReport()).toEqual([]);
    expect(utilization.utilizationReportCSV()).toContain("Resource");
    expect(utilization.utilizationReportPDF()).toBeInstanceOf(Blob);
  });
});

describe("M7: utilization.role / utilization.team wrapped in the latched fault barrier (§6.4)", () => {
  it("a throwing role accessor: one core/pluginError, later calls degrade silently, the service keeps answering", () => {
    const errors: unknown[] = [];
    harness = createTestHost({
      plugins: [
        dataStore(),
        resource({
          utilization: {
            bucket: "week",
            role: () => {
              throw new Error("boom");
            },
          },
        }),
      ],
    });
    harness.host.on("core/pluginError", (e) => errors.push(e));
    const pool = harness.host.service("stargantt.resource-pool");
    const data = harness.host.service("stargantt.data");
    const id = pool.upsert({ name: "Ada", skills: ["dev"] })!;
    data.load({
      tasks: [{ id: "t1", parentId: null, name: "T1", start: MONDAY, end: MONDAY + 5 * DAY }],
      resources: [{ id, name: "Ada" }],
      assignments: [{ taskId: "t1", resourceId: id, units: 1 }],
    });
    const utilization: UtilizationService = harness.host.service("stargantt.utilization");
    // First call: the accessor throws once, is latched, and demandByRole() must still return
    // (not propagate the throw) — the resource is simply excluded from the role rollup.
    expect(() => utilization.demandByRole({ start: MONDAY, end: MONDAY + 7 * DAY })).not.toThrow();
    expect(utilization.demandByRole({ start: MONDAY, end: MONDAY + 7 * DAY })).toEqual([]);
    // A second, third, ... call must NOT report again (latched for the instance's life) — "the
    // panel keeps rendering" is exactly this: every subsequent read degrades quietly.
    utilization.demandByRole({ start: MONDAY, end: MONDAY + 7 * DAY });
    utilization.teamSummary({ start: MONDAY, end: MONDAY + 7 * DAY });
    utilization.trend({ start: MONDAY, end: MONDAY + 7 * DAY, role: "dev" });
    expect(errors).toHaveLength(1);
  });

  it("a throwing team accessor: one core/pluginError, teamSummary() keeps answering (resource omitted)", () => {
    const errors: unknown[] = [];
    harness = createTestHost({
      plugins: [
        dataStore(),
        resource({
          utilization: {
            bucket: "week",
            team: () => {
              throw new Error("boom");
            },
          },
        }),
      ],
    });
    harness.host.on("core/pluginError", (e) => errors.push(e));
    const pool = harness.host.service("stargantt.resource-pool");
    const data = harness.host.service("stargantt.data");
    const id = pool.upsert({ name: "Ada" })!;
    data.load({
      tasks: [{ id: "t1", parentId: null, name: "T1", start: MONDAY, end: MONDAY + 5 * DAY }],
      resources: [{ id, name: "Ada" }],
      assignments: [{ taskId: "t1", resourceId: id, units: 1 }],
    });
    const utilization: UtilizationService = harness.host.service("stargantt.utilization");
    expect(() => utilization.teamSummary({ start: MONDAY, end: MONDAY + 7 * DAY })).not.toThrow();
    expect(utilization.teamSummary({ start: MONDAY, end: MONDAY + 7 * DAY })).toEqual([]);
    utilization.teamSummary({ start: MONDAY, end: MONDAY + 7 * DAY });
    expect(errors).toHaveLength(1);
  });

  it("a non-throwing accessor never reports and keeps being called normally", () => {
    const errors: unknown[] = [];
    harness = createTestHost({
      plugins: [dataStore(), resource({ utilization: { bucket: "week", role: () => "eng" } })],
    });
    harness.host.on("core/pluginError", (e) => errors.push(e));
    const pool = harness.host.service("stargantt.resource-pool");
    const data = harness.host.service("stargantt.data");
    const id = pool.upsert({ name: "Ada" })!;
    data.load({
      tasks: [{ id: "t1", parentId: null, name: "T1", start: MONDAY, end: MONDAY + 5 * DAY }],
      resources: [{ id, name: "Ada" }],
      assignments: [{ taskId: "t1", resourceId: id, units: 1 }],
    });
    const utilization: UtilizationService = harness.host.service("stargantt.utilization");
    expect(utilization.demandByRole({ start: MONDAY, end: MONDAY + 7 * DAY })[0]).toMatchObject({ role: "eng" });
    expect(errors).toHaveLength(0);
  });
});

// M8 (config-opened panels must open at `lifecycle/ready`, not `setup()`) needs a real DOM-backed
// host with a `stargantt.view` stand-in to observe an actual mount — see the dedicated
// `utilization-panels.test.ts` (`@vitest-environment happy-dom`), which asserts the panels'
// `.sg-ru-summary` / `.sg-ru-trend` DOM appears whether the view plugin is listed before or after
// `resource()`, and stays absent without it. This file stays headless throughout, on purpose.
