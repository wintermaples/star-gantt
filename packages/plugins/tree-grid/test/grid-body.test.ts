/**
 * `src/internal/grid-body.ts` — the row-virtualized slot pool: which rows materialize, the tree
 * indent geometry, and the selection and focus marks.
 */
import type { TaskId } from "@stargantt/plugin-data-store";
import { describe, expect, it } from "vitest";
import { createColumnTrack } from "../src/internal/column-track";
import type { ColumnTrack } from "../src/internal/column-track";
import { createGridBody } from "../src/internal/grid-body";
import type { GridBody } from "../src/internal/grid-body";
import type { GridTokenCache } from "../src/internal/tokens";
import { markWbsColumn } from "../src/internal/tree-column";
import { task } from "./_data";
import { asElement } from "./_harness/index";
import type { FakeElement } from "./_harness/index";
import { flatRows, unitColumn, unitModel } from "./_units";
import { asDoc, unitDoc } from "./_units-dom";

const ROW_H = 28;

/** A token cache double with the stylesheet's own default values. */
function tokens(toggleWidth = 24, cellPadding = 8): GridTokenCache {
  return { get: () => ({ toggleWidth, cellPadding }), invalidate: () => {} };
}

interface Harness {
  body: GridBody;
  track: ColumnTrack;
  element: FakeElement;
  /** The materialized (not display:none) row elements, in pool order. */
  rows(): FakeElement[];
  faults: unknown[];
  /** The one cell the paint pass must leave untouched, standing in for an open editor. */
  retain: { id: TaskId | undefined; cell: HTMLElement | undefined };
}

function harness(
  options: {
    tasks?: readonly ReturnType<typeof task>[];
    columns?: ReturnType<typeof unitColumn>[];
    indent?: number;
    viewportHeight?: number;
    /** Ids a `rows/height` contribution reduces to 0. */
    hiddenIds?: readonly TaskId[];
    /** `collapsedBadge`'s text hook (see § Extension points, "Collapsed-branch badge"). */
    rowBadge?: (row: number, id: TaskId) => string | undefined;
  } = {},
): Harness {
  const doc = unitDoc(400, options.viewportHeight ?? 300);
  const faults: unknown[] = [];
  const retain: { id: TaskId | undefined; cell: HTMLElement | undefined } = {
    id: undefined,
    cell: undefined,
  };
  const track = createColumnTrack(() => options.columns ?? [unitColumn("name", { width: 220 })]);
  track.refresh();
  const body = createGridBody({
    doc: asDoc(doc),
    track,
    tokens: tokens(),
    model: unitModel(options.tasks ?? flatRows(50), options.hiddenIds ?? []),
    indent: options.indent ?? 16,
    retainsEditor: (id, cell) => retain.cell !== undefined && retain.id === id && retain.cell === cell,
    fault: (error) => faults.push(error),
    rowBadge: options.rowBadge,
  });
  const element = body.element as unknown as FakeElement;
  return {
    body,
    track,
    element,
    rows: () => element.findAll("sg-grid-row").filter((r) => r.style["display"] !== "none"),
    faults,
    retain,
  };
}

