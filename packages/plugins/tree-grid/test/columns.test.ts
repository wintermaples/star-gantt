/**
 * `TreeGridConfig.columns` / `formatDate` / `formatProgress`.
 *
 * docs/specs/plugins/tree-grid.md § Config
 *
 * Omitting all three reproduces the built-in grid exactly — the same four built-in columns, the
 * same ISO dates and the same whole percentages.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Task } from "@stargantt/plugin-data-store";
import type { ColumnDef } from "../src/types";
import type { TreeGridConfig } from "../src/index";
import {
  DEFAULT_FORMATTERS,
  defaultColumns,
  defaultDateText,
  defaultProgressText,
} from "../src/internal/columns";
import { DEFAULT_MESSAGES } from "../src/internal/messages";
import { boot, flatTasks, probe } from "./_boot";
import type { Booted } from "./_boot";

const MS_DAY = 86_400_000;

let booted: Booted | undefined;

afterEach(() => {
  booted?.gantt.dispose();
  booted?.dom.restore();
  booted = undefined;
});

/** Boots with `config`, loads `tasks` and paints one frame. */
function grid(config?: TreeGridConfig, tasks: Partial<Task>[] = flatTasks(1)): Booted {
  const b = boot([], {}, config);
  booted = b;
  b.data.load(tasks);
  b.dom.flushFrames();
  return b;
}

function headers(b: Booted): string[] {
  return b.header.findAll("sg-grid-cell sg-grid-header-cell").map((h) => h.textContent ?? "");
}

function cells(b: Booted, row = 0): string[] {
  const found = b.visibleRows()[row];
  return found === undefined ? [] : found.findAll("sg-grid-cell").map((c) => c.textContent ?? "");
}

/** One task carrying every field the built-in columns read. */
const DATED: Partial<Task>[] = [
  { id: "t0", parentId: null, name: "t0", start: 0, end: MS_DAY, progress: 0.45 },
];

/* ------------------------------------------------------------------ *
 * Built-in cell rendering — the defaults
 * ------------------------------------------------------------------ */

describe("built-in cell formatting defaults", () => {
  it("renders ISO UTC dates and whole percentages, exactly as before", () => {
    expect(cells(grid(undefined, DATED))).toEqual(["t0", "1970-01-01", "1970-01-02", "45%"]);
  });

  it("renders the same cells for an empty config", () => {
    expect(cells(grid({}, DATED))).toEqual(["t0", "1970-01-01", "1970-01-02", "45%"]);
  });

  it("leaves a task with no progress with an empty progress cell", () => {
    expect(cells(grid(undefined, flatTasks(1)))[3]).toBe("");
  });

  it("exposes the two defaults the normative table fixes", () => {
    expect(defaultDateText(0)).toBe("1970-01-01");
    expect(defaultProgressText(0.45)).toBe("45%");
    expect(DEFAULT_FORMATTERS.date).toBe(defaultDateText);
    expect(DEFAULT_FORMATTERS.progress).toBe(defaultProgressText);
  });
});

