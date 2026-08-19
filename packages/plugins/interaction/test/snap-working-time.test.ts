/**
 * Working-time avoidance (docs/specs/plugins/interaction.md §6.3 `workingDays`).
 *
 * `adjustToWorkingBoundary` is the boundary arithmetic ("adjustToWorkingBoundary — day-granular
 * calendar" and "— intra-day windows"), unchanged: only its source of intervals moved (see
 * snap-service.test.ts).
 *
 * `isUsableWorkingTimeProvider` replaces the earlier structural `stargantt.calendars`
 * service edge with the interaction-owned `snap/workingTime` extension point (see
 * `../src/internal/snap/working-time.ts` and `../src/types.ts`).
 */
import { describe, expect, it } from "vitest";
import { adjustToWorkingBoundary, isUsableWorkingTimeProvider } from "../src/internal/snap/working-time";
import { DAY_GRANULAR, NINE_TO_FIVE, boundsOf } from "./_snap-fakes";

/** Epoch ms of a UTC wall-clock time. */
function utc(y: number, m: number, d: number, h = 0, min = 0, s = 0, ms = 0): number {
  return Date.UTC(y, m - 1, d, h, min, s, ms);
}

// docs/specs/plugins/interaction.md §6.3 — for a calendar without intra-day windows the working
// intervals are whole days, so every expectation in this block is day-boundary avoidance.
describe("adjustToWorkingBoundary — day-granular calendar", () => {
  it("passes an instant inside a working day through unchanged", () => {
    const t = utc(2024, 3, 15, 10);
    expect(adjustToWorkingBoundary(t, boundsOf(DAY_GRANULAR))).toBe(t);
  });

  it("keeps the midnight that closes a working day, so an exclusive end may rest on it", () => {
    const t = utc(2024, 3, 16); // Saturday 00:00 — the day ending here (Friday) works.
    expect(adjustToWorkingBoundary(t, boundsOf(DAY_GRANULAR))).toBe(t);
  });

  it("moves an instant inside a non-working day to the nearest acceptable boundary", () => {
    // Saturday noon: Saturday 00:00 (closes working Friday) is 12h back, Monday 00:00 is 36h on.
    expect(adjustToWorkingBoundary(utc(2024, 3, 16, 12), boundsOf(DAY_GRANULAR))).toBe(
      utc(2024, 3, 16),
    );
  });

  it("resolves a distance tie forward", () => {
    // Sunday 00:00: Saturday 00:00 is one day back, Monday 00:00 one day forward.
    expect(adjustToWorkingBoundary(utc(2024, 3, 17), boundsOf(DAY_GRANULAR))).toBe(
      utc(2024, 3, 18),
    );
  });

  it("returns the instant unchanged for an all-non-working calendar", () => {
    const t = utc(2024, 3, 16, 12);
    expect(adjustToWorkingBoundary(t, boundsOf({ workingDays: [] }))).toBe(t);
  });

  // The unchanged answer is scoped to a calendar with no working time at all — not to one
  // direction having nothing to reach. A calendar whose only working day lies on one side of `t`
  // is the case that separates the two: one walk finds a real boundary while the other exhausts
  // its bound and answers `t`, which the all-non-working calendar above cannot distinguish because
  // it fails both directions at once.
  const oneWorkingDay = (date: string): typeof DAY_GRANULAR => ({
    workingDays: [],
    exceptions: [{ date, working: true }],
  });

  it("moves to the backward boundary when the forward walk has nothing to reach", () => {
    // Only Friday 2024-03-15 works, so from Saturday noon nothing lies ahead; the Saturday
    // midnight closing that Friday is a real boundary 12h back.
    expect(
      adjustToWorkingBoundary(utc(2024, 3, 16, 12), boundsOf(oneWorkingDay("2024-03-15"))),
    ).toBe(utc(2024, 3, 16));
  });

  it("moves to the forward boundary when the backward walk has nothing to reach", () => {
    // Only Monday 2024-03-18 works: nothing behind Saturday noon, Monday 00:00 is 36h ahead.
    expect(
      adjustToWorkingBoundary(utc(2024, 3, 16, 12), boundsOf(oneWorkingDay("2024-03-18"))),
    ).toBe(utc(2024, 3, 18));
  });

  it("still passes an instant inside that single working day through unchanged", () => {
    const t = utc(2024, 3, 18, 10);
    expect(adjustToWorkingBoundary(t, boundsOf(oneWorkingDay("2024-03-18")))).toBe(t);
  });

  it("returns a non-finite instant unchanged", () => {
    expect(adjustToWorkingBoundary(Number.NaN, boundsOf(DAY_GRANULAR))).toBeNaN();
  });
});

