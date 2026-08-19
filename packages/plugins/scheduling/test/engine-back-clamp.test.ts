/**
 * docs/specs/plugins/scheduling.md §2.3 — `ALAP` / `FNLT` as a back-clamp second step.
 *
 * After the forward pass, a second step pulls each late-constrained task late-ward to its upper
 * bound — `FNLT` to its constraint date, `ALAP` to the latest its successors permit — and the pull
 * then carries through those successors. Where an early-side bound conflicts with the late-side
 * one, the early side wins. `latestTimes()` is untouched by any of it.
 */
import { describe, expect, it } from "vitest";
import { latestTimes, schedule } from "../src/engine/engine";
import { DAY, link, moves, task, view } from "./_helpers";

const H = 3_600_000;
const MON = Date.UTC(2024, 0, 1);
const TUE = Date.UTC(2024, 0, 2);

const office = {
  id: "o",
  workingDays: [1, 2, 3, 4, 5],
  workingHours: [[9 * H, 17 * H]] as [number, number][],
};

describe("schedule — FNLT back-clamp", () => {
  it("pulls the task late-ward so it ends on its constraint date", () => {
    const v = view(
      [task("a", 0, 10), task("b", 0, 5, { constraint: { type: "FNLT", date: 40 } })],
      [link("l1", "a", "b", "FS")],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [35, 40] });
  });

  it("keeps the forward placement when the constraint date is already behind it", () => {
    const v = view(
      [task("a", 0, 10), task("b", 0, 5, { constraint: { type: "FNLT", date: 12 } })],
      [link("l1", "a", "b", "FS")],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [10, 15] });
  });

  it("ignores an FNLT without a date", () => {
    const v = view(
      [task("a", 0, 10), task("b", 0, 5, { constraint: { type: "FNLT" } })],
      [link("l1", "a", "b", "FS")],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [10, 15] });
  });

  it("carries the pull through to the successors", () => {
    const v = view(
      [
        task("a", 0, 10),
        task("b", 0, 5, { constraint: { type: "FNLT", date: 40 } }),
        task("c", 0, 3),
      ],
      [link("l1", "a", "b", "FS"), link("l2", "b", "c", "FS")],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [35, 40], c: [40, 43] });
  });

  it("lets a successor's own SNET keep winning after the pull", () => {
    const v = view(
      [
        task("a", 0, 10),
        task("b", 0, 5, { constraint: { type: "FNLT", date: 40 } }),
        task("c", 0, 3, { constraint: { type: "SNET", date: 100 } }),
      ],
      [link("l1", "a", "b", "FS"), link("l2", "b", "c", "FS")],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [35, 40], c: [100, 103] });
  });

  it("never pulls a seed, which carries the user's own edit", () => {
    const v = view([task("a", 0, 10, { constraint: { type: "FNLT", date: 900 } })]);
    expect(schedule(v, new Set(["a"]))).toEqual([]);
  });

  it("never pulls a summary, whose times come from its children", () => {
    const v = view([
      task("p", 0, 0, { constraint: { type: "FNLT", date: 900 } }),
      task("a", 10, 20, { parentId: "p" }),
    ]);
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ p: [10, 20] });
  });

  it("clamps onto working time against a working-hours calendar", () => {
    const v = view(
      [
        task("a", MON + 9 * H, MON + 10 * H),
        task("b", MON + 9 * H, MON + 11 * H, {
          calendarId: "o",
          // 22:00 is outside the working day, so the pull lands on the previous close of business.
          constraint: { type: "FNLT", date: TUE + 22 * H },
        }),
      ],
      [link("l1", "a", "b", "FS")],
      [office],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({
      b: [TUE + 15 * H, TUE + 17 * H],
    });
  });

  it("walks backward to a working day rather than past the constraint date", () => {
    const weekdays = { id: "w", workingDays: [1, 2, 3, 4, 5] };
    const FRI = Date.UTC(2024, 0, 5);
    const SAT = Date.UTC(2024, 0, 6);
    const v = view(
      [
        task("a", MON, MON + DAY),
        task("b", MON, MON + DAY, {
          calendarId: "w",
          constraint: { type: "FNLT", date: SAT + DAY },
        }),
      ],
      [link("l1", "a", "b", "FS")],
      [weekdays],
    );
    // The clamped start (Saturday) is non-working; walking forward would end on Tuesday, past the
    // constraint date, so the walk goes backward and the task ends on Saturday instead.
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [FRI, FRI + DAY] });
  });

  it("leaves the task alone when the backward landing is its forward placement", () => {
    const weekdays = { id: "w", workingDays: [1, 2, 3, 4, 5] };
    const THU = Date.UTC(2024, 0, 4);
    const FRI = Date.UTC(2024, 0, 5);
    const SUN = Date.UTC(2024, 0, 7);
    const v = view(
      [
        task("a", THU, FRI),
        task("b", FRI, FRI + DAY, {
          calendarId: "w",
          constraint: { type: "FNLT", date: SUN },
        }),
      ],
      [link("l1", "a", "b", "FS")],
      [weekdays],
    );
    // Sunday's landing walks back to Friday, exactly where the forward pass put the task, so the
    // pull changes nothing and no patch is emitted.
    expect(moves(schedule(v, new Set(["a"])))).toEqual({});
  });
});