// docs/specs/plugins/tree-grid.md § Config — the finiteness guards sit in the plugin, *outside* the
// hook, so a hook is never handed a value it must guard. Exercised directly on the column
// definitions, because the store coerces both fields on the way in.
describe("the guards around the format hooks", () => {
  function cellOf(column: ColumnDef, task: Partial<Task>): string {
    const el = { textContent: "" };
    column.render(el as unknown as HTMLElement, task as Task);
    return el.textContent;
  }

  // Only the first four keys matter to `defaultColumns`; the rest are carried from the catalog
  // defaults so the object satisfies the full message-catalog type.
  const messages = {
    ...DEFAULT_MESSAGES,
    nameColumn: "N",
    startColumn: "S",
    endColumn: "E",
    progressColumn: "P",
  };

  it("renders an empty cell without calling the hook for a missing or non-finite value", () => {
    const seen: number[] = [];
    const record = (value: number): string => {
      seen.push(value);
      return "called";
    };
    const columns = defaultColumns(messages, { date: record, progress: record });
    const [, start, end, progress] = columns as [ColumnDef, ColumnDef, ColumnDef, ColumnDef];

    expect(cellOf(start, { start: Number.NaN })).toBe("");
    // An absent `end` — the field the store always fills, faked here to prove the guard, not the
    // store's behavior.
    expect(cellOf(end, {})).toBe("");
    expect(cellOf(progress, {})).toBe("");
    expect(cellOf(progress, { progress: Number.POSITIVE_INFINITY })).toBe("");
    expect(seen).toEqual([]);
  });

  it("hands the hook the raw stored progress, unclamped", () => {
    const seen: number[] = [];
    const columns = defaultColumns(messages, {
      date: DEFAULT_FORMATTERS.date,
      progress: (p) => {
        seen.push(p);
        return DEFAULT_FORMATTERS.progress(p);
      },
    });
    expect(cellOf(columns[3] as ColumnDef, { progress: 1.5 })).toBe("150%");
    expect(seen).toEqual([1.5]);
  });
});

describe("formatDate / formatProgress", () => {
  it("formats the built-in date cells with the hook", () => {
    const b = grid({ formatDate: (t) => `d${t}` }, DATED);
    expect(cells(b)).toEqual(["t0", "d0", `d${MS_DAY}`, "45%"]);
  });

  it("formats the built-in progress cell with the hook", () => {
    const b = grid({ formatProgress: (p) => `${p}` }, DATED);
    expect(cells(b)[3]).toBe("0.45");
  });

  // A hook value that is not a function is ignored and the built-in default is used.
  it("ignores a hook that is not a function", () => {
    const config = {
      formatDate: "nope",
      formatProgress: 7,
    } as unknown as TreeGridConfig;
    expect(cells(grid(config, DATED))).toEqual(["t0", "1970-01-01", "1970-01-02", "45%"]);
  });

  it("leaves the headers, widths and ids untouched", () => {
    const b = grid({ formatDate: () => "x", formatProgress: () => "y" }, DATED);
    expect(headers(b)).toEqual(["Name", "Start", "End", "Progress"]);
  });

  // docs/specs/plugins/tree-grid.md § Config — a throwing hook is reported once, that cell falls
  // back to the built-in default, and the hook is not called again for the life of the instance.
  it("reports a throwing hook once, defaults the cell, and then stops calling it", () => {
    const errors: { pluginId: string; error: unknown }[] = [];
    let calls = 0;
    const b = boot(
      [
        probe((ctx) => {
          ctx.on("core/pluginError", (e) => void errors.push(e));
        }),
      ],
      {},
      {
        formatDate: () => {
          calls += 1;
          throw new Error("boom");
        },
      },
    );
    booted = b;
    b.data.load(flatTasks(3));
    b.dom.flushFrames();

    expect(calls).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.pluginId).toBe("stargantt.tree-grid");
    // Every date cell, including the one whose call threw, carries the built-in default.
    expect(cells(b, 0).slice(1, 3)).toEqual(["1970-01-01", "1970-01-02"]);
    expect(cells(b, 2).slice(1, 3)).toEqual(["1970-01-01", "1970-01-02"]);

    b.data.load(flatTasks(3));
    b.dom.flushFrames();
    expect(calls).toBe(1);
    expect(errors).toHaveLength(1);
  });

  it("latches each hook separately", () => {
    const errors: unknown[] = [];
    let progressCalls = 0;
    const b = boot(
      [
        probe((ctx) => {
          ctx.on("core/pluginError", (e) => void errors.push(e));
        }),
      ],
      {},
      {
        formatDate: () => {
          throw new Error("boom");
        },
        formatProgress: (p) => {
          progressCalls += 1;
          return `${p}`;
        },
      },
    );
    booted = b;
    b.data.load([
      { id: "a", parentId: null, name: "a", start: 0, end: MS_DAY, progress: 0.5 },
      { id: "b", parentId: null, name: "b", start: 0, end: MS_DAY, progress: 0.25 },
    ]);
    b.dom.flushFrames();

    expect(errors).toHaveLength(1);
    expect(progressCalls).toBe(2);
    expect(cells(b, 1)[3]).toBe("0.25");
  });
});

