/**
 * `src/internal/grid-header.ts` — the header row, the sort cycle (pointer and keyboard alike), and
 * the header-boundary resize with its announcements.
 */
import type { Task } from "@stargantt/plugin-data-store";
import { describe, expect, it } from "vitest";
import type { ColumnDef, GridSortState } from "../src/types";
import { createColumnTrack } from "../src/internal/column-track";
import type { ColumnTrack } from "../src/internal/column-track";
import { createGridHeader } from "../src/internal/grid-header";
import type { GridHeader } from "../src/internal/grid-header";
import type { GridTokenCache } from "../src/internal/tokens";
import { markWbsColumn } from "../src/internal/tree-column";
import type { FakeElement } from "./_harness/index";
import { unitColumn } from "./_units";
import { asDoc, unitDoc } from "./_units-dom";

type Comparator = (a: Readonly<Task>, b: Readonly<Task>) => number;

interface Harness {
  header: GridHeader;
  track: ColumnTrack;
  element: FakeElement;
  /** Header cells in display order (the leading gutter excluded). */
  cells(): FakeElement[];
  cell(id: string): FakeElement;
  /** The resize handle inside a header cell. */
  handle(id: string): FakeElement;
  comparators: (Comparator | null)[];
  sortChanges: (GridSortState | null)[];
  rowsChanged(): number;
  repaints(): number;
  widthEmits: ("now" | "throttled")[];
  faults: unknown[];
  tokenWidth: { value: number };
}

function harness(
  columns: ColumnDef[] = [unitColumn("name", { width: 220 })],
  options: { cellPadding?: number } = {},
): Harness {
  const doc = unitDoc();
  const track = createColumnTrack(() => columns);
  track.refresh();
  const comparators: (Comparator | null)[] = [];
  const sortChanges: (GridSortState | null)[] = [];
  const widthEmits: ("now" | "throttled")[] = [];
  const faults: unknown[] = [];
  const bodyWidths: [number, number][] = [];
  const tokenWidth = { value: 24 };
  let rowsChanged = 0;
  let repaints = 0;
  const tokens: GridTokenCache = {
    get: () => ({ toggleWidth: tokenWidth.value, cellPadding: options.cellPadding ?? 8 }),
    invalidate: () => {},
  };
  const header = createGridHeader({
    doc: asDoc(doc),
    track,
    tokens,
    applyBodyWidth: (index, width) => bodyWidths.push([index, width]),
    setSortComparator: (compare) => comparators.push(compare),
    fault: (error) => faults.push(error),
    schedule: () => {
      repaints += 1;
    },
    onRowsChanged: () => {
      rowsChanged += 1;
    },
    onSortChanged: (sort) => sortChanges.push(sort),
    onWidthsChanged: () => widthEmits.push("now"),
    onWidthsChangedThrottled: () => widthEmits.push("throttled"),
  });
  const element = header.element as unknown as FakeElement;
  const cells = (): FakeElement[] => element.findAll("sg-grid-header-cell");
  const cell = (id: string): FakeElement => {
    const hit = cells().find((c) => c.getAttribute("data-column-id") === id);
    if (hit === undefined) throw new Error(`no header cell for ${id}`);
    return hit;
  };
  return {
    header,
    track,
    element,
    cells,
    cell,
    handle: (id) => {
      const hit = cell(id).find("sg-grid-header-resize-handle");
      if (hit === undefined) throw new Error(`no resize handle for ${id}`);
      return hit;
    },
    comparators,
    sortChanges,
    rowsChanged: () => rowsChanged,
    repaints: () => repaints,
    widthEmits,
    faults,
    tokenWidth,
  };
}

/** A sortable column ordering by task name. */
function sortable(id: string, extra: Partial<ColumnDef> = {}): ColumnDef {
  return unitColumn(id, { compare: (a, b) => a.name.localeCompare(b.name), ...extra });
}

/** A keyboard event double. */
function key(k: string, target: unknown, altKey = false): {
  key: string;
  altKey: boolean;
  target: unknown;
  preventDefault(): void;
  prevented: boolean;
} {
  const e = {
    key: k,
    altKey,
    target,
    prevented: false,
    preventDefault(): void {
      e.prevented = true;
    },
  };
  return e;
}

