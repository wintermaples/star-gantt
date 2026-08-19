// @vitest-environment happy-dom
/**
 * `internal/cost/panels.ts` — the three cost panels (docs/specs/plugins/tracking.md §2.10 / §2.11 /
 * §2.16), hostless against a real DOM, and then over the wired service.
 *
 * Hostless: each factory takes a mount element and plain callbacks, never a `PluginContext` or a
 * `CostService`, so the table mechanics below are driven through real DOM events with no host at
 * all.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  createBreakdownPanel,
  createCurvePanel,
  createTablePanel,
} from "../src/internal/cost/panels";
import type { TableEdit } from "../src/internal/cost/panels";
import type { BreakdownEntryData, CostCurvePoint, CostFormulaValue, TableRow } from "../src/types";
import { DAY, bootCost, defaultMessages, task } from "./cost-helpers";
import type { CostBoot } from "./cost-helpers";

const MESSAGES = defaultMessages();

let boot: CostBoot | undefined;
afterEach(() => {
  boot?.dispose();
  boot = undefined;
  document.body.innerHTML = "";
});

/* ------------------------------------------------------------------ *
 * Hostless table panel
 * ------------------------------------------------------------------ */

const row = (
  id: string,
  estimated: number,
  actual: number,
  over = false,
  values: TableRow["values"] = {},
): TableRow => ({
  row: { id, name: `Task ${id}`, estimated, actual, variance: actual - estimated, over },
  values,
});

function mountTable(
  rows: readonly TableRow[],
  formulas: readonly CostFormulaValue[] = [],
): {
  root: HTMLElement;
  body: HTMLElement;
  table: HTMLTableElement;
  lines: HTMLTableRowElement[];
  input(rowAt: number, column: 0 | 1 | 2): HTMLInputElement;
  button(label: string): HTMLButtonElement;
  applied: TableEdit[][];
  closedCount(): number;
} {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const applied: TableEdit[][] = [];
  let closed = 0;
  const panel = createTablePanel(host, rows, formulas, MESSAGES, {
    apply: (edits) => void applied.push([...edits]),
    close: () => void (closed += 1),
    amountText: (v) => String(v),
  });
  const root = panel.root;
  const body = root.querySelector<HTMLElement>(".sg-cost-table__body")!;
  const table = body.querySelector("table")!;
  const lines = [...table.querySelectorAll("tr")];
  return {
    root,
    body,
    table,
    lines,
    input: (rowAt, column) =>
      lines[rowAt + 1]!.querySelectorAll("input")[column] as HTMLInputElement,
    button: (label) =>
      [...root.querySelectorAll("button")].find((b) => b.textContent === label)!,
    applied,
    closedCount: () => closed,
  };
}