describe("createGridBody — virtualization", () => {
  it("materializes only the rows intersecting the viewport", () => {
    const h = harness();
    h.body.paint(0);
    const rows = h.rows();
    expect(rows.length).toBe(Math.ceil(300 / ROW_H));
    expect(rows[0]?.getAttribute("data-row-index")).toBe("0");
    expect(rows[0]?.style["transform"]).toBe("translateY(0px)");
    expect(rows[1]?.style["transform"]).toBe("translateY(28px)");
    expect(rows[0]?.style["height"]).toBe("28px");
  });

  it("re-uses one slot per screen position as the offset moves", () => {
    const h = harness();
    h.body.paint(0);
    const first = h.rows()[0];
    h.body.paint(100);
    expect(h.rows()[0]).toBe(first);
    expect(first?.getAttribute("data-row-index")).toBe("3");
    expect(first?.style["transform"]).toBe("translateY(-16px)");
  });

  it("hides the slots a later pass does not need, clearing their row index", () => {
    const h = harness({ tasks: flatRows(50) });
    h.body.paint(0);
    const pooled = h.element.findAll("sg-grid-row").length;
    expect(pooled).toBe(Math.ceil(300 / ROW_H));

    // The last row is 36 px from the bottom of a 300 px viewport, so one fewer slot is needed.
    h.body.paint(50 * ROW_H - 36);
    expect(h.element.findAll("sg-grid-row").length).toBe(pooled);
    const hidden = h.element.findAll("sg-grid-row").filter((r) => r.style["display"] === "none");
    expect(hidden.length).toBeGreaterThan(0);
    for (const row of hidden) expect(row.getAttribute("data-row-index")).toBe("");
  });

  // docs/specs/plugins/tree-grid.md § Extension points. A grid row does not clip its cells, so a
  // zero-height slot printed its full text over the row that followed it: filtering used to stack
  // every hidden label on the one surviving row. The fix is to give such a row no slot at all.
  it("skips a row a rows/height contribution reduced to 0, and closes the gap it left", () => {
    const h = harness({ tasks: flatRows(6), hiddenIds: ["t1" as TaskId, "t2" as TaskId] });
    h.body.paint(0);
    const rows = h.rows();
    expect(rows.map((r) => r.getAttribute("data-row-index"))).toEqual(["0", "3", "4", "5"]);
    for (const row of rows) expect(row.style["height"]).toBe("28px");
    // t0 keeps the top of the pane and t3 sits directly under it — the hidden rows occupy nothing.
    expect(rows[0]?.style["transform"]).toBe("translateY(0px)");
    expect(rows[1]?.style["transform"]).toBe("translateY(28px)");
  });

  it("paints nothing when every row is reduced to height 0", () => {
    const ids = ["t0", "t1", "t2"].map((id) => id as TaskId);
    const h = harness({ tasks: flatRows(3), hiddenIds: ids });
    h.body.paint(0);
    expect(h.rows()).toEqual([]);
  });

  it("paints nothing for an empty row set", () => {
    const h = harness({ tasks: [] });
    h.body.paint(0);
    expect(h.rows()).toEqual([]);
  });

  it("paints nothing while the body has no laid-out height", () => {
    const h = harness({ viewportHeight: 0 });
    h.body.paint(0);
    expect(h.rows()).toEqual([]);
    expect(h.body.viewportHeight()).toBe(0);
  });

  it("discards the pool on `resetSlots`, as a new column count requires", () => {
    const h = harness();
    h.body.paint(0);
    expect(h.element.children.length).toBeGreaterThan(0);
    h.body.resetSlots();
    expect(h.element.children).toEqual([]);
  });

  it("exposes the cells of a materialized row only", () => {
    const h = harness();
    h.body.paint(0);
    expect(h.body.cellsOf(0)?.length).toBe(1);
    expect(h.body.cellsOf(900)).toBeUndefined();
  });
});

describe("createGridBody — cells", () => {
  it("renders each column into its cell", () => {
    const h = harness({
      tasks: [task("a", null, "Alpha")],
      columns: [unitColumn("name", { width: 220 }), unitColumn("copy", { width: 90 })],
    });
    h.body.paint(0);
    const cells = h.rows()[0]?.findAll("sg-grid-cell") ?? [];
    expect(cells.map((c) => c.textContent)).toEqual(["Alpha", "Alpha"]);
  });

  // docs/specs/plugins/tree-grid.md § Extension points, "Column identification in the DOM" —
  // mirrors the header cell's own `data-column-id` so a host's test can address a column by id, not
  // position.
  it("carries `data-column-id` matching each column's own id", () => {
    const h = harness({
      tasks: [task("a", null, "Alpha")],
      columns: [unitColumn("name", { width: 220 }), unitColumn("copy", { width: 90 })],
    });
    h.body.paint(0);
    const cells = h.rows()[0]?.findAll("sg-grid-cell") ?? [];
    expect(cells.map((c) => c.getAttribute("data-column-id"))).toEqual(["name", "copy"]);
  });

  it("reports a throwing `render` instead of letting it kill the pane", () => {
    const boom = new Error("bad column");
    const h = harness({
      tasks: flatRows(2),
      columns: [
        unitColumn("bad", {
          width: 100,
          render: () => {
            throw boom;
          },
        }),
      ],
    });
    h.body.paint(0);
    expect(h.faults).toContain(boom);
    expect(h.rows().length).toBe(2);
  });

  it("leaves a cell hosting an open editor completely untouched", () => {
    const h = harness({ tasks: [task("a", null, "Alpha")] });
    h.body.paint(0);
    const cell = h.body.cellsOf(0)?.[0];
    expect(cell).toBeDefined();
    const marker = (cell as unknown as FakeElement).ownerDocument.createElement("div");
    (cell as unknown as FakeElement).textContent = "";
    (cell as unknown as FakeElement).appendChild(marker);
    h.retain.id = "a";
    h.retain.cell = cell;

    h.body.paint(0);
    expect((cell as unknown as FakeElement).children).toContain(marker);
  });
});

