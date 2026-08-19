/**
 * `view/panes` behavior (docs/specs/plugins/view.md): placement around the chart pane,
 * ordering, dividers, drag-resize, fault barrier, resource ownership.
 */
import { definePlugin } from "@stargantt/core";
import type { AnyPlugin } from "@stargantt/core";
import { asElement, keyEvent } from "../_utils/index";
import type { DomHarness, FakeElement } from "../_utils/index";
import { afterEach, describe, expect, it } from "vitest";
import { view } from "../../src/index";
import { boot } from "./_boot";
import type { Booted, ViewPluginOptions } from "./_boot";
import type { PaneContribution } from "../../src/internal/panes/index";

let booted: Booted[] = [];

afterEach(() => {
  for (const b of booted) {
    b.gantt.dispose();
    b.dom.restore();
  }
  booted = [];
});

/** Boots and tracks the harness for cleanup, returning the `{ dom, g }` pair the tests use. */
function start(
  extra: AnyPlugin[] = [],
  viewOpts: ViewPluginOptions = {},
  domOptions: Parameters<typeof boot>[2] = {},
): { dom: DomHarness; g: Booted["gantt"] } {
  const b = boot(extra, viewOpts, domOptions);
  booted.push(b);
  return { dom: b.dom, g: b.gantt };
}

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

function errorsProbe(sink: unknown[]): AnyPlugin {
  return definePlugin({
    meta: { id: "test.errors" },
    setup(ctx) {
      ctx.on("core/pluginError", (e) => sink.push(e));
    },
  });
}

/**
 * `DomOptions` that make `getComputedStyle` report `px` for `--sg-chart-min-width`.
 *
 * The harness owns `globalThis.getComputedStyle` (and restores it), so the token is supplied
 * through its token map instead of a hand-rolled save/restore around the boot.
 */
function chartMinWidth(px: number): Parameters<typeof boot>[2] {
  return { tokens: { "--sg-chart-min-width": `${px}px` } };
}

/**
 * Every `sg-pane` the plugin itself created, i.e. excluding the renderer's chart pane.
 *
 * The chart pane carries `sg-pane` too, and the shared harness matches class *tokens* the way a CSS
 * selector does, so the contributed panes are the ones without the chart marker.
 */
function contributedPanes(harness: DomHarness): FakeElement[] {
  return harness.root.findAll("sg-pane").filter((el) => !el.classList.contains("sg-pane--chart"));
}

/**
 * The `.sg-pane-row` wrapper the plugin creates around the horizontal composition
 * (docs/specs/plugins/view.md). The panes, dividers and the chart pane are its children,
 * not the root's.
 */
function paneRow(harness: DomHarness): FakeElement {
  const row = harness.root.find("sg-pane-row");
  expect(row).toBeDefined();
  return row!;
}

// This package once asserted the shape of a standalone `panes()` plugin factory: its own `meta.id`
// ("stargantt.panes") and its `dependsOn: ["stargantt.view"]". Both are retired concepts — the six
// formerly-separate modules merged into one `stargantt.view`, wired through `createPanesModule`, which is a plain
// function and not itself a plugin. The equivalent coverage for the merged plugin's own factory
// shape (id, `dependsOn`, "factory not a const") lives in `test/render/renderer.test.ts`'s "plugin
// identity and service" block; nothing here would be testing behavior specific to panes.
describe.skip("factory shape — retired: panes is no longer a standalone plugin", () => {
  it("is a factory, not a plain plugin const, and takes an optional empty config", () => {
    expect(typeof view).toBe("function");
  });
});

