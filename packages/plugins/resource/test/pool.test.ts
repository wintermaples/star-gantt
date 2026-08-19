// docs/specs/plugins/resource.md §1.1 / §3.1 / §3.2 — the resource-pool ledger.
// Covers entries, calendar/time-off, bookings, and store sync.
import { afterEach, describe, expect, it } from "vitest";
import { dataStore } from "@stargantt/plugin-data-store";
import { createTestHost } from "@stargantt/sdk";
import type { TestHost } from "@stargantt/sdk";
import { resource } from "../src/index";
import type { ResourcePoolService } from "../src/index";

const DAY = 86_400_000;

let harness: TestHost | undefined;
afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

function boot(config: Parameters<typeof resource>[0] = {}): ResourcePoolService {
  harness = createTestHost({ plugins: [dataStore(), resource(config)] });
  return harness.host.service("stargantt.resource-pool");
}

describe("entries (§1.1)", () => {
  it("creating requires a usable name; unusable inits are rejected", () => {
    const pool = boot();
    expect(pool.upsert({})).toBeUndefined();
    expect(pool.upsert({ name: "   " })).toBeUndefined();
    const id = pool.upsert({ name: "Ada" });
    expect(id).toBeDefined();
    expect(pool.get(id!)).toMatchObject({ name: "Ada", kind: "person", billable: true, skills: [] });
  });

  it("capacity: non-finite/non-positive is absent, never defaulted to 1", () => {
    const pool = boot();
    const id = pool.upsert({ name: "Ada", capacity: 0 })!;
    expect(pool.get(id)!.capacity).toBeUndefined();
    const id2 = pool.upsert({ name: "Bob", capacity: 0.5 })!;
    expect(pool.get(id2)!.capacity).toBe(0.5);
  });

  it("skills are trimmed, deduplicated, and order-kept", () => {
    const pool = boot();
    const id = pool.upsert({ name: "Ada", skills: ["js", " js ", "ts", ""] })!;
    expect(pool.get(id)!.skills).toEqual(["js", "ts"]);
  });

  it("update only changes the fields the init states", () => {
    const pool = boot();
    const id = pool.upsert({ name: "Ada", kind: "equipment" })!;
    pool.upsert({ id, capacity: 2 });
    expect(pool.get(id)).toMatchObject({ name: "Ada", kind: "equipment", capacity: 2 });
  });

  it("remove cascades time off and bookings", () => {
    const pool = boot();
    const id = pool.upsert({ name: "Ada" })!;
    pool.addTimeOff(id, { start: 0, end: DAY });
    const bookingId = pool.book({ resourceId: id, start: 0, end: DAY });
    pool.remove(id);
    expect(pool.get(id)).toBeUndefined();
    expect(pool.bookingsWhere({ resourceId: id })).toEqual([]);
    void bookingId;
  });

  it("entries() filters combine with AND", () => {
    const pool = boot();
    pool.upsert({ name: "Ada", kind: "person", skills: ["js"] });
    pool.upsert({ name: "Crane", kind: "equipment", skills: ["js"] });
    expect(pool.entries({ kind: "person", skills: ["js"] }).map((e) => e.name)).toEqual(["Ada"]);
    expect(pool.entries({ text: "ada" }).map((e) => e.name)).toEqual(["Ada"]);
  });
});

describe("resources / bookings stores (§1.1, store-shaped)", () => {
  it("sets `resources` once per observable mutation, never for a no-op", () => {
    const pool = boot();
    let notifications = 0;
    pool.resources.subscribe(() => {
      notifications += 1;
    });
    const id = pool.upsert({ name: "Ada" })!;
    expect(notifications).toBe(1);
    // No-op: nothing stated differs from the stored entry.
    pool.upsert({ id, name: "Ada" });
    expect(notifications).toBe(1);
    pool.upsert({ id, name: "Ada Lovelace" });
    expect(notifications).toBe(2);
  });

  it("config-loaded entries set the store once, with cause folded into the initial value", () => {
    harness = createTestHost({
      plugins: [dataStore(), resource({ pool: { resources: [{ name: "Ada" }, { name: "Bob" }] } })],
    });
    const pool: ResourcePoolService = harness.host.service("stargantt.resource-pool");
    expect(pool.resources.get().map((e) => e.name)).toEqual(["Ada", "Bob"]);
  });

  it("bookings() is renamed bookingsWhere() (§1.1 naming resolution)", () => {
    const pool = boot();
    const id = pool.upsert({ name: "Ada" })!;
    const bookingId = pool.book({ resourceId: id, start: 0, end: DAY, units: 0.5 })!;
    expect(pool.bookingsWhere()).toHaveLength(1);
    expect(pool.bookingsWhere({ state: "confirmed" })).toEqual([]);
    pool.setBookingState(bookingId, "confirmed");
    expect(pool.bookingsWhere({ state: "confirmed" })).toHaveLength(1);
  });

  it("billable resolves booking-override-else-entry at read time", () => {
    const pool = boot();
    const id = pool.upsert({ name: "Ada", billable: false })!;
    const bookingId = pool.book({ resourceId: id, start: 0, end: DAY })!;
    expect(pool.bookingsWhere()[0]!.billable).toBe(false);
    pool.cancelBooking(bookingId);
    const overrideId = pool.book({ resourceId: id, start: 0, end: DAY, billable: true })!;
    expect(pool.bookingsWhere({ resourceId: id })[0]!.billable).toBe(true);
    void overrideId;
  });
});

