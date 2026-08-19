/**
 * `src/internal/conditional-format/conditions.ts` — the pure AND/OR condition engine, without a
 * host.
 */
import { describe, expect, it } from "vitest";
import type { Task } from "@stargantt/plugin-data-store";
import { evaluate, resolveField } from "../src/internal/conditional-format/conditions";

function task(partial: Partial<Task>): Task {
  return { id: "t1", parentId: null, name: "T", start: 0, end: 86_400_000, ...partial } as Task;
}

const sample = task({
  progress: 0.5,
  type: "task",
  meta: { priority: 2, category: "dev", tags: { kind: "urgent" } },
});

describe("resolveField", () => {
  it("reads direct task properties", () => {
    expect(resolveField(sample, "progress")).toBe(0.5);
    expect(resolveField(sample, "name")).toBe("T");
  });

  it("reads meta via the explicit and the implicit form identically", () => {
    expect(resolveField(sample, "meta.priority")).toBe(2);
    expect(resolveField(sample, "priority")).toBe(2);
    expect(resolveField(sample, "tags.kind")).toBe("urgent");
    expect(resolveField(sample, "meta.tags.kind")).toBe("urgent");
  });

  it("resolves missing or non-object steps to undefined", () => {
    expect(resolveField(sample, "nope")).toBeUndefined();
    expect(resolveField(sample, "meta.tags.kind.deeper")).toBeUndefined();
    expect(resolveField(task({}), "priority")).toBeUndefined();
  });

  // A field path is looked up as an *own* property of the task, not via `in` (which walks the
  // prototype chain): `"constructor"`, `"toString"` and the like must fall through to `task.meta`
  // exactly as any other name the task does not itself carry does, rather than resolving to
  // `Object.prototype`'s own members.
  it("falls through to meta for a field name that only exists on the prototype chain", () => {
    const withMeta = task({ meta: { constructor: "custom-value", toString: "also-custom" } });
    expect(resolveField(withMeta, "constructor")).toBe("custom-value");
    expect(resolveField(withMeta, "toString")).toBe("also-custom");
    // No meta entry at all: still falls through to `task.meta` (undefined), not the prototype's
    // function value.
    expect(resolveField(task({}), "constructor")).toBeUndefined();
  });
});

describe("evaluate — leaf operators", () => {
  it("eq / neq are strict", () => {
    expect(evaluate({ field: "priority", op: "eq", value: 2 }, sample)).toBe(true);
    expect(evaluate({ field: "priority", op: "eq", value: "2" }, sample)).toBe(false);
    expect(evaluate({ field: "priority", op: "neq", value: 3 }, sample)).toBe(true);
  });

  it("ordering compares only same-typed numbers or strings, never coercing", () => {
    expect(evaluate({ field: "progress", op: "lt", value: 0.75 }, sample)).toBe(true);
    expect(evaluate({ field: "progress", op: "gte", value: 0.5 }, sample)).toBe(true);
    expect(evaluate({ field: "progress", op: "gt", value: 0.5 }, sample)).toBe(false);
    expect(evaluate({ field: "category", op: "lt", value: "eee" }, sample)).toBe(true);
    expect(evaluate({ field: "progress", op: "lt", value: "0.75" }, sample)).toBe(false);
    expect(evaluate({ field: "missing", op: "lt", value: 1 }, sample)).toBe(false);
  });

  it("in checks membership of an array value", () => {
    expect(evaluate({ field: "category", op: "in", value: ["dev", "ops"] }, sample)).toBe(true);
    expect(evaluate({ field: "category", op: "in", value: ["ops"] }, sample)).toBe(false);
    expect(evaluate({ field: "category", op: "in", value: "dev" }, sample)).toBe(false);
  });

  it("exists is true for any value that is neither undefined nor null", () => {
    expect(evaluate({ field: "priority", op: "exists" }, sample)).toBe(true);
    expect(evaluate({ field: "missing", op: "exists" }, sample)).toBe(false);
  });
});

describe("evaluate — combinators", () => {
  it("all is AND with an empty list true", () => {
    expect(
      evaluate(
        {
          all: [
            { field: "priority", op: "eq", value: 2 },
            { field: "progress", op: "lt", value: 1 },
          ],
        },
        sample,
      ),
    ).toBe(true);
    expect(
      evaluate(
        { all: [{ field: "priority", op: "eq", value: 2 }, { field: "missing", op: "exists" }] },
        sample,
      ),
    ).toBe(false);
    expect(evaluate({ all: [] }, sample)).toBe(true);
  });

  it("any is OR with an empty list false, and not negates", () => {
    expect(
      evaluate(
        { any: [{ field: "missing", op: "exists" }, { field: "category", op: "eq", value: "dev" }] },
        sample,
      ),
    ).toBe(true);
    expect(evaluate({ any: [] }, sample)).toBe(false);
    expect(evaluate({ not: { field: "missing", op: "exists" } }, sample)).toBe(true);
  });

  it("nests arbitrarily", () => {
    const cond = {
      any: [
        { all: [{ field: "priority", op: "gte", value: 3 }] },
        {
          all: [
            { field: "category", op: "eq", value: "dev" },
            { not: { field: "progress", op: "gte", value: 1 } },
          ],
        },
      ],
    };
    expect(evaluate(cond, sample)).toBe(true);
  });
});

describe("evaluate — malformed conditions", () => {
  it("evaluates non-objects, unknown ops and bad lists to false without throwing", () => {
    expect(evaluate(null, sample)).toBe(false);
    expect(evaluate("x", sample)).toBe(false);
    expect(evaluate({ field: "priority", op: "like", value: 2 }, sample)).toBe(false);
    expect(evaluate({ all: "not-a-list" }, sample)).toBe(false);
    expect(evaluate({ field: 7, op: "eq" }, sample)).toBe(false);
  });
});