describe("placement around the chart pane", () => {
  it("puts left panes before the chart pane and right panes after it, inside the pane row", () => {
    const { dom } = start([
      contributor("test.c", [
        pane("r1", { side: "right", order: 1 }),
        pane("l1", { side: "left", order: 0 }),
      ]),
    ]);
    // The horizontal composition lives inside the `.sg-pane-row` wrapper, itself the
    // root's direct child.
    expect(dom.root.children.map((c) => c.className)).toEqual(["sg-pane-row"]);
    expect(paneRow(dom).children.map((c) => c.className)).toEqual([
      "sg-pane",
      "sg-pane-divider",
      "sg-pane sg-pane--chart",
      "sg-pane-divider",
      "sg-pane",
    ]);
  });

  it("orders panes by side, `order` ascending, then registration order", () => {
    const mounted: string[] = [];
    const tag = (id: string, over: Partial<PaneContribution>): PaneContribution =>
      pane(id, { ...over, mount: () => mounted.push(id) });
    const { dom } = start([
      contributor("test.a", [
        tag("l2", { side: "left", order: 2 }),
        tag("tieB", { side: "left", order: 1 }),
        tag("r2", { side: "right", order: 2 }),
      ]),
      contributor("test.b", [
        tag("tieA", { side: "left", order: 1 }),
        tag("r1", { side: "right", order: 1 }),
      ]),
    ]);
    // leftmost = lowest left order; innermost right = lowest right order; ties by registration.
    expect(mounted).toEqual(["tieB", "tieA", "l2", "r1", "r2"]);
    const widths = paneRow(dom)
      .children.filter((c) => c.className === "sg-pane")
      .map((c) => c.style["width"]);
    expect(widths.length).toBe(5);
  });

  // The former "composition with no chart pane" case is gone: the chart pane is obtained from
  // `ViewService.chartPaneElement()`, which the render module always answers, so there is no
  // class-string lookup left to miss. The former "with no chart pane, prepends left panes and
  // appends right panes" test covered that retired fallback and is therefore removed rather than
  // adapted.
  it("places panes relative to the element the renderer hands out, whatever its class names", () => {
    // A chart pane carrying none of the renderer's own class names: only the accessor identifies it.
    const { dom } = start(
      [contributor("test.c", [pane("l", { side: "left" }), pane("r", { side: "right" })])],
      {
        chartPane: (ctx) => {
          const marker = ctx.root.ownerDocument.createElement("div");
          marker.className = "custom-chart";
          ctx.root.appendChild(marker);
          return marker;
        },
      },
    );
    // The accessor-provided element is wrapped into the pane row like any chart pane.
    expect(dom.root.find("sg-pane-row")?.children.map((c) => c.className)).toEqual([
      "sg-pane",
      "sg-pane-divider",
      "custom-chart",
      "sg-pane-divider",
      "sg-pane",
    ]);
  });

  // The move requires the chart pane to be a **direct child** of the root: `insertBefore`
  // uses it as a reference node, and a renderer answering with the root itself would be asked to
  // become its own descendant (a cyclic tree that hangs rather than throws) — so the case is
  // refused and reported rather than attempted. The refusal path itself must also survive a real
  // DOM: the row is appended empty and the panes mount with a `null` insertion reference —
  // passing the out-of-row chart pane instead would throw `NotFoundError` in a browser, a defect
  // the shared harness's `insertBefore` masked until it was made to throw like a real DOM's.
  it("refuses to wrap a chart pane that is not inside the root, and reports it", () => {
    const errors: unknown[] = [];
    const { dom } = start(
      [
        errorsProbe(errors),
        contributor("test.c", [pane("l", { side: "left" }), pane("r", { side: "right" })]),
      ],
      { chartPane: (ctx) => ctx.root },
    );
    // Exactly the guard's own report: a `NotFoundError` escaping the `lifecycle/ready` handler
    // would surface as a second `core/pluginError` and would leave the row unpopulated.
    expect(errors.length).toBe(1);
    // The row exists, the root was not moved into itself, and with no chart pane in the row the
    // panes appended in contributed order: left pane and its divider, then the right pane's
    // divider and the right pane.
    expect(dom.root.find("sg-pane-row")?.children.map((c) => c.className)).toEqual([
      "sg-pane",
      "sg-pane-divider",
      "sg-pane-divider",
      "sg-pane",
    ]);
  });

  // The guard requires a direct child, not merely a descendant: a renderer wrapping its chart
  // pane one level deep passes a `contains()` check but `ctx.root.insertBefore(paneRow, chart)`
  // throws `NotFoundError` in a real DOM, and the dispose-time restore would reparent the pane
  // away from its wrapper — breaking the "returned exactly as found" guarantee.
  it("refuses a chart pane that is a grandchild of the root (wrapped one level deep)", () => {
    const errors: unknown[] = [];
    let wrapper: FakeElement | undefined;
    const { dom } = start(
      [errorsProbe(errors), contributor("test.c", [pane("l", { side: "left" })])],
      {
        chartPane: (ctx) => {
          const doc = ctx.root.ownerDocument;
          const shell = doc.createElement("div");
          shell.className = "renderer-shell";
          const chart = doc.createElement("div");
          chart.className = "custom-chart";
          shell.appendChild(chart);
          ctx.root.appendChild(shell);
          wrapper = shell as unknown as FakeElement;
          return chart;
        },
      },
    );
    // Reported once; the chart pane stays exactly where the renderer put it.
    expect(errors.length).toBe(1);
    expect(wrapper?.children.map((c) => c.className)).toEqual(["custom-chart"]);
    // The row was appended empty after the renderer's wrapper and the contributed pane mounted
    // into it.
    expect(dom.root.children.map((c) => c.className)).toEqual(["renderer-shell", "sg-pane-row"]);
    expect(dom.root.find("sg-pane-row")?.children.map((c) => c.className)).toEqual([
      "sg-pane",
      "sg-pane-divider",
    ]);
  });
});

