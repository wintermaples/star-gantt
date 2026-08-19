// @vitest-environment happy-dom
/**
 * The `cost.renderPanel` body seam (docs/specs/plugins/tracking.md §2.13).
 *
 * The plugin builds the chrome and hands the seam an EMPTY scrolling body; the seam is called on
 * every open with `panel` / `model` / `close()`; returning empty is not a fallback signal; and a
 * throw is the LATCHED barrier — reported once as `where: "renderPanel"`, the body emptied and
 * rendered built-in, and the seam never called again for the instance's life, across ALL THREE cost
 * panels as one unit.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  createBreakdownPanel,
  createCurvePanel,
  createTablePanel,
} from "../src/internal/cost/panels";
import type { CostPanelSeam } from "../src/internal/cost/panels";
import type {
  BreakdownEntryData,
  CostCurvePoint,
  CostFormulaValue,
  CostPanelRenderContext,
  TableRow,
} from "../src/types";
import { DAY, bootCost, defaultMessages, task } from "./cost-helpers";
import type { CostBoot } from "./cost-helpers";

const MESSAGES = defaultMessages();

let boot: CostBoot | undefined;
afterEach(() => {
  boot?.dispose();
  boot = undefined;
  document.body.innerHTML = "";
});

function mountHost(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return host;
}

/** Wraps a raw host renderer as the module-level seam the panels take (no latch — see below). */
function seamOf(fn: (host: HTMLElement, ctx: CostPanelRenderContext) => void): CostPanelSeam {
  return (host, ctx) => {
    try {
      fn(host, ctx);
      return true;
    } catch {
      return false;
    }
  };
}

const ROW: TableRow = {
  row: { id: "a", name: "Task a", estimated: 10, actual: 5, variance: -5, over: false },
  values: {},
};