describe("budget-vs-actual table panel (hostless)", () => {
  it("labels itself, renders rows, totals and the TEXTUAL over-budget flag", () => {
    const p = mountTable([row("a", 100, 130, true), row("b", 50, 0)]);
    expect(p.root.getAttribute("role")).toBe("dialog");
    expect(p.root.getAttribute("aria-label")).toBe("Budget vs actual");
    // The variance cell carries the flag as text, never as color alone.
    expect(p.lines[1]!.children[3]!.textContent).toContain("over budget");
    expect(p.lines[2]!.children[3]!.textContent).not.toContain("over budget");
    const totals = p.lines[3]!;
    expect(totals.children[0]!.textContent).toBe("Total");
    expect(totals.children[1]!.textContent).toBe("150");
    expect(totals.children[2]!.textContent).toBe("130");
    expect(totals.children[3]!.textContent).toBe("-20");
  });

  it("names every header and every editable cell for assistive technology", () => {
    const p = mountTable([row("a", 100, 130)]);
    expect([...p.lines[0]!.querySelectorAll("th")].map((th) => th.textContent)).toEqual([
      "Task",
      "Planned",
      "Actual",
      "Variance",
      "Fixed cost",
      "Material cost",
      "Actual cost",
    ]);
    for (const th of p.lines[0]!.querySelectorAll("th")) {
      expect(th.getAttribute("scope")).toBe("col");
    }
    expect(p.input(0, 0).getAttribute("aria-label")).toBe("Fixed cost — Task a");
    expect(p.input(0, 2).getAttribute("aria-label")).toBe("Actual cost — Task a");
  });

  it("Apply gathers only changed, parsable values; Cancel and Escape apply nothing", () => {
    const p = mountTable([row("a", 0, 0, false, { fixedCost: 10 }), row("b", 0, 0)]);
    expect(p.input(0, 0).value).toBe("10"); // pre-filled from stored values
    p.input(0, 0).value = "25"; // changed fixed
    p.input(0, 2).value = "junk"; // unparsable — ignored
    p.input(1, 1).value = "7"; // new material
    p.input(1, 2).value = "-4"; // negative — ignored
    p.button("Apply").click();
    expect(p.applied).toEqual([[{ id: "a", fixedCost: 25 }, { id: "b", materialCost: 7 }]]);
    expect(p.closedCount()).toBe(1);
    p.button("Cancel").click();
    p.root.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(p.applied).toHaveLength(1);
    expect(p.closedCount()).toBe(3);
  });

  it("re-sending an unchanged value produces no edit at all", () => {
    const p = mountTable([row("a", 0, 0, false, { fixedCost: 10 })]);
    p.button("Apply").click();
    expect(p.applied).toEqual([[]]);
  });

  it("appends one row per custom formula BELOW the totals row, in order", () => {
    const formulas: CostFormulaValue[] = [
      { id: "f1", label: "Cost per task", value: 90, text: "$90" },
      { id: "f2", label: "Over-budget count", value: 1, text: "1" },
    ];
    const p = mountTable([row("a", 100, 130, true)], formulas);
    // Rows: header, one task row, totals row, then one row per formula.
    expect(p.lines).toHaveLength(5);
    expect(p.lines[3]!.children[0]!.textContent).toBe("Cost per task");
    expect(p.lines[3]!.children[1]!.textContent).toBe("$90");
    expect(p.lines[4]!.children[0]!.textContent).toBe("Over-budget count");
    expect(p.lines[4]!.children[1]!.textContent).toBe("1");
  });
});

describe("curve and breakdown panels (hostless)", () => {
  it("the curve draws an accessible per-point list and an image-labelled canvas", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const points: CostCurvePoint[] = [
      { t: 0, planned: 0, actual: 0 },
      { t: DAY, planned: 100, actual: 80, forecast: 80 },
    ];
    const panel = createCurvePanel(host, points, MESSAGES, {
      close: () => undefined,
      pointText: (p) => MESSAGES.costCurvePoint(p),
    });
    const body = panel.root.querySelector<HTMLElement>(".sg-cost-curve__body")!;
    const canvas = body.querySelector("canvas")!;
    expect(canvas.getAttribute("role")).toBe("img");
    expect(canvas.getAttribute("aria-label")).toContain("planned");
    const lines = [...body.querySelectorAll("li")].map((li) => li.textContent ?? "");
    expect(lines).toEqual([
      "1970-01-01 — planned 0, actual 0",
      "1970-01-02 — planned 100, actual 80, forecast 80",
    ]);
  });

  it("the curve shows the empty state with no points", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const panel = createCurvePanel(host, [], MESSAGES, {
      close: () => undefined,
      pointText: () => "",
    });
    const body = panel.root.querySelector<HTMLElement>(".sg-cost-curve__body")!;
    expect(body.textContent).toBe("No cost data");
    expect(body.querySelector("canvas")).toBeNull();
  });

  it("the breakdown prints one labelled bar per NON-ZERO type, text beside the bar", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const entries: BreakdownEntryData[] = [
      { type: "labor", amount: 0, percent: 0 },
      { type: "fixed", amount: 75, percent: 75 },
      { type: "variable", amount: 0, percent: 0 },
      { type: "material", amount: 25, percent: 25 },
    ];
    const panel = createBreakdownPanel(host, entries, MESSAGES, {
      close: () => undefined,
      entryText: (e) => MESSAGES.breakdownEntry(e),
      themeGet: (token) => (token === "--sg-cost-fixed" ? "#123456" : ""),
    });
    const body = panel.root.querySelector<HTMLElement>(".sg-cost-breakdown__body")!;
    const rows = [...body.children];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.querySelector("span")?.textContent)).toEqual([
      "fixed — 75 (75%)",
      "material — 25 (25%)",
    ]);
    // The theme token wins over the fallback; the untokened type keeps its documented default.
    expect(rows[0]!.querySelector("div")?.getAttribute("style")).toContain("background:#123456");
    expect(rows[1]!.querySelector("div")?.getAttribute("style")).toContain("background:#2e7d32");
    // The bar itself is decoration — every fact it encodes is in the text beside it.
    expect(rows[0]!.querySelector("div")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("the breakdown shows the empty state when every type is zero", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const panel = createBreakdownPanel(
      host,
      [{ type: "labor", amount: 0, percent: 0 }],
      MESSAGES,
      { close: () => undefined, entryText: () => "" },
    );
    expect(panel.root.querySelector(".sg-cost-breakdown__body")?.textContent).toBe("No cost data");
  });
});

