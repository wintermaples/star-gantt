import { describe, expect, it } from "vitest";
import type { Task } from "@stargantt/plugin-data-store";
import { buildColumns } from "../src/internal/task-fields/columns";
import type { ColumnDeps } from "../src/internal/task-fields/columns";
import { DEFAULT_MESSAGES } from "../src/internal/messages";

const MS_DAY = 86_400_000;
const NOW = Date.UTC(1970, 0, 15);

function deps(overrides: Partial<ColumnDeps> = {}): ColumnDeps {
  return {
    messages: DEFAULT_MESSAGES,
    unit: "days",
    displayIdOf: (t) => `#${String(t.id)}`,
    assigneeTextOf: () => "Ann, Bob",
    now: () => NOW,
    ...overrides,
  };
}

function t(meta?: Record<string, unknown>, extra: Partial<Task> = {}): Task {
  const base: Task = { id: "a", parentId: null, name: "a", start: 0, end: 2 * MS_DAY, ...extra };
  if (meta !== undefined) base.meta = meta;
  return base;
}

/** A minimal cell double: `render` only ever sets `textContent`. */
function cell(): { textContent: string } {
  return { textContent: "" };
}

function column(id: string, d = deps()) {
  const defs = buildColumns(
    ["id", "status", "priority", "tags", "assignees", "deadline", "actualStart", "actualEnd", "duration"],
    d,
  );
  const def = defs.find((c) => c.id === `taskfields-${id}`);
  if (def === undefined) throw new Error(`missing column ${id}`);
  return def;
}

describe("grid columns", () => {
  it("status renders glyph + label, sorts by declaration order and accepts key or label", () => {
    const def = column("status");
    const el = cell();
    def.render(el as unknown as HTMLElement, t({ taskFields: { status: "done" } }));
    expect(el.textContent).toBe("✓ Done");
    def.render(el as unknown as HTMLElement, t());
    expect(el.textContent).toBe("");

    const draft = t();
    def.setValue?.(draft, "In Progress");
    expect(draft.meta).toEqual({ taskFields: { status: "in-progress" } });
    def.setValue?.(draft, "garbage"); // ignored
    expect(draft.meta).toEqual({ taskFields: { status: "in-progress" } });

    const a = t({ taskFields: { status: "not-started" } });
    const b = t({ taskFields: { status: "done" } });
    expect(def.compare?.(a, b)).toBeLessThan(0);
    expect(def.compare?.(b, t())).toBeLessThan(0); // absent sorts last
  });

  it("priority renders its label and sorts high first", () => {
    const def = column("priority");
    const el = cell();
    def.render(el as unknown as HTMLElement, t({ taskFields: { priority: "high" } }));
    expect(el.textContent).toBe("High");
    const draft = t();
    def.setValue?.(draft, "low");
    expect(draft.meta).toEqual({ taskFields: { priority: "low" } });
    expect(
      def.compare?.(t({ taskFields: { priority: "high" } }), t({ taskFields: { priority: "low" } })),
    ).toBeLessThan(0);
  });

  it("tags round-trip through a comma-separated cell text", () => {
    const def = column("tags");
    const draft = t();
    def.setValue?.(draft, " a, b ,a,");
    expect(draft.meta).toEqual({ taskFields: { tags: ["a", "b"] } });
    const el = cell();
    def.render(el as unknown as HTMLElement, draft);
    expect(el.textContent).toBe("a, b");
    def.setValue?.(draft, ""); // empty clears
    // The emptied bag becomes `{}` (never a deleted key) so the grid diff can see the clear.
    expect(draft.meta).toEqual({});
    expect(Object.keys(draft)).toContain("meta");
  });

  it("clearing a field that is not stored leaves an absent meta untouched (no phantom diff)", () => {
    const def = column("tags");
    const draft = t();
    def.setValue?.(draft, "");
    expect(draft.meta).toBeUndefined();
  });

  it("deadline renders ISO with the overdue suffix and parses YYYY-MM-DD", () => {
    const def = column("deadline");
    const el = cell();
    def.render(el as unknown as HTMLElement, t({ taskFields: { deadline: NOW - MS_DAY } }));
    expect(el.textContent).toBe("1970-01-14 !");
    def.render(
      el as unknown as HTMLElement,
      t({ taskFields: { deadline: NOW - MS_DAY, status: "done" } }),
    );
    expect(el.textContent).toBe("1970-01-14");

    const draft = t();
    def.setValue?.(draft, "1970-02-01");
    expect(draft.meta).toEqual({ taskFields: { deadline: Date.UTC(1970, 1, 1) } });
    def.setValue?.(draft, "not a date"); // ignored
    expect(draft.meta).toEqual({ taskFields: { deadline: Date.UTC(1970, 1, 1) } });
    // The strict parse rejects a calendar-invalid date rather than rolling it over.
    def.setValue?.(draft, "2024-02-30"); // ignored
    expect(draft.meta).toEqual({ taskFields: { deadline: Date.UTC(1970, 1, 1) } });
    def.setValue?.(draft, ""); // clears
    expect(draft.meta).toEqual({});
    expect(Object.keys(draft)).toContain("meta");
  });

  it("duration renders in the configured unit and a commit moves end only", () => {
    const def = column("duration", deps({ unit: "hours" }));
    const el = cell();
    const draft = t();
    def.render(el as unknown as HTMLElement, draft);
    expect(el.textContent).toBe("48 h");
    def.setValue?.(draft, "12");
    expect(draft).toMatchObject({ start: 0, end: 12 * 3_600_000 });
    def.setValue?.(draft, "1d"); // suffix overrides the unit
    expect(draft.end).toBe(MS_DAY);
    def.setValue?.(draft, "junk");
    expect(draft.end).toBe(MS_DAY);
  });

  it("id and assignees are read-only projections", () => {
    const idDef = column("id");
    expect(idDef.setValue).toBeUndefined();
    expect(idDef.getValue(t())).toBe("#a");
    const asgDef = column("assignees");
    expect(asgDef.setValue).toBeUndefined();
    expect(asgDef.getValue(t())).toBe("Ann, Bob");
  });
});