describe("mount", () => {
  it("calls mount exactly once, after setup, with the pane element sized to initialWidth", () => {
    const seen: HTMLElement[] = [];
    const { dom } = start([
      contributor("test.c", [pane("p", { initialWidth: 240, mount: (el) => seen.push(el) })]),
    ]);
    expect(seen.length).toBe(1);
    const el = paneRow(dom).children[0];
    expect(seen[0]).toBe(asElement(el!));
    expect(el?.style["width"]).toBe("240px");
  });

  it("guards a throwing mount and still mounts the other panes", () => {
    const errors: unknown[] = [];
    const mounted: string[] = [];
    start([
      errorsProbe(errors),
      contributor("test.c", [
        pane("bad", {
          order: 0,
          mount: () => {
            throw new Error("boom");
          },
        }),
        pane("good", { order: 1, mount: () => mounted.push("good") }),
      ]),
    ]);
    expect(mounted).toEqual(["good"]);
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatchObject({ pluginId: "stargantt.view" });
  });

  it("keeps the first of two contributions with the same id and reports the duplicate", () => {
    const errors: unknown[] = [];
    const mounted: string[] = [];
    const { dom } = start([
      errorsProbe(errors),
      contributor("test.a", [pane("dup", { mount: () => mounted.push("first") })]),
      contributor("test.b", [pane("dup", { mount: () => mounted.push("second") })]),
    ]);
    expect(mounted).toEqual(["first"]);
    expect(errors.length).toBe(1);
    expect(contributedPanes(dom).length).toBe(1);
  });
});

describe("dividers and drag-resize", () => {
  it("resizes a left pane by dragging its divider, clamped to minWidth", () => {
    const { dom } = start([contributor("test.c", [pane("l", { minWidth: 50 })])]);
    const paneEl = contributedPanes(dom)[0];
    const divider = dom.root.find("sg-pane-divider");
    divider?.fire("pointerdown", { clientX: 100 });
    dom.document.fire("pointermove", { clientX: 150 });
    // The drag starts from the pane's own width state (`initialWidth` 100, the single source of
    // truth), not from a measured rect, so +50 lands at 150. Adapted for that unification: the
    // former expectation (450) was the fake layout's fixed 400px rect plus 50.
    expect(paneEl?.style["width"]).toBe("150px");

    dom.document.fire("pointermove", { clientX: -10_000 });
    expect(paneEl?.style["width"]).toBe("50px");

    dom.document.fire("pointerup", {});
    dom.document.fire("pointermove", { clientX: 300 });
    expect(paneEl?.style["width"]).toBe("50px");
  });

  it("resizes a right pane with the drag direction inverted", () => {
    const { dom } = start([contributor("test.c", [pane("r", { side: "right" })])]);
    const paneEl = contributedPanes(dom)[0];
    const divider = dom.root.find("sg-pane-divider");
    divider?.fire("pointerdown", { clientX: 100 });
    dom.document.fire("pointermove", { clientX: 60 });
    // Right pane: the pointer moving left grows it. 100 (`initialWidth`) + 40. Adapted with the
    // width-source unification (was 440 = the fake 400px rect + 40).
    expect(paneEl?.style["width"]).toBe("140px");
  });

  // `.claude/skills/gantt-ui-ux/references/code-quality.md` §8 — one truth source per measurement:
  // a laid-out rect that disagrees with the plugin's width state (a pane CSS-shrunk under container
  // pressure) must not feed the drag, or the keyboard steps and the drag would read different
  // numbers for the same pane. The fake DOM cannot lay anything out, so the divergence is
  // fabricated by writing a conflicting rect; the real-layout check belongs to E2E.
  it("drags from the pane's width state even when its measured rect disagrees", () => {
    const { dom } = start([contributor("test.c", [pane("l", { initialWidth: 200 })])]);
    const paneEl = contributedPanes(dom)[0];
    const divider = dom.root.find("sg-pane-divider");
    if (paneEl !== undefined) paneEl.rect = { ...paneEl.rect, width: 999 };
    divider?.fire("pointerdown", { clientX: 100 });
    dom.document.fire("pointermove", { clientX: 110 });
    expect(paneEl?.style["width"]).toBe("210px");
  });

  it("renders no divider for `resizable: false`", () => {
    const { dom } = start([contributor("test.c", [pane("l", { resizable: false })])]);
    expect(dom.root.find("sg-pane-divider")).toBeUndefined();
    expect(paneRow(dom).children.map((c) => c.className)).toEqual([
      "sg-pane",
      "sg-pane sg-pane--chart",
    ]);
  });

  it("marks each divider with the side its contributed pane is on", () => {
    // The stylesheet needs to know which neighbor is the contributed pane: across that pane's
    // header strip the hit band puts all of its slack on the chart side, so it cannot cover
    // a control the pane places at its own inner edge (column-resize handles).
    const { dom } = start([
      contributor("test.c", [
        pane("l", { side: "left", order: 0 }),
        pane("r", { side: "right", order: 0 }),
      ]),
    ]);
    expect(
      paneRow(dom).children.map((c) => `${c.className}:${c.getAttribute("data-side") ?? "-"}`),
    ).toEqual([
      "sg-pane:-",
      "sg-pane-divider:left",
      "sg-pane sg-pane--chart:-",
      "sg-pane-divider:right",
      "sg-pane:-",
    ]);
  });
});

