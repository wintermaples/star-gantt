// Covers the "stored values" and "bulkEditPiece no-op guard" behaviors, plus remaining-work /
// remaining-duration / batch-merge unit coverage, against this area's own pure `values.ts`
// functions (no host, no DOM).
import { describe, expect, it } from "vitest";
import type { Task } from "@stargantt/plugin-data-store";
import {
  bulkEditPiece,
  isPieceNoop,
  isRag,
  mergeBatchEntries,
  mergeProgressValues,
  progressFieldsPiece,
  progressValuesOf,
  remainingDurationPiece,
} from "../src/internal/progress/values";

const MS_DAY = 86_400_000;
const MS_HOUR = 3_600_000;

function withMeta(meta: unknown): Task {
  return { id: "t", parentId: null, name: "t", start: 0, end: MS_DAY, meta } as unknown as Task;
}

describe("progressValuesOf (defensive read)", () => {
  it("reads only well-shaped members and clamps physicalPercent", () => {
    expect(progressValuesOf(undefined)).toEqual({});
    expect(progressValuesOf(withMeta("junk"))).toEqual({});
    expect(
      progressValuesOf(
        withMeta({
          progressTracking: { rag: "purple", remainingWork: -2, totalWork: 0, physicalPercent: 250 },
        }),
      ),
    ).toEqual({ physicalPercent: 100 });
    expect(
      progressValuesOf(withMeta({ progressTracking: { rag: "amber", remainingWork: 8, totalWork: 40 } })),
    ).toEqual({ rag: "amber", remainingWork: 8, totalWork: 40 });
  });

  it("isRag accepts only the three literals", () => {
    expect(isRag("red")).toBe(true);
    expect(isRag("amber")).toBe(true);
    expect(isRag("green")).toBe(true);
    expect(isRag("purple")).toBe(false);
    expect(isRag(undefined)).toBe(false);
  });
});

describe("mergeProgressValues", () => {
  it("removes on explicit undefined and drops unusable patched values", () => {
    const merged = mergeProgressValues(
      { rag: "red", remainingWork: 5 },
      { rag: undefined, physicalPercent: Number.NaN, totalWork: 10 },
    );
    expect(merged).toEqual({ remainingWork: 5, totalWork: 10 });
  });

  it("an absent key is untouched", () => {
    expect(mergeProgressValues({ rag: "green", remainingWork: 5 }, {})).toEqual({
      rag: "green",
      remainingWork: 5,
    });
  });
});

describe("progressFieldsPiece", () => {
  it("returns undefined for an unknown task or a non-object patch", () => {
    expect(progressFieldsPiece(() => undefined, "x", { rag: "red" })).toBeUndefined();
    const task = withMeta(undefined);
    expect(progressFieldsPiece(() => task, "t", null as never)).toBeUndefined();
  });

  it("recomputes task.progress when a patch states remainingWork over a positive totalWork", () => {
    const task = { id: "a", parentId: null, name: "a", start: 0, end: MS_DAY } as unknown as Task;
    const piece = progressFieldsPiece(() => task, "a", { totalWork: 40 * MS_HOUR, remainingWork: 10 * MS_HOUR });
    expect(piece).toBeDefined();
    expect(piece?.after.progress).toBeCloseTo(0.75, 5);
    expect((piece?.after.meta as { progressTracking: unknown })?.progressTracking).toEqual({
      totalWork: 40 * MS_HOUR,
      remainingWork: 10 * MS_HOUR,
    });
  });

  it("a patch without remainingWork never touches progress", () => {
    const task = { id: "a", parentId: null, name: "a", start: 0, end: MS_DAY } as unknown as Task;
    const piece = progressFieldsPiece(() => task, "a", { totalWork: 80 * MS_HOUR });
    expect(piece?.after.progress).toBeUndefined();
  });

  it("is a no-op (undefined) when the merged result is byte-identical to the stored state", () => {
    const task = withMeta({ progressTracking: { rag: "amber", physicalPercent: 40 } });
    expect(progressFieldsPiece(() => task, "t", { rag: "amber", physicalPercent: 40 })).toBeUndefined();
    expect(progressFieldsPiece(() => task, "t", {})).toBeUndefined();
  });

  it("clearing a field that is not stored is a no-op (no clears: ['meta'])", () => {
    const task = { id: "t", parentId: null, name: "t", start: 0, end: MS_DAY } as unknown as Task;
    expect(progressFieldsPiece(() => task, "t", { rag: undefined })).toBeUndefined();
  });

  it("an emptied bag clears meta and the piece carries clears: ['meta']", () => {
    const task = withMeta({ progressTracking: { rag: "red" } });
    const piece = progressFieldsPiece(() => task, "t", { rag: undefined });
    expect(piece?.clears).toEqual(["meta"]);
    expect(piece?.before.meta).toEqual({ progressTracking: { rag: "red" } });
  });
});

