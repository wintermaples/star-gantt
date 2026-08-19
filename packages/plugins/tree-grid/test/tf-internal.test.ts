import { describe, expect, it } from "vitest";
import type { Task } from "@stargantt/plugin-data-store";
import {
  fieldsOfTask,
  isOverdueValues,
  mergeFieldValues,
  metaWith,
  normalizeTags,
} from "../src/internal/task-fields/fields";
import { formatDuration, parseDurationInput, resolveUnit } from "../src/internal/task-fields/duration";
import { formatSequenceId, resolveNumbering, sequenceCache } from "../src/internal/task-fields/sequence";
import { DEFAULT_COLUMNS, resolveColumns } from "../src/internal/task-fields/columns";
import { DEFAULT_MESSAGES, resolveMessages } from "../src/internal/messages";
import { resolveTemplates } from "../src/internal/task-fields/templates";
import { appendCompletionStamps } from "../src/internal/task-fields/auto-complete";

const MS_DAY = 86_400_000;

function asTask(meta: unknown): Task {
  return { id: "t", parentId: null, name: "t", start: 0, end: MS_DAY, meta } as Task;
}

describe("fields", () => {
  it("reads stored values and drops unusable members", () => {
    const fields = fieldsOfTask(
      asTask({
        taskFields: {
          status: "done",
          priority: "sideways", // not a priority
          tags: ["a", 1, " a ", "b"], // non-string dropped, duplicate collapsed
          deadline: Number.NaN, // non-finite dropped
          notes: "hello",
          customId: "",
        },
      }),
    );
    expect(fields).toEqual({ status: "done", tags: ["a", "b"], notes: "hello" });
  });

  it("returns {} for an absent or non-object bag and an unknown task", () => {
    expect(fieldsOfTask(undefined)).toEqual({});
    expect(fieldsOfTask(asTask(undefined))).toEqual({});
    expect(fieldsOfTask(asTask({ taskFields: 42 }))).toEqual({});
  });

  it("merges patches: undefined removes, absent keys untouched", () => {
    const merged = mergeFieldValues(
      { status: "done", notes: "x" },
      { notes: undefined, priority: "high" },
    );
    expect(merged).toEqual({ status: "done", priority: "high" });
  });

  it("metaWith preserves sibling meta keys and removes an empty bag entirely", () => {
    expect(metaWith({ color: "red" }, { status: "done" })).toEqual({
      color: "red",
      taskFields: { status: "done" },
    });
    expect(metaWith({ color: "red", taskFields: { status: "done" } }, {})).toEqual({
      color: "red",
    });
    expect(metaWith({ taskFields: { status: "done" } }, {})).toBeUndefined();
  });

  it("normalizeTags trims, drops empties/non-strings and collapses duplicates", () => {
    expect(normalizeTags([" a ", "", "b", "a", 3])).toEqual(["a", "b"]);
    expect(normalizeTags([])).toBeUndefined();
    expect(normalizeTags("a")).toBeUndefined();
  });

  it("isOverdueValues needs a past deadline and a non-done status", () => {
    expect(isOverdueValues({ deadline: 10 }, 20)).toBe(true);
    expect(isOverdueValues({ deadline: 30 }, 20)).toBe(false);
    expect(isOverdueValues({ deadline: 10, status: "done" }, 20)).toBe(false);
    expect(isOverdueValues({}, 20)).toBe(false);
  });
});

describe("duration", () => {
  it("formats in the configured unit with the unit suffix", () => {
    expect(formatDuration("days", 0, 3 * MS_DAY)).toBe("3 d");
    expect(formatDuration("hours", 0, 90 * 60_000)).toBe("1.5 h");
    expect(formatDuration("weeks", 0, 7 * MS_DAY)).toBe("1 w");
  });

  it("parses numbers, decimals and unit suffixes; rejects the unusable", () => {
    expect(parseDurationInput("days", "3")).toBe(3 * MS_DAY);
    expect(parseDurationInput("days", "12h")).toBe(12 * 3_600_000);
    expect(parseDurationInput("hours", "2 w")).toBe(14 * MS_DAY);
    expect(parseDurationInput("days", "0")).toBeUndefined();
    expect(parseDurationInput("days", "-1")).toBeUndefined();
    expect(parseDurationInput("days", "abc")).toBeUndefined();
    expect(parseDurationInput("days", {})).toBeUndefined();
  });

  it("resolveUnit falls back to days", () => {
    expect(resolveUnit("hours")).toBe("hours");
    expect(resolveUnit("fortnights")).toBe("days");
    expect(resolveUnit(undefined)).toBe("days");
  });
});