describe("maxWidth clamp", () => {
  it("clamps drag-resize to [minWidth, maxWidth]", () => {
    const { dom } = start([contributor("test.c", [pane("l", { minWidth: 50, maxWidth: 420 })])]);
    const paneEl = contributedPanes(dom)[0];
    const divider = dom.root.find("sg-pane-divider");
    divider?.fire("pointerdown", { clientX: 100 });
    // 100 (`initialWidth`) + 1000 would exceed maxWidth without the clamp
    dom.document.fire("pointermove", { clientX: 1100 });
    expect(paneEl?.style["width"]).toBe("420px");

    dom.document.fire("pointermove", { clientX: -10_000 });
    expect(paneEl?.style["width"]).toBe("50px");
  });

  it("leaves the upper end unbounded when maxWidth is omitted", () => {
    const { dom } = start([contributor("test.c", [pane("l")])]);
    const paneEl = contributedPanes(dom)[0];
    const divider = dom.root.find("sg-pane-divider");
    divider?.fire("pointerdown", { clientX: 100 });
    dom.document.fire("pointermove", { clientX: 100_100 });
    // 100 (`initialWidth`) + 100_000; adapted with the width-source unification (was 100400).
    expect(paneEl?.style["width"]).toBe("100100px");
  });
});

describe("collapse", () => {
  it("collapses and expands via a boundary click on the divider, without moving past the threshold", () => {
    const onResize: number[] = [];
    const { dom } = start([
      contributor("test.c", [
        pane("l", { initialWidth: 240, collapsible: true, onResize: (w) => onResize.push(w) }),
      ]),
    ]);
    const paneEl = contributedPanes(dom)[0];
    const divider = dom.root.find("sg-pane-divider");
    expect(paneEl?.style["width"]).toBe("240px");

    divider?.fire("pointerdown", { clientX: 100 });
    dom.document.fire("pointerup", {});
    expect(paneEl?.style["width"]).toBe("0px");
    expect(onResize).toEqual([]);

    divider?.fire("pointerdown", { clientX: 100 });
    dom.document.fire("pointerup", {});
    expect(paneEl?.style["width"]).toBe("240px");
    expect(onResize).toEqual([]);
  });

  it("does not collapse on a click that moves past the threshold (a real drag)", () => {
    const { dom } = start([contributor("test.c", [pane("l", { collapsible: true })])]);
    const paneEl = contributedPanes(dom)[0];
    const divider = dom.root.find("sg-pane-divider");
    divider?.fire("pointerdown", { clientX: 100 });
    dom.document.fire("pointermove", { clientX: 150 });
    dom.document.fire("pointerup", {});
    // 100 (`initialWidth`) + 50; adapted with the width-source unification (was 450).
    expect(paneEl?.style["width"]).toBe("150px");
  });

  it("renders no collapse UI for a non-collapsible pane: boundary click does nothing", () => {
    const { dom } = start([contributor("test.c", [pane("l", { initialWidth: 240 })])]);
    const paneEl = contributedPanes(dom)[0];
    const divider = dom.root.find("sg-pane-divider");
    divider?.fire("pointerdown", { clientX: 100 });
    dom.document.fire("pointerup", {});
    expect(paneEl?.style["width"]).toBe("240px");
  });

  it("collapses and expands via the view/paneToggle command, explicit and toggling", () => {
    const { dom, g } = start([
      contributor("test.c", [pane("l", { initialWidth: 240, collapsible: true })]),
    ]);
    const paneEl = contributedPanes(dom)[0];

    g.dispatch("view/paneToggle", { id: "l", collapsed: true });
    expect(paneEl?.style["width"]).toBe("0px");

    // omitted `collapsed` toggles
    g.dispatch("view/paneToggle", { id: "l" });
    expect(paneEl?.style["width"]).toBe("240px");

    g.dispatch("view/paneToggle", { id: "l" });
    expect(paneEl?.style["width"]).toBe("0px");

    // setting the same state again is a no-op
    g.dispatch("view/paneToggle", { id: "l", collapsed: true });
    expect(paneEl?.style["width"]).toBe("0px");
  });

  it("remembers the width from the last drag-resize step, not the original initialWidth", () => {
    const { dom, g } = start([
      contributor("test.c", [pane("l", { initialWidth: 240, collapsible: true })]),
    ]);
    const paneEl = contributedPanes(dom)[0];
    const divider = dom.root.find("sg-pane-divider");
    divider?.fire("pointerdown", { clientX: 100 });
    dom.document.fire("pointermove", { clientX: 150 });
    dom.document.fire("pointerup", {});
    // 240 (`initialWidth`) + 50; adapted with the width-source unification (was 450).
    expect(paneEl?.style["width"]).toBe("290px");

    g.dispatch("view/paneToggle", { id: "l", collapsed: true });
    expect(paneEl?.style["width"]).toBe("0px");
    g.dispatch("view/paneToggle", { id: "l", collapsed: false });
    expect(paneEl?.style["width"]).toBe("290px");
  });

  it("is a no-op for an unknown id", () => {
    const { dom, g } = start([contributor("test.c", [pane("l", { collapsible: true })])]);
    const paneEl = contributedPanes(dom)[0];
    expect(() => g.dispatch("view/paneToggle", { id: "nope" })).not.toThrow();
    expect(paneEl?.style["width"]).toBe("100px");
  });

  it("is a no-op for a pane that is not collapsible", () => {
    const { dom, g } = start([contributor("test.c", [pane("l")])]);
    const paneEl = contributedPanes(dom)[0];
    g.dispatch("view/paneToggle", { id: "l", collapsed: true });
    expect(paneEl?.style["width"]).toBe("100px");
  });

  // docs/specs/plugins/view.md: `setCollapsed(true)` zeroes the pane's CSS `min-width`
  // so it can reach 0 px; a drag that un-collapses must restore it, or the pane permanently loses
  // its shrink-under-container-pressure floor.
  it("restores the CSS min-width floor when dragging a collapsed pane's divider outward", () => {
    const { dom, g } = start([
      contributor("test.c", [pane("l", { initialWidth: 240, minWidth: 50, collapsible: true })]),
    ]);
    const paneEl = contributedPanes(dom)[0];
    const divider = dom.root.find("sg-pane-divider");

    g.dispatch("view/paneToggle", { id: "l", collapsed: true });
    expect(paneEl?.style["minWidth"]).toBe("0px");
    expect(paneEl?.style["width"]).toBe("0px");

    // Drag the collapsed pane's divider outward past the click threshold: the pane un-collapses
    // through `applyWidth`, which must bring the `minWidth` floor back with it.
    divider?.fire("pointerdown", { clientX: 100 });
    dom.document.fire("pointermove", { clientX: 180 });
    dom.document.fire("pointerup", {});
    expect(paneEl?.style["width"]).toBe("80px");
    expect(paneEl?.style["minWidth"]).toBe("50px");
  });

  // Escape cancels an in-progress divider drag with full revert (gantt-ui-ux checklist).
  it("cancels a divider drag on Escape, restoring the pre-drag width", () => {
    const { dom } = start([contributor("test.c", [pane("l", { initialWidth: 240 })])]);
    const paneEl = contributedPanes(dom)[0];
    const divider = dom.root.find("sg-pane-divider");

    divider?.fire("pointerdown", { clientX: 100 });
    dom.document.fire("pointermove", { clientX: 180 });
    expect(paneEl?.style["width"]).toBe("320px");

    dom.document.fire("keydown", keyEvent("Escape"));
    expect(paneEl?.style["width"]).toBe("240px");

    // The claim is gone: further movement resizes nothing.
    dom.document.fire("pointermove", { clientX: 400 });
    expect(paneEl?.style["width"]).toBe("240px");
  });

  it("re-collapses on Escape when the cancelled drag had un-collapsed the pane", () => {
    const { dom, g } = start([
      contributor("test.c", [pane("l", { initialWidth: 240, collapsible: true })]),
    ]);
    const paneEl = contributedPanes(dom)[0];
    const divider = dom.root.find("sg-pane-divider");
    g.dispatch("view/paneToggle", { id: "l", collapsed: true });

    divider?.fire("pointerdown", { clientX: 100 });
    dom.document.fire("pointermove", { clientX: 180 });
    expect(paneEl?.style["width"]).toBe("80px");

    dom.document.fire("keydown", keyEvent("Escape"));
    expect(paneEl?.style["width"]).toBe("0px");
    // The remembered width survives the aborted drag: expanding restores the pre-drag width.
    g.dispatch("view/paneToggle", { id: "l", collapsed: false });
    expect(paneEl?.style["width"]).toBe("240px");
  });

  // docs/specs/plugins/view.md: only `pointerup` performs the boundary-click toggle;
  // `pointercancel` must release the drag without touching `collapsed`.
  it("does not collapse on pointercancel after a sub-threshold press", () => {
    const { dom } = start([
      contributor("test.c", [pane("l", { initialWidth: 240, collapsible: true })]),
    ]);
    const paneEl = contributedPanes(dom)[0];
    const divider = dom.root.find("sg-pane-divider");
    divider?.fire("pointerdown", { clientX: 100 });
    dom.document.fire("pointercancel", {});
    expect(paneEl?.style["width"]).toBe("240px");

    // the drag was released, so a later pointerup with no matching pointerdown does nothing either
    dom.document.fire("pointerup", {});
    expect(paneEl?.style["width"]).toBe("240px");
  });

  // docs/specs/plugins/view.md: dragging a collapsed pane's divider outward must clear
  // `collapsed` so it stays in sync with the rendered (now nonzero) width, and a later
  // `view/paneToggle` to `collapsed: true` must therefore not be an early-return no-op.
  it("clears collapsed state when a drag moves a collapsed pane's divider", () => {
    const { dom, g } = start([
      contributor("test.c", [pane("l", { initialWidth: 240, collapsible: true })]),
    ]);
    const paneEl = contributedPanes(dom)[0];
    const divider = dom.root.find("sg-pane-divider");

    g.dispatch("view/paneToggle", { id: "l", collapsed: true });
    expect(paneEl?.style["width"]).toBe("0px");
    // No rect fiddling is needed any more: the drag starts from the plugin's own width state, which
    // reads 0 for a collapsed pane regardless of what the fake layout measures.
    divider?.fire("pointerdown", { clientX: 100 });
    dom.document.fire("pointermove", { clientX: 150 });
    dom.document.fire("pointerup", {});
    expect(paneEl?.style["width"]).toBe("50px");

    // `collapsed` must now read false: a fresh toggle to `collapsed: true` collapses it again
    // instead of being treated as a same-state no-op.
    g.dispatch("view/paneToggle", { id: "l", collapsed: true });
    expect(paneEl?.style["width"]).toBe("0px");
  });

  it("still collapses via the command when `resizable: false` renders no divider to click", () => {
    const { dom, g } = start([
      contributor("test.c", [
        pane("l", { initialWidth: 240, collapsible: true, resizable: false }),
      ]),
    ]);
    const paneEl = contributedPanes(dom)[0];
    expect(dom.root.find("sg-pane-divider")).toBeUndefined();

    g.dispatch("view/paneToggle", { id: "l", collapsed: true });
    expect(paneEl?.style["width"]).toBe("0px");
    g.dispatch("view/paneToggle", { id: "l" });
    expect(paneEl?.style["width"]).toBe("240px");
  });
});