describe("createGridBody — tree indentation", () => {
  const tree = [task("root", null), task("child", "root"), task("grand", "child")];

  it("widens the toggle gutter with depth and shrinks the first cell by the same amount", () => {
    const h = harness({ tasks: tree });
    h.body.paint(0);
    const rows = h.rows();
    expect(rows.map((r) => r.find("sg-grid-toggle")?.style["width"])).toEqual([
      "24px",
      "40px",
      "56px",
    ]);
    expect(rows.map((r) => r.findAll("sg-grid-cell")[0]?.style["width"])).toEqual([
      "220px",
      "204px",
      "188px",
    ]);
  });

  it("reserves the gutter on a leaf row and marks a branch with its glyph", () => {
    const h = harness({ tasks: tree });
    h.body.paint(0);
    const toggles = h.rows().map((r) => r.find("sg-grid-toggle"));
    expect(toggles[0]?.textContent).toBe("▾");
    expect(toggles[0]?.style["visibility"]).toBe("");
    expect(toggles[2]?.textContent).toBe("");
    expect(toggles[2]?.style["visibility"]).toBe("hidden");
    expect(toggles[2]?.style["width"]).toBe("56px");
  });

  // docs/specs/plugins/tree-grid.md § Config, "Header parity and the usable minimum" — the inset
  // saturates instead of the cell shrinking past its usable content box, and the gutter saturates
  // with it so the row never outgrows its header.
  it("saturates the inset on a deep tree, gutter and cell together", () => {
    const deep = [task("d0", null)];
    for (let i = 1; i < 30; i += 1) deep.push(task(`d${i}`, `d${i - 1}`));
    const h = harness({ tasks: deep });
    // Scroll deep enough that 220 - depth x 16 would go non-positive without the saturation.
    h.body.paint(18 * ROW_H);
    const rows = h.rows();
    const widths = rows.map((r) => r.findAll("sg-grid-cell")[0]?.style["width"]);
    // The floor is 24 px of content box net of 2 x 8 px padding: a 40 px border box.
    expect(widths.every((w) => Number.parseFloat(w ?? "0") >= 40)).toBe(true);
    expect(widths[widths.length - 1]).toBe("40px");
    // 220 - 40 = 180 px of inset is all the column affords, so the gutter stops there too and
    // gutter + cell stays 24 + 220 at every depth.
    const toggles = rows.map((r) => r.find("sg-grid-toggle")?.style["width"]);
    expect(toggles[toggles.length - 1]).toBe("204px");
    for (let i = 0; i < rows.length; i += 1) {
      expect(Number.parseFloat(toggles[i] ?? "0") + Number.parseFloat(widths[i] ?? "0")).toBe(244);
    }
  });

  it("insets the content instead when the header has not been laid out (variant A)", () => {
    // No declared width and no registered header cell: nothing to shrink, so the padding moves.
    const h = harness({ tasks: [task("root", null), task("child", "root")], columns: [unitColumn("name")] });
    h.body.paint(0);
    const cells = h.rows().map((r) => r.findAll("sg-grid-cell")[0]);
    expect(cells.map((c) => c?.style["paddingLeft"])).toEqual(["8px", "24px"]);
    expect(cells.map((c) => c?.style["width"])).toEqual(["", ""]);
  });

  it("compensates off the measured header width once the header is laid out", () => {
    const doc = unitDoc();
    const h = harness({ tasks: [task("root", null), task("child", "root")], columns: [unitColumn("name")] });
    const headerCell = doc.createElement("div");
    headerCell.rect = { left: 0, top: 0, width: 150, height: 24 };
    h.track.setHeaderCell("name", asElement(headerCell));
    h.body.paint(0);
    expect(h.rows().map((r) => r.findAll("sg-grid-cell")[0]?.style["width"])).toEqual([
      "150px",
      "134px",
    ]);
  });

  it("does not indent at all with `indent: 0`", () => {
    const h = harness({ tasks: tree, indent: 0 });
    h.body.paint(0);
    expect(h.rows().map((r) => r.find("sg-grid-toggle")?.style["width"])).toEqual([
      "24px",
      "24px",
      "24px",
    ]);
  });
});