describe("schedule — ALAP back-clamp", () => {
  it("pulls the task as late as its successor permits", () => {
    const v = view(
      [
        task("a", 0, 10),
        task("b", 0, 5, { constraint: { type: "ALAP" } }),
        task("c", 0, 10, { constraint: { type: "SNET", date: 60 } }),
      ],
      [link("l1", "a", "b", "FS"), link("l2", "b", "c", "FS")],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [55, 60], c: [60, 70] });
  });

  it("takes the tightest of several successors", () => {
    const v = view(
      [
        task("a", 0, 10),
        task("b", 0, 5, { constraint: { type: "ALAP" } }),
        task("c", 0, 10, { constraint: { type: "SNET", date: 60 } }),
        task("d", 0, 10, { constraint: { type: "SNET", date: 40 } }),
      ],
      [link("l1", "a", "b", "FS"), link("l2", "b", "c", "FS"), link("l3", "b", "d", "FS")],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({
      b: [35, 40],
      c: [60, 70],
      d: [40, 50],
    });
  });

  it("honours the lag of the link it is bounded by", () => {
    const v = view(
      [
        task("a", 0, 10),
        task("b", 0, 5, { constraint: { type: "ALAP" } }),
        task("c", 0, 10, { constraint: { type: "SNET", date: 60 } }),
      ],
      [link("l1", "a", "b", "FS"), link("l2", "b", "c", "FS", 7)],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [48, 53], c: [60, 70] });
  });

  it("stays put when the successor leaves it no slack (the early side wins)", () => {
    const v = view(
      [task("a", 0, 10), task("b", 0, 5, { constraint: { type: "ALAP" } }), task("c", 0, 10)],
      [link("l1", "a", "b", "FS"), link("l2", "b", "c", "FS")],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [10, 15], c: [15, 25] });
  });

  it("stays put with no successor at all to be bounded by", () => {
    const v = view(
      [task("a", 0, 10), task("b", 90, 95, { constraint: { type: "ALAP" } })],
      [link("l1", "a", "b", "FS")],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [10, 15] });
  });

  it("is bounded through an SS link by the successor's start", () => {
    const v = view(
      [
        task("a", 0, 10),
        task("b", 0, 5, { constraint: { type: "ALAP" } }),
        task("c", 0, 10, { constraint: { type: "SNET", date: 60 } }),
      ],
      [link("l1", "a", "b", "FS"), link("l2", "b", "c", "SS")],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [60, 65], c: [60, 70] });
  });

  it("keeps its working duration when pulled against a working-hours calendar", () => {
    const v = view(
      [
        task("a", MON + 9 * H, MON + 10 * H),
        task("b", MON + 9 * H, MON + 13 * H, {
          calendarId: "o",
          constraint: { type: "ALAP" },
        }),
        task("c", MON + 9 * H, MON + 10 * H, {
          calendarId: "o",
          constraint: { type: "SNET", date: TUE + 11 * H },
        }),
      ],
      [link("l1", "a", "b", "FS"), link("l2", "b", "c", "FS")],
      [office],
    );
    // Four working hours ending at Tuesday 11:00 start at Monday 15:00.
    expect(moves(schedule(v, new Set(["a"])))).toEqual({
      b: [MON + 15 * H, TUE + 11 * H],
      c: [TUE + 11 * H, TUE + 12 * H],
    });
  });
});

describe("latestTimes — untouched by the back-clamp", () => {
  it("ignores constraints entirely, as the critical-path consumer expects", () => {
    const v = view(
      [task("a", 0, 10), task("b", 10, 15, { constraint: { type: "FNLT", date: 40 } })],
      [link("l1", "a", "b", "FS")],
    );
    expect(latestTimes(v).get("b")).toEqual({ latestStart: 10, latestFinish: 15 });
    expect(latestTimes(v).get("a")).toEqual({ latestStart: 0, latestFinish: 10 });
  });
});
