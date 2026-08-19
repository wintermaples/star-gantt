// @vitest-environment happy-dom
/**
 * `internal/evm/panels.ts` + the panel half of `internal/evm/wire.ts` — the KPI dashboard, the
 * S-curve panel, the custom KPI tiles as rendered, the §2.13 LATCHED `renderPanel` seam and the
 * plain-language glosses (docs/specs/plugins/tracking.md §2.13 / §2.15 / §2.16).
 *
 * The root vitest config defaults to the "node" environment, so this file opts into `happy-dom`
 * for a real `document`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { MS_DAY, bootEvm, task, themeStub, viewStub } from "./evm-boot";
import type { EvmBoot, EvmBootOptions } from "./evm-boot";
import type { EvmPanelRenderContext } from "../src/types";
import type { TrackingMessages } from "../src/internal/messages";

let boot: EvmBoot | undefined;
afterEach(() => {
  boot?.dispose();
  boot = undefined;
});

/** Boots with `stargantt.view` composed (so panels may open) and a real root element. */
function bootPanels(options: EvmBootOptions = {}): EvmBoot {
  return bootEvm({
    ...options,
    element: options.element ?? document.createElement("div"),
    services: { "stargantt.view": viewStub(), ...(options.services ?? {}) },
  });
}

function loadProject(b: EvmBoot): void {
  b.data.load({ tasks: [task("a", 0, 10 * MS_DAY, { progress: 0.5 })] });
  b.service.setFields("a", { bac: 1000, actualCost: 800 });
}

const find = (b: EvmBoot, className: string): HTMLElement | null =>
  b.root.querySelector(`.${className}`);

const textOf = (el: Element | null): string => el?.textContent ?? "";

/** The dialog's three chrome parts, in DOM order. */
function parts(root: HTMLElement): { header: Element; body: Element; footer: Element } {
  const kids = [...root.children];
  return {
    header: kids[0] as Element,
    body: kids[1] as Element,
    footer: kids[kids.length - 1] as Element,
  };
}

/** The dashboard's tile cards, in render order. */
function tileCards(b: EvmBoot): Element[] {
  const root = find(b, "sg-evm-dashboard");
  if (root === null) throw new Error("the dashboard panel is not open");
  const grid = parts(root).body.children[1] as Element; // description, grid
  return [...grid.children];
}

const cardTexts = (card: Element): string[] => [...card.children].map((c) => c.textContent ?? "");