describe("resource ownership (CLAUDE.md constraint)", () => {
  it("dispose() removes panes, dividers and every listener", () => {
    const { dom, g } = start([contributor("test.c", [pane("l"), pane("r", { side: "right" })])]);
    expect(dom.document.listenerCount("pointermove")).toBe(1);
    expect(dom.document.listenerCount("pointerup")).toBe(1);
    const divider = dom.root.find("sg-pane-divider");
    expect(divider?.listenerCount("pointerdown")).toBe(1);
    expect(divider?.listenerCount("keydown")).toBe(1);

    g.dispose();
    expect(dom.root.children.length).toBe(0);
    expect(dom.document.listenerCount("pointermove")).toBe(0);
    expect(dom.document.listenerCount("pointerup")).toBe(0);
    expect(divider?.listenerCount("pointerdown")).toBe(0);
    expect(divider?.listenerCount("keydown")).toBe(0);
  });
});

describe("chart-pane floor and shrink priority", () => {
  it("writes the contribution's minWidth onto the pane element, zeroed while collapsed", () => {
    const { dom, g } = start([
      contributor("test.c", [pane("l", { minWidth: 80, collapsible: true })]),
    ]);
    const paneEl = contributedPanes(dom)[0];
    expect(paneEl?.style["minWidth"]).toBe("80px");

    g.dispatch("view/paneToggle", { id: "l", collapsed: true });
    expect(paneEl?.style["minWidth"]).toBe("0px");

    g.dispatch("view/paneToggle", { id: "l", collapsed: false });
    expect(paneEl?.style["minWidth"]).toBe("80px");
  });

  it("clamps a divider drag so it cannot push the chart pane below --sg-chart-min-width", () => {
    const { dom } = start(
      [contributor("test.c", [pane("l")])],
      {},
      chartMinWidth(240),
    );
    const chartEl = dom.root.find("sg-pane sg-pane--chart");
    const paneEl = contributedPanes(dom)[0];
    // The chart pane's width is still measured (it has no plugin-side state, being the
    // flex-growing member); it is narrowed here so the floor actually binds:
    // room = 100 (the pane's own width state) + 300 (chart) - 240 (floor) = 160.
    if (chartEl !== undefined) chartEl.rect = { ...chartEl.rect, width: 300 };
    const divider = dom.root.find("sg-pane-divider");

    divider?.fire("pointerdown", { clientX: 100 });
    dom.document.fire("pointermove", { clientX: 100_000 });
    // Adapted with the width-source unification (was 460, off the fake 400px pane rect).
    expect(paneEl?.style["width"]).toBe("160px");
  });

  it("never inverts the clamp: the effective max stays at minWidth under container pressure", () => {
    // Regression: with room (50 + 240 - 240 = 50) below minWidth (100), the clamp used to invert
    // to {min: 100, max: 50}, so a grow keystroke shrank the pane below its own minWidth and the
    // aria triad reported valuemin > valuemax.
    const { dom } = start(
      [contributor("test.c", [pane("l", { minWidth: 100, initialWidth: 50 })])],
      {},
      chartMinWidth(240),
    );
    const chartEl = dom.root.find("sg-pane sg-pane--chart");
    if (chartEl !== undefined) chartEl.rect = { ...chartEl.rect, width: 240 };
    const paneEl = contributedPanes(dom)[0];
    const divider = dom.root.find("sg-pane-divider");

    divider?.fire("keydown", keyEvent("ArrowRight"));
    // The pane snaps up to its minWidth instead of being pushed further below it.
    expect(paneEl?.style["width"]).toBe("100px");
    const min = Number(divider?.getAttribute("aria-valuemin"));
    const max = Number(divider?.getAttribute("aria-valuemax"));
    expect(min).toBeLessThanOrEqual(max);
  });

  it("leaves the drag clamp at [minWidth, maxWidth] when the token can't be read", () => {
    // No `--sg-chart-min-width` token: `getComputedStyle` reports "" for it, which does not parse,
    // degrading the clamp per docs/specs/plugins/view.md.
    const { dom } = start([contributor("test.c", [pane("l")])]);
    const paneEl = contributedPanes(dom)[0];
    const divider = dom.root.find("sg-pane-divider");
    divider?.fire("pointerdown", { clientX: 100 });
    dom.document.fire("pointermove", { clientX: 100_100 });
    // 100 (`initialWidth`) + 100_000; adapted with the width-source unification (was 100400).
    expect(paneEl?.style["width"]).toBe("100100px");
  });

  it("reports the clamped width to onResize, not the requested one", () => {
    const onResize: number[] = [];
    const { dom } = start(
      [contributor("test.c", [pane("l", { onResize: (w) => onResize.push(w) })])],
      {},
      chartMinWidth(240),
    );
    const chartEl = dom.root.find("sg-pane sg-pane--chart");
    if (chartEl !== undefined) chartEl.rect = { ...chartEl.rect, width: 300 };
    const divider = dom.root.find("sg-pane-divider");
    divider?.fire("pointerdown", { clientX: 100 });
    dom.document.fire("pointermove", { clientX: 100_000 });
    // Adapted with the width-source unification (was [460]).
    expect(onResize).toEqual([160]);
  });
});

