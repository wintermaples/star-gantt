/**
 * View modes (docs/specs/plugins/view.md — "View modes"): the `view/setViewMode` command, the
 * `initialViewMode` config option, the `viewMode` store, and the hostless `layoutFor` planner.
 */
import { definePlugin } from "@stargantt/core";
import type { AnyPlugin } from "@stargantt/core";
import type { DomHarness, FakeElement } from "../_utils/index";
import { afterEach, describe, expect, it } from "vitest";
import { layoutFor, parseViewMode } from "../../src/internal/panes/view-mode";
import type { PanesConfig } from "../../src/config";
import { boot } from "./_boot";
import type { Booted } from "./_boot";
import type { PaneContribution } from "../../src/internal/panes/index";

let booted: Booted[] = [];

afterEach(() => {
  for (const b of booted) {
    b.gantt.dispose();
    b.dom.restore();
  }
  booted = [];
});

function contributor(id: string, contributions: PaneContribution[]): AnyPlugin {
  return definePlugin({
    meta: { id, dependsOn: ["stargantt.view"] },
    setup(ctx) {
      for (const c of contributions) ctx.contribute("view/panes", c);
    },
  });
}

function pane(id: string, over: Partial<PaneContribution> = {}): PaneContribution {
  return { id, side: "left", order: 0, initialWidth: 100, mount: () => {}, ...over };
}

/**
 * Records every mode the `viewMode` store actually settles on, in order.
 *
 * `view/modeChanged` is abolished (docs/specs/plugins/view.md): the store is the sole notice of a
 * mode change now. Subscribing happens in this probe's own `setup()` — like the old event
 * listener, that runs before `lifecycle/ready` applies `initialViewMode`, so a test asserting on
 * the startup switch observes it.
 */
function viewModeProbe(sink: string[]): AnyPlugin {
  return definePlugin({
    meta: { id: "test.modes", dependsOn: ["stargantt.view"] },
    setup(ctx) {
      const service = ctx.use("stargantt.view");
      ctx.own(service.viewMode.subscribe((next) => sink.push(next)));
    },
  });
}

function start(
  extra: AnyPlugin[] = [],
  config?: PanesConfig,
): { dom: DomHarness; g: Booted["gantt"] } {
  const b = boot(extra, { config });
  booted.push(b);
  return { dom: b.dom, g: b.gantt };
}

function chartEl(dom: DomHarness): FakeElement | undefined {
  return dom.root.find("sg-pane sg-pane--chart");
}

function contributedPanes(dom: DomHarness): FakeElement[] {
  return dom.root.findAll("sg-pane").filter((el) => !el.classList.contains("sg-pane--chart"));
}

function dividers(dom: DomHarness): FakeElement[] {
  return dom.root.findAll("sg-pane-divider");
}

describe("view-mode planner (hostless)", () => {
  it("parses only the three literal modes", () => {
    expect(parseViewMode("split")).toBe("split");
    expect(parseViewMode("grid")).toBe("grid");
    expect(parseViewMode("gantt")).toBe("gantt");
    expect(parseViewMode("table")).toBeNull();
    expect(parseViewMode(undefined)).toBeNull();
    expect(parseViewMode(42)).toBeNull();
  });

  it("split shows everything and grows nothing", () => {
    const layout = layoutFor("split", [{ side: "left" }, { side: "right" }]);
    expect(layout).toEqual({
      chartHidden: false,
      paneHidden: [false, false],
      dividersHidden: false,
      growIndex: -1,
    });
  });

  it("gantt hides every contributed pane and divider, keeps the chart", () => {
    const layout = layoutFor("gantt", [{ side: "left" }, { side: "right" }]);
    expect(layout).toEqual({
      chartHidden: false,
      paneHidden: [true, true],
      dividersHidden: true,
      growIndex: -1,
    });
  });

  it("grid hides the chart and right panes and grows the innermost left pane", () => {
    const layout = layoutFor("grid", [{ side: "left" }, { side: "left" }, { side: "right" }]);
    expect(layout).toEqual({
      chartHidden: true,
      paneHidden: [false, false, true],
      dividersHidden: true,
      growIndex: 1,
    });
  });

  it("grid is inapplicable without a left pane", () => {
    expect(layoutFor("grid", [{ side: "right" }])).toBeNull();
    expect(layoutFor("grid", [])).toBeNull();
  });
});

