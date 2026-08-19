/**
 * `src/internal/conditional-format/config.ts` + `src/internal/conditional-format/style.ts` — config
 * normalization and the color resolution order (rules → overdue → priorityColors), without a host.
 */
import { describe, expect, it } from "vitest";
import type { Task } from "@stargantt/plugin-data-store";
import { OVERDUE_COLOR, resolveConfig } from "../src/internal/conditional-format/config";
import { createStyleResolver, isOverdue } from "../src/internal/conditional-format/style";

const DAY = 86_400_000;

function task(partial: Partial<Task>): Task {
  return { id: "t1", parentId: null, name: "T", start: 0, end: DAY, ...partial } as Task;
}

/** Colors in these fixtures are literals; token resolution has its own suite in `cf-color.test.ts`. */
const literalColor = (raw: string): string => raw;

describe("resolveConfig", () => {
  it("treats an omitted config as fully inert", () => {
    const r = resolveConfig(undefined);
    expect(r.rules).toEqual([]);
    expect(r.priorityColors).toEqual([]);
    expect(r.overdue).toBeNull();
    expect(r.progress).toBeNull();
    expect(r.legend).toBe(false);
    // Nothing to color: the provider declines for every task, so no bar changes.
    const resolve = createStyleResolver(r, literalColor).style;
    expect(resolve(task({ meta: { priority: 1 } }))).toBeUndefined();
  });

  it("drops unusable rules, colors and priority entries silently", () => {
    const r = resolveConfig({
      rules: [
        null as never,
        { when: { field: "x", op: "exists" }, style: { color: 7 as never } },
        { when: { field: "x", op: "exists" }, style: { color: "#123456" } },
      ],
      priorityColors: { high: "#f00", bad: 3 as never, empty: "" },
      overdue: { color: "" },
    });
    expect(r.rules).toHaveLength(2);
    expect(r.rules[1]?.style.color).toBe("#123456");
    expect(r.priorityColors).toEqual([["high", "#f00"]]);
    expect(r.overdue?.color).toBe(OVERDUE_COLOR);
    expect(r.overdue?.icon).toBe(true);
  });
});

describe("isOverdue", () => {
  it("is true when the end has passed and progress is below 1, never for summaries", () => {
    expect(isOverdue(task({ end: DAY }), 2 * DAY)).toBe(true);
    expect(isOverdue(task({ end: DAY, progress: 1 }), 2 * DAY)).toBe(false);
    expect(isOverdue(task({ end: DAY }), DAY / 2)).toBe(false);
    expect(isOverdue(task({ end: DAY, type: "summary" }), 2 * DAY)).toBe(false);
    expect(isOverdue(task({ start: DAY, end: DAY, type: "milestone" }), 2 * DAY)).toBe(true);
  });
});

describe("createStyleResolver", () => {
  const now = () => 10 * DAY;

  it("applies the first matching rule in array order", () => {
    const r = resolveConfig({
      rules: [
        { when: { field: "priority", op: "eq", value: 1 }, style: { color: "first" } },
        { when: { field: "priority", op: "exists" }, style: { color: "second" } },
      ],
      now,
    });
    const resolve = createStyleResolver(r, literalColor).style;
    expect(resolve(task({ meta: { priority: 1 } }))).toEqual({ color: "first" });
    expect(resolve(task({ meta: { priority: 9 } }))).toEqual({ color: "second" });
    expect(resolve(task({}))).toBeUndefined();
  });

  it("lets rules trump the overdue warning, which trumps priority colors", () => {
    const r = resolveConfig({
      rules: [{ when: { field: "category", op: "eq", value: "x" }, style: { color: "rule" } }],
      overdue: { color: "warn" },
      priorityColors: { "1": "prio" },
      now,
    });
    const resolve = createStyleResolver(r, literalColor).style;
    // Overdue AND priority AND matching rule → the rule wins.
    expect(resolve(task({ end: DAY, meta: { category: "x", priority: 1 } }))).toEqual({
      color: "rule",
    });
    // Overdue AND priority → the warning wins.
    expect(resolve(task({ end: DAY, meta: { priority: 1 } }))).toEqual({ color: "warn" });
    // Priority only (not overdue: ends in the future).
    expect(resolve(task({ end: 20 * DAY, meta: { priority: 1 } }))).toEqual({ color: "prio" });
  });

  it("matches priorities by their string form", () => {
    const r = resolveConfig({ priorityColors: { "2": "two", high: "h" }, now });
    const resolve = createStyleResolver(r, literalColor).style;
    expect(resolve(task({ end: 20 * DAY, meta: { priority: 2 } }))).toEqual({ color: "two" });
    expect(resolve(task({ end: 20 * DAY, meta: { priority: "high" } }))).toEqual({ color: "h" });
    expect(resolve(task({ end: 20 * DAY, meta: { priority: "low" } }))).toBeUndefined();
    expect(resolve(task({ end: 20 * DAY }))).toBeUndefined();
  });
});
