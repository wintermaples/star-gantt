// docs/specs/plugins/resource.md §1.1 / §3.2 — bookings.
/**
 * The booking half of the ledger: a dated hold independent of assignments, in two stages
 * (tentative / confirmed). Hostless.
 */
import type { ResourceId } from "@stargantt/plugin-data-store";
import type { BookingFilter, BookingState, ResourceBooking, ResourceBookingInit } from "./service";
import { isPlainObject } from "./pool";

const STATES: readonly BookingState[] = ["tentative", "confirmed"];

interface Booking {
  id: string;
  resourceId: ResourceId;
  taskId: ResourceBooking["taskId"];
  start: number;
  end: number;
  state: BookingState;
  units: number;
  /** The stored override; `undefined` defers to the owning entry at read time. */
  billable: boolean | undefined;
  note: string | undefined;
}

function finiteInRange(value: unknown, min: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= min ? value : undefined;
}

function usableSpan(init: { start?: unknown; end?: unknown }): { start: number; end: number } | undefined {
  const { start, end } = init;
  if (
    typeof start !== "number" ||
    !Number.isFinite(start) ||
    typeof end !== "number" ||
    !Number.isFinite(end) ||
    start >= end
  ) {
    return undefined;
  }
  return { start, end };
}

/** The booking ledger. `hasResource` is asked to validate `resourceId` against the entry ledger. */
export class Bookings {
  private readonly byId = new Map<string, Booking>();
  private nextBookingId = 1;

  book(init: ResourceBookingInit, hasResource: (id: ResourceId) => boolean): string | undefined {
    if (!isPlainObject(init)) return undefined;
    const resourceId = init.resourceId;
    if (
      (typeof resourceId !== "number" && typeof resourceId !== "string") ||
      (typeof resourceId === "number" && !Number.isFinite(resourceId)) ||
      resourceId === "" ||
      !hasResource(resourceId)
    ) {
      return undefined;
    }
    const span = usableSpan(init);
    if (span === undefined) return undefined;
    const { start, end } = span;
    let bookingId: string;
    if (typeof init.id === "string" && init.id !== "") {
      if (this.byId.has(init.id)) return undefined;
      bookingId = init.id;
    } else {
      do bookingId = `booking-${this.nextBookingId++}`;
      while (this.byId.has(bookingId));
    }
    const units = finiteInRange(init.units, 0);
    this.byId.set(bookingId, {
      id: bookingId,
      resourceId,
      taskId: typeof init.taskId === "string" || typeof init.taskId === "number" ? init.taskId : null,
      start,
      end,
      state: STATES.includes(init.state as BookingState) ? (init.state as BookingState) : "tentative",
      units: units === undefined || units === 0 ? 1 : units,
      billable: typeof init.billable === "boolean" ? init.billable : undefined,
      note: typeof init.note === "string" ? init.note : undefined,
    });
    return bookingId;
  }

  setBookingState(id: string, state: BookingState): boolean {
    const booking = this.byId.get(id);
    if (booking === undefined || !STATES.includes(state) || booking.state === state) return false;
    booking.state = state;
    return true;
  }

  cancelBooking(id: string): boolean {
    return this.byId.delete(id);
  }

  /** Removes every booking of a removed resource; reports the removed ids. */
  removeByResource(resourceId: ResourceId): string[] {
    const ids: string[] = [];
    for (const [id, booking] of this.byId) {
      if (booking.resourceId === resourceId) {
        this.byId.delete(id);
        ids.push(id);
      }
    }
    return ids;
  }

  bookingsWhere(filter: BookingFilter | undefined, billableOf: (resourceId: ResourceId) => boolean): ResourceBooking[] {
    const out: ResourceBooking[] = [];
    const f: BookingFilter | undefined = isPlainObject(filter) ? filter : undefined;
    for (const booking of this.byId.values()) {
      if (f?.resourceId !== undefined && booking.resourceId !== f.resourceId) continue;
      if (f?.taskId !== undefined && booking.taskId !== f.taskId) continue;
      if (f?.state !== undefined && booking.state !== f.state) continue;
      out.push(this.toPublic(booking, billableOf));
    }
    return out;
  }

  private toPublic(booking: Booking, billableOf: (resourceId: ResourceId) => boolean): ResourceBooking {
    const billable = booking.billable ?? billableOf(booking.resourceId);
    return {
      id: booking.id,
      resourceId: booking.resourceId,
      taskId: booking.taskId,
      start: booking.start,
      end: booking.end,
      state: booking.state,
      units: booking.units,
      billable,
      ...(booking.note !== undefined ? { note: booking.note } : {}),
    };
  }
}