// docs/specs/plugins/tree-grid.md § Extension points, "Tree indentation" — the gutter belongs to
// the TREE column, which with `wbs` on is the column after the numbering one.
describe("createGridBody — the tree column with a WBS column present", () => {
  const tree = [task("root", null), task("child", "root")];
  const withWbs = (): ReturnType<typeof unitColumn>[] => [
    markWbsColumn(unitColumn("wbs", { width: 70 })),
    unitColumn("name", { width: 220 }),
  ];

  it("lays the gutter out between the numbering column and the tree column", () => {
    const h = harness({ tasks: tree, columns: withWbs() });
    h.body.paint(0);
    for (const row of h.rows()) {
      expect(row.children.map((c) => c.className)).toEqual([
        "sg-grid-cell",
        "sg-grid-toggle",
        "sg-grid-cell",
      ]);
      expect(row.children[0]?.getAttribute("data-column-id")).toBe("wbs");
    }
  });

  it("charges the depth inset to the tree column, never to the numbering column", () => {
    const h = harness({ tasks: tree, columns: withWbs() });
    h.body.paint(0);
    const rows = h.rows();
    // The numbering column keeps its full 70 px at every depth — it never shrinks.
    expect(rows.map((r) => r.findAll("sg-grid-cell")[0]?.style["width"])).toEqual(["70px", "70px"]);
    expect(rows.map((r) => r.findAll("sg-grid-cell")[1]?.style["width"])).toEqual([
      "220px",
      "204px",
    ]);
    expect(rows.map((r) => r.find("sg-grid-toggle")?.style["width"])).toEqual(["24px", "40px"]);
  });

  it("hangs the collapsed-branch badge off the tree column's cell", () => {
    const h = harness({
      tasks: tree,
      columns: withWbs(),
      rowBadge: (row) => (row === 0 ? "(1)" : undefined),
    });
    h.body.paint(0);
    const cells = h.rows()[0]?.findAll("sg-grid-cell") ?? [];
    expect(cells[0]?.find("sg-grid-badge")).toBeUndefined();
    expect(cells[1]?.find("sg-grid-badge")?.textContent).toBe("(1)");
  });

  it("is the WBS column itself when that is the only column displayed", () => {
    const h = harness({ tasks: tree, columns: [markWbsColumn(unitColumn("wbs", { width: 70 }))] });
    h.body.paint(0);
    const rows = h.rows();
    expect(rows[0]?.children.map((c) => c.className)).toEqual(["sg-grid-toggle", "sg-grid-cell"]);
    // 70 - 40 = 30 px of room, so depth 2 would saturate; depth 1 still fits its 16 px.
    expect(rows.map((r) => r.findAll("sg-grid-cell")[0]?.style["width"])).toEqual(["70px", "54px"]);
  });

  it("builds no gutter at all when no column is displayed", () => {
    const h = harness({ tasks: tree, columns: [] });
    h.body.paint(0);
    for (const row of h.rows()) expect(row.children).toEqual([]);
  });
});