// docs/specs/plugins/interaction.md §6.3 — the same procedure over intra-day working windows:
// acceptance inside an interval or on either of its boundaries, otherwise the nearest boundary,
// ties forward.
describe("adjustToWorkingBoundary — intra-day windows", () => {
  it("passes an instant inside a working window through unchanged", () => {
    const t = utc(2024, 3, 15, 12); // Friday noon, inside 09:00-17:00.
    expect(adjustToWorkingBoundary(t, boundsOf(NINE_TO_FIVE))).toBe(t);
  });

  it("accepts the instant a window opens on", () => {
    const t = utc(2024, 3, 15, 9);
    expect(adjustToWorkingBoundary(t, boundsOf(NINE_TO_FIVE))).toBe(t);
  });

  it("accepts the instant a window closes on, so an exclusive end may rest there", () => {
    const t = utc(2024, 3, 15) + 61_200_000;
    expect(t).toBe(utc(2024, 3, 15, 17));
    expect(adjustToWorkingBoundary(t, boundsOf(NINE_TO_FIVE))).toBe(t);
  });

  it("pulls an evening instant back to the window's closing boundary", () => {
    // Friday 18:00: back to Friday 17:00 is 1h; forward to Monday 09:00 is 63h.
    expect(adjustToWorkingBoundary(utc(2024, 3, 15, 18), boundsOf(NINE_TO_FIVE))).toBe(
      utc(2024, 3, 15, 17),
    );
  });

  it("pushes a pre-dawn instant forward to the window's opening boundary", () => {
    // Friday 08:00: forward to Friday 09:00 is 1h; back to Thursday 17:00 is 15h.
    expect(adjustToWorkingBoundary(utc(2024, 3, 15, 8), boundsOf(NINE_TO_FIVE))).toBe(
      utc(2024, 3, 15, 9),
    );
  });

  it("resolves an intra-day tie forward", () => {
    // The Monday-17:00 -> Tuesday-09:00 gap is 16h wide, so Tuesday 01:00 is its exact midpoint:
    // 8h back to Monday 17:00, 8h forward to Tuesday 09:00. The forward candidate wins.
    expect(adjustToWorkingBoundary(utc(2024, 3, 19, 1), boundsOf(NINE_TO_FIVE))).toBe(
      utc(2024, 3, 19, 9),
    );
  });

  it("crosses a weekend to the nearer working boundary", () => {
    // Sunday 20:00: back to Friday 17:00 is 51h; forward to Monday 09:00 is 13h.
    expect(adjustToWorkingBoundary(utc(2024, 3, 17, 20), boundsOf(NINE_TO_FIVE))).toBe(
      utc(2024, 3, 18, 9),
    );
  });

  it("never moves a whole-day-working instant that an intra-day calendar leaves working", () => {
    const t = utc(2024, 3, 15, 3);
    expect(adjustToWorkingBoundary(t, boundsOf(DAY_GRANULAR))).toBe(t);
    expect(adjustToWorkingBoundary(t, boundsOf(NINE_TO_FIVE))).toBe(utc(2024, 3, 15, 9));
  });
});

// New in v2: `isUsableWorkingTimeProvider` is the structural guard `snap/workingTime` (first)
// applies to each contribution — a contribution without a `boundaries` member is treated as
// absent (../src/types.ts).
describe("isUsableWorkingTimeProvider", () => {
  it("accepts an object exposing a boundaries function", () => {
    expect(isUsableWorkingTimeProvider({ boundaries: () => undefined })).toBe(true);
    expect(isUsableWorkingTimeProvider({ boundaries: () => boundsOf(DAY_GRANULAR) })).toBe(true);
  });

  it("rejects an object missing boundaries, or carrying it as a non-function", () => {
    expect(isUsableWorkingTimeProvider({})).toBe(false);
    expect(isUsableWorkingTimeProvider({ boundaries: "nope" })).toBe(false);
    expect(isUsableWorkingTimeProvider({ boundaries: undefined })).toBe(false);
  });

  it("rejects non-object candidates", () => {
    for (const bad of [undefined, null, 0, "boundaries", true, () => undefined]) {
      expect(isUsableWorkingTimeProvider(bad)).toBe(false);
    }
  });
});