/* ------------------------------------------------------------------ *
 * Columns — replacing the built-ins
 * ------------------------------------------------------------------ */

function column(id: string, header = id.toUpperCase()): ColumnDef {
  return {
    id,
    header,
    width: 50,
    render: (el, task) => void (el.textContent = `${id}:${task.name}`),
    getValue: (task) => task.name,
    // Mirrors the built-in `name` column: only a column reusing that id is editable.
    ...(id === "name" ? { setValue: (task: Task, value: unknown) => void (task.name = String(value)) } : {}),
  };
}

describe("columns — replacing the built-ins", () => {
  it("contributes the built-in four when the option is absent", () => {
    expect(headers(grid())).toEqual(["Name", "Start", "End", "Progress"]);
  });

  it("contributes the array's entries instead, in array order", () => {
    const b = grid({ columns: [column("b"), column("a")] }, DATED);
    expect(headers(b)).toEqual(["B", "A"]);
    expect(cells(b)).toEqual(["b:t0", "a:t0"]);
  });

  // The empty array is a legitimate value, not an unusable one.
  it("honours the empty array as 'no built-in columns'", () => {
    const b = grid({ columns: [] }, DATED);
    expect(headers(b)).toEqual([]);
    expect(cells(b)).toEqual([]);
  });

  it("ignores a `columns` that is not an array and keeps the built-ins", () => {
    const config = { columns: "nope" } as unknown as TreeGridConfig;
    expect(headers(grid(config))).toEqual(["Name", "Start", "End", "Progress"]);
  });

  it("skips an unusable entry and contributes the rest", () => {
    const bad = [
      null,
      { id: 1, header: "x", render: () => {} },
      { id: "x", header: 2, render: () => {} },
      { id: "x", header: "x", render: "nope" },
      column("ok"),
    ] as unknown as ColumnDef[];
    expect(headers(grid({ columns: bad }))).toEqual(["OK"]);
  });

  it("does not resurrect the built-ins when every entry is skipped", () => {
    const bad = [null, 7] as unknown as ColumnDef[];
    expect(headers(grid({ columns: bad }))).toEqual([]);
  });

  it("leaves another plugin's contribution in place, after its own", () => {
    booted = boot(
      [
        probe((ctx) => {
          ctx.contribute("grid/columns", column("note", "Note"));
        }),
      ],
      {},
      { columns: [column("a")] },
    );
    expect(headers(booted)).toEqual(["A", "Note"]);
  });

  // The message catalog has nothing left to title once the built-ins are gone.
  it("makes the message catalog inert", () => {
    const b = grid({ columns: [column("a")], messages: { nameColumn: "Aufgabe" } });
    expect(headers(b)).toEqual(["A"]);
  });

  it("makes the format hooks inert", () => {
    let calls = 0;
    const b = grid(
      {
        columns: [column("a")],
        formatDate: () => {
          calls += 1;
          return "x";
        },
        formatProgress: () => {
          calls += 1;
          return "y";
        },
      },
      DATED,
    );
    void b;
    expect(calls).toBe(0);
  });

  it("resolves once at setup: mutating the array afterwards has no effect", () => {
    const columns = [column("a")];
    booted = boot([], {}, { columns });
    columns.push(column("b"));
    expect(headers(booted)).toEqual(["A"]);
  });

  // Replacing a built-in column while keeping its `id` is the supported way to change a column's
  // rendering without breaking a consumer that keys off the id (inline editing included).
  it("keeps the `name` column editable when a replacement reuses its id", () => {
    const b = grid({ columns: [column("name", "Name")] }, DATED);
    b.gantt.dispatch("view/editStart", { id: "t0" });
    expect(b.editor()).toBeDefined();
  });
});