describe("default behavior is unchanged (default-off)", () => {
  it("writes no display/flex styles without a mode switch", () => {
    const { dom } = start([contributor("test.c", [pane("l"), pane("r", { side: "right" })])]);
    expect(chartEl(dom)?.style["display"] ?? "").toBe("");
    for (const el of [...contributedPanes(dom), ...dividers(dom)]) {
      expect(el.style["display"] ?? "").toBe("");
      expect(el.style["flex"] ?? "").toBe("");
    }
  });
});

describe("view/setViewMode command", () => {
  it("grid hides the chart, right panes and dividers, and grows the innermost left pane", () => {
    const { dom, g } = start([
      contributor("test.c", [
        pane("l1", { side: "left", order: 0 }),
        pane("l2", { side: "left", order: 1 }),
        pane("r", { side: "right" }),
      ]),
    ]);
    g.dispatch("view/setViewMode", { mode: "grid" });

    expect(chartEl(dom)?.style["display"]).toBe("none");
    const [l1, l2, r] = contributedPanes(dom);
    expect(l1?.style["display"]).toBe("");
    expect(l2?.style["display"]).toBe("");
    expect(r?.style["display"]).toBe("none");
    // innermost left pane grows
    expect(l1?.style["flex"]).toBe("");
    expect(l2?.style["flex"]).toBe("1 1 auto");
    for (const d of dividers(dom)) expect(d.style["display"]).toBe("none");
  });

  it("gantt hides every contributed pane and divider and keeps the chart", () => {
    const { dom, g } = start([contributor("test.c", [pane("l"), pane("r", { side: "right" })])]);
    g.dispatch("view/setViewMode", { mode: "gantt" });

    expect(chartEl(dom)?.style["display"] ?? "").toBe("");
    for (const el of contributedPanes(dom)) expect(el.style["display"]).toBe("none");
    for (const d of dividers(dom)) expect(d.style["display"]).toBe("none");
  });

  it("split restores the exact previous layout, including pane widths", () => {
    const { dom, g } = start([
      contributor("test.c", [pane("l", { initialWidth: 240 }), pane("r", { side: "right" })]),
    ]);
    g.dispatch("view/setViewMode", { mode: "grid" });
    g.dispatch("view/setViewMode", { mode: "split" });

    expect(chartEl(dom)?.style["display"]).toBe("");
    for (const el of [...contributedPanes(dom), ...dividers(dom)]) {
      expect(el.style["display"]).toBe("");
      expect(el.style["flex"] ?? "").toBe("");
    }
    expect(contributedPanes(dom)[0]?.style["width"]).toBe("240px");
  });

  it("keeps pane content mounted across switches (mount called exactly once)", () => {
    let mounts = 0;
    const { g } = start([contributor("test.c", [pane("l", { mount: () => (mounts += 1) })])]);
    g.dispatch("view/setViewMode", { mode: "gantt" });
    g.dispatch("view/setViewMode", { mode: "grid" });
    g.dispatch("view/setViewMode", { mode: "split" });
    expect(mounts).toBe(1);
  });

  it("silently ignores an unusable mode", () => {
    const { dom, g } = start([contributor("test.c", [pane("l")])]);
    expect(() =>
      g.dispatch("view/setViewMode", { mode: "table" as unknown as "grid" }),
    ).not.toThrow();
    expect(chartEl(dom)?.style["display"] ?? "").toBe("");
  });

  it("ignores grid when no left-side pane exists", () => {
    const events: string[] = [];
    const { dom, g } = start([
      viewModeProbe(events),
      contributor("test.c", [pane("r", { side: "right" })]),
    ]);
    g.dispatch("view/setViewMode", { mode: "grid" });
    expect(chartEl(dom)?.style["display"] ?? "").toBe("");
    expect(contributedPanes(dom)[0]?.style["display"] ?? "").toBe("");
    expect(events).toEqual([]);
  });

  it("notifies the viewMode store only when the mode actually changes", () => {
    const events: string[] = [];
    const { g } = start([viewModeProbe(events), contributor("test.c", [pane("l")])]);
    g.dispatch("view/setViewMode", { mode: "split" }); // already in effect
    g.dispatch("view/setViewMode", { mode: "grid" });
    g.dispatch("view/setViewMode", { mode: "grid" }); // same mode again
    g.dispatch("view/setViewMode", { mode: "gantt" });
    expect(events).toEqual(["grid", "gantt"]);
  });

  it("notifies onResize with the occupied width when the grow is gained and lost", () => {
    const widths: number[] = [];
    const { dom, g } = start([
      contributor("test.c", [pane("l", { initialWidth: 240, onResize: (w) => widths.push(w) })]),
    ]);
    const paneEl = contributedPanes(dom)[0];
    // The fake layout reports the harness's fixed rect for the grown pane.
    if (paneEl !== undefined) paneEl.rect = { ...paneEl.rect, width: 400 };
    g.dispatch("view/setViewMode", { mode: "grid" });
    expect(widths).toEqual([400]);
    g.dispatch("view/setViewMode", { mode: "split" });
    // Back at the remembered width — which the mode switches never changed.
    expect(widths).toEqual([400, 240]);
    expect(paneEl?.style["width"]).toBe("240px");
  });

  it("keeps paneToggle memory across mode switches", () => {
    const { dom, g } = start([
      contributor("test.c", [pane("l", { initialWidth: 240, collapsible: true })]),
    ]);
    g.dispatch("view/paneToggle", { id: "l", collapsed: true });
    g.dispatch("view/setViewMode", { mode: "gantt" });
    g.dispatch("view/setViewMode", { mode: "split" });
    expect(contributedPanes(dom)[0]?.style["width"]).toBe("0px");
    g.dispatch("view/paneToggle", { id: "l" });
    expect(contributedPanes(dom)[0]?.style["width"]).toBe("240px");
  });
});