describe("divider accessibility", () => {
  it("is a focusable role=separator with aria-orientation and a default accessible name", () => {
    const { dom } = start([contributor("test.c", [pane("l", { initialWidth: 120 })])]);
    const divider = dom.root.find("sg-pane-divider");
    expect(divider?.getAttribute("role")).toBe("separator");
    expect(divider?.getAttribute("aria-orientation")).toBe("vertical");
    expect(divider?.getAttribute("aria-label")).toBe("Resize pane");
    expect(divider?.tabIndex).toBe(0);
    expect(divider?.getAttribute("aria-valuemin")).toBe("0");
    expect(divider?.getAttribute("aria-valuenow")).toBe("120");
  });

  it("uses the contribution's label as the accessible name when given", () => {
    const { dom } = start([contributor("test.c", [pane("l", { label: "Resize sidebar" })])]);
    const divider = dom.root.find("sg-pane-divider");
    expect(divider?.getAttribute("aria-label")).toBe("Resize sidebar");
  });

  it("falls back to the default name when a contribution's label is blank", () => {
    // A tabbable separator with no accessible name is announced as an unlabelled control, so the
    // empty string cannot mean "no name" here the way it means "no text" for a visible catalog
    // string. The bottom region already treated a blank label as absent; the vertical divider
    // used `??`, which accepts `""` and `"   "`.
    for (const blank of ["", "   "]) {
      const { dom } = start([contributor("test.c", [pane("l", { label: blank })])]);
      expect(dom.root.find("sg-pane-divider")?.getAttribute("aria-label")).toBe("Resize pane");
    }
  });

  it("omits aria-valuemax while the upper end is unbounded, sets it once maxWidth is given", () => {
    const { dom: unbounded } = start([contributor("test.c", [pane("l")])]);
    expect(unbounded.root.find("sg-pane-divider")?.getAttribute("aria-valuemax")).toBeNull();

    const { dom: bounded } = start([contributor("test.d", [pane("m", { maxWidth: 420 })])]);
    expect(bounded.root.find("sg-pane-divider")?.getAttribute("aria-valuemax")).toBe("420");
  });

  it("ArrowRight grows a left pane by 16px, ArrowLeft shrinks it, clamped to minWidth", () => {
    const { dom } = start([
      contributor("test.c", [pane("l", { initialWidth: 100, minWidth: 50 })]),
    ]);
    const paneEl = contributedPanes(dom)[0];
    const divider = dom.root.find("sg-pane-divider");

    divider?.fire("keydown", keyEvent("ArrowRight"));
    expect(paneEl?.style["width"]).toBe("116px");

    divider?.fire("keydown", keyEvent("ArrowLeft"));
    divider?.fire("keydown", keyEvent("ArrowLeft"));
    expect(paneEl?.style["width"]).toBe("84px");

    for (let i = 0; i < 10; i += 1) divider?.fire("keydown", keyEvent("ArrowLeft"));
    expect(paneEl?.style["width"]).toBe("50px");
  });

  it("ArrowLeft grows a right pane, mirroring the drag direction inversion", () => {
    const { dom } = start([
      contributor("test.c", [pane("r", { side: "right", initialWidth: 100 })]),
    ]);
    const paneEl = contributedPanes(dom)[0];
    const divider = dom.root.find("sg-pane-divider");
    divider?.fire("keydown", keyEvent("ArrowLeft"));
    expect(paneEl?.style["width"]).toBe("116px");
    divider?.fire("keydown", keyEvent("ArrowRight"));
    divider?.fire("keydown", keyEvent("ArrowRight"));
    expect(paneEl?.style["width"]).toBe("84px");
  });

  it("Shift+Arrow steps by 64px", () => {
    const { dom } = start([contributor("test.c", [pane("l", { initialWidth: 100 })])]);
    const paneEl = contributedPanes(dom)[0];
    const divider = dom.root.find("sg-pane-divider");
    divider?.fire("keydown", keyEvent("ArrowRight", { shiftKey: true }));
    expect(paneEl?.style["width"]).toBe("164px");
  });

  it("Home/End jump to the clamp bounds", () => {
    const { dom } = start([
      contributor("test.c", [pane("l", { minWidth: 50, maxWidth: 420 })]),
    ]);
    const paneEl = contributedPanes(dom)[0];
    const divider = dom.root.find("sg-pane-divider");
    divider?.fire("keydown", keyEvent("End"));
    expect(paneEl?.style["width"]).toBe("420px");
    divider?.fire("keydown", keyEvent("Home"));
    expect(paneEl?.style["width"]).toBe("50px");
  });

  it("keeps aria-valuenow in sync with keyboard resize", () => {
    const { dom } = start([contributor("test.c", [pane("l", { initialWidth: 100 })])]);
    const divider = dom.root.find("sg-pane-divider");
    divider?.fire("keydown", keyEvent("ArrowRight"));
    expect(divider?.getAttribute("aria-valuenow")).toBe("116");
  });

  it("Enter/Space toggles collapse on a collapsible pane's divider", () => {
    const { dom } = start([
      contributor("test.c", [pane("l", { initialWidth: 240, collapsible: true })]),
    ]);
    const paneEl = contributedPanes(dom)[0];
    const divider = dom.root.find("sg-pane-divider");
    divider?.fire("keydown", keyEvent("Enter"));
    expect(paneEl?.style["width"]).toBe("0px");
    divider?.fire("keydown", keyEvent(" "));
    expect(paneEl?.style["width"]).toBe("240px");
  });

  it("reports the collapsed pane's actual (zeroed) width, not its remembered width", () => {
    const { dom } = start([
      contributor("test.c", [pane("l", { initialWidth: 240, minWidth: 50, collapsible: true })]),
    ]);
    const divider = dom.root.find("sg-pane-divider");
    expect(divider?.getAttribute("aria-valuemin")).toBe("50");
    expect(divider?.getAttribute("aria-valuenow")).toBe("240");

    divider?.fire("keydown", keyEvent("Enter"));
    expect(divider?.getAttribute("aria-valuemin")).toBe("0");
    expect(divider?.getAttribute("aria-valuenow")).toBe("0");

    divider?.fire("keydown", keyEvent(" "));
    expect(divider?.getAttribute("aria-valuemin")).toBe("50");
    expect(divider?.getAttribute("aria-valuenow")).toBe("240");
  });

  it("Enter/Space is a no-op on a non-collapsible pane's divider", () => {
    const { dom } = start([contributor("test.c", [pane("l", { initialWidth: 240 })])]);
    const paneEl = contributedPanes(dom)[0];
    const divider = dom.root.find("sg-pane-divider");
    divider?.fire("keydown", keyEvent("Enter"));
    expect(paneEl?.style["width"]).toBe("240px");
  });

  it("calls preventDefault/stopPropagation for every key it handles", () => {
    const { dom } = start([
      contributor("test.c", [pane("l", { initialWidth: 100, collapsible: true })]),
    ]);
    const divider = dom.root.find("sg-pane-divider");
    for (const k of ["ArrowLeft", "ArrowRight", "Home", "End", "Enter", " "]) {
      const e = keyEvent(k);
      divider?.fire("keydown", e);
      expect(e.defaultPrevented).toBe(true);
      expect(e.propagationStopped).toBe(true);
    }
    // An unhandled key is left alone.
    const ignored = keyEvent("Tab");
    divider?.fire("keydown", ignored);
    expect(ignored.defaultPrevented).toBe(false);
    expect(ignored.propagationStopped).toBe(false);
  });

  it("routes keyboard resize through onResize, guarded like the drag", () => {
    const onResize: number[] = [];
    const { dom } = start([
      contributor("test.c", [pane("l", { initialWidth: 100, onResize: (w) => onResize.push(w) })]),
    ]);
    const divider = dom.root.find("sg-pane-divider");
    divider?.fire("keydown", keyEvent("ArrowRight"));
    expect(onResize).toEqual([116]);
  });
});