describe("createGridHeader — rebuild", () => {
  it("builds the leading gutter and one cell per column", () => {
    const h = harness([unitColumn("name", { width: 220 }), unitColumn("end", { width: 110 })]);
    h.header.rebuild();
    const gutter = h.element.find("sg-grid-header-gutter");
    expect(gutter?.style["width"]).toBe("24px");
    expect(gutter?.getAttribute("aria-hidden")).toBe("true");
    expect(h.cells().map((c) => c.getAttribute("data-column-id"))).toEqual(["name", "end"]);
    expect(h.cells().map((c) => c.style["width"])).toEqual(["220px", "110px"]);
  });

  it("makes every header cell a `columnheader` tab stop with its own resize handle", () => {
    const h = harness();
    h.header.rebuild();
    const cell = h.cell("name");
    expect(cell.getAttribute("role")).toBe("columnheader");
    expect(cell.getAttribute("tabindex")).toBe("0");
    expect(cell.textContent).toBe("NAME");
    const handle = h.handle("name");
    expect(handle.style["width"]).toBe("24px");
    expect(handle.style["cursor"]).toBe("col-resize");
  });

  it("registers its cells with the track and replaces them on the next rebuild", () => {
    const h = harness();
    h.header.rebuild();
    const first = h.track.headerCell("name");
    h.header.rebuild();
    expect(h.track.headerCell("name")).not.toBe(first);
    expect(h.cells().length).toBe(1);
  });

  it("declares no width for a column that declares none", () => {
    const h = harness([unitColumn("name")]);
    h.header.rebuild();
    expect(h.cell("name").style["width"]).toBeUndefined();
  });

  // docs/specs/plugins/tree-grid.md § Config, "Tree indentation" — the header's gutter has to sit
  // exactly where every row's does, or the header cells stop covering their own body cells (the
  // header/body parity invariant).
  it("puts the gutter before the tree column, after a WBS numbering column", () => {
    const h = harness([
      markWbsColumn(unitColumn("wbs", { width: 70 })),
      unitColumn("name", { width: 220 }),
    ]);
    h.header.rebuild();
    expect(h.element.children.map((c) => c.getAttribute("data-column-id") ?? c.className)).toEqual([
      "wbs",
      "sg-grid-header-gutter",
      "name",
    ]);
  });

  it("builds no gutter when no column is displayed", () => {
    const h = harness([]);
    h.header.rebuild();
    expect(h.element.find("sg-grid-header-gutter")).toBeUndefined();
    expect(h.element.children).toEqual([]);
  });

  it("re-applies the gutter width after a theme change", () => {
    const h = harness();
    h.header.rebuild();
    h.tokenWidth.value = 32;
    h.header.applyGutterWidth();
    expect(h.element.find("sg-grid-header-gutter")?.style["width"]).toBe("32px");
  });
});