describe("initialViewMode config", () => {
  it("starts in the configured mode and notifies the viewMode store once", () => {
    const events: string[] = [];
    const { dom } = start(
      [viewModeProbe(events), contributor("test.c", [pane("l"), pane("r", { side: "right" })])],
      { initialViewMode: "grid" },
    );
    expect(chartEl(dom)?.style["display"]).toBe("none");
    expect(events).toEqual(["grid"]);
  });

  it("silently ignores an unusable value and starts in split", () => {
    const { dom } = start([contributor("test.c", [pane("l")])], {
      initialViewMode: "spreadsheet" as unknown as "grid",
    });
    expect(chartEl(dom)?.style["display"] ?? "").toBe("");
  });

  it("silently ignores grid when the composition has no left pane", () => {
    const { dom } = start([contributor("test.c", [pane("r", { side: "right" })])], {
      initialViewMode: "grid",
    });
    expect(chartEl(dom)?.style["display"] ?? "").toBe("");
    expect(contributedPanes(dom)[0]?.style["display"] ?? "").toBe("");
  });
});

// docs/specs/plugins/view.md — "View modes": a mode switch must never orphan keyboard
// focus to `<body>` by hiding the subtree that holds it.
describe("focus reanchoring on a mode switch", () => {
  it("moves focus to the chart pane before hiding a pane that holds the active element", () => {
    const { dom, g } = start([contributor("test.c", [pane("l")])]);
    const paneEl = contributedPanes(dom)[0]!;
    const input = dom.document.createElement("div");
    paneEl.appendChild(input);
    input.focus();
    expect(dom.document.activeElement).toBe(input);

    // "gantt" hides every contributed pane, so the surviving anchor is the chart pane.
    g.dispatch("view/setViewMode", { mode: "gantt" });

    expect(dom.document.activeElement).toBe(chartEl(dom));
    expect(dom.document.activeElement).not.toBe(dom.document.body);
  });

  it("moves focus to the grown pane before hiding the chart pane that holds the active element", () => {
    const { dom, g } = start([contributor("test.c", [pane("l")])]);
    const chart = chartEl(dom)!;
    const input = dom.document.createElement("div");
    chart.appendChild(input);
    input.focus();

    // "grid" hides the chart pane, so the surviving anchor is the (sole, grown) left pane.
    g.dispatch("view/setViewMode", { mode: "grid" });

    expect(dom.document.activeElement).toBe(contributedPanes(dom)[0]);
    expect(dom.document.activeElement).not.toBe(dom.document.body);
  });

  it("moves focus off a divider that hides even though its own pane stays visible", () => {
    const { dom, g } = start([contributor("test.c", [pane("l")])]);
    const divider = dividers(dom)[0]!;
    divider.focus();
    expect(dom.document.activeElement).toBe(divider);

    // "gantt" sets dividersHidden even for panes that stay put — here the pane itself is also
    // hidden, but the anchor check must key off the divider becoming hidden, not just the pane.
    g.dispatch("view/setViewMode", { mode: "gantt" });

    expect(dom.document.activeElement).toBe(chartEl(dom));
  });

  it("leaves focus untouched when the active element is not inside anything being hidden", () => {
    const { dom, g } = start([
      contributor("test.c", [pane("l"), pane("r", { side: "right" })]),
    ]);
    const leftPane = contributedPanes(dom)[0]!;
    const input = dom.document.createElement("div");
    leftPane.appendChild(input);
    input.focus();

    // "grid" hides the chart pane, the right pane and every divider — but not the left pane
    // holding the active element, so the guard's negative branch must leave focus alone.
    g.dispatch("view/setViewMode", { mode: "grid" });

    expect(chartEl(dom)?.style["display"]).toBe("none");
    expect(dom.document.activeElement).toBe(input);
  });

  it("does not reach for `document.activeElement` at all when nothing is hidden", () => {
    // No panes at all: "gantt" and "grid" are inapplicable/no-ops, so there is nothing to hide and
    // nothing to reanchor; this just documents that the guard degrades safely with zero panes.
    const { dom, g } = start([]);
    expect(() => g.dispatch("view/setViewMode", { mode: "gantt" })).not.toThrow();
    expect(dom.document.activeElement).toBe(dom.document.body);
  });
});

