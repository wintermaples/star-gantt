// docs/specs/plugins/resource.md §1.1 — the store-shaped `ResourcePoolService`.
/**
 * Assembles the entry ledger (`pool.ts`) and the booking ledger (`bookings.ts`) into the public,
 * store-shaped service: two `Store`s (`resources`, `bookings`) replace discrete
 * `resourcePool/changed` / `resourcePool/bookingsChanged` events, plus the ledgers' methods carried
 * unchanged. `bookings()` is renamed `bookingsWhere()` (§1.1's one member-level rename).
 *
 * A store is set at most once per observable mutation (this method call actually changed
 * something); `onChanged` fires on exactly those occasions, so `wire.ts` can drive the one-way
 * store mirror (§3.1) from the identical signal a config-time batch load also uses.
 */
import { createStore } from "@stargantt/core";
import type { Store, WritableStore } from "@stargantt/core";
import type { ResourceId, TaskId } from "@stargantt/plugin-data-store";
import { isWorkingInstant } from "@stargantt/sdk";
import type { TimeRange } from "@stargantt/sdk";
import type {
  ResourcePoolEntry,
  ResourcePoolEntryInit,
  ResourceTimeOffInit,
  ResourceWorkCalendar,
} from "../../config";
import type { WorkingTimeSource } from "../engine/working-time";
import { effectiveCalendar, workingIntervalsOf, workingMsOf } from "./calendar";
import { Bookings } from "./bookings";
import { PoolEntries } from "./pool";
import type { ResourceFilter, ResourceTimeOff } from "./pool";

export type { ResourceFilter, ResourceTimeOff } from "./pool";
export type {
  ResourceKind,
  ResourcePoolEntry,
  ResourcePoolEntryInit,
  ResourceTimeOffInit,
  ResourceWorkCalendar,
} from "../../config";
// §1.1 — re-exports from config.ts, the canonical declaration site for every pool input/output type
// that also appears on the plugin's config surface (§6.1). Booking types below have no config
// surface of their own (only `ResourceBookingInit` does, via the `pool.bookings` seed list), so
// they are declared fresh here instead.
import type { BookingState, ResourceBookingInit } from "../../config";
export type { BookingState, ResourceBookingInit } from "../../config";

/** A resolved booking as the service reports it. */
export interface ResourceBooking {
  readonly id: string;
  readonly resourceId: ResourceId;
  readonly taskId: TaskId | null;
  readonly start: number;
  readonly end: number;
  readonly state: BookingState;
  readonly units: number;
  /** The effective flag: the booking's own override when given, else the resource's, at read time. */
  readonly billable: boolean;
  readonly note?: string;
}

/** Filter for `bookingsWhere()`. Members combine with AND. */
export interface BookingFilter {
  resourceId?: ResourceId;
  taskId?: TaskId;
  state?: BookingState;
}

export interface ResourcePoolService {
  readonly resources: Store<readonly ResourcePoolEntry[]>;
  readonly bookings: Store<readonly ResourceBooking[]>;
  entries(filter?: ResourceFilter): readonly ResourcePoolEntry[];
  get(id: ResourceId): ResourcePoolEntry | undefined;
  upsert(init: ResourcePoolEntryInit): ResourceId | undefined;
  remove(id: ResourceId): void;
  addSkill(id: ResourceId, skill: string): void;
  removeSkill(id: ResourceId, skill: string): void;
  setCalendar(id: ResourceId, calendar: ResourceWorkCalendar | undefined): void;
  timeOff(id: ResourceId): readonly ResourceTimeOff[];
  addTimeOff(id: ResourceId, init: ResourceTimeOffInit): string | undefined;
  removeTimeOff(id: ResourceId, timeOffId: string): void;
  isWorking(id: ResourceId, epochMs: number): boolean;
  workingIntervals(id: ResourceId, from: number, to: number, out?: TimeRange[]): TimeRange[];
  workingMs(id: ResourceId, from: number, to: number): number;
  bookingsWhere(filter?: BookingFilter): readonly ResourceBooking[];
  book(init: ResourceBookingInit): string | undefined;
  setBookingState(id: string, state: BookingState): void;
  cancelBooking(id: string): void;
}

