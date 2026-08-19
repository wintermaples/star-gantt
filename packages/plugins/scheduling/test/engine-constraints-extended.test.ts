// docs/specs/plugins/scheduling.md §2.3 — the four MS-Project-style built-in constraint additions
// (SNLT / FNET / MSO / MFO).
import { describe, expect, it } from "vitest";
import { schedule } from "../src/engine/engine";
import { DAY, link, moves, task, view } from "./_helpers";

describe("extended built-in constraints", () => {
  it("SNLT pulls a task late-ward but never past 'start no later than' its date", () => {
    // b would land at day 2 unconstrained; SNLT day 6 allows a late-ward pull up to start=6.
    const v = view(
      [
        task("a", 0, 2 * DAY),
        task("b", 0, 3 * DAY, { constraint: { type: "SNLT", date: 6 * DAY } }),
      ],
      [link("l1", "a", "b")],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [6 * DAY, 9 * DAY] });
  });

  it("FNET holds a task's finish at or after its date (early-side bound)", () => {
    // Unconstrained b would start at day 2 and finish day 5; FNET day 8 pushes it out.
    const v = view(
      [
        task("a", 0, 2 * DAY),
        task("b", 0, 3 * DAY, { constraint: { type: "FNET", date: 8 * DAY } }),
      ],
      [link("l1", "a", "b")],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [5 * DAY, 8 * DAY] });
  });

  it("MSO pins the task to its date when dependencies permit", () => {
    const v = view(
      [
        task("a", 0, 2 * DAY),
        task("b", 0, 3 * DAY, { constraint: { type: "MSO", date: 5 * DAY } }),
      ],
      [link("l1", "a", "b")],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [5 * DAY, 8 * DAY] });
  });

  it("MSO degrades to its early side when a dependency forces a later start", () => {
    // a finishes at day 6, after MSO's day 5 — the early side wins.
    const v = view(
      [
        task("a", 0, 6 * DAY),
        task("b", 0, 3 * DAY, { constraint: { type: "MSO", date: 5 * DAY } }),
      ],
      [link("l1", "a", "b")],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [6 * DAY, 9 * DAY] });
  });

  it("MFO pins the task's finish to its date when dependencies permit", () => {
    const v = view(
      [
        task("a", 0, 2 * DAY),
        task("b", 0, 3 * DAY, { constraint: { type: "MFO", date: 9 * DAY } }),
      ],
      [link("l1", "a", "b")],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [6 * DAY, 9 * DAY] });
  });

  it("a dateless extended constraint bounds nothing", () => {
    const v = view(
      [task("a", 0, 2 * DAY), task("b", 0, 3 * DAY, { constraint: { type: "SNLT" } })],
      [link("l1", "a", "b")],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [2 * DAY, 5 * DAY] });
  });
});