describe("createGridHeader — sorting", () => {
  it("cycles ascending → descending → off, publishing each step", () => {
    const h = harness([sortable("name", { width: 220 })]);
    h.header.rebuild();

    h.header.cycleSort("name");
    expect(h.cell("name").getAttribute("aria-sort")).toBe("ascending");
    expect(h.cell("name").getAttribute("data-sort")).toBe("ascending");

    h.header.cycleSort("name");
    expect(h.cell("name").getAttribute("aria-sort")).toBe("descending");

    h.header.cycleSort("name");
    expect(h.cell("name").getAttribute("aria-sort")).toBe("none");
    expect(h.cell("name").getAttribute("data-sort")).toBeNull();

    expect(h.sortChanges).toEqual([
      { columnId: "name", header: "NAME", direction: "ascending" },
      { columnId: "name", header: "NAME", direction: "descending" },
      null,
    ]);
    expect(h.rowsChanged()).toBe(3);
    expect(h.repaints()).toBe(3);
  });

  it("installs a comparator that reverses for descending, and clears it for off", () => {
    const h = harness([sortable("name", { width: 220 })]);
    h.header.rebuild();
    const a = { name: "a" } as Task;
    const b = { name: "b" } as Task;

    h.header.cycleSort("name");
    expect((h.comparators[0] as Comparator)(a, b)).toBeLessThan(0);
    h.header.cycleSort("name");
    expect((h.comparators[1] as Comparator)(a, b)).toBeGreaterThan(0);
    h.header.cycleSort("name");
    expect(h.comparators[2]).toBeNull();
  });

  it("reports a throwing `compare` and treats the pair as equal", () => {
    const boom = new Error("bad comparator");
    const h = harness([
      sortable("name", {
        width: 220,
        compare: () => {
          throw boom;
        },
      }),
    ]);
    h.header.rebuild();
    h.header.cycleSort("name");
    expect((h.comparators[0] as Comparator)({} as Task, {} as Task)).toBe(0);
    expect(h.faults).toContain(boom);
  });

  it("replaces the active sort when a different column is cycled", () => {
    const h = harness([sortable("name", { width: 220 }), sortable("end", { width: 110 })]);
    h.header.rebuild();
    h.header.cycleSort("name");
    h.header.cycleSort("end");
    expect(h.cell("name").getAttribute("aria-sort")).toBe("none");
    expect(h.cell("end").getAttribute("aria-sort")).toBe("ascending");
  });

  it("leaves a column without `compare` unsortable and unmarked", () => {
    const h = harness([unitColumn("name", { width: 220 })]);
    h.header.rebuild();
    h.header.cycleSort("name");
    expect(h.cell("name").getAttribute("aria-sort")).toBeNull();
    expect(h.sortChanges).toEqual([]);
    expect(h.comparators).toEqual([]);
  });

  it("restores the active sort's mark across a rebuild", () => {
    const h = harness([sortable("name", { width: 220 })]);
    h.header.rebuild();
    h.header.cycleSort("name");
    h.header.rebuild();
    expect(h.cell("name").getAttribute("aria-sort")).toBe("ascending");
    expect(h.cell("name").getAttribute("data-sort")).toBe("ascending");
  });

  it("sorts on a header click, but never from the resize handle", () => {
    const h = harness([sortable("name", { width: 220 })]);
    h.header.rebuild();
    h.header.onClick({ target: h.handle("name") });
    expect(h.sortChanges).toEqual([]);
    h.header.onClick({ target: h.cell("name") });
    expect(h.sortChanges.length).toBe(1);
    h.header.onClick({ target: h.element });
    expect(h.sortChanges.length).toBe(1);
  });

  it("sorts on Enter and on Space, swallowing the key", () => {
    const h = harness([sortable("name", { width: 220 })]);
    h.header.rebuild();
    const enter = key("Enter", h.cell("name"));
    h.header.onKeyDown(enter);
    expect(enter.prevented).toBe(true);
    h.header.onKeyDown(key(" ", h.cell("name")));
    expect(h.sortChanges.map((c) => c?.direction)).toEqual(["ascending", "descending"]);
  });

  it("ignores a keydown outside any header cell", () => {
    const h = harness([sortable("name", { width: 220 })]);
    h.header.rebuild();
    const stray = key("Enter", h.element);
    h.header.onKeyDown(stray);
    expect(stray.prevented).toBe(false);
    expect(h.sortChanges).toEqual([]);
  });
});