/* ------------------------------------------------------------------ *
 * The panels over the wired service
 * ------------------------------------------------------------------ */

describe("panels over the wired service (§2.16)", () => {
  const find = (b: CostBoot, cls: string): HTMLElement | null =>
    b.root.querySelector<HTMLElement>(`.${cls}`);

  it("the table panel opens, applies ONE task/update per changed task, and closes", () => {
    const b = (boot = bootCost({ cost: {} }, { view: true }));
    b.data.load([task("a", 0, 10 * DAY), task("b", 0, 5 * DAY)]);
    expect(b.service.openCostTablePanel()).toBe(true);
    const root = find(b, "sg-cost-table");
    expect(root).not.toBeNull();

    const commits: number[] = [];
    b.data.tasks.subscribe(() => commits.push(1));

    const lines = [...root!.querySelectorAll("tr")];
    (lines[1]!.querySelectorAll("input")[0] as HTMLInputElement).value = "100"; // fixed of a
    (lines[2]!.querySelectorAll("input")[2] as HTMLInputElement).value = "40"; // actual of b
    [...root!.querySelectorAll("button")].find((x) => x.textContent === "Apply")!.click();

    expect(find(b, "sg-cost-table")).toBeNull();
    expect(b.service.costValuesOf("a")).toEqual({ fixedCost: 100 });
    expect(b.service.costValuesOf("b")).toEqual({ actualCost: 40 });
    // One transaction per changed task — the undo grain (§2.10).
    expect(commits).toHaveLength(2);
  });

  it("Escape closes the table panel without applying", () => {
    const b = (boot = bootCost({ cost: {} }, { view: true }));
    b.data.load([task("a", 0, 10 * DAY)]);
    b.service.openCostTablePanel();
    find(b, "sg-cost-table")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(find(b, "sg-cost-table")).toBeNull();
    expect(b.service.costValuesOf("a")).toEqual({});
  });

  it("reopening never leaves a second panel behind, and dispose closes the open one", () => {
    const b = (boot = bootCost({ cost: {} }, { view: true }));
    b.data.load([task("a", 0, 10 * DAY)]);
    for (let i = 0; i < 3; i++) {
      b.service.openCostTablePanel();
      expect(b.root.querySelectorAll(".sg-cost-table")).toHaveLength(1);
      find(b, "sg-cost-table")!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      expect(b.root.querySelectorAll(".sg-cost-table")).toHaveLength(0);
    }
    b.service.openCostTablePanel();
    b.dispose();
    boot = undefined;
    expect(b.root.querySelectorAll(".sg-cost-table")).toHaveLength(0);
  });

  it("at most ONE cost panel is open at a time", () => {
    const b = (boot = bootCost({ cost: { statusDate: 5 * DAY } }, { view: true }));
    b.data.load([task("a", 0, 10 * DAY)]);
    b.service.setCostFields("a", { fixedCost: 1000, actualCost: 400 });
    expect(b.service.openCostCurvePanel()).toBe(true);
    const lines = [...find(b, "sg-cost-curve")!.querySelectorAll("li")].map(
      (li) => li.textContent ?? "",
    );
    expect(lines.some((l) => l.includes("planned"))).toBe(true);
    expect(lines.some((l) => l.includes("forecast"))).toBe(true);

    expect(b.service.openBreakdownPanel()).toBe(true);
    expect(find(b, "sg-cost-curve")).toBeNull();
    expect(find(b, "sg-cost-breakdown")).not.toBeNull();
    b.service.closePanels();
    expect(find(b, "sg-cost-breakdown")).toBeNull();
  });

  it("the curve panel shows the empty state without tasks", () => {
    const b = (boot = bootCost({ cost: {} }, { view: true }));
    expect(b.service.openCostCurvePanel()).toBe(true);
    expect(find(b, "sg-cost-curve")!.querySelector(".sg-cost-curve__body")!.textContent).toBe(
      "No cost data",
    );
  });

  it("the breakdown panel prints one labelled bar row per non-zero type", () => {
    const b = (boot = bootCost({ cost: {} }, { view: true }));
    b.data.load([task("a", 0, 10 * DAY)]);
    b.service.setCostFields("a", { fixedCost: 75, materialCost: 25 });
    b.service.openBreakdownPanel();
    const body = find(b, "sg-cost-breakdown")!.querySelector(".sg-cost-breakdown__body")!;
    expect([...body.children].map((r) => r.querySelector("span")?.textContent)).toEqual([
      "fixed — 75 (75%)",
      "material — 25 (25%)",
    ]);
  });

  it("reads theme tokens from a theme service resolved per call", () => {
    const b = (boot = bootCost(
      { cost: {} },
      { view: true, theme: (token) => (token === "--sg-cost-fixed" ? "#123456" : "") },
    ));
    b.data.load([task("a", 0, 10 * DAY)]);
    b.service.setCostFields("a", { fixedCost: 75 });
    b.service.openBreakdownPanel();
    const body = find(b, "sg-cost-breakdown")!.querySelector(".sg-cost-breakdown__body")!;
    expect(body.children[0]!.querySelector("div")?.getAttribute("style")).toContain(
      "background:#123456",
    );
  });

  it("a custom formula reaches the table panel as an extra row", () => {
    const b = (boot = bootCost(
      {
        cost: {
          formulas: [
            { id: "total-actual", label: "Total actual", evaluate: (i) => i.totals.actualCost ?? 0 },
          ],
        },
      },
      { view: true },
    ));
    b.data.load([task("a", 0, 10 * DAY), task("b", 0, 5 * DAY)]);
    b.service.setCostFields("a", { actualCost: 40 });
    b.service.setCostFields("b", { actualCost: 10 });
    b.service.openCostTablePanel();
    const lines = [...find(b, "sg-cost-table")!.querySelectorAll("tr")];
    // header + 2 task rows + totals row + 1 formula row.
    expect(lines).toHaveLength(5);
    expect(lines[4]!.children[0]!.textContent).toBe("Total actual");
    expect(lines[4]!.children[1]!.textContent).toBe("50");
  });

  it("a throwing formula is reported per open and left out of the table (§2.12, unlatched)", () => {
    const b = (boot = bootCost(
      {
        cost: {
          formulas: [
            {
              id: "boom",
              label: "Boom",
              evaluate: () => {
                throw new Error("boom");
              },
            },
          ],
        },
      },
      { view: true },
    ));
    b.data.load([task("a", 0, 10 * DAY)]);
    b.service.openCostTablePanel();
    // header + 1 task row + totals row, no formula row.
    expect([...find(b, "sg-cost-table")!.querySelectorAll("tr")]).toHaveLength(3);
    expect(b.faults.map((f) => f.where)).toEqual(["formulas.boom"]);
    // Unlatched: the next open reports again.
    b.service.openCostTablePanel();
    expect(b.faults.map((f) => f.where)).toEqual(["formulas.boom", "formulas.boom"]);
    expect(b.pluginErrors).toHaveLength(2);
  });
});