describe("dashboard panel (§2.15)", () => {
  it("opens as a labelled dialog with the ten KPI tiles and textual flags", () => {
    boot = bootPanels({ evm: { statusDate: 5 * MS_DAY } });
    loadProject(boot);
    expect(boot.service.openDashboardPanel()).toBe(true);
    const root = find(boot, "sg-evm-dashboard");
    expect(root).not.toBeNull();
    expect(root?.getAttribute("role")).toBe("dialog");
    expect(root?.getAttribute("aria-label")).toBe("Earned value");
    expect(root?.getAttribute("tabindex")).toBe("-1");
    const all = textOf(root);
    for (const label of ["BAC", "PV", "EV", "AC", "SV", "CV", "SPI", "CPI", "EAC", "ETC"]) {
      expect(all).toContain(label);
    }
    // SPI = 500/500 = 1 (no flag); CPI = 500/800 < 1 (a TEXTUAL flag, never color-only).
    expect(all).not.toContain("⚠ behind schedule");
    expect(all).toContain("⚠ over cost");
    expect(all).toContain("1,600"); // EAC = 1000 / 0.625
  });

  it("keeps every tile reachable: reflowing grid inside the dialog's own scroller", () => {
    // Narrow hosts (the 720×540 minimum viewport) must not push EAC/ETC out of reach: the grid
    // reflows (auto-fit) and any remaining overflow scrolls inside the body.
    boot = bootPanels({ evm: { statusDate: 5 * MS_DAY } });
    loadProject(boot);
    boot.service.openDashboardPanel();
    const root = find(boot, "sg-evm-dashboard") as HTMLElement;
    expect(root.style.overflow).toBe("hidden");
    const body = parts(root).body as HTMLElement;
    expect(body.style.overflow).toBe("auto");
    // The body must be the shrinking flex item: without `flex:1 1 auto` and `min-height:0` a column
    // flex item cannot shrink below its content height, so the dialog's `overflow:hidden` would
    // clip the bottom tiles and the footer Close button instead of the tile area scrolling.
    expect(body.style.flex).toBe("1 1 auto");
    expect(body.style.minHeight).toBe("0");
    const grid = body.children[1] as Element;
    expect(grid.getAttribute("style")).toContain("repeat(auto-fit, minmax(150px, 1fr))");
    expect(grid.children).toHaveLength(10);
  });

  it("shows the empty state without any figures", () => {
    boot = bootPanels({ evm: { statusDate: 5 * MS_DAY } });
    boot.data.load({ tasks: [task("a", 0, 10 * MS_DAY)] });
    boot.service.openDashboardPanel();
    expect(textOf(find(boot, "sg-evm-dashboard"))).toContain("No EVM data");
  });

  it("closes on Escape and via the Close button; at most one EVM panel is open", () => {
    boot = bootPanels({ evm: { statusDate: 5 * MS_DAY } });
    loadProject(boot);
    boot.service.openDashboardPanel();
    boot.service.openCurvePanel(); // replaces the dashboard
    expect(find(boot, "sg-evm-dashboard")).toBeNull();
    const curve = find(boot, "sg-evm-curve");
    expect(curve).not.toBeNull();
    curve?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(find(boot, "sg-evm-curve")).toBeNull();

    boot.service.openDashboardPanel();
    const root = find(boot, "sg-evm-dashboard") as HTMLElement;
    const button = parts(root).footer.children[0] as HTMLElement;
    expect(textOf(button)).toBe("Close");
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(find(boot, "sg-evm-dashboard")).toBeNull();
  });

  it("tears the open panel down on dispose (the one ctx.own()-registered disposer)", () => {
    boot = bootPanels({ evm: { statusDate: 5 * MS_DAY } });
    loadProject(boot);
    boot.service.openDashboardPanel();
    const root = boot.root;
    boot.dispose();
    boot = undefined;
    expect(root.querySelector(".sg-evm-dashboard")).toBeNull();
  });
});

describe("curve panel (§2.15)", () => {
  it("renders an accessible per-point list mirroring the canvas", () => {
    boot = bootPanels({ evm: { statusDate: 5 * MS_DAY } });
    loadProject(boot);
    expect(boot.service.openCurvePanel()).toBe(true);
    const root = find(boot, "sg-evm-curve");
    expect(root?.getAttribute("aria-label")).toBe("EVM S-curve");
    const all = textOf(root);
    // The status-date point: PV 500 (halfway), EV 500, AC 800.
    expect(all).toContain("1970-01-06 — PV 500, EV 500, AC 800");
    // The final point has PV only — no EV/AC guess past the status date.
    expect(all).toContain("1970-01-11 — PV 1,000");
    // The canvas carries the same series as an image label, never canvas-only.
    const canvas = root?.querySelector("canvas");
    expect(canvas?.getAttribute("role")).toBe("img");
    expect(canvas?.getAttribute("aria-label")).toContain("1970-01-06 — PV 500");
    expect(root?.querySelectorAll("li")).toHaveLength(3);
  });

  it("shows the empty state without tasks and honors message overrides", () => {
    boot = bootPanels({
      evm: { statusDate: 5 * MS_DAY },
      messages: { evmCurveTitle: "Kurve", evmCurveEmpty: "nichts" },
    });
    boot.service.openCurvePanel();
    const root = find(boot, "sg-evm-curve");
    expect(root?.getAttribute("aria-label")).toBe("Kurve");
    expect(textOf(root)).toContain("nichts");
  });

  it("reads theme tokens per use, falling back to the §2.15 defaults without a theme", () => {
    boot = bootPanels({
      evm: { statusDate: 5 * MS_DAY },
      services: { "stargantt.theme": themeStub({ "--sg-evm-pv": "#123456" }) },
    });
    loadProject(boot);
    boot.service.openCurvePanel();
    const canvas = find(boot, "sg-evm-curve")?.querySelector("canvas");
    expect(canvas).not.toBeNull();
    // happy-dom has no 2D context, so the draw is skipped entirely; what this pins is that the
    // panel still mounts its canvas and its accessible list with a theme composed.
    expect(textOf(find(boot, "sg-evm-curve"))).toContain("1970-01-06 — PV 500");
  });
});

