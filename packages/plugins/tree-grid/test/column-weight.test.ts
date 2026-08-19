/**
 * Display order of the composed `grid/columns` collection: the weight sort.
 *
 * docs/specs/plugins/tree-grid.md § Extension points — `ColumnDef.weight` and "display order is
 * weight-sorted".
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Task } from "@stargantt/plugin-data-store";
import {
  DEFAULT_COLUMN_WEIGHT,
  sortColumnsByWeight,
  weightSortedReader,
} from "../src/internal/column-order";
import type { ColumnDef } from "../src/types";
import { boot, flatTasks, probe } from "./_boot";
import type { Booted } from "./_boot";

let booted: Booted | undefined;

afterEach(() => {
  booted?.gantt.dispose();
  booted?.dom.restore();
  booted = undefined;
});

/** A minimal usable column whose cells print its id. */
function column(id: string, weight?: number): ColumnDef {
  const def: ColumnDef = {
    id,
    header: id,
    render(el: HTMLElement, task: Readonly<Task>): void {
      el.textContent = `${id}:${task.id}`;
    },
    getValue: (task: Readonly<Task>) => task.id,
  };
  return weight === undefined ? def : { ...def, weight };
}

function headerLabels(b: Booted): (string | undefined)[] {
  return b.header.findAll("sg-grid-cell sg-grid-header-cell").map((c) => c.textContent);
}

/** Boots with contributors registered in the given tier and paints one frame. */
function withColumns(
  contributors: { id: string; dependsOn: string[]; columns: ColumnDef[] }[],
  config?: Parameters<typeof boot>[2],
): Booted {
  const b = boot(
    contributors.map((c) =>
      probe(
        (ctx) => {
          for (const def of c.columns) ctx.contribute("grid/columns", def);
        },
        c.id,
        c.dependsOn,
      ),
    ),
    {},
    config,
  );
  booted = b;
  b.data.load(flatTasks(2));
  b.dom.flushFrames();
  return b;
}

/* ------------------------------------------------------------------ *
 * Pure unit: sortColumnsByWeight
 * ------------------------------------------------------------------ */

describe("sortColumnsByWeight", () => {
  it("treats an omitted weight as 100, behind the built-ins' 0", () => {
    expect(DEFAULT_COLUMN_WEIGHT).toBe(100);
    const sorted = sortColumnsByWeight([column("late"), column("early", 0)]);
    expect(sorted.map((c) => c.id)).toEqual(["early", "late"]);
  });

  it("sorts ascending by explicit weight", () => {
    const sorted = sortColumnsByWeight([column("c", 10), column("a", -5), column("b", 0)]);
    expect(sorted.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps contribution order for ties", () => {
    const sorted = sortColumnsByWeight([
      column("z", 50),
      column("a", 0),
      column("y", 50),
      column("x", 50),
    ]);
    expect(sorted.map((c) => c.id)).toEqual(["a", "z", "y", "x"]);
  });

  it("treats a non-finite weight as omitted", () => {
    const sorted = sortColumnsByWeight([column("nan", Number.NaN), column("zero", 0)]);
    expect(sorted.map((c) => c.id)).toEqual(["zero", "nan"]);
  });

  it("returns an already-ordered list unchanged, same array identity", () => {
    const input = [column("a", 0), column("b", 0), column("c")];
    expect(sortColumnsByWeight(input)).toBe(input);
  });
});

describe("weightSortedReader", () => {
  it("memoizes on the input array's identity", () => {
    const input = [column("late"), column("early", 0)];
    let reads = 0;
    const read = weightSortedReader(() => {
      reads += 1;
      return input;
    });
    const first = read();
    expect(first.map((c) => c.id)).toEqual(["early", "late"]);
    expect(read()).toBe(first);
    expect(reads).toBe(2);
  });

  it("re-sorts when the input array identity changes", () => {
    let input = [column("a", 0)];
    const read = weightSortedReader(() => input);
    expect(read().map((c) => c.id)).toEqual(["a"]);
    input = [column("z"), column("a", 0)];
    expect(read().map((c) => c.id)).toEqual(["a", "z"]);
  });
});

/* ------------------------------------------------------------------ *
 * Composed grid
 * ------------------------------------------------------------------ */

describe("grid/columns display order", () => {
  it("puts an earlier-tier contributor's column right of the built-ins", () => {
    // A data-store-only contributor starts before the tree-grid, so its column is collected first.
    const b = withColumns([
      { id: "test.early", dependsOn: ["stargantt.data-store"], columns: [column("extra")] },
    ]);
    expect(headerLabels(b)).toEqual(["Name", "Start", "End", "Progress", "extra"]);
    // The cells follow the headers: the row leads with the task name, not the contributed column.
    const cells = b.visibleRows()[0]!.findAll("sg-grid-cell").map((c) => c.textContent);
    expect(cells[0]).toBe("t0");
    expect(cells[cells.length - 1]).toBe("extra:t0");
  });

  it("honors an explicit weight left of the built-ins", () => {
    const b = withColumns([
      { id: "test.early", dependsOn: ["stargantt.data-store"], columns: [column("lead", -1)] },
    ]);
    expect(headerLabels(b)).toEqual(["lead", "Name", "Start", "End", "Progress"]);
  });

  it("orders explicit weights across tiers and keeps ties in contribution order", () => {
    const b = withColumns([
      {
        id: "test.early",
        dependsOn: ["stargantt.data-store"],
        columns: [column("e1", 50), column("e2", 50)],
      },
      {
        id: "test.late",
        dependsOn: ["stargantt.tree-grid"],
        columns: [column("l1", 50), column("l0", 10)],
      },
    ]);
    expect(headerLabels(b)).toEqual([
      "Name",
      "Start",
      "End",
      "Progress",
      "l0",
      "e1",
      "e2",
      "l1",
    ]);
  });

  it("gives treeGrid.columns replacement entries the built-ins' weight", () => {
    const b = withColumns(
      [{ id: "test.early", dependsOn: ["stargantt.data-store"], columns: [column("extra")] }],
      { columns: [column("own1"), column("own2")] },
    );
    expect(headerLabels(b)).toEqual(["own1", "own2", "extra"]);
  });

  it("lets a replacement entry set its own weight", () => {
    const b = withColumns(
      [{ id: "test.early", dependsOn: ["stargantt.data-store"], columns: [column("extra")] }],
      { columns: [column("tail", 200), column("head")] },
    );
    expect(headerLabels(b)).toEqual(["head", "extra", "tail"]);
  });

  it("keeps the WBS column ahead of the other built-ins", () => {
    const b = withColumns(
      [{ id: "test.early", dependsOn: ["stargantt.data-store"], columns: [column("extra")] }],
      { wbs: true },
    );
    expect(headerLabels(b)).toEqual(["WBS", "Name", "Start", "End", "Progress", "extra"]);
  });
});
