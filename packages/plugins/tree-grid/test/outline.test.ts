/**
 * The outline helpers behind `view/rowIndent` / `view/rowOutdent` / `view/rowInsert` /
 * `view/expandToLevel`, plus the collapsed-branch descendant count. Pure logic: no core, no DOM.
 */
import { describe, expect, it } from "vitest";
import {
  countDescendants,
  indentTarget,
  insertSlot,
  lastRootTaskId,
  noRefInsertDates,
  outdentTarget,
  planExpandToLevel,
} from "../src/internal/outline";
import { fakeData, task } from "./_data";

/** One day in milliseconds — the insert fallback duration with no usable time axis. */
const MS_DAY = 86_400_000;

describe("outline helpers", () => {
  const view = fakeData([
    task("a", null),
    task("a1", "a"),
    task("a2", "a"),
    task("b", null),
  ]).query();

  it("indents onto the previous sibling only", () => {
    expect(indentTarget(view, "a2")).toBe("a1");
    expect(indentTarget(view, "a1")).toBeUndefined(); // first sibling
    expect(indentTarget(view, "a")).toBeUndefined(); // first root
    expect(indentTarget(view, "b")).toBe("a");
    expect(indentTarget(view, "missing")).toBeUndefined();
  });

  it("outdents onto the grandparent, roots staying put", () => {
    expect(outdentTarget(view, "a1")).toEqual({ parentId: null });
    expect(outdentTarget(view, "a")).toBeUndefined();
    expect(outdentTarget(view, "missing")).toBeUndefined();
  });

  it("computes insert slots above / below / as child", () => {
    expect(insertSlot(view, "a1", "above")).toEqual({ parentId: "a", index: 0 });
    expect(insertSlot(view, "a1", "below")).toEqual({ parentId: "a", index: 1 });
    expect(insertSlot(view, "b", "child")).toEqual({ parentId: "b", index: undefined });
    expect(insertSlot(view, undefined, "below")).toEqual({ parentId: null, index: undefined });
    expect(insertSlot(view, "missing", "below")).toBeUndefined();
  });

  it("plans expand-to-level over branch nodes only", () => {
    const plan = planExpandToLevel(view, 0);
    expect(plan).toEqual([{ id: "a", expanded: false }]);
    expect(planExpandToLevel(view, 1)).toEqual([{ id: "a", expanded: true }]);
  });

  it("counts descendants transitively", () => {
    const deep = fakeData([task("r", null), task("c", "r"), task("g", "c")]).query();
    expect(countDescendants(deep, "r")).toBe(2);
    expect(countDescendants(deep, "c")).toBe(1);
    expect(countDescendants(view, "b")).toBe(0);
  });

  it("finds the current last root task, or none in an empty store", () => {
    expect(lastRootTaskId(view)).toBe("b");
    expect(lastRootTaskId(fakeData([]).query())).toBeUndefined();
  });
});

describe("noRefInsertDates", () => {
  it("dates like a `below` insert on the last root task when one exists", () => {
    const cellAt = (t: number): { start: number; end: number } => ({
      start: t,
      end: t + 7 * MS_DAY,
    });
    expect(noRefInsertDates(100, 999_999, cellAt, undefined)).toEqual({
      start: 100,
      end: 100 + 7 * MS_DAY,
    });
  });

  it("falls back to a one-day span with a last root task but no usable axis", () => {
    expect(noRefInsertDates(100, 999_999, () => undefined, undefined)).toEqual({
      start: 100,
      end: 100 + MS_DAY,
    });
  });

  it("fills the grid cell containing `now` for an empty store", () => {
    const cellAt = (t: number): { start: number; end: number } => ({ start: t - 10, end: t + 20 });
    expect(noRefInsertDates(undefined, 500, cellAt, undefined)).toEqual({ start: 490, end: 520 });
  });

  it("falls back to the UTC day floor of `now` plus one day for an empty store with no axis", () => {
    const now = 3 * MS_DAY + 12_345;
    expect(noRefInsertDates(undefined, now, () => undefined, undefined)).toEqual({
      start: 3 * MS_DAY,
      end: 4 * MS_DAY,
    });
  });

  it("clamps `now` to a host-configured future axis origin, so the task lands in the origin's cell", () => {
    const originAt = 10 * MS_DAY;
    const cellAt = (t: number): { start: number; end: number } => ({ start: t, end: t + MS_DAY });
    // `now` (one day) is far earlier than the origin (ten days): without the clamp this would
    // fill the cell at `now`, dating the task before the origin.
    expect(noRefInsertDates(undefined, MS_DAY, cellAt, () => originAt)).toEqual({
      start: originAt,
      end: originAt + MS_DAY,
    });
  });

  it("floors the clamped instant, not `now`, when the axis answers no cell", () => {
    const originAt = 10 * MS_DAY + 12_345;
    // Future origin plus `gridCellAt` answering undefined: the day-floor fallback must hold the
    // clamp too, or the task would be dated before the origin again.
    expect(
      noRefInsertDates(
        undefined,
        MS_DAY,
        () => undefined,
        () => originAt,
      ),
    ).toEqual({ start: 10 * MS_DAY, end: 11 * MS_DAY });
  });

  it("treats a last root task with a non-finite start as absent (empty-store rule)", () => {
    const cellAt = (t: number): { start: number; end: number } => ({ start: t - 5, end: t + 25 });
    expect(noRefInsertDates(Number.NaN, 500, cellAt, undefined)).toEqual({
      start: 495,
      end: 525,
    });
  });
});