describe("the seam receives the right context per panel (hostless)", () => {
  it("table: panel 'table' and the rows/formulas model; the built-in table does not run", () => {
    const seen: CostPanelRenderContext[] = [];
    const formulas: CostFormulaValue[] = [{ id: "f", label: "F", value: 1, text: "1" }];
    const panel = createTablePanel(mountHost(), [ROW], formulas, MESSAGES, {
      apply: () => undefined,
      close: () => undefined,
      amountText: String,
      seam: seamOf((host, ctx) => {
        seen.push(ctx);
        const marker = host.ownerDocument.createElement("div");
        marker.textContent = "custom-table";
        host.appendChild(marker);
      }),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.panel).toBe("table");
    expect(seen[0]?.model).toEqual({ panel: "table", rows: [ROW], formulas });
    const body = panel.root.querySelector<HTMLElement>(".sg-cost-table__body")!;
    expect(body.children).toHaveLength(1);
    expect(body.children[0]!.textContent).toBe("custom-table");
    expect(body.querySelector("table")).toBeNull();
  });

  it("curve: panel 'curve' and the points model", () => {
    const points: CostCurvePoint[] = [{ t: 0, planned: 10, actual: 5 }];
    const seen: CostPanelRenderContext[] = [];
    createCurvePanel(mountHost(), points, MESSAGES, {
      close: () => undefined,
      pointText: () => "",
      seam: seamOf((_host, ctx) => void seen.push(ctx)),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.panel).toBe("curve");
    expect(seen[0]?.model).toEqual({ panel: "curve", points });
  });

  it("breakdown: panel 'breakdown' and the entries model", () => {
    const entries: BreakdownEntryData[] = [{ type: "fixed", amount: 75, percent: 100 }];
    const seen: CostPanelRenderContext[] = [];
    createBreakdownPanel(mountHost(), entries, MESSAGES, {
      close: () => undefined,
      entryText: () => "",
      seam: seamOf((_host, ctx) => void seen.push(ctx)),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.panel).toBe("breakdown");
    expect(seen[0]?.model).toEqual({ panel: "breakdown", entries });
  });

  it("a seam that appends nothing leaves the body empty — that is not a fallback signal", () => {
    const panel = createBreakdownPanel(
      mountHost(),
      [{ type: "fixed", amount: 75, percent: 100 }],
      MESSAGES,
      { close: () => undefined, entryText: () => "", seam: () => true },
    );
    expect(panel.root.querySelector(".sg-cost-breakdown__body")!.children).toHaveLength(0);
  });

  it("a declining seam has the body emptied and the built-in rendering take over", () => {
    const panel = createTablePanel(mountHost(), [ROW], [], MESSAGES, {
      apply: () => undefined,
      close: () => undefined,
      amountText: String,
      seam: seamOf((host) => {
        // Appends something first, so the fallback must CLEAR it, not merely stop.
        host.appendChild(host.ownerDocument.createElement("div"));
        throw new Error("boom");
      }),
    });
    const body = panel.root.querySelector<HTMLElement>(".sg-cost-table__body")!;
    expect(body.children).toHaveLength(1);
    expect(body.querySelector("table")).not.toBeNull();
    expect(body.querySelectorAll("tr")[1]!.children[0]!.textContent).toBe("Task a");
  });

  it("`close()` on the context is the panel's own close callback", () => {
    let closed = 0;
    let ctx: CostPanelRenderContext | undefined;
    createCurvePanel(mountHost(), [], MESSAGES, {
      close: () => void (closed += 1),
      pointText: () => "",
      seam: seamOf((_host, c) => void (ctx = c)),
    });
    ctx?.close();
    expect(closed).toBe(1);
  });
});

describe("the LATCH, end to end through the wired service (§2.13)", () => {
  it("a throwing renderPanel is reported once, then stays silent on later opens of ANY panel", () => {
    let calls = 0;
    const b = (boot = bootCost(
      {
        cost: {
          renderPanel: () => {
            calls += 1;
            throw new Error("boom");
          },
        },
      },
      { view: true },
    ));
    b.data.load([task("a", 0, 10 * DAY)]);
    const find = (cls: string): HTMLElement | null => b.root.querySelector<HTMLElement>(`.${cls}`);

    b.service.openCostTablePanel();
    expect(find("sg-cost-table")).not.toBeNull();
    // The body fell back to the built-in table.
    expect(find("sg-cost-table")!.querySelector("table")).not.toBeNull();
    expect(calls).toBe(1);
    expect(b.faults.map((f) => f.where)).toEqual(["renderPanel"]);

    // Re-opening the SAME panel: the latch is tripped, so the host is never called again.
    b.service.openCostTablePanel();
    expect(calls).toBe(1);
    expect(b.faults).toHaveLength(1);

    // Opening a DIFFERENT panel: still latched — one seam, shared across all three cost panels.
    b.service.openCostCurvePanel();
    expect(find("sg-cost-curve")).not.toBeNull();
    expect(calls).toBe(1);
    expect(b.faults).toHaveLength(1);

    b.service.openBreakdownPanel();
    expect(find("sg-cost-breakdown")).not.toBeNull();
    expect(calls).toBe(1);
    expect(b.faults).toHaveLength(1);
    expect(b.pluginErrors).toHaveLength(1);
  });

  it("receives the right discriminant for each of the three panels when it does not throw", () => {
    const seen: CostPanelRenderContext["panel"][] = [];
    const b = (boot = bootCost(
      { cost: { renderPanel: (_host, ctx) => void seen.push(ctx.panel) } },
      { view: true },
    ));
    b.data.load([task("a", 0, 10 * DAY)]);
    b.service.openCostTablePanel();
    b.service.openCostCurvePanel();
    b.service.openBreakdownPanel();
    expect(seen).toEqual(["table", "curve", "breakdown"]);
    expect(b.faults).toEqual([]);
  });

  it("the chrome stays the plugin's: the seam replaces the BODY only", () => {
    const b = (boot = bootCost(
      { cost: { renderPanel: (host) => void (host.textContent = "mine") } },
      { view: true },
    ));
    b.data.load([task("a", 0, 10 * DAY)]);
    b.service.openCostTablePanel();
    const root = b.root.querySelector<HTMLElement>(".sg-cost-table")!;
    expect(root.getAttribute("role")).toBe("dialog");
    expect(root.getAttribute("aria-label")).toBe("Budget vs actual");
    expect(root.querySelector(".sg-cost-table__body")!.textContent).toBe("mine");
    // Escape and the footer buttons still belong to the plugin.
    expect([...root.querySelectorAll("button")].map((x) => x.textContent)).toEqual([
      "Apply",
      "Cancel",
    ]);
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(b.root.querySelector(".sg-cost-table")).toBeNull();
  });
});