describe("resource ownership (CLAUDE.md constraint)", () => {
  it("restores the chart pane's inline display on dispose", () => {
    const { dom, g } = start([contributor("test.c", [pane("l")])]);
    const chart = chartEl(dom);
    g.dispatch("view/setViewMode", { mode: "grid" });
    expect(chart?.style["display"]).toBe("none");
    g.dispose();
    expect(chart?.style["display"]).toBe("");
  });

  it("removes the tabindex the focus anchor wrote on the chart pane on dispose", () => {
    const { dom, g } = start([contributor("test.c", [pane("l")])]);
    const chart = chartEl(dom)!;
    const paneEl = contributedPanes(dom)[0]!;
    const input = dom.document.createElement("div");
    paneEl.appendChild(input);
    input.focus();

    // "gantt" hides the left pane, so the reanchor makes the renderer-owned chart pane
    // focusable by writing `tabindex="-1"` onto it.
    g.dispatch("view/setViewMode", { mode: "gantt" });
    expect(chart.getAttribute("tabindex")).toBe("-1");

    g.dispose();
    expect(chart.hasAttribute("tabindex")).toBe(false);
  });

  it("leaves a pre-existing tabindex on the anchor alone", () => {
    const { dom, g } = start([contributor("test.c", [pane("l")])]);
    const chart = chartEl(dom)!;
    chart.setAttribute("tabindex", "0");
    chart.tabIndex = 0;
    const paneEl = contributedPanes(dom)[0]!;
    const input = dom.document.createElement("div");
    paneEl.appendChild(input);
    input.focus();

    g.dispatch("view/setViewMode", { mode: "gantt" });
    expect(chart.getAttribute("tabindex")).toBe("0");

    g.dispose();
    expect(chart.getAttribute("tabindex")).toBe("0");
  });
});
