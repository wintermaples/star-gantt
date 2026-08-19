// docs/specs/plugins/scheduling.md §2.4 — manual/auto mixed scheduling.
import { describe, expect, it } from "vitest";
import { schedule } from "../src/engine/engine";
import { isManualTask, scheduleModeOf } from "../src/engine/modes";
import { DAY, link, moves, task, view } from "./_helpers";

const manual = { meta: { scheduleMode: "manual" } };

describe("manual scheduling mode", () => {
  it("reads the mode from meta.scheduleMode, defaulting to auto", () => {
    expect(scheduleModeOf(task("a", 0, DAY))).toBe("auto");
    expect(scheduleModeOf(task("a", 0, DAY, manual))).toBe("manual");
    expect(scheduleModeOf(task("a", 0, DAY, { meta: { scheduleMode: "weird" } }))).toBe("auto");
    expect(scheduleModeOf(undefined)).toBe("auto");
    expect(isManualTask(task("a", 0, DAY, manual))).toBe(true);
  });

  it("never moves a manual task during forward propagation", () => {
    const v = view(
      [task("a", 0, 2 * DAY), task("b", 5 * DAY, 6 * DAY, manual), task("c", 0, DAY)],
      [link("l1", "a", "b"), link("l2", "b", "c")],
    );
    // a's edit would push b to day 2; b is pinned, but its fixed dates still drive c.
    expect(moves(schedule(v, new Set(["a"])))).toEqual({ c: [6 * DAY, 7 * DAY] });
  });

  it("never pulls a manual task in the back-clamp pass", () => {
    const v = view(
      [
        task("a", 0, 2 * DAY),
        task("b", 2 * DAY, 3 * DAY, {
          ...manual,
          constraint: { type: "FNLT", date: 10 * DAY },
        }),
      ],
      [link("l1", "a", "b")],
    );
    expect(moves(schedule(v, new Set(["a"])))).toEqual({});
  });

  it("a manual summary keeps its own dates instead of rolling up", () => {
    const v = view([
      task("s", 0, 10 * DAY, { ...manual, type: "summary" }),
      task("a", 0, 2 * DAY, { parentId: "s" }),
    ]);
    expect(moves(schedule(v, new Set(["a"])))).toEqual({});
  });
});
