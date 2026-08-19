/**
 * docs/specs/plugins/scheduling.md §2.3 — constraint semantics.
 *
 * Of the four original built-in types only `SNET` bounds an *earliest* start, so only `SNET` acts in
 * the forward pass. `ASAP` is an intentional no-op. The late-side types are covered by
 * `engine-back-clamp.test.ts`; what is asserted here is that neither of them disturbs the forward
 * pass when nothing pulls the task late-ward.
 */
import { describe, expect, it } from "vitest";
import { schedule } from "../src/engine/engine";
import { link, moves, task, view } from "./_helpers";

describe("schedule — constraints", () => {
  it("SNET holds the successor back to its constraint date", () => {
    const v = view(
      [task("a", 0, 10), task("b", 0, 5, { constraint: { type: "SNET", date: 50 } })],
      [link("l1", "a", "b", "FS")],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [50, 55] });
  });

  it("SNET earlier than the link-derived start has no effect", () => {
    const v = view(
      [task("a", 0, 10), task("b", 0, 5, { constraint: { type: "SNET", date: 3 } })],
      [link("l1", "a", "b", "FS")],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [10, 15] });
  });

  it("SNET without a date is ignored", () => {
    const v = view(
      [task("a", 0, 10), task("b", 0, 5, { constraint: { type: "SNET" } })],
      [link("l1", "a", "b", "FS")],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [10, 15] });
  });

  it("ASAP schedules at the earliest start", () => {
    const v = view(
      [task("a", 0, 10), task("b", 90, 95, { constraint: { type: "ASAP" } })],
      [link("l1", "a", "b", "FS")],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [10, 15] });
  });

  it("ALAP without a successor keeps the forward-pass placement", () => {
    const v = view(
      [task("a", 0, 10), task("b", 90, 95, { constraint: { type: "ALAP" } })],
      [link("l1", "a", "b", "FS")],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [10, 15] });
  });

  it("FNLT earlier than the forward-pass finish loses to the early side", () => {
    const v = view(
      [task("a", 0, 10), task("b", 0, 5, { constraint: { type: "FNLT", date: 12 } })],
      [link("l1", "a", "b", "FS")],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ b: [10, 15] });
  });

  it("does not apply SNET to a seed", () => {
    const v = view([task("a", 0, 10, { constraint: { type: "SNET", date: 999 } })]);
    expect(schedule(v, new Set(["a"]))).toEqual([]);
  });
});