// docs/specs/plugins/tree-grid.md § Extension points — the grid pane's half of the alternating row
// background. The chart pane's `grid-lines` stripe derives its parity from the same logical row
// index, so these two must agree row for row or the split-pane reading breaks.
describe("createGridBody — alternating row background", () => {
  it("marks odd rows by their own index", () => {
    const h = harness({ tasks: flatRows(4) });
    h.body.paint(0);
    expect(h.rows().map((r) => r.classList.contains("sg-grid-row--odd"))).toEqual([
      false,
      true,
      false,
      true,
    ]);
  });

  // The regression this guards: slots are recycled as the viewport scrolls, so a stripe set once
  // at slot creation would follow the slot rather than the row, and the whole pattern would flip
  // whenever the first visible row changed parity.
  it("keeps parity with the row, not the recycled slot, after scrolling", () => {
    const h = harness({ tasks: flatRows(20) });
    h.body.paint(0);
    const before = h.rows().map((r) => [r.getAttribute("data-row-index"), r.classList.contains("sg-grid-row--odd")]);
    for (const [index, odd] of before) expect(odd).toBe(Number(index) % 2 === 1);

    h.body.paint(ROW_H * 3);
    for (const r of h.rows()) {
      const index = Number(r.getAttribute("data-row-index"));
      expect(r.classList.contains("sg-grid-row--odd")).toBe(index % 2 === 1);
    }
  });
});

describe("createGridBody — reflected selection and focus", () => {
  it("marks the reflected selection as rows materialize, and unmarks on replacement", () => {
    const h = harness({ tasks: flatRows(4) });
    h.body.setSelected(new Set<TaskId>(["t1", "t2"]));
    h.body.paint(0);
    expect(h.rows().map((r) => r.classList.contains("sg-grid-row--selected"))).toEqual([
      false,
      true,
      true,
      false,
    ]);

    h.body.setSelected(new Set());
    h.body.paint(0);
    expect(h.rows().every((r) => !r.classList.contains("sg-grid-row--selected"))).toBe(true);
  });

  it("marks exactly the focused row, and clears it for `undefined`", () => {
    const h = harness({ tasks: flatRows(4) });
    h.body.setFocused("t2");
    h.body.paint(0);
    expect(h.rows().map((r) => r.classList.contains("sg-grid-row--focused"))).toEqual([
      false,
      false,
      true,
      false,
    ]);

    h.body.setFocused(undefined);
    h.body.paint(0);
    expect(h.rows().every((r) => !r.classList.contains("sg-grid-row--focused"))).toBe(true);
  });

  // docs/specs/plugins/tree-grid.md § Extension points — reflection is in place: the marks move on
  // the rows already materialized, with no paint pass in between.
  it("marks and unmarks materialized rows in place, with no repaint", () => {
    const h = harness({ tasks: flatRows(4) });
    h.body.paint(0);

    h.body.setSelected(new Set<TaskId>(["t1", "t2"]));
    expect(h.rows().map((r) => r.classList.contains("sg-grid-row--selected"))).toEqual([
      false,
      true,
      true,
      false,
    ]);

    h.body.setSelected(new Set<TaskId>(["t0"]));
    expect(h.rows().map((r) => r.classList.contains("sg-grid-row--selected"))).toEqual([
      true,
      false,
      false,
      false,
    ]);

    h.body.setFocused("t3");
    expect(h.rows().map((r) => r.classList.contains("sg-grid-row--focused"))).toEqual([
      false,
      false,
      false,
      true,
    ]);

    h.body.setFocused(undefined);
    expect(h.rows().every((r) => !r.classList.contains("sg-grid-row--focused"))).toBe(true);
  });

  /**
   * A paint pass wipes each cell (`textContent = ""`) and re-runs the column's `render`, so a cell
   * child materialized before a reflection call must still be the same node, in the same cell,
   * after it. Losing that identity between `mousedown` and `mouseup` is what killed the `click` on
   * an interactive child of a contributed cell — the selection owner reflects on `pointerdown`,
   * mid-gesture.
   */
  it("leaves cell children and their DOM identity untouched", () => {
    let renders = 0;
    const h = harness({
      tasks: flatRows(3),
      columns: [
        unitColumn("action", {
          width: 220,
          render: (el, t) => {
            renders += 1;
            const button = el.ownerDocument.createElement("button");
            button.className = "unit-open";
            button.textContent = t.name;
            el.appendChild(button);
          },
        }),
      ],
    });
    h.body.paint(0);
    const painted = renders;
    const cell = h.rows()[1]?.findAll("sg-grid-cell")[0];
    const button = cell?.find("unit-open");
    expect(button).toBeDefined();

    h.body.setSelected(new Set<TaskId>(["t1"]));
    h.body.setFocused("t1");

    expect(renders).toBe(painted);
    expect(cell?.find("unit-open")).toBe(button);
    expect(button?.parentNode).toBe(cell);
    expect(h.rows()[1]?.classList.contains("sg-grid-row--selected")).toBe(true);
  });

  it("marks a row that materializes after the call, including one scrolled into view", () => {
    const h = harness({ tasks: flatRows(50) });
    h.body.paint(0);
    h.body.setSelected(new Set<TaskId>(["t40"]));
    h.body.setFocused("t40");
    // Off-screen at scrollTop 0 (300px viewport, 28px rows), so nothing is marked yet.
    expect(h.rows().some((r) => r.classList.contains("sg-grid-row--selected"))).toBe(false);

    h.body.paint(40 * ROW_H);
    const row = h.rows().find((r) => r.getAttribute("data-row-index") === "40");
    expect(row?.classList.contains("sg-grid-row--selected")).toBe(true);
    expect(row?.classList.contains("sg-grid-row--focused")).toBe(true);
  });
});

