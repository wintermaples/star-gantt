// @vitest-environment happy-dom
/**
 * `internal/assign/cell.ts` — the "Resources" grid-column cell (docs/specs/plugins/resource.md
 * §3.3), hostless against a real DOM: the open button is the first, unclippable child,
 * one chip per assignment follows in store order, and the cell's `title` matches `getValue`'s text.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cellText, renderResourcesCell } from "../src/internal/assign/cell";
import type { CellDeps } from "../src/internal/assign/cell";

afterEach(() => {
  document.body.innerHTML = "";
});

function deps(over: Partial<CellDeps> = {}): CellDeps {
  return {
    assignmentsOf: () => [
      { resourceId: "r1", units: 1 },
      { resourceId: "r2", units: 0.5 },
    ],
    nameOf: (id) => (id === "r1" ? "Ana" : "Bo"),
    chipText: (name, unitsPercent) => (unitsPercent === 100 ? name : `${name} ${String(unitsPercent)}%`),
    openLabel: "Edit resource assignments",
    draggable: true,
    ...over,
  };
}

describe("renderResourcesCell", () => {
  it("renders the open button first, flex:none, with a >=24x24 hit area and an accessible label", () => {
    const el = document.createElement("div");
    renderResourcesCell(el, "t1", deps());
    const open = el.firstElementChild as HTMLButtonElement;
    expect(open.className).toBe("sg-ra-open");
    expect(open.getAttribute("type")).toBe("button");
    expect(open.getAttribute("data-sg-ra-open")).toBe("t1");
    expect(open.getAttribute("aria-label")).toBe("Edit resource assignments");
    expect(open.style.minWidth).toBe("24px");
    expect(open.style.minHeight).toBe("24px");
    // happy-dom expands the `flex` shorthand into its longhands on read-back.
    expect(open.style.flexGrow).toBe("0");
    expect(open.style.flexShrink).toBe("0");
  });

  it("renders one chip per assignment, in store order, after the open button", () => {
    const el = document.createElement("div");
    renderResourcesCell(el, "t1", deps());
    const chips = [...el.querySelectorAll(".sg-ra-chip")];
    expect(chips).toHaveLength(2);
    expect(chips[0]?.textContent).toBe("Ana"); // 100% -> name alone
    expect(chips[1]?.textContent).toBe("Bo 50%");
    expect(chips[0]?.getAttribute("data-sg-ra-task")).toBe("t1");
    expect(chips[0]?.getAttribute("data-sg-ra-res")).toBe("r1");
  });

  it("makes chips draggable only when the deps say so, and sets a grab cursor when draggable", () => {
    const el = document.createElement("div");
    renderResourcesCell(el, "t1", deps({ draggable: true }));
    const chip = el.querySelector(".sg-ra-chip") as HTMLElement;
    expect(chip.getAttribute("draggable")).toBe("true");
    expect(chip.style.cursor).toBe("grab");

    const el2 = document.createElement("div");
    renderResourcesCell(el2, "t1", deps({ draggable: false }));
    const chip2 = el2.querySelector(".sg-ra-chip") as HTMLElement;
    expect(chip2.getAttribute("draggable")).toBeNull();
    expect(chip2.style.cursor).toBe("default");
  });

  it("sets the cell's title to the same comma-joined text getValue/cellText produces", () => {
    const el = document.createElement("div");
    const d = deps();
    renderResourcesCell(el, "t1", d);
    expect(el.getAttribute("title")).toBe(cellText("t1", d));
    expect(cellText("t1", d)).toBe("Ana, Bo 50%");
  });

  it("re-renders cleanly into a reused cell element (virtualized row recycling)", () => {
    const el = document.createElement("div");
    renderResourcesCell(el, "t1", deps());
    expect(el.querySelectorAll(".sg-ra-chip")).toHaveLength(2);
    renderResourcesCell(el, "t2", deps({ assignmentsOf: () => [] }));
    expect(el.querySelectorAll(".sg-ra-chip")).toHaveLength(0);
    expect(el.getAttribute("data-sg-ra-cell")).toBe("t2");
    expect(el.querySelector(".sg-ra-open")?.getAttribute("data-sg-ra-open")).toBe("t2");
  });

  it("renders an empty cell (just the open button) for a task with no assignments", () => {
    const el = document.createElement("div");
    renderResourcesCell(el, "t1", deps({ assignmentsOf: () => [] }));
    expect(el.children).toHaveLength(1);
    expect(el.getAttribute("title")).toBe("");
  });
});