describe("createGridHeader — column resize", () => {
  it("nudges a column with Alt+Arrow, announcing the committed step at once", () => {
    const h = harness([unitColumn("name", { width: 220 })]);
    h.header.rebuild();
    const right = key("ArrowRight", h.cell("name"), true);
    h.header.onKeyDown(right);
    expect(right.prevented).toBe(true);
    expect(h.cell("name").style["width"]).toBe("236px");
    expect(h.widthEmits).toEqual(["now"]);

    h.header.onKeyDown(key("ArrowLeft", h.cell("name"), true));
    expect(h.cell("name").style["width"]).toBe("220px");
  });

  it("accumulates successive presses off the width it just wrote", () => {
    const h = harness([unitColumn("name", { width: 220 })]);
    h.header.rebuild();
    h.header.onKeyDown(key("ArrowRight", h.cell("name"), true));
    h.header.onKeyDown(key("ArrowRight", h.cell("name"), true));
    expect(h.cell("name").style["width"]).toBe("252px");
  });

  it("seeds an undeclared width from the header cell's measured box, not from the floor", () => {
    const h = harness([unitColumn("name")]);
    h.header.rebuild();
    // The fake DOM reports 400 px for every element, which is what the drag handle seeds from too.
    h.header.onKeyDown(key("ArrowRight", h.cell("name"), true));
    expect(h.cell("name").style["width"]).toBe("416px");
  });

  // docs/specs/plugins/tree-grid.md § Config, "Header parity and the usable minimum" — the floor is
  // 24 CSS px of content box, so with the default 8 px cell padding the narrowest border box a
  // resize can reach is 40 px.
  it("clamps a keyboard nudge at the resize floor", () => {
    const h = harness([unitColumn("name", { width: 44 })]);
    h.header.rebuild();
    h.header.onKeyDown(key("ArrowLeft", h.cell("name"), true));
    expect(h.cell("name").style["width"]).toBe("40px");
    h.header.onKeyDown(key("ArrowLeft", h.cell("name"), true));
    expect(h.cell("name").style["width"]).toBe("40px");
  });

  // The floor is derived from the cell-padding token, not hardcoded: a theme with roomier cells
  // moves it, so the 24 px of content box survives the restyle.
  it("derives the floor from the cell-padding token", () => {
    const h = harness([unitColumn("name", { width: 60 })], { cellPadding: 16 });
    h.header.rebuild();
    for (let i = 0; i < 5; i += 1) h.header.onKeyDown(key("ArrowLeft", h.cell("name"), true));
    expect(h.cell("name").style["width"]).toBe("56px");
  });

  it("leaves Alt+Arrow alone without the Alt modifier", () => {
    const h = harness([unitColumn("name", { width: 220 })]);
    h.header.rebuild();
    h.header.onKeyDown(key("ArrowRight", h.cell("name")));
    expect(h.cell("name").style["width"]).toBe("220px");
    expect(h.widthEmits).toEqual([]);
  });

  it("resizes on a boundary drag, coalescing the announcement per frame", () => {
    const h = harness([unitColumn("name", { width: 220 })]);
    h.header.rebuild();
    // The fake DOM reports 400 px wide, which is what `pointerdown` seeds `startWidth` from.
    h.header.onPointerDown({ target: h.handle("name"), clientX: 100, pointerId: 1 });
    h.header.onPointerMove({ clientX: 130 });
    expect(h.cell("name").style["width"]).toBe("430px");
    h.header.onPointerMove({ clientX: 90 });
    expect(h.cell("name").style["width"]).toBe("390px");
    expect(h.widthEmits).toEqual(["throttled", "throttled"]);
  });

  it("clamps a drag at the resize floor", () => {
    const h = harness([unitColumn("name", { width: 220 })]);
    h.header.rebuild();
    h.header.onPointerDown({ target: h.handle("name"), clientX: 500, pointerId: 1 });
    h.header.onPointerMove({ clientX: 0 });
    expect(h.cell("name").style["width"]).toBe("40px");
  });

  it("starts no drag away from a boundary handle", () => {
    const h = harness([unitColumn("name", { width: 220 })]);
    h.header.rebuild();
    h.header.onPointerDown({ target: h.cell("name"), clientX: 100, pointerId: 1 });
    h.header.onPointerMove({ clientX: 400 });
    expect(h.cell("name").style["width"]).toBe("220px");
    expect(h.widthEmits).toEqual([]);
  });

  it("releases the drag so the resize never sticks to the pointer", () => {
    const h = harness([unitColumn("name", { width: 220 })]);
    h.header.rebuild();
    h.header.onPointerDown({ target: h.handle("name"), clientX: 100, pointerId: 1 });
    h.header.onPointerEnd();
    h.header.onPointerMove({ clientX: 400 });
    expect(h.cell("name").style["width"]).toBe("220px");
  });

  it("takes pointer capture where the target offers it, and survives where it throws", () => {
    const h = harness([unitColumn("name", { width: 220 })]);
    h.header.rebuild();
    const captured: number[] = [];
    const handle = h.handle("name") as unknown as Record<string, unknown>;
    handle["setPointerCapture"] = (id: number): void => {
      captured.push(id);
    };
    h.header.onPointerDown({ target: handle, clientX: 0, pointerId: 7 });
    expect(captured).toEqual([7]);
    h.header.onPointerEnd();

    handle["setPointerCapture"] = (): void => {
      throw new Error("pointer already gone");
    };
    expect(() => h.header.onPointerDown({ target: handle, clientX: 0, pointerId: 8 })).not.toThrow();
    h.header.onPointerMove({ clientX: 10 });
    expect(h.cell("name").style["width"]).toBe("410px");
  });
});