describe("calendar, time off, working time (§3.1)", () => {
  it("defaults to Monday-Friday when no calendar is given", () => {
    const pool = boot();
    const id = pool.upsert({ name: "Ada" })!;
    const MONDAY = Date.UTC(2024, 0, 1);
    const SATURDAY = MONDAY + 5 * DAY;
    expect(pool.isWorking(id, MONDAY)).toBe(true);
    expect(pool.isWorking(id, SATURDAY)).toBe(false);
  });

  it("workingIntervals subtracts time off, splitting the day around it", () => {
    const pool = boot();
    const id = pool.upsert({ name: "Ada" })!;
    const MONDAY = Date.UTC(2024, 0, 1);
    pool.addTimeOff(id, { start: MONDAY + 4 * 3_600_000, end: MONDAY + 6 * 3_600_000 });
    const intervals = pool.workingIntervals(id, MONDAY, MONDAY + DAY);
    expect(intervals).toEqual([
      { start: MONDAY, end: MONDAY + 4 * 3_600_000 },
      { start: MONDAY + 6 * 3_600_000, end: MONDAY + DAY },
    ]);
  });

  it("workingMs is exactly the summed length of workingIntervals for the same args", () => {
    const pool = boot();
    const id = pool.upsert({ name: "Ada" })!;
    const MONDAY = Date.UTC(2024, 0, 1);
    const from = MONDAY;
    const to = MONDAY + 3 * DAY;
    const intervals = pool.workingIntervals(id, from, to);
    const summed = intervals.reduce((total, r) => total + (r.end - r.start), 0);
    expect(pool.workingMs(id, from, to)).toBe(summed);
  });

  it("unknown resource: isWorking false, workingIntervals empty, workingMs 0", () => {
    const pool = boot();
    expect(pool.isWorking("nope", 0)).toBe(false);
    expect(pool.workingIntervals("nope", 0, DAY)).toEqual([]);
    expect(pool.workingMs("nope", 0, DAY)).toBe(0);
  });
});

describe("pool.syncToStore (§3.1)", () => {
  it("mirrors id/name/capacity one-way into the data store", () => {
    harness = createTestHost({
      plugins: [dataStore(), resource({ pool: { syncToStore: true, resources: [{ name: "Ada", capacity: 1 }] } })],
    });
    const data = harness.host.service("stargantt.data");
    const names = [...data.query().resources.values()].map((r) => r.name);
    expect(names).toEqual(["Ada"]);
  });

  it("removing a mirrored entry removes it from the store too", () => {
    harness = createTestHost({ plugins: [dataStore(), resource({ pool: { syncToStore: true } })] });
    const pool: ResourcePoolService = harness.host.service("stargantt.resource-pool");
    const data = harness.host.service("stargantt.data");
    const id = pool.upsert({ name: "Ada" })!;
    expect(data.query().resources.has(id)).toBe(true);
    pool.remove(id);
    expect(data.query().resources.has(id)).toBe(false);
  });

  it("without syncToStore, the pool never touches the data store", () => {
    harness = createTestHost({ plugins: [dataStore(), resource({ pool: {} })] });
    const pool: ResourcePoolService = harness.host.service("stargantt.resource-pool");
    const data = harness.host.service("stargantt.data");
    pool.upsert({ name: "Ada" });
    expect(data.query().resources.size).toBe(0);
  });
});