describe("custom KPI tiles on the dashboard (§2.15)", () => {
  it("adds tiles after the ten built-in ones, in configuration order", () => {
    boot = bootPanels({
      evm: {
        statusDate: 5 * MS_DAY,
        formulas: [
          { id: "burn", label: "Burn", evaluate: (i) => i.indices.ac - i.indices.ev },
          { id: "tcpi", label: "TCPI", evaluate: () => 1.25, format: (v) => v.toFixed(2) },
        ],
      },
    });
    loadProject(boot);
    boot.service.openDashboardPanel();
    const cards = tileCards(boot);
    expect(cards).toHaveLength(12);
    expect(cardTexts(cards[9] as Element)[0]).toBe("ETC");
    expect(cardTexts(cards[10] as Element).slice(0, 2)).toEqual(["Burn", "300"]);
    expect(cardTexts(cards[11] as Element).slice(0, 2)).toEqual(["TCPI", "1.25"]);
  });

  it("passes the project indices, the S-curve and the status date to evaluate", () => {
    let seen: { statusDate: number; ev: number; times: number[] } | undefined;
    boot = bootPanels({
      evm: {
        statusDate: 5 * MS_DAY,
        formulas: [
          {
            evaluate: (input) => {
              seen = {
                statusDate: input.statusDate,
                ev: input.indices.ev,
                times: input.curve.map((p) => p.t),
              };
              return 1;
            },
          },
        ],
      },
    });
    loadProject(boot);
    boot.service.openDashboardPanel();
    expect(seen?.statusDate).toBe(5 * MS_DAY);
    expect(seen?.ev).toBe(500);
    expect(seen?.times).toEqual([0, 5 * MS_DAY, 10 * MS_DAY]);
  });

  it("threads the already-computed project indices into the S-curve instead of recomputing them", () => {
    boot = bootPanels({ evm: { statusDate: 5 * MS_DAY, formulas: [{ evaluate: (i) => i.indices.ev }] } });
    loadProject(boot);
    const originalTaskIds = boot.data.taskIds.bind(boot.data);
    let taskIdsCalls = 0;
    boot.data.taskIds = () => {
      taskIdsCalls += 1;
      return originalTaskIds();
    };
    boot.service.openDashboardPanel();
    // `dashboardModel()`'s own `projectMetrics()` sweeps tasks twice (`allMetrics()` and
    // `projectBac()`), then `scurve(metrics)` reuses that result (never calls `projectMetrics()`
    // again) and only adds its own per-task planned-date/BAC pass — three sweeps total, not the
    // five an un-threaded second `projectMetrics()` call inside `scurve()` would cost.
    expect(taskIdsCalls).toBe(3);
  });

  it("defaults the id and the label, and formats with the plugin's rounding", () => {
    boot = bootPanels({ evm: { statusDate: 5 * MS_DAY, formulas: [{ evaluate: () => 12_345.6 }] } });
    loadProject(boot);
    boot.service.openDashboardPanel();
    expect(cardTexts(tileCards(boot)[10] as Element).slice(0, 2)).toEqual(["formula-1", "12,346"]);
  });

  it("reports a throwing evaluate and skips that tile", () => {
    boot = bootPanels({
      evm: {
        statusDate: 5 * MS_DAY,
        formulas: [
          {
            id: "bad",
            evaluate: () => {
              throw new Error("boom");
            },
          },
          { id: "good", evaluate: () => 7 },
        ],
      },
    });
    loadProject(boot);
    boot.service.openDashboardPanel();
    const cards = tileCards(boot);
    expect(cards).toHaveLength(11);
    expect(cardTexts(cards[10] as Element).slice(0, 2)).toEqual(["good", "7"]);
    expect(boot.wheres()).toEqual(["formulas.bad.evaluate"]);
  });

  it("ignores an unusable init and keeps the ten built-in tiles", () => {
    boot = bootPanels({
      evm: {
        statusDate: 5 * MS_DAY,
        formulas: [{ id: "nope" } as unknown as { evaluate: () => number }],
      },
    });
    loadProject(boot);
    boot.service.openDashboardPanel();
    expect(tileCards(boot)).toHaveLength(10);
  });
});