describe("remainingDurationPiece", () => {
  it("moves end past the status date and sets the elapsed fraction", () => {
    const task = { id: "a", parentId: null, name: "a", start: 0, end: 10 * MS_DAY } as unknown as Task;
    const piece = remainingDurationPiece(task, 5 * MS_DAY, 5 * MS_DAY);
    expect(piece.after.end).toBe(10 * MS_DAY);
    expect(piece.after.progress).toBeCloseTo(0.5, 5);
  });

  it("anchors at the task start when the task begins after the status date", () => {
    const task = { id: "a", parentId: null, name: "a", start: 8 * MS_DAY, end: 9 * MS_DAY } as unknown as Task;
    const piece = remainingDurationPiece(task, 2 * MS_DAY, 5 * MS_DAY);
    expect(piece.after.end).toBe(10 * MS_DAY);
    expect(piece.after.progress).toBe(0);
  });

  it("recomputes a stored remainingWork from totalWork alongside end and progress", () => {
    const task = withMeta({ progressTracking: { totalWork: 40 * MS_HOUR, remainingWork: 30 * MS_HOUR } });
    (task as unknown as { start: number; end: number }).start = 0;
    (task as unknown as { start: number; end: number }).end = 10 * MS_DAY;
    const piece = remainingDurationPiece(task, 5 * MS_DAY, 5 * MS_DAY); // end 10d, progress 0.5
    expect(piece.after.progress).toBeCloseTo(0.5, 5);
    const bag = (piece.after.meta as { progressTracking: { remainingWork: number } }).progressTracking;
    // (1 − 0.5) × 40h — the exact inverse of the remaining-work recompute.
    expect(bag.remainingWork).toBeCloseTo(20 * MS_HOUR, 5);
  });

  it("scales a stored remainingWork proportionally when no totalWork is known", () => {
    const task = withMeta({ progressTracking: { remainingWork: 30 * MS_HOUR } });
    (task as unknown as { start: number; end: number; progress?: number }).start = 0;
    (task as unknown as { start: number; end: number }).end = 10 * MS_DAY;
    const piece = remainingDurationPiece(task, 5 * MS_DAY, 5 * MS_DAY); // progress 0 → 0.5
    const bag = (piece.after.meta as { progressTracking: { remainingWork: number } }).progressTracking;
    // 30h × (1 − 0.5) / (1 − 0) = 15h.
    expect(bag.remainingWork).toBeCloseTo(15 * MS_HOUR, 5);
  });

  it("leaves the stored remainingWork untouched when old progress was already 1", () => {
    const task = withMeta({ progressTracking: { remainingWork: 30 * MS_HOUR } });
    (task as unknown as { start: number; end: number; progress?: number }).start = 0;
    (task as unknown as { start: number; end: number; progress?: number }).end = 10 * MS_DAY;
    (task as unknown as { progress?: number }).progress = 1;
    const piece = remainingDurationPiece(task, 5 * MS_DAY, 5 * MS_DAY);
    expect(piece.after.meta).toBeUndefined();
  });
});

describe("isPieceNoop", () => {
  it("true when after/clears change nothing on the task", () => {
    const task = { id: "t", parentId: null, name: "t", start: 0, end: MS_DAY, progress: 0.5 } as unknown as Task;
    expect(isPieceNoop(task, { progress: 0.5 })).toBe(true);
    expect(isPieceNoop(task, { progress: 0.6 })).toBe(false);
    expect(isPieceNoop(task, {}, ["meta"])).toBe(true);
  });
});

describe("bulkEditPiece (§2.5 bulk-panel Apply)", () => {
  const stored: Task = { id: "t", parentId: null, name: "t", start: 0, end: MS_DAY, progress: 0.5 } as unknown as Task;
  const getTask = (id: unknown): Task | undefined => (id === "t" ? stored : undefined);

  it("returns undefined for an edit identical to the stored state", () => {
    expect(bulkEditPiece(getTask, { id: "t", progressPct: 50 })).toBeUndefined();
  });

  it("still builds a piece for an edit that changes the task", () => {
    const piece = bulkEditPiece(getTask, { id: "t", progressPct: 75 });
    expect(piece).toMatchObject({ id: "t", before: { progress: 0.5 }, after: { progress: 0.75 } });
  });

  it("recomputes progress from remainingWork/totalWork unless progressPct was also edited", () => {
    const withTotal: Task = { id: "u", parentId: null, name: "u", start: 0, end: MS_DAY, meta: { progressTracking: { totalWork: 40 * MS_HOUR } } } as unknown as Task;
    const get2 = (id: unknown): Task | undefined => (id === "u" ? withTotal : undefined);
    const piece = bulkEditPiece(get2, { id: "u", remainingWork: 10 * MS_HOUR });
    expect(piece?.after.progress).toBeCloseTo(0.75, 5);

    const withBoth = bulkEditPiece(get2, { id: "u", progressPct: 10, remainingWork: 10 * MS_HOUR });
    // The explicit progressPct wins; the remaining-work recompute does not overwrite it.
    expect(withBoth?.after.progress).toBeCloseTo(0.1, 5);
  });

  it("returns undefined for an unknown task", () => {
    expect(bulkEditPiece(getTask, { id: "nope", progressPct: 10 })).toBeUndefined();
  });
});

describe("mergeBatchEntries", () => {
  it("merges same-task entries, later field wins, explicit undefined included", () => {
    const merged = mergeBatchEntries([
      { id: "a", patch: { rag: "red", totalWork: 40 } },
      { id: "a", patch: { rag: "green" } },
    ]);
    expect(merged.get("a")).toEqual({ rag: "green", totalWork: 40 });
  });

  it("a later explicit undefined still wins", () => {
    const merged = mergeBatchEntries([
      { id: "a", patch: { rag: "red" } },
      { id: "a", patch: { rag: undefined } },
    ]);
    expect(merged.get("a")).toEqual({ rag: undefined });
  });

  it("skips a non-object patch and a non-object entry", () => {
    const merged = mergeBatchEntries([
      { id: "a", patch: "junk" as never },
      { id: "b", patch: { rag: "amber" } },
    ]);
    expect(merged.has("a")).toBe(false);
    expect(merged.get("b")).toEqual({ rag: "amber" });
  });
});