describe("createGridBody — applyColumnWidth", () => {
  it("resizes every materialized cell of a later column verbatim", () => {
    const h = harness({
      tasks: flatRows(3),
      columns: [unitColumn("name", { width: 220 }), unitColumn("end", { width: 110 })],
    });
    h.body.paint(0);
    h.body.applyColumnWidth(1, 175);
    expect(h.rows().map((r) => r.findAll("sg-grid-cell")[1]?.style["width"])).toEqual([
      "175px",
      "175px",
      "175px",
    ]);
  });

  it("re-applies the per-row indent compensation when the tree column is resized", () => {
    const h = harness({ tasks: [task("root", null), task("child", "root")] });
    h.body.paint(0);
    h.body.applyColumnWidth(0, 200);
    expect(h.rows().map((r) => r.findAll("sg-grid-cell")[0]?.style["width"])).toEqual([
      "200px",
      "184px",
    ]);
  });

  // A resize that pushes the column to its floor must saturate the gutter with it, or the row
  // would keep the wider gutter and outgrow its own header.
  it("shrinks the gutter with the cell when a resize saturates the inset", () => {
    const deep = [task("d0", null), task("d1", "d0"), task("d2", "d1")];
    const h = harness({ tasks: deep });
    h.body.paint(0);
    h.body.applyColumnWidth(0, 56);
    const rows = h.rows();
    // 56 - 40 = 16 px of inset is all the column affords: depth 1 fits it, depth 2 saturates.
    expect(rows.map((r) => r.findAll("sg-grid-cell")[0]?.style["width"])).toEqual([
      "56px",
      "40px",
      "40px",
    ]);
    expect(rows.map((r) => r.find("sg-grid-toggle")?.style["width"])).toEqual([
      "24px",
      "40px",
      "40px",
    ]);
  });

  // The tree column is not always index 0: a resize of the numbering column before it is a plain
  // width write, and a resize of the tree column keeps its compensation.
  it("targets the tree column's compensation by index, not by position 0", () => {
    const h = harness({
      tasks: [task("root", null), task("child", "root")],
      columns: [markWbsColumn(unitColumn("wbs", { width: 70 })), unitColumn("name", { width: 220 })],
    });
    h.body.paint(0);
    h.body.applyColumnWidth(0, 90);
    expect(h.rows().map((r) => r.findAll("sg-grid-cell")[0]?.style["width"])).toEqual([
      "90px",
      "90px",
    ]);
    h.body.applyColumnWidth(1, 200);
    expect(h.rows().map((r) => r.findAll("sg-grid-cell")[1]?.style["width"])).toEqual([
      "200px",
      "184px",
    ]);
  });

  it("ignores a column index the pool has no cell for", () => {
    const h = harness({ tasks: flatRows(2) });
    h.body.paint(0);
    expect(() => h.body.applyColumnWidth(9, 100)).not.toThrow();
  });
});