/* --- the §2.13 renderPanel seam -------------------------------------------- */

describe("`evm.renderPanel` — the LATCHED body seam", () => {
  it("hands the dashboard body to the host with the tile model", () => {
    let seen: EvmPanelRenderContext | undefined;
    boot = bootPanels({
      evm: {
        statusDate: 5 * MS_DAY,
        formulas: [{ id: "extra", evaluate: () => 42 }],
        renderPanel: (host, panelCtx) => {
          seen = panelCtx;
          const own = host.ownerDocument.createElement("div");
          own.textContent = "host body";
          host.appendChild(own);
        },
      },
    });
    loadProject(boot);
    boot.service.openDashboardPanel();
    const all = textOf(find(boot, "sg-evm-dashboard"));
    expect(all).toContain("host body");
    expect(all).not.toContain("BAC"); // the built-in tiles did not run
    expect(seen?.panel).toBe("dashboard");
    const model = seen?.model;
    expect(model?.panel === "dashboard" ? model.tiles.map((t) => t.label) : []).toEqual([
      "BAC",
      "PV",
      "EV",
      "AC",
      "SV",
      "CV",
      "SPI",
      "CPI",
      "EAC",
      "ETC",
      "extra",
    ]);
  });

  it("hands the curve body to the host with the point model, and close() shuts the panel", () => {
    let seen: EvmPanelRenderContext | undefined;
    boot = bootPanels({
      evm: {
        statusDate: 5 * MS_DAY,
        renderPanel: (host, panelCtx) => {
          seen = panelCtx;
          const own = host.ownerDocument.createElement("div");
          own.textContent = "my curve";
          host.appendChild(own);
        },
      },
    });
    loadProject(boot);
    boot.service.openCurvePanel();
    expect(textOf(find(boot, "sg-evm-curve"))).toContain("my curve");
    expect(seen?.panel).toBe("curve");
    const model = seen?.model;
    expect(model?.panel === "curve" ? model.points.map((p) => p.t) : []).toEqual([
      0,
      5 * MS_DAY,
      10 * MS_DAY,
    ]);
    seen?.close();
    expect(find(boot, "sg-evm-curve")).toBeNull();
  });

  it("leaves an empty body when the host appends nothing — not a fallback signal", () => {
    boot = bootPanels({ evm: { statusDate: 5 * MS_DAY, renderPanel: () => undefined } });
    loadProject(boot);
    boot.service.openDashboardPanel();
    const root = find(boot, "sg-evm-dashboard") as HTMLElement;
    expect(parts(root).body.children).toHaveLength(0);
    expect(textOf(root)).not.toContain("BAC");
  });

  it("reports a throw once, empties the body, and stays latched across BOTH panels", () => {
    boot = bootPanels({
      evm: {
        statusDate: 5 * MS_DAY,
        renderPanel: (host) => {
          const own = host.ownerDocument.createElement("div");
          own.textContent = "half-built";
          host.appendChild(own);
          throw new Error("boom");
        },
      },
    });
    loadProject(boot);
    boot.service.openDashboardPanel();
    const dashboard = textOf(find(boot, "sg-evm-dashboard"));
    expect(dashboard).not.toContain("half-built");
    expect(dashboard).toContain("BAC");
    // Latched per config field: the curve panel does not call the host rule again.
    boot.service.openCurvePanel();
    const curve = textOf(find(boot, "sg-evm-curve"));
    expect(curve).not.toContain("half-built");
    expect(curve).toContain("1970-01-06 — PV 500");
    // Re-opening the dashboard does not report a second time either.
    boot.service.openDashboardPanel();
    expect(textOf(find(boot, "sg-evm-dashboard"))).toContain("BAC");
    expect(boot.wheres()).toEqual(["renderPanel"]);
  });

  it("falls back to the built-in curve rendering when the host throws on the curve panel first", () => {
    boot = bootPanels({
      evm: {
        statusDate: 5 * MS_DAY,
        renderPanel: () => {
          throw new Error("boom");
        },
      },
    });
    loadProject(boot);
    boot.service.openCurvePanel();
    expect(textOf(find(boot, "sg-evm-curve"))).toContain("1970-01-06 — PV 500");
    expect(boot.wheres()).toEqual(["renderPanel"]);
  });
});