describe("sequence", () => {
  it("formats prefix, start offset and zero padding", () => {
    expect(formatSequenceId({ prefix: "T-", start: 100, minDigits: 4 }, 2)).toBe("T-0102");
    expect(formatSequenceId(resolveNumbering(undefined), 0)).toBe("1");
  });

  it("resolveNumbering drops unusable members", () => {
    expect(resolveNumbering({ prefix: 7, start: 1.5, minDigits: 0 })).toEqual({
      prefix: "",
      start: 1,
      minDigits: 1,
    });
  });

  it("caches positions and rebuilds after invalidate", () => {
    let ids = ["a", "b"];
    const cache = sequenceCache(() => ids);
    expect(cache.positionOf("b")).toBe(1);
    ids = ["b", "a"];
    expect(cache.positionOf("b")).toBe(1); // cached
    cache.invalidate();
    expect(cache.positionOf("b")).toBe(0);
  });
});

describe("config resolution", () => {
  it("resolveColumns keeps known ids, drops the rest, honors []", () => {
    expect(resolveColumns(["status", "bogus", "id", "status"])).toEqual(["status", "id"]);
    expect(resolveColumns([])).toEqual([]);
    expect(resolveColumns("nope")).toEqual(DEFAULT_COLUMNS);
  });

  it("resolveMessages overrides per key and ignores non-strings", () => {
    const m = resolveMessages({ statusDone: "Fertig", idColumn: 42 as unknown as string });
    expect(m.statusDone).toBe("Fertig");
    expect(m.idColumn).toBe(DEFAULT_MESSAGES.idColumn);
  });

  it("resolveTemplates drops non-object entries and validates fields", () => {
    const t = resolveTemplates({
      good: { fields: { status: "in-progress", priority: "nope" }, durationMs: MS_DAY },
      bad: "x",
    });
    expect([...t.keys()]).toEqual(["good"]);
    expect(t.get("good")?.fields).toEqual({ status: "in-progress" });
    expect(t.get("good")?.durationMs).toBe(MS_DAY);
  });
});

describe("appendCompletionStamps", () => {
  const getTask = (id: unknown): Task | undefined =>
    id === "t" ? asTask({ taskFields: { status: "in-progress" } }) : undefined;

  it("appends one stamp for a status flip to done", () => {
    const patches: unknown[] = [
      { op: "task/update", id: "t", before: {}, after: { meta: { taskFields: { status: "done" } } } },
    ];
    expect(appendCompletionStamps(patches, getTask, 123)).toBe(1);
    expect(patches).toHaveLength(2);
    const appended = patches[1] as { after: { meta: { taskFields: Record<string, unknown> } } };
    expect(appended.after.meta.taskFields).toEqual({ status: "done", actualEnd: 123 });
  });

  it("leaves alone transactions that already carry actualEnd or are not flips", () => {
    const withEnd: unknown[] = [
      {
        op: "task/update",
        id: "t",
        before: {},
        after: { meta: { taskFields: { status: "done", actualEnd: 5 } } },
      },
    ];
    expect(appendCompletionStamps(withEnd, getTask, 123)).toBe(0);

    const alreadyDone: unknown[] = [
      { op: "task/update", id: "t", before: {}, after: { meta: { taskFields: { status: "done" } } } },
    ];
    const doneTask = (): Task => asTask({ taskFields: { status: "done" } });
    expect(appendCompletionStamps(alreadyDone, doneTask, 123)).toBe(0);

    const notStatus: unknown[] = [{ op: "task/move", id: "t" }];
    expect(appendCompletionStamps(notStatus, getTask, 123)).toBe(0);
  });
});