/** Everything `wire.ts` needs: the assembled service plus raw access for the setup-time seed load. */
export interface PoolServiceHost {
  service: ResourcePoolService;
  /** The raw entry ledger — used ONLY by `wire.ts`'s config seed loop (§6.1), which batches every
   *  loaded entry into at most one `resources` set rather than one per entry. */
  entries: PoolEntries;
  /** The raw booking ledger — same seed-loop use for `pool.bookings`. */
  bookingsLedger: Bookings;
  resources: WritableStore<readonly ResourcePoolEntry[]>;
  bookingsStore: WritableStore<readonly ResourceBooking[]>;
  /** Commits the entries ledger's current snapshot to the `resources` store and fires `onChanged`.
   *  `wire.ts` calls this once after a seed loop that changed anything; every service method that
   *  mutates an entry calls it internally under the same rule. */
  commitEntries(): void;
  commitBookings(): void;
  /** The `WorkingIntervalCache`'s source (§2.3): `knows`/`intervalsOf` over the entry ledger. */
  workingTimeSource: WorkingTimeSource;
}

/**
 * Builds the pool's service host. `onChanged` fires once per store actually set — the signal
 * `wire.ts` drives the `pool.syncToStore` mirror from (§3.1: "reconciled after ... every entry
 * mutation" — bookings never mirror, so only entry commits call it).
 */
export function createPoolServiceHost(onChanged: () => void): PoolServiceHost {
  const entries = new PoolEntries();
  const bookingsLedger = new Bookings();
  const resources: WritableStore<readonly ResourcePoolEntry[]> = createStore([]);
  const bookingsStore: WritableStore<readonly ResourceBooking[]> = createStore([]);

  const billableOf = (id: ResourceId): boolean => entries.get(id)?.billable ?? true;

  function commitEntries(): void {
    resources.set(entries.entries());
    onChanged();
  }
  function commitBookings(): void {
    bookingsStore.set(bookingsLedger.bookingsWhere(undefined, billableOf));
  }

  const workingTimeSource: WorkingTimeSource = {
    knows: (id) => entries.has(id),
    intervalsOf: (id, from, to, out) => {
      const raw = entries.calendarOf(id);
      if (raw === undefined) return;
      workingIntervalsOf(raw.calendar, raw.timeOff, from, to, out);
    },
  };

  const service: ResourcePoolService = {
    resources,
    bookings: bookingsStore,
    entries: (filter) => entries.entries(filter),
    get: (id) => entries.get(id),
    upsert(init) {
      const result = entries.upsert(init);
      if (result !== undefined && result.changed) commitEntries();
      return result?.id;
    },
    remove(id) {
      const removed = entries.remove(id);
      if (!removed) return;
      commitEntries();
      const removedBookingIds = bookingsLedger.removeByResource(id);
      if (removedBookingIds.length > 0) commitBookings();
    },
    addSkill(id, skill) {
      if (entries.addSkill(id, skill)) commitEntries();
    },
    removeSkill(id, skill) {
      if (entries.removeSkill(id, skill)) commitEntries();
    },
    setCalendar(id, calendar) {
      if (entries.setCalendar(id, calendar)) commitEntries();
    },
    timeOff: (id) => entries.timeOff(id),
    addTimeOff(id, init) {
      const rangeId = entries.addTimeOff(id, init);
      if (rangeId !== undefined) commitEntries();
      return rangeId;
    },
    removeTimeOff(id, timeOffId) {
      if (entries.removeTimeOff(id, timeOffId)) commitEntries();
    },
    isWorking(id, epochMs) {
      const raw = entries.calendarOf(id);
      if (raw === undefined || !Number.isFinite(epochMs)) return false;
      if (raw.timeOff.some((r) => epochMs >= r.start && epochMs < r.end)) return false;
      return isWorkingInstant(effectiveCalendar(raw.calendar), epochMs);
    },
    workingIntervals(id, from, to, out) {
      const list = out ?? [];
      const raw = entries.calendarOf(id);
      if (raw === undefined) return list;
      return workingIntervalsOf(raw.calendar, raw.timeOff, from, to, list);
    },
    workingMs(id, from, to) {
      const raw = entries.calendarOf(id);
      if (raw === undefined) return 0;
      return workingMsOf(raw.calendar, raw.timeOff, from, to);
    },
    bookingsWhere: (filter) => bookingsLedger.bookingsWhere(filter, billableOf),
    book(init) {
      const id = bookingsLedger.book(init, (rid) => entries.has(rid));
      if (id !== undefined) commitBookings();
      return id;
    },
    setBookingState(id, state) {
      if (bookingsLedger.setBookingState(id, state)) commitBookings();
    },
    cancelBooking(id) {
      if (bookingsLedger.cancelBooking(id)) commitBookings();
    },
  };

  return {
    service,
    entries,
    bookingsLedger,
    resources,
    bookingsStore,
    commitEntries,
    commitBookings,
    workingTimeSource,
  };
}