/* --- the plain-language glosses (§2.15) ------------------------------------ */

const GLOSSES: readonly [keyof TrackingMessages, string][] = [
  ["bacGloss", "Total budget for all the work."],
  ["pvGloss", "Budgeted cost of the work planned by now."],
  ["evGloss", "Budgeted cost of the work actually finished."],
  ["acGloss", "What has actually been spent."],
  ["svGloss", "Earned minus planned. Below zero means behind schedule."],
  ["cvGloss", "Earned minus spent. Below zero means over budget."],
  ["spiGloss", "Schedule efficiency. Above 1 is ahead of plan."],
  ["cpiGloss", "Cost efficiency. Above 1 is under budget."],
  ["eacGloss", "Projected total cost if the current trend holds."],
  ["etcGloss", "Projected cost of the work still to do."],
];

describe("the plain-language layer", () => {
  it("renders a gloss under every built-in tile's value, before the flag", () => {
    boot = bootPanels({ evm: { statusDate: 5 * MS_DAY } });
    loadProject(boot);
    boot.service.openDashboardPanel();
    const cards = tileCards(boot);
    expect(cards).toHaveLength(10);
    for (let i = 0; i < 10; i += 1) {
      expect(cardTexts(cards[i] as Element)[2]).toBe(GLOSSES[i]?.[1]);
    }
    // The CPI tile is the flagged one: label, value, gloss, then the TEXTUAL flag.
    expect(cardTexts(cards[7] as Element)).toEqual([
      "CPI",
      "0.63",
      "Cost efficiency. Above 1 is under budget.",
      "⚠ over cost",
    ]);
  });

  it("describes each panel in one line above its content", () => {
    boot = bootPanels({ evm: { statusDate: 5 * MS_DAY } });
    loadProject(boot);
    boot.service.openDashboardPanel();
    const dashboard = find(boot, "sg-evm-dashboard") as HTMLElement;
    expect(textOf(parts(dashboard).body.children[0] as Element)).toBe(
      "Earned-value metrics as of the status date, in the project's cost unit.",
    );
    boot.service.openCurvePanel();
    const curve = find(boot, "sg-evm-curve") as HTMLElement;
    expect(textOf(parts(curve).body.children[0] as Element)).toBe(
      "Cumulative cost over time: planned (PV), earned (EV) and actual (AC).",
    );
  });

  it("overrides every gloss and description through the merged catalog", () => {
    const overrides: Partial<TrackingMessages> = Object.fromEntries(
      [...GLOSSES.map(([key]) => key), "dashboardDescription", "curveDescription"].map((key) => [
        key,
        `x-${String(key)}`,
      ]),
    );
    boot = bootPanels({ evm: { statusDate: 5 * MS_DAY }, messages: overrides });
    loadProject(boot);
    boot.service.openDashboardPanel();
    const all = textOf(find(boot, "sg-evm-dashboard"));
    for (const [key] of GLOSSES) expect(all).toContain(`x-${String(key)}`);
    expect(all).toContain("x-dashboardDescription");
    boot.service.openCurvePanel();
    expect(textOf(find(boot, "sg-evm-curve"))).toContain("x-curveDescription");
  });
});
